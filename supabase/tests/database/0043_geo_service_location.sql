-- pgTAP · 0043 geo + service locations: the address normaliser is deterministic, the
-- geo primitives refuse garbage, service_location is PHI behind AAL2 with three lawful
-- readers, service_location_version is append-only at BOTH layers, the four §6.1 RPCs
-- are the only write path and refuse every way they can be misused, and no coordinate
-- ever reaches the audit or outbox ledgers.
-- Style mirrors 0011_scheduling.sql / 0027_domain_event_outbox.sql.
-- @trace: ST-201, D-025, D-030, docs/17 §3.1, §3.2, §3.3, §4.1, §6.1
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ───────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'loc.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'loc.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'loc.cg2.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'loc.cg3.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'loc.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Loc Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Loc Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Loc Admin A', 'loc.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Loc Caregiver A1', 'loc.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Loc Caregiver A2', 'loc.cg2.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Loc Caregiver A3', 'loc.cg3.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Loc Admin B', 'loc.admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('location.manage', 'test'), ('schedule.read', 'test'), ('schedule.write', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'loc_admin', 'Loc Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'loc_admin', 'Loc Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'location.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.write'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'location.manage'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.write');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Loc', 'ClientA'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Loc', 'ClientB');

-- A1 is on client A's care team. A2 is NOT — A2 is only the caregiver assigned to a
-- visit for that client, which is the third lawful reader in §3.2. A3 is neither.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');
insert into public.visit (id, tenant_id, client_id, caregiver_id,
                          scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now(), now() + interval '2 hours');

insert into public.service_type (id, tenant_id, code, name, evv_required, payer_kind) values
  ('aaaaaaaa-0000-0000-0000-000000005201', 'aaaaaaaa-0000-0000-0000-000000000001',
   'PCA', 'Personal Care Aide', true, 'medicaid'),
  ('bbbbbbbb-0000-0000-0000-000000005201', 'bbbbbbbb-0000-0000-0000-000000000001',
   'PCA', 'Personal Care Aide', false, 'private');

-- One located place per tenant. Tenant B's exists solely so the isolation probes prove
-- "sees their own and only their own" rather than the weaker "sees nothing".
-- Inserted as postgres (no JWT) ⇒ audit/outbox triggers no-op, no chain fork.
insert into public.service_location
  (id, tenant_id, client_id, kind, label, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'primary_residence', 'Home',
   'aaaaaaaa-0000-0000-0000-0000000000ad'),
  ('bbbbbbbb-0000-0000-0000-000000005001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', 'primary_residence', 'Home B',
   'bbbbbbbb-0000-0000-0000-0000000000ad');
insert into public.service_location_version
  (id, tenant_id, service_location_id, created_by, version_no,
   original_address, normalized_address, address_line1, city, state, postal_code) values
  ('aaaaaaaa-0000-0000-0000-000000005101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000005001', 'aaaaaaaa-0000-0000-0000-0000000000ad', 1,
   '8 Fixture Ln, Rockville, MD 20850',
   app.normalize_address('8 Fixture Ln', null, 'Rockville', 'MD', '20850'),
   '8 Fixture Ln', 'Rockville', 'MD', '20850'),
  ('bbbbbbbb-0000-0000-0000-000000005101', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000005001', 'bbbbbbbb-0000-0000-0000-0000000000ad', 1,
   '3 Brookmead Way, Bowie, MD 20715',
   app.normalize_address('3 Brookmead Way', null, 'Bowie', 'MD', '20715'),
   '3 Brookmead Way', 'Bowie', 'MD', '20715');
update public.service_location
   set current_version_id = 'aaaaaaaa-0000-0000-0000-000000005101'
 where id = 'aaaaaaaa-0000-0000-0000-000000005001';
update public.service_location
   set current_version_id = 'bbbbbbbb-0000-0000-0000-000000005101'
 where id = 'bbbbbbbb-0000-0000-0000-000000005001';

-- Session simulator (identical to 002/003/0011).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ §4.1 · Geo primitives — deterministic, and refusing garbage ═══════════
-- Two spellings of one address must converge, or dedupe is theatre.
select is(
  app.normalize_address('1600 N. Main St.', 'Apt #2', 'Silver Spring', 'MD', '20910', 'US'),
  '1600 N MAIN ST APT 2 SILVER SPRING MD 20910 US',
  'normalize_address +: punctuation is stripped and whitespace collapsed');
