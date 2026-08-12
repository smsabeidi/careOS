-- pgTAP · 0045 verified visit: the four state axes exist and are RPC-only, the clock
-- ledger accepts its new event types and its idempotency key exactly once, visit_event
-- stays append-only at BOTH layers, public.verified_visit derives its minutes from the
-- ledger under the caller's own RLS, and no coordinate reaches the view or the audit
-- ledger. Style mirrors 0011_scheduling.sql / 0027_domain_event_outbox.sql.
-- @trace: ST-203, D-014, D-022, D-023, D-024, D-025, D-030, docs/17 §3, §3.5, §3.6
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ───────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'vv.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'vv.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'vv.cg2.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'vv.cg3.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'vv.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'VV Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'VV Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'VV Admin A', 'vv.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'VV Caregiver A1', 'vv.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'VV Caregiver A2', 'vv.cg2.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001',
   'VV Nurse A3', 'vv.cg3.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'VV Admin B', 'vv.admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('schedule.read', 'test'), ('schedule.write', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'vv_admin', 'VV Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'vv_admin', 'VV Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'VV', 'ClientA'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'VV', 'ClientB');

-- A3 is on client A's care team but works none of these visits — the third lawful reader.
-- A2 is a tenant-A caregiver with no relationship to client A at all.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c3', 'rn_case_manager');

-- The §3.5 binding targets (0043). Real rows, so the new FKs are exercised rather than
-- merely declared. policy_id is left NULL on purpose: visit_policy is 0044's contract and
-- this file asserts the FK from the catalog instead of guessing that table's column set.
insert into public.service_type (id, tenant_id, code, name, evv_required, payer_kind) values
  ('aaaaaaaa-0000-0000-0000-000000005201', 'aaaaaaaa-0000-0000-0000-000000000001',
   'PCA', 'Personal Care Aide', true, 'medicaid');
insert into public.service_location
  (id, tenant_id, client_id, kind, label, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'primary_residence', 'Home',
   'aaaaaaaa-0000-0000-0000-0000000000ad');
insert into public.service_location_version
  (id, tenant_id, service_location_id, created_by, version_no,
   original_address, normalized_address, address_line1, city, state, postal_code) values
  ('aaaaaaaa-0000-0000-0000-000000005101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-0000000000ad', 1,
   '8 Fixture Ln, Rockville, MD 20850', '8 FIXTURE LN ROCKVILLE MD 20850 US',
   '8 Fixture Ln', 'Rockville', 'MD', '20850');

-- Three tenant-A visits with FIXED windows, so every minute assertion below is
-- arithmetic and not "whatever now() happened to be". Inserted as postgres (no JWT) ⇒
-- the audit and outbox triggers no-op, and no chain forks.
--   v1 09:00–11:00 — the full story: a rejected attempt, two clock-ins, two clock-outs
--   v2 13:00–15:00 — clocked in EARLY, never clocked out
--   v3 17:00–19:00 — nobody ever showed up
insert into public.visit (id, tenant_id, client_id, caregiver_id,
                          scheduled_start, scheduled_end,
                          service_type_id, service_location_id,
                          service_location_version_id) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-02 09:00:00+00', '2026-03-02 11:00:00+00',
   'aaaaaaaa-0000-0000-0000-000000005201', 'aaaaaaaa-0000-0000-0000-000000005001',
   'aaaaaaaa-0000-0000-0000-000000005101'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-02 13:00:00+00', '2026-03-02 15:00:00+00', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-02 17:00:00+00', '2026-03-02 19:00:00+00', null, null, null);
insert into public.visit (id, tenant_id, client_id, caregiver_id,
                          scheduled_start, scheduled_end) values
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-0000000000ad',
   '2026-03-02 09:00:00+00', '2026-03-02 11:00:00+00');

