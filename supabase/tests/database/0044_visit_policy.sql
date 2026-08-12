-- pgTAP · 0044 visit policy: the tenant floor is mandatory (no floor ⇒ POLICY_MISSING),
-- the defaults are the docs/17 §3.4 numbers, every tenant member reads policy at AAL1
-- (it is not PHI) while nobody writes it directly, the table is append-only at BOTH
-- layers, the specificity ladder resolves client → service_type → payer_kind → tenant,
-- a scheduled version does not govern until it starts, and app.upsert_visit_policy
-- appends versions, inherits at write time, and refuses every malformed scope.
-- Style mirrors 0011_scheduling.sql / 0043_geo_service_location.sql.
-- @trace: ST-202, D-014, D-017, D-024, docs/17 §3.4, §4.2, §5, §6.2
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ───────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'pol.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'pol.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'pol.cg2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'pol.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Policy Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Policy Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Policy Admin A', 'pol.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Policy Caregiver A1', 'pol.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Policy Caregiver A2', 'pol.cg2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Policy Admin B', 'pol.admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('policy.manage', 'test'), ('schedule.read', 'test'), ('schedule.write', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'pol_admin', 'Policy Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'pol_admin', 'Policy Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'policy.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'policy.manage');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

-- Two tenant-A clients: c001 gets a client-scope policy, c002 never does, so the
-- ladder can be observed with and without its top rung.
insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Policy', 'ClientA1'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Policy', 'ClientA2'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Policy', 'ClientB');

insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

-- PCA is medicaid and will carry its OWN service_type policy; COMPANION is private and
-- carries none, so it is the rung that exposes payer_kind inheritance.
insert into public.service_type (id, tenant_id, code, name, evv_required, payer_kind) values
  ('aaaaaaaa-0000-0000-0000-000000005201', 'aaaaaaaa-0000-0000-0000-000000000001',
   'PCA', 'Personal Care Aide', true, 'medicaid'),
  ('aaaaaaaa-0000-0000-0000-000000005202', 'aaaaaaaa-0000-0000-0000-000000000001',
   'COMPANION', 'Companion', false, 'private');

-- Inserted as postgres (no JWT) ⇒ the audit/outbox triggers no-op, no chain fork.
insert into public.visit (id, tenant_id, client_id, caregiver_id, service_type_id,
                          scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'aaaaaaaa-0000-0000-0000-000000005201', now(), now() + interval '2 hours');

-- Session simulator (identical to 002/003/0011/0043).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ Invariant: RLS enabled AND forced (docs/07 §1 convention 4) ═══════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'visit_policy'
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS is enabled + forced on visit_policy');

-- ═══ §4.2 · An unconfigured agency fails loudly, not quietly ═══════════════
-- Nothing is seeded yet for these tenants (the migration seeded the tenants that
-- existed when it ran, and these were created inside this transaction).
select throws_like(
  $$select app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c001')$$,
  '%CAREOS_POLICY_MISSING%',
  'resolve -: an agency with no tenant-scope row raises CAREOS_POLICY_MISSING');
select throws_like(
  $$select app.visit_policy_for('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_POLICY_MISSING%',
  'visit_policy_for -: the same floor requirement holds when keyed by the visit');

-- ═══ §3.4 · The tenant floor: seeded once, at the documented defaults ══════
select is(app.seed_visit_policy('aaaaaaaa-0000-0000-0000-000000000001'), 1,
  'seed +: the first call lays the tenant floor');
select is(app.seed_visit_policy('aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'seed +: a second call is a no-op (idempotent, the 0038 pattern)');
select is(
  (select count(*)::int from public.visit_policy
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1, 'seed +: exactly one policy row exists after seeding twice');

select is(
  (select jsonb_build_object(
            'scope_kind', vp.scope_kind, 'version_no', vp.version_no,
            'tier', vp.geofence_tier, 'radius', vp.geofence_radius_m,
            'accuracy', vp.max_accuracy_m, 'early', vp.early_clock_in_minutes,
            'late', vp.late_threshold_minutes, 'grace', vp.clock_out_grace_minutes,
            'missing', vp.missing_clock_out_minutes, 'missed', vp.missed_visit_minutes,
            'max_visit', vp.max_visit_minutes, 'signature', vp.signature_requirement,
            'rounding', vp.rounding_policy, 'overtime', vp.overtime_weekly_minutes,
            'travel', vp.impossible_travel_kmh)
     from public.visit_policy vp
    where vp.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  jsonb_build_object(
    'scope_kind', 'tenant', 'version_no', 1, 'tier', 'standard', 'radius', 200,
    'accuracy', 250, 'early', 15, 'late', 7, 'grace', 10, 'missing', 20,
    'missed', 60, 'max_visit', 900, 'signature', 'none', 'rounding', 'none',
    'overtime', 2400, 'travel', 120),
  'seed +: the floor carries exactly the docs/17 §3.4 defaults');

-- created_by FKs a real principal: the seeder attributes the floor to a member of the
-- tenant rather than inventing an author (it returns 0 when there is nobody).
select ok(
  exists (select 1 from public.app_user u
           join public.visit_policy vp on vp.created_by = u.id
          where vp.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            and u.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            and u.status = 'active'),
  'seed +: the floor is attributed to an active member of the tenant');

-- ═══ §3.4 · Read posture: every member, including at AAL1 (not PHI) ════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.visit_policy), 1,
  'visit_policy +: a caregiver with no permissions reads their agency''s policy');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.visit_policy), 1,
  'visit_policy +: the same caregiver reads it at AAL1 — a policy row carries no PHI');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.visit_policy), 1,
  'visit_policy +: a caregiver off the care team reads it too (grace periods are shared)');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_policy), 0,
  'visit_policy -: tenant-B admin sees no tenant-A policy (tenant isolation)');