select is(
  app.normalize_address('1600 North Main Street', 'Apartment 2', 'Silver Spring',
                        'MD', '20910', 'US'),
  app.normalize_address('1600 N. Main St.', 'Apt #2', 'Silver Spring', 'MD', '20910', 'US'),
  'normalize_address +: the long and short spellings of one address converge');
select is(
  app.normalize_address('123 North Avenue', null, 'Baltimore', 'MD', '21201'),
  '123 N AVE BALTIMORE MD 21201 US',
  'normalize_address +: NORTH AVENUE folds to N AVE (directional then suffix)');
select is(
  app.normalize_address('88 Willow Terrace', 'Suite 4', 'Bowie', 'MD', '20715'),
  '88 WILLOW TER STE 4 BOWIE MD 20715 US',
  'normalize_address +: TERRACE and SUITE fold to TER and STE');
select is(
  app.normalize_address('50 Southwest Parkway', null, 'Frederick', 'MD', '21701'),
  '50 SW PKWY FREDERICK MD 21701 US',
  'normalize_address +: SOUTHWEST folds to SW, not to S + WEST');
select is(
  app.normalize_address('7 Elm Ct', null, 'Westminster', 'MD', '21157'),
  '7 ELM CT WESTMINSTER MD 21157 US',
  'normalize_address +: WESTMINSTER survives intact (folds are whole-word only)');
select is(
  app.normalize_address(
    app.normalize_address('1600 N. Main St.', 'Apt #2', 'Silver Spring', 'MD', '20910', 'US'),
    null, null, null, null, ''),
  app.normalize_address('1600 N. Main St.', 'Apt #2', 'Silver Spring', 'MD', '20910', 'US'),
  'normalize_address +: normalising a normalised address is a no-op (idempotent)');
select is(
  app.normalize_address(null, null, null, null, null, ''),
  null,
  'normalize_address -: an address with no components at all is null, not a blank string');
select is(
  app.normalize_address(null, null, null, null, null, null),
  'US',
  'normalize_address +: a null country still folds to the US default (the parameter default)');
-- Declared IMMUTABLE and immutable in fact: the planner is allowed to believe this the
-- day someone indexes normalized_address, so the declaration must not be a lie.
select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'normalize_address'),
  'i'::"char", 'normalize_address +: the function is declared IMMUTABLE');

select ok(app.geo_point(39.0, -77.0) is not null,
  'geo_point +: a Maryland coordinate yields a point');
select ok(
  abs(extensions.ST_Y(app.geo_point(39.0, -77.0)::extensions.geometry) - 39.0) < 1e-9
  and abs(extensions.ST_X(app.geo_point(39.0, -77.0)::extensions.geometry) + 77.0) < 1e-9,
  'geo_point +: latitude lands on Y and longitude on X (the x/y swap is caught)');
select ok(app.geo_point(91.0, -77.0) is null,
  'geo_point -: a latitude past the pole is not a point');
select ok(app.geo_point(39.0, -181.0) is null,
  'geo_point -: a longitude past the antimeridian is not a point');
select ok(app.geo_point(null, -77.0) is null,
  'geo_point -: a missing latitude is not a point');

select ok(
  app.distance_m(app.geo_point(39.0, -77.0), 39.001, -77.0) between 100 and 125,
  'distance_m +: 0.001 degrees of latitude is ~111 metres on the spheroid');
select ok(app.distance_m(null, 39.0, -77.0) is null,
  'distance_m -: no stored point means no distance (null, not zero)');
select ok(app.distance_m(app.geo_point(39.0, -77.0), null, null) is null,
  'distance_m -: no captured reading means no distance (null, not zero)');

-- Internal plumbing: definer bodies call these, clients never do (0007 posture).
select ok(not has_function_privilege('authenticated',
  'app.normalize_address(text,text,text,text,text,text)', 'execute'),
  'geo -: authenticated cannot call app.normalize_address directly');
select ok(not has_function_privilege('authenticated',
  'app.geo_point(double precision,double precision)', 'execute'),
  'geo -: authenticated cannot call app.geo_point directly');
