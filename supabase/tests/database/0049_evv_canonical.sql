-- pgTAP · EVV canonical layer (0049): that evv_record/evv_adapter/evv_submission are
-- tenant-scoped, AAL2-gated and append-only in both layers; that the six-element
-- completeness object and its conjunction are constraint-true; that the canonical hash is
-- stable under a no-op rebuild and moves when an element moves; that a disabled adapter is
-- a no-op and not an error (D-026); that the worker lane is service_role-only and its
-- replays are idempotent; and that no coordinate reaches an audit payload, an outbox
-- payload or a queue message from any of it (invariant 5, D-030).
-- @trace: ST-207, D-026, D-030
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'evv.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'evv.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'evv.cg2.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'evv.nurse.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'evv.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'EVV Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'EVV Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'EVV Admin A', 'evv.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'EVV Caregiver A1', 'evv.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'EVV Caregiver A2', 'evv.cg2.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'EVV Nurse A', 'evv.nurse.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'EVV Admin B', 'evv.admin.b@brookmead.test', 'staff');

-- The keys 0049 inserts into the catalog; re-stated here so the file is readable alone.
insert into public.permission (key, description) values
  ('evv.read', 'test'), ('evv.manage', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'evv_admin', 'EVV Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'evv_admin', 'EVV Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'evv.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'evv.manage'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'evv.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'evv.manage');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'EVV', 'ClientA'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'EVV', 'ClientB');

-- The nurse is care-team-only: no EVV permission, no visit. She is the probe for
-- "PHI follows the care team", separate from "the caregiver sees their own work".
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000d1', 'rn_case_manager');

-- Two service types: one Medicaid line that carries an EVV obligation, one private-pay
-- line that carries none — the pair that proves evv_status is derived, not assumed.
insert into public.service_type
  (id, tenant_id, code, name, evv_required, payer_kind) values
  ('aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'PCA', 'Personal Care Aide', true, 'medicaid'),
  ('aaaaaaaa-0000-0000-0000-000000005002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'COMPANION', 'Companion Care', false, 'private');

insert into public.service_location
  (id, tenant_id, client_id, kind, label, is_primary, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000006001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'primary_residence', 'Home', true,
   'aaaaaaaa-0000-0000-0000-0000000000ad');
insert into public.service_location_version
  (id, tenant_id, service_location_id, version_no, original_address, normalized_address,
   created_by) values
  ('aaaaaaaa-0000-0000-0000-000000006101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000006001', 1,
   '900 Meadowbrook Ln, Baltimore, MD 21201', '900 MEADOWBROOK LN BALTIMORE MD 21201',
   'aaaaaaaa-0000-0000-0000-0000000000ad');

-- Five tenant-A visits and one tenant-B visit. Inserted as postgres with no JWT ⇒ the
-- audit and outbox triggers no-op (seed guard), so the ledgers below hold only what the
-- 0049 RPCs actually emitted.
--   e001 completed, EVV-required, fully bound          → the happy path
--   e002 completed, EVV-required, NO location version  → an incomplete record
--   e003 still scheduled                               → CAREOS_BAD_STATE
--   e004 completed but never clocked                   → CAREOS_EVV_NO_TIMES
--   e005 completed, private-pay type                   → evv_status 'not_required'
insert into public.visit
  (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status,
   service_type_id, service_location_id, service_location_version_id, note) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-01 13:00:00+00', '2026-06-01 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-000000006001',
   'aaaaaaaa-0000-0000-0000-000000006101', 'evv-happy'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-02 13:00:00+00', '2026-06-02 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005001', null, null, 'evv-incomplete'),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-03 13:00:00+00', '2026-06-03 15:00:00+00', 'scheduled',
   'aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-000000006001',
   'aaaaaaaa-0000-0000-0000-000000006101', 'evv-scheduled'),
  ('aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-04 13:00:00+00', '2026-06-04 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-000000006001',
   'aaaaaaaa-0000-0000-0000-000000006101', 'evv-unclocked'),
  ('aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-05 13:00:00+00', '2026-06-05 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005002', 'aaaaaaaa-0000-0000-0000-000000006001',
   'aaaaaaaa-0000-0000-0000-000000006101', 'evv-private'),
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', null,
   '2026-06-01 13:00:00+00', '2026-06-01 15:00:00+00', 'completed',
   null, null, null, 'evv-tenant-b');

