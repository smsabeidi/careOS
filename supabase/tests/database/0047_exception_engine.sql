-- pgTAP · exception engine (0047): the two [AO] ledgers are RLS-enclosed and immutable,
-- the five detectors are deterministic, clock-injectable and idempotent, corrections
-- append instead of overwrite, only a human disposes, and no coordinate ever reaches an
-- audit / outbox / notification / evidence payload (D-030, invariant 5).
-- Style mirrors 0011_scheduling.sql / 0027_domain_event_outbox.sql.
-- @trace: ST-205, D-016, D-020, D-024, D-030
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'exc.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'exc.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'exc.cg2.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'exc.cg3.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'exc.agent.a@agents.careos.internal'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'exc.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Exception Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Exception Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exc Admin A', 'exc.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exc Caregiver A1', 'exc.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exc Caregiver A2', 'exc.cg2.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exc Caregiver A3', 'exc.cg3.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Exc Admin B', 'exc.admin.b@brookmead.test', 'staff');
-- A machine principal that legitimately holds visit.verify.act (it reads and narrates
-- the queue) and must still be structurally unable to close a finding (D-020).
insert into public.app_user (id, tenant_id, full_name, work_email, kind, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exception Triage', 'exc.agent.a@agents.careos.internal', 'system', 'active');
-- 0039: system principals need an ENABLED agent_identity row for tenant context.
insert into public.agent_identity (tenant_id, agent_key, app_user_id, charter, enabled)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'exception_triage',
        'aaaaaaaa-0000-0000-0000-0000000000a9',
        'Ranks and narrates the exception queue. Never disposes.', true);

insert into public.permission (key, description) values
  ('schedule.read', 'test'), ('schedule.write', 'test'),
  ('visit.verify.read', 'test'), ('visit.verify.act', 'test'), ('visit.correct', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'exc_admin', 'Exc Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0a9', 'aaaaaaaa-0000-0000-0000-000000000001',
   'exc_agent', 'Exc Agent'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'exc_admin', 'Exc Admin B');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.verify.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.verify.act'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.correct'),
  ('aaaaaaaa-0000-0000-0000-00000000e0a9', 'visit.verify.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0a9', 'visit.verify.act'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'visit.verify.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'visit.verify.act');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000a9', 'aaaaaaaa-0000-0000-0000-00000000e0a9'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exc', 'ClientA'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Exc', 'ClientTwo'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Exc', 'ClientB');

-- Caregiver A1 is on client A's care team; A2 and A3 are not.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

-- Policy (0044): the tenant floor requires a visit note; a client-scoped row for
-- ClientTwo forbids location exceptions, which is the refusal probe below.
-- effective_from is pinned a month back ON PURPOSE. Every visit below is dated in the
-- past, and docs/17 §4.2 leaves open whether app.visit_policy_for resolves as of now()
-- or as of the visit's own window; a policy that only became effective at INSERT time
-- would make this whole file's outcome depend on that unspecified choice. Tenant B
-- deliberately gets NO policy row: an unconfigured tenant must be skipped, not fatal.
insert into public.visit_policy
  (tenant_id, scope_kind, version_no, effective_from, require_visit_note, created_by)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant', 1, now() - interval '30 days', true,
   'aaaaaaaa-0000-0000-0000-0000000000ad');
insert into public.visit_policy
  (tenant_id, scope_kind, scope_id, version_no, effective_from,
   allow_location_exception, created_by)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'client',
   'aaaaaaaa-0000-0000-0000-00000000c002', 1, now() - interval '30 days', false,
   'aaaaaaaa-0000-0000-0000-0000000000ad');