-- v1's ledger. The rejected attempt at 09:00:10 is the EARLIEST row on the visit and must
-- never become the arrival; the second tap at 09:09 must never displace the first; the
-- earlier clock-out at 10:58 must never displace the later one.
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   latitude, longitude, accuracy_m, distance_m, location_status, capture_source) values
  ('aaaaaaaa-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in_rejected', '2026-03-02 09:00:10+00', 39.0839, -77.1528, 400, 1800,
   'low_accuracy', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', '2026-03-02 09:07:30+00', 39.0839, -77.1528, 12, 18, 'verified', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', '2026-03-02 09:09:00+00', 39.0839, -77.1528, 12, 21, 'verified', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-03-02 10:58:00+00', 39.0839, -77.1528, 12, 25, 'verified', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-03-02 11:03:20+00', 39.0839, -77.1528, 12, 31, 'verified', 'web');
-- v2: clocked in five minutes EARLY, from a replayed offline queue entry.
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   distance_m, location_status, capture_source, is_offline,
   client_event_id, client_captured_at) values
  ('aaaaaaaa-0000-0000-0000-00000000a006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', '2026-03-02 12:55:00+00', 40, 'verified', 'offline', true,
   'queued-1', '2026-03-02 12:54:58+00');

-- Session simulator (identical to 002/003/0011/0043).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Invariant 2: the expand phase did not disturb the perimeter ────────────
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('visit','visit_event')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'rls +: still enabled AND forced on visit and visit_event after the expand');

-- ═══ §3.5 · the four state axes and the four binding columns exist ═════════
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'visit'
      and column_name in ('service_type_id','service_location_id',
                          'service_location_version_id','policy_id',
                          'verification_status','approval_status',
                          'payroll_status','evv_status')),
  8, 'visit +: all eight §3.5 columns landed');

-- The four axes default to the states docs/17 §3.5 pins, and 'not_required' (not
-- 'pending') is the EVV default — a default of pending would invent a backlog.
select is(
  (select verification_status || '/' || approval_status || '/' ||
          payroll_status || '/' || evv_status
     from public.visit where id = 'aaaaaaaa-0000-0000-0000-00000000e003'),
  'pending/pending/not_ready/not_required',
  'visit +: the four axes default to pending / pending / not_ready / not_required');

select throws_ok(
  $$update public.visit set verification_status = 'nonsense'
     where id = 'aaaaaaaa-0000-0000-0000-00000000e003'$$,
  '23514', null,
  'visit -: verification_status refuses a value outside the four-state CHECK');
select throws_ok(
  $$update public.visit set evv_status = 'submitted_maybe'
     where id = 'aaaaaaaa-0000-0000-0000-00000000e003'$$,
  '23514', null,
  'visit -: evv_status refuses a value outside the six-state CHECK');

-- The binding columns point where D-014 says they point. policy_id is asserted from the
-- catalog rather than by inserting, so this file stays independent of 0044's shape.
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.visit'::regclass and contype = 'f'
      and confrelid in ('public.service_type'::regclass,
                        'public.service_location'::regclass,
                        'public.service_location_version'::regclass,
                        'public.visit_policy'::regclass)),
  4, 'visit +: the four new FKs point at service_type, service_location, '
     'service_location_version and visit_policy');

-- ═══ D-024 · the projection columns are RPC-only, and 0023''s perimeter holds ══
-- docs/17 §3.5 prescribes revoking table-wide UPDATE and re-granting ten scheduling
-- columns. 0023 had already revoked insert+update outright AND dropped both write
-- policies, so 0045 grants nothing: these four assertions are the stronger property the
-- migration actually delivers, and they fail loudly if anyone ever "restores" the
-- column grants the doc describes.
select ok(not has_table_privilege('authenticated', 'public.visit', 'update'),
  'd-024 -: authenticated has no table-wide UPDATE grant on visit');
select ok(not has_table_privilege('authenticated', 'public.visit', 'insert'),
  'd-024 -: authenticated has no INSERT grant on visit (lane-B perimeter, 0023)');
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'visit' and p.polcmd in ('w', 'a')),
  0, 'd-024 -: no UPDATE or INSERT policy survives on visit — writes are definer-only');