select ok(not has_function_privilege('authenticated',
  'app.distance_m(extensions.geography,double precision,double precision)', 'execute'),
  'geo -: authenticated cannot call app.distance_m directly');

-- ═══ Invariant: RLS enabled AND forced on every new table ══════════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('service_type','service_location','service_location_version')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS is enabled + forced on service_type, service_location and service_location_version');

-- ═══ §3.1 · service_type — a catalog every member reads, schedulers author ═
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.service_type), 1,
  'service_type +: a plain tenant member with no permissions reads the catalog');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal1');
select is((select count(*)::int from public.service_type), 1,
  'service_type +: a catalog is not PHI — AAL1 still reads it (classification is CFG)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select throws_ok(
  $$insert into public.service_type (tenant_id, code, name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'RN_SUPERVISORY', 'RN Supervisory')$$,
  '42501', null,
  'service_type -: a member without schedule.write cannot author a catalog row');
-- An UPDATE the policy refuses is filtered, not raised (the USING clause removes the
-- row) — so the honest assertion is "no error, and nothing changed".
select lives_ok(
  $$update public.service_type set name = 'Tampered' where code = 'PCA'$$,
  'service_type -: a member without schedule.write updates zero rows (RLS filters)');
reset role;
select is((select count(*)::int from public.service_type where name = 'Tampered'), 0,
  'service_type -: … and the catalog row was not actually changed');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$insert into public.service_type (tenant_id, code, name, payer_kind)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'COMPANION', 'Companion', 'private')$$,
  'service_type +: schedule.write authors a catalog row');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.service_type
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'service_type -: tenant-B admin sees no tenant-A catalog row (tenant isolation)');

-- ═══ §3.2 · service_location — PHI, AAL2, three lawful readers ═════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.service_location), 1,
  'service_location +: location.manage sees the client''s place of care');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.service_location), 1,
  'service_location +: a care-team caregiver sees it');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.service_location), 1,
  'service_location +: the caregiver assigned to a visit for this client sees it');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.service_location), 0,
  'service_location -: a caregiver with no care team and no visit sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.service_location), 0,
  'service_location -: the same care-team caregiver at AAL1 sees nothing (invariant 3)');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.service_location
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'service_location -: tenant-B admin sees no tenant-A location (tenant isolation)');
select is((select count(*)::int from public.service_location), 1,
  'service_location +: tenant-B admin sees exactly their own tenant''s location');

-- ═══ §3.3 · service_location_version — read follows the parent ═════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.service_location_version), 1,
  'service_location_version +: a care-team caregiver sees the parent''s version');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.service_location_version), 1,
  'service_location_version +: the assigned caregiver sees it (follows the parent)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.service_location_version), 0,
  'service_location_version -: a caregiver who cannot see the parent sees no version');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.service_location_version), 0,
  'service_location_version -: AAL1 sees nothing (PHI by linkage)');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.service_location_version
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'service_location_version -: tenant-B admin sees no tenant-A version (isolation)');

-- ═══ Append-only: trigger layer (even the superuser) + privilege layer ═════
reset role;
select throws_like(
  $$update public.service_location_version set city = 'Tampered'$$,
  '%CAREOS_APPEND_ONLY%',
  'service_location_version UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.service_location_version$$,
  '%CAREOS_APPEND_ONLY%',
  'service_location_version DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.service_location_version', 'update'),
  'service_location_version -: authenticated has no UPDATE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.service_location_version', 'delete'),
  'service_location_version -: authenticated has no DELETE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.service_location_version', 'insert'),
  'service_location_version -: authenticated has no INSERT grant (version_no is server-assigned)');
select ok(has_table_privilege('authenticated', 'public.service_location_version', 'select'),
  'service_location_version +: authenticated may read (RLS decides which rows)');

-- Lane-B perimeter on the parent: reads only, RPCs write.
select ok(not has_table_privilege('authenticated', 'public.service_location', 'insert'),
  'lane-b -: authenticated has no INSERT grant on service_location');
select ok(not has_table_privilege('authenticated', 'public.service_location', 'update'),
  'lane-b -: authenticated has no UPDATE grant on service_location');
select ok(not has_table_privilege('authenticated', 'public.service_location', 'delete'),
  'lane-b -: authenticated has no DELETE grant on service_location');

