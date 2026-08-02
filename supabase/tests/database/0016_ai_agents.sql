-- pgTAP · AI action plane (0016): the approvals-inbox spine and its disposition ledger,
-- document extraction with human acceptance, the agent runtime, clinical flags, evidence
-- packets, and the two deterministic engines (rank_fill_candidates, denial_risk).
--
-- What this file proves, invariant by invariant:
--   1 (append-only)  — every new table refuses UPDATE/DELETE at BOTH layers (no grant,
--                      and a trigger that raises even for a superuser). The four tables
--                      with a bounded disposition column prove the column-scoped grant
--                      works AND that every other column is still refused.
--   2 (RLS)          — enabled + forced on all eight tables; positive and negative policy
--                      probes per table; tenant isolation.
--   3 (AAL2 for PHI) — an AAL1 session sees nothing on the PHI tables, and both engines
--                      refuse an AAL1 caller.
--   7 (audit)        — a proposal and its disposition each emit exactly one audit event.
--   8 (human dispose)— actor/created_by are DB-pinned to auth.uid(); a disposition cannot
--                      be attributed to a colleague.
--  13 (deterministic)— rank_fill_candidates blocks a lapsed-credential caregiver via
--                      app.assert_schedulable, and denial_risk names the gaps on an
--                      incomplete visit while passing a complete one.
-- Style mirrors 0011_scheduling.sql / 0015_ai_governance.sql.
-- @trace: docs/16 Waves 2–5, invariants 1/2/3/7/8/13
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — two tenants, Meadowbrook conventions) ────────
insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-0000000000ad', 'agents.admin.a@meadowbrook.test'),  -- ai.read/manage + compliance.read + client.read.all
  ('cccccccc-0000-0000-0000-0000000000c0', 'agents.coord.a@meadowbrook.test'),  -- schedule.read/write + client.write
  ('cccccccc-0000-0000-0000-0000000000c1', 'agents.cg1.a@meadowbrook.test'),    -- caregiver, on client A's care team
  ('cccccccc-0000-0000-0000-0000000000c2', 'agents.cg2.a@meadowbrook.test'),    -- caregiver, no perms, other client
  ('dddddddd-0000-0000-0000-0000000000ad', 'agents.admin.b@brookmead.test');    -- tenant B

insert into public.tenant (id, name) values
  ('cccccccc-0000-0000-0000-000000000001', 'Agents Tenant A'),
  ('dddddddd-0000-0000-0000-000000000001', 'Agents Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-000000000001', 'Agents Admin A',      'agents.admin.a@meadowbrook.test', 'staff'),
  ('cccccccc-0000-0000-0000-0000000000c0', 'cccccccc-0000-0000-0000-000000000001', 'Agents Coordinator A','agents.coord.a@meadowbrook.test', 'staff'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001', 'Agents Caregiver A1', 'agents.cg1.a@meadowbrook.test',   'staff'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000001', 'Agents Caregiver A2', 'agents.cg2.a@meadowbrook.test',   'staff'),
  ('dddddddd-0000-0000-0000-0000000000ad', 'dddddddd-0000-0000-0000-000000000001', 'Agents Admin B',      'agents.admin.b@brookmead.test',   'staff');