-- Visits (inserted as postgres ⇒ the audit/outbox triggers no-op, no chain fork).
--   e001 open clock-in, past its window   → missing_clock_out
--   e002 never started, past the window   → missed_visit
--   e003 never started, still in window   → NOT missed (the clock-injection negative)
--   e004/e005 overlapping actual windows  → overlapping_visits, both sides
--   e006 completed, undocumented          → documentation_missing
--   e007 completed, documented            → NOT a gap (the negative)
--   e008/e009 A2's two clocked visits     → impossible_travel between them
--   e010 completed, the correction subject
--   e011 ClientTwo, the "policy forbids an exception" subject
insert into public.visit (id, tenant_id, client_id, caregiver_id, scheduled_start,
                          scheduled_end, status, note) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '4 hours', now() - interval '3 hours', 'in_progress', null),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '3 hours', now() - interval '2 hours', 'scheduled', null),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '10 minutes', now() + interval '50 minutes', 'scheduled', null),
  ('aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '8 hours', now() - interval '6 hours', 'completed', null),
  ('aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '7 hours', now() - interval '5 hours', 'completed', null),
  ('aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '2 hours', now() - interval '1 hour', 'completed', null),
  ('aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '2 hours', now() - interval '1 hour', 'completed',
   'Client resting comfortably; meds taken.'),
  ('aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now() - interval '3 hours', now() - interval '2 hours', 'completed', null),
  ('aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now() - interval '110 minutes', now() - interval '60 minutes', 'completed', null),
  ('aaaaaaaa-0000-0000-0000-00000000e010', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '10 hours', now() - interval '9 hours', 'completed',
   'Documented at the desk.'),
  ('aaaaaaaa-0000-0000-0000-00000000e011', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '10 minutes', now() + interval '50 minutes', 'scheduled', null),
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', null,
   now() - interval '1 hour', now(), 'scheduled', null);

-- Clock ledger. Only A2's two visits carry coordinates: Baltimore → Ocean City in ten
-- minutes is ~170 km, ~1000 km/h — impossible under the 120 km/h policy default.
insert into public.visit_event (id, tenant_id, visit_id, caregiver_id, event_type,
                                occurred_at, latitude, longitude, accuracy_m) values
  ('aaaaaaaa-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '4 hours', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '8 hours', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000a005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '6 hours', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000a006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '7 hours', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000a007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '5 hours', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000a008', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_in', now() - interval '3 hours', 39.2904, -76.6122, 20),
  ('aaaaaaaa-0000-0000-0000-00000000a009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_out', now() - interval '2 hours', 39.2904, -76.6122, 20),
  ('aaaaaaaa-0000-0000-0000-00000000a010', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_in', now() - interval '110 minutes', 38.3365, -75.0849, 20),
  ('aaaaaaaa-0000-0000-0000-00000000a011', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_out', now() - interval '60 minutes', 38.3365, -75.0849, 20),
  ('aaaaaaaa-0000-0000-0000-00000000a012', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e010', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '10 hours', null, null, null),
  ('aaaaaaaa-0000-0000-0000-00000000a013', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e010', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '9 hours', null, null, null);
-- A rejected attempt (0045's widened event_type CHECK): the thing a correction may NOT
-- re-time, and the position app.request_location_exception would carry forward.
insert into public.visit_event (id, tenant_id, visit_id, caregiver_id, event_type,
                                occurred_at, latitude, longitude, accuracy_m,
                                location_status) values
  ('aaaaaaaa-0000-0000-0000-00000000a014', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e011', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in_rejected', now() - interval '5 minutes', 39.2904, -76.6122, 40,
   'outside_geofence');

-- A tenant-B finding, seeded directly (tenant B has no policy, so no detector will ever
-- raise one for it). Without a row on the other side of the perimeter, every
-- cross-tenant probe below would pass vacuously against an empty table — which proves
-- nothing about isolation.
insert into public.visit_exception (id, tenant_id, visit_id, kind, severity, dedupe_key)
values
  ('bbbbbbbb-0000-0000-0000-00000000d001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000e001', 'missed_visit', 'critical',
   'visit:bbbbbbbb-0000-0000-0000-00000000e001');

-- Session simulator (identical to 002/003/0011).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ Structure: RLS, grants, catalog, view, cron ═══════════════════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('visit_exception','visit_exception_disposition')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'rls: enabled + forced on visit_exception and visit_exception_disposition');

select ok(has_table_privilege('authenticated', 'public.visit_exception', 'select'),
  'grants +: authenticated may SELECT visit_exception (RLS gates the rows)');
select ok(not has_table_privilege('authenticated', 'public.visit_exception', 'insert'),
  'grants -: no INSERT grant on visit_exception (definer raise paths only)');
select ok(not has_table_privilege('authenticated', 'public.visit_exception', 'update'),
  'grants -: no UPDATE grant on visit_exception (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_exception', 'delete'),
  'grants -: no DELETE grant on visit_exception (append-only)');
select ok(has_table_privilege('authenticated', 'public.visit_exception_disposition', 'select'),
  'grants +: authenticated may SELECT visit_exception_disposition');
select ok(not has_table_privilege('authenticated', 'public.visit_exception_disposition', 'insert'),
  'grants -: no INSERT grant on visit_exception_disposition (RPC only)');
select ok(not has_table_privilege('authenticated', 'public.visit_exception_disposition', 'update'),
  'grants -: no UPDATE grant on visit_exception_disposition (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_exception_disposition', 'delete'),
  'grants -: no DELETE grant on visit_exception_disposition (append-only)');

select is(
  (select count(*)::int from public.permission
    where key in ('visit.verify.read','visit.verify.act','visit.correct')),
  3, 'catalog: the three ST-205 permission keys ship in the migration, not the seed');

select ok(exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'visit_exception_state'
       and c.reloptions @> array['security_invoker=true']),
  'view: visit_exception_state is security_invoker (RLS composes through, invariant 9)');
select ok(has_table_privilege('authenticated', 'public.visit_exception_state', 'select'),
  'grants +: authenticated may SELECT the state view (its base tables still gate rows)');
select ok(
  (select pg_get_viewdef('public.visit_exception_state'::regclass)) not like '%latitude%'
  and (select pg_get_viewdef('public.visit_exception_state'::regclass)) not like '%longitude%',
  'view -: the state view selects no coordinate anywhere in its definition (D-030)');

select is((select count(*)::int from cron.job where jobname = 'careos_visit_sweep'),
  1, 'cron: the five-minute visit sweep is registered (0034 idiom)');
-- The local stack runs the real pg_cron, so on any machine where a five-minute boundary
-- has passed since the reset, the sweep has already run and earned its heartbeat —
-- asserting "still RED" here failed by wall clock, not by regression. The invariant was
-- never "the sweep has not run"; it is "green is only ever EARNED": the heartbeat is
-- either still the RED the migration seeded, or it is green because a sweep run actually
-- succeeded. A heartbeat born green with no run behind it — the lie 0039 H1 exists to
-- prevent — still fails this test, in CI and on a laptop alike.
select is(
  (select count(*)::int from public.job_heartbeat
    where job_key = 'visit_sweep'
      and (last_ok_at is null
           or exists (select 1
                        from cron.job_run_details d
                        join cron.job j on j.jobid = d.jobid
                       where j.jobname = 'careos_visit_sweep'
                         and d.status = 'succeeded'))),
  1, 'cron: the sweep heartbeat starts RED and green is only ever earned (0039 H1)');

-- ═══ Function surface: who may call what ═══════════════════════════════════
select ok(has_function_privilege('authenticated',
  'app.correct_visit_event(uuid,timestamptz,text)', 'execute'),
  'lane-b +: authenticated can call app.correct_visit_event');
select ok(has_function_privilege('authenticated',
  'app.dispose_visit_exception(uuid,text,text)', 'execute'),
  'lane-b +: authenticated can call app.dispose_visit_exception');
select ok(has_function_privilege('authenticated',
  'app.request_location_exception(uuid,text,text,text)', 'execute'),
  'lane-b +: authenticated can call app.request_location_exception');
select ok(not has_function_privilege('anon',
  'app.request_location_exception(uuid,text,text,text)', 'execute'),
  'lane-b -: anon can call none of it');
select ok(not has_function_privilege('authenticated',
  'app.raise_visit_exception(uuid,text,text,jsonb,text)', 'execute'),
  'lane-b -: raising an exception is system/internal, not a client call');
select ok(not has_function_privilege('authenticated',
  'app.sweep_visit_exceptions(timestamptz)', 'execute'),
  'sweep -: authenticated cannot drive the engine');
select ok(not has_function_privilege('service_role',
  'app.sweep_visit_exceptions(timestamptz)', 'execute'),
  'sweep -: service_role cannot drive it either (cron owns the tick)');
select ok(not has_function_privilege('authenticated',
  'app.detect_missing_clock_out(timestamptz)', 'execute'),
  'sweep -: detectors are definer plumbing, not client calls');
select ok(not has_function_privilege('authenticated',
  'app.raise_visit_exception_internal(uuid,uuid,uuid,text,text,text,text,jsonb,text,uuid,uuid)',
  'execute'),
  'sweep -: the internal raiser is reachable only from definer bodies');
select ok(not has_function_privilege('authenticated',
  'app.notify_visit_verifiers(uuid,text,uuid,text)', 'execute'),
  'sweep -: the supervisor fan-out is definer plumbing');

-- ═══ Detectors: deterministic, clock-injectable, idempotent ════════════════
-- Missing clock-out. The injected clock is the whole point: at a p_now before the
-- window closed, nothing is late.
select is(app.detect_missing_clock_out(now() - interval '10 hours'), 0,
  'missing_clock_out -: at an earlier clock nothing is overdue (D-016 injection)');
select is(app.detect_missing_clock_out(now()), 1,
  'missing_clock_out +: the open visit past its grace window raises one exception');
select is(app.detect_missing_clock_out(now()), 0,
  'missing_clock_out +: a second sweep raises nothing (dedupe_key idempotence)');
select is(
  (select count(*)::int from public.visit_exception
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and kind = 'missing_clock_out' and severity = 'warning'
      and detected_by = 'rule' and rule_key = 'sweep.missing_clock_out'),
  1, 'missing_clock_out +: exactly one row, warning, machine-detected');
select is(
  (select verification_status from public.visit
    where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'exception',
  'projection: raising an exception projects verification_status=exception (D-024)');

-- Missed visits. Advances the status through the transition 0026 whitelisted and
-- nothing had ever invoked.
select is(app.detect_missed_visits(now() - interval '210 minutes'), 0,
  'missed_visit -: at an earlier clock the caregiver still has time (D-016 injection)');
select is(app.detect_missed_visits(now()), 1,
  'missed_visit +: the unattended visit past the threshold raises one exception');
select is(app.detect_missed_visits(now()), 0,
  'missed_visit +: a second sweep raises nothing (idempotence)');
select is(
  (select status from public.visit where id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  'missed', 'missed_visit +: the visit advanced scheduled→missed (0026 transition)');
select is(
  (select status from public.visit where id = 'aaaaaaaa-0000-0000-0000-00000000e003'),
  'scheduled',
  'missed_visit -: a visit still inside its window is untouched (no false no-show)');

-- Overlapping actual windows, raised on both sides.
select is(app.detect_overlapping_visits(null, now()), 2,
  'overlapping_visits +: one overlapping pair raises on both visits');
select is(app.detect_overlapping_visits(null, now()), 0,
  'overlapping_visits +: a second sweep raises nothing (idempotence)');
select is(
  (select count(*)::int from public.visit_exception
    where kind = 'overlapping_visits'
      and visit_id in ('aaaaaaaa-0000-0000-0000-00000000e004',
                       'aaaaaaaa-0000-0000-0000-00000000e005')),
  2, 'overlapping_visits +: both sides of the pair carry the finding');
select is(
  (select evidence ->> 'other_visit_id' from public.visit_exception
    where kind = 'overlapping_visits'
      and visit_id = 'aaaaaaaa-0000-0000-0000-00000000e004'),
  'aaaaaaaa-0000-0000-0000-00000000e005',
  'overlapping_visits +: the evidence names the other visit by id');

-- Impossible travel: PostGIS metres over the elapsed hours, against the policy ceiling.
select is(app.detect_impossible_travel(null, now()), 1,
  'impossible_travel +: Baltimore→Ocean City in ten minutes is one finding');
select is(app.detect_impossible_travel(null, now()), 0,
  'impossible_travel +: a second sweep raises nothing (idempotence)');
select ok(
  (select (evidence ->> 'speed_kmh')::numeric from public.visit_exception
    where kind = 'impossible_travel') > 120,
  'impossible_travel +: the computed speed exceeds the policy ceiling');
select is(
  (select evidence ->> 'threshold_kmh' from public.visit_exception
    where kind = 'impossible_travel'),
  '120', 'impossible_travel +: the evidence records the threshold it was judged against');
select ok(
  not ((select evidence from public.visit_exception where kind = 'impossible_travel')
       ?| array['lat','lng','latitude','longitude','coordinates','geo','point']),
  'impossible_travel -: the evidence carries a speed, never a coordinate (D-030)');
select is(
  (select severity from public.visit_exception where kind = 'impossible_travel'),
  'critical', 'impossible_travel +: a fraud signal is critical, not informational');

-- Documentation gaps, per the agency's own policy switch.
select ok(app.detect_documentation_gaps(null, now()) > 0,
  'documentation_missing +: undocumented completed visits are found');
select is(app.detect_documentation_gaps(null, now()), 0,
  'documentation_missing +: a second sweep raises nothing (idempotence)');
select is(
  (select count(*)::int from public.visit_exception
    where kind = 'documentation_missing'
      and visit_id = 'aaaaaaaa-0000-0000-0000-00000000e006'),
  1, 'documentation_missing +: the undocumented visit is flagged');
select is(
  (select count(*)::int from public.visit_exception
    where kind = 'documentation_missing'
      and visit_id = 'aaaaaaaa-0000-0000-0000-00000000e007'),
  0, 'documentation_missing -: a visit with a note is not flagged');

-- The sweep is the cron entry point and reports per-rule counts.
select is((app.sweep_visit_exceptions(now()) ->> 'total')::int, 0,
  'sweep: running the whole engine again finds nothing new (idempotent by construction)');
select is((app.sweep_visit_exceptions(now()) ->> 'missing_clock_out')::int, 0,
  'sweep: the result carries a per-rule count for every detector');
select is(app.sweep_visit_exceptions(now()) ->> 'ok', 'true',
  'sweep: the return shape starts ok:true (docs/08 §2 convention)');
-- Tenant B has no visit_policy row at all. Its overdue visit must be SKIPPED, not
-- judged against a threshold nobody set — and skipping it must not have stopped the
-- tenant-A rules above from running, which every assertion in this section proves.
select is(
  (select status from public.visit where id = 'bbbbbbbb-0000-0000-0000-00000000e001'),
  'scheduled',
  'sweep -: an unconfigured tenant is skipped, never judged (CAREOS_POLICY_MISSING)');
select is(
  (select count(*)::int from public.visit_exception
    where visit_id = 'bbbbbbbb-0000-0000-0000-00000000e001' and rule_key is not null),
  0, 'sweep -: no rule-detected finding is invented for a tenant with no policy');

-- ═══ Invariant 5 / D-030: coordinates cannot be written into evidence ══════
select throws_like(
  $$select app.raise_visit_exception('aaaaaaaa-0000-0000-0000-00000000e006',
      'late_start', 'info', '{"latitude": 39.2904}'::jsonb, 'phi-probe')$$,
  '%CAREOS_PHI_LEAK%',
  'phi -: the raiser refuses evidence carrying a coordinate (invariant 5, D-030)');
select throws_ok(
  $$insert into public.visit_exception
      (tenant_id, visit_id, kind, dedupe_key, evidence)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000e006', 'late_start', 'phi-probe-2',
            '{"lng": -76.6122}'::jsonb)$$,
  '23514', null,
  'phi -: the CHECK constraint refuses it underneath, even for the superuser');

-- The canary: the impossible-travel finding read coordinates and none of them reached
-- any downstream payload. Greps for the literal longitude that produced the finding.
select is(
  (select count(*)::int from audit.audit_event where payload::text like '%76.6122%'),
  0, 'canary: no coordinate reached an audit payload');
select is(
  (select count(*)::int from public.domain_event where payload::text like '%76.6122%'),
  0, 'canary: no coordinate reached an outbox payload');
select is(
  (select count(*)::int from public.visit_exception where evidence::text like '%76.6122%'),
  0, 'canary: no coordinate reached exception evidence');
select is(
  (select count(*)::int from public.notification where title like '%76.6122%'),
  0, 'canary: no coordinate reached a notification');

-- ═══ Audit + outbox: invariant 7 holds on the machine path too ═════════════
select ok(
  (select count(*) from audit.audit_event
    where action = 'visit_exception.missing_clock_out' and actor_kind = 'system') = 1,
  'audit: a sweep-detected exception lands on the ledger as a system actor');
select ok(
  (select count(*) from public.domain_event
    where event_type = 'visit.exception.raised') >= 5,
  'outbox: every raised exception emitted visit.exception.raised');
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'visit.missed'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  1, 'outbox: the missed visit emitted visit.missed exactly once (docs/17 §8)');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.status_change' and actor_kind = 'system'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  1, 'audit: the sweep carries its own status-change entry (the triggers no-op)');

-- ═══ Notifications: management by exception, PHI-free by construction ══════
select is(
  (select count(*)::int from public.notification
    where recipient_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'
      and template_key = 'visit.missing_clock_out'),
  1, 'notify +: the caregiver hears about their own open visit first (docs/17 §9)');
select is(
  (select count(*)::int from public.notification
    where recipient_id = 'aaaaaaaa-0000-0000-0000-0000000000ad'
      and template_key = 'visit.missing_clock_out'),
  1, 'notify +: the desk is escalated to at twice the threshold');
select is(
  (select count(*)::int from public.notification
    where recipient_id = 'aaaaaaaa-0000-0000-0000-0000000000ad'
      and template_key = 'visit.missed'),
  1, 'notify +: the desk hears about the missed visit');
select is(
  (select count(*)::int from public.notification
    where recipient_id = 'aaaaaaaa-0000-0000-0000-0000000000a9'),
  0, 'notify -: the agent principal holding visit.verify.act is never paged (D-020)');
select is(
  (select distinct title from public.notification where template_key = 'visit.missed'),
  'A scheduled visit was never started',
  'notify: the title comes from the closed map — no name, no address, no jargon');
select throws_like(
  $$select app.queue_notification('aaaaaaaa-0000-0000-0000-0000000000ad',
      'visit.invented', null)$$,
  '%CAREOS_BAD_TEMPLATE%',
  'notify -: an unregistered template is still refused (0039 M4 preserved)');
select ok(
  app.queue_notification('aaaaaaaa-0000-0000-0000-0000000000ad', 'offer.new', null,
    'visit', 'aaaaaaaa-0000-0000-0000-00000000e001', 'in_app', 'tmpl-probe') is not null,
  'notify +: the six pre-existing 0039 template keys still resolve');

-- ═══ Append-only, both layers ══════════════════════════════════════════════
select throws_like(
  $$update public.visit_exception set severity = 'info'$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: visit_exception UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.visit_exception$$,
  '%CAREOS_APPEND_ONLY%', 'append-only: visit_exception DELETE raises CAREOS_APPEND_ONLY');

-- ═══ RLS policy matrix on visit_exception ══════════════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select ok((select count(*) from public.visit_exception
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001') = 1,
  'visit_exception +: the caregiver sees the finding about their own visit');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.visit_exception), 0,
  'visit_exception -: the same caregiver at AAL1 sees nothing (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.visit_exception), 0,
  'visit_exception -: an unrelated caregiver sees nothing');
select is((select count(*)::int from public.visit_exception_state), 0,
  'visit_exception_state -: the view inherits the refusal (security_invoker)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select ok((select count(*) from public.visit_exception) >= 5,
  'visit_exception +: visit.verify.read sees the whole tenant queue');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.visit_exception
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'visit_exception -: tenant-B admin sees no tenant-A finding (tenant isolation)');
select is((select count(*)::int from public.visit_exception), 1,
  'visit_exception +: tenant-B admin sees tenant B''s own finding and only that');

-- ═══ app.dispose_visit_exception ═══════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'resolved', 'Caregiver confirmed departure time.')$$,
  '%CAREOS_AAL2_REQUIRED%', 'dispose -: an unverified session is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'resolved', 'I finished on time.')$$,
  '%CAREOS_FORBIDDEN%',
  'dispose -: a caregiver without visit.verify.act cannot close their own finding');

-- The D-020 probe: a machine principal WITH the permission is still refused.
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000a9', 'aal2');
select throws_like(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'dismissed', 'Auto-triaged as benign.')$$,
  '%CAREOS_HUMAN_REQUIRED%',
  'dispose -: an agent holding visit.verify.act still cannot dispose (invariant 8, D-020)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'resolved', '   ')$$,
  '%CAREOS_REASON_REQUIRED%', 'dispose -: a disposition without a reason is refused');
select throws_like(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'ignored', 'Not a real disposition.')$$,
  '%CAREOS_BAD_DISPOSITION%', 'dispose -: an unlisted disposition is refused');
