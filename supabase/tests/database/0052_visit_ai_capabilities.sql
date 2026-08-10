-- pgTAP · visit AI registry (0052): that the four docs/17 §11 capabilities register
-- idempotently per key with a pinned model and a budget cap; that the database — not a
-- convention, not a prompt — refuses to register visit.operational_profile without a
-- human disposer, on INSERT and on a later UPDATE alike (invariant 8, D-028, D-021);
-- that the registry and the flag table are tenant-scoped and read-only from the client;
-- that the two dark flags read false even when the call site defaults true (D-026); that
-- the only pen on a flag is app.set_feature_flag under AAL2 + platform.manage; and that
-- deploy-time provisioning writes no audit event while a human flip writes exactly one,
-- carrying the key and the state and no free text.
-- Style mirrors 0015_ai_governance.sql / 0027_domain_event_outbox.sql.
--
-- No client, care-team or visit fixtures here, deliberately: every row this migration
-- writes is CFG (a capability catalogue, a prompt registry, a switch table). None of it
-- names a person, so none of it carries an AAL2 gate — asserted below rather than
-- assumed.
-- @trace: ST-210, D-013, D-021, D-026, D-028, D-030
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'reg.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'reg.cg1.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'reg.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Registry Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Registry Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Registry Admin A', 'reg.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Registry Caregiver A1', 'reg.cg1.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Registry Admin B', 'reg.admin.b@brookmead.test', 'staff');

-- platform.manage is 0026's key for the flag pen; the caregiver deliberately holds
-- nothing, so the refusal probes below fail on the permission and on nothing else.
insert into public.permission (key, description) values
  ('platform.manage', 'test'), ('ai.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'reg_platform_admin', 'Registry Platform Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'reg_caregiver', 'Registry Caregiver'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'reg_platform_admin', 'Registry Platform Admin B');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'platform.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'ai.read'),
  -- Tenant B holds the SAME keys, so every cross-tenant probe fails on tenancy alone.
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'platform.manage'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'ai.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000e0c1'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Posture: the seeders are deploy-time plumbing, reachable by nobody ──────
select ok(not has_function_privilege('authenticated',
  'app.seed_visit_ai_capabilities(uuid)', 'execute'),
  'seeder -: authenticated cannot register capabilities');
select ok(not has_function_privilege('anon',
  'app.seed_visit_ai_capabilities(uuid)', 'execute'),
  'seeder -: anon cannot register capabilities');
select ok(not has_function_privilege('service_role',
  'app.seed_visit_ai_capabilities(uuid)', 'execute'),
  'seeder -: service_role cannot register capabilities (no worker lane exists)');
select ok(not has_function_privilege('authenticated',
  'app.seed_visit_feature_flags(uuid)', 'execute'),
  'seeder -: authenticated cannot lay feature flags (app.set_feature_flag is the pen)');
select ok(not has_function_privilege('anon',
  'app.seed_visit_feature_flags(uuid)', 'execute'),
  'seeder -: anon cannot lay feature flags');
select ok(not has_function_privilege('service_role',
  'app.seed_visit_feature_flags(uuid)', 'execute'),
  'seeder -: service_role cannot lay feature flags');
-- Definer, or the provisioning insert would be a no-op the day a policy tightens.
select is((select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app'
             and p.proname in ('seed_visit_ai_capabilities', 'seed_visit_feature_flags')
             and p.prosecdef),
  2, 'seeder +: both provisioning functions are security definer');

-- ── Registration: the four §11 capabilities, idempotent per key ─────────────
select is(app.seed_visit_ai_capabilities('aaaaaaaa-0000-0000-0000-000000000001'), 4,
  'registry +: the four docs/17 §11 capabilities register for a fresh tenant');
