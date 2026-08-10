-- pgTAP · web EVV (0013): RLS enabled+forced on the visit_event ledger, the clock_visit
-- transition RPC (assigned-caregiver + AAL2 only, advances visit status), append-only, no
-- direct insert grant (RPC-only writes), and RPC privilege posture.
-- Style mirrors 0011_scheduling.sql / 0012_consent_family.sql.
-- @trace: docs/07 §6 (EVV), Wave "web EVV"
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-0000000000ad', 'evv.admin@meadowbrook.test'),
  ('dddddddd-0000-0000-0000-0000000000c1', 'evv.cg1@meadowbrook.test'),
  ('dddddddd-0000-0000-0000-0000000000c2', 'evv.cg2@meadowbrook.test');
insert into public.tenant (id, name) values
  ('dddddddd-0000-0000-0000-000000000001', 'EVV Tenant');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('dddddddd-0000-0000-0000-0000000000ad', 'dddddddd-0000-0000-0000-000000000001', 'EVV Admin', 'evv.admin@meadowbrook.test', 'staff'),
  ('dddddddd-0000-0000-0000-0000000000c1', 'dddddddd-0000-0000-0000-000000000001', 'EVV Caregiver 1', 'evv.cg1@meadowbrook.test', 'staff'),
  ('dddddddd-0000-0000-0000-0000000000c2', 'dddddddd-0000-0000-0000-000000000001', 'EVV Caregiver 2', 'evv.cg2@meadowbrook.test', 'staff');
insert into public.permission (key, description) values ('schedule.read', 'test') on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('dddddddd-0000-0000-0000-00000000e0ad', 'dddddddd-0000-0000-0000-000000000001', 'evv_admin', 'EVV Admin');
insert into public.role_permission (role_id, permission_key) values
  ('dddddddd-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('dddddddd-0000-0000-0000-0000000000ad', 'dddddddd-0000-0000-0000-00000000e0ad');
insert into public.client (id, tenant_id, first_name, last_name) values
  ('dddddddd-0000-0000-0000-00000000c001', 'dddddddd-0000-0000-0000-000000000001', 'EVV', 'Client');
-- A visit assigned to caregiver 1.
insert into public.visit (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end) values
  ('dddddddd-0000-0000-0000-00000000e001', 'dddddddd-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-00000000c001', 'dddddddd-0000-0000-0000-0000000000c1',
   now(), now() + interval '2 hours');

-- RLS enabled + forced.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'visit_event'
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS enabled + forced on visit_event');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── clock_visit +: assigned caregiver (AAL2) clocks in ──────────────────────
select pg_temp.login('dddddddd-0000-0000-0000-0000000000c1', 'aal2');
select is(
  app.clock_visit('dddddddd-0000-0000-0000-00000000e001', 'clock_in', 40.01, -76.30, 6.0) ->> 'status',
  'in_progress', 'clock_visit +: assigned caregiver clocking in advances the visit to in_progress');
select is((select count(*)::int from public.visit_event
            where visit_id = 'dddddddd-0000-0000-0000-00000000e001'),
  1, 'clock_in appends exactly one visit_event');

reset role;
select is((select status from public.visit where id = 'dddddddd-0000-0000-0000-00000000e001'),
  'in_progress', 'visit.status advanced to in_progress by the RPC');
-- The audit ledger recorded the clock event (no location in payload).
select is((select count(*)::int from audit.audit_event
            where action = 'visit.clock_in' and entity_type = 'visit_event'),
  1, 'clock_in emits one visit.clock_in audit event (invariant 7)');

-- clock_out → completed.
select pg_temp.login('dddddddd-0000-0000-0000-0000000000c1', 'aal2');
select is(
  app.clock_visit('dddddddd-0000-0000-0000-00000000e001', 'clock_out', 40.01, -76.30, 6.0) ->> 'status',
  'completed', 'clock_visit +: clocking out completes the visit');

-- ── clock_visit -: a non-assigned caregiver is refused ──────────────────────
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000c2', 'aal2');
select throws_ok(
  $$ select app.clock_visit('dddddddd-0000-0000-0000-00000000e001', 'clock_in', null, null, null) $$,
  '42501', null, 'clock_visit -: a caregiver not assigned to the visit cannot clock it');

-- ── clock_visit -: AAL2 is required ─────────────────────────────────────────
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000c1', 'aal1');
select throws_ok(
  $$ select app.clock_visit('dddddddd-0000-0000-0000-00000000e001', 'clock_in', null, null, null) $$,
  '42501', null, 'clock_visit -: an AAL1 session cannot clock a visit (invariant 3)');

-- ── visit_event is append-only (trigger + privilege) ────────────────────────
reset role;
select throws_like($$update public.visit_event set note = 'x'$$, '%CAREOS_APPEND_ONLY%',
  'visit_event UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.visit_event$$, '%CAREOS_APPEND_ONLY%',
  'visit_event DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.visit_event', 'insert'),
  'authenticated has NO direct insert grant on visit_event (writes go through the RPC)');

-- ── visit_event select scoping ──────────────────────────────────────────────
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.visit_event), 2,
  'visit_event +: the clocking caregiver sees their own two events (in + out)');
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.visit_event), 0,
  'visit_event -: an unrelated caregiver sees nothing');

-- ── RPC privilege posture ───────────────────────────────────────────────────
reset role;
-- D-029 re-signed this RPC: the five-argument function was DROPPED and re-created with six
-- additional defaulted parameters, so five-argument call sites (every one above) still
-- resolve while the capture fields stay additive. The privilege probe therefore names the
-- new identity signature — the same assertion pointed at the function that now exists, not
-- a relaxed one. An overload was rejected deliberately (D-016: ambiguous overloads break
-- PostgREST's named-argument resolution).
select ok(has_function_privilege('authenticated',
  'app.clock_visit(uuid,text,double precision,double precision,double precision,text,timestamptz,boolean,text,text,text)',
  'execute'),
  'authenticated can call app.clock_visit');
select ok(not has_function_privilege('anon',
  'app.clock_visit(uuid,text,double precision,double precision,double precision,text,timestamptz,boolean,text,text,text)',
  'execute'),
  'anon cannot call app.clock_visit');
-- The old five-argument identity is gone, not shadowed: proving the drop-and-create in
-- D-029 actually happened and no stale overload survives to make calls ambiguous.
select ok(to_regprocedure(
  'app.clock_visit(uuid,text,double precision,double precision,double precision)') is null,
  'the pre-D-029 five-argument clock_visit identity no longer exists (no ambiguous overload)');

reset role;
select * from finish();
rollback;