-- … and the perimeter refuses loudly, not just on paper (the 0011/0023 idiom).
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_ok(
  $$insert into public.service_location (tenant_id, client_id, kind, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000c001', 'primary_residence',
            'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  '42501', null,
  'lane-b -: even location.manage cannot insert a service location directly');
select throws_ok(
  $$insert into public.service_location_version
      (tenant_id, service_location_id, created_by, version_no,
       original_address, normalized_address)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000005001',
            'aaaaaaaa-0000-0000-0000-0000000000ad', 42, '9 Forged Rd', '9 FORGED RD')$$,
  '42501', null,
  'lane-b -: even location.manage cannot append a version directly');

-- D-025 made structural: 'verified' without a named human is unrepresentable.
reset role;
select throws_ok(
  $$insert into public.service_location_version
      (tenant_id, service_location_id, created_by, version_no,
       original_address, normalized_address, verification)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000005001',
            'aaaaaaaa-0000-0000-0000-0000000000ad', 99,
            '9 Forged Rd', '9 FORGED RD', 'verified')$$,
  '23514', null,
  'chk_slv_verified_needs_human -: a verified version with no attester is refused');

-- ═══ §6.1 · The four RPCs — callable by users, never by anon ═══════════════
select ok(has_function_privilege('authenticated',
  'app.create_service_location(uuid,text,text,jsonb,boolean)', 'execute'),
  'rpc +: authenticated can call app.create_service_location');
select ok(has_function_privilege('authenticated',
  'app.revise_service_location(uuid,jsonb,text)', 'execute'),
  'rpc +: authenticated can call app.revise_service_location');
select ok(has_function_privilege('authenticated',
  'app.verify_service_location(uuid,double precision,double precision,text,text)', 'execute'),
  'rpc +: authenticated can call app.verify_service_location');
select ok(has_function_privilege('authenticated',
  'app.set_service_location_geofence(uuid,integer,text)', 'execute'),
  'rpc +: authenticated can call app.set_service_location_geofence');
select ok(not has_function_privilege('anon',
  'app.create_service_location(uuid,text,text,jsonb,boolean)', 'execute'),
  'rpc -: anon cannot call app.create_service_location');
select ok(not has_function_privilege('anon',
  'app.verify_service_location(uuid,double precision,double precision,text,text)', 'execute'),
  'rpc -: anon cannot call app.verify_service_location');

-- ── create: the gate ──────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.create_service_location('aaaaaaaa-0000-0000-0000-00000000c001',
      'primary_residence', 'PROBE-DENIED',
      '{"line1":"1 Denied Way","city":"Rockville","state":"MD","postal_code":"20850"}')$$,
  '%CAREOS_FORBIDDEN%',
  'create -: a care-team caregiver without location.manage is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.create_service_location('aaaaaaaa-0000-0000-0000-00000000c001',
      'primary_residence', 'PROBE-DENIED',
      '{"line1":"1 Denied Way","city":"Rockville","state":"MD","postal_code":"20850"}')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'create -: location.manage at AAL1 is refused (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.create_service_location('bbbbbbbb-0000-0000-0000-00000000c001',
      'primary_residence', 'PROBE-DENIED',
      '{"line1":"1 Denied Way","city":"Rockville","state":"MD","postal_code":"20850"}')$$,
  '%CAREOS_NOT_FOUND%',
  'create -: a cross-tenant client cannot be given a location');
select throws_like(
  $$select app.create_service_location('aaaaaaaa-0000-0000-0000-00000000c001',
      'garage', 'PROBE-DENIED',
      '{"line1":"1 Denied Way","city":"Rockville","state":"MD","postal_code":"20850"}')$$,
  '%CAREOS_BAD_KIND%',
  'create -: an unknown location kind is refused');
select throws_like(
  $$select app.create_service_location('aaaaaaaa-0000-0000-0000-00000000c001',
      'primary_residence', 'PROBE-DENIED',
      '{"city":"Rockville","state":"MD","postal_code":"20850"}')$$,
  '%CAREOS_BAD_ADDRESS%',
  'create -: an address with no street line is refused');