select is(app.seed_visit_ai_capabilities('aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'registry +: a second run registers nothing (idempotent on (tenant_id, key))');

select is((select tier from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and key = 'visit.operational_profile'),
  'T2', 'registry +: visit.operational_profile is registered T2 (D-028)');
select ok((select requires_human from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and key = 'visit.operational_profile'),
  'registry +: visit.operational_profile requires a human disposer (invariant 8)');
select ok(not (select enabled from public.ai_capability
                where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                  and key = 'visit.operational_profile'),
  'registry +: the profile capability ships with its kill switch off (an owner opts in)');
select is((select count(*)::int from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and key in ('visit.exception_triage', 'workforce.weekly_report',
                          'payroll.readiness_brief')
              and tier = 'T1' and requires_human = false and enabled),
  3, 'registry +: the three narration capabilities are T1, enabled, no disposer needed');
select is((select count(*)::int from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and tier = 'T0'),
  0, 'registry -: nothing in this layer is registered T0 (no silent auto-execute)');
select is((select count(*)::int from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and (model is null or monthly_budget_usd is null)),
  0, 'registry +: every registration pins a model and a monthly cap (D-013)');
-- DN-0052a: §11 rows 2 and 6 are extensions of live capabilities, not new rows.
select is((select count(*)::int from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and key in ('ops.daily_brief', 'ops.nl_query')),
  0, 'registry -: 0052 registers no alias of huddle.brief or analytics.query (DN-0052a)');

-- Invariant 10: a capability with no registry prompt cannot lawfully be called.
select is((select count(*)::int from public.ai_prompt_template
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and version = 1 and active
              and capability_key in ('visit.exception_triage', 'workforce.weekly_report',
                                     'payroll.readiness_brief',
                                     'visit.operational_profile')),
  4, 'prompts +: each of the four capabilities lands its v1 registry prompt');
select is((select count(*)::int from public.ai_capability c
            where c.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and not exists (select 1 from public.ai_prompt_template t
                               where t.tenant_id = c.tenant_id
                                 and t.capability_key = c.key and t.active)),
  0, 'prompts +: no capability is registered without a prompt row (invariant 10)');
-- D-030 as a text canary: the boundary is written into every prompt, so a v2 that drops
-- it shows up in a diff instead of in a model context window.
select is((select count(*)::int from public.ai_prompt_template
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and system_prompt not ilike '%coordinate%'),
  0, 'prompts +: every v1 prompt states the no-coordinates boundary in its own text');

-- ── RLS + client posture on the two tables this slice writes ────────────────
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('ai_capability', 'ai_prompt_template', 'feature_flag')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS enabled + forced on ai_capability, ai_prompt_template, feature_flag');

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.ai_capability), 4,
  'capability +: a caregiver in the tenant reads the capability catalogue');
reset role;
-- Deliberate: the catalogue is CFG. It names no client and no caregiver, so it carries
-- no AAL2 gate — and a caregiver whose session has not stepped up still sees which
-- capabilities exist and which are switched off.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.ai_capability), 4,
  'capability +: an AAL1 session still reads the catalogue (CFG, not PHI)');
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.ai_capability), 0,
  'capability -: tenant-B admin sees none of tenant A registrations (tenant isolation)');
select is((select count(*)::int from public.ai_prompt_template), 0,
  'prompts -: tenant-B admin sees none of tenant A prompts (tenant isolation)');
reset role;

select ok(has_table_privilege('authenticated', 'public.ai_capability', 'select'),
  'capability +: authenticated holds SELECT on the catalogue');
select ok(not has_table_privilege('authenticated', 'public.ai_capability', 'insert'),
  'capability -: authenticated has no INSERT grant (registration is deploy-time)');
select ok(not has_table_privilege('authenticated', 'public.ai_capability', 'update'),
  'capability -: authenticated has no UPDATE grant (no client-side tier edit)');
select ok(not has_table_privilege('authenticated', 'public.ai_capability', 'delete'),
  'capability -: authenticated has no DELETE grant');
select ok(not has_table_privilege('authenticated', 'public.ai_prompt_template', 'insert'),
  'prompts -: authenticated has no INSERT grant on the prompt registry');

-- ══ The claim this file exists for: invariant 8 is structural, not procedural ══
-- A T2 capability without a human disposer is not a policy violation to be caught in
-- review — it is a row the database will not accept, on the way in and ever after.
select throws_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'visit.operational_profile',
            'Caregiver operational profile (draft)', 'T2', false)$$,
  '23514', null,
  'capability -: registering visit.operational_profile as T2 with no human disposer is '
  'refused by the database (invariant 8, D-028)');
select lives_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'visit.operational_profile',
            'Caregiver operational profile (draft)', 'T2', true)$$,
  'capability +: control — the identical row WITH a human disposer is accepted');
select throws_ok(
  $$update public.ai_capability set requires_human = false
     where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
       and key = 'visit.operational_profile'$$,
  '23514', null,
  'capability -: the CHECK is not insert-only — a later UPDATE cannot strip the human');
select throws_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'visit.probe_t3', 'Probe', 'T3', false)$$,
  '23514', null,
  'capability -: the refusal generalises to T3 (any high-autonomy tier needs a human)');
select lives_ok(
  $$insert into public.ai_capability (tenant_id, key, name, tier, requires_human)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'visit.probe_t1', 'Probe', 'T1', false)$$,
  'capability +: control — T1 without a disposer is lawful (not a blanket ban)');

-- Idempotence is per key, not per tenant: tenant B already holds the profile row from
-- the control insert above, so the seeder lands exactly the three that are missing.
select is(app.seed_visit_ai_capabilities('bbbbbbbb-0000-0000-0000-000000000001'), 3,
  'registry +: the seeder registers only the keys a tenant is missing');
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.ai_capability
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'capability -: tenant-B admin still reads zero tenant-A rows once B has its own');
reset role;

