-- pgTAP · AI governance (0015): RLS enabled+forced on the four new tables, the
-- append-only + self-pinned ai_disposition flywheel (invariant 8), huddle_brief
-- AAL2 + role scoping (invariant 3), prompt-registry read-only posture, chunk-corpus
-- tenant scoping + gated insert, and the 0014 tier-human CHECK still intact after
-- the ai_capability ALTER. Style mirrors 0014.
-- @trace: docs/16 Wave 0, D-013, invariants 3/8/9/10
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('ffffffff-0000-0000-0000-0000000000ad', 'gov.admin.a@meadowbrook.test'),   -- ai.read + ai.manage
  ('ffffffff-0000-0000-0000-0000000000f1', 'gov.owner.a@meadowbrook.test'),   -- role: owner
  ('ffffffff-0000-0000-0000-0000000000c9', 'gov.cg.a@meadowbrook.test'),      -- role: caregiver
  ('ffffffff-0000-0000-0000-0000000000bd', 'gov.admin.b@brookmead.test');     -- tenant B
insert into public.tenant (id, name) values
  ('ffffffff-0000-0000-0000-000000000001', 'Gov Tenant A'),
  ('ffffffff-0000-0000-0000-000000000002', 'Gov Tenant B');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('ffffffff-0000-0000-0000-0000000000ad', 'ffffffff-0000-0000-0000-000000000001', 'Gov Admin A', 'gov.admin.a@meadowbrook.test', 'staff'),
  ('ffffffff-0000-0000-0000-0000000000f1', 'ffffffff-0000-0000-0000-000000000001', 'Gov Owner A', 'gov.owner.a@meadowbrook.test', 'staff'),
  ('ffffffff-0000-0000-0000-0000000000c9', 'ffffffff-0000-0000-0000-000000000001', 'Gov Caregiver A', 'gov.cg.a@meadowbrook.test', 'staff'),
  ('ffffffff-0000-0000-0000-0000000000bd', 'ffffffff-0000-0000-0000-000000000002', 'Gov Admin B', 'gov.admin.b@brookmead.test', 'staff');
insert into public.permission (key, description) values
  ('ai.read','test'), ('ai.manage','test') on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('ffffffff-0000-0000-0000-00000000e0ad', 'ffffffff-0000-0000-0000-000000000001', 'ai_admin',  'AI Admin'),
  ('ffffffff-0000-0000-0000-00000000e001', 'ffffffff-0000-0000-0000-000000000001', 'owner',     'Owner'),
  ('ffffffff-0000-0000-0000-00000000e005', 'ffffffff-0000-0000-0000-000000000001', 'caregiver', 'Caregiver');
insert into public.role_permission (role_id, permission_key) values
  ('ffffffff-0000-0000-0000-00000000e0ad', 'ai.read'),
  ('ffffffff-0000-0000-0000-00000000e0ad', 'ai.manage');
insert into public.user_role (user_id, role_id) values
  ('ffffffff-0000-0000-0000-0000000000ad', 'ffffffff-0000-0000-0000-00000000e0ad'),
  ('ffffffff-0000-0000-0000-0000000000f1', 'ffffffff-0000-0000-0000-00000000e001'),
  ('ffffffff-0000-0000-0000-0000000000c9', 'ffffffff-0000-0000-0000-00000000e005');

-- Fixtures: a corpus doc + chunk, a logged interaction (by the caregiver), a prompt
-- template row, and two role-wide huddle briefs (owner + caregiver editions).
insert into public.knowledge_document (id, tenant_id, title, body, category) values
  ('ffffffff-0000-0000-0000-0000000d0001', 'ffffffff-0000-0000-0000-000000000001', 'Fall prevention', 'Keep paths clear. Report falls immediately.', 'policy');
insert into public.knowledge_chunk (id, tenant_id, document_id, seq, content) values
  ('ffffffff-0000-0000-0000-0000000c0001', 'ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000d0001', 0, 'Fall prevention — Keep paths clear.');
insert into public.ai_interaction
  (id, tenant_id, capability_key, provider, model, tier, status, tokens_in, tokens_out, cost_usd, input_digest, output_digest, created_by) values
  ('ffffffff-0000-0000-0000-0000000a0001', 'ffffffff-0000-0000-0000-000000000001', 'note.voice_draft', 'mock', 'gpt-5.6-luna (mock)', 'T2', 'ok', 100, 40, 0.0001, 'transcript digest', 'draft digest', 'ffffffff-0000-0000-0000-0000000000c9');
insert into public.ai_prompt_template (tenant_id, capability_key, version, system_prompt) values
  ('ffffffff-0000-0000-0000-000000000001', 'brain.answer', 1, 'test prompt v1');
