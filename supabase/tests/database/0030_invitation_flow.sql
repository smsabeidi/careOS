-- pgTAP · invitation flow: invite → accept binds the account; token, email, expiry,
-- revocation and duplicate guards; desk-only reads; Lane-B write posture.
-- @trace: ST-133
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'new.hire@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-00000000f002', 'wrong.person@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-00000000f003', 'expired.hire@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('staff.manage', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'staff.manage');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad');

-- Session simulator (with email claim — accept_invitation matches on it)
create function pg_temp.login_e(p_user uuid, p_aal text, p_email text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal,
                      'email', p_email)::text, true);
end $$;

-- Raw invite tokens (test-only): the RPC stores sha256(token); links carry the raw.
-- t1 = repeat('11'), t2 = repeat('22') expired, t3 = repeat('33') revoked.

-- ── Invite ─────────────────────────────────────────────────────────────────
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2', 'admin.a@meadowbrook.test');
select lives_ok(
  $$select app.invite_staff('new.hire@meadowbrook.test', 'New Hire',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('11', 32), 'hex')), 'hex'))$$,
  'invite: staff.manage invites a new hire');
select throws_like(
  $$select app.invite_staff('new.hire@meadowbrook.test', 'New Hire Again',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('aa', 32), 'hex')), 'hex'))$$,
  '%CAREOS_DUPLICATE%',
  'invite: a second pending invitation for the same email is refused');
select throws_like(
  $$select app.invite_staff('cg1.a@meadowbrook.test', 'Existing Person',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('bb', 32), 'hex')), 'hex'))$$,
  '%CAREOS_ALREADY_ENROLLED%',
  'invite: an email already on an active account is refused');
select throws_like(
  $$select app.invite_staff('other.hire@meadowbrook.test', 'Other Hire',
      'bbbbbbbb-0000-0000-0000-00000000e0ad', 'Office',
      encode(sha256(decode(repeat('cc', 32), 'hex')), 'hex'))$$,
  '%CAREOS_NOT_FOUND%',
  'invite: a cross-tenant role id is refused');

reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2', 'cg1.a@meadowbrook.test');
select throws_like(
  $$select app.invite_staff('x@meadowbrook.test', 'X',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('dd', 32), 'hex')), 'hex'))$$,
  '%CAREOS_FORBIDDEN%',
  'invite: no staff.manage ⇒ no invitations');
select is((select count(*)::int from public.invitation), 0,
  'invite: the desk list is invisible without staff.manage');

-- ── Accept ─────────────────────────────────────────────────────────────────
reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-00000000f001', 'aal1', 'new.hire@meadowbrook.test');
select throws_like(
  $$select app.accept_invitation(repeat('44', 32))$$,
  '%CAREOS_NOT_FOUND%',
  'accept: a wrong token finds nothing');

reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-00000000f002', 'aal1', 'wrong.person@meadowbrook.test');
select throws_like(
  $$select app.accept_invitation(repeat('11', 32))$$,
  '%CAREOS_EMAIL_MISMATCH%',
  'accept: the right token from the wrong account is refused');

reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-00000000f001', 'aal1', 'new.hire@meadowbrook.test');
select lives_ok(
  $$select app.accept_invitation(repeat('11', 32))$$,
  'accept: the invitee binds their account at AAL1 (no PHI exposed)');
select throws_like(
  $$select app.accept_invitation(repeat('11', 32))$$,
  '%CAREOS_%',
  'accept: a second acceptance is refused');

reset role;
select is(
  (select status from public.app_user where id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  'active', 'accept: the access record is active (PHI still waits on AAL2)');
select is(
  (select (role_title, employment_status, hire_date)::text from public.employee
    where id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  ('HHA', 'onboarding', current_date)::text,
  'accept: the employment record starts in onboarding with the invited title');
select is(
  (select granted_by from public.user_role
    where user_id = 'aaaaaaaa-0000-0000-0000-00000000f001'),
  'aaaaaaaa-0000-0000-0000-0000000000ad'::uuid,
  'accept: the role grant is attributed to the inviting human');
select is(
  (select (status, accepted_user_id)::text from public.invitation
    where lower(email) = 'new.hire@meadowbrook.test'),
  ('accepted', 'aaaaaaaa-0000-0000-0000-00000000f001')::text,
  'accept: the invitation closed onto the new account');
select is(
  (select count(*)::int from audit.audit_event
    where action in ('identity.invited','identity.invitation_accepted','identity.role_granted')),
  3, 'accept: the whole enrollment story is on the audit ledger');

-- ── Expiry + revocation ────────────────────────────────────────────────────
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2', 'admin.a@meadowbrook.test');
select lives_ok(
  $$select app.invite_staff('expired.hire@meadowbrook.test', 'Late Hire',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('22', 32), 'hex')), 'hex'))$$,
  'expiry: a second invitation goes out');
reset role;
update public.invitation set expires_at = now() - interval '1 hour'
 where lower(email) = 'expired.hire@meadowbrook.test';
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-00000000f003', 'aal1', 'expired.hire@meadowbrook.test');
select throws_like(
  $$select app.accept_invitation(repeat('22', 32))$$,
  '%CAREOS_EXPIRED%',
  'expiry: a stale token is refused');

reset role;
select pg_temp.login_e('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2', 'admin.a@meadowbrook.test');
select lives_ok(
  $$select app.invite_staff('revoked.hire@meadowbrook.test', 'Rescinded Hire',
      'aaaaaaaa-0000-0000-0000-00000000e0c9', 'HHA',
      encode(sha256(decode(repeat('33', 32), 'hex')), 'hex'))$$,
  'revoke: a third invitation goes out');
select lives_ok(
  $$select app.revoke_invitation(
      (select id from public.invitation where lower(email) = 'revoked.hire@meadowbrook.test'))$$,
  'revoke: staff.manage rescinds it');
select is(
  (select status from public.invitation where lower(email) = 'revoked.hire@meadowbrook.test'),
  'revoked', 'revoke: the invitation is closed');

-- ── Write posture ──────────────────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.invitation', 'insert'),
  'posture: no direct INSERT on invitation');
select ok(not has_table_privilege('authenticated', 'public.invitation', 'update'),
  'posture: no direct UPDATE on invitation');

reset role;
select * from finish();
rollback;
