-- pgTAP · clock engine (0046): app.evaluate_location is an exhaustive truth table and
-- never says 'suspicious'; the re-signed app.clock_visit gates on AAL2 + assignment,
-- replays idempotently, guards the clock sequence, binds the address/policy version it was
-- verified against and never re-resolves it, refuses to substitute an address the
-- scheduler did not choose, keeps clocking when a tenant has no policy at all, returns
-- buckets instead of metres, and leaks no coordinate into the audit chain or the outbox
-- (the D-030 canary).
-- Style mirrors 0013_visit_events.sql / 0027_domain_event_outbox.sql.
-- @trace: ST-204, D-014, D-022, D-024, D-029, D-030, docs/17 §4.3, §4.4
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, invariant 4) ───────────────────
-- Tenant A is an ordinary configured agency. Tenant B forbids location exceptions (the
-- hard-refusal lane). Tenant C has no visit policy at all (the DN-0046f floor lane).
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'clock.admin@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'clock.cg1@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'clock.cg2@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'clock.admin@brookmead.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'clock.cg1@brookmead.test'),
  ('cccccccc-0000-0000-0000-0000000000ad', 'clock.admin@unconfigured.test'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'clock.cg1@unconfigured.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B'),
  ('cccccccc-0000-0000-0000-000000000001', 'Tenant C');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Admin A', 'clock.admin@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Caregiver A1', 'clock.cg1@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Caregiver A2', 'clock.cg2@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Admin B', 'clock.admin@brookmead.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Caregiver B1', 'clock.cg1@brookmead.test', 'staff'),
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-000000000001',
   'Admin C', 'clock.admin@unconfigured.test', 'staff'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001',
   'Caregiver C1', 'clock.cg1@unconfigured.test', 'staff');

