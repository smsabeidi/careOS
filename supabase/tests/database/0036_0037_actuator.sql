-- pgTAP · the actuator: notifications (own-inbox scoping, dedupe, dead-account guard)
-- and offers (fanout from approval, first-accept-wins, write-time eligibility, honest
-- exhaustion).
-- @trace: ST-160..166, S4-3, S4-4, S2-8, D-005
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (0011-style: one blocked candidate, one clean) ────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'cg2.a@meadowbrook.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A2', 'cg2.a@meadowbrook.test', 'staff');
insert into public.permission (key, description) values
  ('schedule.write', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c9', 'aaaaaaaa-0000-0000-0000-000000000001', 'caregiver', 'Caregiver');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.write'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000e0c9'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-00000000e0c9');
insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');
-- CPR blocks scheduling; A1 lapsed, A2 valid.
insert into public.credential_type
  (id, tenant_id, key, name, category, required_for_roles, blocks_scheduling) values
  ('aaaaaaaa-0000-0000-0000-0000000c7001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'cpr', 'CPR Certification', 'certification', '{Caregiver}', true);
insert into public.credential
  (tenant_id, app_user_id, credential_type_id, expires_on, status, verified_by, verified_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'aaaaaaaa-0000-0000-0000-0000000c7001', current_date - 5, 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now()),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'aaaaaaaa-0000-0000-0000-0000000c7001', current_date + 300, 'verified',
   'aaaaaaaa-0000-0000-0000-0000000000ad', now());

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Notifications ──────────────────────────────────────────────────────────
select ok(
  app.queue_notification('aaaaaaaa-0000-0000-0000-0000000000c1', 'credential.expiring',
    'A probe notification', p_dedupe_key => 'probe:1') is not null,
  'notify: a notification queues');
select is(
  app.queue_notification('aaaaaaaa-0000-0000-0000-0000000000c1', 'credential.expiring',
    'A probe notification', p_dedupe_key => 'probe:1'),
  null, 'notify: the same dedupe_key is a silent no-op');
update public.app_user set status = 'separated'
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c2';
select is(
  app.queue_notification('aaaaaaaa-0000-0000-0000-0000000000c2', 'credential.expiring', 'x'),
  null, 'notify: a dead account is never notified');
update public.app_user set status = 'active'
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c2';

select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.notification), 1,
  'notify: the recipient reads their own inbox');
select lives_ok(
  $$update public.notification set read_at = now()$$,
  'notify: the recipient marks their own notification read');
select throws_ok(
  $$update public.notification set status = 'delivered'$$,
  '42501', null,
  'notify: delivery telemetry is not the recipient''s to forge (0039, L2)');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.notification), 0,
  'notify: nobody reads a colleague''s inbox');

-- ── Offers: fanout requires an approved plan ───────────────────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.schedule_visit('aaaaaaaa-0000-0000-0000-00000000c001',
      now() + interval '1 day', now() + interval '1 day 2 hours',
      p_note => 'offer-probe-visit')$$,
  'offers: an open visit exists');
select lives_ok(
  $$insert into public.ai_proposal
      (id, tenant_id, capability_key, kind, subject_type, title, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000dd01',
            'aaaaaaaa-0000-0000-0000-000000000001', 'shift.fill', 'assignment',
            'visit', 'Fill plan (probe)', auth.uid())$$,
  'offers: a fill proposal exists');
select throws_like(
  $$select app.create_offers(
      (select id from public.visit where note = 'offer-probe-visit'),
      array['aaaaaaaa-0000-0000-0000-0000000000c1'::uuid],
      'aaaaaaaa-0000-0000-0000-00000000dd01')$$,
  '%CAREOS_NOT_APPROVED%',
  'offers: a pending proposal cannot fan out (invariant 8)');
-- The approval EVENT is the status — ai_proposal itself is append-only (0016).
reset role;
insert into public.ai_proposal_event (tenant_id, proposal_id, action, actor) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000dd01',
   'approve', 'aaaaaaaa-0000-0000-0000-0000000000ad');
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is(
  ((app.create_offers(
      (select id from public.visit where note = 'offer-probe-visit'),
      array['aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
            'aaaaaaaa-0000-0000-0000-0000000000c2'::uuid],
      'aaaaaaaa-0000-0000-0000-00000000dd01')) ->> 'offers_created')::int,
  2, 'offers: the approved plan fans out to both candidates');

-- ── First-accept-wins with write-time eligibility ──────────────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.accept_offer(
      (select id from public.offer where candidate_user_id = auth.uid()
         and status = 'notified'))$$,
  '%CAREOS_NOT_SCHEDULABLE%',
  'offers: the lapsed candidate is refused at accept time (S4-3)');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select lives_ok(
  $$select app.accept_offer(
      (select id from public.offer where candidate_user_id = auth.uid()
         and status = 'notified'))$$,
  'offers: the clean candidate accepts under their own JWT (S2-8)');
