-- pgTAP · onboarding engine: trigger materialization off the invitation flow, human-only
-- verification (D-015 structural), waivers, and the pure-SQL completeness engine.
-- @trace: ST-136, C9, D-015
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'new.hire@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-000000005e5e', 'agent.bot@meadowbrook.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-000000005e5e', 'aaaaaaaa-0000-0000-0000-000000000001', 'Agent Bot', 'agent.bot@meadowbrook.test', 'system');

insert into public.permission (key, description) values
  ('staff.manage', 'test'), ('credential.write', 'test'), ('credential.read.all', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'staff.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'credential.write'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'credential.read.all');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-000000005e5e', 'aaaaaaaa-0000-0000-0000-00000000e0ad');

select ok(app.seed_onboarding_catalog('aaaaaaaa-0000-0000-0000-000000000001') = 10,
  'catalog: the ten COMAR personnel-file items seed');
select ok(app.seed_onboarding_catalog('aaaaaaaa-0000-0000-0000-000000000001') = 0,
  'catalog: idempotent');

-- Session simulator (with email — the accept flow needs it)
create function pg_temp.login_e(p_user uuid, p_aal text, p_email text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal,
                      'email', p_email)::text, true);
end $$;

-- ── Integration: invite → accept → the file materializes by trigger ────────
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2', 'admin.a@meadowbrook.test');
select lives_ok(
  $$select app.invite_staff('new.hire@meadowbrook.test', 'New Hire',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('11', 32), 'hex')), 'hex'))$$,
  'flow: the hire is invited');
reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-00000000f001', 'aal1', 'new.hire@meadowbrook.test');
select lives_ok(
  $$select app.accept_invitation(repeat('11', 32))$$,
  'flow: the hire accepts');

reset role;
-- HHA file: everything except licensure_verification (RN/LPN-only) = 9 items.
select is(
  (select count(*)::int from public.onboarding_item
    where employee_id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  9, 'materialize: the HHA file has its nine required items, by trigger');
select is(
  (select count(*)::int from public.onboarding_item
    where employee_id = 'aaaaaaaa-0000-0000-0000-00000000f001'
      and checklist_key = 'licensure_verification'),
  0, 'materialize: the RN-only item is not in an HHA file');
select is(
  (select (items_total, items_closed, file_complete)::text from public.employee_file_status
    where employee_id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  (9, 0, false)::text, 'engine: the file starts open');

-- ── Human-only verification (D-015, structural) ────────────────────────────
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-000000005e5e', 'aal2', 'agent.bot@meadowbrook.test');
select throws_like(
  $$select app.complete_onboarding_item('aaaaaaaa-0000-0000-0000-00000000f001', 'interview')$$,
  '%CAREOS_HUMAN_REQUIRED%',
  'D-015: a system identity holding the right permission still cannot verify');

reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2', 'admin.a@meadowbrook.test');
select lives_ok(
  $$select app.complete_onboarding_item('aaaaaaaa-0000-0000-0000-00000000f001', 'interview')$$,
  'verify: a human staff member attests the interview');
select is(
  (app.complete_onboarding_item('aaaaaaaa-0000-0000-0000-00000000f001', 'interview')
     ->> 'already_closed'),
  'true', 'verify: replay is an idempotent no-op');
select throws_like(
  $$select app.waive_onboarding_item('aaaaaaaa-0000-0000-0000-00000000f001', 'reference_2', '')$$,
  '%CAREOS_REASON_REQUIRED%', 'waive: a documented reason is required');
select lives_ok(
  $$select app.waive_onboarding_item('aaaaaaaa-0000-0000-0000-00000000f001', 'reference_2',
      'second reference pending mail — accepted per policy 4.2')$$,
  'waive: staff.manage waives with a reason');

-- Close the remaining seven; the last one emits onboarding.completed.
select lives_ok(
  $$select app.complete_onboarding_item('aaaaaaaa-0000-0000-0000-00000000f001', k)
      from unnest(array['identity_eligibility','employment_history','reference_1',
                        'chrc_background','tb_screening','cpr_certification',
                        'skills_demonstration']) k$$,
  'verify: the rest of the file closes');

reset role;
select is(
  (select (items_closed, file_complete)::text from public.employee_file_status
    where employee_id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  (9, true)::text, 'engine: the file is complete');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'onboarding.completed'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  1, 'engine: completion is on the ledger');
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'onboarding.completed'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  1, 'engine: completion is on the outbox (C9''s cue)');

-- ── Posture ────────────────────────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.onboarding_item', 'insert'),
  'posture: no direct INSERT on onboarding_item');
select ok(not has_table_privilege('authenticated', 'public.onboarding_item', 'update'),
  'posture: no direct UPDATE on onboarding_item');
select ok(not has_table_privilege('authenticated', 'public.onboarding_checklist', 'insert'),
  'posture: the catalog has no client write path');

reset role;
select * from finish();
rollback;