select ok(
  not has_column_privilege('authenticated', 'public.visit', 'verification_status', 'update'),
  'd-024 -: authenticated cannot UPDATE verification_status (projection is RPC-only)');
select ok(
  not has_column_privilege('authenticated', 'public.visit', 'service_location_version_id',
                           'update'),
  'd-024 -: authenticated cannot UPDATE service_location_version_id (binding is RPC-only)');
select ok(
  not has_column_privilege('authenticated', 'public.visit', 'caregiver_id', 'update'),
  'd-024 -: no per-column UPDATE grant was issued for the scheduling columns either');
select ok(has_table_privilege('authenticated', 'public.visit', 'select'),
  'd-024 +: the SELECT grant on visit is untouched by the tightening');

-- ═══ §3.6 · visit_event — the widened event_type CHECK ═════════════════════
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'visit_event'
      and column_name in ('client_event_id','client_captured_at','received_at',
                          'service_location_version_id','policy_id','distance_m',
                          'location_status','capture_source','is_offline',
                          'device_session_id','reason_code','corrects_event_id')),
  12, 'visit_event +: all twelve §3.6 columns landed');

select lives_ok(
  $$insert into public.visit_event
      (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
       reason_code, corrects_event_id)
    values ('aaaaaaaa-0000-0000-0000-00000000a007',
            'aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1',
            'correction', '2026-03-02 11:30:00+00',
            'device_issue', 'aaaaaaaa-0000-0000-0000-00000000a005')$$,
  'visit_event +: a correction event is accepted and references what it corrects');
select lives_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, occurred_at,
       location_status, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e002',
            'aaaaaaaa-0000-0000-0000-0000000000c1',
            'exception_requested', '2026-03-02 13:05:00+00',
            'outside_geofence', 'alternate_location')$$,
  'visit_event +: an exception_requested event is accepted');
select throws_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_sideways')$$,
  '23514', null,
  'visit_event -: the widened CHECK is still a whitelist, not an open door');
-- `method` keeps its 0013 CHECK; capture_source is the finer-grained field (§3.6).
select throws_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, method)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_in', 'offline')$$,
  '23514', null,
  'visit_event -: method still refuses ''offline'' — capture_source carries that lane');
select throws_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, capture_source)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_in', 'carrier_pigeon')$$,
  '23514', null, 'visit_event -: capture_source refuses a value outside its four lanes');
select throws_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, location_status)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_in', 'probably_fine')$$,
  '23514', null, 'visit_event -: location_status refuses a value outside the §4.3 set');
select throws_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, reason_code)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_in', 'because')$$,
  '23514', null, 'visit_event -: reason_code refuses a value outside the seven codes');

-- Server-side capture defaults: web, online, and a received_at the caller cannot forge.
select is(
  (select capture_source || '/' || is_offline::text || '/' ||
          (received_at is not null)::text
     from public.visit_event where id = 'aaaaaaaa-0000-0000-0000-00000000a007'),
  'web/false/true',
  'visit_event +: capture_source, is_offline and received_at carry their server defaults');

-- ═══ §4.4 step 3 · idempotent replay is an INDEX, not a hope ═══════════════
select throws_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, client_event_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e002',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_in', 'queued-1')$$,
  '23505', null,
  'replay -: the same client_event_id cannot land twice on one visit');
select lives_ok(
  $$insert into public.visit_event
      (tenant_id, visit_id, caregiver_id, event_type, client_event_id, occurred_at)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e001',
            'aaaaaaaa-0000-0000-0000-0000000000c1', 'clock_in', 'queued-1',
            '2026-03-02 09:30:00+00')$$,
  'replay +: the same key on a DIFFERENT visit is a different intent and is allowed');
select is(
  (select count(*)::int from public.visit_event
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and client_event_id is null),
  6, 'replay +: many keyless (live, online) events coexist on one visit — partial index');