-- ── Feature flags: rows, not call-site defaults ─────────────────────────────
select is(app.seed_visit_feature_flags('aaaaaaaa-0000-0000-0000-000000000001'), 4,
  'flags +: the four switches of this layer land for a fresh tenant');
select is(app.seed_visit_feature_flags('aaaaaaaa-0000-0000-0000-000000000001'), 0,
  'flags +: a second run lays nothing (idempotent on the (tenant_id, key) primary key)');
select ok(not (select enabled from public.feature_flag
                where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                  and key = 'evv.offline_capture'),
  'flags +: evv.offline_capture ships off (the PWA replay path is unproven, D-022)');
select ok(not (select enabled from public.feature_flag
                where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                  and key = 'evv.submission'),
  'flags +: evv.submission ships off (no live endpoint until V17 / D-Q16, D-026)');
select ok((select enabled from public.feature_flag
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and key = 'visit.trust_score'),
  'flags +: visit.trust_score ships on (deterministic evidence, never an adverse
   action — D-028)');
select ok((select enabled from public.feature_flag
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and key = 'workforce.intelligence'),
  'flags +: workforce.intelligence ships on (aggregate features, no coordinates)');
select is((select count(*)::int from public.feature_flag
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and not enabled
              and (disabled_reason is null or btrim(disabled_reason) = '')),
  0, 'flags +: every off-by-default switch states why it is off');
select is((select count(*)::int from public.feature_flag
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and updated_by is not null),
  0, 'flags +: deploy-laid rows attribute themselves to nobody (no fabricated actor)');

-- The structural point of writing rows instead of trusting defaults: a call site that
-- passes true still reads false, and one that passes false still reads true.
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is(app.feature_enabled('evv.submission', true), false,
  'flags -: an explicit off row beats a call site defaulting true (D-026)');
select is(app.feature_enabled('visit.trust_score', false), true,
  'flags +: an explicit on row beats a call site defaulting false');
reset role;

select ok(has_table_privilege('authenticated', 'public.feature_flag', 'select'),
  'flags +: authenticated reads the switch table (caregivers see their own surfaces)');
select ok(not has_table_privilege('authenticated', 'public.feature_flag', 'insert'),
  'flags -: authenticated has no INSERT grant (app.set_feature_flag is the only pen)');
select ok(not has_table_privilege('authenticated', 'public.feature_flag', 'update'),
  'flags -: authenticated has no UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.feature_flag', 'delete'),
  'flags -: authenticated has no DELETE grant');

-- Deploy-time provisioning is not a user action and must leave the ledger alone.
select is((select count(*)::int from audit.audit_event
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and entity_type in ('ai_capability', 'ai_prompt_template', 'feature_flag')),
  0, 'audit +: registering capabilities and laying flags emits no audit event');

-- ── The lawful pen: AAL2 + platform.manage, reason required to go dark ──────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.set_feature_flag('visit.trust_score', false, 'caregiver attempt')$$,
  '%CAREOS_FORBIDDEN%',
  'flags -: a caregiver without platform.manage cannot flip a switch');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.set_feature_flag('visit.trust_score', false, 'unstepped session')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'flags -: an AAL1 platform admin cannot flip a switch');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.set_feature_flag('visit.trust_score', false)$$,
  '%CAREOS_REASON_REQUIRED%',
  'flags -: switching a feature off without a reason is refused');
select lives_ok(
  $$select app.set_feature_flag('visit.trust_score', false,
      'pgTAP flag lane: proving the pen works and the reason stays out of the ledger')$$,
  'flags +: an AAL2 platform admin switches visit.trust_score off');
select is(app.feature_enabled('visit.trust_score', true), false,
  'flags +: the flip is what the reader sees on the next call');
reset role;

-- The flip is a consequential config act: exactly one audit event, IDs and enums only.
select is((select count(*)::int from audit.audit_event
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and entity_type = 'feature_flag' and action = 'config.feature_flag'),
  1, 'audit +: the human flip emits exactly one audit event (invariant 7)');
select is((select payload->>'key' from audit.audit_event
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and entity_type = 'feature_flag' order by id desc limit 1),
  'visit.trust_score', 'audit +: the payload names the switch that moved');
select is((select count(*)::int from audit.audit_event e,
                 lateral jsonb_object_keys(e.payload) k
            where e.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and e.entity_type = 'feature_flag'),
  2, 'audit +: the payload carries the key and the state and nothing else');
select is((select count(*)::int from audit.audit_event
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and entity_type = 'feature_flag'
              and payload::text ilike '%pgTAP flag lane%'),
  0, 'audit -: the operator free-text reason never reaches the ledger payload');

reset role;
select * from finish();
rollback;
