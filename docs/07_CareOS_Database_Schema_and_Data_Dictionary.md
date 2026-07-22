# CareOS — Database Schema & Data Dictionary

**Client:** American Care Team (Maryland) · **Document:** 07 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 01 (FR-* requirements), Doc 02 (COMAR/EVV/HIPAA obligations), Doc 03 §5–6 (data model & versioning design), Doc 06 (platform).

> **Purpose.** The authoritative physical data model for CareOS on Supabase Postgres 16. §3–§9 are **real DDL** for the compliance spine — the parts where correctness is existential. §10 is the data dictionary for the remaining domains (full DDL generated from it as migrations `0001…` in the repo). Every table states its RLS class and retention. Conventions here are binding for all future migrations.

---

## 1. Conventions (binding)

1. **Schemas.** `public` = domain tables (exposed via Data API only by explicit grant). `app` = functions/helpers (not exposed). `audit` = audit chain. `ai` = AI-layer tables. `pgmq` = queues (managed).
2. **Keys & types.** PKs `uuid DEFAULT gen_random_uuid()` (except append-only ledgers: `bigint GENERATED ALWAYS AS IDENTITY` for cheap ordering). Time = `timestamptz` UTC only. Money = `numeric(12,2)`. Enums as `text` + `CHECK` (migration-friendly) unless closed forever.
3. **Standard columns.** Every domain table: `tenant_id uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, and (mutable tables only) `updated_at` via trigger, `row_version int NOT NULL DEFAULT 1` for optimistic concurrency.
4. **RLS everywhere.** `ALTER TABLE … ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY;` on every domain table. No table is readable without a policy. Explicit `GRANT`s only (aligned with Supabase's 2026 explicit-exposure default).
5. **Append-only classes.** Tables marked **[AO]** (versions, audit, MAR, EVV raw events, AI interactions) get: no `UPDATE/DELETE` grants + `app.forbid_mutation()` trigger. Corrections are new rows referencing the corrected row — never edits.
6. **PHI classes.** Each table/column tagged `PHI` (protected health info), `PII` (workforce personal data), `OPS` (operational, non-identifying), `CFG` (configuration). Drives log-scrubbing, DLP, and the AI PHI-minimizer allowlists (Doc 11 §4).
7. **Naming.** `snake_case`; FKs `<entity>_id`; RPCs `app.<verb>_<noun>`; policies `<table>_<action>_<who>`; every index named.
8. **Migrations.** Sequential SQL via Supabase CLI, expand→migrate→contract, each guarded by pgTAP tests (Doc 12 §3). Destructive DDL forbidden without a decision-log entry.

---

## 2. Extensions & roles

```sql
create extension if not exists pgcrypto;      -- digest(), gen_random_uuid()
create extension if not exists vector;        -- pgvector: Agency Brain index
create extension if not exists postgis;       -- EVV geofencing
create extension if not exists pg_cron;       -- cadence engine ticks
create extension if not exists pgmq;          -- durable queues (Supabase Queues)
-- Supabase Vault is used for column-level secrets/crypto where flagged.

-- Least-privilege grants: nothing exposed by default.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
-- Per-table explicit grants appear with each table below.
```

## 3. Identity, tenancy & RBAC (implements Doc 01 FR-X-010…014)

```sql
-- ── Tenancy ────────────────────────────────────────────────────────────────
create table public.tenant (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);                                                                  -- CFG

-- ── Users (1:1 with Supabase auth.users) ──────────────────────────────────
create table public.app_user (
  id uuid primary key references auth.users(id) on delete restrict,
  tenant_id uuid not null references public.tenant(id),
  full_name text not null,                                          -- PII
  work_email text not null,                                         -- PII
  phone text,                                                       -- PII
  kind text not null check (kind in ('staff','family','system')),
  status text not null default 'active'
    check (status in ('invited','active','suspended','separated')),
  separated_at timestamptz,          -- drives ≤1-hr access-revocation control
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);