insert into public.permission (key, description) values
  ('ai.read','test'), ('ai.manage','test'), ('compliance.read','test'),
  ('client.read.all','test'), ('client.write','test'),
  ('schedule.read','test'), ('schedule.write','test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('cccccccc-0000-0000-0000-00000000e0ad', 'cccccccc-0000-0000-0000-000000000001', 'ai_admin',    'AI Admin'),
  ('cccccccc-0000-0000-0000-00000000e0c0', 'cccccccc-0000-0000-0000-000000000001', 'coordinator', 'Coordinator'),
  ('cccccccc-0000-0000-0000-00000000e0c9', 'cccccccc-0000-0000-0000-000000000001', 'caregiver',   'Caregiver'),
  ('dddddddd-0000-0000-0000-00000000e0ad', 'dddddddd-0000-0000-0000-000000000001', 'ai_admin',    'AI Admin');
insert into public.role_permission (role_id, permission_key) values
  ('cccccccc-0000-0000-0000-00000000e0ad', 'ai.read'),
  ('cccccccc-0000-0000-0000-00000000e0ad', 'ai.manage'),
  ('cccccccc-0000-0000-0000-00000000e0ad', 'compliance.read'),
  ('cccccccc-0000-0000-0000-00000000e0ad', 'client.read.all'),
  ('cccccccc-0000-0000-0000-00000000e0c0', 'schedule.read'),
  ('cccccccc-0000-0000-0000-00000000e0c0', 'schedule.write'),
  ('cccccccc-0000-0000-0000-00000000e0c0', 'client.write'),
  ('dddddddd-0000-0000-0000-00000000e0ad', 'ai.read'),
  ('dddddddd-0000-0000-0000-00000000e0ad', 'compliance.read'),
  ('dddddddd-0000-0000-0000-00000000e0ad', 'client.read.all'),
  ('dddddddd-0000-0000-0000-00000000e0ad', 'schedule.write');
insert into public.user_role (user_id, role_id) values
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-00000000e0ad'),
  ('cccccccc-0000-0000-0000-0000000000c0', 'cccccccc-0000-0000-0000-00000000e0c0'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-00000000e0c9'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-00000000e0c9'),
  ('dddddddd-0000-0000-0000-0000000000ad', 'dddddddd-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name, city, status) values
  ('cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-000000000001', 'Agents', 'ClientA1', 'Silver Spring', 'active'),
  ('cccccccc-0000-0000-0000-00000000c002', 'cccccccc-0000-0000-0000-000000000001', 'Agents', 'ClientA2', 'Silver Spring', 'active'),
  ('dddddddd-0000-0000-0000-00000000c001', 'dddddddd-0000-0000-0000-000000000001', 'Agents', 'ClientB',  'Rockville',     'active');

-- A1 is on client A1's care team (familiarity + same city). A2 serves client A2 only
-- (same city, no familiarity with A1).
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000c001',
   'cccccccc-0000-0000-0000-0000000000c1', 'caregiver'),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000c002',
   'cccccccc-0000-0000-0000-0000000000c2', 'caregiver');

-- Scheduling-blocking credential type: A1's CPR lapsed, A2's is valid.
insert into public.credential_type
  (id, tenant_id, key, name, category, required_for_roles, blocks_scheduling) values
  ('cccccccc-0000-0000-0000-0000000c7001', 'cccccccc-0000-0000-0000-000000000001',
   'cpr', 'CPR Certification', 'certification', '{Caregiver}', true);
insert into public.credential
  (id, tenant_id, app_user_id, credential_type_id, issued_on, expires_on, status, verified_by, verified_at) values
  ('cccccccc-0000-0000-0000-000000cd0001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-0000000c7001',
   current_date - 400, current_date - 5, 'verified',
   'cccccccc-0000-0000-0000-0000000000ad', now()),
  ('cccccccc-0000-0000-0000-000000cd0002', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-0000000c7001',
   current_date - 10, current_date + 300, 'verified',
   'cccccccc-0000-0000-0000-0000000000ad', now());

-- Visits: one OPEN visit tomorrow (the fill target + the incomplete-claim probe), one
-- already-worked visit yesterday that is complete end to end (the ready-claim probe),
-- and one assigned visit that loads A1's week.
insert into public.visit (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status) values
  ('cccccccc-0000-0000-0000-00000000e001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', null,
   date_trunc('day', now()) + interval '34 hours', date_trunc('day', now()) + interval '36 hours', 'scheduled'),
  ('cccccccc-0000-0000-0000-00000000e002', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-0000000000c2',
   now() - interval '26 hours', now() - interval '24 hours', 'completed'),
  ('cccccccc-0000-0000-0000-00000000e003', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c002', 'cccccccc-0000-0000-0000-0000000000c1',
   date_trunc('day', now()) + interval '32 hours', date_trunc('day', now()) + interval '36 hours', 'scheduled');

-- The completed visit has a clock pair, a finalized signed note, and a caregiver whose
-- credential was valid — i.e. nothing for denial_risk to flag.
insert into public.visit_event
  (tenant_id, visit_id, caregiver_id, event_type, occurred_at) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000e002',
   'cccccccc-0000-0000-0000-0000000000c2', 'clock_in',  now() - interval '26 hours'),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000e002',
   'cccccccc-0000-0000-0000-0000000000c2', 'clock_out', now() - interval '24 hours');

