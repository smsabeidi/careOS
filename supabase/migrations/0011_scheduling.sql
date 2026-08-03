-- ST-030 / ST-031 · Migration 0011 — scheduling spine: caregiver shifts, scheduled
-- visits, an append-only schedule-exception ledger, and the deterministic
-- credential-lapse scheduling guard app.assert_schedulable().
-- Implements: docs/07 §6 (scheduling) + §8 (scheduling guard); ST-030/ST-031 ACs (docs/15).
--
-- MODEL NOTE — surfaced divergence from docs/07 §6 (NOT a silent change):
--   docs/07 §6 names the *schedulable care event* `shift` (client-bound) and reserves
--   `visit` for the EVV clock-in/out realization (PostGIS geo, 1:1 with a shift, PHI).
--   This slice (per the ratified S3 story brief) instead models:
--     * `visit`  = the *scheduled care event* (client + caregiver + planned window +
--                  lifecycle status). caregiver_id NULL ⇒ open/unassigned ("open-shift
--                  state modeled", ST-030 AC).
--     * `shift`  = a caregiver *roster/availability window* (caregiver + window).
--     * `schedule_exception` = the append-only change/exception ledger for a visit.
--   The S4 EVV migration MUST reconcile this: it should attach clock-in/out + geofence
--   columns to THIS `visit` row (additively, expand-phase) rather than re-creating a
--   `visit` table, and a docs/00 §3 decision entry should ratify the naming. Flagged in
--   the task result so the reconciliation is not lost. PostGIS geo is deliberately NOT
--   introduced here (kept pure-Postgres, matching 0004's deferral of client geo).
--
-- Consequential-write posture (matches the 0004 client precedent, not the 0005 RPC-only
--   forms precedent): shift/visit carry direct, permission-gated INSERT/UPDATE grants so
--   the Scheduler-v1 surface can write under RLS. Every consequential write is captured:
--   `visit` and `schedule_exception` emit an audit event via a definer trigger
--   (invariant 7); `schedule_exception` is additionally immutable domain history
--   (append-only trigger, invariant 1). The transition-guarding scheduling RPC layer
--   (create/assign/cancel, calling app.assert_schedulable in-txn) is the ST-030/ST-031
--   follow-up, exactly as 0006 followed 0005.
--   `shift` is roster/availability (operational, low-consequence — like 0009 `obligation`)
--   and is deliberately not audited; the consequential facts are captured at the
--   visit/exception layer.
-- @trace: ST-030, ST-031, docs/07 §6, docs/07 §8

-- ── Scheduling permission catalog (real config — belongs in the migration, not the
--    synthetic seed, so production has these keys; per-tenant role grants are wired in
--    the seed / a future admin RPC). Mirrors the 0008 credential-permission precedent. ─
insert into public.permission (key, description) values
  ('schedule.read',  'Read the schedule — shifts and visits across the tenant'),
  ('schedule.write', 'Create, assign, reschedule and cancel shifts and visits')
on conflict (key) do nothing;

-- ── Audit + integrity triggers (definer; PHI-minimized payloads — IDs & enums only) ──
-- emit_audit requires an authenticated tenant session. Bulk synthetic seeding and
-- migrations run as postgres with no JWT, so app.current_tenant_id() is null there; the
-- guard makes seeding a no-op (never a user action, never forks the audit chain) while
-- every real request-path write is audited. Mirrors app.audit_supervisory_visit (0010).
create or replace function app.audit_visit() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('visit.schedule', 'visit', new.id,
      jsonb_build_object('client_id', new.client_id,
                         'caregiver_id', new.caregiver_id,   -- id only; never PHI content
                         'status', new.status));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform app.emit_audit('visit.status_change', 'visit', new.id,
        jsonb_build_object('client_id', new.client_id,
                           'from', old.status, 'to', new.status));
    end if;
    if new.caregiver_id is distinct from old.caregiver_id then
      perform app.emit_audit('visit.reassign', 'visit', new.id,
        jsonb_build_object('client_id', new.client_id,
                           'from_caregiver', old.caregiver_id,
                           'to_caregiver', new.caregiver_id));
    end if;
  end if;
  return null;                                    -- AFTER trigger: result ignored
end $$;

-- A scheduled visit's tenant and client are its identity — a visit is rescheduled or
-- cancelled, never re-pointed at a different client (invariant 1 spirit). Caregiver and
-- window stay mutable (assign / reschedule).
create or replace function app.guard_visit() returns trigger
language plpgsql as $$
begin
  if new.tenant_id <> old.tenant_id or new.client_id <> old.client_id then
    raise exception
      'CAREOS_IMMUTABLE_KEY: the tenant and client of a visit are immutable — cancel and reschedule instead'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function app.audit_schedule_exception() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  -- kind is a bounded enum; note (free text, possible PHI) is deliberately NOT in the payload.
  perform app.emit_audit('schedule_exception.' || new.kind, 'schedule_exception', new.id,
    jsonb_build_object('visit_id', new.visit_id, 'kind', new.kind));
  return null;
end $$;

-- Locked down like every other app function (baseline 0001/0007): trigger-only, no grant.
revoke all on function app.audit_visit()              from public;
revoke all on function app.guard_visit()              from public;
revoke all on function app.audit_schedule_exception() from public;

-- ── shift: caregiver roster / availability window ──────────────────────────── OPS
create table public.shift (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  caregiver_id uuid not null references public.app_user(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','in_progress','completed','cancelled')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_shift_window check (ends_at > starts_at)
);
create index idx_shift_tenant on public.shift (tenant_id);
create index idx_shift_caregiver_start on public.shift (caregiver_id, starts_at);

alter table public.shift enable row level security;
alter table public.shift force row level security;

-- Read: own roster, or anyone holding schedule.read (coordinators/schedulers).
create policy shift_select_scoped on public.shift for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (caregiver_id = auth.uid() or app.has_perm('schedule.read')));
-- Write: schedule.write only; WITH CHECK pins tenant.
create policy shift_insert_scheduler on public.shift for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_perm('schedule.write'));
create policy shift_update_scheduler on public.shift for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('schedule.write'))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.shift to authenticated;   -- RLS gates rows; no delete