-- Clock ledger. The coordinates are the canary payload: 39.2904 must never appear
-- downstream of this table (D-030).
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   latitude, longitude, accuracy_m, method) values
  ('aaaaaaaa-0000-0000-0000-00000000ea01', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-06-01 13:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea02', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-06-01 15:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea03', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-06-02 13:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea04', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-06-02 15:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea05', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-06-05 13:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea06', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-06-05 15:00:00+00', 39.2904, -76.6122, 12, 'web');

-- The migration's tenant loop ran before these tenants existed, so the seeder is invoked
-- here — which is also the idempotence probe.
select is(app.seed_evv_adapters('aaaaaaaa-0000-0000-0000-000000000001'), 1,
  'adapter seed +: the Maryland row is created for a new tenant');
select is(app.seed_evv_adapters('aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'adapter seed +: re-running the seeder creates nothing (idempotent)');
select is(app.seed_evv_adapters('bbbbbbbb-0000-0000-0000-000000000001'), 1,
  'adapter seed +: tenant B gets its own row, not tenant A''s');

-- Session simulator (identical to 002/003/0011).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ Posture: RLS, grants, function privileges ═════════════════════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('evv_record','evv_adapter','evv_submission')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'posture: RLS is enabled + forced on evv_record, evv_adapter and evv_submission');

select ok(has_table_privilege('authenticated', 'public.evv_record', 'select'),
  'posture: authenticated has SELECT on evv_record (RLS gates the rows)');
select ok(not has_table_privilege('authenticated', 'public.evv_record', 'insert'),
  'posture: authenticated has no INSERT on evv_record (RPC only)');
select ok(not has_table_privilege('authenticated', 'public.evv_record', 'update'),
  'posture: authenticated has no UPDATE grant on evv_record (append-only)');
select ok(not has_table_privilege('authenticated', 'public.evv_record', 'delete'),
  'posture: authenticated has no DELETE grant on evv_record (append-only)');
select ok(has_table_privilege('authenticated', 'public.evv_submission', 'select'),
  'posture: authenticated has SELECT on evv_submission');
select ok(not has_table_privilege('authenticated', 'public.evv_submission', 'insert'),
  'posture: authenticated has no INSERT on evv_submission (RPC/worker only)');
select ok(not has_table_privilege('authenticated', 'public.evv_submission', 'update'),
  'posture: authenticated has no UPDATE grant on evv_submission (append-only)');
select ok(not has_table_privilege('authenticated', 'public.evv_submission', 'delete'),
  'posture: authenticated has no DELETE grant on evv_submission (append-only)');
select ok(has_table_privilege('authenticated', 'public.evv_adapter', 'select'),
  'posture: authenticated has SELECT on evv_adapter');
select ok(not has_table_privilege('authenticated', 'public.evv_adapter', 'insert'),
  'posture: authenticated has no INSERT on evv_adapter (config is not a client write)');
select ok(not has_table_privilege('authenticated', 'public.evv_adapter', 'update'),
  'posture: authenticated has no UPDATE grant on evv_adapter');
select ok(not has_table_privilege('authenticated', 'public.evv_adapter', 'delete'),
  'posture: authenticated has no DELETE grant on evv_adapter');

select ok(has_function_privilege('authenticated', 'app.build_evv_record(uuid)', 'execute'),
  'posture: authenticated can call app.build_evv_record');
select ok(has_function_privilege('authenticated', 'app.submit_evv(uuid)', 'execute'),
  'posture: authenticated can call app.submit_evv');
select ok(not has_function_privilege('anon', 'app.build_evv_record(uuid)', 'execute'),
  'posture: anon cannot call app.build_evv_record');
select ok(not has_function_privilege('anon', 'app.submit_evv(uuid)', 'execute'),
  'posture: anon cannot call app.submit_evv');
select ok(not has_function_privilege('service_role', 'app.build_evv_record(uuid)', 'execute'),
  'posture: service_role cannot call app.build_evv_record (no request-path reach)');
select ok(not has_function_privilege('service_role', 'app.submit_evv(uuid)', 'execute'),
  'posture: service_role cannot call app.submit_evv (no request-path reach)');
select ok(has_function_privilege('service_role',
  'app.reconcile_evv(uuid,text,text,text,text)', 'execute'),
  'posture: service_role can call app.reconcile_evv (the worker lane)');
select ok(not has_function_privilege('authenticated',
  'app.reconcile_evv(uuid,text,text,text,text)', 'execute'),
  'posture: authenticated cannot call app.reconcile_evv');
select ok(not has_function_privilege('anon',
  'app.reconcile_evv(uuid,text,text,text,text)', 'execute'),
  'posture: anon cannot call app.reconcile_evv');
select ok(not has_function_privilege('authenticated', 'app.seed_evv_adapters(uuid)', 'execute'),
  'posture: authenticated cannot call the adapter seeder');

-- ═══ Maryland ships disabled (D-026) ═══════════════════════════════════════
select is(
  (select target || '/' || state_code || '/' || mode || '/' || enabled::text
     from public.evv_adapter
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'isas/MD/reconcile/false',
  'adapter +: Maryland ships as isas/MD in reconcile mode, disabled (D-026)');

-- ═══ Constraint-true modelling ═════════════════════════════════════════════
select throws_ok(
  $$insert into public.evv_adapter (tenant_id, target, state_code, mode, enabled)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'sandata', 'MD', 'disabled', true)$$,
  '23514', null,
  'adapter -: an enabled adapter in disabled mode is unrepresentable');
select throws_ok(
  $$insert into public.evv_adapter (tenant_id, target, state_code, mode, config)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'hhax', 'MD', 'reconcile',
            '{"api_key":"sk-live-nope"}'::jsonb)$$,
  '23514', null,
  'adapter -: a credential-bearing config is refused (secrets live in Vault)');
