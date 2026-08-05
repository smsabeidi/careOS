-- pgTAP · employee: PII policy matrix, write posture, backfill mapping
-- @trace: ST-131
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'rn1.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nurse A1', 'rn1.a@meadowbrook.test', 'staff', 'separated'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff', 'active');

insert into public.permission (key, description) values
  ('staff.manage', 'test'), ('credential.read.all', 'test'), ('user.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver'),
  ('aaaaaaaa-0000-0000-0000-00000000e0e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'rn', 'Registered Nurse'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'staff.manage'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'staff.manage');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000e0c9'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000e0e1'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

-- ── Backfill mapping ───────────────────────────────────────────────────────
select is(app.backfill_employees(), 4,
  'backfill: one employee row per kind=staff app_user');
select is(app.backfill_employees(), 0,
  'backfill: idempotent — the second pass inserts nothing');
select is(
  (select role_title from public.employee where id = 'aaaaaaaa-0000-0000-0000-0000000000e1'),
  'RN', 'backfill: an rn-role user maps to the RN title');
select is(
  (select role_title from public.employee where id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  'HHA', 'backfill: a caregiver-role user maps to the HHA title');
select is(
  (select role_title from public.employee where id = 'aaaaaaaa-0000-0000-0000-0000000000ad'),
  'Office', 'backfill: office-only roles map to the Office title (DN-0028a)');
select is(
  (select employment_status from public.employee where id = 'aaaaaaaa-0000-0000-0000-0000000000e1'),
  'separated', 'backfill: a separated app_user maps to separated employment');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Policy matrix ──────────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.employee), 3,
  'employee +: staff.manage (AAL2) reads the whole tenant book — and nothing of B');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.employee), 1,
  'employee +: a caregiver reads exactly their own employment record');
select is(
  (select id from public.employee), 'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
  'employee +: and it is their own');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.employee), 0,
  'employee -: AAL1 sees nothing (PII ⇒ AAL2)');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.employee
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'employee -: tenant isolation holds');

-- ── Write posture: Lane-B only ─────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.employee', 'insert'),
  'employee: authenticated has no INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.employee', 'update'),
  'employee: authenticated has no UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.employee', 'delete'),
  'employee: authenticated has no DELETE grant');
select ok(not has_function_privilege('authenticated', 'app.backfill_employees()', 'execute'),
  'employee: the backfill helper is migration/seed plumbing, not client-callable');

reset role;
select * from finish();
rollback;
