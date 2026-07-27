-- Migration 0010 — care planning + supervisory visit cadence
-- Implements: docs/07 §10 (Care planning: care_plan [AO], care_plan_item — PHI,
--   "versioned exactly like forms; RN signature to finalize") and the 45/90/120-day
--   supervisory cadence of docs/07 §7 (E10/M8, COMAR 10.07.05 supervisory oversight).
--
-- Model (deliberate, recorded here so a reviewer can trace the intent):
--   * care_plan rows ARE versions and are append-only [AO] — a client's plan of care
--     is authored as version 1, revised by inserting version 2 (referencing v1 via
--     prev_version_id), and so on. "Current plan" is DERIVED as the highest version
--     per client; supersession is implicit in the version ordering, so there is no
--     UPDATE path that could flip an older version's status after the fact. This is
--     the append-only analogue of form_instance→form_version, collapsed into one
--     table per this schema's contract (client_id, version, status, authored_by).
--   * care_plan_item is the immutable content of a plan version (goals /
--     interventions). Items belong to exactly one care_plan version and are
--     append-only for the same reason the version is — you cannot tamper with the
--     goals of a plan that has already been authored.
--   * supervisory_visit is a MUTABLE operational/compliance record (like
--     compliance_obligation, docs/07 §7): scheduled → completed. Its immutable
--     clinical evidence lives in the linked form_instance (append-only form_version +
--     signature). A BEFORE UPDATE guard forbids reopening a completed visit and
--     freezes its identity columns, so the consequential fact ("this visit happened")
--     can never be overwritten (invariant 1).
--
-- Writes here use Lane A (direct INSERT/UPDATE gated by RLS + triggers), not a
-- Lane-B RPC surface: version numbers are collision-guarded by unique(client_id,
-- version), append-only is enforced by trigger, tenant/care-team scoping by policy,
-- and every consequential action is audited by a definer trigger. The RN-signature
-- finalize step for a plan of care is the forms engine's job (form_template
-- 'plan_of_care') and is intentionally out of this migration's scope.
-- @trace: docs/07 §10 (care planning), docs/07 §7 (45/90/120 supervisory cadence), E10/M8

-- ── Audit triggers (definer; PHI-minimized payloads — IDs & enums only) ─────
-- emit_audit requires an authenticated tenant session. Bulk synthetic seeding and
-- migrations run as postgres with no JWT, so app.current_tenant_id() is null there;
-- the guard makes seeding a no-op (never a user action, never forks the audit chain)
-- while every real request-path write is audited.
create or replace function app.audit_care_plan() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is not null then
    perform app.emit_audit('care_plan.author', 'care_plan', new.id,
      jsonb_build_object('client_id', new.client_id,
                         'version', new.version,
                         'status', new.status));
  end if;
  return null;                                   -- AFTER trigger: result ignored
end $$;

create or replace function app.audit_supervisory_visit() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('supervisory_visit.schedule', 'supervisory_visit', new.id,
      jsonb_build_object('client_id', new.client_id,
                         'kind', new.kind,
                         'due_on', new.due_on));
  elsif tg_op = 'UPDATE' and old.completed_on is null and new.completed_on is not null then
    perform app.emit_audit('supervisory_visit.complete', 'supervisory_visit', new.id,
      jsonb_build_object('client_id', new.client_id,
                         'kind', new.kind,
                         'form_instance_id', new.form_instance_id));
  end if;
  return null;
end $$;

-- ── Update guard for the mutable supervisory_visit ──────────────────────────
create or replace function app.guard_supervisory_visit() returns trigger
language plpgsql as $$
begin
  if old.completed_on is not null and new.completed_on is null then
    raise exception
      'CAREOS_APPEND_ONLY: a completed supervisory visit cannot be reopened'
      using errcode = 'P0001';
  end if;
  if new.tenant_id <> old.tenant_id
     or new.client_id <> old.client_id
     or new.kind <> old.kind then
    raise exception
      'CAREOS_IMMUTABLE_KEY: tenant, client and kind of a supervisory visit are immutable'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Locked down like every other app function (baseline in 0001/0007): no client grant.
revoke all on function app.audit_care_plan() from public;
revoke all on function app.audit_supervisory_visit() from public;
revoke all on function app.guard_supervisory_visit() from public;

-- ── care_plan — the append-only, versioned plan of care ─────────────────────
create table public.care_plan (                            -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  version int not null,
  prev_version_id uuid references public.care_plan(id),     -- lineage (v_{n-1})
  status text not null default 'draft' check (status in
    ('draft','active','discontinued')),
  title text,
  summary text,                                             -- plain-language overview
  authored_by uuid not null references public.app_user(id),
  authored_at timestamptz not null default now(),
  effective_on date,
  review_due_on date,                                       -- e.g. 90-day plan review
  created_at timestamptz not null default now(),
  unique (client_id, version)
);
create index idx_care_plan_tenant on public.care_plan (tenant_id);
create index idx_care_plan_client_ver on public.care_plan (client_id, version desc);

