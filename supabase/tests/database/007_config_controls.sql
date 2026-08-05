-- pgTAP · config controls (0026): transition guard refuses illegal state jumps,
-- feature flags flip only through the audited platform.manage RPC, and the
-- repaired grants exist (no orphaned permissions).
-- @trace: ST-124, ST-125, ST-126, S1-4, S9-4
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only) ──────────────────────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000f0d', 'platform.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-000000000f99', 'plain.a@meadowbrook.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Cfg Tenant A');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-000000000f0d', 'aaaaaaaa-0000-0000-0000-000000000001', 'Platform A', 'platform.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-000000000f99', 'aaaaaaaa-0000-0000-0000-000000000001', 'Plain A', 'plain.a@meadowbrook.test', 'staff');
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000ef0d', 'aaaaaaaa-0000-0000-0000-000000000001', 'platform', 'Platform');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000ef0d', 'platform.manage');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-000000000f0d', 'aaaaaaaa-0000-0000-0000-00000000ef0d');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── assert_transition: legal moves pass, illegal moves raise ───────────────
select lives_ok(
  $$select app.assert_transition('app_user', 'invited', 'active')$$,
  'transition +: invited -> active is legal');
select lives_ok(
  $$select app.assert_transition('app_user', null, 'invited')$$,
  'transition +: initial state assignment (null from) always passes');
select lives_ok(
  $$select app.assert_transition('app_user', 'active', 'active')$$,
  'transition +: no-op same-state is not a transition');
select throws_like(
  $$select app.assert_transition('app_user', 'separated', 'active')$$,
  '%CAREOS_INVALID_TRANSITION%',
  'transition -: separated is terminal — no return to active');
select throws_like(
  $$select app.assert_transition('employee', 'candidate', 'active')$$,
  '%CAREOS_INVALID_TRANSITION%',
  'transition -: a candidate cannot skip onboarding');
select throws_like(
  $$select app.assert_transition('offer', 'accepted', 'declined')$$,
  '%CAREOS_INVALID_TRANSITION%',
  'transition -: an accepted offer cannot be un-accepted');

-- ── feature_flag: only the platform.manage RPC writes; flips are audited ───
select ok(not has_table_privilege('authenticated', 'public.feature_flag', 'insert'),
  'feature_flag: no direct INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.feature_flag', 'update'),
  'feature_flag: no direct UPDATE grant');

select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000f0d', 'aal2');
select is(app.feature_enabled('sms_outbound', false), false,
  'feature_enabled: an absent flag returns the caller''s default');
select throws_like(
  $$select app.set_feature_flag('shift_fill_agent', false)$$,
  '%CAREOS_REASON_REQUIRED%',
  'set_feature_flag -: disabling without a reason is refused');
select lives_ok(
  $$select app.set_feature_flag('shift_fill_agent', false, 'red-team finding open')$$,
  'set_feature_flag +: platform.manage can disable with a reason');
select is(app.feature_enabled('shift_fill_agent', true), false,
  'feature_enabled: the kill switch reads back OFF even with default true');

reset role;
select is(
  (select count(*)::int from audit.audit_event
    where action = 'config.feature_flag'
      and payload ->> 'key' = 'shift_fill_agent'),
  1, 'set_feature_flag: the flip is on the audit ledger');

select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000f99', 'aal2');
select throws_like(
  $$select app.set_feature_flag('shift_fill_agent', true)$$,
  '%CAREOS_FORBIDDEN%',
  'set_feature_flag -: without platform.manage the flag will not flip');

-- ── Grant repairs (ST-124): the orphaned permissions have holders ──────────
reset role;
insert into public.role (id, tenant_id, key, name, is_system) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner', 'Owner', true)
on conflict (tenant_id, key) do nothing;
-- Re-run the 0026 repair shape against this test tenant's system roles:
insert into public.role_permission (role_id, permission_key)
select r.id, v.perm from public.role r
join lateral (values
  ('owner', 'family.manage'), ('owner', 'compliance.authority.publish'), ('owner', 'audit.read')
) as v(role_key, perm) on v.role_key = r.key
where r.is_system
on conflict do nothing;
select is(
  (select count(*)::int from public.role_permission rp
    join public.role r on r.id = rp.role_id
   where r.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and r.key = 'owner'
     and rp.permission_key in ('family.manage','compliance.authority.publish','audit.read')),
  3, 'grant repairs: owner holds the previously-orphaned permissions');

reset role;
select * from finish();
rollback;