insert into public.permission (key, description) values
  ('schedule.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'clock_admin', 'Clock Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Ada',  'Located'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nolan','Unlocated'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001', 'Bea',  'Strict'),
  ('cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-000000000001', 'Cyril','Floor');

-- Places of care. Client A1 has a human-attested geocode at 39.290000 / -76.612000 and,
-- separately, a temporary residence the agency has NOT geocoded yet; client A2
-- deliberately has none at all (the "agency has not finished geocoding" case).
insert into public.service_location
  (id, tenant_id, client_id, kind, label, is_primary, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000005101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'primary_residence', 'Home', true,
   'aaaaaaaa-0000-0000-0000-0000000000ad'),
  ('aaaaaaaa-0000-0000-0000-000000005102', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'temporary_residence', 'Respite stay', false,
   'aaaaaaaa-0000-0000-0000-0000000000ad'),
  ('bbbbbbbb-0000-0000-0000-000000005101', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', 'primary_residence', 'Home', true,
   'bbbbbbbb-0000-0000-0000-0000000000ad'),
  ('cccccccc-0000-0000-0000-000000005101', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'primary_residence', 'Home', true,
   'cccccccc-0000-0000-0000-0000000000ad');

insert into public.service_location_version
  (id, tenant_id, service_location_id, version_no, original_address, normalized_address,
   geo, geo_precision, geo_source, verification, verified_by, verified_at, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000005a01', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000005101', 1, '1 Test Way', '1 TEST WAY',
   app.geo_point(39.290000, -76.612000), 'rooftop', 'manual', 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now(), 'aaaaaaaa-0000-0000-0000-0000000000ad'),
  ('bbbbbbbb-0000-0000-0000-000000005a01', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000005101', 1, '2 Test Way', '2 TEST WAY',
   app.geo_point(39.290000, -76.612000), 'rooftop', 'manual', 'verified',
   'bbbbbbbb-0000-0000-0000-0000000000ad', now(), 'bbbbbbbb-0000-0000-0000-0000000000ad'),
  ('cccccccc-0000-0000-0000-000000005a01', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000005101', 1, '3 Test Way', '3 TEST WAY',
   app.geo_point(39.290000, -76.612000), 'rooftop', 'manual', 'verified',
   'cccccccc-0000-0000-0000-0000000000ad', now(), 'cccccccc-0000-0000-0000-0000000000ad');

update public.service_location
   set current_version_id = 'aaaaaaaa-0000-0000-0000-000000005a01'
 where id = 'aaaaaaaa-0000-0000-0000-000000005101';
update public.service_location
   set current_version_id = 'bbbbbbbb-0000-0000-0000-000000005a01'
 where id = 'bbbbbbbb-0000-0000-0000-000000005101';
update public.service_location
   set current_version_id = 'cccccccc-0000-0000-0000-000000005a01'
 where id = 'cccccccc-0000-0000-0000-000000005101';
-- 5102 keeps current_version_id NULL on purpose: a named place with no geography.

-- Tenant policy floors. version_no is max+1 so this row is the newest at its scope
-- whether or not 0044 already seeded a tenant default — the test pins the values it
-- reasons about instead of inheriting whatever the floor happens to be.
-- Tenant A permits a location exception; tenant B forbids one (the hard-refusal lane).
-- Tenant C gets NO row at all, deliberately.
insert into public.visit_policy
  (tenant_id, scope_kind, version_no, geofence_radius_m, max_accuracy_m,
   allow_location_exception, created_by)
select 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant',
       coalesce((select max(vp.version_no) from public.visit_policy vp
                  where vp.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                    and vp.scope_kind = 'tenant'), 0) + 1,
       200, 250, true, 'aaaaaaaa-0000-0000-0000-0000000000ad';
insert into public.visit_policy
  (tenant_id, scope_kind, version_no, geofence_radius_m, max_accuracy_m,
   allow_location_exception, created_by)
select 'bbbbbbbb-0000-0000-0000-000000000001', 'tenant',
       coalesce((select max(vp.version_no) from public.visit_policy vp
                  where vp.tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001'
                    and vp.scope_kind = 'tenant'), 0) + 1,
       200, 250, false, 'bbbbbbbb-0000-0000-0000-0000000000ad';

-- The day's work. Every tenant-A visit belongs to caregiver A1. e008 is the one the
-- scheduler pinned to the ungeocoded respite address.
insert into public.visit
  (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-00000000e010', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours'),
  ('cccccccc-0000-0000-0000-00000000e001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours');
-- e008 is scheduled AT the ungeocoded respite address, not at the client's home.
insert into public.visit
  (id, tenant_id, client_id, caregiver_id, service_location_id,
   scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'aaaaaaaa-0000-0000-0000-000000005102',
   now(), now() + interval '2 hours');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- Return values are parked here so each jsonb field can be asserted separately without
-- re-calling the RPC (which the sequence guard would rightly refuse).
create temp table t_clock (k text primary key, v jsonb);
grant all on t_clock to authenticated;   -- test scaffolding only (temp schema)

-- ══ app.evaluate_location — the §4.3 truth table, exhaustively ════════════════════════
-- The clause ORDER is the contract: accuracy is judged before distance.
select is(app.evaluate_location(null, 10, 250, 200), 'unavailable',
  'evaluate_location: null accuracy is unavailable (nothing was measured)');
select is(app.evaluate_location(10, null, 250, 200), 'unavailable',
  'evaluate_location: null distance is unavailable (no place to measure against)');
select is(app.evaluate_location(null, null, 250, 200), 'unavailable',
  'evaluate_location: both null is unavailable');
select is(app.evaluate_location(900, 10, 250, 200), 'low_accuracy',
  'evaluate_location: accuracy is judged first — a fuzzy fix inside the fence is not verified');
select is(app.evaluate_location(900, 5000, 250, 200), 'low_accuracy',
  'evaluate_location: low accuracy outranks an out-of-fence distance (order matters)');
select is(app.evaluate_location(250, 10, 250, 200), 'verified',
  'evaluate_location: accuracy exactly at the ceiling passes (> not >=)');
select is(app.evaluate_location(250.5, 10, 250, 200), 'low_accuracy',
  'evaluate_location: accuracy just over the ceiling fails');
select is(app.evaluate_location(10, 10, 250, 200), 'verified',
  'evaluate_location: accurate and inside the fence is verified');
select is(app.evaluate_location(10, 200, 250, 200), 'verified',
  'evaluate_location: distance exactly at the radius is inside (<=)');
select is(app.evaluate_location(10, 200.5, 250, 200), 'outside_geofence',
  'evaluate_location: distance just past the radius is outside_geofence');
select is(app.evaluate_location(10, 0, 250, 200), 'verified',
  'evaluate_location: standing on the pin is verified');
select ok(not exists (
    select 1
      from unnest(array[null, 5, 250, 900]::double precision[]) a,
           unnest(array[null, 0, 200, 5000]::double precision[]) d
     where app.evaluate_location(a, d, 250, 200) = 'suspicious'),
  'evaluate_location -: never returns ''suspicious'' — that is a §4.5 rule with evidence');
select ok((select bool_and(app.evaluate_location(a, d, 250, 200)
             in ('unavailable','low_accuracy','verified','outside_geofence'))
             from unnest(array[null, 5, 250, 900]::double precision[]) a,
                  unnest(array[null, 0, 200, 5000]::double precision[]) d),
  'evaluate_location: the verdict is always one of the four §4.3 values');
select is((select p.provolatile::text from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'evaluate_location'), 'i',
  'evaluate_location: IMMUTABLE — a geofence verdict is a predicate, not a judgement (inv 13)');

-- ══ Function privilege posture ════════════════════════════════════════════════════════
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'clock_visit'), 1,
  'clock_visit: exactly one signature exists — D-029 drop-and-create, never an overload');