-- ── create: the happy path ────────────────────────────────────────────────
select lives_ok(
  $$select app.create_service_location('aaaaaaaa-0000-0000-0000-00000000c001',
      'primary_residence', 'PROBE-L1',
      '{"line1":"4200 North Ridge Avenue","line2":"Apartment 3",
        "city":"Silver Spring","state":"MD","postal_code":"20910"}',
      true)$$,
  'create +: location.manage creates a place of care at version 1');

reset role;
select is(
  (select v.version_no from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  1, 'create +: the first version is version 1 (server-assigned)');
select is(
  (select v.normalized_address from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  '4200 N RIDGE AVE APT 3 SILVER SPRING MD 20910 US',
  'create +: the version stores the deterministically normalised address');
select is(
  (select v.original_address from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  '4200 North Ridge Avenue, Apartment 3, Silver Spring, MD 20910, US',
  'create +: the version also keeps the address exactly as entered');
select is(
  (select v.verification from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  'unverified',
  'create +: version 1 is unverified and unlocated — a human pins it later (D-025)');
select ok(
  (select v.geo is null from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  'create +: version 1 carries no geocode (no vendor guessed one)');
select is(
  (select l.current_version_id from public.service_location l where l.label = 'PROBE-L1'),
  (select v.id from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  'create +: the location is bound to its current version');

-- One live primary per client: the incumbent is demoted, never duplicated.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.create_service_location('aaaaaaaa-0000-0000-0000-00000000c001',
      'family_residence', 'PROBE-L2',
      '{"line1":"9 Daughter Ct","city":"Rockville","state":"MD","postal_code":"20850"}',
      true)$$,
  'create +: a second primary location is accepted');
reset role;
select is(
  (select count(*)::int from public.service_location
    where client_id = 'aaaaaaaa-0000-0000-0000-00000000c001' and is_primary and active),
  1, 'create +: exactly one live primary remains (the incumbent was demoted)');
select is(
  (select label from public.service_location
    where client_id = 'aaaaaaaa-0000-0000-0000-00000000c001' and is_primary and active),
  'PROBE-L2', 'create +: the newest primary is the one that holds the flag');

-- ── revise: every refusal, then a new version — never an edit ─────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.revise_service_location(
      (select id from public.service_location where label = 'PROBE-L1'),
      '{"line1":"4200 N Ridge Ave","city":"Silver Spring","state":"MD","postal_code":"20910"}',
      'probe')$$,
  '%CAREOS_FORBIDDEN%',
  'revise -: a caregiver without location.manage cannot revise an address');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.revise_service_location(
      (select id from public.service_location where label = 'PROBE-L1'),
      '{"line1":"4200 N Ridge Ave","city":"Silver Spring","state":"MD","postal_code":"20910"}',
      '  ')$$,
  '%CAREOS_REASON_REQUIRED%',
  'revise -: revising an address without a reason is refused');
select throws_like(
  $$select app.revise_service_location(
      (select id from public.service_location where label = 'PROBE-L1'),
      '{"city":"Silver Spring","state":"MD","postal_code":"20910"}', 'probe')$$,
  '%CAREOS_BAD_ADDRESS%',
  'revise -: an address with no street line is refused');
select throws_like(
  $$select app.revise_service_location('aaaaaaaa-0000-0000-0000-0000000059ff',
      '{"line1":"1 Nowhere Rd","city":"Rockville","state":"MD","postal_code":"20850"}',
      'probe')$$,
  '%CAREOS_NOT_FOUND%',
  'revise -: an unknown service location is not found');
select throws_like(
  $$select app.revise_service_location('bbbbbbbb-0000-0000-0000-000000005001',
      '{"line1":"1 Nowhere Rd","city":"Rockville","state":"MD","postal_code":"20850"}',
      'probe')$$,
  '%CAREOS_NOT_FOUND%',
  'revise -: a tenant-B location is invisible to a tenant-A administrator (isolation)');

select lives_ok(
  $$select app.revise_service_location(
      (select id from public.service_location where label = 'PROBE-L1'),
      '{"line1":"4200 North Ridge Avenue","line2":"Apartment 5",
        "city":"Silver Spring","state":"MD","postal_code":"20910"}',
      'unit corrected at intake')$$,
  'revise +: a corrected unit number appends version 2');

reset role;
select is(
  (select count(*)::int from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  2, 'revise +: both versions exist — the original was not rewritten');
select is(
  (select v.supersedes_id from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 2),
  (select v.id from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 1),
  'revise +: version 2 links back to what it supersedes');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select app.revise_service_location(
      (select id from public.service_location where label = 'PROBE-L1'),
      '{"line1":"4200 N. Ridge Ave.","line2":"Apt 5",
        "city":"Silver Spring","state":"MD","postal_code":"20910"}',
      'resubmitted from a flaky form') ->> 'unchanged'),
  'true',
  'revise +: the same place spelled differently is unchanged, not a new version');