-- ═══ invariant 1 · visit_event is append-only at BOTH layers ═══════════════
select throws_like(
  $$update public.visit_event set note = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%',
  'visit_event -: UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.visit_event$$,
  '%CAREOS_APPEND_ONLY%',
  'visit_event -: DELETE raises CAREOS_APPEND_ONLY (even as superuser)');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'update'),
  'visit_event -: authenticated has no UPDATE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'delete'),
  'visit_event -: authenticated has no DELETE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'insert'),
  'visit_event -: authenticated has no INSERT grant — the clock RPC is the only writer');

-- ═══ public.verified_visit — the view''s own posture ═══════════════════════
-- security_invoker is the whole security model of this view. Without it the view runs as
-- postgres and leaks every tenant''s ledger to every caller.
select ok(
  (select 'security_invoker=true' = any (coalesce(reloptions, '{}'))
     from pg_class where relname = 'verified_visit' and relkind = 'v'),
  'verified_visit +: the view is security_invoker — base-table RLS applies to the querier');
select ok(has_table_privilege('authenticated', 'public.verified_visit', 'select'),
  'verified_visit +: authenticated may read the view');
select ok(not has_table_privilege('anon', 'public.verified_visit', 'select'),
  'verified_visit -: anon cannot read the view');
select ok(not has_table_privilege('authenticated', 'public.verified_visit', 'insert'),
  'verified_visit -: the view is read-only for authenticated');
-- D-030, asserted against the catalog rather than against good intentions.
select ok(
  pg_get_viewdef('public.verified_visit'::regclass) !~* '(latitude|longitude)',
  'verified_visit -: no coordinate column appears anywhere in the view definition (D-030)');

-- ═══ verified_visit · RLS composes THROUGH the view ════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is(
  (select count(*)::int from public.verified_visit
    where visit_id in ('aaaaaaaa-0000-0000-0000-00000000e001',
                       'aaaaaaaa-0000-0000-0000-00000000e002',
                       'aaaaaaaa-0000-0000-0000-00000000e003')),
  3, 'verified_visit +: the assigned caregiver (AAL2) sees their three visits');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.verified_visit), 0,
  'verified_visit -: the same caregiver at AAL1 sees nothing (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.verified_visit), 0,
  'verified_visit -: an unrelated tenant-A caregiver sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is(
  (select count(*)::int from public.verified_visit
    where client_id = 'aaaaaaaa-0000-0000-0000-00000000c001'),
  3, 'verified_visit +: a care-team member sees their client''s visits');
-- Composition, not just row visibility: the lateral joins run under A3''s RLS on
-- visit_event too, so the derived columns are populated rather than silently NULL.
select is(
  (select actual_start from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  '2026-03-02 09:07:30+00'::timestamptz,
  'verified_visit +: the derived clock columns compose under the care-team member''s RLS');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.verified_visit
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  3, 'verified_visit +: a schedule.read holder sees the tenant''s visits');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.verified_visit
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'verified_visit -: a tenant-B admin sees no tenant-A row (tenant isolation)');
select is(
  (select count(*)::int from public.verified_visit
    where visit_id = 'bbbbbbbb-0000-0000-0000-00000000e001'),
  1, 'verified_visit +: the tenant-B admin still sees their own tenant''s visit');

