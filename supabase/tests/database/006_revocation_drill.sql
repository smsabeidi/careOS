-- pgTAP · Revocation drill: separation and tenant suspension fail closed mid-token,
-- across the SELF-SCOPED policy branches S3-1 flagged (own credential, own visit/shift,
-- own app_user row) — not just care-team scope, which 002 already drills.
-- The mechanism under test is the active-principal contract of app.current_tenant_id()
-- (0022): non-active principal ⇒ NULL tenant context ⇒ every tenant-pinned policy closes.
-- @trace: ST-120, S3-1, docs/09 §2 (revocation control evidence)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('user.read', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'user.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'user.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');

insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

insert into public.credential_type (id, tenant_id, key, name, category) values
  ('aaaaaaaa-0000-0000-0000-00000000c701', 'aaaaaaaa-0000-0000-0000-000000000001',
   'cpr', 'CPR Certification', 'certification');
insert into public.credential (id, tenant_id, app_user_id, credential_type_id, status, expires_on) values
  ('aaaaaaaa-0000-0000-0000-00000000c801', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000c701',
   'verified', current_date + 180);

insert into public.shift (id, tenant_id, caregiver_id, starts_at, ends_at) values
  ('aaaaaaaa-0000-0000-0000-00000000af01', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', now() + interval '1 day', now() + interval '1 day 8 hours');

insert into public.visit (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end) values
  ('aaaaaaaa-0000-0000-0000-00000000ae01', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() + interval '1 day', now() + interval '1 day 2 hours');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Baseline: the active caregiver sees own-scoped rows ────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select ok(app.is_active_user(), 'active caregiver: is_active_user() true');
select is((select count(*)::int from public.app_user where id = auth.uid()), 1,
  'active caregiver reads own app_user row');
select is((select count(*)::int from public.credential), 1,
  'active caregiver reads own credential');
select is((select count(*)::int from public.visit), 1,
  'active caregiver reads own visit');
select is((select count(*)::int from public.shift), 1,
  'active caregiver reads own shift');
select is((select count(*)::int from public.user_role where user_id = auth.uid()), 0,
  'caregiver holds no roles (fixture sanity)');

-- ── Separate the caregiver; SAME still-valid session must go dark ──────────
reset role;
update public.app_user set status = 'separated', separated_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select ok(not app.is_active_user(), 'separated: is_active_user() false');
select ok(app.current_tenant_id() is null, 'separated: tenant context is NULL');
select is((select count(*)::int from public.app_user), 0,
  'separated: own app_user row is gone mid-token');
select is((select count(*)::int from public.credential), 0,
  'separated: own credential is gone mid-token (S3-1 residue closed)');
select is((select count(*)::int from public.visit), 0,
  'separated: own visit is gone mid-token');
select is((select count(*)::int from public.shift), 0,
  'separated: own shift is gone mid-token');

-- ── user_role: tenant isolation of the repaired policy ─────────────────────
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.user_role), 1,
  'tenant-B admin (user.read) sees only tenant-B role grants — tenant predicate holds');

-- ── Tenant suspension fails the whole tenant closed ────────────────────────
reset role;
update public.tenant set status = 'suspended'
 where id = 'bbbbbbbb-0000-0000-0000-000000000001';

select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select ok(app.current_tenant_id() is null, 'suspended tenant: tenant context is NULL');
select is((select count(*)::int from public.app_user), 0,
  'suspended tenant: admin sees no users, not even self');
select is((select count(*)::int from public.user_role), 0,
  'suspended tenant: role grants invisible');

reset role;
select * from finish();
rollback;