reset role;
select is(
  (select count(*)::int from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  2, 'revise +: the idempotent replay created no third version');

-- ── verify: the human attestation ─────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.verify_service_location(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      39.2904, -77.1234, 'psychic')$$,
  '%CAREOS_BAD_PRECISION%',
  'verify -: an unknown geocode precision is refused');
select throws_like(
  $$select app.verify_service_location(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      999.0, -77.1234, 'rooftop')$$,
  '%CAREOS_BAD_COORDINATES%',
  'verify -: an out-of-range coordinate is refused, and never echoed back');
select throws_like(
  $$select app.verify_service_location('aaaaaaaa-0000-0000-0000-0000000059fe',
      39.2904, -77.1234, 'rooftop')$$,
  '%CAREOS_NOT_FOUND%',
  'verify -: an unknown version is not found');
select throws_like(
  $$select app.verify_service_location('bbbbbbbb-0000-0000-0000-000000005101',
      39.2904, -77.1234, 'rooftop')$$,
  '%CAREOS_NOT_FOUND%',
  'verify -: a tenant-B version is invisible to a tenant-A administrator (isolation)');
select throws_like(
  $$select app.verify_service_location(
      (select v.id from public.service_location_version v
         join public.service_location l on l.id = v.service_location_id
        where l.label = 'PROBE-L1' and v.version_no = 1),
      39.2904, -77.1234, 'rooftop')$$,
  '%CAREOS_STALE_VERSION%',
  'verify -: an attestation cannot be attached to a superseded version');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.verify_service_location(
      'aaaaaaaa-0000-0000-0000-000000005101', 39.2904, -77.1234, 'rooftop')$$,
  '%CAREOS_FORBIDDEN%',
  'verify -: a caregiver without location.manage cannot attest a geocode');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.verify_service_location(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      39.2904, -77.1234, 'rooftop', 'pin confirmed with the daughter at intake')$$,
  'verify +: location.manage pins the address and signs for it');

reset role;
select is(
  (select v.verification from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 3),
  'verified', 'verify +: the attestation appends version 3, verified');
select is(
  (select v.verified_by from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 3),
  'aaaaaaaa-0000-0000-0000-0000000000ad'::uuid,
  'verify +: the version names the human who attested it (D-025)');
select ok(
  (select v.geo is not null and v.verified_at is not null
     from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 3),
  'verify +: the verified version carries both a point and a time');
select is(
  (select v.verification from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 2),
  'unverified', 'verify +: the superseded version is untouched (append-only)');

-- ── geofence: a radius is part of the record a clock-in binds to ──────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.set_service_location_geofence(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      300, 'probe')$$,
  '%CAREOS_FORBIDDEN%',
  'geofence -: a caregiver without location.manage cannot widen a geofence');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.set_service_location_geofence(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      10, 'too tight')$$,
  '%CAREOS_BAD_RADIUS%',
  'geofence -: a radius below the 25 m floor is refused');
select throws_like(
  $$select app.set_service_location_geofence(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      9000, 'too wide')$$,
  '%CAREOS_BAD_RADIUS%',
  'geofence -: a radius above the 5000 m ceiling is refused');
select throws_like(
  $$select app.set_service_location_geofence(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      300, '')$$,
  '%CAREOS_REASON_REQUIRED%',
  'geofence -: changing a geofence without a reason is refused');
select throws_like(
  $$select app.set_service_location_geofence('aaaaaaaa-0000-0000-0000-0000000059fd',
      300, 'probe')$$,
  '%CAREOS_NOT_FOUND%',
  'geofence -: an unknown version is not found');