insert into public.form_template (id, tenant_id, key, title, schema, requires_signature_roles) values
  ('cccccccc-0000-0000-0000-00000000f001', 'cccccccc-0000-0000-0000-000000000001',
   'visit_note', 'Visit Note', '{}', '{rn}');
insert into public.form_instance
  (id, tenant_id, template_id, client_id, visit_id, status, created_by) values
  ('cccccccc-0000-0000-0000-00000000f101', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000f001', 'cccccccc-0000-0000-0000-00000000c001',
   'cccccccc-0000-0000-0000-00000000e002', 'final', 'cccccccc-0000-0000-0000-0000000000c2');
insert into public.form_version
  (id, tenant_id, instance_id, version_no, content, content_hash, author_id, kind) values
  ('cccccccc-0000-0000-0000-00000000f201', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000f101', 1, '{"a":1}',
   extensions.digest(convert_to('{"a": 1}', 'utf8'), 'sha256'),
   'cccccccc-0000-0000-0000-0000000000c2', 'create');
update public.form_instance
   set current_version_id = 'cccccccc-0000-0000-0000-00000000f201'
 where id = 'cccccccc-0000-0000-0000-00000000f101';
insert into public.signature
  (tenant_id, form_version_id, signer_id, signer_role, content_hash, session_aal) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000f201',
   'cccccccc-0000-0000-0000-0000000000ad', 'rn',
   (select content_hash from public.form_version where id = 'cccccccc-0000-0000-0000-00000000f201'),
   'aal2');

-- AI-plane fixtures: one ledger row, two proposals (one untouched, one to be disposed),
-- an extraction job + fields, an agent task + step, a clinical flag, an evidence packet.
insert into public.ai_interaction
  (id, tenant_id, capability_key, provider, model, tier, status, input_digest, output_digest, created_by) values
  ('cccccccc-0000-0000-0000-0000000a0001', 'cccccccc-0000-0000-0000-000000000001',
   'chase.draft', 'mock', 'gpt-5.6-luna (mock)', 'T2', 'ok',
   'credential expiry facts digest', 'drafted reminder digest',
   'cccccccc-0000-0000-0000-0000000000c0');

insert into public.ai_proposal
  (id, tenant_id, capability_key, kind, subject_type, subject_id, title, body, rationale,
   confidence, ai_interaction_id, created_by) values
  ('cccccccc-0000-0000-0000-00000000ab01', 'cccccccc-0000-0000-0000-000000000001',
   'chase.draft', 'message', 'credential', 'cccccccc-0000-0000-0000-000000cd0001',
   'Credential renewal reminder', 'Your CPR certification has lapsed.',
   'Blocks scheduling; expired five days ago.', 0.910,
   'cccccccc-0000-0000-0000-0000000a0001', 'cccccccc-0000-0000-0000-0000000000c0'),
  ('cccccccc-0000-0000-0000-00000000ab02', 'cccccccc-0000-0000-0000-000000000001',
   'shift.fill', 'assignment', 'visit', 'cccccccc-0000-0000-0000-00000000e001',
   'Coverage plan for an open visit', 'Two candidates are schedulable for this window.',
   'The visit is unassigned and starts tomorrow.', 0.740,
   null, 'cccccccc-0000-0000-0000-0000000000c0');

insert into public.extraction_job
  (id, tenant_id, kind, source_name, page_count, status, client_id, created_by) values
  ('cccccccc-0000-0000-0000-00000000ec01', 'cccccccc-0000-0000-0000-000000000001',
   'intake_packet', 'referral-packet.pdf', 12, 'extracted',
   'cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-0000000000c0');
