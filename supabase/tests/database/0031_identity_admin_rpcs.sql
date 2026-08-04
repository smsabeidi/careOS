-- pgTAP · identity admin write plane: role grants (rbac.manage finally checked),
-- suspension round-trip, assignment lifecycle, employment updates, last-admin guard.
-- @trace: ST-134
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'cg2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A2', 'cg2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('staff.manage', 'test'), ('rbac.manage', 'test'), ('careteam.manage', 'test'),
  ('user.read', 'test'), ('careteam.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'staff.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'rbac.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'careteam.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'user.read'),      -- production admins hold both
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'careteam.read');  -- (seeded role matrix)
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');

select ok(app.backfill_employees() >= 4, 'fixtures: employee rows materialized');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Role grants ────────────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.grant_role('aaaaaaaa-0000-0000-0000-0000000000c2',
                          'aaaaaaaa-0000-0000-0000-00000000e0c9')$$,
  '%CAREOS_FORBIDDEN%', 'grant: no rbac.manage ⇒ no role grants');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (app.grant_role('aaaaaaaa-0000-0000-0000-0000000000c2',
                  'aaaaaaaa-0000-0000-0000-00000000e0c9') ->> 'granted'),
  'true', 'grant: rbac.manage grants the caregiver role');
select is(
  (select granted_by from public.user_role
    where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  'aaaaaaaa-0000-0000-0000-0000000000ad'::uuid,
  'grant: granted_by finally gets written');
select is(
  (app.grant_role('aaaaaaaa-0000-0000-0000-0000000000c2',
                  'aaaaaaaa-0000-0000-0000-00000000e0c9') ->> 'granted'),
  'false', 'grant: re-granting is a reported no-op');
select throws_like(
  $$select app.grant_role('bbbbbbbb-0000-0000-0000-0000000000ad',
                          'aaaaaaaa-0000-0000-0000-00000000e0c9')$$,
  '%CAREOS_NOT_FOUND%', 'grant: a cross-tenant target is refused');

-- ── Assignment lifecycle ───────────────────────────────────────────────────
select lives_ok(
  $$select app.create_assignment('aaaaaaaa-0000-0000-0000-00000000c001',
      'aaaaaaaa-0000-0000-0000-0000000000c2', 'caregiver')$$,
  'assignment: careteam.manage assigns the caregiver');
select throws_like(
  $$select app.create_assignment('aaaaaaaa-0000-0000-0000-00000000c001',
      'aaaaaaaa-0000-0000-0000-0000000000c2', 'caregiver')$$,
  '%CAREOS_DUPLICATE%', 'assignment: an identical active assignment is refused');
select throws_like(
  $$select app.end_assignment(
      (select id from public.care_team_assignment
        where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2' and ends_on is null),
      '')$$,
  '%CAREOS_REASON_REQUIRED%', 'assignment: ending needs a reason');
select lives_ok(
  $$select app.end_assignment(
      (select id from public.care_team_assignment
        where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2' and ends_on is null),
      'client discharged')$$,
  'assignment: ends with a reason');
select is(
  (select ends_on from public.care_team_assignment
    where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  current_date, 'assignment: ends_on is stamped today');

-- ── Employment updates ─────────────────────────────────────────────────────
select is(
  (app.update_employee('aaaaaaaa-0000-0000-0000-0000000000c2', 1,
                       p_role_title => 'CNA') ->> 'ok'),
  'true', 'employee: title update with the right row_version');
select throws_like(
  $$select app.update_employee('aaaaaaaa-0000-0000-0000-0000000000c2', 1,
                               p_role_title => 'HHA')$$,
  '%CAREOS_STALE%', 'employee: a stale row_version is refused');
select is(
  (app.update_employee('aaaaaaaa-0000-0000-0000-0000000000c2', 2,
                       p_employment_status => 'leave') ->> 'ok'),
  'true', 'employee: active→leave is a lawful transition');
select throws_like(
  $$select app.update_employee('aaaaaaaa-0000-0000-0000-0000000000c2', 3,
                               p_employment_status => 'candidate')$$,
  '%CAREOS_INVALID_TRANSITION%', 'employee: leave→candidate is not in the catalog');
select throws_like(
  $$select app.update_employee('aaaaaaaa-0000-0000-0000-0000000000c2', 3,
                               p_employment_status => 'separated')$$,
  '%CAREOS_USE_SEPARATION%', 'employee: separation is a saga, not a field edit');
select throws_like(
  $$select app.update_employee('aaaaaaaa-0000-0000-0000-0000000000c2', 3,
                               p_supervisor => 'aaaaaaaa-0000-0000-0000-00000000ffff')$$,
  '%CAREOS_NOT_FOUND%', 'employee: an unknown supervisor is refused');

-- ── Suspension round-trip ──────────────────────────────────────────────────
select throws_like(
  $$select app.suspend_user('aaaaaaaa-0000-0000-0000-0000000000ad', 'because')$$,
  '%CAREOS_SELF_TARGET%', 'suspend: you cannot suspend yourself');
select throws_like(
  $$select app.suspend_user('aaaaaaaa-0000-0000-0000-0000000000c1', '')$$,
  '%CAREOS_REASON_REQUIRED%', 'suspend: a reason is required');
select lives_ok(
  $$select app.suspend_user('aaaaaaaa-0000-0000-0000-0000000000c1', 'pending investigation')$$,
  'suspend: staff.manage suspends the caregiver');
select is(
  (select status from public.app_user where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  'suspended', 'suspend: access status flipped (0022 kills the session at commit)');
select lives_ok(
  $$select app.reinstate_user('aaaaaaaa-0000-0000-0000-0000000000c1')$$,
  'suspend: reinstatement round-trips');
select is(
  (select status from public.app_user where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  'active', 'suspend: the caregiver is active again');

-- ── The last-admin guard ───────────────────────────────────────────────────
select throws_like(
  $$select app.revoke_role('aaaaaaaa-0000-0000-0000-0000000000ad',
                           'aaaaaaaa-0000-0000-0000-00000000e0ad')$$,
  '%CAREOS_LAST_ADMIN%',
  'lockout: revoking the sole rbac.manage holder''s role is refused');

reset role;
select is(
  (select count(*)::int from audit.audit_event
    where action in ('identity.role_granted','assignment.created','assignment.ended',
                     'identity.suspended','identity.reinstated','employee.updated')),
  7, 'ledger: every consequential identity action of this drill is audited');

reset role;
select * from finish();
rollback;