select throws_ok(
  $$insert into public.evv_record
      (tenant_id, source_visit_id, client_id, service_date, start_at, end_at, payer_kind,
       element_completeness, is_complete, record_sha256)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-00000000c001', date '2026-06-01',
            '2026-06-01 13:00:00+00', '2026-06-01 15:00:00+00', 'medicaid',
            '{"service_type":false,"individual_receiving":true,"service_date":true,
              "service_location":true,"individual_providing":true,"service_times":true}'::jsonb,
            true, repeat('a', 64))$$,
  '23514', null,
  'evv_record -: is_complete cannot disagree with the six booleans');
select throws_ok(
  $$insert into public.evv_record
      (tenant_id, source_visit_id, client_id, service_date, start_at, end_at, payer_kind,
       element_completeness, is_complete, record_sha256)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-00000000c001', date '2026-06-01',
            '2026-06-01 13:00:00+00', '2026-06-01 15:00:00+00', 'medicaid',
            '{"individual_receiving":true,"service_date":true,"service_location":true,
              "individual_providing":true,"service_times":true}'::jsonb,
            true, repeat('a', 64))$$,
  '23514', null,
  'evv_record -: a completeness object missing an element key is refused');
select throws_ok(
  $$insert into public.evv_submission
      (tenant_id, evv_record_id, adapter_id, attempt_no, status)
    select 'aaaaaaaa-0000-0000-0000-000000000001', null, a.id, 1, 'accepted'
      from public.evv_adapter a
     where a.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '23502', null,
  'evv_submission -: a submission with no canonical record is refused');

-- ═══ app.build_evv_record — the refusals ═══════════════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'build -: an AAL1 session cannot build an EVV record (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_FORBIDDEN%',
  'build -: the assigned caregiver has no evv.manage and is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.build_evv_record('bbbbbbbb-0000-0000-0000-00000000e001')$$,
  '%CAREOS_NOT_FOUND%',
  'build -: a tenant-A admin cannot reach a tenant-B visit (tenant isolation)');
select throws_like(
  $$select app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e003')$$,
  '%CAREOS_BAD_STATE%',
  'build -: a still-scheduled visit has nothing to canonicalise');
select throws_like(
  $$select app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e004')$$,
  '%CAREOS_EVV_NO_TIMES%',
  'build -: a completed visit that was never clocked is refused, not half-stored');

-- ═══ app.build_evv_record — the happy path ═════════════════════════════════
select is(
  app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'ok', 'true',
  'build +: the EVV desk canonicalises a fully bound completed visit');