insert into public.extraction_field
  (id, tenant_id, job_id, field_key, extracted_value, confidence, page_ref) values
  ('cccccccc-0000-0000-0000-00000000ed01', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000ec01', 'client.last_name', 'ClientA1', 0.990, 1),
  ('cccccccc-0000-0000-0000-00000000ed02', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000ec01', 'payer.member_id', 'MD-88213-9', 0.610, 3);

insert into public.agent_task (id, tenant_id, kind, subject_id, status, goal, created_by) values
  ('cccccccc-0000-0000-0000-00000000aa01', 'cccccccc-0000-0000-0000-000000000001',
   'shift_fill', 'cccccccc-0000-0000-0000-00000000e001', 'awaiting_approval',
   'Fill the open visit tomorrow morning.', 'cccccccc-0000-0000-0000-0000000000c0');
insert into public.agent_step
  (id, tenant_id, task_id, seq, tool, input_digest, output_digest, status) values
  ('cccccccc-0000-0000-0000-00000000ae01', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000aa01', 1, 'rank_fill_candidates',
   'visit id + window', '2 candidates, 1 blocked', 'ok');

insert into public.clinical_flag
  (id, tenant_id, client_id, kind, severity, summary, evidence, created_by) values
  ('cccccccc-0000-0000-0000-00000000cf01', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'condition_trend', 'medium',
   'Condition recorded as declining on the last three visits.',
   '{"series":["Stable","Declining","Declining"]}',
   'cccccccc-0000-0000-0000-0000000000ad');

insert into public.evidence_packet
  (id, tenant_id, client_id, scope, record_count, manifest, generated_by) values
  ('cccccccc-0000-0000-0000-00000000ee01', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'supervisory_visits.2026', 3,
   '{"form_versions":3}', 'cccccccc-0000-0000-0000-0000000000ad');

-- Session simulator (identical to 002/003/0011/0015).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ Invariant 2: RLS enabled + forced on every new table ═══════════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('ai_proposal','ai_proposal_event','extraction_job','extraction_field',
                        'agent_task','agent_step','clinical_flag','evidence_packet')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS is enabled + forced on all eight 0016 tables');

-- The derived-status view reads with the CALLER's rights, never the definer's.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'ai_proposal_status'
      and 'security_invoker=true' = any (c.reloptions)),
  1, 'ai_proposal_status is a security_invoker view (no privileged read path)');

-- ═══ ai_proposal: scoping, self-pinning, append-only ════════════════════════
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');   -- coordinator
select is((select count(*)::int from public.ai_proposal), 2,
  'ai_proposal +: a coordinator (schedule.write) sees the tenant inbox');
select lives_ok(
  $$insert into public.ai_proposal
      (id, tenant_id, capability_key, kind, subject_type, subject_id, title, body, created_by)
    values ('cccccccc-0000-0000-0000-00000000ab03', 'cccccccc-0000-0000-0000-000000000001',
            'chase.draft', 'message', 'client', 'cccccccc-0000-0000-0000-00000000c001',
            'Stale draft nudge', 'Your visit note from yesterday is still a draft.',
            'cccccccc-0000-0000-0000-0000000000c0')$$,
  'ai_proposal +: a capability records a proposal pinned to the running user');
select throws_ok(
  $$insert into public.ai_proposal
      (tenant_id, capability_key, kind, subject_type, title, created_by)
    values ('cccccccc-0000-0000-0000-000000000001', 'chase.draft', 'message', 'client',
            'Forged proposal', 'cccccccc-0000-0000-0000-0000000000ad')$$,
  '42501', null,
  'ai_proposal -: a proposal cannot be attributed to another user (self-pinned)');

reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal2');   -- ai.read oversight
select is((select count(*)::int from public.ai_proposal), 3,
  'ai_proposal +: ai.read oversight sees every proposal in the tenant');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');   -- caregiver, no perms
select is((select count(*)::int from public.ai_proposal), 0,
  'ai_proposal -: a caregiver with no AI/scheduling/compliance permission sees nothing');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal1');
select is((select count(*)::int from public.ai_proposal), 0,
  'ai_proposal -: an AAL1 session sees no proposals (invariant 3: AAL2 for PHI)');
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.ai_proposal), 0,
  'ai_proposal -: another tenant sees nothing (tenant isolation)');

reset role;
select throws_like($$update public.ai_proposal set status = 'approved'$$, '%CAREOS_APPEND_ONLY%',
  'ai_proposal UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.ai_proposal$$, '%CAREOS_APPEND_ONLY%',
  'ai_proposal DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.ai_proposal', 'update'),
  'authenticated has no UPDATE grant on ai_proposal (dispositions are events, not edits)');
select ok(not has_table_privilege('authenticated', 'public.ai_proposal', 'delete'),
  'authenticated has no DELETE grant on ai_proposal (append-only)');

-- ═══ ai_proposal_event: the disposition ledger (invariant 8) ════════════════
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');
select lives_ok(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, note, edited_body, actor)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000ab01',
            'edit', 'Softened the opening line.',
            'Hi — your CPR certification lapsed on the 5th. Send the renewal when you have it.',
            'cccccccc-0000-0000-0000-0000000000c0')$$,
  'ai_proposal_event +: a coordinator records their own edit disposition');
