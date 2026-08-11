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
-- Extensions never land in `public`. The three CareOS calls directly are installed into
-- the `extensions` schema (the Supabase convention; USAGE granted in 0001), so their
-- types are referenced schema-qualified everywhere — `extensions.geography(Point,4326)`,
-- `extensions.vector(1024)` — and no extension object can shadow a domain table.
create extension if not exists pgcrypto with schema extensions;  -- digest(), gen_random_uuid()  [0001]
create extension if not exists vector   with schema extensions;  -- pgvector: Agency Brain index  [0015]
create extension if not exists postgis  with schema extensions;  -- EVV geofencing                [0043]
create extension if not exists pg_cron;       -- cadence engine + sweep ticks   [0034]
create extension if not exists pgmq;          -- durable queues (Supabase Queues) [0027]
create extension if not exists pg_net;        -- outbound worker dispatch        [0041]
-- Supabase Vault is used for column-level secrets/crypto where flagged.

-- Least-privilege grants: nothing exposed by default.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
-- Per-table explicit grants appear with each table below.
```

**PostGIS is live.** 0004 deferred client geography ("geo/geofence columns land with the EVV migration") and 0011 deliberately kept the scheduling spine pure-Postgres; **migration 0043 is the migration both were pointing at**, and it installs PostGIS into `extensions`. The deferral recorded in **D-011 clause 6 is therefore discharged** — but *not* where it was originally aimed. Geography does **not** live on `public.client`: it lives on `public.service_location_version` (§6.6), because a client can have several places of care (own home, a daughter's house, an adult day facility) and because binding a verified visit to an **address version** is what makes visit history immutable. See §5 and §6.6.

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
  -- SUPERSEDED — never built here. v1.0 sketched `geo geography(point,4326)` and
  -- `geofence_radius_m int not null default 150` on this row; 0004 deferred both
  -- (D-011 clause 6) and D-025 relocated them permanently to
  -- service_location_version (§6.6): one client, many places of care, and a verified
  -- visit binds to an address VERSION so correcting an address cannot rewrite history.
  -- The mailing address columns above stay — they are the client's address of record,
  -- not the geofence the clock engine measures against.
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

## 6. Scheduling, visits & EVV — the Verified Visit layer (implements M4/M5; Doc 02 §4)

Full design contract: **Doc 17**. Physically delivered by migrations 0011 (scheduling spine), 0013 (clock ledger), 0023 (Lane-B scheduling RPCs) and **0043–0052** (the Verified Visit & Workforce Intelligence layer).

> **Naming — superseded by D-023.** ~~v1.0 of this section named the schedulable care event `shift` (client-bound, `service_type_id`, open/offered lifecycle) and reserved `visit` for the 1:1 EVV clock-in/out realization.~~ The built model is the **inverse**, and D-023 ratified it: **`visit` is the scheduled care event** (client + caregiver + planned window + lifecycle) and **`shift` is the caregiver roster/availability window**. Migration 0011 built it that way, flagged the conflict in its own header, and left the reconciliation to "the S4 EVV migration"; by then ~30 migrations, the Lane-B scheduling RPCs, the outbox event names (`visit.assigned`, `visit.vacated`), the credential-lapse sweep and every UI surface already spoke it. EVV attaches **additively to `public.visit`**. There is no second visit table, ever.

> **The EVV realization — superseded by D-024 / D-025 / D-026.** ~~v1.0 sketched `clock_in_at` / `clock_out_at` / `clock_in_geo` / `within_geofence_in|out` / `method` / `device_id` columns on the `visit` row, a `visit_event` ledger keyed on device time, a single `evv_submission` state machine, and an `app.clock_in(p_shift, …)` RPC that geofenced against `client.geo`.~~ None of that is what exists. The built model is: the **append-only `visit_event` ledger is the single source of truth** for every clock fact; **actual times are derived**, not denormalized, in the `public.verified_visit` view (§6.5); the visit row carries **four orthogonal status axes** (§6.3) instead of one lifecycle enum; geography lives on **`service_location_version`** (§6.6), not on `client`; EVV is a canonical **`evv_record` + `evv_adapter` + `evv_submission`** trio (§6.10); and the clock RPC is `app.clock_visit(p_visit, …)` (§6.12). *A view can be slow; it cannot be stale* — a denormalized `clock_in_at` is a second copy of a fact maintained by a different code path, and the copy that feeds payroll is the one nobody re-reads.

### 6.1 `shift` — the caregiver roster window (0011)

```sql
create table public.shift (                                                       -- OPS
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
```

Availability, not care: no `client_id`, no `service_type_id`, no geofence. Read = own roster or `schedule.read`; write = `schedule.write`. Deliberately **not** audited — the consequential facts are captured one level up, on `visit` and `schedule_exception`.

### 6.2 `service_type` — the "type of service" EVV element (0043)

```sql
create table public.service_type (                                                -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  code text not null,                    -- 'PCA','CNA','RN_SUPERVISORY','COMPANION'
  name text not null,
  evv_required boolean not null default false,   -- most private-pay work carries no EVV duty
  payer_kind text not null default 'private'
    check (payer_kind in ('medicaid','medicare','private','waiver','other')),
  billable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint uq_service_type_tenant_code unique (tenant_id, code)
);
```

Built as `code` (v1.0 said `key`) and `evv_required default false` (v1.0 said `true`; defaulting to true would manufacture an EVV backlog out of private-pay work). A catalog, not PHI: read = any tenant member (a caregiver's own visit names a service type), insert/update = `schedule.write` via direct grants — the 0011 catalog posture, not the RPC-only posture, because no ledger or version semantics ride on these rows.

### 6.3 `visit` — the scheduled care event, and four orthogonal state axes (0011 + 0045)

```sql
create table public.visit (                                                       -- PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  caregiver_id uuid references public.app_user(id),   -- NULL ⇒ open / unassigned
  shift_id uuid references public.shift(id),          -- optional link to a roster block
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  status text not null default 'scheduled'            -- care delivery, unchanged by 0045
    check (status in ('scheduled','in_progress','completed','missed','cancelled')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_visit_window check (scheduled_end > scheduled_start)
);

-- ── 0045, expand phase: bindings + the four axes (D-024) ──────────────────────────────
alter table public.visit
  add column service_type_id uuid references public.service_type(id),
  add column service_location_id uuid references public.service_location(id),
  add column service_location_version_id uuid                 -- bound at first clock-in
    references public.service_location_version(id),
  add column policy_id uuid references public.visit_policy(id),  -- bound at first clock-in
  -- Axis 1 — did the evidence hold up?   (projects visit_event + visit_exception)
  add column verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','exception','manual_review')),
  -- Axis 2 — did a human sign off?        (projects approved_work_segment)
  add column approval_status text not null default 'pending'
    check (approval_status in ('pending','approved','rejected')),
  -- Axis 3 — has it left for payroll?     (projects payroll_export)
  add column payroll_status text not null default 'not_ready'
    check (payroll_status in ('not_ready','ready','exported')),
  -- Axis 4 — what does the state say?     (projects evv_submission)
  add column evv_status text not null default 'not_required'
    check (evv_status in
      ('not_required','pending','submitted','accepted','rejected','reconciled'));

create index idx_visit_verification_open on public.visit (tenant_id, scheduled_start)
  where verification_status in ('exception','manual_review');
create index idx_visit_approval_pending on public.visit (tenant_id, scheduled_start)
  where status = 'completed' and approval_status = 'pending';

revoke update on public.visit from authenticated;      -- restated postcondition, D-024
```

**Why four columns and not one enum (D-024).** "Verified but unapproved" and "approved but EVV-rejected" are ordinary Tuesday states. A single lifecycle enum can only express them by multiplying out, and the product of that multiplication is a state space in which illegal states are representable. Each axis is a **projection of an append-only ledger** — `visit_event` (§6.4), `visit_exception` (§6.8), `approved_work_segment` (§6.11), `evv_submission` (§6.10) — so the ledger stays the fact and the column stays a cache a definer RPC maintains and can rebuild. `visit.status` keeps its 0011 care-delivery meaning, untouched.

**Privilege posture.** D-024 prescribed revoking table-wide `UPDATE` from `authenticated` and re-granting the scheduling columns one by one. 0023 had already gone further: it dropped `visit_insert_scheduler` and `visit_update_scheduler` and revoked `insert, update` outright, making every scheduling mutation a definer-RPC act. Issuing column grants would therefore have **widened** the perimeter, and would have been inert anyway with no UPDATE policy left to work through. 0045 grants nothing and restates the revoke; pgTAP asserts the stronger property directly — **no UPDATE grant *and* no UPDATE policy on `public.visit`**. The four axes and the two binding columns are writable only by the definer RPCs in 0046/0047/0049/0050.

**RLS.** PHI ⇒ AAL2. Read = `schedule.read` (org-wide) **or** `app.on_care_team(client_id)` **or** `caregiver_id = auth.uid()`. `app.guard_visit()` pins tenant and client as immutable (a visit is rescheduled or cancelled, never re-pointed at another client).

### 6.4 `visit_event` — the append-only clock ledger (0013, extended by 0045)

```sql
create table public.visit_event (                                          -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  caregiver_id uuid not null references public.app_user(id),
  event_type text not null check (event_type in                -- widened by 0045
    ('clock_in','clock_out','clock_in_rejected','clock_out_rejected',
     'exception_requested','correction')),
  occurred_at timestamptz not null default now(),   -- SERVER time; the authoritative one
  latitude double precision, longitude double precision, accuracy_m double precision,
  method text not null default 'web' check (method in ('web','manual')),
  note text,
  created_at timestamptz not null default now(),
  -- ── 0045 additions ─────────────────────────────────────────────────────────────────
  client_event_id text,                    -- caller-supplied idempotency key (PWA replay)
  client_captured_at timestamptz,          -- DEVICE time: diagnostics only, never maths
  received_at timestamptz not null default now(),
  service_location_version_id uuid references public.service_location_version(id),
  policy_id uuid references public.visit_policy(id),
  distance_m double precision,             -- to the bound location; derived, not a coordinate
  location_status text check (location_status in
    ('verified','low_accuracy','outside_geofence','unavailable','suspicious','not_required')),
  capture_source text not null default 'web'
    check (capture_source in ('web','offline','manual','system')),
  is_offline boolean not null default false,
  device_session_id text,                  -- opaque, rotating — NOT a device fingerprint
  reason_code text check (reason_code in
    ('alternate_location','gps_unavailable','address_incorrect','emergency_visit',
     'device_issue','network_failure','other')),
  corrects_event_id uuid references public.visit_event(id)   -- corrections reference
);
create unique index uq_visit_event_client_event
  on public.visit_event (tenant_id, visit_id, client_event_id)
  where client_event_id is not null;
create index idx_visit_event_visit_type
  on public.visit_event (visit_id, event_type, occurred_at);
create trigger trg_visit_event_ao before update or delete on public.visit_event
  for each row execute function app.forbid_mutation();
```

**Server time is authoritative.** `occurred_at` defaults to `now()` and the RPC never accepts a caller-supplied value for it; `client_captured_at` is stored as drift evidence and is barred from payroll and EVV arithmetic. A phone with a wrong clock must not be able to move money.

**Rejections are records.** `clock_in_rejected` / `clock_out_rejected` are the durable evidence that somebody tried and the geofence said no — the thing an agency running on paper has no record of at all. The `verified_visit` laterals (§6.5) filter on the literal clock types, so a rejected attempt never becomes an arrival.

**Corrections reference, never overwrite** (invariant 1). `app.correct_visit_event` appends a `correction` row carrying its asserted time in `occurred_at` and `corrects_event_id` pointing at the original.

**RLS.** PHI ⇒ AAL2. Read = own events (`caregiver_id = auth.uid()`) **or** `schedule.read` **or** care-team on the visit's client. **No insert/update/delete grant anywhere** — `app.clock_visit` and `app.correct_visit_event` are the only writers, so a client cannot forge a clock event out of band. The audit payload carries `{visit_id, method, capture_source, location_status, is_offline}` — never a coordinate, never `distance_m` (D-030).

### 6.5 `public.verified_visit` — the derived operational read model (0045)

```sql
create or replace view public.verified_visit with (security_invoker = true) as
select v.id as visit_id, v.tenant_id, v.client_id, v.caregiver_id,
       v.service_type_id, v.service_location_id, v.service_location_version_id,
       v.policy_id, v.status, v.scheduled_start, v.scheduled_end,
       ci.occurred_at as actual_start,
       co.occurred_at as actual_end,
       floor(extract(epoch from (v.scheduled_end - v.scheduled_start))/60)::int
                                                        as scheduled_minutes,
       floor(extract(epoch from (co.occurred_at - ci.occurred_at))/60)::int
                                                        as verified_minutes,
       case when ci.occurred_at is null then null else
         greatest(floor(extract(epoch from (ci.occurred_at - v.scheduled_start))/60),0)::int
       end                                              as late_minutes,
       case when co.occurred_at is null then null else
         greatest(floor(extract(epoch from (co.occurred_at - v.scheduled_end))/60),0)::int
       end                                              as overrun_minutes,
       v.verification_status, v.approval_status, v.payroll_status, v.evv_status,
       ci.location_status as clock_in_location_status,
       co.location_status as clock_out_location_status,
       ci.distance_m      as clock_in_distance_m,
       co.distance_m      as clock_out_distance_m,
       ci.capture_source  as clock_in_capture_source,
       co.capture_source  as clock_out_capture_source,
       (coalesce(ci.is_offline,false) or coalesce(co.is_offline,false))
                                                        as had_offline_capture,
       ci.id as clock_in_event_id, co.id as clock_out_event_id
  from public.visit v
  left join lateral (…earliest clock_in…)  ci on true
  left join lateral (…latest  clock_out…) co on true;
grant select on public.verified_visit to authenticated;
```

`security_invoker` is load-bearing, not decoration: without it the view executes as its owner (who bypasses RLS) and hands every authenticated caller every tenant's clock ledger. With it, RLS on **both** base tables composes through — the `credential_expiry` (0008) / `cadence_obligation_status` (0009) / `employee_file_status` (0033) idiom. A principal who can read a visit but not one of its events gets NULL derived columns rather than someone else's clock data.

**Minutes are whole minutes, floored.** A visit 125 seconds short of two hours is 119 minutes, not 120 — rounding up silently invents paid time. Any `rounding_policy` is applied **on top** by `app.compute_visit_minutes` (0050); this view never rounds, so the unrounded truth stays retrievable. `verified_minutes` is deliberately **not** clamped at zero: a clock-out preceding its clock-in is an incoherent ledger and a negative number says so, while `approved_work_segment` CHECKs `>= 0` so the incoherence refuses to become money. `late_minutes` / `overrun_minutes` are **NULL when the clock event is missing, never 0** — `greatest()` ignores NULLs in Postgres, so the naïve form would report a visit nobody attended as "on time".

**No coordinate is selected anywhere in this definition** (D-030). Distance in metres is administrator evidence and stays inside this RLS-gated surface; the caregiver-facing RPC returns a bucket. pgTAP greps the view's own catalog definition for `latitude`/`longitude` so the property stays true rather than merely intended.

### 6.6 Places of care — `service_location` + `service_location_version` (0043)

This is where the geography that v1.0 put on `client` actually lives. `service_location` is the durable identity of a place; `service_location_version` **[AO]** is the geographic source of truth, following the `form_template`/`form_version` binding precedent (D-014): a verified visit binds the exact version it was verified against, so correcting an address can never rewrite what a clock-in meant.

```sql
create table public.service_location (                                            -- PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  current_version_id uuid,                        -- FK added after the version table
  kind text not null check (kind in ('primary_residence','temporary_residence',
    'family_residence','community','facility','alternate')),
  label text,                                     -- 'Home','Daughter''s house' — PHI-adjacent
  is_primary boolean not null default false,
  effective_from date not null default current_date,
  effective_until date,
  active boolean not null default true,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_service_location_effective_window
    check (effective_until is null or effective_until >= effective_from)
);
-- One live primary per client: the clock engine resolves "the client's primary place" on
-- every clock-in, and two live primaries would make that resolution ambiguous.
create unique index uq_service_location_primary
  on public.service_location (tenant_id, client_id) where is_primary and active;

create table public.service_location_version (                             -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  service_location_id uuid not null references public.service_location(id),
  supersedes_id uuid references public.service_location_version(id),
  created_by uuid not null references public.app_user(id),
  version_no int not null,                        -- server-assigned, 1-based
  original_address text not null,                 -- exactly as entered
  normalized_address text not null,               -- app.normalize_address()
  address_line1 text, address_line2 text, city text, state text,
  postal_code text, country text not null default 'US',
  geo extensions.geography(Point,4326),           -- NULL ⇒ unlocatable
  geo_precision text not null default 'unknown' check (geo_precision in
    ('rooftop','parcel','interpolated','street','locality','manual','unknown')),
  geo_source text not null default 'manual'
    check (geo_source in ('manual','import','provider','derived')),
  geo_provider text, geo_provider_place_id text,
  geo_provider_response_sha256 text,              -- provenance, never the raw response
  verification text not null default 'unverified'
    check (verification in ('unverified','verified','rejected')),
  verified_by uuid references public.app_user(id),          -- human attestation (D-025)
  verified_at timestamptz,
  geofence_radius_m int check (geofence_radius_m between 25 and 5000),  -- NULL ⇒ policy
  change_reason text,
  created_at timestamptz not null default now(),
  constraint uq_slv_location_version unique (service_location_id, version_no),
  constraint chk_slv_verified_needs_human
    check (verification <> 'verified'
           or (verified_by is not null and verified_at is not null))
);
create index idx_slv_geo on public.service_location_version using gist (geo)
  where geo is not null;
create trigger trg_slv_ao before update or delete on public.service_location_version
  for each row execute function app.forbid_mutation();
```

**No geocoding vendor is on this boundary (D-025).** Client addresses are PHI and Google Maps Platform is not BAA-eligible, so the corpus buys the *seam* and not the vendor. `app.normalize_address(line1, line2, city, state, postal, country default 'US')` is a pure **`immutable`** SQL function doing USPS Publication 28-style folding (uppercase, punctuation strip, whitespace collapse, whole-word directional and suffix/unit abbreviation) and is used for **comparison and dedupe only — never validation**: it answers "are these two strings the same place as written?", never "does this place exist?". A trusted coordinate arrives only from a human who attests it, and the attestation is structural rather than procedural — `chk_slv_verified_needs_human` makes a `verified` row impossible without `verified_by` + `verified_at`, and `verified_by` FKs `public.app_user`, so an AI capability can never satisfy it (the D-015 pattern). `geo_source` / `geo_provider*` exist unused so registering a BAA-eligible provider later is a **row, not a DDL change**.

**RLS.** Both PHI ⇒ AAL2. `service_location` read = `location.manage` **or** `app.on_care_team(client_id)` **or** an assigned caregiver on a visit for that client. `service_location_version` read follows the parent *literally*: its policy is an `EXISTS` over `service_location`, itself evaluated under the parent's policy, so the read rule has exactly one definition and cannot drift. **Neither table has any write grant** — the four §6.12 RPCs are the only way in, because version numbering, current-version binding and the human attestation are all invariants a direct INSERT could violate.

**Every write is an append.** `verify_service_location` and `set_service_location_geofence` take a `p_version` parameter that reads like an in-place edit; the table is [AO], so both **append a new version** carrying the change with `supersedes_id = p_version`. Same observable contract, honest history.

### 6.7 `visit_policy` — the rules a visit is measured against (0044)

```sql
create table public.visit_policy (                                        -- [AO] CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  scope_kind text not null
    check (scope_kind in ('tenant','program','payer_kind','service_type','client')),
  scope_id uuid,                                  -- NULL for tenant / payer_kind scopes
  scope_value text,                               -- payer_kind literal, else NULL
  version_no int not null,                        -- server-assigned, 1-based
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  -- geofence
  geofence_tier text not null default 'standard'
    check (geofence_tier in ('strict','standard','rural','custom')),
  geofence_radius_m int not null default 200 check (geofence_radius_m between 25 and 5000),
  max_accuracy_m int not null default 250 check (max_accuracy_m between 10 and 5000),
  require_clock_in_location  boolean not null default true,
  require_clock_out_location boolean not null default true,
  allow_location_exception   boolean not null default true,
  -- time (minutes)
  early_clock_in_minutes int not null default 15,
  late_threshold_minutes int not null default 7,
  clock_out_grace_minutes int not null default 10,
  missing_clock_out_minutes int not null default 20,
  missed_visit_minutes int not null default 60,
  max_visit_minutes int not null default 900,
  -- documentation
  require_visit_note boolean not null default false,
  require_task_completion boolean not null default false,
  signature_requirement text not null default 'none' check (signature_requirement in
    ('none','optional','required_for_service','required_for_payer')),
  -- money
  rounding_policy text not null default 'none' check (rounding_policy in
    ('none','nearest_1','nearest_5','nearest_6','nearest_15')),
  overtime_weekly_minutes int not null default 2400,          -- 40h
  -- fraud
  impossible_travel_kmh int not null default 120,
  supersedes_id uuid references public.visit_policy(id),
  change_reason text,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT is load-bearing: scope_id and scope_value are NULL on every
  -- tenant-scope row, and default NULL semantics would enforce nothing on exactly the
  -- scope that matters most.
  constraint uq_visit_policy_scope_version unique nulls not distinct
    (tenant_id, scope_kind, scope_id, scope_value, version_no),
  constraint chk_visit_policy_scope_id
    check ((scope_id is null) = (scope_kind in ('tenant','payer_kind'))),
  constraint chk_visit_policy_scope_value
    check (case when scope_kind = 'payer_kind'
                then scope_value in ('medicaid','medicare','private','waiver','other')
                else scope_value is null end),
  constraint chk_visit_policy_effective_window
    check (effective_until is null or effective_until > effective_from),
  constraint chk_visit_policy_durations check (…all non-negative, max_visit_minutes > 0,
    impossible_travel_kmh > 0…)
);
```

Resolution is **most-specific-wins, field-by-field merge** over `client → service_type → payer_kind → program → tenant`, via `app.resolve_visit_policy(p_client, p_service_type default null, p_at default now()) returns public.visit_policy` and `app.visit_policy_for(p_visit)`. Both are `stable` and deterministic; a tenant-scope row is the floor, and its absence raises `CAREOS_POLICY_MISSING`. Superseded versions are never closed off with an UPDATE — they cannot be — so resolution takes the highest `version_no` among rows actually in force at the instant asked about.

Not PHI. **Read = any active tenant member, no AAL2** — a caregiver must be able to see their own grace period. No insert grant either: `app.upsert_visit_policy(p_scope_kind, p_scope_id, p_scope_value, p_settings, p_reason)` (gated on `policy.manage`) appends the new version.

> Tier values are **engineering defaults, not regulatory thresholds**: `strict` 75–150 m, `standard` 150–300 m, `rural` 300–750 m. No COMAR or federal rule sets a geofence radius; agencies do.

### 6.8 Exceptions — `visit_exception`, `visit_exception_disposition`, `visit_exception_state` (0047)

```sql
create table public.visit_exception (                                      -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  caregiver_id uuid references public.app_user(id),   -- NULL ⇒ nobody was on the visit
  kind text not null check (kind in (
    'location_unverified','low_accuracy','outside_geofence','location_unavailable',
    'late_start','early_end','long_visit','short_visit','missing_clock_out','missed_visit',
    'overlapping_visits','impossible_travel','manual_correction','duplicate_visit',
    'evv_rejected','payroll_mismatch','documentation_missing')),
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  detected_by text not null default 'rule' check (detected_by in ('rule','human','agent')),
  rule_key text,                                     -- 'sweep.missing_clock_out'
  dedupe_key text not null,                          -- what makes the sweeps idempotent
  evidence jsonb not null default '{}'::jsonb,       -- IDs + numbers ONLY (invariant 5)
  source_event_id uuid references public.visit_event(id),
  created_by uuid references public.app_user(id),    -- NULL ⇒ the sweep, not a person
  created_at timestamptz not null default now(),
  constraint uq_visit_exception_dedupe unique (tenant_id, visit_id, kind, dedupe_key),
  -- D-030 made structural: no future detector can smuggle a coordinate onto a surface
  -- the exception queue reads, exports, or hands to a model.
  constraint chk_visit_exception_evidence_no_coords
    check (not (evidence ?| array['lat','lng','latitude','longitude',
                                  'coordinates','geo','point']::text[]))
);

create table public.visit_exception_disposition (                          -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  exception_id uuid not null references public.visit_exception(id),
  disposition text not null check (disposition in
    ('acknowledged','resolved','dismissed','escalated','reopened')),
  reason text not null,
  acted_by uuid not null references public.app_user(id),   -- ALWAYS a human (D-020)
  created_at timestamptz not null default now(),
  seq bigint generated always as identity,                 -- APPEND ORDER, see below
  constraint chk_visit_exception_disposition_reason check (btrim(reason) <> '')
);
```

`uq_visit_exception_dedupe` is what makes the five-minute sweep idempotent: a detector re-running is an `ON CONFLICT DO NOTHING`, so running it twice raises no duplicate.

**Why `seq` exists** (an addition to the Doc 17 §3.8 shape). The current state of a finding is "the latest disposition", and `created_at` cannot decide that alone: `now()` is the *transaction* timestamp, so two dispositions written in one transaction carry the identical instant and the tiebreak falls to a random uuid — a state machine whose current state is decided by `gen_random_uuid()` is not a state machine. An identity column is the same instrument `audit.audit_event` uses to order its chain. Ordering only: never an FK target, never surfaced.

Current state is exposed by **`public.visit_exception_state`** (`security_invoker` view): the exception's own columns plus `latest_disposition_id`, `latest_disposition`, `disposed_by`, `disposed_at`, and `open` = *no disposition yet, or the latest one reopened it*. Escalation is closed here and open on the escalation surface, which is a different queue.

**RLS.** Both PHI-by-reference ⇒ AAL2. `visit_exception` read = the caregiver the exception is *about* (a workforce record about a person is a record that person may read), **or** `visit.verify.read`, **or** care-team on the visit's client. `schedule.read` is deliberately excluded — **seeing the roster is not seeing the fraud queue**. Dispositions follow the parent exactly. Neither table has a write grant; `app.raise_visit_exception`, `app.request_location_exception` and `app.dispose_visit_exception` are the ways in.

### 6.9 `visit_trust_assessment` — deterministic score snapshots (0048)

```sql
create table public.visit_trust_assessment (                               -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  score int not null check (score between 0 and 100),
  band text not null check (band in
    ('verified','verified_with_exception','requires_review','high_risk')),
  components jsonb not null,     -- points EARNED per component
  reasons jsonb not null,        -- [{code,component,points,detail_id}] — codes + ids only
  model_version text not null,   -- 'trust.v1' — the weight set that produced this row
  computed_at timestamptz not null default now(),
  -- The band can never disagree with its own arithmetic (D-028).
  constraint chk_visit_trust_assessment_band_v1
    check (model_version <> 'trust.v1' or band = case
             when score >= 90 then 'verified'
             when score >= 75 then 'verified_with_exception'
             when score >= 50 then 'requires_review'
             else 'high_risk' end),
  constraint chk_visit_trust_assessment_no_coords check (…D-030, components and reasons…),
  -- The closed trust.v1 reason vocabulary: twelve codes, never prose about a person.
  constraint chk_visit_trust_assessment_reason_vocabulary check (…)
);
```

Weights (`trust.v1`): location 35, time 20, schedule 15, identity 15, device 10, consistency 5. `app.visit_trust_score(p_visit)` computes and stores nothing; `app.record_trust_assessment(p_visit)` computes and appends a snapshot. **Deterministic evidence, never an automated adverse action (D-028)** — a caregiver disputing a score gets an arithmetic answer, which is also what survives a wage-and-hour challenge. The reason-vocabulary CHECK is the guard against a future caller writing a sentence into `code`, which is how a deterministic score quietly becomes a character assessment.

**RLS.** AAL2 + (`visit.verify.read` **or** `schedule.read`). Deliberately narrower than §6.8: care-team membership is *not* sufficient and neither is being the scored visit's caregiver, because an assessment characterises the **caregiver** — an operations artifact, not a clinical one. D-028's promise is kept by disclosing the subtraction through the verification surface with a human in the loop, not by opening every snapshot to probing. **No insert grant and no insert policy** (stricter than the usual [AO] select+insert): a client that could insert a score could forge one, and a forged score is worse than no score.

### 6.10 Canonical EVV — `evv_record`, `evv_adapter`, `evv_submission` (0049)

> **Superseded.** ~~v1.0's single `evv_submission (visit_id, target, status, attempt, last_error, external_ref, …)` state machine.~~ D-026 splits the concern: the **canonical record is state-agnostic and adapters translate**, so Maryland's format is never built into the database.

```sql
create table public.evv_record (                                           -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  source_visit_id uuid not null references public.visit(id),
  service_type_id uuid references public.service_type(id),          -- (1) type of service
  client_id uuid not null references public.client(id),             -- (2) who received it
  service_date date not null,                                       -- (3) date of service
  service_location_version_id uuid
    references public.service_location_version(id),                 -- (4) where
  caregiver_id uuid references public.app_user(id),                 -- (5) who provided it
  start_at timestamptz not null,                                    -- (6a) begin time
  end_at timestamptz not null,                                      -- (6b) end time
  capture_method text not null default 'web_gps' check (capture_method in
    ('web_gps','manual','offline_sync','telephony','corrected')),
  exception_code text,                       -- adapter vocabulary; NULL until one exists
  payer_kind text not null default 'other'
    check (payer_kind in ('medicaid','medicare','private','waiver','other')),
  element_completeness jsonb not null,       -- exactly six booleans, keys CHECK-fixed
  is_complete boolean not null,              -- their conjunction, CHECK-enforced
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_id uuid references public.evv_record(id),
  created_at timestamptz not null default now(),
  constraint chk_evv_record_window check (end_at >= start_at)
);

create table public.evv_adapter (                                                 -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  target text not null check (target in ('isas','sandata','hhax','none')),
  state_code text not null check (state_code ~ '^[A-Z]{2}$'),
  mode text not null default 'disabled'
    check (mode in ('capture','reconcile','dual','disabled')),
  enabled boolean not null default false,
  adapter_version text,
  config jsonb not null default '{}'::jsonb,     -- NON-SECRET only, CHECK-enforced
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_evv_adapter_enabled_mode check (not enabled or mode <> 'disabled'),
  -- Adapter credentials live in Vault (Doc 09 §5); this refuses api_key/secret/token/… keys.
  constraint chk_evv_adapter_config_non_secret check (…)
);

create table public.evv_submission (                                       -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  evv_record_id uuid not null references public.evv_record(id),
  adapter_id uuid not null references public.evv_adapter(id),
  attempt_no int not null check (attempt_no >= 1),
  status text not null default 'pending' check (status in
    ('pending','submitted','accepted','rejected','superseded','reconciled')),
  external_reference text, response_code text, response_message text,
  request_sha256 text, submitted_at timestamptz, resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chk_evv_submission_resolved
    check (status in ('pending','submitted') or resolved_at is not null),
  -- response_message is text WE DID NOT WRITE, arriving from a vendor: bounded so a
  -- vendor echoing a client name back at us cannot turn an OPS row into a PHI sink.
  constraint chk_evv_submission_message_bounded
    check (response_message is null or length(response_message) <= 500)
);
```

`element_completeness` may not be a free-form bag — CHECKs pin all six keys (`service_type`, `individual_receiving`, `service_date`, `service_location`, `individual_providing`, `service_times`), so "which element is missing?" is always answerable, and `is_complete` is not an opinion but their conjunction, true by constraint. Builders: `app.build_evv_record(p_visit)` (canonicalise + hash + completeness), `app.submit_evv(p_visit)` (enqueues; a no-op when the adapter is disabled), `app.reconcile_evv(p_submission, p_status, p_external_reference, p_response_code, p_response_message)` (worker lane only).

**Maryland ships as `('isas','MD', mode='reconcile', enabled=false)`** and is correct under both answers to V17: in a closed model CareOS reconciles against ISAS as system of record, in an open model the same canonical record flips to `mode='capture'` with one row update and an adapter implementation. `evv_adapter` is the one mutable table here — flipping the mode must be an UPDATE, not a version chain.

**RLS.** `evv_record` PHI ⇒ AAL2, read = `evv.read`/`evv.manage`, own record, or care-team on the client (the same three-way scope `visit_event` uses, so the two ledgers agree). `evv_submission` AAL2 + `evv.read`/`evv.manage` only — a caregiver has no operational use for a vendor rejection code. `evv_adapter` carries no PHI, so permission-gated without AAL2 (the `feature_flag` posture).

### 6.11 The payroll boundary — `approved_work_segment`, `payroll_period`, `payroll_export` (0050)

Approved hours land in Phase 1; the payroll *ledger* is internal and **export-only** (D-027). No payroll vendor, no accounting book of record.

```sql
create table public.approved_work_segment (                                -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  caregiver_id uuid not null references public.app_user(id),   -- NOT NULL: see the CHECK
  work_date date not null,
  verified_minutes int not null check (verified_minutes >= 0),  -- the immutable fact
  approved_minutes int not null check (approved_minutes >= 0),  -- what a human approved
  rounding_applied text not null default 'none' check (rounding_applied in
    ('none','nearest_1','nearest_5','nearest_6','nearest_15','manual')),
  pay_code text not null default 'regular' check (pay_code in
    ('regular','overtime','holiday','training','travel','adjustment')),
  decision text not null default 'approved' check (decision in ('approved','rejected')),
  approval_note text,
  approved_by uuid not null references public.app_user(id),
  supersedes_id uuid references public.approved_work_segment(id),
  created_at timestamptz not null default now(),
  seq bigint generated always as identity,        -- head-of-chain ordering, as in 0047
  -- D-027 made structural: self-approval is unrepresentable, not merely refused.
  constraint chk_approved_work_segment_no_self check (approved_by <> caregiver_id),
  constraint chk_approved_work_segment_supersedes_other
    check (supersedes_id is distinct from id),
  constraint chk_approved_work_segment_rejection_zero
    check (decision <> 'rejected' or approved_minutes = 0),
  constraint chk_approved_work_segment_rejection_reason
    check (decision <> 'rejected' or btrim(coalesce(approval_note,'')) <> '')
);

create table public.payroll_period (                                              -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  starts_on date not null, ends_on date not null,
  status text not null default 'open' check (status in ('open','locked','exported')),
  locked_by uuid references public.app_user(id), locked_at timestamptz,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint uq_payroll_period_window unique (tenant_id, starts_on, ends_on),
  constraint chk_payroll_period_window check (ends_on >= starts_on),
  constraint chk_payroll_period_locked
    check (status = 'open' or (locked_by is not null and locked_at is not null))
);

create table public.payroll_export (                                       -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  period_id uuid not null references public.payroll_period(id),
  format text not null default 'csv' check (format in ('csv')),
  row_count int not null check (row_count >= 0),
  total_minutes int not null check (total_minutes >= 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  exported_by uuid not null references public.app_user(id),
  exported_at timestamptz not null default now()
);
```

**`verified_minutes` and `approved_minutes` are both stored on purpose.** The first is the immutable fact from the clock ledger with corrections folded in; the second is what a human actually approved. Their difference is the whole reason both columns exist, and it is exactly what a wage-and-hour review asks to see. A later correction **appends a new segment** rather than moving a number. `rounding_applied = 'manual'` means a human supplied the figure outright — distinct from `'none'`, which means the policy's rule *is* "do not round".

**`payroll_period` is the one non-[AO] table in the layer**: `open → locked → exported` are transitions of one row, and `uq_payroll_period_window` could not be stated across a version chain. It carries a `no_delete` trigger instead (the `sms_log` posture) and has no write grant — a direct UPDATE could lock a period with unapproved hours still in it, which is precisely the check `app.close_payroll_period` exists to perform.

RPCs: `app.compute_visit_minutes`, `app.round_minutes`, `app.approve_visit_hours`, `app.reject_visit_hours`, `app.compute_overtime`, `app.open_payroll_period`, `app.close_payroll_period`, `app.export_payroll_period`. `approve_visit_hours` refuses when the visit is not `completed`, when an unresolved `critical` exception exists (`CAREOS_APPROVAL_BLOCKED`), and when the actor is the caregiver themself (`CAREOS_SELF_APPROVAL`).

**RLS.** `approved_work_segment` PHI-by-linkage ⇒ AAL2; read = own segments (a worker reading their own timesheet is a wage-and-hour right, not a favour) **or** `visit.approve` **or** `payroll.read`/`payroll.manage`. Care-team membership is deliberately **not** sufficient — a nurse on the case has clinical business with this client and none with this caregiver's pay — and neither is `schedule.read`. `payroll_period` and `payroll_export` hold no PHI (dates, counts, a digest), so they are permission-gated without AAL2. None of the three has a write grant.

### 6.12 Write paths — the clock engine (0046) and the location RPCs (0043)

**Superseded:** ~~`app.clock_in(p_shift, p_lat, p_lng, p_accuracy, p_at, p_client_event, p_offline)`~~ never existed as written. The built entry point is `app.clock_visit`, introduced in 0013 and **re-signed by drop-and-create** in 0046 (D-029 — `create or replace` with a new signature *overloads* rather than replaces, and an ambiguous overload breaks PostgREST named-argument resolution; the D-016 lesson). The six new parameters are defaulted, so every existing five-argument call site resolves to the new function unchanged.

```sql
app.clock_visit(p_visit uuid, p_event text,                    -- 'clock_in' | 'clock_out'
                p_lat double precision default null, p_lng double precision default null,
                p_accuracy double precision default null,
                p_client_event_id text default null,
                p_captured_at timestamptz default null,        -- device time, diagnostics
                p_offline boolean default false,
                p_reason_code text default null, p_note text default null,
                p_device_session_id text default null) returns jsonb

app.evaluate_location(p_accuracy_m, p_distance_m, p_max_accuracy_m, p_radius_m) returns text
  --  distance IS NULL OR accuracy IS NULL  → 'unavailable'
  --  accuracy > max_accuracy_m             → 'low_accuracy'
  --  distance <= radius_m                  → 'verified'
  --  else                                  → 'outside_geofence'
```

`app.evaluate_location` is pure and `immutable`, and **never** produces `'suspicious'` — that status is only ever set by a detection rule holding evidence. `app.clock_visit` requires AAL2 (`CAREOS_AAL2_REQUIRED`) and the assigned caregiver (`CAREOS_FORBIDDEN`); replays a matching `p_client_event_id` as a **return value with `replayed: true`, never a second row and never an error**; guards the sequence (`CAREOS_ALREADY_CLOCKED_IN` / `CAREOS_NOT_CLOCKED_IN`); binds the resolved policy and service-location version to the visit on first clock-in; appends the event; advances `visit.status` and `verification_status`; and emits audit + outbox.

It returns `{ok, replayed, event_id, status, verification_status, location_status, occurred_at, needs_reason, distance_bucket}`. **`distance_bucket` (`'inside'|'near'|'far'`) is returned instead of metres** so the caregiver UI can be helpful without displaying surveillance-grade precision — metres never leave the database (D-030).

*(Out-of-geofence never blocks care.* Where policy allows an exception and a `reason_code` was supplied, the event is appended with its honest status and the matching `visit_exception` is raised. Where no reason has been given yet, a `*_rejected` event is appended and `{ok:false, needs_reason:true}` returned so the UI can offer "Try again" / "Request exception" — **no exception is raised for a retry**. Where policy forbids an exception, `CAREOS_GEOFENCE_UNVERIFIED`. And where there is **nothing to verify against** — the client has no service location, or its current version carries no human-attested pin — the event is appended and the visit starts *with no reason asked*: that is an agency configuration gap the caregiver can neither see nor fix, so the visit lands in `verification_status='exception'` for the coordinator who can.*)

Location write paths (all gated on AAL2 + `location.manage`, all appending): `app.create_service_location(p_client, p_kind, p_label, p_address jsonb, p_is_primary default false)`, `app.revise_service_location(p_location, p_address, p_reason)`, `app.verify_service_location(p_version, p_lat, p_lng, p_precision, p_note default null)`, `app.set_service_location_geofence(p_version, p_radius_m, p_reason)`.

### 6.13 Detection, analytics and the layer at a glance

Detection (0047, pure SQL, idempotent via `dedupe_key`, clock-injectable per D-016): `app.detect_missing_clock_out`, `app.detect_missed_visits`, `app.detect_overlapping_visits`, `app.detect_impossible_travel`, `app.detect_documentation_gaps`, with `app.sweep_visit_exceptions(p_now default now())` as the five-minute cron entry point returning per-rule counts. Corrections: `app.correct_visit_event(p_event, p_occurred_at, p_reason)` — requires `visit.correct`, AAL2 and a non-empty reason, and raises a `manual_correction` exception so the correction itself is reviewable.

Analytics (0051): the `security_invoker` views `public.workforce_visit_fact` and `public.evv_capture_fact` (which exposes a bucketed `accuracy_bucket` and **no** latitude, longitude, `distance_m` or raw `accuracy_m`), plus `app.workforce_features(p_from, p_to, p_caregiver default null)` — the **only** input any workforce AI capability may read — and `app.evv_observability(p_from, p_to)`.

| Table / view | Purpose | Class | [AO] | RLS posture | Mig |
|---|---|---|---|---|---|
| `service_type` | Service catalog; the EVV "type of service" element | CFG | — | select: tenant member · insert/update: `schedule.write` (direct grants) | 0043 |
| `service_location` | Durable identity of a place of care | PHI | — | select AAL2: `location.manage` ∨ care-team ∨ assigned caregiver · **writes: RPC only** | 0043 |
| `service_location_version` | Geographic source of truth; address + geo + attestation | PHI | ✓ | select AAL2: follows parent · **writes: RPC only** | 0043 |
| `visit_policy` | Geofence/time/documentation/money/fraud rules, versioned | CFG | ✓ | select: tenant member (no AAL2) · **writes: RPC only** (`policy.manage`) | 0044 |
| `visit` (+8 cols) | Scheduled care event + 4 state axes + 2 bindings | PHI | — | select AAL2: `schedule.read` ∨ care-team ∨ own · **no insert/update grant or policy** | 0011/0045 |
| `visit_event` (+12 cols) | Append-only clock ledger — the single source of truth | PHI | ✓ | select AAL2: own ∨ `schedule.read` ∨ care-team · **writes: RPC only** | 0013/0045 |
| `verified_visit` (view) | Derived actuals, minutes, lateness, offline flag | PHI | n/a | `security_invoker` — RLS composes from `visit` + `visit_event` | 0045 |
| `visit_exception` | Detected exceptions with ID/number evidence | PHI | ✓ | select AAL2: subject caregiver ∨ `visit.verify.read` ∨ care-team · writes: RPC | 0047 |
| `visit_exception_disposition` | How a human resolved it (always `kind='staff'`) | PHI | ✓ | select AAL2: follows parent · writes: RPC (`visit.verify.act`) | 0047 |
| `visit_exception_state` (view) | Latest disposition + `open` | PHI | n/a | `security_invoker` over both ledgers | 0047 |
| `visit_trust_assessment` | Deterministic `trust.v1` score snapshots | PHI | ✓ | select AAL2: `visit.verify.read` ∨ `schedule.read` · **definer-write only** | 0048 |
| `evv_record` | Canonical, state-agnostic six-element EVV object | PHI | ✓ | select AAL2: `evv.read`/`evv.manage` ∨ own ∨ care-team · writes: RPC | 0049 |
| `evv_adapter` | Per-state target/mode/enabled; non-secret config | CFG | — | select: `evv.read`/`evv.manage` (no AAL2) · writes: RPC | 0049 |
| `evv_submission` | One row per attempt and per outcome | OPS | ✓ | select AAL2: `evv.read`/`evv.manage` · **definer-write only** | 0049 |
| `approved_work_segment` | Verified vs approved minutes; the payroll boundary | PHI | ✓ | select AAL2: own ∨ `visit.approve` ∨ `payroll.read`/`.manage` · writes: RPC | 0050 |
| `payroll_period` | Open → locked → exported container | OPS | no-delete | select: `payroll.read`/`.manage` (no AAL2) · writes: RPC | 0050 |
| `payroll_export` | What left the building: counts + `content_sha256` | OPS | ✓ | select: `payroll.read`/`.manage` · **definer-write only** | 0050 |
| `workforce_visit_fact`, `evv_capture_fact` (views) | Analytics read models; bucketed accuracy, no geo | PHI | n/a | `security_invoker`; aggregates gated on `workforce.read` | 0051 |

New permission keys, seeded by the migrations themselves (never by the synthetic seed): `location.manage` (0043), `policy.manage` (0044), `visit.verify.read` · `visit.verify.act` · `visit.correct` (0047), `evv.read` · `evv.manage` (0049), `visit.approve` · `payroll.read` · `payroll.manage` (0050), `workforce.read` (0051). **Caregivers need no new permission to clock** — `app.clock_visit` authorises on assignment.

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

The Verified Visit & Workforce Intelligence tables are **not** listed here: they are specified in full in §6, and §6.13 carries their at-a-glance dictionary row-for-row (class, append-only status, RLS posture, migration).

| Domain | Tables | Purpose / key columns | Class | Notes |
|---|---|---|---|---|
| Care planning | `care_plan`, `care_plan_version` [AO], `care_plan_task` | COMAR-required plan contents; tasks feed visit checklists & the matching engine | PHI | Versioned exactly like forms; RN signature to finalize |
| Medications | `medication`, `mar_entry` [AO] | Client med list; administration/assist log incl. errors & adverse reactions | PHI | MAR is append-only per COMAR 10.07.05.12 |
| On-call | `on_call_shift`, `on_call_log` [AO] | 24/7 coverage roster; response log (1-hr response evidence) | OPS/PHI | Doc 02 §3 |
| Incidents & grievances | `incident`, `incident_version` [AO], `grievance` | Structured reports, severity, routing, resolution | PHI | FR-AI-044 feeds drafts |
| Notifications | `notification`, `notification_delivery`, `escalation_policy` | ID-only payloads; per-channel delivery state; escalation chains | OPS | Doc 06 §6.4 |
| Events/queues | `domain_event` [AO], pgmq queues + DLQs | Transactional outbox; consumer offsets | OPS | Doc 06 §5 |
| Billing prep | `payer`, `authorization`, `billable_visit`, `claim_export` | EVV-verified billables; QuickBooks export batches | OPS/PHI | Doc 08 §6.4. **Phase 2+.** ~~`payroll_period`, `pay_exception`~~ moved out of this row by **D-027**: `payroll_period` and `payroll_export` are built in §6.11 as part of the Verified Visit layer, because *approving hours* is a care-operations act that belongs with the verified visit, while *paying people* is an accounting integration. `pay_exception` was never built — the `visit_exception` kinds `payroll_mismatch` and `documentation_missing` (§6.8) carry that role on the one exception ledger |
| Family portal | `family_member_link`, `family_update`, `portal_consent` | Scoped read access; approved updates only | PHI | Consent-gated (COMAR .15/.16) |
| Comms | `message_thread`, `message` [AO], `sms_log` | Internal messaging; Twilio delivery records (minimized bodies) | PHI | Retention-scoped |
| AI layer (`ai.*`) | `ai_interaction` [AO], `ai_prompt_template`, `ai_capability_flag`, `agent_task`, `agent_step` [AO], `ai_metric`, `ai_budget` | Full provenance: model+version, template version, tier, confidence, human disposition; kill switches; spend caps | OPS (PHI-minimized refs) | Doc 11 §3 |
| Knowledge (Brain) | `knowledge_document`, `knowledge_chunk` (`embedding vector(1024)`, `fts tsvector`, `scope`, `sensitivity`) | RBAC-aware RAG index | OPS/PHI | RLS on chunks = same predicates as source entities; hybrid index (`hnsw` + GIN) |
| Config | `agency_setting`, `holiday_calendar`, `notification_pref` | Tenant configuration | CFG | |

## 11. RLS policy catalog & verification

Every table ships with a policy set named per convention and a **pgTAP matrix test**: for each (role × representative row × operation) the expected allow/deny is asserted in CI (Doc 12 §3). The catalog is generated into `db/policies.md` by `scripts/gen-policies.sh` so the *documented* and *deployed* policy sets cannot drift — `--check` mode fails CI on any difference. It introspects `pg_policies` on a database with the full chain applied, not the migration text: `create policy` statements cannot be counted, because later migrations drop policies they did not create (0023 drops four), so only the live catalog is true. **104 policies across 69 tables** as of migration 0052, plus 5 RLS-enabled tables that carry no policy at all and are therefore deny-by-default, reachable only through `security definer` functions. (The figure this sentence carried at v1.0 — "63 policies" — was stale, and the generator it promised did not exist; both were fixed alongside the Verified Visit layer.) Sensitive-column protection (e.g., `client.medicaid_id`, pay rates) uses Vault-backed encrypted columns + column-privilege revocation with accessor RPCs, so even broad `select` grants never expose them (Doc 09 §6).

## 12. Seed & fixture policy

Migrations seed: permission catalog + system roles (from Doc 01 RBAC matrix), `compliance_rule` rows for every Doc 02 §3 cadence (each with `source_ref`), `credential_type` rows for Doc 02 §7 HR items, `form_template` v1 for the master forms inventory, the tenant-floor `visit_policy` version every resolution falls back to (§6.7), and the Maryland `evv_adapter` row `('isas','MD','reconcile', enabled=false)` (§6.10). **Synthetic fixtures only** outside production (Doc 12 §7) — generated personas, never real PHI.

**Real configuration belongs in the migration, not the synthetic seed.** Permission keys, policy floors and adapter rows are things production must have on day one; seeding them from the fixture system would ship an empty production. Per-tenant *role grants* for those keys are wired alongside them in the same migration (the 0011/0026 precedent), so no key ever ships orphaned.
