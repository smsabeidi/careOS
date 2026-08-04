-- pgTAP · audit chain: linkage holds, recomputation verifies, tamper is detected
-- @trace: ST-003, FR-X-020
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

-- Three events for tenant A, one interleaved for tenant B (chains are per-tenant)
select app.emit_audit_system('aaaaaaaa-0000-0000-0000-000000000001', 'system', 'e.one',   'thing', null, '{"n":1}');
select app.emit_audit_system('bbbbbbbb-0000-0000-0000-000000000001', 'system', 'e.other', 'thing', null, '{"n":9}');
select app.emit_audit_system('aaaaaaaa-0000-0000-0000-000000000001', 'system', 'e.two',   'thing', null, '{"n":2}');
select app.emit_audit_system('aaaaaaaa-0000-0000-0000-000000000001', 'system', 'e.three', 'thing', null, '{"n":3}');

-- Linkage: each event's prev_hash equals the prior same-tenant event's hash
select is(
  (select count(*)::int from (
     select hash, prev_hash,
            lag(hash) over (order by id) as expected_prev
       from audit.audit_event
      where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001') x
    where prev_hash is distinct from expected_prev),
  0, 'per-tenant prev_hash linkage holds with an interleaved foreign-tenant event');

-- Recomputation verifies for both tenants
select results_eq(
  $$select ok, first_bad_id from audit.verify_chain('aaaaaaaa-0000-0000-0000-000000000001')$$,
  $$values (true, null::bigint)$$,
  'verify_chain: tenant A chain is intact');
select results_eq(
  $$select ok, first_bad_id from audit.verify_chain('bbbbbbbb-0000-0000-0000-000000000001')$$,
  $$values (true, null::bigint)$$,
  'verify_chain: tenant B chain is intact');

-- ── Guarded read path (0025): the ledger is readable via RPC, never the tables ──
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000a0d', 'auditor.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-000000000c99', 'plain.a@meadowbrook.test');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-000000000a0d', 'aaaaaaaa-0000-0000-0000-000000000001', 'Auditor A', 'auditor.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-000000000c99', 'aaaaaaaa-0000-0000-0000-000000000001', 'Plain A', 'plain.a@meadowbrook.test', 'staff');
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000ea0d', 'aaaaaaaa-0000-0000-0000-000000000001', 'auditor', 'Auditor');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000ea0d', 'audit.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-000000000a0d', 'aaaaaaaa-0000-0000-0000-00000000ea0d');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000a0d', 'aal2');
select is(
  (select count(*)::int from app.read_audit_trail()),
  3, 'read_audit_trail: the auditor sees exactly the three tenant-A events, never B''s');
select is(
  (select count(*)::int from app.read_audit_trail(p_entity_type => 'thing')),
  3, 'read_audit_trail: entity_type filter matches');
select is(
  (select r.action from app.read_audit_trail(p_limit => 1) r),
  'e.three', 'read_audit_trail: newest first');
select is(
  (app.verify_audit_chain() ->> 'ok'), 'true',
  'verify_audit_chain: the auditor proves an intact tenant chain');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000a0d', 'aal1');
select throws_like(
  $$select * from app.read_audit_trail()$$,
  '%CAREOS_AAL2_REQUIRED%', 'read_audit_trail: AAL1 session is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000c99', 'aal2');
select throws_like(
  $$select * from app.read_audit_trail()$$,
  '%CAREOS_FORBIDDEN%', 'read_audit_trail: a user without audit.read is refused');

reset role;

-- Simulated insider tamper (docs/12 §3): superuser disables the guard and edits a row
alter table audit.audit_event disable trigger trg_audit_ao;
update audit.audit_event set payload = '{"n":999}'
 where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'e.two';
alter table audit.audit_event enable trigger trg_audit_ao;

select is(
  (select ok from audit.verify_chain('aaaaaaaa-0000-0000-0000-000000000001')),
  false, 'verify_chain detects the tampered event');
select is(
  (select first_bad_id from audit.verify_chain('aaaaaaaa-0000-0000-0000-000000000001')),
  (select id from audit.audit_event
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and action = 'e.two'),
  'verify_chain points at the exact tampered event');

-- The untouched tenant still verifies
select results_eq(
  $$select ok, first_bad_id from audit.verify_chain('bbbbbbbb-0000-0000-0000-000000000001')$$,
  $$values (true, null::bigint)$$,
  'tamper in tenant A does not disturb tenant B verification');

select * from finish();
rollback;