-- ── Permission catalog (seeded from Doc 01 RBAC matrix) ───────────────────
create table public.permission (
  key text primary key,              -- e.g. 'client.read', 'form.finalize',
  description text not null         --      'schedule.write', 'ai.approve.t1'
);                                                                  -- CFG
create table public.role (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,                 -- 'owner','admin','rn','coordinator',
  name text not null,               -- 'caregiver','hr','biller','family'
  is_system boolean not null default false,
  unique (tenant_id, key)
);                                                                  -- CFG
create table public.role_permission (
  role_id uuid references public.role(id) on delete cascade,
  permission_key text references public.permission(key),
  primary key (role_id, permission_key)
);                                                                  -- CFG
create table public.user_role (
  user_id uuid references public.app_user(id) on delete cascade,
  role_id uuid references public.role(id) on delete cascade,
  granted_by uuid references public.app_user(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role_id)
);                                                                  -- OPS

-- ── Assignment scoping: the heart of least-privilege ──────────────────────
create table public.care_team_assignment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null,           -- FK added after client table
  user_id uuid not null references public.app_user(id),
  role_on_case text not null check (role_on_case in
    ('caregiver','rn_case_manager','supervisor','backup')),
  starts_on date not null default current_date,
  ends_on date,                      -- null = active
  created_at timestamptz not null default now()
);                                                                  -- OPS
create index idx_cta_user_active on public.care_team_assignment (user_id)
  where ends_on is null;
create index idx_cta_client_active on public.care_team_assignment (client_id)
  where ends_on is null;
```

### 3.1 Authorization helpers (used by every policy)

```sql
create schema if not exists app;

create or replace function app.current_user_id() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.current_tenant_id() returns uuid
language sql stable as $$
  select tenant_id from public.app_user where id = auth.uid()
$$;

create or replace function app.is_aal2() returns boolean
language sql stable as $$
  select coalesce(auth.jwt()->>'aal','aal1') = 'aal2'   -- MFA-verified session
$$;

create or replace function app.has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_role ur
    join public.role_permission rp on rp.role_id = ur.role_id
    join public.app_user u on u.id = ur.user_id
    where ur.user_id = auth.uid() and rp.permission_key = p
      and u.status = 'active'
  )
$$;

create or replace function app.on_care_team(p_client uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.care_team_assignment a
    where a.client_id = p_client and a.user_id = auth.uid()
      and a.starts_on <= current_date
      and (a.ends_on is null or a.ends_on >= current_date)
  )
$$;
```

*(These `security definer` helpers are read-only, `search_path`-pinned, and themselves covered by pgTAP tests — the standard safe pattern for RLS predicates that must cross tables.)*

## 4. Guard machinery: append-only + audit chain (implements FR-X-001…006, 020…023)

```sql
-- ── Universal mutation guard for [AO] tables ──────────────────────────────
create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'CAREOS_APPEND_ONLY: % on % is forbidden — append a new row',
    tg_op, tg_table_name using errcode = 'P0001';
end $$;

-- ── Tamper-evident audit ledger ───────────────────────────────────────────
create schema if not exists audit;
create table audit.audit_event (            -- [AO]  OPS (payload PHI-minimized)
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  occurred_at timestamptz not null default now(),
  actor_id uuid,                            -- null = system
  actor_kind text not null default 'user' check (actor_kind in ('user','system','agent')),
  action text not null,                     -- 'form.finalize','visit.clock_in',…
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}',      -- IDs & deltas only — never raw PHI
  ip inet, user_agent text,
  prev_hash bytea,
  hash bytea not null
);
create index idx_audit_entity on audit.audit_event (tenant_id, entity_type, entity_id, id);

create or replace function audit.compute_chain() returns trigger
language plpgsql as $$
declare v_prev bytea;
begin
  select hash into v_prev from audit.audit_event
   where tenant_id = new.tenant_id order by id desc limit 1;
  new.prev_hash := v_prev;
  new.hash := digest(
    coalesce(v_prev,'\x00'::bytea) ||
    convert_to(new.tenant_id::text || new.occurred_at::text ||
               coalesce(new.actor_id::text,'') || new.action ||
               new.entity_type || coalesce(new.entity_id::text,'') ||
               new.payload::text, 'utf8'), 'sha256');
  return new;
