-- E09 · Migration 0008 — workforce credentials: catalog, per-staff credentials,
-- append-only credential history, and a deterministic expiry engine (Engine-1).
-- Implements: docs/07 §8 (Workforce & credentials, M7) · sprint S5 "Credential vault
-- + expiry engine". Backs the scheduling guard (ST-030 assert_schedulable) and the
-- S5 credential-expiry dashboard/notifications.
--
-- Deviations from docs/07 §8 (SURFACE for a docs/00 §3 decision entry — do not treat
-- as silently ratified):
--   D-0008a  `credential.app_user_id -> public.app_user(id)` instead of the doc's
--            `credential.employee_id -> public.employee(id)`. The `employee` table is
--            the M7 workforce spine and is NOT yet migrated (only referenced as a
--            future FK in 0005). Every employee IS an app_user (docs §8:
--            `employee.id references app_user(id)`), so app_user is the correct
--            superset anchor today. When `employee` lands, an expand migration can add
--            `employee_id` + backfill from app_user; no history is lost.
--   D-0008b  Column names follow the orchestrated field list: `status`
--            (doc: verification_status), `credential_type_id` (doc: type_id),
--            `app_user_id` (doc: employee_id), `required_for_roles`
--            (doc: required_for_titles). `credential_type.category` is added (new).
--            Status VALUES are kept identical to the doc (pending/verified/rejected/expired).
--   D-0008c  AAL2 is required on `credential` and `credential_event` even though they
--            are classified PII (invariant 3 mandates AAL2 only for PHI). Credential
--            records carry compliance-sensitive PII — license numbers, background-check
--            and verification decisions adverse to an employee — so they are gated at
--            the PHI-adjacent tier. `credential_type` (CFG catalog) is not AAL2-gated,
--            matching role/permission/form_template.
--
-- Design (by-construction guarantees):
--   * `credential` is the mutable current-state projection (updated_at + row_version),
--     written Lane-A via RLS policies — mirrors `client`.
--   * `credential_event` [AO] is the tamper-evident history. It is TRIGGER-WRITTEN
--     only (no client write grants): every INSERT/material-UPDATE on `credential`
--     appends exactly one event, so the transition log can never be skipped or forged
--     from the app. Its append-only-ness is enforced at the trigger layer too.
--   * Each history event AFTER-INSERT emits an audit_event (IDs + status deltas only —
--     PHI/PII-safe payload), satisfying invariant 7 for every consequential change.
--   * `app.credential_expiry_bucket()` + the `credential_expiry` view are pure
--     deterministic SQL (Engine-1, invariant 13) — never an LLM judgment. The view is
--     `security_invoker` so RLS on the underlying tables composes through it.
-- @trace: E09, M7, ST-030

-- ── Permission catalog (real config — belongs in the migration, not the synthetic
--    seed, so production has these keys). Role grants are wired per-tenant. ─────────
insert into public.permission (key, description) values
  ('credential.read.all', 'Read every staff credential in the tenant'),
  ('credential.write',    'Add, verify, renew, and update staff credentials')
on conflict (key) do nothing;

-- ── Credential type catalog ────────────────────────────────────────────────────
create table public.credential_type (                      -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,                                        -- 'rn_license','cpr',…
  name text not null,
  category text not null check (category in
    ('license','certification','health_screening','background_check','training')),
  required_for_roles text[] not null default '{}',          -- role titles this gates
  renewal_interval_days int,                                -- null = non-expiring
  blocks_scheduling boolean not null default true,          -- feeds assert_schedulable
  source_ref text,                                          -- 'COMAR 10.07.05.10/.11'
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);
create index idx_credential_type_tenant on public.credential_type (tenant_id);

alter table public.credential_type enable row level security;
alter table public.credential_type force row level security;
create policy credential_type_select_tenant on public.credential_type for select to authenticated
  using (tenant_id = app.current_tenant_id());
grant select on public.credential_type to authenticated;
-- Catalog authoring is a config-audited admin path (seeded per tenant) — no write grants.

-- ── Per-staff credential (mutable current state) ────────────────────────────────
create table public.credential (                           -- PII
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  app_user_id uuid not null references public.app_user(id),        -- the staff member (D-0008a)
  credential_type_id uuid not null references public.credential_type(id),
  identifier text,                                          -- license / certificate number
  issued_on date,
  expires_on date,
  status text not null default 'pending' check (status in
    ('pending','verified','rejected','expired')),
  verified_by uuid references public.app_user(id),
  verified_at timestamptz,
  document_id uuid,                    -- scanned evidence; FK lands with document table (docs §9)
  ai_extracted boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
create index idx_credential_tenant on public.credential (tenant_id);
create index idx_credential_user on public.credential (app_user_id);
create index idx_credential_type on public.credential (credential_type_id);
-- Hot path: the expiry dashboard scans verified credentials by expiry date (docs §8).
create index idx_credential_expiry on public.credential (tenant_id, expires_on)
  where status = 'verified';

alter table public.credential enable row level security;
alter table public.credential force row level security;
create policy credential_select_scoped on public.credential for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and (app.has_perm('credential.read.all') or app_user_id = auth.uid()));
create policy credential_insert_admin on public.credential for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
              and app.has_perm('credential.write'));