create trigger trg_care_plan_ao before update or delete on public.care_plan
  for each row execute function app.forbid_mutation();
create trigger trg_care_plan_audit after insert on public.care_plan
  for each row execute function app.audit_care_plan();

alter table public.care_plan enable row level security;
alter table public.care_plan force row level security;

create policy care_plan_select_scoped on public.care_plan for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('client.read.all') or app.on_care_team(client_id)));

create policy care_plan_insert_scoped on public.care_plan for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id() and app.is_aal2()
    and authored_by = auth.uid()                            -- author is always self
    and (app.has_perm('form.write.all') or app.on_care_team(client_id))
    -- client must be visible to the author (also pins the reference to this tenant)
    and exists (select 1 from public.client c
                 where c.id = client_id and c.tenant_id = app.current_tenant_id()));

grant select, insert on public.care_plan to authenticated;   -- RLS gates rows; no update/delete

-- ── care_plan_item — immutable goals / interventions of a plan version ──────
create table public.care_plan_item (                       -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  care_plan_id uuid not null references public.care_plan(id),
  kind text not null check (kind in ('goal','intervention')),
  seq int not null default 0,                              -- display order within the plan
  text text not null,                                      -- the goal / intervention statement
  target text,                                             -- measurable target / frequency
  created_at timestamptz not null default now()
);
create index idx_care_plan_item_tenant on public.care_plan_item (tenant_id);
create index idx_care_plan_item_plan on public.care_plan_item (care_plan_id, seq);

create trigger trg_care_plan_item_ao before update or delete on public.care_plan_item
  for each row execute function app.forbid_mutation();

alter table public.care_plan_item enable row level security;
alter table public.care_plan_item force row level security;

create policy care_plan_item_select_scoped on public.care_plan_item for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
      select 1 from public.care_plan cp
       where cp.id = care_plan_id and (
         app.has_perm('client.read.all') or app.on_care_team(cp.client_id))));

create policy care_plan_item_insert_scoped on public.care_plan_item for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
      select 1 from public.care_plan cp
       where cp.id = care_plan_id and cp.tenant_id = app.current_tenant_id() and (
         app.has_perm('form.write.all') or app.on_care_team(cp.client_id))));

grant select, insert on public.care_plan_item to authenticated;   -- no update/delete (append-only)

-- ── supervisory_visit — mutable 45/90/120-day cadence record ────────────────
create table public.supervisory_visit (                    -- PHI (by reference; OPS shape)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  rn_id uuid not null references public.app_user(id),      -- supervising RN
  kind text not null check (kind in ('45_day','90_day','120_day')),
  status text not null default 'scheduled' check (status in
    ('scheduled','completed','missed','waived')),
  due_on date not null,
  completed_on date,
  form_instance_id uuid references public.form_instance(id),  -- the visit's evidence form
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  -- a completed visit must say so; keeps completed_on and status in lockstep
  constraint chk_sv_completed check (completed_on is null or status = 'completed')
);
create index idx_supervisory_visit_tenant on public.supervisory_visit (tenant_id);
create index idx_supervisory_visit_client on public.supervisory_visit (client_id);
create index idx_supervisory_visit_rn on public.supervisory_visit (rn_id);
-- hot filter: the open/upcoming supervisory queue (due dates not yet completed)
create index idx_supervisory_visit_open on public.supervisory_visit (tenant_id, due_on)
  where completed_on is null;

create trigger trg_supervisory_visit_guard before update on public.supervisory_visit
  for each row execute function app.guard_supervisory_visit();
create trigger trg_supervisory_visit_audit after insert or update on public.supervisory_visit
  for each row execute function app.audit_supervisory_visit();

alter table public.supervisory_visit enable row level security;
alter table public.supervisory_visit force row level security;

create policy supervisory_visit_select_scoped on public.supervisory_visit for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('client.read.all') or app.on_care_team(client_id)));

create policy supervisory_visit_insert_scoped on public.supervisory_visit for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('form.write.all') or app.on_care_team(client_id))
    and exists (select 1 from public.client c
                 where c.id = client_id and c.tenant_id = app.current_tenant_id()));

create policy supervisory_visit_update_scoped on public.supervisory_visit for update to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('form.write.all') or app.on_care_team(client_id)))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.supervisory_visit to authenticated;   -- no delete