-- ═══ Append-only, at both layers ═══════════════════════════════════════════
reset role;
select throws_like(
  $$update public.visit_policy set geofence_radius_m = 4000$$,
  '%CAREOS_APPEND_ONLY%',
  'visit_policy -: UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.visit_policy$$,
  '%CAREOS_APPEND_ONLY%',
  'visit_policy -: DELETE raises CAREOS_APPEND_ONLY');

select ok(has_table_privilege('authenticated', 'public.visit_policy', 'select'),
  'visit_policy +: authenticated holds the SELECT grant');
select ok(not has_table_privilege('authenticated', 'public.visit_policy', 'update'),
  'visit_policy -: authenticated has no UPDATE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_policy', 'delete'),
  'visit_policy -: authenticated has no DELETE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_policy', 'insert'),
  'visit_policy -: authenticated has no INSERT grant (lane-B: §6.2 is the only writer)');

-- ═══ Function surface (0001/0007 posture) ══════════════════════════════════
select ok(has_function_privilege('authenticated',
  'app.resolve_visit_policy(uuid,uuid,timestamptz)', 'execute'),
  'lane-b +: authenticated can call app.resolve_visit_policy');
select ok(has_function_privilege('authenticated', 'app.visit_policy_for(uuid)', 'execute'),
  'lane-b +: authenticated can call app.visit_policy_for');
select ok(has_function_privilege('authenticated',
  'app.upsert_visit_policy(text,uuid,text,jsonb,text)', 'execute'),
  'lane-b +: authenticated can call app.upsert_visit_policy');
select ok(not has_function_privilege('anon',
  'app.upsert_visit_policy(text,uuid,text,jsonb,text)', 'execute'),
  'lane-b -: anon cannot call app.upsert_visit_policy');
select ok(not has_function_privilege('anon',
  'app.resolve_visit_policy(uuid,uuid,timestamptz)', 'execute'),
  'lane-b -: anon cannot call app.resolve_visit_policy');
select ok(not has_function_privilege('authenticated',
  'app.visit_policy_chain(uuid,uuid,uuid,timestamptz)', 'execute'),
  'lane-b -: the candidate ladder is internal plumbing, not a client call');
select ok(not has_function_privilege('authenticated',
  'app.seed_visit_policy(uuid,uuid)', 'execute'),
  'lane-b -: authenticated cannot lay a tenant floor directly');
select ok(not has_function_privilege('authenticated', 'app.audit_visit_policy()', 'execute'),
  'lane-b -: the audit trigger function is not callable by clients');

-- ═══ §6.2 · Refusals ═══════════════════════════════════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.upsert_visit_policy('tenant', null, null,
      '{"late_threshold_minutes": 3}'::jsonb, 'caregiver tries')$$,
  '%CAREOS_FORBIDDEN%',
  'upsert -: a caregiver without policy.manage cannot author policy');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.upsert_visit_policy('tenant', null, null,
      '{"late_threshold_minutes": 3}'::jsonb, 'unverified session')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'upsert -: policy.manage at AAL1 is refused (invariant 3 posture)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.upsert_visit_policy('agency', null, null, '{}'::jsonb, 'typo')$$,
  '%CAREOS_BAD_SCOPE%',
  'upsert -: an unknown scope kind is refused');
