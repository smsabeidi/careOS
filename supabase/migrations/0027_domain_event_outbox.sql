-- ST-130 · Migration 0027 — the outbox: domain_event + pgmq, invariant 7 becomes real
-- Invariant 7's second half ("… and, if it has side effects, an outbox event — in the
-- same transaction") was product-wide unsatisfiable: no outbox table existed (2026-08-02
-- review §2.4). This migration lands the durable event spine the automation runtime
-- (Phase 2) consumes:
--   * public.domain_event [AO, OPS] — the transactional outbox. IDs-only payloads
--     (invariant 5): consumers refetch content under their own RLS.
--   * pgmq ('q_events') — same-transaction delivery. pgmq is table-backed, so
--     pgmq.send() commits or rolls back WITH the domain write (the outbox property,
--     free of dual-write drift). No consumers exist yet; Phase 2 adds them.
--   * app.emit_event / app.emit_event_system — the two lawful emitters, mirroring the
--     audit pair (D-011 posture: definer-body-only / service_role-only).
--   * Scheduling domain events are TRIGGER-driven (trg_visit_domain_events,
--     trg_shift_domain_events), not per-RPC calls — the same architecture as the audit
--     chain. Every write path present and future (Lane-B RPCs, the credential sweep,
--     app.clock_visit) emits by construction; a future RPC cannot forget the outbox.
--     Richer lifecycle semantics with no single row delta (identity.*, onboarding.*)
--     are emitted explicitly by their RPCs in 0030+.
-- Seed posture: like the audit triggers, event triggers no-op when there is no session
-- tenant context — synthetic seeding is not a user action and must not enqueue work.
-- @trace: ST-130, invariant 7, docs/11 §7 groundwork

-- ── Queue plane ───────────────────────────────────────────────────────────────────────
create extension if not exists pgmq;
select pgmq.create('q_events');

-- ── The outbox table ──────────────────────────────────────────────────────────────────
create table public.domain_event (                                  -- OPS [AO]
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  event_type text not null,               -- 'visit.vacated', 'identity.separated', …
  entity_type text not null,              -- 'visit', 'app_user', …
  entity_id uuid,
  payload jsonb not null default '{}',    -- IDs & enums only — never PHI content
  created_by uuid references public.app_user(id),   -- null ⇒ system emitter
  created_at timestamptz not null default now()
);
create index idx_domain_event_tenant on public.domain_event (tenant_id, created_at desc);
create index idx_domain_event_type on public.domain_event (event_type);

alter table public.domain_event enable row level security;
alter table public.domain_event force row level security;
-- Zero client grants: writes via the emitters below; reads arrive with the Phase-2
-- operations surface (a definer RPC in the read_audit_trail mold). Consumers hold the
-- worker identity and read through pgmq, not this table.
create trigger trg_domain_event_ao before update or delete on public.domain_event
  for each row execute function app.forbid_mutation();

-- ── Emitters (the only write paths) ───────────────────────────────────────────────────
-- Internal shared body: no grants of any kind — reachable only from the definer
-- functions and triggers in this file and from later Lane-B RPC bodies.
create or replace function app.emit_event_internal(
  p_tenant uuid, p_actor uuid, p_event_type text,
  p_entity_type text, p_entity_id uuid, p_payload jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  insert into public.domain_event
    (tenant_id, event_type, entity_type, entity_id, payload, created_by)
  values
    (p_tenant, p_event_type, p_entity_type, p_entity_id, coalesce(p_payload, '{}'), p_actor)
  returning id into v_id;
  perform pgmq.send('q_events',
    jsonb_build_object('type', p_event_type, 'event_id', v_id, 'tenant_id', p_tenant));
  return v_id;
end $$;
revoke all on function app.emit_event_internal(uuid, uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;

-- Session emitter: derives tenant from the active principal (0022 contract). An RPC
-- acting for a not-yet-active principal must flip status BEFORE emitting (0022 header).
create or replace function app.emit_event(
  p_event_type text, p_entity_type text, p_entity_id uuid, p_payload jsonb default '{}'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: domain events need an active principal'
      using errcode = 'P0001';
  end if;
  return app.emit_event_internal(v_tenant, auth.uid(), p_event_type,
                                 p_entity_type, p_entity_id, p_payload);
end $$;
revoke all on function app.emit_event(text, text, uuid, jsonb)
  from public, anon, authenticated;

-- System emitter: explicit tenant, for workers with no session principal (mirrors
-- app.emit_audit_system until Phase-2 agent identities make that lane rare).
create or replace function app.emit_event_system(
  p_tenant uuid, p_event_type text, p_entity_type text, p_entity_id uuid,
  p_payload jsonb default '{}'
) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  return app.emit_event_internal(p_tenant, null, p_event_type,
                                 p_entity_type, p_entity_id, p_payload);
end $$;
revoke all on function app.emit_event_system(uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function app.emit_event_system(uuid, text, text, uuid, jsonb)
  to service_role;

-- ── Scheduling domain events, trigger-driven ──────────────────────────────────────────
create or replace function app.visit_domain_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_event_internal(new.tenant_id, v_actor,
      case when new.caregiver_id is null then 'visit.opened' else 'visit.scheduled' end,
      'visit', new.id,
      jsonb_build_object('client_id', new.client_id, 'caregiver_id', new.caregiver_id));
    return null;
  end if;
  -- Assignment deltas: the open-shift board's lifecycle (C1's cues).
  if new.caregiver_id is distinct from old.caregiver_id then
    perform app.emit_event_internal(new.tenant_id, v_actor,
      case
        when old.caregiver_id is null then 'visit.assigned'
        when new.caregiver_id is null then 'visit.vacated'
        else 'visit.reassigned' end,
      'visit', new.id,
      jsonb_build_object('client_id', new.client_id,
                         'from_caregiver', old.caregiver_id,
                         'to_caregiver', new.caregiver_id));
  end if;
  if new.status is distinct from old.status then
    perform app.emit_event_internal(new.tenant_id, v_actor,
      'visit.' || case new.status
        when 'in_progress' then 'started'
        when 'completed'   then 'completed'
        when 'cancelled'   then 'cancelled'
        when 'missed'      then 'missed'
        else 'status_changed' end,
      'visit', new.id,
      jsonb_build_object('client_id', new.client_id,
                         'from', old.status, 'to', new.status));
  end if;
  return null;
end $$;
create trigger trg_visit_domain_events after insert or update on public.visit
  for each row execute function app.visit_domain_events();

create or replace function app.shift_domain_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_event_internal(new.tenant_id, auth.uid(), 'shift.created',
      'shift', new.id, jsonb_build_object('caregiver_id', new.caregiver_id));
  end if;
  return null;
end $$;
create trigger trg_shift_domain_events after insert on public.shift
  for each row execute function app.shift_domain_events();