reset role;
select is((select count(*)::int from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  1, 'build +: exactly one canonical record exists for the visit');
select is((select is_complete from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  true, 'build +: all six elements are present, so the record is complete');
select is((select element_completeness from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  '{"service_type": true, "service_date": true, "service_times": true,
    "service_location": true, "individual_providing": true,
    "individual_receiving": true}'::jsonb,
  'build +: the completeness object names all six elements and each is true');
select ok((select record_sha256 ~ '^[0-9a-f]{64}$' from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'build +: record_sha256 is a 64-character lowercase hex digest');
select is((select service_date from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  date '2026-06-01', 'build +: service_date is the UTC calendar date of the clock-in');
select is((select payer_kind from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'medicaid', 'build +: payer_kind is carried from the service type, not guessed');
select is((select capture_method from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'web_gps', 'build +: an ordinary browser capture is web_gps');
select is((select end_at from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  '2026-06-01 15:00:00+00'::timestamptz,
  'build +: end_at is the clock-out from the append-only ledger');
select is((select evv_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'pending', 'build +: an EVV-required visit projects to evv_status pending (D-024)');
select is((select count(*)::int from audit.audit_event
            where action = 'evv.record.built' and entity_type = 'evv_record'),
  1, 'build +: building emits exactly one evv.record.built audit event (invariant 7)');
select is((select count(*)::int from public.domain_event
            where event_type = 'evv.record.built'),
  1, 'build +: building emits exactly one evv.record.built outbox event');

-- A no-op rebuild is a return value, not a second row and not an error.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'unchanged', 'true',
  'build +: rebuilding an unchanged visit reports unchanged (idempotent)');
reset role;
select is((select count(*)::int from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  1, 'build +: the no-op rebuild appended nothing to the ledger');

-- ═══ Incomplete records, and the private-pay axis ══════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e002') ->> 'is_complete', 'false',
  'build +: a visit with no bound location yields an incomplete record');
reset role;
select is(
  (select element_completeness ->> 'service_location' from public.evv_record
    where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  'false', 'build +: the incomplete record names WHICH element is missing');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e005') ->> 'evv_status',
  'not_required',
  'build +: a private-pay service type projects evv_status not_required');
reset role;
select is((select evv_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e005'),
  'not_required', 'build +: the not_required projection lands on the visit row');

-- ═══ app.submit_evv — disabled is a no-op, not an error (D-026) ════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'skipped', 'true',
  'submit +: with no enabled adapter the call is skipped, never an error');
select is(
  app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'reason', 'adapter_disabled',
  'submit +: the skip reason is adapter_disabled');
reset role;
select is((select count(*)::int from public.evv_submission), 0,
  'submit +: a skipped submission wrote no ledger row');

-- The one-column flip D-026 describes.
update public.evv_adapter set enabled = true, updated_at = now(), row_version = row_version + 1
 where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  '%CAREOS_EVV_INCOMPLETE%',
  'submit -: an incomplete canonical record is a work item, not a transmission');
select throws_like(
  $$select app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e004')$$,
  '%CAREOS_NOT_FOUND%',
  'submit -: a visit with no canonical record must be built first');
select throws_like(
  $$select app.submit_evv('bbbbbbbb-0000-0000-0000-00000000e001')$$,
  '%CAREOS_NOT_FOUND%',
  'submit -: a tenant-A admin cannot submit a tenant-B visit (tenant isolation)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_FORBIDDEN%',
  'submit -: the caregiver has no evv.manage and cannot submit');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'submit -: an AAL1 session cannot submit');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001') -> 'attempt_no')::text, '1',
  'submit +: the first attempt on a record is attempt_no 1');
select is(
  app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'unchanged', 'true',
  'submit +: an attempt already in flight is returned, not duplicated');
reset role;
select is((select count(*)::int from public.evv_submission), 1,
  'submit +: the idempotent re-submit appended no second attempt');
select is((select status from public.evv_submission), 'pending',
  'submit +: a queued attempt is pending until the worker reports back');
select is((select count(*)::int from audit.audit_event where action = 'evv.submitted'),
  1, 'submit +: submitting emits one evv.submitted audit event');
select is((select count(*)::int from public.domain_event where event_type = 'evv.submitted'),
  1, 'submit +: submitting emits one evv.submitted outbox event');
select is((select count(*)::int from pgmq.q_q_events q
            where (q.message ->> 'type') = 'evv.submitted'),
  1, 'submit +: the outbox event reached pgmq in the same transaction (0027)');

-- ═══ Rebuild after a correction: append, supersede, re-hash ════════════════
-- A §4.6 correction moves the clock-out by 30 minutes. The original event is untouched.
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at, method,
   corrects_event_id) values
  ('aaaaaaaa-0000-0000-0000-00000000ea07', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'correction', '2026-06-01 15:30:00+00', 'manual',
   'aaaaaaaa-0000-0000-0000-00000000ea02');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  app.build_evv_record('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'unchanged', 'false',
  'rebuild +: a corrected clock-out changes the record, so a new one is appended');
reset role;
select is((select count(*)::int from public.evv_record
            where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  2, 'rebuild +: the ledger now holds both records — nothing was overwritten');
select is(
  (select count(*)::int from public.evv_record r
    where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and r.supersedes_id is not null),
  1, 'rebuild +: the new record points at the one it replaces (supersedes_id)');
select is(
  (select count(distinct record_sha256)::int from public.evv_record
    where source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  2, 'rebuild +: the canonical hash moved because an element moved');
select is(
  (select r.end_at from public.evv_record r
    where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id)),
  '2026-06-01 15:30:00+00'::timestamptz,
  'rebuild +: the head record carries the CORRECTED clock-out, not the original');
select is(
  (select r.capture_method from public.evv_record r
    where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id)),
  'corrected', 'rebuild +: provenance says corrected, which outranks every other lane');
select is(
  (select count(*)::int from public.evv_submission where status = 'superseded'),
  1, 'rebuild +: the attempt still in flight for the old record is superseded');

-- The superseded attempt is a NEW row: the antecedent is untouched (invariant 1).
select is((select count(*)::int from public.evv_submission where status = 'pending'), 1,
  'rebuild +: the original pending attempt row was appended past, never rewritten');

-- ═══ app.reconcile_evv — the worker lane ═══════════════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (app.submit_evv('aaaaaaaa-0000-0000-0000-00000000e001') -> 'attempt_no')::text, '1',
  'submit +: the rebuilt record starts its own attempt sequence at 1');

reset role;   -- postgres stands in for the service_role worker: no session principal
select throws_like(
  $$select app.reconcile_evv(
      (select id from public.evv_submission
        where status = 'pending' and request_sha256 = (
          select r.record_sha256 from public.evv_record r
           where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
             and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id))),
      'pending', null, null, null)$$,
  '%CAREOS_BAD_STATE%',
  'reconcile -: pending is not an outcome a worker can report');
select throws_like(
  $$select app.reconcile_evv('aaaaaaaa-0000-0000-0000-00000000dead',
      'accepted', null, null, null)$$,
  '%CAREOS_NOT_FOUND%',
  'reconcile -: an unknown submission id is refused');

-- Transmission acknowledged, with vendor prose far over the bound.
select is(
  app.reconcile_evv(
    (select id from public.evv_submission
      where status = 'pending' and request_sha256 = (
        select r.record_sha256 from public.evv_record r
         where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
           and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id))),
    'submitted', 'ISAS-2026-0001', 'A-000', repeat('vendor prose ', 60)) ->> 'ok',
  'true', 'reconcile +: the worker records the transmission');