create policy credential_update_admin on public.credential for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('credential.write'))
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
              and app.has_perm('credential.write'));
grant select, insert, update on public.credential to authenticated;   -- RLS gates rows; no delete

-- ── Append-only credential history (trigger-written) ────────────────────────────
create table public.credential_event (                     -- [AO]  PII
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  credential_id uuid not null references public.credential(id),
  app_user_id uuid not null references public.app_user(id),   -- denormalized for cheap own-history scoping
  event_type text not null check (event_type in
    ('created','status_changed','verified','rejected','expired','renewed','updated')),
  from_status text,
  to_status text,
  changed_by uuid references public.app_user(id),          -- actor; null for system/seed
  note text,
  occurred_at timestamptz not null default now()
);
create index idx_credential_event_cred on public.credential_event (credential_id, occurred_at);
create index idx_credential_event_tenant on public.credential_event (tenant_id, occurred_at);
create index idx_credential_event_user on public.credential_event (app_user_id);

create trigger trg_credential_event_ao before update or delete on public.credential_event
  for each row execute function app.forbid_mutation();

alter table public.credential_event enable row level security;
alter table public.credential_event force row level security;
create policy credential_event_select_scoped on public.credential_event for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and (app.has_perm('credential.read.all') or app_user_id = auth.uid()));
grant select on public.credential_event to authenticated;
-- No insert/update/delete grants: history is written only by trg_credential_history.

-- ── History emitter: one event per consequential credential change ──────────────
create or replace function app.log_credential_event() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
declare
  v_event text;
  v_from  text;
  v_to    text;
begin
  if tg_op = 'INSERT' then
    v_event := 'created';
    v_from  := null;
    v_to    := new.status;
  else
    -- Record only material (consequential) changes; ignore row_version/updated_at churn.
    if new.status      is not distinct from old.status
       and new.verified_by is not distinct from old.verified_by
       and new.verified_at is not distinct from old.verified_at
       and new.expires_on  is not distinct from old.expires_on
       and new.issued_on   is not distinct from old.issued_on
       and new.identifier  is not distinct from old.identifier
       and new.document_id is not distinct from old.document_id then
      return null;
    end if;
    v_from := old.status;
    v_to   := new.status;
    v_event := case
      when new.status is distinct from old.status then
        case new.status
          when 'verified' then 'verified'
          when 'rejected' then 'rejected'
          when 'expired'  then 'expired'
          else 'status_changed'
        end
      when new.expires_on is distinct from old.expires_on
           and (old.expires_on is null or new.expires_on > old.expires_on) then 'renewed'
      else 'updated'
    end;
  end if;

  insert into public.credential_event
    (tenant_id, credential_id, app_user_id, event_type, from_status, to_status, changed_by)
  values
    (new.tenant_id, new.id, new.app_user_id, v_event, v_from, v_to, auth.uid());

  return null;
end $$;

create trigger trg_credential_history after insert or update on public.credential
  for each row execute function app.log_credential_event();

-- ── Audit emitter: every history event is a consequential action (invariant 7) ──
create or replace function app.audit_credential_event() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  -- Payload is IDs + status deltas only — never PHI/PII (invariant 5).
  if auth.uid() is null then
    perform app.emit_audit_system(new.tenant_id, 'system',
      'credential.' || new.event_type, 'credential', new.credential_id,
      jsonb_build_object('event_id', new.id, 'from', new.from_status, 'to', new.to_status));
  else
    perform app.emit_audit(
      'credential.' || new.event_type, 'credential', new.credential_id,
      jsonb_build_object('event_id', new.id, 'from', new.from_status, 'to', new.to_status));
  end if;
  return null;
end $$;

create trigger trg_credential_event_audit after insert on public.credential_event
  for each row execute function app.audit_credential_event();

-- ── Deterministic expiry engine (Engine-1 — never an LLM; invariant 13) ─────────
create or replace function app.credential_expiry_bucket(p_expires_on date, p_warn_days int default 30)
returns text language sql stable as $$
  select case
    when p_expires_on is null            then 'valid'
    when p_expires_on < current_date     then 'lapsed'
    when p_expires_on <= current_date + p_warn_days then 'expiring_soon'
    else 'valid'
  end
$$;

-- security_invoker: RLS on credential + credential_type is enforced as the querying
-- user, so the view never widens what the caller could already read (invariant 2/9).
create view public.credential_expiry with (security_invoker = true) as
select
  c.id                 as credential_id,
  c.tenant_id,
  c.app_user_id,
  c.credential_type_id,
  ct.key               as credential_type_key,
  ct.name              as credential_type_name,
  ct.category,
  ct.blocks_scheduling,
  c.status,
  c.issued_on,
  c.expires_on,
  (c.expires_on - current_date)              as days_to_expiry,
  app.credential_expiry_bucket(c.expires_on) as expiry_bucket
from public.credential c
join public.credential_type ct on ct.id = c.credential_type_id;
grant select on public.credential_expiry to authenticated;

-- ── Explicit function-privilege posture (D-011: defaults do not bind reliably) ──
grant execute on function app.credential_expiry_bucket(date, int) to authenticated;
-- Trigger functions are never a client-callable surface:
revoke all on function app.log_credential_event()   from public, anon, authenticated;
revoke all on function app.audit_credential_event()  from public, anon, authenticated;