select ok(has_function_privilege('authenticated',
  'app.clock_visit(uuid,text,double precision,double precision,double precision,text,timestamptz,boolean,text,text,text)',
  'execute'),
  'clock_visit +: authenticated can call the re-signed RPC');
select ok(not has_function_privilege('anon',
  'app.clock_visit(uuid,text,double precision,double precision,double precision,text,timestamptz,boolean,text,text,text)',
  'execute'),
  'clock_visit -: anon cannot call the RPC');
select ok(not has_function_privilege('authenticated',
  'app.evaluate_location(double precision,double precision,integer,integer)', 'execute'),
  'evaluate_location -: internal plumbing — no client grant (D-030: no metres to preview)');
select ok(not has_function_privilege('anon',
  'app.evaluate_location(double precision,double precision,integer,integer)', 'execute'),
  'evaluate_location -: anon cannot call it either');

-- ══ visit_event: RLS + append-only + write surface ════════════════════════════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'visit_event'
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'visit_event: RLS enabled + forced (invariant 2)');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'insert'),
  'visit_event -: no direct insert grant — the RPC is the only write path');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'update'),
  'visit_event -: no update grant (append-only, invariant 1)');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'delete'),
  'visit_event -: no delete grant (append-only, invariant 1)');
select ok(not has_column_privilege('authenticated', 'public.visit', 'verification_status', 'update'),
  'visit -: authenticated cannot write verification_status — RPC-only projection (D-024)');
select ok(not has_column_privilege('authenticated', 'public.visit', 'policy_id', 'update'),
  'visit -: authenticated cannot write policy_id — RPC-only binding column (D-024)');
select ok(not has_column_privilege('authenticated', 'public.visit',
  'service_location_version_id', 'update'),
  'visit -: authenticated cannot write the bound address version (D-024, D-014)');

-- ══ Happy path: in the fence, accurate, verified ══════════════════════════════════════
-- 39.2903117 is the CANARY latitude: ~35 m from the pin, and a literal that must never
-- appear anywhere downstream of the ledger row.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select lives_ok(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e001', 'clock_in',
                           39.2903117, -76.612000, 8.0)$$,
  'clock +: the assigned caregiver clocks in from inside the geofence');

insert into t_clock select 'e001_out',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e001', 'clock_out',
                  39.2903118, -76.612000, 8.0);
select is((select v ->> 'status' from t_clock where k = 'e001_out'), 'completed',
  'clock +: clocking out completes the visit');
select is((select v ->> 'location_status' from t_clock where k = 'e001_out'), 'verified',
  'clock +: an accurate in-fence fix is verified');
select is((select v ->> 'distance_bucket' from t_clock where k = 'e001_out'), 'inside',
  'clock +: the caller is told ''inside'', never metres (D-030)');
select is((select v ->> 'verification_status' from t_clock where k = 'e001_out'), 'verified',
  'clock +: verification_status projects the location verdict (D-024)');
select is((select v ->> 'ok' from t_clock where k = 'e001_out'), 'true',
  'clock +: a verified clock returns ok');
select is((select v ->> 'needs_reason' from t_clock where k = 'e001_out'), 'false',
  'clock +: a verified clock never asks for a reason');
select is((select v ->> 'replayed' from t_clock where k = 'e001_out'), 'false',
  'clock +: a first-time call is not a replay');
select ok(not (select v ? 'distance_m' from t_clock where k = 'e001_out'),
  'clock -: the return payload carries no raw metres (DN-0046c, D-030)');
select ok(not (select v ? 'latitude' from t_clock where k = 'e001_out'),
  'clock -: the return payload carries no coordinates (D-030)');