end $$;
create trigger trg_audit_chain before insert on audit.audit_event
  for each row execute function audit.compute_chain();
create trigger trg_audit_ao before update or delete on audit.audit_event
  for each row execute function app.forbid_mutation();

create or replace function app.emit_audit(
  p_action text, p_entity_type text, p_entity_id uuid, p_payload jsonb default '{}'
) returns void language sql security definer set search_path = public, audit as $$
  insert into audit.audit_event (tenant_id, actor_id, action, entity_type, entity_id, payload)
  values (app.current_tenant_id(), auth.uid(), p_action, p_entity_type, p_entity_id, p_payload)
$$;

create table audit.audit_anchor (           -- daily root exported to WORM storage
  day date primary key,
  tenant_id uuid not null,
  last_event_id bigint not null,
  root_hash bytea not null,
  exported_at timestamptz
);
```

## 5. Clients & the forms/versioning engine (fixes pain #1; implements M2/M3)

```sql
create table public.client (                               -- PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  status text not null default 'inquiry' check (status in
    ('inquiry','pending_admission','active','on_hold','discharged')),
  first_name text not null, last_name text not null,
  dob date, sex text,
  address_line1 text, address_line2 text, city text, state text, zip text,
  geo geography(point,4326),               -- geocoded service location
  geofence_radius_m int not null default 150,
  primary_phone text, primary_language text not null default 'en',
  payer_type text check (payer_type in ('private','medicaid','ltc_insurance','va','other')),
  medicaid_id text,                        -- Vault-encrypted at rest (Doc 09 §6)
  admitted_on date, discharged_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
alter table public.care_team_assignment
  add constraint fk_cta_client foreign key (client_id) references public.client(id);

alter table public.client enable row level security;
alter table public.client force row level security;
create policy client_select_scoped on public.client for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('client.read.all') or app.on_care_team(id)
    ));
create policy client_write_admin on public.client
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('client.write'))
  with check (tenant_id = app.current_tenant_id());
grant select, insert, update on public.client to authenticated;  -- RLS gates rows

-- ── Form templates (JSON-Schema-driven; versioned definitions) ────────────
create table public.form_template (                        -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,                    -- 'rn_assessment','plan_of_care',
  title text not null,                  -- 'visit_note','incident_report',…
  version int not null default 1,
  schema jsonb not null,                -- JSON Schema (field defs, required)
  ui jsonb not null default '{}',       -- layout hints for the renderer
  requires_signature_roles text[] not null default '{}',
  status text not null default 'active' check (status in ('draft','active','retired')),
  unique (tenant_id, key, version)
);

-- ── Instances (the logical document) + versions (the append-only truth) ───
create table public.form_instance (                        -- PHI (by reference)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  template_id uuid not null references public.form_template(id),
  client_id uuid references public.client(id),
  employee_id uuid,                     -- HR-side forms (FK in §8)
  visit_id uuid,                        -- visit-bound notes (FK in §6)
  status text not null default 'draft' check (status in
    ('draft','in_review','final','superseded','void')),
  current_version_id uuid,              -- convenience pointer (trigger-set)
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);

create table public.form_version (                         -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  instance_id uuid not null references public.form_instance(id),
  version_no int not null,
  prev_version_id uuid references public.form_version(id),
  content jsonb not null,               -- the answers
  content_hash bytea not null,          -- sha256(canonical(content))
  author_id uuid not null references public.app_user(id),
  authored_at timestamptz not null default now(),
  kind text not null default 'edit' check (kind in
    ('create','edit','correction','import','ai_draft')),
  ai_interaction_id uuid,               -- provenance when kind='ai_draft'
  note text,                            -- e.g. correction reason (required by RPC)
  unique (instance_id, version_no)
);
create trigger trg_form_version_ao before update or delete on public.form_version
  for each row execute function app.forbid_mutation();