-- ── visit: the scheduled care event ───────────────────────────────────────── PHI
create table public.visit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  caregiver_id uuid references public.app_user(id),   -- NULL ⇒ open / unassigned
  shift_id uuid references public.shift(id),           -- optional link to a roster block
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  -- Lifecycle per ST-030 (scheduled/in_progress/completed/missed) plus 'cancelled':
  -- a cancelled visit must be representable (schedule_exception has a 'cancellation'
  -- kind), which a strict four-state model cannot express. Superset flagged in the
  -- task result for the docs/07 §6 data-dictionary reconciliation.
  status text not null default 'scheduled'
    check (status in ('scheduled','in_progress','completed','missed','cancelled')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_visit_window check (scheduled_end > scheduled_start)
);
create index idx_visit_tenant on public.visit (tenant_id);
create index idx_visit_client_start on public.visit (client_id, scheduled_start);
create index idx_visit_caregiver_start on public.visit (caregiver_id, scheduled_start);
create index idx_visit_shift on public.visit (shift_id);
-- Hot filter: the open-shift board (unassigned, still schedulable).
create index idx_visit_open on public.visit (tenant_id, scheduled_start)
  where caregiver_id is null and status = 'scheduled';

create trigger trg_visit_guard before update on public.visit
  for each row execute function app.guard_visit();
create trigger trg_visit_audit after insert or update on public.visit
  for each row execute function app.audit_visit();

alter table public.visit enable row level security;
alter table public.visit force row level security;

-- PHI ⇒ AAL2. Read: schedule.read (org-wide), OR care-team on the client, OR the
-- assigned caregiver seeing their own visit.
create policy visit_select_scoped on public.visit for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('schedule.read')
      or app.on_care_team(client_id)
      or caregiver_id = auth.uid()
    ));
create policy visit_insert_scheduler on public.visit for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
              and app.has_perm('schedule.write'));
create policy visit_update_scheduler on public.visit for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('schedule.write'))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.visit to authenticated;   -- RLS gates rows; no delete

-- ── schedule_exception: append-only change / exception ledger ────────── [AO] OPS
create table public.schedule_exception (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  kind text not null check (kind in
    ('reschedule','cancellation','no_show','late_start','early_end','reassignment','other')),
  note text,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_sched_exc_visit on public.schedule_exception (visit_id, created_at);
create index idx_sched_exc_tenant on public.schedule_exception (tenant_id);

-- Immutable history: no UPDATE/DELETE grant is ever issued, and the trigger blocks
-- mutation even for a table owner / superuser (same guard as form_version/signature).
create trigger trg_schedule_exception_ao before update or delete on public.schedule_exception
  for each row execute function app.forbid_mutation();
create trigger trg_schedule_exception_audit after insert on public.schedule_exception
  for each row execute function app.audit_schedule_exception();

alter table public.schedule_exception enable row level security;
alter table public.schedule_exception force row level security;

-- Read follows the parent visit's visibility (PHI-by-reference ⇒ AAL2).
create policy schedule_exception_select_scoped on public.schedule_exception for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.visit v
    where v.id = visit_id and (
      app.has_perm('schedule.read')
      or app.on_care_team(v.client_id)
      or v.caregiver_id = auth.uid())));
-- Append: a scheduler, or the visit's caregiver / a care-team member, may log an
-- exception on a visit they can see. You always log as yourself (created_by pinned).
create policy schedule_exception_insert_scoped on public.schedule_exception for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id() and app.is_aal2()
    and created_by = auth.uid()
    and exists (
      select 1 from public.visit v
      where v.id = visit_id and v.tenant_id = app.current_tenant_id() and (
        app.has_perm('schedule.write')
        or app.on_care_team(v.client_id)
        or v.caregiver_id = auth.uid())));

