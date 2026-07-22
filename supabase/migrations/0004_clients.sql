-- ST-012 · Migration 0004 — client records + care-team FK closure
-- Implements: docs/07 §5 (client table), resequenced per the ratified design doc.
-- Deviations (recorded in D-011):
--   * geo/geofence columns land with the EVV migration (S5/S6 sprint) — PostGIS is
--     not needed by the records spine and keeping core migrations pure-Postgres
--     keeps local verification portable.
--   * medicaid_id lands with the Vault column-crypto migration (docs/09 §4) — it
--     must never exist as a plaintext column, so it does not exist yet at all.
--   * INSERT policy included (docs/07 §5 granted INSERT but defined no policy —
--     finding S5-5: a grant without a policy is a silent deny; now explicit).
-- @trace: ST-012, FR-M2

create table public.client (                               -- PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  status text not null default 'inquiry' check (status in
    ('inquiry','pending_admission','active','on_hold','discharged')),
  first_name text not null, last_name text not null,
  dob date, sex text,
  address_line1 text, address_line2 text, city text, state text, zip text,
  primary_phone text, primary_language text not null default 'en',
  payer_type text check (payer_type in ('private','medicaid','ltc_insurance','va','other')),
  admitted_on date, discharged_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
create index idx_client_tenant on public.client (tenant_id);

alter table public.care_team_assignment
  add constraint fk_cta_client foreign key (client_id) references public.client(id);

alter table public.client enable row level security;
alter table public.client force row level security;

create policy client_select_scoped on public.client for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('client.read.all') or app.on_care_team(id)
    ));
create policy client_insert_admin on public.client for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
              and app.has_perm('client.write'));
create policy client_update_admin on public.client for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('client.write'))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.client to authenticated;   -- RLS gates rows