revoke update, delete on public.form_version from authenticated;
grant select, insert on public.form_version to authenticated;   -- RLS gates rows

create policy form_version_select on public.form_version for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.form_instance fi
    where fi.id = instance_id and (
      app.has_perm('form.read.all')
      or (fi.client_id is not null and app.on_care_team(fi.client_id))
      or fi.created_by = auth.uid())));
create policy form_version_insert on public.form_version for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
              and author_id = auth.uid());

-- ── Signatures bound to content hashes (native e-sign; Doc 08 §5) ─────────
create table public.signature (                            -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  form_version_id uuid not null references public.form_version(id),
  signer_id uuid not null references public.app_user(id),
  signer_role text not null,
  signed_at timestamptz not null default now(),
  content_hash bytea not null,          -- must equal version.content_hash
  method text not null default 'click' check (method in ('click','drawn','external_docusign')),
  session_aal text not null,            -- captured 'aal2' evidence
  ip inet, user_agent text
);
create trigger trg_signature_ao before update or delete on public.signature
  for each row execute function app.forbid_mutation();
```

**Finalize RPC (the only path to `final`):**

```sql
create or replace function app.finalize_form(p_instance uuid, p_version uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v record;
begin
  select fi.*, fv.content_hash into v
    from public.form_instance fi
    join public.form_version fv on fv.id = p_version and fv.instance_id = fi.id
   where fi.id = p_instance for update;
  if not found then raise exception 'not found'; end if;
  if not app.is_aal2() then raise exception 'MFA (AAL2) required'; end if;
  if not (app.has_perm('form.finalize') or v.created_by = auth.uid()) then
    raise exception 'not authorized'; end if;
  -- required signatures present? (template-driven)
  perform 1 from public.form_template t where t.id = v.template_id
    and (cardinality(t.requires_signature_roles) = 0
         or not exists (select unnest(t.requires_signature_roles)
                        except
                        select s.signer_role from public.signature s
                        where s.form_version_id = p_version));
  if not found then raise exception 'missing required signature(s)'; end if;

  update public.form_instance
     set status='final', current_version_id=p_version,
         updated_at=now(), row_version=row_version+1
   where id = p_instance;
  perform app.emit_audit('form.finalize','form_instance',p_instance,
                         jsonb_build_object('version_id',p_version));
end $$;
```

## 6. Scheduling, visits & EVV (implements M4/M5; Doc 02 §4)

```sql
create table public.service_type (        -- CFG: 'personal_care','respite',…
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null, name text not null, evv_required boolean not null default true,
  unique (tenant_id, key)
);

create table public.shift (                                -- OPS→PHI (links)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  caregiver_id uuid references public.app_user(id),   -- null = open shift
  service_type_id uuid not null references public.service_type(id),
  starts_at timestamptz not null, ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in
    ('draft','open','offered','scheduled','in_progress','completed',
     'missed','cancelled')),
  recurrence_id uuid,                    -- series pointer
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_shift_times check (ends_at > starts_at)
);
create index idx_shift_caregiver_day on public.shift (caregiver_id, starts_at);
create index idx_shift_client_day on public.shift (client_id, starts_at);
create index idx_shift_open on public.shift (tenant_id, starts_at) where status='open';

create table public.visit (                                -- PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  shift_id uuid not null unique references public.shift(id),
  clock_in_at timestamptz, clock_out_at timestamptz,
  clock_in_geo geography(point,4326), clock_out_geo geography(point,4326),
  clock_in_accuracy_m numeric(6,1), clock_out_accuracy_m numeric(6,1),
  method text check (method in ('mobile_gps','telephony_ivr','manual_attested')),
  within_geofence_in boolean, within_geofence_out boolean,
  offline_captured boolean not null default false,   -- queued on device
  device_id text,
  status text not null default 'pending' check (status in
    ('pending','in_progress','complete','exception','void'))
);

