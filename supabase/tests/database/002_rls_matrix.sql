-- pgTAP · RLS matrix: tenant isolation × care-team scoping × AAL gating on client
-- @trace: ST-012, FR-X-010
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'cg2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A2', 'cg2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('client.read.all', 'test'), ('client.write', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'client.read.all'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'client.write'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'client.read.all');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'Two'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001', 'Client', 'Bee');

insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Matrix assertions ──────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.client), 2,
  'admin A (client.read.all, AAL2) sees both tenant-A clients and nothing of B');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.client), 1,
  'assigned caregiver (AAL2) sees exactly the assigned client');
select is((select id from public.client), 'aaaaaaaa-0000-0000-0000-00000000c001'::uuid,
  'and it is the right client');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.client), 0,
  'same caregiver at AAL1 sees nothing (invariant 3: AAL2 for PHI)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.client), 0,
  'unassigned caregiver sees nothing');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.client), 1,
  'tenant-B admin sees only tenant-B clients');

-- Cross-tenant write: silently zero rows (RLS), not an error
update public.client set city = 'HACKED'
 where id = 'aaaaaaaa-0000-0000-0000-00000000c001';
reset role;
select is((select city from public.client where id = 'aaaaaaaa-0000-0000-0000-00000000c001'),
  null::text, 'tenant-B admin cannot update a tenant-A client (RLS filtered the write)');
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');

-- Unpermissioned insert: RLS with-check rejects loudly
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_ok(
  $$insert into public.client (tenant_id, first_name, last_name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'No', 'Perm')$$,
  '42501', null,
  'caregiver without client.write cannot insert a client');

-- Separated user loses assignment scope immediately (D-011 / finding S3-1)
reset role;
update public.app_user set status = 'separated', separated_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.client), 0,
  'separated caregiver sees nothing even with a still-valid session');

reset role;
select * from finish();
rollback;