select throws_like(
  $$select app.upsert_visit_policy('tenant',
      'aaaaaaaa-0000-0000-0000-00000000c001', null, '{}'::jsonb, 'confused scope')$$,
  '%CAREOS_BAD_SCOPE%',
  'upsert -: a tenant policy that names a scope id is refused');
select throws_like(
  $$select app.upsert_visit_policy('client', null, null, '{}'::jsonb, 'which client?')$$,
  '%CAREOS_BAD_SCOPE%',
  'upsert -: a client policy with no scope id is refused');
select throws_like(
  $$select app.upsert_visit_policy('payer_kind', null, 'cash', '{}'::jsonb, 'bad payer')$$,
  '%CAREOS_BAD_SCOPE%',
  'upsert -: a payer kind outside the service_type enum is refused');
select throws_like(
  $$select app.upsert_visit_policy('client', 'aaaaaaaa-0000-0000-0000-00000000c001',
      'medicaid', '{}'::jsonb, 'value on the wrong scope')$$,
  '%CAREOS_BAD_SCOPE%',
  'upsert -: only a payer_kind policy may carry a scope value');
select throws_like(
  $$select app.upsert_visit_policy('tenant', null, null,
      '{"late_threshold_minutes": 3}'::jsonb, '   ')$$,
  '%CAREOS_REASON_REQUIRED%',
  'upsert -: a policy change without a reason is refused');
select throws_like(
  $$select app.upsert_visit_policy('tenant', null, null,
      '{"geofence_radius": 300}'::jsonb, 'typo in the key')$$,
  '%CAREOS_BAD_SETTING%',
  'upsert -: an unknown setting key is refused, never silently dropped');
select throws_like(
  $$select app.upsert_visit_policy('client', 'bbbbbbbb-0000-0000-0000-00000000c001',
      null, '{}'::jsonb, 'cross-tenant client')$$,
  '%CAREOS_NOT_FOUND%',
  'upsert -: a scope naming another tenant''s client is not found (tenant isolation)');
select throws_like(
  $$select app.upsert_visit_policy('tenant', null, null,
      '{"effective_until": "2020-01-01T00:00:00Z"}'::jsonb, 'ends before it starts')$$,
  '%CAREOS_BAD_WINDOW%',
  'upsert -: a policy version that ends before it starts is refused');

-- Constraint-layer backstop: the CHECKs refuse an out-of-range value even if an RPC
-- ever forgot to (the radius is a metre count, not a mood).
select throws_like(
  $$select app.upsert_visit_policy('tenant', null, null,
      '{"geofence_radius_m": 10}'::jsonb, 'too tight to be a geofence')$$,
  '%visit_policy_geofence_radius_m_check%',
  'upsert -: a 10 m radius is refused by the range CHECK');

-- ═══ §6.2 + §4.2 · Authoring and the specificity ladder ════════════════════
select is(
  (app.upsert_visit_policy('tenant', null, null,
     '{"late_threshold_minutes": 5}'::jsonb,
     'Board set the late threshold to five minutes.') ->> 'version_no')::int,
  2, 'upsert +: changing the floor appends version 2');
select is(
  (select vp.supersedes_id from public.visit_policy vp
    where vp.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and vp.scope_kind = 'tenant' and vp.version_no = 2),
  (select vp.id from public.visit_policy vp
    where vp.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and vp.scope_kind = 'tenant' and vp.version_no = 1),
  'upsert +: version 2 supersedes version 1 (the chain is explicit, not implied)');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002')).late_threshold_minutes,
  5, 'resolve +: the newest in-force tenant version governs');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002')).geofence_radius_m,
  200, 'resolve +: a one-field edit left the other seventeen settings alone');

-- Idempotence is a return value, never an error, and never a second identical version.
select is(
  app.upsert_visit_policy('tenant', null, null,
    '{"late_threshold_minutes": 5}'::jsonb, 'same save, pressed twice') ->> 'unchanged',
  'true', 'upsert +: re-saving identical settings reports unchanged');
select is(
  (select count(*)::int from public.visit_policy vp
    where vp.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and vp.scope_kind = 'tenant'),
  2, 'upsert +: the unchanged save appended no version');