select is(
  (select length(response_message)::int from public.evv_submission
    where status = 'submitted'),
  500, 'reconcile +: vendor prose is truncated at 500 characters (never a PHI sink)');
select is((select evv_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'submitted', 'reconcile +: the visit''s EVV axis follows the ledger');

-- Acceptance. The worker names the ORIGINAL attempt row, not the row it created.
select is(
  app.reconcile_evv(
    (select id from public.evv_submission
      where status = 'pending' and request_sha256 = (
        select r.record_sha256 from public.evv_record r
         where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
           and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id))),
    'accepted', 'ISAS-2026-0001', 'A-100', 'accepted') ->> 'ok',
  'true', 'reconcile +: acceptance is appended against the attempt, not the row named');
select is((select evv_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'accepted', 'reconcile +: the visit reaches evv_status accepted');
select is((select count(*)::int from public.domain_event where event_type = 'evv.accepted'),
  1, 'reconcile +: acceptance emits the evv.accepted outbox event (docs/17 §8)');
select is((select count(*)::int from audit.audit_event
            where action = 'evv.reconciled' and actor_kind = 'system'),
  2, 'reconcile +: every worker outcome lands on the audit chain as a system actor');

-- Replay safety: the acknowledged attempt is closed, whatever arrives next.
select is(
  app.reconcile_evv(
    (select id from public.evv_submission
      where status = 'pending' and request_sha256 = (
        select r.record_sha256 from public.evv_record r
         where r.source_visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
           and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id))),
    'rejected', null, 'E-104', 'late duplicate') ->> 'unchanged',
  'true', 'reconcile +: a late outcome on a terminal attempt is a no-op, never an error');
