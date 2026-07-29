-- pgTAP · AI plane (0014): RLS enabled+forced on the three tables, the DB-enforced
-- autonomy-tier rule (T2/T3 must require a human — invariant 8), knowledge-corpus tenant
-- scoping, and the append-only ai_interaction ledger with self-pinned inserts (invariant 10).
-- Style mirrors 0011/0012/0013.
-- @trace: docs/05, docs/11, invariants 8/10
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-0000000000ad', 'ai.admin.a@meadowbrook.test'),
  ('eeeeeeee-0000-0000-0000-0000000000c1', 'ai.staff.a@meadowbrook.test'),
  ('eeeeeeee-0000-0000-0000-0000000000bd', 'ai.admin.b@brookmead.test');
insert into public.tenant (id, name) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'AI Tenant A'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'AI Tenant B');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('eeeeeeee-0000-0000-0000-0000000000ad', 'eeeeeeee-0000-0000-0000-000000000001', 'AI Admin A', 'ai.admin.a@meadowbrook.test', 'staff'),
  ('eeeeeeee-0000-0000-0000-0000000000c1', 'eeeeeeee-0000-0000-0000-000000000001', 'AI Staff A',  'ai.staff.a@meadowbrook.test', 'staff'),
  ('eeeeeeee-0000-0000-0000-0000000000bd', 'eeeeeeee-0000-0000-0000-000000000002', 'AI Admin B', 'ai.admin.b@brookmead.test', 'staff');
insert into public.permission (key, description) values ('ai.read','test') on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('eeeeeeee-0000-0000-0000-00000000e0ad', 'eeeeeeee-0000-0000-0000-000000000001', 'ai_admin', 'AI Admin');
insert into public.role_permission (role_id, permission_key) values
  ('eeeeeeee-0000-0000-0000-00000000e0ad', 'ai.read');
insert into public.user_role (user_id, role_id) values
  ('eeeeeeee-0000-0000-0000-0000000000ad', 'eeeeeeee-0000-0000-0000-00000000e0ad');

insert into public.knowledge_document (id, tenant_id, title, body, category) values
  ('eeeeeeee-0000-0000-0000-0000000d0001', 'eeeeeeee-0000-0000-0000-000000000001', 'Fall prevention', 'Keep paths clear.', 'policy');
-- One interaction, created by staff A.
insert into public.ai_interaction
  (id, tenant_id, capability_key, provider, model, tier, status, tokens_in, tokens_out, cost_usd, input_digest, output_digest, created_by) values
  ('eeeeeeee-0000-0000-0000-0000000a0001', 'eeeeeeee-0000-0000-0000-000000000001', 'brain.answer', 'mock', 'gpt-4o-mini (mock)', 'T1', 'ok', 100, 40, 0.0001, 'q', 'a', 'eeeeeeee-0000-0000-0000-0000000000c1');

-- RLS enabled + forced on all three.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('ai_capability','knowledge_document','ai_interaction')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS enabled + forced on ai_capability, knowledge_document, ai_interaction');

-- ── Invariant 8, DB-enforced: a T2 capability cannot skip the human ─────────
select throws_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'bad.auto', 'Bad', 'T2', false)$$,
  '23514', null,
  'ai_capability -: a T2 capability with requires_human=false violates the tier-human CHECK');
-- T1 may be autonomous (allowed).
select lives_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'ok.t1', 'OK', 'T1', false)$$,
  'ai_capability +: a T1 capability may be autonomous');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── knowledge_document: tenant-scoped read ─────────────────────────────────
select pg_temp.login('eeeeeeee-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.knowledge_document), 1,
  'knowledge_document +: staff in the tenant sees the active policy doc');
reset role;
select pg_temp.login('eeeeeeee-0000-0000-0000-0000000000bd', 'aal2');
select is((select count(*)::int from public.knowledge_document), 0,
  'knowledge_document -: staff in another tenant sees nothing (tenant isolation)');

-- ── ai_interaction: own vs ai.read vs other-tenant ─────────────────────────
reset role;
select pg_temp.login('eeeeeeee-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.ai_interaction), 1,
  'ai_interaction +: the creator sees their own logged call');
reset role;
select pg_temp.login('eeeeeeee-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.ai_interaction), 1,
  'ai_interaction +: a holder of ai.read sees tenant AI activity');
reset role;
select pg_temp.login('eeeeeeee-0000-0000-0000-0000000000bd', 'aal2');
select is((select count(*)::int from public.ai_interaction), 0,
  'ai_interaction -: another tenant sees nothing');

-- ── ai_interaction insert is self-pinned (created_by must be auth.uid()) ────
reset role;
select pg_temp.login('eeeeeeee-0000-0000-0000-0000000000c1', 'aal2');
select lives_ok(
  $$insert into public.ai_interaction (tenant_id, capability_key, tier, status, created_by)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'brain.answer', 'T1', 'ok',
            'eeeeeeee-0000-0000-0000-0000000000c1')$$,
  'ai_interaction +: a user logs their OWN call');
select throws_ok(
  $$insert into public.ai_interaction (tenant_id, capability_key, tier, status, created_by)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'brain.answer', 'T1', 'ok',
            'eeeeeeee-0000-0000-0000-0000000000ad')$$,
  '42501', null,
  'ai_interaction -: a user cannot log a call attributed to someone else');

-- ── ai_interaction is append-only ─────────────────────────────────────────
reset role;
select throws_like($$update public.ai_interaction set status = 'error'$$, '%CAREOS_APPEND_ONLY%',
  'ai_interaction UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.ai_interaction$$, '%CAREOS_APPEND_ONLY%',
  'ai_interaction DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.ai_interaction', 'update'),
  'authenticated has no UPDATE grant on ai_interaction (append-only)');
select ok(not has_table_privilege('authenticated', 'public.ai_interaction', 'delete'),
  'authenticated has no DELETE grant on ai_interaction (append-only)');

reset role;
select * from finish();
rollback;