select throws_like(
  $$select app.set_service_location_geofence(
      (select v.id from public.service_location_version v
         join public.service_location l on l.id = v.service_location_id
        where l.label = 'PROBE-L1' and v.version_no = 1),
      300, 'probe')$$,
  '%CAREOS_STALE_VERSION%',
  'geofence -: a superseded version cannot take a new radius');

select lives_ok(
  $$select app.set_service_location_geofence(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      300, 'apartment block, wide GPS scatter')$$,
  'geofence +: a per-location radius appends version 4');
select is(
  (select app.set_service_location_geofence(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      300, 'apartment block, wide GPS scatter') ->> 'unchanged'),
  'true', 'geofence +: setting the same radius again is unchanged, not a new version');

reset role;
select is(
  (select v.geofence_radius_m from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 4),
  300, 'geofence +: version 4 carries the radius');
select is(
  (select v.verification from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1' and v.version_no = 4),
  'verified',
  'geofence +: the human attestation carries forward — the address did not change');
select is(
  (select count(*)::int from public.service_location_version v
     join public.service_location l on l.id = v.service_location_id
    where l.label = 'PROBE-L1'),
  4, 'geofence +: four versions, none of them an edit');

-- Re-attesting the same pin on the carried-forward version is a no-op.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select app.verify_service_location(
      (select current_version_id from public.service_location where label = 'PROBE-L1'),
      39.2904, -77.1234, 'rooftop') ->> 'unchanged'),
  'true', 'verify +: re-attesting the identical pin is unchanged, not a fifth version');

-- A retired place of care is history: it is read, never revised. (Nothing in this slice
-- retires a location — 0045+ owns that — so the state is staged as postgres, which the
-- audit trigger correctly ignores.)
reset role;
update public.service_location set active = false where label = 'PROBE-L2';
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.revise_service_location(
      (select id from public.service_location where label = 'PROBE-L2'),
      '{"line1":"11 Daughter Ct","city":"Rockville","state":"MD","postal_code":"20850"}',
      'moved next door')$$,
  '%CAREOS_BAD_STATE%',
  'revise -: an inactive service location cannot be revised');

-- ═══ Invariant 7 · audit + outbox, and D-030 · no coordinates in either ════
reset role;
select is(
  (select count(*)::int from audit.audit_event
    where action = 'service_location.created'
      and entity_id = (select id from public.service_location where label = 'PROBE-L1')),
  1, 'audit: creating a location emits one service_location.created event');
select is(
  (select count(*)::int from audit.audit_event a
    where a.action = 'service_location_version.created'
      and a.entity_id in (select v.id from public.service_location_version v
                            join public.service_location l on l.id = v.service_location_id
                           where l.label = 'PROBE-L1')),
  4, 'audit: every appended version lands on the ledger');
select is(
  (select array_agg(d.event_type order by d.created_at)
     from public.domain_event d
    where d.entity_id = (select id from public.service_location where label = 'PROBE-L1')),
  array['location.created','location.revised','location.verified','location.geofence_set'],
  'outbox: the event types tell the location''s story in order');
select is(
  (select count(*)::int from pgmq.q_q_events q
    where (q.message ->> 'event_id')::uuid in
      (select d.id from public.domain_event d
        where d.entity_id = (select id from public.service_location
                              where label = 'PROBE-L1'))),
  4, 'outbox: every location event has its pgmq message in the same transaction');

-- The canary (docs/17 §12): the attested latitude and longitude appear NOWHERE
-- downstream of the row that legitimately holds them.
select is(
  (select count(*)::int from audit.audit_event
    where payload::text like '%39.2904%' or payload::text like '%77.1234%'),
  0, 'canary: no coordinate reached an audit payload (D-030, invariant 5)');
select is(
  (select count(*)::int from public.domain_event
    where payload::text like '%39.2904%' or payload::text like '%77.1234%'),
  0, 'canary: no coordinate reached an outbox payload (D-030, invariant 5)');
select is(
  (select count(*)::int from public.domain_event
    where payload::text like '%Ridge%' or payload::text like '%20910%'),
  0, 'canary: no address component reached an outbox payload (invariant 5)');
select is(
  (select count(*)::int from audit.audit_event
    where payload::text like '%Ridge%' or payload::text like '%20910%'
       or payload::text like '%PROBE-L1%'),
  0, 'canary: no address or label reached an audit payload (invariant 5)');

reset role;
select * from finish();
rollback;