select throws_like(
  $$select app.dispose_visit_exception(
      'aaaaaaaa-0000-0000-0000-0000000000ff', 'resolved', 'No such finding.')$$,
  '%CAREOS_NOT_FOUND%', 'dispose -: an unknown exception is refused');
-- The id is a literal, not a subquery: RLS would hide the tenant-B row from this
-- session, so a subquery would resolve to NULL and the probe would pass without ever
-- reaching the perimeter it claims to test.
select throws_like(
  $$select app.dispose_visit_exception(
      'bbbbbbbb-0000-0000-0000-00000000d001', 'resolved', 'Cross-tenant probe.')$$,
  '%CAREOS_NOT_FOUND%',
  'dispose -: a real tenant-B finding is not found from a tenant-A session (isolation)');

select lives_ok(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'resolved', 'Caregiver confirmed the departure time by phone.')$$,
  'dispose +: visit.verify.act closes the finding with a reason');
select is(
  (select (app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'resolved', 'Same call, submitted twice.') ->> 'unchanged')),
  'true', 'dispose +: re-submitting the same disposition is unchanged, not an error');
select is(
  (select open::text from public.visit_exception_state
    where kind = 'missing_clock_out'),
  'false', 'state view: a resolved finding is closed');
select lives_ok(
  $$select app.dispose_visit_exception(
      (select id from public.visit_exception where kind = 'missing_clock_out'),
      'reopened', 'New information from the client.')$$,
  'dispose +: a finding can be reopened');