-- ═══ verified_visit · the derivation (read as postgres: arithmetic, not visibility) ══
reset role;
select is(
  (select actual_start from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  '2026-03-02 09:07:30+00'::timestamptz,
  'derivation +: actual_start is the EARLIEST clock_in, not the second tap');
select is(
  (select clock_in_event_id from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'aaaaaaaa-0000-0000-0000-00000000a002'::uuid,
  'derivation +: clock_in_event_id links to the winning event (IDs travel, invariant 5)');
select is(
  (select actual_end from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  '2026-03-02 11:03:20+00'::timestamptz,
  'derivation +: actual_end is the LATEST clock_out, not the earlier one');
select is(
  (select scheduled_minutes from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  120, 'derivation +: scheduled_minutes is the planned window (09:00–11:00)');
select is(
  (select verified_minutes from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  115, 'derivation +: verified_minutes floors 115m50s to 115 — rounding up invents pay');
select is(
  (select late_minutes from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  7, 'derivation +: late_minutes floors a 7m30s late arrival to 7');
select is(
  (select overrun_minutes from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  3, 'derivation +: overrun_minutes floors a 3m20s overrun to 3');
select is(
  (select clock_in_location_status || '/' || clock_out_location_status
     from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'verified/verified',
  'derivation +: both location verdicts surface from the winning events');
select is(
  (select clock_in_distance_m from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  18::double precision,
  'derivation +: distance in metres surfaces as administrator evidence (never coordinates)');
select ok(
  (select not had_offline_capture from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'derivation +: a live online visit is not flagged as an offline capture');

-- v2: early arrival, never clocked out.
select is(
  (select late_minutes from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  0, 'derivation +: arriving five minutes early is zero lateness, never negative');
select ok(
  (select actual_end is null and overrun_minutes is null and verified_minutes is null
     from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  'derivation +: a missing clock_out leaves actual_end, overrun and verified NULL');
select ok(
  (select had_offline_capture from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  'derivation +: an offline replay is flagged, never presented as ordinarily verified');

-- v3: nobody came. The greatest()-ignores-nulls trap lives here.
select ok(
  (select actual_start is null and late_minutes is null
     from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e003'),
  'derivation +: a visit with no clock_in reports NULL lateness, never "on time"');
select is(
  (select scheduled_minutes from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e003'),
  120, 'derivation +: an unworked visit still reports its scheduled window');

-- A rejected attempt is evidence, not an arrival — the reason those event types exist.
select is(
  (select count(*)::int from public.visit_event
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and event_type = 'clock_in_rejected'),
  1, 'derivation +: the rejected attempt is on the ledger…');
select ok(
  (select actual_start > '2026-03-02 09:00:10+00'::timestamptz
     from public.verified_visit
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'derivation +: …and it did not become the arrival, despite being the earliest row');

-- ═══ invariant 5 + D-030 · the audit payload carries no geography ══════════
-- Written under a real session so the emitter''s tenant guard passes and the trigger
-- actually fires; the row itself carries coordinates and a distance, and the ledger
-- entry must carry neither.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
reset role;   -- postgres inserts (no client INSERT grant exists), JWT context persists
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   latitude, longitude, accuracy_m, distance_m, location_status,
   capture_source, is_offline, note)
values
  ('aaaaaaaa-0000-0000-0000-00000000a009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', '2026-03-02 17:02:00+00', 39.0839, -77.1528, 9, 1275.5,
   'outside_geofence', 'offline', true, 'client was at the day program');

select is(
  (select count(*)::int from audit.audit_event
    where entity_type = 'visit_event'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000a009'
      and action = 'visit.clock_in'),
  1, 'audit +: appending a clock event emits exactly one audit row (invariant 7)');
select is(
  (select payload ->> 'capture_source' || '/' || (payload ->> 'is_offline') || '/' ||
          (payload ->> 'location_status')
     from audit.audit_event
    where entity_id = 'aaaaaaaa-0000-0000-0000-00000000a009'),
  'offline/true/outside_geofence',
  'audit +: the payload carries the capture enums a surveyor needs');
select ok(
  (select not (payload ? 'latitude' or payload ? 'longitude' or payload ? 'distance_m'
               or payload ? 'note')
     from audit.audit_event
    where entity_id = 'aaaaaaaa-0000-0000-0000-00000000a009'),
  'audit -: the payload has no latitude, longitude, distance or free-text key (D-030)');
select ok(
  (select payload::text not like '%39.0839%' and payload::text not like '%1275.5%'
     from audit.audit_event
    where entity_id = 'aaaaaaaa-0000-0000-0000-00000000a009'),
  'audit -: the literal coordinate and distance appear nowhere in the payload text');

reset role;
select * from finish();
rollback;