select lives_ok(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000ab01',
            'approve', 'cccccccc-0000-0000-0000-0000000000c0')$$,
  'ai_proposal_event +: approval lands as a second append-only row');
select throws_ok(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000ab01',
            'approve', 'cccccccc-0000-0000-0000-0000000000ad')$$,
  '42501', null,
  'ai_proposal_event -: a disposition cannot be attributed to someone else (self-pinned)');
select throws_ok(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000ab01',
            'shred', 'cccccccc-0000-0000-0000-0000000000c0')$$,
  '23514', null,
  'ai_proposal_event -: an action outside approve/edit/reject/execute/expire is rejected');

-- The derived status view is the authority on current state.
select is(
  (select status from public.ai_proposal_status where proposal_id = 'cccccccc-0000-0000-0000-00000000ab01'),
  'approved', 'ai_proposal_status +: the last event decides the current status');
select is(
  (select event_count from public.ai_proposal_status where proposal_id = 'cccccccc-0000-0000-0000-00000000ab01'),
  2, 'ai_proposal_status +: both dispositions are preserved (nothing is overwritten)');
select is(
  (select status from public.ai_proposal_status where proposal_id = 'cccccccc-0000-0000-0000-00000000ab02'),
  'pending', 'ai_proposal_status +: an undisposed proposal is still pending');

reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');   -- caregiver, no perms
select is((select count(*)::int from public.ai_proposal_event), 0,
  'ai_proposal_event -: read follows the parent proposal (no proposal, no events)');
select is((select count(*)::int from public.ai_proposal_status), 0,
  'ai_proposal_status -: the view inherits the base tables'' RLS');
select throws_ok(
  $$insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000ab01',
            'execute', 'cccccccc-0000-0000-0000-0000000000c2')$$,
  '42501', null,
  'ai_proposal_event -: a user who cannot see the proposal cannot dispose it');

reset role;
select throws_like($$update public.ai_proposal_event set action = 'reject'$$, '%CAREOS_APPEND_ONLY%',
  'ai_proposal_event UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.ai_proposal_event$$, '%CAREOS_APPEND_ONLY%',
  'ai_proposal_event DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.ai_proposal_event', 'update'),
  'authenticated has no UPDATE grant on ai_proposal_event (append-only)');
select ok(not has_table_privilege('authenticated', 'public.ai_proposal_event', 'delete'),
  'authenticated has no DELETE grant on ai_proposal_event (append-only)');

-- ═══ Invariant 7: proposing and disposing are audited ═══════════════════════
select is(
  (select count(*)::int from audit.audit_event
    where action = 'ai_proposal.proposed'
      and entity_id = 'cccccccc-0000-0000-0000-00000000ab03'),
  1, 'audit: a proposal recorded in-session emits one ai_proposal.proposed event');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'ai_proposal.approve'
      and entity_id = 'cccccccc-0000-0000-0000-00000000ab01'),
  1, 'audit: approving a proposal emits one ai_proposal.approve event');
select is(
  (select count(*)::int from audit.audit_event
    where entity_type = 'ai_proposal' and payload::text ilike '%lapsed on the 5th%'),
  0, 'audit -: no drafted body text ever reaches an audit payload (invariant 5)');

-- ═══ extraction_job / extraction_field: review without rewriting history ════
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');   -- client.write
select is((select count(*)::int from public.extraction_job), 1,
  'extraction_job +: the intake desk (client.write) sees the job');
select is((select count(*)::int from public.extraction_field), 2,
  'extraction_field +: fields follow the parent job');
select lives_ok(
  $$update public.extraction_job set status = 'reviewed'
     where id = 'cccccccc-0000-0000-0000-00000000ec01'$$,
  'extraction_job +: the review lifecycle advances through the column-scoped grant');
select is((select status from public.extraction_job where id = 'cccccccc-0000-0000-0000-00000000ec01'),
  'reviewed', 'extraction_job +: the new status is persisted');
select throws_ok(
  $$update public.extraction_job set kind = 'referral'
     where id = 'cccccccc-0000-0000-0000-00000000ec01'$$,
  '42501', null,
  'extraction_job -: what was extracted from what is immutable (grant covers status only)');