select is(
  (select open::text from public.visit_exception_state
    where kind = 'missing_clock_out'),
  'true', 'state view: reopened is open again, and both dispositions survive');
-- The regression this file exists to prevent: both dispositions above were written in
-- ONE transaction, so they share created_at exactly. "Latest" must therefore be decided
-- by append order (seq), never by a uuid tiebreak.
select is(
  (select latest_disposition_id from public.visit_exception_state
    where kind = 'missing_clock_out'),
  (select d.id from public.visit_exception_disposition d
     join public.visit_exception e on e.id = d.exception_id
    where e.kind = 'missing_clock_out'
    order by d.seq desc limit 1),
  'state view: "latest" follows append order even when created_at ties (DN-0047e)');
select is(
  (select count(*)::int from public.visit_exception_disposition),
  2, 'dispose: nothing was overwritten — two disposition rows, append-only');

reset role;
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit_exception.resolved'),
  1, 'audit: the disposition emitted its own audit event (invariant 7)');
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'visit.exception.disposed'),
  2, 'outbox: each disposition emitted visit.exception.disposed');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit_exception.resolved' and payload ? 'reason'),
  0, 'phi: the disposition reason (free text) never enters the audit payload');
select throws_like(
  $$update public.visit_exception_disposition set reason = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: visit_exception_disposition UPDATE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.visit_exception_disposition$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: visit_exception_disposition DELETE raises CAREOS_APPEND_ONLY');

-- ═══ RLS policy matrix on the disposition ledger and the state view ════════
-- Read follows the parent finding exactly: if you can see what went wrong, you can see
-- how it was closed and by whom. Probed per principal class, both polarities.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.visit_exception_disposition), 2,
  'disposition +: the caregiver sees how the finding on their own visit was disposed');
