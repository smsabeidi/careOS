-- pgTAP · agent identity (D-020): charter-only principals, RLS applies to agents as to
-- humans, and invariant 8 is structural — agents propose, only staff dispose.
-- @trace: ST-154, ST-155, D-020, S1-3
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff');
insert into public.permission (key, description) values
  ('compliance.read', 'test'), ('credential.read.all', 'test'), ('user.read', 'test'),
  ('schedule.read', 'test'), ('careteam.read', 'test'), ('ai.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'ai.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad');

-- ── Provisioning: idempotent, charter-only ─────────────────────────────────
select is(app.provision_agent_fleet('aaaaaaaa-0000-0000-0000-000000000001'), 4,
  'fleet: four v1 agents provision');
select lives_ok(
  $$select app.provision_agent_fleet('aaaaaaaa-0000-0000-0000-000000000001')$$,
  'fleet: re-provisioning is safe');
select is(
  (select count(*)::int from public.agent_identity
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  4, 'fleet: still exactly four after the replay');
select is(
  (select (u.kind, u.status)::text from public.app_user u
    join public.agent_identity a on a.app_user_id = u.id
   where a.agent_key = 'compliance_watch'
     and a.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('system', 'active')::text,
  'agent: a real principal — kind system, active (the 0022 contract covers it)');
select is(
  (select count(*)::int from public.role_permission rp
    join public.role r on r.id = rp.role_id
   where r.key = 'agent_compliance_watch'
     and r.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  3, 'agent: the charter role carries exactly its three permissions');
select ok(
  (select enabled = false from public.agent_identity where agent_key = 'compliance_watch'
       and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'agent: autonomy is opt-in — the fleet ships disabled');

-- 0039: sessions require enabled=true — switch the probe agent ON first.
reset role;
update public.agent_identity set enabled = true
 where agent_key = 'compliance_watch'
   and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ── Under a broker-minted session, RLS treats the agent like anyone ────────
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

select pg_temp.login(
  (select app_user_id from public.agent_identity where agent_key = 'compliance_watch'
       and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'aal2');
select ok(app.is_active_user(), 'agent session: an active principal');
select ok(app.has_perm('compliance.read'), 'agent session: holds its charter permission');
select ok(not app.has_perm('client.write'), 'agent session: holds nothing beyond the charter');
-- created_by = auth.uid(): the agent pins its own identity, exactly like a human would
-- (its charter deliberately cannot read the roster table it lives in).
select lives_ok(
  $$insert into public.ai_proposal
      (tenant_id, capability_key, kind, subject_type, title, created_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'chase.draft', 'message',
            'credential', 'Renewal chase draft (probe)', auth.uid())$$,
  'agent session: authoring a proposal rides the ordinary self-pinned policy');

-- ── Invariant 8, structural: the agent cannot dispose ──────────────────────
reset role;
select throws_like(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            (select id from public.ai_proposal where title like '%(probe)'),
            'approve',
            (select app_user_id from public.agent_identity where agent_key = 'compliance_watch'
       and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'))$$,
  '%CAREOS_HUMAN_REQUIRED%',
  'invariant 8: an agent actor on a disposition is refused — even by the superuser path');
select lives_ok(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            (select id from public.ai_proposal where title like '%(probe)'),
            'approve', 'aaaaaaaa-0000-0000-0000-0000000000ad')$$,
  'invariant 8: a staff actor disposes normally');

-- ── M5 (0039): the kill switch has EFFECT, not just a value ────────────────
reset role;
update public.agent_identity set enabled = true
 where agent_key = 'compliance_watch'
   and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.login(
  (select app_user_id from public.agent_identity where agent_key = 'compliance_watch'
       and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'aal2');
select ok(app.current_tenant_id() is not null,
  'kill switch: an ENABLED agent has tenant context');
reset role;
update public.agent_identity set enabled = false
 where agent_key = 'compliance_watch'
   and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.login(
  (select app_user_id from public.agent_identity where agent_key = 'compliance_watch'
       and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'aal2');
select ok(app.current_tenant_id() is null,
  'kill switch: flipping enabled=false kills the agent MID-TOKEN (0039, M5)');
select ok(not app.is_active_user(),
  'kill switch: a disabled agent is not an active principal');
reset role;

-- ── Oversight visibility + posture ─────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.agent_identity), 4,
  'oversight: ai.read sees the fleet roster');
reset role;
select ok(not has_table_privilege('authenticated', 'public.agent_identity', 'insert'),
  'posture: no client write path to the roster');
select ok(not has_function_privilege('authenticated',
  'app.provision_agent(uuid,text,text,text,text[])', 'execute'),
  'posture: provisioning is deploy plumbing, never client-callable');

reset role;
select * from finish();
rollback;
