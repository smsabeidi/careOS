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