select ok(not (select v ? 'note' from t_clock where k = 'e001_out'),
  'clock -: the return payload carries no free text (invariant 5)');

reset role;
select is((select status from public.visit where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'completed', 'visit: the RPC advanced status to completed');
select is((select verification_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'verified', 'visit: verification_status was written by the definer RPC');
select is((select service_location_version_id from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'aaaaaaaa-0000-0000-0000-000000005a01'::uuid,
  'visit: the address VERSION is bound on first clock-in (DN-0046a, D-014 precedent)');
select ok((select policy_id from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001') is not null,
  'visit: the policy version is bound on first clock-in (DN-0046a)');
select is((select service_location_id from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'aaaaaaaa-0000-0000-0000-000000005101'::uuid,
  'visit: the client''s primary service location is bound when the scheduler named none');
select is((select count(*)::int from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'), 2,
  'ledger: clock-in and clock-out are two appended rows');
select is((select count(*)::int from public.domain_event
            where entity_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
              and event_type = 'visit.clock_in.verified'), 1,
  'outbox: a verified clock-in emits visit.clock_in.verified (invariant 7)');
select is((select count(*)::int from public.domain_event
            where entity_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
              and event_type = 'visit.clock_out.completed'), 1,
  'outbox: a clock-out emits visit.clock_out.completed');

-- ══ THE CANARY: coordinates stop at the ledger row (D-030, invariant 5) ═══════════════
select is((select count(*)::int from public.visit_event where latitude = 39.2903117), 1,
  'canary setup: the distinctive latitude really is in the ledger (the canary is not vacuous)');
select is((select count(*)::int from audit.audit_event
            where payload::text like '%39.2903117%'), 0,
  'canary -: the clock latitude appears in ZERO audit payloads (D-030)');
select is((select count(*)::int from public.domain_event
            where payload::text like '%39.2903117%'), 0,
  'canary -: the clock latitude appears in ZERO outbox payloads (D-030)');
select is((select count(*)::int from audit.audit_event where payload::text like '%39.290%'), 0,
  'canary -: no latitude of any precision reaches the audit chain');
select is((select count(*)::int from public.domain_event where payload::text like '%39.290%'), 0,
  'canary -: no latitude of any precision reaches the outbox');
select is((select count(*)::int from audit.audit_event where payload::text like '%-76.61%'), 0,
  'canary -: no longitude reaches the audit chain');
select is((select count(*)::int from public.domain_event where payload::text like '%-76.61%'), 0,
  'canary -: no longitude reaches the outbox');
-- The emitter itself is 0045's (this migration deliberately does not re-own it); what
-- 0046 owns is that location_status is populated for it to carry, and that nothing the
-- clock engine writes widens the payload. event_type is borne by the audit ACTION.
select ok((select payload ? 'visit_id' and payload ? 'location_status'
                  and payload ? 'method' and payload ? 'capture_source'
                  and not (payload ? 'latitude') and not (payload ? 'longitude')
                  and not (payload ? 'distance_m') and not (payload ? 'note')
             from audit.audit_event
            where action = 'visit.clock_in' order by id limit 1),
  'audit +: the clock payload is ids + enums only — never a point, a metre or a note');
select is((select payload ->> 'location_status' from audit.audit_event
            where action = 'visit.clock_in' order by id limit 1), 'verified',
  'audit +: the engine''s verdict reaches the audit chain (a surveyor can answer "why")');
select ok((select count(*) from public.domain_event
            where entity_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
              and payload ? 'distance_m') = 0,
  'canary -: no coordinate-derived distance reaches the outbox either (D-030)');

-- ══ Sequence guards ═══════════════════════════════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select lives_ok(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e006', 'clock_in',
                           39.2900500, -76.612000, 8.0)$$,
  'clock +: e006 opens a shift');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e006', 'clock_in',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_ALREADY_CLOCKED_IN%',
  'clock -: a second clock-in on an open visit raises CAREOS_ALREADY_CLOCKED_IN');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e002', 'clock_out',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_NOT_CLOCKED_IN%',
  'clock -: clocking out with no open clock-in raises CAREOS_NOT_CLOCKED_IN');

-- ══ Out of the fence: soft refusal, then the reasoned exception ═══════════════════════
insert into t_clock select 'e002_far',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e002', 'clock_in',
                  39.3204119, -76.612000, 8.0);
select is((select v ->> 'location_status' from t_clock where k = 'e002_far'), 'outside_geofence',
  'clock -: a fix 3.4 km from the pin is outside_geofence');
select is((select v ->> 'needs_reason' from t_clock where k = 'e002_far'), 'true',
  'clock -: policy allows an exception and no reason was given — the caregiver is asked');
select is((select v ->> 'ok' from t_clock where k = 'e002_far'), 'false',
  'clock -: a refused attempt is not ok');
select is((select v ->> 'distance_bucket' from t_clock where k = 'e002_far'), 'far',
  'clock -: beyond 3x the radius the caller is told ''far'' (never 3376 m)');
select is((select v ->> 'status' from t_clock where k = 'e002_far'), 'scheduled',
  'clock -: a refused attempt does not start the visit');

reset role;
select is((select event_type from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'), 'clock_in_rejected',
  'ledger: the refused attempt IS recorded, as clock_in_rejected');
select is((select verification_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e002'), 'pending',
  'visit: a refused attempt leaves verification_status pending (nothing was verified)');
select ok((select service_location_version_id from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e002') is null,
  'visit: a refused attempt binds nothing — binding is an act of the accepted clock');
select is((select count(*)::int from public.domain_event
            where entity_id = 'aaaaaaaa-0000-0000-0000-00000000e002'
              and event_type like 'visit.clock%'), 0,
  'outbox -: a retry emits no clock event — nothing downstream happened');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e002_reason',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e002', 'clock_in',
                  39.3204119, -76.612000, 8.0,
                  p_reason_code => 'alternate_location',
                  p_note => 'client was at her daughter''s house');
select is((select v ->> 'ok' from t_clock where k = 'e002_reason'), 'true',
  'clock +: with a reason code the out-of-fence clock-in is accepted');
select is((select v ->> 'status' from t_clock where k = 'e002_reason'), 'in_progress',
  'clock +: the reasoned clock-in starts the visit — care is never blocked on geography');
select is((select v ->> 'verification_status' from t_clock where k = 'e002_reason'), 'exception',
  'clock +: an accepted unverified clock projects verification_status = exception');

reset role;
select is((select count(*)::int from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'
              and event_type = 'clock_in'), 1,
  'ledger: a rejected row never blocked the retry — the accepted clock_in is appended');
select is((select reason_code from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'
              and event_type = 'clock_in'), 'alternate_location',
  'ledger: the accepted event carries the caregiver''s reason code');
select is((select count(*)::int from public.domain_event
            where entity_id = 'aaaaaaaa-0000-0000-0000-00000000e002'
              and event_type = 'visit.clock_in.exception'), 1,
  'outbox: the reasoned clock-in emits visit.clock_in.exception');
select is((select count(*)::int from audit.audit_event where payload::text like '%daughter%'), 0,
  'canary -: the caregiver''s free-text note never reaches the audit chain (invariant 5)');
select is((select count(*)::int from public.domain_event where payload::text like '%daughter%'), 0,
  'canary -: the caregiver''s free-text note never reaches the outbox (invariant 5)');

-- ══ Idempotent replay: the PWA queue is safe by construction (D-022, §7.6) ════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e003_first',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e003', 'clock_in',
                  39.2900500, -76.612000, 8.0,
                  p_client_event_id => 'queued-event-0001',
                  p_captured_at => now() - interval '3 hours',   -- device time, offline
                  p_offline => true);
insert into t_clock select 'e003_replay',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e003', 'clock_in',
                  39.9999999, -76.999999, 4000.0,     -- a wildly different second capture
                  p_client_event_id => 'queued-event-0001');
select is((select v ->> 'replayed' from t_clock where k = 'e003_replay'), 'true',
  'replay +: the same client_event_id returns the stored event, flagged replayed');
select is((select v ->> 'event_id' from t_clock where k = 'e003_replay'),
          (select v ->> 'event_id' from t_clock where k = 'e003_first'),
  'replay +: the replay returns the ORIGINAL event id, not a new one');
select is((select v ->> 'location_status' from t_clock where k = 'e003_replay'), 'verified',
  'replay +: the replay reports what was decided at capture time, not what was resent');
select is((select v ->> 'distance_bucket' from t_clock where k = 'e003_replay'), 'inside',
  'replay +: the bucket is recomputed from the BOUND radius, not from today''s config');

reset role;
select is((select count(*)::int from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e003'), 1,
  'replay: exactly one row exists — a replay is never a second clock event');
select is((select count(*)::int from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e003'
              and capture_source = 'offline' and is_offline), 1,
  'replay: the queued event is flagged offline, never presented as ordinarily verified');
select is((select count(*)::int from public.visit_event where latitude = 39.9999999), 0,
  'replay -: the resent coordinates were discarded — the first capture is the record');
-- Server time is authoritative (§3.6): a phone with a wrong clock must never move money.
select ok((select occurred_at from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e003')
          > now() - interval '1 minute',
  'server time: occurred_at is the SERVER''s clock, never the device''s (§3.6)');
select ok((select client_captured_at from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e003')
          < now() - interval '2 hours',
  'server time: the device''s claimed time is kept beside it as drift evidence, not used');

-- ══ Replaying a REFUSED attempt returns the refusal, not a fresh decision ═════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e010_reject',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e010', 'clock_in',
                  39.3204119, -76.612000, 8.0,
                  p_client_event_id => 'queued-event-0002');
insert into t_clock select 'e010_replay',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e010', 'clock_in',
                  39.3204119, -76.612000, 8.0,
                  p_client_event_id => 'queued-event-0002');
select is((select v ->> 'replayed' from t_clock where k = 'e010_replay'), 'true',
  'replay +: a refused attempt replays too — the queue does not distinguish outcomes');
select is((select v ->> 'ok' from t_clock where k = 'e010_replay'), 'false',
  'replay +: replaying a refusal is still a refusal');
select is((select v ->> 'needs_reason' from t_clock where k = 'e010_replay'), 'true',
  'replay +: the caregiver is still asked for a reason, not silently clocked in');
select is((select v ->> 'distance_bucket' from t_clock where k = 'e010_replay'), 'far',
  'replay +: the bucket survives the replay (D-030 buckets, never metres)');
reset role;
select is((select count(*)::int from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e010'), 1,
  'replay: a replayed refusal appends no second rejected row either');

-- ══ Low accuracy inside the fence: a fuzzy fix verifies nothing ═══════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e004_fuzzy',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e004', 'clock_in',
                  39.2900500, -76.612000, 900.0);
select is((select v ->> 'location_status' from t_clock where k = 'e004_fuzzy'), 'low_accuracy',
  'clock -: a 900 m accuracy circle centred on the pin is low_accuracy, not verified');
select is((select v ->> 'distance_bucket' from t_clock where k = 'e004_fuzzy'), 'inside',
  'clock -: the bucket still reports ''inside'' — accuracy and distance are separate facts');
select is((select v ->> 'needs_reason' from t_clock where k = 'e004_fuzzy'), 'true',
  'clock -: low accuracy asks the caregiver for a reason');

-- ══ No geocode on file: unavailable, and care still happens (DN-0046b) ════════════════
insert into t_clock select 'e005_nogeo',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e005', 'clock_in',
                  39.2900500, -76.612000, 8.0);
select is((select v ->> 'location_status' from t_clock where k = 'e005_nogeo'), 'unavailable',
  'clock -: a client with no service location yields unavailable, never an error');
select ok((select v ->> 'distance_bucket' from t_clock where k = 'e005_nogeo') is null,
  'clock -: with nothing to measure against the bucket is null');
-- The caregiver is NOT asked to justify a record they cannot see or edit. A missing
-- service location is an agency configuration gap, so the clock stands on the FIRST
-- attempt with no reason code at all, and the visit starts.
select is((select v ->> 'status' from t_clock where k = 'e005_nogeo'), 'in_progress',
  'clock +: missing config never blocks care — the visit starts with no reason asked');
select is((select v ->> 'needs_reason' from t_clock where k = 'e005_nogeo'), 'false',
  'clock +: a config gap the caregiver cannot fix never demands a reason from them');
-- But the record stays honest: unverified is unverified, and a coordinator who CAN fix it
-- sees it in the exception queue.
select is((select verification_status from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e005'),
  'exception',
  'clock +: care proceeded, and the visit is still flagged for the coordinator who can fix it');
-- Proof the first attempt genuinely opened the visit rather than being a soft refusal.
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e005', 'clock_in',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_ALREADY_CLOCKED_IN%',
  'clock -: the config-gap clock-in really opened the visit — a second clock-in is refused');

-- ══ A named place with no geography is NOT silently swapped for the home (DN-0046b) ═══
-- e008 is scheduled at the respite address, which nobody has geocoded. The client's HOME
-- is geocoded and the caregiver is standing on its pin. A best-effort fallback would call
-- this 'verified' against an address the scheduler did not choose; a fallback the other
-- way would manufacture an outside_geofence exception with a caregiver's name on it.
insert into t_clock select 'e008_named',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e008', 'clock_in',
                  39.2900500, -76.612000, 8.0);
select is((select v ->> 'location_status' from t_clock where k = 'e008_named'), 'unavailable',
  'clock -: a named-but-ungeocoded place of care is unavailable, not measured against another');
select ok((select v ->> 'distance_bucket' from t_clock where k = 'e008_named') is null,
  'clock -: no substitute address means no distance and no bucket');
reset role;
select ok((select service_location_version_id from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e008') is null,
  'ledger: the event binds no version — there was none to bind (honest silence)');
select is((select service_location_id from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e008'),
  'aaaaaaaa-0000-0000-0000-000000005102'::uuid,
  'visit: the scheduler''s chosen location is never rewritten to the client''s primary');

-- ══ The bound version survives an address revision (DN-0046a, D-014) ══════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e009_in',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e009', 'clock_in',
                  39.2900500, -76.612000, 8.0);
select is((select v ->> 'location_status' from t_clock where k = 'e009_in'), 'verified',
  'clock +: e009 clocks in against version 1 of the home address');

-- The office corrects the address mid-visit. A new VERSION appears and becomes current;
-- the old one is untouched, because service_location_version is append-only.
reset role;
insert into public.service_location_version
  (id, tenant_id, service_location_id, version_no, original_address, normalized_address,
   geo, geo_precision, geo_source, verification, verified_by, verified_at,
   supersedes_id, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000005a02', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000005101', 2, '9 Far Road', '9 FAR RD',
   app.geo_point(39.360000, -76.612000), 'rooftop', 'manual', 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now(),
   'aaaaaaaa-0000-0000-0000-000000005a01', 'aaaaaaaa-0000-0000-0000-0000000000ad');
update public.service_location
   set current_version_id = 'aaaaaaaa-0000-0000-0000-000000005a02'
 where id = 'aaaaaaaa-0000-0000-0000-000000005101';

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e009_out',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e009', 'clock_out',
                  39.2900500, -76.612000, 8.0);
select is((select v ->> 'location_status' from t_clock where k = 'e009_out'), 'verified',
  'clock +: the clock-out is judged against the BOUND version, so it is still verified');
reset role;
select is((select service_location_version_id from public.visit_event
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e009'
              and event_type = 'clock_out'),
  'aaaaaaaa-0000-0000-0000-000000005a01'::uuid,
  'ledger: revising an address cannot rewrite a visit already in flight (D-014)');
select is((select service_location_version_id from public.visit
            where id = 'aaaaaaaa-0000-0000-0000-00000000e009'),
  'aaaaaaaa-0000-0000-0000-000000005a01'::uuid,
  'visit: the binding is written once and never re-resolved (DN-0046a)');
-- Put the current version back so nothing after this point inherits the moved address.
update public.service_location
   set current_version_id = 'aaaaaaaa-0000-0000-0000-000000005a01'
 where id = 'aaaaaaaa-0000-0000-0000-000000005101';

-- ══ Near bucket: close, but not at the door ═══════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'e007_near',
  app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'clock_in',
                  39.2935000, -76.612000, 8.0,
                  p_reason_code => 'gps_unavailable');
