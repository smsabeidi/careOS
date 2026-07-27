-- pgTAP · scheduling (0011): RLS enabled+forced per table, one positive + one negative
-- policy probe per table, schedule_exception append-only probes, the visit audit path,
-- and the deterministic credential-lapse guard app.assert_schedulable (bound to 0008).
-- Style mirrors 002_rls_matrix.sql / 003_append_only.sql.
-- @trace: ST-030, ST-031, docs/07 §6, §8
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'sched.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'sched.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'sched.cg2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'sched.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Sched Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Sched Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Sched Admin A', 'sched.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Sched Caregiver A1', 'sched.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Sched Caregiver A2', 'sched.cg2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Sched Admin B', 'sched.admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('schedule.read', 'test'), ('schedule.write', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'sched_admin', 'Sched Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'sched_admin', 'Sched Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.write'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.write');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Sched', 'ClientA'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001', 'Sched', 'ClientB');

-- Caregiver A1 is assigned to client A (care-team scope); A2 is not.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

-- Shift for A1; visit (client A ← caregiver A1) linked to it; exception on the visit.
-- Inserted as postgres (no JWT) ⇒ the audit trigger is a no-op, no chain fork.
insert into public.shift (id, tenant_id, caregiver_id, starts_at, ends_at) values
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', now(), now() + interval '4 hours');
insert into public.visit (id, tenant_id, client_id, caregiver_id, shift_id,
                          scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'aaaaaaaa-0000-0000-0000-00000000f001', now(), now() + interval '2 hours');
insert into public.schedule_exception (id, tenant_id, visit_id, kind, note, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000d001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'late_start', 'Traffic on Georgia Ave.',
   'aaaaaaaa-0000-0000-0000-0000000000c1');

-- ── Invariant: RLS enabled AND forced on every new table (docs/07 §1 conv. 4) ──
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('shift','visit','schedule_exception')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS is enabled + forced on shift, visit, and schedule_exception');

-- Session simulator (identical to 002/003).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── shift: positive + negative policy probes ───────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.shift), 1,
  'shift +: caregiver A1 sees their own roster shift');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.shift), 0,
  'shift -: caregiver A2 (no schedule.read, not the shift owner) sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.shift), 1,
  'shift +: admin A (schedule.read) sees the tenant shift');

-- ── visit: positive + negative policy probes (PHI ⇒ AAL2 + scoping) ─────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.visit), 1,
  'visit +: assigned caregiver A1 (AAL2) sees their scheduled visit');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.visit), 0,
  'visit -: same caregiver at AAL1 sees nothing (invariant 3: AAL2 for PHI)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.visit), 0,
  'visit -: unassigned caregiver A2 sees nothing');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit), 0,
  'visit -: tenant-B admin sees no tenant-A visit (tenant isolation)');

-- Unpermissioned insert is rejected loudly by the WITH CHECK.
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select throws_ok(
  $$insert into public.visit (tenant_id, client_id, scheduled_start, scheduled_end)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000c001', now(), now() + interval '1 hour')$$,
  '42501', null,
  'visit -: caregiver without schedule.write cannot insert a visit');

-- ── visit audit: a scheduled visit emits exactly one visit.schedule audit event ──
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');   -- schedule.write + AAL2
insert into public.visit (id, tenant_id, client_id, scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000e777', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', now() + interval '1 day', now() + interval '1 day 2 hours');
reset role;   -- postgres bypasses RLS to read the append-only ledger
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.schedule' and entity_type = 'visit'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000e777'),
  1, 'visit audit: scheduling a visit emits one visit.schedule audit event (invariant 7)');

-- ── schedule_exception: positive + negative policy probes ──────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.schedule_exception), 1,
  'schedule_exception +: caregiver on the visit sees the exception');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.schedule_exception), 0,
  'schedule_exception -: caregiver not on the visit sees nothing');

-- ── schedule_exception append-only: trigger layer (even superuser) ─────────
reset role;
select throws_like(
  $$update public.schedule_exception set note = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%', 'schedule_exception UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.schedule_exception$$,
  '%CAREOS_APPEND_ONLY%', 'schedule_exception DELETE raises CAREOS_APPEND_ONLY');

