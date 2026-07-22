-- ST-003 · Migration 0003 — append-only guard + tamper-evident audit chain
-- Implements: docs/07 §4 (FR-X-001…006, 020…023)
-- Hardening per D-011 (CEO deep-review findings S1-1, S1-2, S1-3, S5-1, S5-8):
--   * compute_chain serializes same-tenant appends with a per-tenant advisory xact
--     lock — under READ COMMITTED, two concurrent inserts otherwise read the same
--     chain head and fork the chain, paging false tamper alarms under normal load.
--     Trade-off (recorded): all audited writes for one tenant serialize; acceptable
--     at single-agency scale, revisit at SaaS scale.
--   * The hash input is canonicalized deterministically (UTC fixed-format timestamp,
--     field separator, event id included) so verification does not depend on session
--     TimeZone or column-order accidents.
--   * app.emit_audit has NO client grants — callable only from definer-owned RPC
--     bodies. app.emit_audit_system exists for workers/agents (service_role only).
--   * audit_anchor is keyed (tenant_id, day) — day-only breaks at tenant #2.
-- @trace: ST-003, FR-X-020

-- ── Universal mutation guard for [AO] tables ───────────────────────────────
create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'CAREOS_APPEND_ONLY: % on % is forbidden — append a new row',
    tg_op, tg_table_name using errcode = 'P0001';
end $$;

-- ── Tamper-evident audit ledger ────────────────────────────────────────────
create table audit.audit_event (            -- [AO]  OPS (payload PHI-minimized)
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenant(id),
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user','system','agent')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}',      -- IDs & deltas only — never raw PHI
  ip inet, user_agent text,
  prev_hash bytea,
  hash bytea not null
);
create index idx_audit_entity on audit.audit_event (tenant_id, entity_type, entity_id, id);
create index idx_audit_tenant_id on audit.audit_event (tenant_id, id);

alter table audit.audit_event enable row level security;
alter table audit.audit_event force row level security;
-- No policies, no client grants: definer paths only. postgres carries bypassrls.

create or replace function audit.compute_chain() returns trigger
language plpgsql as $$
declare v_prev bytea;
begin
  -- Serialize per-tenant chain appends (D-011 / finding S1-1).
  perform pg_advisory_xact_lock(hashtextextended('careos_audit_chain:' || new.tenant_id::text, 0));
  select hash into v_prev from audit.audit_event
   where tenant_id = new.tenant_id order by id desc limit 1;
  new.prev_hash := v_prev;
  new.hash := extensions.digest(
    coalesce(v_prev, '\x00'::bytea) ||
    convert_to(
      new.tenant_id::text
      || '|' || new.id::text
      || '|' || to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      || '|' || coalesce(new.actor_id::text, '')
      || '|' || new.actor_kind
      || '|' || new.action
      || '|' || new.entity_type
      || '|' || coalesce(new.entity_id::text, '')
      || '|' || new.payload::text,
      'utf8'),
    'sha256');
  return new;
end $$;

create trigger trg_audit_chain before insert on audit.audit_event
  for each row execute function audit.compute_chain();
create trigger trg_audit_ao before update or delete on audit.audit_event
  for each row execute function app.forbid_mutation();

-- ── Emission paths ─────────────────────────────────────────────────────────
create or replace function app.emit_audit(
  p_action text, p_entity_type text, p_entity_id uuid, p_payload jsonb default '{}'
) returns void language plpgsql security definer set search_path = public, audit, extensions as $$
declare v_tenant uuid;
begin
  v_tenant := app.current_tenant_id();
  if v_tenant is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: emit_audit requires an authenticated tenant user; system actors use emit_audit_system'
      using errcode = 'P0001';
  end if;
  insert into audit.audit_event (tenant_id, actor_id, actor_kind, action, entity_type, entity_id, payload)
  values (v_tenant, auth.uid(), 'user', p_action, p_entity_type, p_entity_id, p_payload);
end $$;
-- Deliberately NO grants: reachable only through definer-owned RPCs (D-011 / S1-2).

create or replace function app.emit_audit_system(
  p_tenant uuid, p_actor_kind text, p_action text,
  p_entity_type text, p_entity_id uuid, p_payload jsonb default '{}'
) returns void language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if p_actor_kind not in ('system','agent') then
    raise exception 'CAREOS_INVALID_ACTOR_KIND: %', p_actor_kind using errcode = 'P0001';
  end if;
  insert into audit.audit_event (tenant_id, actor_id, actor_kind, action, entity_type, entity_id, payload)
  values (p_tenant, null, p_actor_kind, p_action, p_entity_type, p_entity_id, p_payload);
end $$;
grant execute on function app.emit_audit_system(uuid, text, text, text, uuid, jsonb) to service_role;

-- ── Chain verification (daily job + pgTAP) ─────────────────────────────────
create or replace function audit.verify_chain(p_tenant uuid)
returns table (ok boolean, first_bad_id bigint)
language plpgsql stable security definer set search_path = public, audit, extensions as $$
declare
  r record;
  v_prev bytea := null;
  v_expected bytea;
begin
  for r in
    select * from audit.audit_event where tenant_id = p_tenant order by id
  loop
    if r.prev_hash is distinct from v_prev then
      return query select false, r.id; return;
    end if;
    v_expected := extensions.digest(
      coalesce(v_prev, '\x00'::bytea) ||
      convert_to(
        r.tenant_id::text
        || '|' || r.id::text
        || '|' || to_char(r.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        || '|' || coalesce(r.actor_id::text, '')
        || '|' || r.actor_kind
        || '|' || r.action
        || '|' || r.entity_type
        || '|' || coalesce(r.entity_id::text, '')
        || '|' || r.payload::text,
        'utf8'),
      'sha256');
    if r.hash is distinct from v_expected then
      return query select false, r.id; return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select true, null::bigint;
end $$;
-- No client grants; run by the anchor job and tests.

-- ── Daily anchor (exported to WORM storage by the ops job) ─────────────────
create table audit.audit_anchor (
  tenant_id uuid not null references public.tenant(id),
  day date not null,
  last_event_id bigint not null,
  root_hash bytea not null,
  exported_at timestamptz,
  primary key (tenant_id, day)                -- D-011 / S5-8: day-only breaks at tenant #2
);
alter table audit.audit_anchor enable row level security;
alter table audit.audit_anchor force row level security;
create trigger trg_audit_anchor_ao before update or delete on audit.audit_anchor
  for each row execute function app.forbid_mutation();
