-- pgTAP · staff compliance: catalog repair + expansion, staff cadence off hire_date,
-- and on_event rules driven by the outbox (D-016 closure).
-- @trace: ST-170, ST-171, D-016, D-017
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff');
insert into public.credential_type (tenant_id, key, name, category, renewal_interval_days) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cpr', 'CPR Certification', 'certification', 365),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tb_screen', 'TB Screening', 'health_screening', 365);
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000e0c9');
select ok(app.backfill_employees() >= 2, 'fixtures: employees materialized');

-- ── Catalog repair + expansion, one idempotent function ────────────────────
select ok(app.expand_credential_catalog('aaaaaaaa-0000-0000-0000-000000000001') = 6,
  'catalog: six new types land');
select is(
  (select renewal_interval_days from public.credential_type
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'cpr'),
  730, 'catalog: the CPR interval is repaired to the AHA two-year cycle');
select ok(
  (select advisor_note is not null from public.credential_type
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'tb_screen'),
  'catalog: the assumed TB interval is flagged for a human, not silently trusted');
select is(app.expand_credential_catalog('aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'catalog: idempotent');
select ok(
  (select not blocks_scheduling from public.credential_type
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and key = 'annual_inservice'),
  'catalog: a training lapse raises an obligation but never unstaffs a visit');

-- ── Staff cadence off hire_date, clinical titles only ──────────────────────
select ok(app.seed_staff_cadence('aaaaaaaa-0000-0000-0000-000000000001') = 2,
  'cadence: the two staff rules land');
update public.employee set hire_date = current_date - interval '400 days'
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';   -- HHA, a year past hire
select is(app.evaluate_staff_compliance(), 1,
  'cadence: the clinical employee owes their annual in-service (Office/Admin owe nothing)');
select is(
  (select (o.due_on, o.status)::text from public.obligation o
    join public.cadence_rule r on r.id = o.cadence_rule_id
   where r.key = 'inservice.annual' and o.staff_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  (((current_date - interval '400 days')::date + interval '12 months')::date, 'open')::text,
  'cadence: due lands twelve months after hire, in the regulation''s units (D-016)');
select is(app.evaluate_staff_compliance(), 0,
  'cadence: one live obligation per rule x employee — no duplicates');

-- ── on_event: the outbox drives obligations (D-016 closure) ────────────────
select lives_ok(
  $$select app.emit_event_system('aaaaaaaa-0000-0000-0000-000000000001',
      'identity.separated', 'app_user',
      'aaaaaaaa-0000-0000-0000-0000000000c1', '{}')$$,
  'on_event: a separation event lands');
select is(
  (select count(*)::int from public.obligation o
    join public.cadence_rule r on r.id = o.cadence_rule_id
   where r.key = 'file_closure.separation'
     and o.staff_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'
     and o.due_on = current_date + 30 and o.status = 'open'),
  1, 'on_event: the file-closure duty materialized in the same transaction, due in 30 days');
select lives_ok(
  $$select app.emit_event_system('aaaaaaaa-0000-0000-0000-000000000001',
      'identity.separated', 'app_user',
      'aaaaaaaa-0000-0000-0000-0000000000c1', '{}')$$,
  'on_event: a replayed event is harmless');
select is(
  (select count(*)::int from public.obligation o
    join public.cadence_rule r on r.id = o.cadence_rule_id
   where r.key = 'file_closure.separation'
     and o.staff_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  1, 'on_event: still exactly one live duty');

reset role;
select * from finish();
rollback;