grant select, insert on public.schedule_exception to authenticated;   -- no update/delete: append-only

-- ── Deterministic scheduling guard (Engine 1 — pure SQL, never an LLM; invariant 13) ─
-- app.assert_schedulable(caregiver, client, window) → jsonb {schedulable, blockers[], …}
-- Refuses (schedulable=false) when the caregiver holds a lapsed / missing / unverified
-- credential that blocks scheduling for a role they actually hold (docs/07 §8: "no worker
-- ever serves a client with a lapsed license — by construction"). Called by the future
-- shift-assignment RPCs; also directly testable.
--
-- 0008 BINDING (task: "join to 0008 credential + credential_type.required_for_roles;
--   if 0008 columns differ, gate on what exists and note it"). Migrations apply in order,
--   so credential/credential_type always exist here. 0008 landed the ORCHESTRATED field
--   names, which differ from docs/07 §8's sketch — we bind to what actually exists:
--     credential:      app_user_id, credential_type_id, status, expires_on  (doc said
--                      employee_id / type_id / verification_status)
--     credential_type: required_for_roles, blocks_scheduling                (doc said
--                      required_for_titles)
--   There is NO `employee` table (DN-0008a: every employee IS an app_user), so the
--   caregiver's role source is app_user → user_role → role. required_for_roles carries
--   title tokens ('RN','Caregiver'); role.key/name are matched case-insensitively.
--
-- SECURITY DEFINER (like app.has_perm / app.on_care_team): this is an eligibility helper,
--   so it must see credential status regardless of the caller's own credential RLS. Its
--   output is PHI/PII-minimized — credential-type key/name + a reason enum only; the
--   license `identifier` is never read out (invariant 5). It is scoped to the caregiver's
--   own tenant, so it never crosses the tenancy perimeter.
create or replace function app.assert_schedulable(
  p_caregiver uuid, p_client uuid, p_window tstzrange
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant     uuid := (select tenant_id from public.app_user where id = p_caregiver);
  -- Evaluate credential validity through the END of the requested window (most
  -- conservative: a credential lapsing mid-shift is treated as lapsed for the shift).
  v_window_end date := coalesce((upper(p_window))::date, (lower(p_window))::date, current_date);
  v_blockers   jsonb;
begin
  select coalesce(jsonb_agg(b order by b ->> 'credential'), '[]'::jsonb)
    into v_blockers
  from (
    select jsonb_build_object(
             'credential', ct.key,
             'name', ct.name,
             'reason', case
                 when cr.id is null                              then 'missing'
                 when cr.status is distinct from 'verified'      then 'unverified'
                 when cr.expires_on is not null
                      and cr.expires_on < v_window_end           then 'lapsed'
                 else 'blocked' end) as b
    from public.credential_type ct
    -- The caregiver's most current credential of this type (a future/non-expiring one
    -- wins over an old lapsed one, so a renewal never false-blocks).
    left join lateral (
      select c.id, c.status, c.expires_on
      from public.credential c
      where c.app_user_id = p_caregiver
        and c.credential_type_id = ct.id
        and c.tenant_id = v_tenant
      order by c.expires_on desc nulls last, c.created_at desc
      limit 1
    ) cr on true
    where ct.tenant_id = v_tenant
      and ct.blocks_scheduling = true
      -- Applies when the type is required for everyone (empty) or for a role the
      -- caregiver holds (title token vs lowercase role key ⇒ case-insensitive match).
      and ( cardinality(ct.required_for_roles) = 0
            or exists (
              select 1 from public.user_role ur
              join public.role r on r.id = ur.role_id
              where ur.user_id = p_caregiver
                and ( lower(r.key)  = any (select lower(x) from unnest(ct.required_for_roles) x)
                   or lower(r.name) = any (select lower(x) from unnest(ct.required_for_roles) x) )
            ))
      -- Only the gaps are blockers: missing, not verified, or lapsed by window end.
      and ( cr.id is null
            or cr.status is distinct from 'verified'
            or (cr.expires_on is not null and cr.expires_on < v_window_end) )
  ) blockers;

  return jsonb_build_object(
    'schedulable', (v_blockers = '[]'::jsonb),
    'caregiver_id', p_caregiver,
    'client_id', p_client,
    'window', jsonb_build_object('start', lower(p_window), 'end', upper(p_window)),
    'credential_enforcement', 'active',   -- statically bound to 0008 (see header note)
    'blockers', v_blockers
  );
end $$;

-- Callable by the user-scoped RPC layer (invariant 6: no service_role in request paths).
-- Belt-and-suspenders against the default PUBLIC grant on new functions (see 0001/0007).
revoke all on function app.assert_schedulable(uuid, uuid, tstzrange) from public, anon;
grant execute on function app.assert_schedulable(uuid, uuid, tstzrange) to authenticated;