create table public.visit_event (                          -- [AO] OPS raw ledger
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  visit_id uuid not null references public.visit(id),
  kind text not null check (kind in ('clock_in','clock_out','task_done','note','exception')),
  at timestamptz not null,               -- device-captured time
  received_at timestamptz not null default now(),
  geo geography(point,4326), accuracy_m numeric(6,1),
  payload jsonb not null default '{}',
  client_event_id uuid not null unique   -- device idempotency key (offline sync)
);
create trigger trg_visit_event_ao before update or delete on public.visit_event
  for each row execute function app.forbid_mutation();

create table public.evv_submission (                       -- OPS state machine
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  visit_id uuid not null references public.visit(id),
  target text not null default 'isas',
  status text not null default 'pending' check (status in
    ('pending','submitted','accepted','rejected','corrected','reconciled')),
  attempt int not null default 0,
  last_error text, external_ref text,
  submitted_at timestamptz, reconciled_at timestamptz,
  updated_at timestamptz not null default now()
);
```

**Clock-in RPC (geofence + idempotency + audit, offline-tolerant):**

```sql
create or replace function app.clock_in(
  p_shift uuid, p_lat double precision, p_lng double precision,
  p_accuracy numeric, p_at timestamptz, p_client_event uuid, p_offline boolean default false
) returns public.visit language plpgsql security definer set search_path=public as $$
declare v_visit public.visit; v_client public.client; v_in boolean;
begin
  perform 1 from public.shift s where s.id=p_shift and s.caregiver_id=auth.uid();
  if not found then raise exception 'not your shift'; end if;

  insert into public.visit (tenant_id, shift_id)
    select tenant_id, id from public.shift where id=p_shift
  on conflict (shift_id) do nothing;
  select * into v_visit from public.visit where shift_id=p_shift for update;

  -- idempotent replay (offline retry)
  if exists (select 1 from public.visit_event where client_event_id=p_client_event)
    then return v_visit; end if;

  select c.* into v_client from public.client c
    join public.shift s on s.client_id=c.id where s.id=p_shift;
  v_in := st_dwithin(v_client.geo,
                     st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography,
                     v_client.geofence_radius_m);

  update public.visit set
    clock_in_at = coalesce(clock_in_at, p_at),
    clock_in_geo = st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography,
    clock_in_accuracy_m = p_accuracy,
    within_geofence_in = v_in,
    offline_captured = offline_captured or p_offline,
    method = 'mobile_gps',
    status = case when v_in then 'in_progress' else 'exception' end
  where id = v_visit.id;

  insert into public.visit_event (tenant_id, visit_id, kind, at, geo, accuracy_m,
                                  payload, client_event_id)
  values (v_visit.tenant_id, v_visit.id, 'clock_in', p_at,
          st_setsrid(st_makepoint(p_lng,p_lat),4326)::geography, p_accuracy,
          jsonb_build_object('within_geofence', v_in), p_client_event);

  update public.shift set status='in_progress', updated_at=now(),
         row_version=row_version+1 where id=p_shift;
  perform app.emit_audit('visit.clock_in','visit',v_visit.id,
          jsonb_build_object('within_geofence',v_in,'offline',p_offline));
  perform pgmq.send('q_evv_isas', jsonb_build_object('visit_id', v_visit.id));
  return (select v from public.visit v where v.id = v_visit.id);
end $$;
```

*(Out-of-geofence never blocks care: it records, flags `exception`, prompts the caregiver for a reason, and routes to coordinator review — Doc 05 FR-AI-032.)*

## 7. Compliance cadence engine (implements Doc 02 §3; M8)

```sql
create table public.compliance_rule (                      -- CFG (COMAR-seeded)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,            -- 'assessment.initial','assessment.annual',
  name text not null,           -- 'assessment.48h_high_acuity',
  subject text not null check (subject in ('client','employee')),
  trigger_kind text not null check (trigger_kind in
    ('on_admission','interval_days','on_event','credential_expiry')),
  interval_days int,            -- 365 annual · 45/90/120 supervisory · etc.
  grace_days int not null default 0,
  severity text not null default 'high' check (severity in ('info','medium','high','critical')),
  source_ref text,              -- 'COMAR 10.07.05.12B' — survey traceability
  active boolean not null default true,
  unique (tenant_id, key)
);