insert into public.huddle_brief (id, tenant_id, role_key, for_user, brief_date, facts, generated_by) values
  ('ffffffff-0000-0000-0000-0000000b0001', 'ffffffff-0000-0000-0000-000000000001', 'owner',     null, current_date, '{"callouts":1}', 'ffffffff-0000-0000-0000-0000000000ad'),
  ('ffffffff-0000-0000-0000-0000000b0002', 'ffffffff-0000-0000-0000-000000000001', 'caregiver', null, current_date, '{"visits":3}',   'ffffffff-0000-0000-0000-0000000000ad'),
  ('ffffffff-0000-0000-0000-0000000b0003', 'ffffffff-0000-0000-0000-000000000001', 'caregiver',
   'ffffffff-0000-0000-0000-0000000000ad', current_date, '{"visits":1}', 'ffffffff-0000-0000-0000-0000000000ad');

-- ── RLS enabled + forced on all four new tables ────────────────────────────
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('ai_prompt_template','ai_disposition','huddle_brief','knowledge_chunk')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS enabled + forced on ai_prompt_template, ai_disposition, huddle_brief, knowledge_chunk');

-- ── ai_capability: governance columns exist; tier-human CHECK still intact ──
select has_column('public', 'ai_capability', 'model',              'ai_capability has the model pin column');
select has_column('public', 'ai_capability', 'enabled',            'ai_capability has the enabled kill switch');
select has_column('public', 'ai_capability', 'monthly_budget_usd', 'ai_capability has the monthly budget cap');
select throws_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('ffffffff-0000-0000-0000-000000000001', 'bad.auto', 'Bad', 'T2', false)$$,
  '23514', null,
  'ai_capability -: the tier-human CHECK survives the ALTER (T2 cannot skip the human)');

-- ── huddle_brief: constraint probes (role vocabulary, one-brief-per-day) ────
select throws_ok(
  $$insert into public.huddle_brief (tenant_id, role_key, brief_date, facts, generated_by)
    values ('ffffffff-0000-0000-0000-000000000001', 'family', current_date, '{}',
            'ffffffff-0000-0000-0000-0000000000ad')$$,
  '23514', null,
  'huddle_brief -: role_key outside owner/coordinator/rn/caregiver is rejected');
select throws_ok(
  $$insert into public.huddle_brief (tenant_id, role_key, brief_date, facts, generated_by)
    values ('ffffffff-0000-0000-0000-000000000001', 'owner', current_date, '{}',
            'ffffffff-0000-0000-0000-0000000000ad')$$,
  '23505', null,
  'huddle_brief -: a second role-wide owner brief for the same day violates the unique index');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── ai_prompt_template: tenant-read, no client write path ──────────────────
select pg_temp.login('ffffffff-0000-0000-0000-0000000000c9', 'aal2');
select is((select count(*)::int from public.ai_prompt_template), 1,
  'ai_prompt_template +: staff in the tenant read the prompt registry');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000bd', 'aal2');
select is((select count(*)::int from public.ai_prompt_template), 0,
  'ai_prompt_template -: another tenant sees nothing (tenant isolation)');
reset role;
select ok(not has_table_privilege('authenticated', 'public.ai_prompt_template', 'insert'),
  'ai_prompt_template -: authenticated has no INSERT grant (admin RPC only)');
select ok(not has_table_privilege('authenticated', 'public.ai_prompt_template', 'update'),
  'ai_prompt_template -: authenticated has no UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.ai_prompt_template', 'delete'),
  'ai_prompt_template -: authenticated has no DELETE grant');

-- ── huddle_brief: AAL2 gate + role scoping ─────────────────────────────────
select pg_temp.login('ffffffff-0000-0000-0000-0000000000f1', 'aal2');
select is((select count(*)::int from public.huddle_brief), 1,
  'huddle_brief +: an owner-role user sees exactly the role-wide owner edition');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000c9', 'aal2');
select is((select count(*)::int from public.huddle_brief where role_key = 'owner'), 0,
  'huddle_brief -: a caregiver cannot read the owner brief (role scoping)');
select is((select count(*)::int from public.huddle_brief), 1,
  'huddle_brief +: a caregiver sees only the role-wide caregiver edition (not a colleague''s per-user edition)');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000f1', 'aal1');
select is((select count(*)::int from public.huddle_brief), 0,
  'huddle_brief -: an AAL1 session sees no briefs (PHI requires AAL2)');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.huddle_brief), 3,
  'huddle_brief +: ai.read oversight (and the per-user recipient) sees all editions');
-- Insert is self-pinned: the generator records the brief as themselves.
select lives_ok(
  $$insert into public.huddle_brief (tenant_id, role_key, brief_date, facts, generated_by)
    values ('ffffffff-0000-0000-0000-000000000001', 'rn', current_date, '{"visits":2}',
            'ffffffff-0000-0000-0000-0000000000ad')$$,
  'huddle_brief +: a generator inserts a brief pinned to themselves');
