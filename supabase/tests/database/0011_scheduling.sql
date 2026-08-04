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

-- ── visit audit: scheduling via the Lane-B RPC emits exactly one visit.schedule ──
-- (0023: direct inserts are revoked; app.schedule_visit is the only way in.)
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');   -- schedule.write + AAL2
select lives_ok(
  $$select app.schedule_visit('aaaaaaaa-0000-0000-0000-00000000c001',
      now() + interval '1 day', now() + interval '1 day 2 hours',
      p_note => 'audit-probe-0011')$$,
  'visit +: admin with schedule.write schedules an open visit via the RPC');
reset role;   -- postgres bypasses RLS to read the append-only ledger
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.schedule' and entity_type = 'visit'
      and entity_id = (select id from public.visit where note = 'audit-probe-0011')),
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

-- ═══ Lane-B perimeter (0023): the guard has no bypass ══════════════════════
-- Give A2 the missing TB screen so exactly one eligible caregiver exists (A2);
-- A1 remains blocked by the lapsed CPR.
reset role;
insert into public.credential
  (id, tenant_id, app_user_id, credential_type_id, issued_on, expires_on, status, verified_by, verified_at) values
  ('aaaaaaaa-0000-0000-0000-0000000cd003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-0000000c7002',
   current_date - 10, current_date + 300, 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now());

-- No direct write grants remain — even for schedule.write holders.
select ok(not has_table_privilege('authenticated', 'public.visit', 'insert'),
  'lane-b: authenticated has no INSERT grant on visit');
select ok(not has_table_privilege('authenticated', 'public.visit', 'update'),
  'lane-b: authenticated has no UPDATE grant on visit');
select ok(not has_table_privilege('authenticated', 'public.shift', 'insert'),
  'lane-b: authenticated has no INSERT grant on shift');
select ok(not has_table_privilege('authenticated', 'public.shift', 'update'),
  'lane-b: authenticated has no UPDATE grant on shift');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_ok(
  $$insert into public.visit (tenant_id, client_id, scheduled_start, scheduled_end)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000c001', now(), now() + interval '1 hour')$$,
  '42501', null,
  'lane-b: even the admin with schedule.write cannot insert a visit directly');

-- Open a visit, then assign it: the blocked caregiver is refused at WRITE time,
-- the eligible one lands.
select lives_ok(
  $$select app.schedule_visit('aaaaaaaa-0000-0000-0000-00000000c001',
      now() + interval '2 days', now() + interval '2 days 2 hours',
      p_note => 'lane-b-open-visit')$$,
  'lane-b: admin schedules an open visit');
select throws_like(
  $$select app.assign_visit(
      (select id from public.visit where note = 'lane-b-open-visit'),
      'aaaaaaaa-0000-0000-0000-0000000000c1')$$,
  '%CAREOS_NOT_SCHEDULABLE%',
  'lane-b: assigning a caregiver with a lapsed required credential is refused in-transaction');
select lives_ok(
  $$select app.assign_visit(
      (select id from public.visit where note = 'lane-b-open-visit'),
      'aaaaaaaa-0000-0000-0000-0000000000c2')$$,
  'lane-b: assigning the fully-credentialed caregiver succeeds');
select is(
  (select caregiver_id from public.visit where note = 'lane-b-open-visit'),
  'aaaaaaaa-0000-0000-0000-0000000000c2'::uuid,
  'lane-b: the visit is assigned to the eligible caregiver');

-- Call-out vacates the visit back to the open board with a callout exception.
select throws_like(
  $$select app.record_callout(
      (select id from public.visit where note = 'lane-b-open-visit'), '')$$,
  '%CAREOS_REASON_REQUIRED%',
  'lane-b: a call-out without a reason is refused');
select lives_ok(
  $$select app.record_callout(
      (select id from public.visit where note = 'lane-b-open-visit'), 'sick call, 6am')$$,
  'lane-b: recording a call-out succeeds');
select is(
  (select caregiver_id from public.visit where note = 'lane-b-open-visit'),
  null, 'lane-b: the call-out vacated the visit (open again)');
select is(
  (select count(*)::int from public.schedule_exception se
    where se.visit_id = (select id from public.visit where note = 'lane-b-open-visit')
      and se.kind = 'callout'),
  1, 'lane-b: the call-out left its exception-trail row');

-- Cancellation needs a reason and lands the terminal state.
select throws_like(
  $$select app.cancel_visit(
      (select id from public.visit where note = 'lane-b-open-visit'), null)$$,
  '%CAREOS_REASON_REQUIRED%',
  'lane-b: a cancellation without a reason is refused');
select lives_ok(
  $$select app.cancel_visit(
      (select id from public.visit where note = 'lane-b-open-visit'), 'client hospitalized')$$,
  'lane-b: cancelling with a reason succeeds');
select is(
  (select status from public.visit where note = 'lane-b-open-visit'),
  'cancelled', 'lane-b: the visit reached cancelled');

-- ═══ Credential lapse sweep (0024, S2-9) ═══════════════════════════════════
-- A2 is fully credentialed and assigned to a future visit and an old scheduled
-- visit. Rejecting A2's CPR must vacate the FUTURE visit only, leaving a
-- credential_lapse exception; the past visit is history and stays untouched.
reset role;
-- Both credential permissions: an UPDATE whose WHERE references existing columns
-- must satisfy the SELECT policy as well as the UPDATE policy (Postgres RLS rule),
-- and credential_select_scoped needs credential.read.all for non-self rows.
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'credential.write'),   -- keys exist from 0008
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'credential.read.all');

insert into public.visit (id, tenant_id, client_id, caregiver_id,
                          scheduled_start, scheduled_end, note) values
  ('aaaaaaaa-0000-0000-0000-00000000e801', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now() + interval '3 days', now() + interval '3 days 2 hours', 'sweep-future'),
  ('aaaaaaaa-0000-0000-0000-00000000e802', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   now() - interval '3 days', now() - interval '3 days' + interval '2 hours', 'sweep-past');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
update public.credential
   set status = 'rejected', row_version = row_version + 1
 where id = 'aaaaaaaa-0000-0000-0000-0000000cd002';   -- A2's CPR, was verified

reset role;
select is(
  (select caregiver_id from public.visit where note = 'sweep-future'),
  null, 'sweep: the future visit of the now-blocked caregiver is vacated');
select is(
  (select caregiver_id from public.visit where note = 'sweep-past'),
  'aaaaaaaa-0000-0000-0000-0000000000c2'::uuid,
  'sweep: the past visit is history and keeps its caregiver');
select is(
  (select count(*)::int from public.schedule_exception se
    where se.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e801'
      and se.kind = 'credential_lapse'),
  1, 'sweep: the vacated visit carries its credential_lapse exception-trail row');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.reassign'
      and entity_id = 'aaaaaaaa-0000-0000-0000-00000000e801'),
  1, 'sweep: the vacate is on the audit ledger as a visit.reassign');

-- The sweep engine is definer-only plumbing — not directly callable by clients.
select ok(not has_function_privilege('authenticated',
  'app.sweep_ineligible_assignments(uuid,uuid)', 'execute'),
  'sweep: authenticated cannot call the sweep engine directly');

reset role;
select * from finish();
rollback;
