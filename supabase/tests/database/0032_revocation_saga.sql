-- pgTAP · separation saga: one transaction closes access, employment, assignments and
-- future visits; the checklist materializes; completion emits the verification row.
-- @trace: ST-135, S2-7, docs/09 §2-3
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'cg2.a@meadowbrook.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A2', 'cg2.a@meadowbrook.test', 'staff');

insert into public.permission (key, description) values
  ('staff.manage', 'test'), ('rbac.manage', 'test'), ('user.read', 'test'),
  ('careteam.read', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'staff.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'rbac.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'user.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'careteam.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000e0c9');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c2', 'caregiver');
insert into public.visit (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, note) values
  ('aaaaaaaa-0000-0000-0000-00000000e801', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now() + interval '2 days', now() + interval '2 days 2 hours', 'sep-future'),
  ('aaaaaaaa-0000-0000-0000-00000000e802', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now() - interval '2 days', now() - interval '2 days' + interval '2 hours', 'sep-past');

select ok(app.backfill_employees() >= 3, 'fixtures: employee rows materialized');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Guards ─────────────────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.separate_user('aaaaaaaa-0000-0000-0000-0000000000c2', 'x')$$,
  '%CAREOS_FORBIDDEN%', 'saga: no staff.manage ⇒ no separation');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.separate_user('aaaaaaaa-0000-0000-0000-0000000000ad', 'quitting')$$,
  '%CAREOS_SELF_TARGET%', 'saga: you cannot separate yourself');
select throws_like(
  $$select app.separate_user('aaaaaaaa-0000-0000-0000-0000000000c2', '')$$,
  '%CAREOS_REASON_REQUIRED%', 'saga: a reason is required');

-- ── The separation, one transaction ────────────────────────────────────────
select is(
  (app.separate_user('aaaaaaaa-0000-0000-0000-0000000000c2', 'resigned') ->> 'ok'),
  'true', 'saga: separation executes');

reset role;
select is(
  (select (status, separated_at is not null)::text from public.app_user
    where id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  ('separated', true)::text, 'saga: access record separated + stamped');
select is(
  (select employment_status from public.employee
    where id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  'separated', 'saga: employment record separated');
select is(
  (select ends_on from public.care_team_assignment
    where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  current_date, 'saga: the open assignment ended today');
select is(
  (select caregiver_id from public.visit where note = 'sep-future'),
  null, 'saga: the future visit is vacated back to the open board');
select is(
  (select count(*)::int from public.schedule_exception se
    where se.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e801' and se.kind = 'separation'),
  1, 'saga: the vacate carries its separation exception-trail row');
select is(
  (select caregiver_id from public.visit where note = 'sep-past'),
  'aaaaaaaa-0000-0000-0000-0000000000c2'::uuid,
  'saga: the past visit is history and keeps its caregiver');
select is(
  (select count(*)::int from public.revocation_checklist
    where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2' and status = 'pending'),
  6, 'saga: the six-step checklist materialized, all pending');
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'identity.separated'
      and entity_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  1, 'saga: the worker''s cue is on the outbox');

-- The separated caregiver's still-valid session is dark (0022 + 006 drill semantics).
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.visit), 0,
  'saga: the separated caregiver''s live token reads nothing, mid-token');

-- No resurrection, replay-safe: separating again is an explicit no-op (S2-7).
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (app.separate_user('aaaaaaaa-0000-0000-0000-0000000000c2', 'again') ->> 'already_separated'),
  'true', 'saga: replaying a separation is an idempotent no-op');
reset role;
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'identity.separated'
      and entity_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  1, 'saga: the replay emitted no duplicate outbox event');
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');

-- ── Checklist completion → verification evidence ───────────────────────────
select lives_ok(
  $$select app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'auth_ban',
      'banned via dashboard')$$,
  'checklist: a step completes');
select is(
  (app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'auth_ban')
     ->> 'already_done'),
  'true', 'checklist: replaying a done step is an idempotent no-op');
select lives_ok(
  $$select app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'refresh_revoke');
    select app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'push_invalidate',
      null, true);
    select app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'secrets_rotation',
      null, true);
    select app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'equipment_return');
    select app.complete_revocation_step('aaaaaaaa-0000-0000-0000-0000000000c2', 'final_documentation')$$,
  'checklist: the remaining steps land (two as not-applicable)');

reset role;
select is(
  (select count(*)::int from public.revocation_checklist
    where user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2' and status = 'pending'),
  0, 'checklist: nothing left pending');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'identity.revocation_verified'
      and entity_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'),
  1, 'checklist: the docs/09 §3 verification evidence row is on the ledger');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'identity.revocation_step'), 6,
  'checklist: all six step completions are audited');

reset role;
select * from finish();
rollback;