-- Rung 2: a service_type policy. It inherits the FLOOR at write time (DN-0044a), so it
-- carries late=5 from the floor plus its own change.
select is(
  (app.upsert_visit_policy('service_type', 'aaaaaaaa-0000-0000-0000-000000005201',
     null, '{"late_threshold_minutes": 3}'::jsonb,
     'Medicaid PCA visits are held to three minutes.') ->> 'version_no')::int,
  1, 'upsert +: a new scope starts its own chain at version 1');
select is(
  (select vp.supersedes_id from public.visit_policy vp
    where vp.scope_kind = 'service_type'
      and vp.scope_id = 'aaaaaaaa-0000-0000-0000-000000005201'),
  null, 'upsert +: a new scope supersedes nothing — it inherits values, not a chain');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002',
     'aaaaaaaa-0000-0000-0000-000000005201')).late_threshold_minutes,
  3, 'resolve +: the service_type rung outranks the tenant floor');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002',
     'aaaaaaaa-0000-0000-0000-000000005201')).missed_visit_minutes,
  60, 'resolve +: the service_type row inherited the floor''s untouched settings');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002')).late_threshold_minutes,
  5, 'resolve -: with no service type named, the service_type rung is not a candidate');

-- Rung 3: payer_kind. COMPANION is private-pay and has no service_type policy, so the
-- payer rung is what governs it — and the payer literal comes from the service type.
select is(
  (app.upsert_visit_policy('payer_kind', null, 'private',
     '{"missed_visit_minutes": 45}'::jsonb,
     'Private-pay visits are chased sooner.') ->> 'version_no')::int,
  1, 'upsert +: a payer_kind policy is authored against the literal, not a row');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002',
     'aaaaaaaa-0000-0000-0000-000000005202')).missed_visit_minutes,
  45, 'resolve +: a service type with no policy of its own inherits its payer''s');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002',
     'aaaaaaaa-0000-0000-0000-000000005201')).missed_visit_minutes,
  60, 'resolve +: the medicaid PCA policy outranks the private payer rung');

-- Rung 1: the client. Highest specificity wins the whole row — and because it inherited
-- the FLOOR (not the service_type row) at write time, late is 5 here, not 3. This is
-- DN-0044a made observable rather than left to be discovered in production.
select is(
  (app.upsert_visit_policy('client', 'aaaaaaaa-0000-0000-0000-00000000c001', null,
     '{"geofence_radius_m": 500}'::jsonb,
     'Farm setback: the house is 400 m off the road.') ->> 'scope_kind'),
  'client', 'upsert +: a client-scope policy is authored');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c001',
     'aaaaaaaa-0000-0000-0000-000000005201')).scope_kind,
  'client', 'resolve +: the client rung is the head of the ladder');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c001',
     'aaaaaaaa-0000-0000-0000-000000005201')).geofence_radius_m,
  500, 'resolve +: the client''s own radius governs that client''s visits');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c001',
     'aaaaaaaa-0000-0000-0000-000000005201')).late_threshold_minutes,
  5, 'resolve +: the client row inherited the floor at write time, not the rung below it');

-- ═══ §4.2 · Keyed by the visit ═════════════════════════════════════════════
select is(
  (app.visit_policy_for('aaaaaaaa-0000-0000-0000-00000000e001')).geofence_radius_m,
  500, 'visit_policy_for +: resolution runs on the visit''s own client + service type');
select is(
  (app.visit_policy_for('aaaaaaaa-0000-0000-0000-00000000e001')).id,
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c001',
     'aaaaaaaa-0000-0000-0000-000000005201')).id,
  'visit_policy_for +: it is the same row app.resolve_visit_policy returns');
select throws_like(
  $$select app.visit_policy_for('aaaaaaaa-0000-0000-0000-0000000000ff')$$,
  '%CAREOS_NOT_FOUND%',
  'visit_policy_for -: an unknown visit is not found');

-- ═══ Tenant isolation on the resolution path ═══════════════════════════════
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c001')$$,
  '%CAREOS_NOT_FOUND%',
  'resolve -: a tenant-B principal cannot resolve a tenant-A client''s policy');