select is((select v ->> 'distance_bucket' from t_clock where k = 'e007_near'), 'near',
  'clock: within 3x the radius the caller is told ''near'' (D-030 buckets, never metres)');
select is((select v ->> 'location_status' from t_clock where k = 'e007_near'), 'outside_geofence',
  'clock: ''near'' is a helpfulness hint, not a verdict — the status is still outside_geofence');

-- ══ An unconfigured tenant still clocks in (DN-0046f) ═════════════════════════════════
-- Tenant C has no visit_policy row. An agency mid-onboarding must not have a workforce
-- that cannot clock in; the engine falls back to the docs/17 §3.4 documented floor and
-- records the absence honestly rather than inventing a policy row.
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');
insert into t_clock select 'c001_floor',
  app.clock_visit('cccccccc-0000-0000-0000-00000000e001', 'clock_in',
                  39.2900500, -76.612000, 8.0);
select is((select v ->> 'location_status' from t_clock where k = 'c001_floor'), 'verified',
  'clock +: a tenant with no policy is judged against the §3.4 floor, not refused');
select is((select v ->> 'status' from t_clock where k = 'c001_floor'), 'in_progress',
  'clock +: an unconfigured agency''s caregiver still starts their visit (DN-0046f)');
reset role;
select ok(
  ((select count(*)::int from public.visit_policy
     where tenant_id = 'cccccccc-0000-0000-0000-000000000001') = 0)
  is not distinct from
  ((select policy_id from public.visit_event
     where visit_id = 'cccccccc-0000-0000-0000-00000000e001') is null),
  'ledger: policy_id is NULL exactly when no policy existed — the degradation is recorded');

