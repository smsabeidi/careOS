-- pgTAP · document store: record path, self/desk reads, storage RLS twin, sweep
-- @trace: ST-132
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
  ('document.write', 'test'), ('staff.manage', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'document.write'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'staff.manage'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'staff.manage');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

select ok(app.backfill_employees() >= 4, 'fixtures: employee rows materialized');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── record_document: the only write path, idempotent by natural key ────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.record_document('hr-docs',
      'aaaaaaaa-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-0000000000c1/cpr-card.pdf',
      'deadbeef', 'pii',
      p_employee => 'aaaaaaaa-0000-0000-0000-0000000000c1')$$,
  'document: admin with document.write records an HR document');
select is(
  (select app.record_document('hr-docs',
      'aaaaaaaa-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-0000000000c1/cpr-card.pdf',
      'deadbeef', 'pii',
      p_employee => 'aaaaaaaa-0000-0000-0000-0000000000c1')),
  (select id from public.document where storage_path like '%cpr-card.pdf'),
  'document: re-recording the same path+hash returns the same id (idempotent)');
select throws_like(
  $$select app.record_document('hr-docs',
      'aaaaaaaa-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-0000000000c1/cpr-card.pdf',
      '0badf00d', 'pii')$$,
  '%CAREOS_CONFLICT%',
  'document: the same path with different content is refused');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.record_document('hr-docs', 'aaaaaaaa-0000-0000-0000-000000000001/x/y.pdf',
      'deadbeef', 'pii')$$,
  '%CAREOS_FORBIDDEN%',
  'document: a caregiver without document.write cannot record');

-- ── Read scoping ───────────────────────────────────────────────────────────
select is((select count(*)::int from public.document), 1,
  'document +: the subject employee reads their own file');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.document), 0,
  'document -: another caregiver sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.document), 0,
  'document -: AAL1 sees nothing');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.document), 0,
  'document -: tenant isolation holds');

-- ── Storage RLS twin ───────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('hr-docs',
      'aaaaaaaa-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-0000000000c1/cpr-card.pdf')$$,
  'storage: document.write + matching tenant folder may upload into hr-docs');
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('hr-docs',
      'bbbbbbbb-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-0000000000c1/evil.pdf')$$,
  '42501', null,
  'storage: a path outside the session tenant folder is refused');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'hr-docs'
    and (storage.foldername(name))[2] = 'aaaaaaaa-0000-0000-0000-0000000000c1'), 1,
  'storage: the subject reads their own object row (signed-URL path)');
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('hr-docs',
      'aaaaaaaa-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-0000000000c1/self.pdf')$$,
  '42501', null,
  'storage: no document.write ⇒ no upload, even into one''s own folder');

-- ── Write posture + sweep ──────────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.document', 'insert'),
  'document: authenticated has no direct INSERT grant');
select ok(not has_table_privilege('authenticated', 'public.document', 'delete'),
  'document: authenticated has no DELETE grant');
select ok(not has_function_privilege('authenticated', 'app.retention_sweep(date)', 'execute'),
  'document: authenticated cannot run the retention sweep');

reset role;
-- Age one document past retention; hold another.
insert into public.document (tenant_id, bucket, storage_path, sha256, classification,
                             retention_until, legal_hold, employee_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'hr-docs', 'a/expired.pdf', '\xdead', 'ops',
   current_date - 1, false, 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'hr-docs', 'a/held.pdf', '\xbeef', 'ops',
   current_date - 1, true, null);
select is((app.retention_sweep() ->> 'swept')::int, 1,
  'sweep p1: exactly the expired, unheld document is stamped for destruction');
select ok(
  (select destroy_requested_at is not null from public.document
    where storage_path = 'a/expired.pdf'),
  'sweep p1: the expired document carries its destruction stamp');
select ok(
  (select destroy_requested_at is null from public.document
    where storage_path = 'a/held.pdf'),
  'sweep p1: legal_hold survives retention untouched');
select is((app.retention_sweep() ->> 'swept')::int, 0,
  'sweep p1: idempotent — a second pass stamps nothing new');
select is(
  (select count(*)::int from public.domain_event where event_type = 'document.destroy'), 1,
  'sweep p1: the destruction request is on the outbox for the worker');

-- A stamped document is unreachable even by its subject, before the blob is gone.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is(
  (select count(*)::int from public.document where storage_path = 'a/expired.pdf'), 0,
  'sweep p1: the stamped document is invisible to its subject at commit');

reset role;
-- Phase 2: the worker (blob destroyed via Storage API) completes the row deletion.
select throws_like(
  $$select app.complete_document_destruction(
      (select id from public.document where storage_path = 'a/held.pdf'))$$,
  '%CAREOS_BAD_STATE%',
  'sweep p2: an unstamped document cannot be deleted — no reachable→gone shortcut');
select lives_ok(
  $$select app.complete_document_destruction(
      (select id from public.document where storage_path = 'a/expired.pdf'))$$,
  'sweep p2: the worker completes the stamped destruction');
select is((select count(*)::int from public.document where storage_path = 'a/expired.pdf'), 0,
  'sweep p2: the metadata row is gone');
select is(
  (select count(*)::int from audit.audit_event
    where action in ('document.destruction_requested','document.swept')), 2,
  'sweep: both phases of the destruction are on the audit ledger');

reset role;
select * from finish();
rollback;
