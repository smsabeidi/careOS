-- pgTAP · credentials: RLS matrix (tenant × own-record × AAL gating) · append-only
-- credential history · deterministic expiry engine · audit-on-change (invariant 7).
-- Mirrors 002_rls_matrix.sql / 003_append_only.sql conventions. Synthetic only.
-- @trace: E09, M7, ST-030
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic — Meadowbrook conventions) ─────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'cred.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cred.staff.a1@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'cred.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cred Admin A', 'cred.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Staff A1',     'cred.staff.a1@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Cred Admin B', 'cred.admin.b@brookmead.test', 'staff');

-- credential.read.all / .write are inserted by migration 0008; re-assert defensively.
insert into public.permission (key, description) values
  ('credential.read.all', 'test'), ('credential.write', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'credential.read.all'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'credential.write'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'credential.read.all');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');
-- Staff A1 has NO role → exercises the own-credential predicate (app_user_id = auth.uid()).

insert into public.credential_type (id, tenant_id, key, name, category) values
  ('aaaaaaaa-0000-0000-0000-0000000c7001', 'aaaaaaaa-0000-0000-0000-000000000001', 'rn_license', 'RN License', 'license'),
  ('bbbbbbbb-0000-0000-0000-0000000c7001', 'bbbbbbbb-0000-0000-0000-000000000001', 'rn_license', 'RN License', 'license');

-- Credentials inserted as superuser → history + audit triggers fire, each seeding
-- exactly one 'created' event and one audit event.
insert into public.credential
  (id, tenant_id, app_user_id, credential_type_id, identifier, issued_on, expires_on, status) values
  ('aaaaaaaa-0000-0000-0000-000000cd0001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000c7001',
   'RN-A1', current_date - 100, current_date + 200, 'pending'),
  ('aaaaaaaa-0000-0000-0000-000000cd0002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-0000000c7001',
   'RN-A2', current_date - 300, current_date + 10, 'verified'),
  ('bbbbbbbb-0000-0000-0000-000000cd0001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-0000000c7001',
   'RN-B1', current_date - 800, current_date - 5, 'expired');

-- Session simulator (identical to 002/003).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Structural invariants: RLS enabled+forced on every new table ────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.credential_type'::regclass),
  'credential_type: RLS enabled + forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.credential'::regclass),
  'credential: RLS enabled + forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.credential_event'::regclass),
  'credential_event: RLS enabled + forced');
select ok((select 'security_invoker=true' = any(reloptions) from pg_class where oid = 'public.credential_expiry'::regclass),
  'credential_expiry view is security_invoker (RLS composes through it, no privileged read)');

-- ── Deterministic expiry engine (Engine-1 — pure, no session needed) ────────────
select is(app.credential_expiry_bucket(null),               'valid',         'bucket: no expiry ⇒ valid');
select is(app.credential_expiry_bucket(current_date + 200), 'valid',         'bucket: far future ⇒ valid');
select is(app.credential_expiry_bucket(current_date + 10),  'expiring_soon', 'bucket: within 30d ⇒ expiring_soon');
select is(app.credential_expiry_bucket(current_date),       'expiring_soon', 'bucket: due today ⇒ expiring_soon');
select is(app.credential_expiry_bucket(current_date - 1),   'lapsed',        'bucket: past ⇒ lapsed');

-- ── RLS matrix: credential_type (CFG, tenant-scoped, no AAL gate) ───────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.credential_type), 1,
  'tenant-A user sees only the tenant-A credential type (cross-tenant isolation)');

-- ── RLS matrix: credential (PII + AAL2 hardening D-0008c) ───────────────────────
select is((select count(*)::int from public.credential), 2,
  'admin A (credential.read.all, AAL2) sees both tenant-A credentials and nothing of B');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select is((select count(*)::int from public.credential), 0,
  'same admin at AAL1 sees no credentials (D-0008c: AAL2 for compliance PII)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.credential), 1,
  'unpermissioned staff sees exactly their own credential');