-- ══ Hard refusal: a policy that forbids exceptions (DN-0046d) ═════════════════════════
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.clock_visit('bbbbbbbb-0000-0000-0000-00000000e001', 'clock_in',
                           39.3204119, -76.612000, 8.0)$$,
  '%CAREOS_GEOFENCE_UNVERIFIED%',
  'clock -: a policy forbidding exceptions refuses an out-of-fence clock-in outright');
reset role;
select is((select count(*)::int from public.visit_event
            where visit_id = 'bbbbbbbb-0000-0000-0000-00000000e001'), 0,
  'clock -: the hard refusal writes nothing — the raise would roll an append back anyway');
select is((select status from public.visit where id = 'bbbbbbbb-0000-0000-0000-00000000e001'),
  'scheduled', 'clock -: the refused tenant-B visit never started');

-- ══ Authorisation and tenancy refusals ════════════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select throws_ok(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'clock_in',
                           39.2900500, -76.612000, 8.0)$$,
  '42501', null,
  'clock -: a caregiver not assigned to the visit cannot clock it (errcode 42501)');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'clock_in',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_FORBIDDEN%',
  'clock -: the refusal names CAREOS_FORBIDDEN (docs/08 §2 error contract)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select throws_ok(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'clock_out',
                           39.2900500, -76.612000, 8.0)$$,
  '42501', null,
  'clock -: an AAL1 session cannot clock a visit (invariant 3)');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'clock_out',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_AAL2_REQUIRED%',
  'clock -: the AAL1 refusal names CAREOS_AAL2_REQUIRED, before any row is read');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'clock_out',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_NOT_FOUND%',
  'clock -: a tenant-B caregiver cannot see, let alone clock, a tenant-A visit (isolation)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e007', 'lunch_break',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_BAD_EVENT%', 'clock -: an unknown event name raises CAREOS_BAD_EVENT');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-00000000e004', 'clock_in',
                           39.3204119, -76.612000, 8.0,
                           p_reason_code => 'because_i_said_so')$$,
  '%CAREOS_BAD_REASON_CODE%',
  'clock -: an unknown reason code raises CAREOS_BAD_REASON_CODE before anything is written');