select is((select evv_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'accepted', 'reconcile +: the late duplicate did not move the visit off accepted');
select is((select count(*)::int from public.evv_submission where status = 'rejected'), 0,
  'reconcile +: the no-op appended nothing');

-- ═══ Append-only, both layers, even for the superuser ══════════════════════
select throws_like(
  $$update public.evv_record set is_complete = false$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: evv_record UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.evv_record$$,
  '%CAREOS_APPEND_ONLY%', 'append-only: evv_record DELETE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$update public.evv_submission set status = 'accepted'$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: evv_submission UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.evv_submission$$,
  '%CAREOS_APPEND_ONLY%', 'append-only: evv_submission DELETE raises CAREOS_APPEND_ONLY');

-- ═══ Canary: no coordinate escapes any of this (invariant 5, D-030) ════════
select is(
  (select count(*)::int from audit.audit_event a
    where a.payload::text like '%39.2904%' or a.payload::text like '%76.6122%'),
  0, 'canary: no captured coordinate appears in any audit payload');
select is(
  (select count(*)::int from public.domain_event e
    where e.payload::text like '%39.2904%' or e.payload::text like '%76.6122%'),
  0, 'canary: no captured coordinate appears in any outbox payload');
select is(
  (select count(*)::int from pgmq.q_q_events q
    where q.message::text like '%39.2904%' or q.message::text like '%76.6122%'),
  0, 'canary: no captured coordinate appears in any queue message');
select is(
  (select count(*)::int from audit.audit_event a
    where a.action like 'evv.%' and a.payload::text ~* '(latitude|longitude|accuracy)'),
  0, 'canary: no EVV audit payload even names a coordinate field');
select is(
  (select count(*)::int from public.domain_event e
    where e.event_type like 'evv.%' and e.payload::text ~* '(latitude|longitude|accuracy)'),
  0, 'canary: no EVV outbox payload even names a coordinate field');
-- Vendor prose stays in the row it landed in and never rides an event.
select is(
  (select count(*)::int from public.domain_event e
    where e.event_type like 'evv.%' and e.payload::text like '%vendor prose%'),
  0, 'canary: vendor response text never leaves evv_submission');

-- ═══ RLS policy matrix ═════════════════════════════════════════════════════
-- evv_record: four tenant-A records (two for e001, one each for e002 and e005).
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.evv_record), 4,
  'evv_record +: the EVV desk (evv.read) sees the tenant''s canonical records');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.evv_record), 4,
  'evv_record +: the caregiver sees the records of visits they worked');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000d1', 'aal2');
select is((select count(*)::int from public.evv_record), 4,
  'evv_record +: a care-team nurse sees her client''s records');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.evv_record), 0,
  'evv_record -: an unrelated caregiver sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.evv_record), 0,
  'evv_record -: the same caregiver at AAL1 sees nothing (invariant 3)');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.evv_record), 0,
  'evv_record -: a tenant-B admin sees no tenant-A record (tenant isolation)');

-- evv_submission: five rows for tenant A (attempt, supersede, attempt, submitted,
-- accepted). Narrower than the record: back-office only.
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.evv_submission), 5,
  'evv_submission +: the EVV desk sees the whole submission ledger');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.evv_submission), 0,
  'evv_submission -: a caregiver sees no vendor plumbing, even for their own visit');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000d1', 'aal2');
select is((select count(*)::int from public.evv_submission), 0,
  'evv_submission -: a care-team nurse without evv.read sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select is((select count(*)::int from public.evv_submission), 0,
  'evv_submission -: the EVV desk at AAL1 sees nothing (PHI by linkage)');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.evv_submission), 0,
  'evv_submission -: a tenant-B admin sees no tenant-A submission');

-- evv_adapter: config, no PHI, permission-gated and tenant-scoped.
select is((select count(*)::int from public.evv_adapter), 1,
  'evv_adapter +: a tenant-B admin sees exactly tenant B''s own adapter row');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.evv_adapter), 1,
  'evv_adapter +: the EVV desk sees its tenant''s adapter');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.evv_adapter), 0,
  'evv_adapter -: a caregiver without evv.read sees no adapter configuration');

reset role;
select * from finish();
rollback;
