-- pgTAP · RPC guards: the full forms workflow with exact CAREOS_* codes
-- draft → conflict (keep-both) → sign → finalize → locked → correction
-- @trace: ST-021, ST-022, ST-023, FR-M3
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'rn1@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver One', 'cg1@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nurse One', 'rn1@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('form.finalize', 'test'), ('form.correct', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'rn', 'Registered Nurse');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0f1', 'form.finalize');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000e0f1');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

insert into public.form_template (id, tenant_id, key, title, schema, requires_signature_roles) values
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'rn_assessment', 'RN Assessment', '{}', '{rn}');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

create temp table t_state (k text primary key, v uuid);
create temp table t_json (k text primary key, v jsonb);
grant all on t_state, t_json to authenticated;  -- test scaffolding only (temp schema)

-- ── AAL2 gate ──────────────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select throws_like(
  $$select app.create_form('aaaaaaaa-0000-0000-0000-00000000f001',
                           'aaaaaaaa-0000-0000-0000-00000000c001', '{"q1":"x"}')$$,
  '%CAREOS_AAL2_REQUIRED%', 'create_form at AAL1 raises CAREOS_AAL2_REQUIRED');

-- ── Create + draft flow (assigned caregiver, AAL2) ─────────────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
insert into t_state
  select 'inst', app.create_form('aaaaaaaa-0000-0000-0000-00000000f001',
                                 'aaaaaaaa-0000-0000-0000-00000000c001', '{"q1":"first"}');
select ok((select v from t_state where k = 'inst') is not null, 'create_form returns the instance id');

insert into t_state
  select 'v1', fv.id from public.form_version fv
   where fv.instance_id = (select v from t_state where k = 'inst') and fv.version_no = 1;

insert into t_json
  select 'save2', app.save_draft((select v from t_state where k = 'inst'),
                                 '{"q1":"second"}', (select v from t_state where k = 'v1'));
select is((select v->>'conflict' from t_json where k = 'save2'), 'false',
  'save_draft with the current base succeeds');
insert into t_state select 'v2', ((select v->>'version_id' from t_json where k = 'save2'))::uuid;

-- Keep-both: saving against the stale v1 base must conflict, never overwrite
insert into t_json
  select 'stale', app.save_draft((select v from t_state where k = 'inst'),
                                 '{"q1":"concurrent"}', (select v from t_state where k = 'v1'));
select is((select v->>'code' from t_json where k = 'stale'), 'CAREOS_CONFLICT_KEEP_BOTH',
  'save_draft with a stale base returns CAREOS_CONFLICT_KEEP_BOTH');
select is(((select v->>'server_version_id' from t_json where k = 'stale'))::uuid,
  (select v from t_state where k = 'v2'),
  'the conflict payload carries the server version for the merge UX');

-- ── Finalize guards ────────────────────────────────────────────────────────
select throws_like(
  $$select app.finalize_form(
      (select v from t_state where k = 'inst'), (select v from t_state where k = 'v2'))$$,
  '%CAREOS_SIGNATURES_INCOMPLETE%', 'finalize without the required RN signature is blocked');
select throws_like(
  $$select app.finalize_form(
      (select v from t_state where k = 'inst'), (select v from t_state where k = 'v1'))$$,
  '%CAREOS_STALE_VERSION%', 'finalize of a non-latest version is blocked');
select throws_like(
  $$select app.sign_version((select v from t_state where k = 'v2'), 'click')$$,
  '%CAREOS_NOT_AUTHORIZED%', 'a signer without a required role cannot sign');

-- ── RN signs, author finalizes ─────────────────────────────────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000e1', 'aal2');
insert into t_state
  select 'sig', app.sign_version((select v from t_state where k = 'v2'), 'click');
select ok((select v from t_state where k = 'sig') is not null, 'RN signature recorded');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select lives_ok(
  $$select app.finalize_form(
      (select v from t_state where k = 'inst'), (select v from t_state where k = 'v2'))$$,
  'author finalizes once the required signature exists');

reset role;
select is((select status from public.form_instance where id = (select v from t_state where k = 'inst')),
  'final', 'instance is final');
select is((select current_version_id from public.form_instance where id = (select v from t_state where k = 'inst')),
  (select v from t_state where k = 'v2'), 'current_version_id points at the signed version');

-- ── Locked: no edits, corrections only, reason mandatory ───────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.save_draft((select v from t_state where k = 'inst'), '{"q1":"late edit"}',
                          (select v from t_state where k = 'v2'))$$,
  '%CAREOS_INVALID_STATE%', 'save_draft on a finalized instance is blocked');
select throws_like(
  $$select app.finalize_form(
      (select v from t_state where k = 'inst'), (select v from t_state where k = 'v2'))$$,
  '%CAREOS_INVALID_STATE%', 're-finalize is blocked');
select throws_like(
  $$select app.correct_form((select v from t_state where k = 'inst'), '{"q1":"fixed"}', '  ')$$,
  '%CAREOS_REASON_REQUIRED%', 'correction without a reason is blocked');
insert into t_state
  select 'v3', app.correct_form((select v from t_state where k = 'inst'),
                                '{"q1":"fixed"}', 'wrong date entered');
select ok((select v from t_state where k = 'v3') is not null, 'correction creates a new version');

reset role;
select is((select kind from public.form_version where id = (select v from t_state where k = 'v3')),
  'correction', 'correction version has kind=correction');
select is((select note from public.form_version where id = (select v from t_state where k = 'v3')),
  'wrong date entered', 'correction carries its mandatory reason');
select is((select status from public.form_instance where id = (select v from t_state where k = 'inst')),
  'final', 'instance stays final after a correction (append-only, no reopen)');

-- ── Tenant isolation on the RPC surface ────────────────────────────────────
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.finalize_form(
      (select v from t_state where k = 'inst'), (select v from t_state where k = 'v3'))$$,
  '%CAREOS_NOT_FOUND%', 'a tenant-B user cannot touch a tenant-A instance through the RPCs');

-- ── Audit trail exists for every consequential action ──────────────────────
reset role;
select is(
  (select count(*)::int from audit.audit_event
    where entity_id = (select v from t_state where k = 'inst')
      and action in ('form.create','form.finalize','form.correct')),
  3, 'create/finalize/correct each emitted an audit event');
select is(
  (select count(*)::int from audit.audit_event
    where entity_id = (select v from t_state where k = 'v2') and action = 'form.sign'),
  1, 'sign emitted an audit event');
select results_eq(
  $$select ok from audit.verify_chain('aaaaaaaa-0000-0000-0000-000000000001')$$,
  $$values (true)$$,
  'the audit chain verifies after the whole workflow');

select * from finish();
rollback;