select throws_ok(
  $$insert into public.huddle_brief (tenant_id, role_key, brief_date, facts, generated_by)
    values ('ffffffff-0000-0000-0000-000000000001', 'coordinator', current_date, '{}',
            'ffffffff-0000-0000-0000-0000000000c9')$$,
  '42501', null,
  'huddle_brief -: generated_by cannot be pinned to someone else');
reset role;
-- Append-only.
select throws_like($$update public.huddle_brief set narrative = 'edited'$$, '%CAREOS_APPEND_ONLY%',
  'huddle_brief UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.huddle_brief$$, '%CAREOS_APPEND_ONLY%',
  'huddle_brief DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.huddle_brief', 'update'),
  'authenticated has no UPDATE grant on huddle_brief (append-only)');
select ok(not has_table_privilege('authenticated', 'public.huddle_brief', 'delete'),
  'authenticated has no DELETE grant on huddle_brief (append-only)');

-- ── ai_disposition: self-pinned insert, scoped read, append-only ───────────
select pg_temp.login('ffffffff-0000-0000-0000-0000000000c9', 'aal2');
select lives_ok(
  $$insert into public.ai_disposition (tenant_id, ai_interaction_id, capability_key, action, edited_digest, disposed_by)
    values ('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000a0001',
            'note.voice_draft', 'edited', 'trimmed the mood section', 'ffffffff-0000-0000-0000-0000000000c9')$$,
  'ai_disposition +: the author records their OWN disposition');
select throws_ok(
  $$insert into public.ai_disposition (tenant_id, ai_interaction_id, capability_key, action, disposed_by)
    values ('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000a0001',
            'note.voice_draft', 'accepted', 'ffffffff-0000-0000-0000-0000000000ad')$$,
  '42501', null,
  'ai_disposition -: a disposition cannot be attributed to someone else (self-pinned)');
select is((select count(*)::int from public.ai_disposition), 1,
  'ai_disposition +: the disposer sees their own disposition');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.ai_disposition), 1,
  'ai_disposition +: a holder of ai.read sees tenant dispositions');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000bd', 'aal2');
select is((select count(*)::int from public.ai_disposition), 0,
  'ai_disposition -: another tenant sees nothing');
reset role;
select throws_like($$update public.ai_disposition set action = 'accepted'$$, '%CAREOS_APPEND_ONLY%',
  'ai_disposition UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.ai_disposition$$, '%CAREOS_APPEND_ONLY%',
  'ai_disposition DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.ai_disposition', 'update'),
  'authenticated has no UPDATE grant on ai_disposition (append-only)');
select ok(not has_table_privilege('authenticated', 'public.ai_disposition', 'delete'),
  'authenticated has no DELETE grant on ai_disposition (append-only)');

-- ── knowledge_chunk: tenant read, insert gated ai.manage-or-client.write ───
select pg_temp.login('ffffffff-0000-0000-0000-0000000000c9', 'aal2');
select is((select count(*)::int from public.knowledge_chunk), 1,
  'knowledge_chunk +: staff in the tenant read the chunked corpus (retrieval as the user)');
select throws_ok(
  $$insert into public.knowledge_chunk (tenant_id, document_id, seq, content)
    values ('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000d0001', 9, 'rogue chunk')$$,
  '42501', null,
  'knowledge_chunk -: a caregiver without ai.manage/client.write cannot insert chunks');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$insert into public.knowledge_chunk (tenant_id, document_id, seq, content)
    values ('ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000d0001', 1, 'Fall prevention — Report falls immediately.')$$,
  'knowledge_chunk +: a holder of ai.manage inserts corpus chunks');
-- The embedding backfill is column-scoped: ai.manage writes vectors, nobody rewrites text.
select lives_ok(
  $$update public.knowledge_chunk
       set embedding = array_fill(0.1::real, array[1536])::extensions.vector
     where seq = 0$$,
  'knowledge_chunk +: a holder of ai.manage backfills the embedding column as themselves');
select is((select count(*)::int from public.knowledge_chunk where embedding is not null), 1,
  'knowledge_chunk +: exactly the targeted chunk carries a vector');
select throws_ok(
  $$update public.knowledge_chunk set content = 'rewritten policy text'$$,
  '42501', null,
  'knowledge_chunk -: corpus text is not writable — the grant covers the embedding column only');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000c9', 'aal2');
select lives_ok(
  $$update public.knowledge_chunk
       set embedding = array_fill(0.9::real, array[1536])::extensions.vector$$,
  'knowledge_chunk: a caregiver''s embedding write raises nothing…');
select is((select count(*)::int from public.knowledge_chunk
            where embedding = array_fill(0.9::real, array[1536])::extensions.vector), 0,
  '…but matches no rows — the update policy is ai.manage-gated');
reset role;
select pg_temp.login('ffffffff-0000-0000-0000-0000000000bd', 'aal2');
select is((select count(*)::int from public.knowledge_chunk), 0,
  'knowledge_chunk -: another tenant sees nothing (tenant isolation)');

reset role;
select * from finish();
rollback;
