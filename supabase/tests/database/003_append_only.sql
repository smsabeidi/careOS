-- pgTAP · append-only probes: UPDATE/DELETE impossible on [AO] tables at both
-- the privilege layer and the trigger layer (docs/07 §1 convention 5)
-- @trace: ST-021, FR-X-001
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fixtures (as postgres; superuser bypasses RLS/grants but NOT triggers)
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'ao.admin@meadowbrook.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'AO Admin', 'ao.admin@meadowbrook.test', 'staff');

select app.emit_audit_system('aaaaaaaa-0000-0000-0000-000000000001', 'system',
  'test.event', 'test_entity', null, '{"n":1}');

insert into public.form_template (id, tenant_id, key, title, schema) values
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'visit_note', 'Visit Note', '{}');
insert into public.form_instance (id, tenant_id, template_id, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000f101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-0000000000ad');
insert into public.form_version
  (id, tenant_id, instance_id, version_no, content, content_hash, author_id, kind) values
  ('aaaaaaaa-0000-0000-0000-00000000f201', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000f101', 1, '{"a":1}',
   extensions.digest(convert_to('{"a": 1}', 'utf8'), 'sha256'),
   'aaaaaaaa-0000-0000-0000-0000000000ad', 'create');
insert into public.signature
  (tenant_id, form_version_id, signer_id, signer_role, content_hash, session_aal) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000f201',
   'aaaaaaaa-0000-0000-0000-0000000000ad', 'rn',
   (select content_hash from public.form_version where id = 'aaaaaaaa-0000-0000-0000-00000000f201'),
   'aal2');

-- ── Trigger layer: even a superuser cannot mutate history ──────────────────
select throws_like(
  $$update audit.audit_event set action = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%', 'audit_event UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from audit.audit_event$$,
  '%CAREOS_APPEND_ONLY%', 'audit_event DELETE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$update public.form_version set content = '{"tampered":true}'$$,
  '%CAREOS_APPEND_ONLY%', 'form_version UPDATE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.form_version$$,
  '%CAREOS_APPEND_ONLY%', 'form_version DELETE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$update public.signature set signer_role = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%', 'signature UPDATE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.signature$$,
  '%CAREOS_APPEND_ONLY%', 'signature DELETE raises CAREOS_APPEND_ONLY');

-- Composite-FK evidence binding: a signature with a wrong hash cannot exist
select throws_ok(
  $$insert into public.signature
      (tenant_id, form_version_id, signer_id, signer_role, content_hash, session_aal)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000f201',
            'aaaaaaaa-0000-0000-0000-0000000000ad', 'rn',
            extensions.digest(convert_to('forged', 'utf8'), 'sha256'), 'aal2')$$,
  '23503', null,
  'a signature whose content_hash does not match its version violates the composite FK');

-- ── Privilege layer: authenticated has no mutation grants at all ───────────
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_ok(
  $$update public.form_version set content = '{}'$$,
  '42501', null, 'authenticated: form_version UPDATE is permission-denied before any trigger fires');
select throws_ok(
  $$insert into public.form_version (tenant_id, instance_id, version_no, content, content_hash, author_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000f101',
            2, '{}', '\x00', 'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  '42501', null, 'authenticated: direct form_version INSERT is permission-denied (RPC only)');
select throws_ok(
  $$update public.form_instance set status = 'draft'$$,
  '42501', null, 'authenticated: form_instance UPDATE is permission-denied (no final→draft path)');

reset role;
select * from finish();
rollback;