select is((select id from public.credential), 'aaaaaaaa-0000-0000-0000-000000cd0001'::uuid,
  'and it is their own credential row');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.credential), 1,
  'tenant-B admin sees only the tenant-B credential');

-- ── RLS matrix: credential_event (append-only history, same scoping) ────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.credential_event), 2,
  'admin A sees the two tenant-A history events (one auto-created per credential)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.credential_event), 1,
  'staff sees only their own credential history');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.credential_event), 0,
  'AAL1 sees no credential history');

-- ── Expiry view is deterministic AND RLS-scoped through security_invoker ────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select expiry_bucket from public.credential_expiry
             where credential_id = 'aaaaaaaa-0000-0000-0000-000000cd0002'), 'expiring_soon',
  'expiry view buckets a credential due in 10 days as expiring_soon');
select is((select days_to_expiry from public.credential_expiry
             where credential_id = 'aaaaaaaa-0000-0000-0000-000000cd0002'), 10,
  'expiry view reports days_to_expiry deterministically');
select is((select count(*)::int from public.credential_expiry), 2,
  'expiry view is RLS-scoped: tenant-A admin sees 2 rows, none of tenant B');

-- ── Invariant 7: a consequential change appends history + emits audit ───────────
update public.credential
   set status = 'verified',
       verified_by = 'aaaaaaaa-0000-0000-0000-0000000000ad',
       verified_at = now(),
       row_version = row_version + 1
 where id = 'aaaaaaaa-0000-0000-0000-000000cd0001';
select is((select count(*)::int from public.credential_event
             where credential_id = 'aaaaaaaa-0000-0000-0000-000000cd0001'), 2,
  'verifying a credential APPENDS a second (verified) event — history is never overwritten');
select is((select to_status from public.credential_event
             where credential_id = 'aaaaaaaa-0000-0000-0000-000000cd0001'
               and event_type = 'verified'), 'verified',
  'the appended event records the verified transition (from pending)');

reset role;
select ok(exists(
  select 1 from audit.audit_event
   where entity_type = 'credential' and action = 'credential.verified'
     and entity_id = 'aaaaaaaa-0000-0000-0000-000000cd0001'),
  'a credential.verified audit event was emitted in the same transaction (invariant 7)');

-- ── Append-only: even a superuser cannot mutate history (trigger layer) ─────────
select throws_like(
  $$update public.credential_event set to_status = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%', 'credential_event UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.credential_event$$,
  '%CAREOS_APPEND_ONLY%', 'credential_event DELETE raises CAREOS_APPEND_ONLY');

-- ── Privilege layer: no client write path to history or catalog ─────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_ok(
  $$insert into public.credential_event (tenant_id, credential_id, app_user_id, event_type, to_status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000cd0002',
            'aaaaaaaa-0000-0000-0000-0000000000ad', 'created', 'pending')$$,
  '42501', null,
  'authenticated cannot INSERT credential_event directly (trigger-written only)');
select throws_ok(
  $$insert into public.credential_type (tenant_id, key, name, category)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'x', 'X', 'license')$$,
  '42501', null,
  'authenticated cannot INSERT credential_type (catalog is admin-seeded, no write grant)');

-- Unpermissioned staff cannot create a credential (RLS with-check rejects loudly).
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_ok(
  $$insert into public.credential (tenant_id, app_user_id, credential_type_id, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
            'aaaaaaaa-0000-0000-0000-0000000c7001', 'pending')$$,
  '42501', null,
  'staff without credential.write cannot insert a credential');

-- Cross-tenant write is silently filtered by RLS (zero rows, not an error).
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
update public.credential set note = 'HACKED'
 where id = 'aaaaaaaa-0000-0000-0000-000000cd0002';
reset role;
select is((select note from public.credential where id = 'aaaaaaaa-0000-0000-0000-000000cd0002'),
  null::text, 'tenant-B admin cannot update a tenant-A credential (RLS filtered the write)');

select * from finish();
rollback;