select lives_ok(
  $$update public.extraction_field
       set accepted = true, accepted_value = 'ClientA1',
           accepted_by = 'cccccccc-0000-0000-0000-0000000000c0', accepted_at = now()
     where id = 'cccccccc-0000-0000-0000-00000000ed01'$$,
  'extraction_field +: a human accepts a field through the column-scoped grant');
select is(
  (select accepted_value from public.extraction_field where id = 'cccccccc-0000-0000-0000-00000000ed01'),
  'ClientA1', 'extraction_field +: the human''s accepted value is persisted');
select throws_ok(
  $$update public.extraction_field set extracted_value = 'Rewritten'
     where id = 'cccccccc-0000-0000-0000-00000000ed01'$$,
  '42501', null,
  'extraction_field -: the model''s extracted value is not writable (append-only record)');
select throws_ok(
  $$update public.extraction_field
       set accepted = true, accepted_by = 'cccccccc-0000-0000-0000-0000000000ad'
     where id = 'cccccccc-0000-0000-0000-00000000ed02'$$,
  '42501', null,
  'extraction_field -: an acceptance cannot be attributed to another user');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.extraction_job), 0,
  'extraction_job -: a caregiver outside the packet''s chart and the intake desk sees nothing');
select is((select count(*)::int from public.extraction_field), 0,
  'extraction_field -: field visibility follows the job');
reset role;
select throws_like(
  $$update public.extraction_field set extracted_value = 'Tampered'$$,
  '%CAREOS_APPEND_ONLY%',
  'extraction_field UPDATE of an extracted value raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.extraction_field$$, '%CAREOS_APPEND_ONLY%',
  'extraction_field DELETE raises CAREOS_APPEND_ONLY');
select throws_like($$delete from public.extraction_job$$, '%CAREOS_APPEND_ONLY%',
  'extraction_job DELETE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.extraction_job', 'delete'),
  'authenticated has no DELETE grant on extraction_job');
select ok(not has_table_privilege('authenticated', 'public.extraction_field', 'delete'),
  'authenticated has no DELETE grant on extraction_field');

-- ═══ agent_task / agent_step: the durable runtime is replayable, not editable ═
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');
select is((select count(*)::int from public.agent_task), 1,
  'agent_task +: the coordinator sees the running task');
select is((select count(*)::int from public.agent_step), 1,
  'agent_step +: steps follow the parent task');
select lives_ok(
  $$update public.agent_task set status = 'completed'
     where id = 'cccccccc-0000-0000-0000-00000000aa01'$$,
  'agent_task +: the task lifecycle advances through the column-scoped grant');
select throws_ok(
  $$update public.agent_task set goal = 'Do something else'
     where id = 'cccccccc-0000-0000-0000-00000000aa01'$$,
  '42501', null,
  'agent_task -: the goal a human handed the agent is immutable');
select lives_ok(
  $$insert into public.agent_step (tenant_id, task_id, seq, tool, input_digest, output_digest, status)
    values ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000aa01',
            2, 'draft_outreach', 'candidate ids', 'draft ready', 'ok')$$,
  'agent_step +: the runtime appends the next step');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.agent_task), 0,
  'agent_task -: a caregiver with no scheduling or AI permission sees nothing');
reset role;
select throws_like($$update public.agent_step set output_digest = 'rewritten'$$, '%CAREOS_APPEND_ONLY%',
  'agent_step UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.agent_step$$, '%CAREOS_APPEND_ONLY%',
  'agent_step DELETE raises CAREOS_APPEND_ONLY');
select throws_like($$update public.agent_task set goal = 'rewritten'$$, '%CAREOS_APPEND_ONLY%',
  'agent_task UPDATE outside status raises CAREOS_APPEND_ONLY (even as superuser)');
select ok(not has_table_privilege('authenticated', 'public.agent_step', 'update'),
  'authenticated has no UPDATE grant on agent_step (append-only)');
select ok(not has_table_privilege('authenticated', 'public.agent_task', 'delete'),
  'authenticated has no DELETE grant on agent_task');

-- ═══ clinical_flag: AAL2 + care-team scoping, disposition only ══════════════
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');   -- on client A1's care team
select is((select count(*)::int from public.clinical_flag), 1,
  'clinical_flag +: a care-team member sees the flag for their client');