select is(
  (select latest_disposition from public.visit_exception_state
    where kind = 'missing_clock_out'),
  'reopened', 'state view +: the caregiver reads the current state through the view');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.visit_exception_disposition), 0,
  'disposition -: the same caregiver at AAL1 sees nothing (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.visit_exception_disposition), 0,
  'disposition -: an unrelated caregiver sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_exception_disposition), 2,
  'disposition +: visit.verify.read sees the tenant''s disposition trail');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_exception_disposition), 0,
  'disposition -: tenant-B admin sees no tenant-A disposition (tenant isolation)');
select is((select count(*)::int from public.visit_exception_state), 1,
  'state view -: tenant-B admin sees only tenant B''s own finding');

reset role;

-- ═══ app.correct_visit_event ═══════════════════════════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-00000000a012',
      now() - interval '10 hours 15 minutes', 'Caregiver arrived earlier than recorded.')$$,
  '%CAREOS_AAL2_REQUIRED%', 'correct -: an unverified session is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-00000000a012',
      now() - interval '10 hours 15 minutes', 'I actually arrived earlier.')$$,
  '%CAREOS_FORBIDDEN%',
  'correct -: a caregiver without visit.correct cannot re-time their own clock');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-00000000a012',
      now() - interval '10 hours 15 minutes', '')$$,
  '%CAREOS_REASON_REQUIRED%', 'correct -: a correction without a reason is refused');