select throws_like(
  $$select app.visit_policy_for('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_NOT_FOUND%',
  'visit_policy_for -: a tenant-B principal cannot resolve a tenant-A visit');

-- ═══ Tenant B: bootstrap and the floor requirement ═════════════════════════
select throws_like(
  $$select app.upsert_visit_policy('client', 'bbbbbbbb-0000-0000-0000-00000000c001',
      null, '{"geofence_radius_m": 300}'::jsonb, 'no floor yet')$$,
  '%CAREOS_POLICY_MISSING%',
  'upsert -: a narrower scope cannot be authored before the agency has defaults');
select is(
  (app.upsert_visit_policy('tenant', null, null,
     '{"geofence_tier": "rural", "geofence_radius_m": 600}'::jsonb,
     'Rural county: the standard fence does not reach the door.') ->> 'version_no')::int,
  2, 'upsert +: authoring the tenant scope first lays the defaults, then the change');
select is(
  (select vp.geofence_radius_m from public.visit_policy vp
    where vp.tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and vp.scope_kind = 'tenant' and vp.version_no = 1),
  200, 'upsert +: the bootstrapped version 1 is the documented default, honestly recorded');
select is(
  (app.resolve_visit_policy('bbbbbbbb-0000-0000-0000-00000000c001')).geofence_tier,
  'rural', 'resolve +: tenant B now resolves to its own floor');

-- ═══ Clock injection: a scheduled version does not govern until it starts ══
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (app.upsert_visit_policy('tenant', null, null,
     ('{"late_threshold_minutes": 9, "effective_from": "'
      || (now() + interval '1 day')::text || '"}')::jsonb,
     'New handbook takes effect tomorrow.') ->> 'version_no')::int,
  3, 'upsert +: a change can be scheduled ahead as version 3');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002')).late_threshold_minutes,
  5, 'resolve +: tomorrow''s version does not govern today (version 2 is still in force)');
select is(
  (app.resolve_visit_policy('aaaaaaaa-0000-0000-0000-00000000c002',
     null, now() + interval '2 days')).late_threshold_minutes,
  9, 'resolve +: asked about the day after, the scheduled version governs (D-016 clock)');

-- ═══ Invariant 7 · audit + outbox, IDs and enums only ══════════════════════
reset role;
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit_policy.version_created'
      and entity_type = 'visit_policy'
      and entity_id = (select vp.id from public.visit_policy vp
                        where vp.scope_kind = 'client'
                          and vp.scope_id = 'aaaaaaaa-0000-0000-0000-00000000c001')),
  1, 'audit: authoring a policy version emits exactly one audit event (invariant 7)');
select ok(
  not exists (select 1 from audit.audit_event
               where action = 'visit_policy.version_created'
                 and payload ? 'change_reason'),
  'audit -: the reason a policy changed is staff free text and stays off the payload');
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'policy.updated'
      and entity_id = (select vp.id from public.visit_policy vp
                        where vp.scope_kind = 'client'
                          and vp.scope_id = 'aaaaaaaa-0000-0000-0000-00000000c001')),
  1, 'outbox: the same change emits one policy.updated domain event (invariant 7)');
select ok(
  not exists (select 1 from public.domain_event
               where event_type = 'policy.updated' and payload ? 'change_reason'),
  'outbox -: the outbox payload is IDs and enums only (invariant 5)');

-- ═══ Constraint layer: the shapes the resolver could never match ═══════════
select throws_ok(
  $$insert into public.visit_policy (tenant_id, scope_kind, scope_id, version_no, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant',
            'aaaaaaaa-0000-0000-0000-00000000c001', 99,
            'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  '23514', null,
  'constraint -: a tenant-scope row carrying a scope id is refused');
select throws_ok(
  $$insert into public.visit_policy (tenant_id, scope_kind, scope_id, scope_value,
                                     version_no, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'client',
            'aaaaaaaa-0000-0000-0000-00000000c002', 'medicaid', 99,
            'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  '23514', null,
  'constraint -: only a payer_kind row may carry a scope value');
select throws_ok(
  $$insert into public.visit_policy (tenant_id, scope_kind, version_no,
                                     missed_visit_minutes, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant', 99, -5,
            'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  '23514', null,
  'constraint -: a negative grace period is a data-entry accident, not a policy');
-- The NULLS NOT DISTINCT clause is what makes the tenant scope uniquely versioned at
-- all: under default NULL semantics this duplicate would be accepted.
select throws_ok(
  $$insert into public.visit_policy (tenant_id, scope_kind, version_no, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant', 1,
            'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  '23505', null,
  'constraint -: a second tenant-scope version 1 collides (nulls not distinct)');

reset role;
select * from finish();
rollback;