-- Visibility is not disposition (invariant 8): the caregiver's UPDATE is a legal
-- statement that simply matches no row, exactly like the knowledge_chunk precedent.
select lives_ok(
  $$update public.clinical_flag set status = 'dismissed'$$,
  'clinical_flag: a care-team caregiver''s disposition raises nothing…');
select is((select count(*)::int from public.clinical_flag where status <> 'open'), 0,
  '…but matches no rows — disposing a clinical finding needs the clinical read permission');
select throws_ok(
  $$update public.clinical_flag set summary = 'Rewritten finding'
     where id = 'cccccccc-0000-0000-0000-00000000cf01'$$,
  '42501', null,
  'clinical_flag -: the finding itself is immutable (grant covers the disposition only)');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal2');   -- client.read.all
select lives_ok(
  $$update public.clinical_flag
       set status = 'acknowledged', acknowledged_by = 'cccccccc-0000-0000-0000-0000000000ad',
           acknowledged_at = now()
     where id = 'cccccccc-0000-0000-0000-00000000cf01'$$,
  'clinical_flag +: a clinical reviewer disposes the flag through the column-scoped grant');
select is((select status from public.clinical_flag where id = 'cccccccc-0000-0000-0000-00000000cf01'),
  'acknowledged', 'clinical_flag +: the disposition is persisted');
select throws_ok(
  $$update public.clinical_flag
       set status = 'dismissed', acknowledged_by = 'cccccccc-0000-0000-0000-0000000000c1'
     where id = 'cccccccc-0000-0000-0000-00000000cf01'$$,
  '42501', null,
  'clinical_flag -: a disposition cannot be attributed to another user');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');   -- not on that care team
select is((select count(*)::int from public.clinical_flag), 0,
  'clinical_flag -: a caregiver off the care team sees nothing');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.clinical_flag), 0,
  'clinical_flag -: an AAL1 session sees no clinical flags (invariant 3)');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal2');   -- client.read.all
select is((select count(*)::int from public.clinical_flag), 1,
  'clinical_flag +: tenant-wide clinical read sees the flag');
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.clinical_flag), 0,
  'clinical_flag -: another tenant sees nothing (tenant isolation)');
reset role;
select throws_like($$delete from public.clinical_flag$$, '%CAREOS_APPEND_ONLY%',
  'clinical_flag DELETE raises CAREOS_APPEND_ONLY');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'clinical_flag.acknowledged'
      and entity_id = 'cccccccc-0000-0000-0000-00000000cf01'),
  1, 'audit: acknowledging a clinical flag emits one audit event');

-- ═══ evidence_packet: compliance-gated, immutable ═══════════════════════════
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal2');   -- compliance.read
select is((select count(*)::int from public.evidence_packet), 1,
  'evidence_packet +: a compliance reader sees the packet');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');   -- no compliance.read
select is((select count(*)::int from public.evidence_packet), 0,
  'evidence_packet -: a coordinator without compliance.read sees nothing');
select throws_ok(
  $$insert into public.evidence_packet (tenant_id, scope, generated_by)
    values ('cccccccc-0000-0000-0000-000000000001', 'forged.scope',
            'cccccccc-0000-0000-0000-0000000000c0')$$,
  '42501', null,
  'evidence_packet -: assembling a packet requires compliance.read');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal1');
select is((select count(*)::int from public.evidence_packet), 0,
  'evidence_packet -: an AAL1 session sees no packets (invariant 3)');
reset role;
select throws_like($$update public.evidence_packet set narrative = 'rewritten'$$, '%CAREOS_APPEND_ONLY%',
  'evidence_packet UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select ok(not has_table_privilege('authenticated', 'public.evidence_packet', 'update'),
  'authenticated has no UPDATE grant on evidence_packet (append-only)');

-- ═══ Engine: app.rank_fill_candidates (invariant 13) ════════════════════════
select ok(has_function_privilege('authenticated', 'app.rank_fill_candidates(uuid)', 'execute'),
  'authenticated can call app.rank_fill_candidates');
select ok(not has_function_privilege('anon', 'app.rank_fill_candidates(uuid)', 'execute'),
  'anon cannot call app.rank_fill_candidates');
select ok(has_function_privilege('authenticated', 'app.denial_risk(uuid)', 'execute'),
  'authenticated can call app.denial_risk');
select ok(not has_function_privilege('anon', 'app.denial_risk(uuid)', 'execute'),
  'anon cannot call app.denial_risk');