create table public.compliance_obligation (                -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  rule_id uuid not null references public.compliance_rule(id),
  client_id uuid references public.client(id),
  employee_id uuid,
  due_at timestamptz not null,
  status text not null default 'open' check (status in
    ('open','at_risk','overdue','satisfied','waived')),
  satisfied_by_entity text, satisfied_by_id uuid,   -- e.g. the form_instance
  waiver_reason text, waived_by uuid,               -- RN-documented waiver path
  updated_at timestamptz not null default now()
);
create index idx_oblig_open on public.compliance_obligation (tenant_id, due_at)
  where status in ('open','at_risk','overdue');

-- Hourly tick: (re)materialize obligations, transition at_risk/overdue, emit events.
select cron.schedule('careos_cadence_tick','5 * * * *',
  $$select app.evaluate_compliance()$$);
```

`app.evaluate_compliance()` is pure deterministic SQL/plpgsql (Engine 1 — Doc 05 §1): it derives due dates from admissions, latest satisfied obligations, medication-involvement level (45/90/120-day supervisory cadence), and credential expiries; transitions statuses; and enqueues `q_notifications` events with **IDs only**. Every rule row carries its `source_ref` so a surveyor can trace software behavior to the regulation.

## 8. Workforce & credentials (implements M7; Doc 02 §7 HR forms)

```sql
create table public.employee (                             -- PII
  id uuid primary key references public.app_user(id),
  tenant_id uuid not null references public.tenant(id),
  role_title text not null,          -- 'RN','LPN','CNA','HHA','Coordinator'
  hire_date date not null,
  employment_status text not null default 'active' check (employment_status in
    ('candidate','onboarding','active','leave','separated')),
  medication_involvement text not null default 'none' check (medication_involvement in
    ('administers','assists_self_admin','none')),   -- drives 45/90/120 cadence
  supervisor_id uuid references public.app_user(id),
  updated_at timestamptz not null default now(), row_version int not null default 1
);

create table public.credential_type (      -- CFG: 'rn_license','cna_cert','cpr',
  id uuid primary key default gen_random_uuid(),                 -- 'tb_screen',
  tenant_id uuid not null,                 -- 'background_check','tb_annual',…
  key text not null, name text not null,
  required_for_titles text[] not null default '{}',
  renewal_interval_days int, blocks_scheduling boolean not null default true,
  source_ref text,                          -- COMAR 10.07.05.10/.11
  unique (tenant_id, key)
);

create table public.credential (                           -- PII
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  employee_id uuid not null references public.employee(id),
  type_id uuid not null references public.credential_type(id),
  identifier text,                          -- license #
  issued_on date, expires_on date,
  verification_status text not null default 'pending' check (verification_status in
    ('pending','verified','rejected','expired')),
  verified_by uuid, verified_at timestamptz,
  document_id uuid,                         -- scanned evidence (§9)
  ai_extracted boolean not null default false,
  updated_at timestamptz not null default now(), row_version int not null default 1
);
create index idx_credential_expiry on public.credential (tenant_id, expires_on)
  where verification_status = 'verified';