reset role;
select is(
  (select caregiver_id from public.visit where note = 'offer-probe-visit'),
  'aaaaaaaa-0000-0000-0000-0000000000c2'::uuid,
  'offers: the visit is theirs');
select is(
  (select status from public.offer
    where candidate_user_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  'superseded',
  'offers: the sibling offer superseded the moment the visit was taken');
select is(
  (select count(*)::int from public.offer_event), 4,
  'offers: the trail carries both creations, the acceptance, and the supersession');

-- ── Exhaustion is loud ─────────────────────────────────────────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.schedule_visit('aaaaaaaa-0000-0000-0000-00000000c001',
      now() + interval '2 days', now() + interval '2 days 2 hours',
      p_note => 'exhaust-probe-visit')$$,
  'exhaustion: a second open visit');
select lives_ok(
  $$select app.create_offers(
      (select id from public.visit where note = 'exhaust-probe-visit'),
      array['aaaaaaaa-0000-0000-0000-0000000000c2'::uuid])$$,
  'exhaustion: one candidate is offered');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select lives_ok(
  $$select app.decline_offer(
      (select id from public.offer where candidate_user_id = auth.uid()
         and status = 'notified'))$$,
  'exhaustion: they decline');
reset role;
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'shift.fill_exhausted'
      and entity_id = (select id from public.visit where note = 'exhaust-probe-visit')),
  1, 'exhaustion: the dead fill announces itself (S4-3''s silent case closed)');

-- ── Expiry + posture ───────────────────────────────────────────────────────
update public.offer set expires_at = now() - interval '1 minute'
 where status in ('pending','notified');
select ok(app.expire_offers() >= 0, 'expiry: the sweep runs');
select is(
  (select count(*)::int from public.offer where status in ('pending','notified')),
  0, 'expiry: no live offers outlive their window');
select ok(not has_table_privilege('authenticated', 'public.offer', 'insert'),
  'posture: offers are RPC-only');
select ok(not has_function_privilege('authenticated', 'app.expire_offers()', 'execute'),
  'posture: expiry is cron plumbing');
select ok(not has_function_privilege('authenticated', 'app.revoke_auth_sessions(uuid)', 'execute'),
  'posture: session revocation is worker-only');

-- ═══ 0039 hardening probes (review 2026-08-05) ═════════════════════════════
-- C1: a non-active principal cannot take or decline an offer, loudly.
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.schedule_visit('aaaaaaaa-0000-0000-0000-00000000c001',
      now() + interval '3 days', now() + interval '3 days 2 hours',
      p_note => 'c1-probe-visit')$$,
  'c1: a third open visit');
select lives_ok(
  $$select app.create_offers(
      (select id from public.visit where note = 'c1-probe-visit'),
      array['aaaaaaaa-0000-0000-0000-0000000000c2'::uuid])$$,
  'c1: the candidate is offered');
reset role;
update public.app_user set status = 'separated', separated_at = now()
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c2';
select is(
  (select status from public.offer
    where candidate_user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'
      and visit_id = (select id from public.visit where note = 'c1-probe-visit')),
  'superseded',
  'c1: leaving active closed the live offer at the moment of deactivation');
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select throws_like(
  $$select app.accept_offer(
      (select o.id from public.offer o
        where o.candidate_user_id = 'aaaaaaaa-0000-0000-0000-0000000000c2'
        order by o.created_at desc limit 1))$$,
  '%CAREOS_FORBIDDEN%',
  'c1: even against a somehow-live offer, a separated principal is refused by name');
reset role;
update public.app_user set status = 'active', separated_at = null
 where id = 'aaaaaaaa-0000-0000-0000-0000000000c2';

-- M3: dispositions are on the AUDIT ledger, not just the offer trail.
select ok(
  (select count(*) >= 1 from audit.audit_event where action = 'offer.accepted'),
  'm3: acceptance is on the audit ledger');
select ok(
  (select count(*) >= 1 from audit.audit_event where action = 'offer.declined'),
  'm3: decline is on the audit ledger');
select ok(
  (select count(*) >= 1 from public.offer_event where actor is not null),
  'm3: the offer trail carries its actor');

-- M4: free-text titles are structurally refused.
select throws_like(
  $$select app.queue_notification('aaaaaaaa-0000-0000-0000-0000000000c2',
      'evil.template', 'Jane Doe has dementia — call me')$$,
  '%CAREOS_BAD_TEMPLATE%',
  'm4: an unregistered template cannot smuggle free text into a notification');

-- H1: the worker heartbeats are pre-seeded and red until earned.
select is(
  (select count(*)::int from public.job_heartbeat
    where job_key in ('worker.q_events','worker.q_notify') and last_ok_at is null),
  2, 'h1: a worker that never came up is visibly stalled, not unknown');

reset role;
select * from finish();
rollback;