select throws_like(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-00000000a012',
      now() + interval '1 hour', 'Typo in the hour.')$$,
  '%CAREOS_BAD_TIMESTAMP%', 'correct -: a clock event cannot be moved into the future');
select throws_like(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-0000000000ff',
      now() - interval '1 hour', 'No such event.')$$,
  '%CAREOS_NOT_FOUND%', 'correct -: an unknown event is refused');
select throws_like(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-00000000a014',
      now() - interval '6 minutes', 'Re-timing the refusal.')$$,
  '%CAREOS_BAD_EVENT%',
  'correct -: a rejected attempt is a record of what the device said, not a clock reading');

select lives_ok(
  $$select app.correct_visit_event('aaaaaaaa-0000-0000-0000-00000000a012',
      now() - interval '10 hours 15 minutes',
      'Caregiver arrived 15 minutes earlier; confirmed with the client.')$$,
  'correct +: visit.correct appends a correction with a reason');
select is(
  (select count(*)::int from public.visit_event
    where corrects_event_id = 'aaaaaaaa-0000-0000-0000-00000000a012'
      and event_type = 'correction'),
  1, 'correct +: the correction is a NEW event referencing what it corrects');
select is(
  (select date_trunc('second', occurred_at) from public.visit_event
    where id = 'aaaaaaaa-0000-0000-0000-00000000a012'),
  (select date_trunc('second', now() - interval '10 hours')),
  'correct +: the original event is untouched (invariant 1 — no overwrite path)');