select throws_like(
  $$select app.clock_visit('aaaaaaaa-0000-0000-0000-0000000000ff', 'clock_in',
                           39.2900500, -76.612000, 8.0)$$,
  '%CAREOS_NOT_FOUND%', 'clock -: an unknown visit id raises CAREOS_NOT_FOUND');

-- ══ visit_event read scoping (the ledger the RPC now writes far more into) ════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select ok((select count(*) from public.visit_event) > 0,
  'visit_event +: the clocking caregiver sees their own events');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.visit_event), 0,
  'visit_event -: an unrelated caregiver sees nothing');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select is((select count(*)::int from public.visit_event), 0,
  'visit_event -: schedule.read at AAL1 sees nothing (PHI needs AAL2, invariant 3)');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select ok((select count(*) from public.visit_event) > 0,
  'visit_event +: schedule.read at AAL2 sees the tenant''s clock ledger');
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_event), 0,
  'visit_event -: a tenant-B admin sees no tenant-A events (tenant isolation)');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_event), 0,
  'visit_event -: a tenant-C admin without schedule.read sees nothing (least privilege)');

-- ══ Append-only, both layers ══════════════════════════════════════════════════════════
reset role;
select throws_like($$update public.visit_event set note = 'x'$$, '%CAREOS_APPEND_ONLY%',
  'visit_event: UPDATE raises CAREOS_APPEND_ONLY even as superuser (invariant 1)');
select throws_like($$delete from public.visit_event$$, '%CAREOS_APPEND_ONLY%',
  'visit_event: DELETE raises CAREOS_APPEND_ONLY even as superuser (invariant 1)');

reset role;
select * from finish();
rollback;