select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');   -- schedule.read/write
select is(
  (select count(*)::int from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001')),
  2, 'rank_fill_candidates +: both active caregivers are ranked for the open visit');
select is(
  (select (r.blockers ->> 'blocked') from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001') r
    where r.caregiver_id = 'cccccccc-0000-0000-0000-0000000000c1'),
  'true', 'rank_fill_candidates -: the lapsed-credential caregiver comes back blocked');
select is(
  (select jsonb_array_length(r.blockers -> 'items') from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001') r
    where r.caregiver_id = 'cccccccc-0000-0000-0000-0000000000c1'),
  1, 'rank_fill_candidates -: the blocker list is assert_schedulable''s verdict, verbatim');
select is(
  (select (r.blockers ->> 'blocked') from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001') r
    where r.caregiver_id = 'cccccccc-0000-0000-0000-0000000000c2'),
  'false', 'rank_fill_candidates +: the caregiver with a valid credential is not blocked');
select ok(
  (select r1.score from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001') r1
    where r1.caregiver_id = 'cccccccc-0000-0000-0000-0000000000c2')
  >
  (select r2.score from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001') r2
    where r2.caregiver_id = 'cccccccc-0000-0000-0000-0000000000c1'),
  'rank_fill_candidates +: a schedulable candidate outranks a blocked one');
select ok(
  (select 'Has an active assignment with this client' = any (r.reasons)
     from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001') r
    where r.caregiver_id = 'cccccccc-0000-0000-0000-0000000000c1'),
  'rank_fill_candidates +: familiarity with the client is stated as a reason');
select is(
  (select count(*)::int from app.rank_fill_candidates('cccccccc-0000-0000-0000-0000000e0000')),
  0, 'rank_fill_candidates -: an unknown visit yields no candidates');
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000ad', 'aal2');   -- tenant B, schedule.write
select is(
  (select count(*)::int from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001')),
  0, 'rank_fill_candidates -: another tenant''s visit yields no candidates (tenant isolation)');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');   -- no scheduling permission
select throws_ok(
  $$select * from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001')$$,
  '42501', null,
  'rank_fill_candidates -: a caller without a scheduling permission is refused');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal1');
select throws_ok(
  $$select * from app.rank_fill_candidates('cccccccc-0000-0000-0000-00000000e001')$$,
  '42501', null,
  'rank_fill_candidates -: an AAL1 session is refused (invariant 3)');

-- ═══ Engine: app.denial_risk (docs/16 B2) ══════════════════════════════════
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal2');
select is(
  app.denial_risk('cccccccc-0000-0000-0000-00000000e001') ->> 'ready',
  'false', 'denial_risk -: an unworked, unassigned visit is not claim-ready');
select ok(
  jsonb_array_length(app.denial_risk('cccccccc-0000-0000-0000-00000000e001') -> 'gaps') >= 4,
  'denial_risk -: it names every gap (status, caregiver, clock pair, note)');
select ok(
  app.denial_risk('cccccccc-0000-0000-0000-00000000e001') -> 'gaps'
    @> '["No clock-in was recorded for the visit"]'::jsonb,
  'denial_risk -: the missing EVV clock-in is stated in plain language');
select is(
  app.denial_risk('cccccccc-0000-0000-0000-00000000e002') ->> 'ready',
  'true', 'denial_risk +: a clocked, finalized, signed visit by a credentialed caregiver is ready');
select is(
  jsonb_array_length(app.denial_risk('cccccccc-0000-0000-0000-00000000e002') -> 'gaps'),
  0, 'denial_risk +: a ready visit reports no gaps');
select is(
  app.denial_risk('cccccccc-0000-0000-0000-0000000e0000') ->> 'ready',
  'false', 'denial_risk -: an unknown visit is reported, not assumed ready');
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-0000000000ad', 'aal2');
select ok(
  app.denial_risk('cccccccc-0000-0000-0000-00000000e002') -> 'gaps'
    @> '["The visit was not found"]'::jsonb,
  'denial_risk -: another tenant''s visit is indistinguishable from a missing one');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c0', 'aal1');
select throws_ok(
  $$select app.denial_risk('cccccccc-0000-0000-0000-00000000e002')$$,
  '42501', null,
  'denial_risk -: an AAL1 session is refused (invariant 3)');

reset role;
select * from finish();
rollback;