select is(
  (select count(*)::int from public.visit_exception
    where kind = 'manual_correction'
      and visit_id = 'aaaaaaaa-0000-0000-0000-00000000e010'),
  1, 'correct +: the correction raises its own reviewable exception (docs/17 §4.6)');
select is(
  (select detected_by from public.visit_exception where kind = 'manual_correction'),
  'human', 'correct +: a correction is human-detected, not a rule outcome');

reset role;
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.event_corrected' and payload ? 'from' and payload ? 'to'),
  1, 'audit: the correction logs old→new timestamps (docs/17 §4.6)');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.event_corrected' and payload::text like '%confirmed with the client%'),
  0, 'phi: the correction reason (free text) never enters the audit payload');
select is(
  (select count(*)::int from public.domain_event where event_type = 'visit.corrected'),
  1, 'outbox: the correction emitted visit.corrected (docs/17 §8)');

-- ═══ app.request_location_exception — the caregiver''s escape hatch ════════
-- Gate coverage only. The end-to-end happy path crosses into app.clock_visit, which
-- 0046 owns and tests: this RPC deliberately delegates the clock write rather than
-- becoming a second writer of visit.status (see the migration header).
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select throws_like(
  $$select app.request_location_exception('aaaaaaaa-0000-0000-0000-00000000e011',
      'clock_in', 'gps_unavailable', 'No signal in the basement.')$$,
  '%CAREOS_AAL2_REQUIRED%', 'location exception -: an unverified session is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.request_location_exception('aaaaaaaa-0000-0000-0000-00000000e011',
      'lunch_break', 'gps_unavailable', 'No signal.')$$,
  '%CAREOS_BAD_EVENT%', 'location exception -: only clock_in or clock_out');
select throws_like(
  $$select app.request_location_exception('aaaaaaaa-0000-0000-0000-00000000e011',
      'clock_in', 'because', 'No signal.')$$,
  '%CAREOS_BAD_REASON_CODE%',
  'location exception -: the reason code comes from the closed list, never free text');
select throws_like(
  $$select app.request_location_exception('aaaaaaaa-0000-0000-0000-0000000000ff',
      'clock_in', 'gps_unavailable', 'No signal.')$$,
  '%CAREOS_NOT_FOUND%', 'location exception -: an unknown visit is refused');
select throws_like(
  $$select app.request_location_exception('aaaaaaaa-0000-0000-0000-00000000e011',
      'clock_in', 'gps_unavailable', 'No signal.')$$,
  '%CAREOS_EXCEPTION_NOT_ALLOWED%',
  'location exception -: a policy that forbids exceptions is honoured (0044 resolution)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select throws_like(
  $$select app.request_location_exception('aaaaaaaa-0000-0000-0000-00000000e011',
      'clock_in', 'gps_unavailable', 'Trying someone else''s visit.')$$,
  '%CAREOS_FORBIDDEN%',
  'location exception -: only the assigned caregiver may request one');

reset role;
select * from finish();
rollback;