```

**Scheduling guard:** `app.assert_schedulable(caregiver, client, at)` — called by shift-assignment RPCs — refuses assignment if any `blocks_scheduling` credential is missing/expired or required training is incomplete. *No worker ever serves a client with a lapsed license — by construction* (Doc 01 G5).

## 9. Documents, storage & retention

```sql
create table public.document (                             -- PHI/PII metadata
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  bucket text not null,                 -- 'client-docs' | 'hr-docs' | 'intake-inbox'
  storage_path text not null unique,
  sha256 bytea not null,
  content_type text, byte_size bigint,
  classification text not null check (classification in ('phi','pii','ops')),
  client_id uuid references public.client(id),
  employee_id uuid references public.employee(id),
  source text not null default 'upload' check (source in
    ('upload','fax','email','migration','generated')),
  retention_until date,                 -- 6-year COMAR default, computed on file
  legal_hold boolean not null default false,
  uploaded_by uuid, created_at timestamptz not null default now()
);
```

Buckets are **private**; access is via storage RLS mirroring the owning entity's policy plus short-TTL signed URLs minted server-side. Deletion is possible **only** through `app.retention_sweep()` (respects `retention_until` + `legal_hold`, logs to audit) — there is no ad-hoc delete path.

## 10. Data dictionary — remaining domains (DDL in migrations, same conventions)

| Domain | Tables | Purpose / key columns | Class | Notes |
|---|---|---|---|---|
| Care planning | `care_plan`, `care_plan_version` [AO], `care_plan_task` | COMAR-required plan contents; tasks feed visit checklists & the matching engine | PHI | Versioned exactly like forms; RN signature to finalize |
| Medications | `medication`, `mar_entry` [AO] | Client med list; administration/assist log incl. errors & adverse reactions | PHI | MAR is append-only per COMAR 10.07.05.12 |
| On-call | `on_call_shift`, `on_call_log` [AO] | 24/7 coverage roster; response log (1-hr response evidence) | OPS/PHI | Doc 02 §3 |
| Incidents & grievances | `incident`, `incident_version` [AO], `grievance` | Structured reports, severity, routing, resolution | PHI | FR-AI-044 feeds drafts |
| Notifications | `notification`, `notification_delivery`, `escalation_policy` | ID-only payloads; per-channel delivery state; escalation chains | OPS | Doc 06 §6.4 |
| Events/queues | `domain_event` [AO], pgmq queues + DLQs | Transactional outbox; consumer offsets | OPS | Doc 06 §5 |
| Billing prep | `payer`, `authorization`, `billable_visit`, `claim_export`, `payroll_period`, `pay_exception` | EVV-verified billables; QuickBooks export batches; payroll reconciliation | OPS/PHI | Doc 08 §6.4 |
| Family portal | `family_member_link`, `family_update`, `portal_consent` | Scoped read access; approved updates only | PHI | Consent-gated (COMAR .15/.16) |
| Comms | `message_thread`, `message` [AO], `sms_log` | Internal messaging; Twilio delivery records (minimized bodies) | PHI | Retention-scoped |
| AI layer (`ai.*`) | `ai_interaction` [AO], `ai_prompt_template`, `ai_capability_flag`, `agent_task`, `agent_step` [AO], `ai_metric`, `ai_budget` | Full provenance: model+version, template version, tier, confidence, human disposition; kill switches; spend caps | OPS (PHI-minimized refs) | Doc 11 §3 |
| Knowledge (Brain) | `knowledge_document`, `knowledge_chunk` (`embedding vector(1024)`, `fts tsvector`, `scope`, `sensitivity`) | RBAC-aware RAG index | OPS/PHI | RLS on chunks = same predicates as source entities; hybrid index (`hnsw` + GIN) |
| Config | `agency_setting`, `holiday_calendar`, `notification_pref` | Tenant configuration | CFG | |

## 11. RLS policy catalog & verification

Every table ships with a policy set named per convention and a **pgTAP matrix test**: for each (role × representative row × operation) the expected allow/deny is asserted in CI (Doc 12 §3). The catalog (63 policies at v1.0) is generated into `db/policies.md` from the migrations so the *documented* and *deployed* policy sets cannot drift — drift fails the build. Sensitive-column protection (e.g., `client.medicaid_id`, pay rates) uses Vault-backed encrypted columns + column-privilege revocation with accessor RPCs, so even broad `select` grants never expose them (Doc 09 §6).

## 12. Seed & fixture policy

Migrations seed: permission catalog + system roles (from Doc 01 RBAC matrix), `compliance_rule` rows for every Doc 02 §3 cadence (each with `source_ref`), `credential_type` rows for Doc 02 §7 HR items, and `form_template` v1 for the master forms inventory. **Synthetic fixtures only** outside production (Doc 12 §7) — generated personas, never real PHI.