-- ── schedule_exception append-only: privilege layer (no update/delete grant) ─
select ok(not has_table_privilege('authenticated', 'public.schedule_exception', 'update'),
  'authenticated has no UPDATE grant on schedule_exception (append-only)');
select ok(not has_table_privilege('authenticated', 'public.schedule_exception', 'delete'),
  'authenticated has no DELETE grant on schedule_exception (append-only)');

-- ── app.assert_schedulable: deterministic credential-lapse guard (bound to 0008) ──
-- Callable by the RPC layer; never by anon (invariant 6).
select ok(has_function_privilege('authenticated',
  'app.assert_schedulable(uuid,uuid,tstzrange)', 'execute'),
  'authenticated can call app.assert_schedulable (RPC-layer guard)');
select ok(not has_function_privilege('anon',
  'app.assert_schedulable(uuid,uuid,tstzrange)', 'execute'),
  'anon cannot call app.assert_schedulable');

-- Positive: caregiver A2 holds no required blocking credential (no role, no cred yet)
-- ⇒ schedulable.
select is(
  app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) ->> 'schedulable',
  'true', 'assert_schedulable +: caregiver with no required blocking credential is schedulable');

-- Fixtures: a scheduling-blocking credential type required for caregivers; A1/A2 both
-- become caregivers. A1's credential is verified-but-lapsed; A2's is verified-and-valid.
reset role;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000e0c9'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000e0c9');
insert into public.credential_type
  (id, tenant_id, key, name, category, required_for_roles, blocks_scheduling) values
  ('aaaaaaaa-0000-0000-0000-0000000c7001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'cpr', 'CPR Certification', 'certification', '{Caregiver}', true);
-- A1: verified but lapsed 5 days ago ⇒ a 'lapsed' blocker.
insert into public.credential
  (id, tenant_id, app_user_id, credential_type_id, issued_on, expires_on, status, verified_by, verified_at) values
  ('aaaaaaaa-0000-0000-0000-0000000cd001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000c7001',
   current_date - 400, current_date - 5, 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now());
-- A2: verified and valid well past the window ⇒ no blocker.
insert into public.credential
  (id, tenant_id, app_user_id, credential_type_id, issued_on, expires_on, status, verified_by, verified_at) values
  ('aaaaaaaa-0000-0000-0000-0000000cd002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-0000000c7001',
   current_date - 10, current_date + 300, 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now());

-- Negative: A1's required CPR lapsed ⇒ NOT schedulable, one 'lapsed' blocker naming CPR.
select is(
  app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) ->> 'schedulable',
  'false', 'assert_schedulable -: a caregiver with a lapsed required credential is blocked');
select is(
  jsonb_array_length(app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) -> 'blockers'),
  1, 'assert_schedulable -: exactly one blocker (the lapsed CPR)');
select is(
  app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) #>> '{blockers,0,reason}',
  'lapsed', 'assert_schedulable -: the blocker reason is "lapsed"');
select is(
  app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) #>> '{blockers,0,credential}',
  'cpr', 'assert_schedulable -: the blocker names the CPR credential type');

-- A2 holds the SAME required credential, valid ⇒ still schedulable (no false block).
select is(
  app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) ->> 'schedulable',
  'true', 'assert_schedulable +: a valid required credential does not block');

-- Missing-credential path: a second blocking type required for caregivers, with no
-- credential for A2 ⇒ a 'missing' blocker ⇒ not schedulable.
insert into public.credential_type
  (id, tenant_id, key, name, category, required_for_roles, blocks_scheduling) values
  ('aaaaaaaa-0000-0000-0000-0000000c7002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'tb_screen', 'TB Screening', 'health_screening', '{Caregiver}', true);
select is(
  app.assert_schedulable(
    'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000c001',
    tstzrange(now(), now() + interval '2 hours', '[)')) ->> 'schedulable',
  'false', 'assert_schedulable -: a missing required credential blocks scheduling');

reset role;
select * from finish();
rollback;
