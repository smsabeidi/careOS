-- pgTAP · visit trust score (0048): the arithmetic is exact and reconstructible, the
-- snapshots are append-only and definer-written, the read is verification-gated + AAL2 +
-- tenant-scoped, every reason code comes from the closed trust.v1 vocabulary, the
-- byte-identical-coordinate rule fires on a different client and stays silent on the
-- same one, and no coordinate reaches an assessment row or its audit payload (D-030).
-- Style mirrors 0011_scheduling.sql / 0027_domain_event_outbox.sql.
--
-- Not asserted here, deliberately: CAREOS_POLICY_MISSING. app.visit_trust_score
-- propagates it from app.visit_policy_for (0044 §4.2) rather than handling it — a score
-- computed against thresholds nobody configured would be a number, not evidence — but
-- the raise belongs to 0044 and asserting it through this function would couple this
-- file to another slice's seeding behaviour. 0044's own pgTAP owns that claim.
-- @trace: ST-206, D-021, D-028, D-030
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'trust.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000d5', 'trust.sched.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000a7', 'trust.actor.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'trust.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'trust.cg2.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'trust.cg3.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'trust.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Trust Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Trust Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust Ops Admin A', 'trust.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust Scheduler A', 'trust.sched.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust Disposer A', 'trust.actor.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust Caregiver A1', 'trust.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust Caregiver A2', 'trust.cg2.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust Caregiver A3', 'trust.cg3.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Trust Admin B', 'trust.admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('visit.verify.read', 'test'), ('visit.verify.act', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;

-- Three principal classes, deliberately non-overlapping so each gate is probed alone:
--   ops admin  — visit.verify.read + visit.verify.act + schedule.read (the real role)
--   scheduler  — schedule.read ONLY: may score and may read a snapshot, may not record
--   disposer   — visit.verify.act ONLY: may record without ever holding verify.read
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'trust_ops_admin', 'Trust Ops Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0d5', 'aaaaaaaa-0000-0000-0000-000000000001',
   'trust_scheduler', 'Trust Scheduler'),
  ('aaaaaaaa-0000-0000-0000-00000000e0a7', 'aaaaaaaa-0000-0000-0000-000000000001',
   'trust_disposer', 'Trust Disposer'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'trust_ops_admin', 'Trust Ops Admin B');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.verify.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.verify.act'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0d5', 'schedule.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0a7', 'visit.verify.act'),
  -- Tenant B's admin holds the SAME keys, so every cross-tenant probe below fails on
  -- tenancy alone and never on a missing grant.
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'visit.verify.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000d5', 'aaaaaaaa-0000-0000-0000-00000000e0d5'),
  ('aaaaaaaa-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-00000000e0a7'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust', 'ClientOne'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust', 'ClientTwo'),
  ('aaaaaaaa-0000-0000-0000-00000000c003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Trust', 'ClientThree'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Trust', 'ClientB');

-- Caregiver A1 is on both clients' care teams AND is the assigned caregiver on most of
-- the fixture: enough to read the VISIT (0011), and deliberately not enough to read a
-- trust assessment. That negative is the whole point of the probe further down.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c002',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

-- Tenant-scope visit policy (0044 §3.4 defaults: early clock-in 15, late threshold 7,
-- missing clock-out 20, missed visit 60). app.visit_policy_for resolves to this row for
-- every tenant-A visit, so every threshold below is the documented floor.
insert into public.visit_policy (id, tenant_id, scope_kind, version_no, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000091a1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'tenant', 1, 'aaaaaaaa-0000-0000-0000-0000000000ad');

-- One shared place of care, modelled once (0043): clients One and Three are both seen
-- at it, so their visits bind to the SAME service_location_version. That is the
-- structural proof the repeated-coordinate rule uses to stay quiet.
insert into public.service_location
  (id, tenant_id, client_id, kind, label, is_primary, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000005101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c003', 'facility', 'Meadowbrook House', true,
   'aaaaaaaa-0000-0000-0000-0000000000ad');
insert into public.service_location_version
  (id, tenant_id, service_location_id, created_by, version_no,
   original_address, normalized_address) values
  ('aaaaaaaa-0000-0000-0000-000000005111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000005101', 'aaaaaaaa-0000-0000-0000-0000000000ad', 1,
   '1 Meadowbrook Way, Baltimore, MD 21201', '1 MEADOWBROOK WAY BALTIMORE MD 21201');

-- Visits (inserted as postgres ⇒ the audit/outbox triggers no-op on the seed guard, so
-- no hash chain is forked). created_at is set well into the past on purpose: a visit row
-- created at or after its own clock-in is a back-fill and scores schedule.unscheduled,
-- which none of these fixtures may trip by accident.
--   E001 clean, on time, verified both ends                       → 100 · verified
--   E002 arrival outside the geofence, everything else clean      →  75 · w/ exception
--   E003 nobody ever clocked                                      →  35 · high_risk
--   E004 different client, byte-identical arrival coords to E001  →  97 · verified
--   E005 SAME client, byte-identical arrival coords to E001       → 100 · verified
--   E006 clean capture, one live + one dismissed 0047 finding     →  95 · verified
--   E007 wrong person, offline, sessionless, no fix, late, open   →  20 · high_risk
--   E008/E009 two clients at ONE modelled location, same coords   → 100 · verified
insert into public.visit (id, tenant_id, client_id, caregiver_id, scheduled_start,
                          scheduled_end, status, note, service_location_version_id,
                          created_at) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '3 hours', now() - interval '1 hour', 'completed', 'trust-clean',
   null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '6 hours', now() - interval '5 hours', 'completed', 'trust-geofence',
   null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '1 day', now() - interval '1 day' + interval '2 hours', 'missed',
   'trust-noevents', null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '90 minutes', now() - interval '15 minutes', 'completed',
   'trust-repeat-other-client', null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '2 hours', now() - interval '30 minutes', 'completed',
   'trust-repeat-same-client', null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '8 hours', now() - interval '7 hours', 'completed',
   'trust-exceptions', null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   now() - interval '5 hours', now() - interval '4 hours', 'in_progress', 'trust-worst',
   null, now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   now() - interval '6 hours', now() - interval '5 hours', 'completed',
   'trust-shared-location-a', 'aaaaaaaa-0000-0000-0000-000000005111',
   now() - interval '5 days'),
  ('aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c003', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   now() - interval '5 hours', now() - interval '4 hours', 'completed',
   'trust-shared-location-b', 'aaaaaaaa-0000-0000-0000-000000005111',
   now() - interval '5 days'),
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', null,
   now() - interval '3 hours', now() - interval '1 hour', 'completed', 'trust-tenant-b',
   null, now() - interval '5 days');

-- Clock ledger. Real fixes jitter in the last digit between captures, and these do —
-- except for the three deliberate byte-identical repeats: E001⇄E004 (different clients,
-- the spoofing signal), E001⇄E005 (same client, ordinary) and E008⇄E009 (two clients at
-- one modelled location, ordinary).
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   latitude, longitude, accuracy_m, location_status, capture_source, is_offline,
   device_session_id) values
  ('aaaaaaaa-0000-0000-0000-00000000a101', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '3 hours', 39.2904, -76.6122, 12, 'verified', 'web',
   false, 'sess-e001-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a102', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '1 hour', 39.2905, -76.6123, 14, 'verified', 'web',
   false, 'sess-e001-out'),
  ('aaaaaaaa-0000-0000-0000-00000000a201', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '6 hours', 39.3001, -76.7001, 20, 'outside_geofence',
   'web', false, 'sess-e002-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a202', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '5 hours', 39.3002, -76.7002, 18, 'verified', 'web',
   false, 'sess-e002-out'),
  ('aaaaaaaa-0000-0000-0000-00000000a401', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '90 minutes', 39.2904, -76.6122, 12, 'verified', 'web',
   false, 'sess-e004-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a402', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '15 minutes', 39.2907, -76.6125, 15, 'verified', 'web',
   false, 'sess-e004-out'),
  ('aaaaaaaa-0000-0000-0000-00000000a501', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '2 hours', 39.2904, -76.6122, 11, 'verified', 'web',
   false, 'sess-e005-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a502', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '30 minutes', 39.2906, -76.6124, 13, 'verified', 'web',
   false, 'sess-e005-out'),
  ('aaaaaaaa-0000-0000-0000-00000000a601', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in', now() - interval '8 hours', 39.4001, -76.8001, 10, 'verified', 'web',
   false, 'sess-e006-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a602', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', now() - interval '7 hours', 39.4002, -76.8002, 10, 'verified', 'web',
   false, 'sess-e006-out'),
  -- E007: caregiver A2 clocked a visit assigned to A1 — offline, sessionless, with no
  -- usable fix, two hours late, and never clocked out.
  ('aaaaaaaa-0000-0000-0000-00000000a701', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_in', now() - interval '3 hours', null, null, null, 'unavailable', 'offline',
   true, null),
  ('aaaaaaaa-0000-0000-0000-00000000a801', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   'clock_in', now() - interval '6 hours', 39.5001, -76.9001, 12, 'verified', 'web',
   false, 'sess-e008-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a802', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   'clock_out', now() - interval '5 hours', 39.5002, -76.9002, 12, 'verified', 'web',
   false, 'sess-e008-out'),
  ('aaaaaaaa-0000-0000-0000-00000000a901', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   'clock_in', now() - interval '5 hours', 39.5001, -76.9001, 12, 'verified', 'web',
   false, 'sess-e009-in'),
  ('aaaaaaaa-0000-0000-0000-00000000a902', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e009', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   'clock_out', now() - interval '4 hours', 39.5003, -76.9003, 12, 'verified', 'web',
   false, 'sess-e009-out');

-- 0047's ledger for E006: one live impossible_travel, one DISMISSED overlap. A dismissal
-- is a human saying "not a real problem" — a deterministic input the scorer honours.
insert into public.visit_exception (id, tenant_id, visit_id, kind, severity, dedupe_key)
values
  ('aaaaaaaa-0000-0000-0000-0000000e6001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'impossible_travel', 'critical',
   'trust-e006-it'),
  ('aaaaaaaa-0000-0000-0000-0000000e6002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'overlapping_visits', 'warning',
   'trust-e006-ov');
insert into public.visit_exception_disposition
  (tenant_id, exception_id, disposition, reason, acted_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000e6002',
   'dismissed', 'Double-booked in the roster, not in the field.',
   'aaaaaaaa-0000-0000-0000-0000000000ad');

-- ═══ Structure: RLS enabled AND forced (docs/07 §1 convention 4) ════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname = 'visit_trust_assessment'
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'trust: RLS is enabled + forced on visit_trust_assessment');

-- ═══ Grants: read-only for humans, definer-only for writes ══════════════════
select ok(has_table_privilege('authenticated', 'public.visit_trust_assessment', 'select'),
  'grant +: authenticated may read assessments (RLS gates the rows)');
select ok(not has_table_privilege('authenticated', 'public.visit_trust_assessment',
  'insert'),
  'grant -: no INSERT grant — a client that could insert a score could forge one');
select ok(not has_table_privilege('authenticated', 'public.visit_trust_assessment',
  'update'), 'grant -: no UPDATE grant (append-only)');
select ok(not has_table_privilege('authenticated', 'public.visit_trust_assessment',
  'delete'), 'grant -: no DELETE grant (append-only)');
select ok(has_function_privilege('authenticated', 'app.visit_trust_score(uuid)',
  'execute'), 'grant +: authenticated may execute app.visit_trust_score');
select ok(has_function_privilege('authenticated', 'app.record_trust_assessment(uuid)',
  'execute'), 'grant +: authenticated may execute app.record_trust_assessment');
select ok(not has_function_privilege('anon', 'app.visit_trust_score(uuid)', 'execute'),
  'grant -: anon may not execute app.visit_trust_score');
select ok(not has_function_privilege('anon', 'app.record_trust_assessment(uuid)',
  'execute'), 'grant -: anon may not execute app.record_trust_assessment');

-- ═══ The table's structural guards (D-028, D-030) ═══════════════════════════
-- Written as superuser: these are CHECK constraints, so they hold for every writer that
-- will ever exist, including a future definer RPC that forgets the discipline.
select throws_ok($$
  insert into public.visit_trust_assessment
    (tenant_id, visit_id, score, band, components, reasons, model_version)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001', 100, 'verified',
          '{"location":35}'::jsonb,
          '[{"code":"location.unavailable","latitude":39.2904}]'::jsonb, 'trust.v1')
$$, '23514', null,
  'trust -: a coordinate in reasons is refused by CHECK (invariant 5, D-030)');
select throws_ok($$
  insert into public.visit_trust_assessment
    (tenant_id, visit_id, score, band, components, reasons, model_version)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001', 100, 'verified',
          '{"location":35,"lat":39.2904}'::jsonb, '[]'::jsonb, 'trust.v1')
$$, '23514', null, 'trust -: a coordinate in components is refused by CHECK (D-030)');
select throws_ok($$
  insert into public.visit_trust_assessment
    (tenant_id, visit_id, score, band, components, reasons, model_version)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001', 100, 'verified',
          '{"location":35}'::jsonb,
          '[{"code":"caregiver seems dishonest"}]'::jsonb, 'trust.v1')
$$, '23514', null,
  'trust -: prose outside the closed trust.v1 vocabulary is refused (D-028)');
select throws_ok($$
  insert into public.visit_trust_assessment
    (tenant_id, visit_id, score, band, components, reasons, model_version)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001', 100, 'high_risk',
          '{"location":35}'::jsonb, '[]'::jsonb, 'trust.v1')
$$, '23514', null,
  'trust -: a band that disagrees with its own score is refused (D-028)');

-- Session simulator (identical to 002/003/0011/0047).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ app.visit_trust_score — the gate ═══════════════════════════════════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'score -: an unverified session cannot score a visit (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_FORBIDDEN%',
  'score -: the assigned caregiver holds no verification permission and is refused');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_NOT_FOUND%',
  'score -: tenant-B admin cannot score a tenant-A visit (tenant isolation)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-0000000000ff')$$,
  '%CAREOS_NOT_FOUND%', 'score -: an unknown visit id is refused');
select lives_ok(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  'score +: visit.verify.read at AAL2 scores a visit');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000d5', 'aal2');
select lives_ok(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  'score +: schedule.read alone is sufficient to score (docs/17 §3.9 read scope)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000a7', 'aal2');
select lives_ok(
  $$select app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  'score +: visit.verify.act composes — a disposer sees the evidence they act on');

-- ═══ The arithmetic, component by component ═════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');

select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001')
             ->> 'score')::int, 100,
  'score +: a clean visit scores 100 (all six components at full marks)');
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'band',
  'verified', 'band +: 100 bands as verified');
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001') ->> 'model_version',
  'trust.v1', 'score +: the weight set that produced the number is named on it');
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001') -> 'weights',
  jsonb_build_object('location', 35, 'time', 20, 'schedule', 15,
                     'identity', 15, 'device', 10, 'consistency', 5),
  'score +: trust.v1 weights are returned verbatim (docs/17 §4.9)');
select is(jsonb_array_length(
  app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e001') -> 'reasons'), 0,
  'score +: a clean visit carries no reason codes at all');

-- 35 − 25 (outside geofence on arrival) = 10 → 75, the verified_with_exception floor.
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e002')
             ->> 'score')::int, 75,
  'score +: one out-of-fence arrival costs 25 of the 35 location points');
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e002') ->> 'band',
  'verified_with_exception', 'band +: 75 is the verified_with_exception floor');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e002') -> 'reasons'
  @? '$[*] ? (@.code == "location.outside_geofence")',
  'reason +: the deduction names location.outside_geofence');
select is(
  (select r ->> 'detail_id'
     from jsonb_array_elements(
       app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e002') -> 'reasons') r
    where r ->> 'code' = 'location.outside_geofence'),
  'aaaaaaaa-0000-0000-0000-00000000a201',
  'reason +: the code carries the id of the row that evidences it (D-028)');

-- No ledger at all: location and device have nothing to weigh, and the clock-out window
-- has long passed. 0 + 0 + 15 + 15 + 0 + 5 = 35.
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e003')
             ->> 'score')::int, 35,
  'score +: a visit nobody clocked scores 35 (no location, no device, no clock-out)');
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e003') ->> 'band',
  'high_risk', 'band +: 35 bands as high_risk');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e003') -> 'reasons'
  @? '$[*] ? (@.code == "time.no_clock_out")',
  'reason +: the missing clock-out is named once the policy window has passed');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e003') -> 'reasons'
  @? '$[*] ? (@.code == "location.unavailable")',
  'reason +: absence of evidence is scored as absence of evidence, and says so');

-- ═══ The byte-identical-coordinate rule (the slice's sharpest edge) ═════════
-- Fires: a different client, same caregiver, same coordinates to the last digit.
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e004')
             -> 'components' ->> 'consistency')::int, 2,
  'consistency +: an exact coordinate repeat across clients costs 3 of 5');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e004') -> 'reasons'
  @? '$[*] ? (@.code == "consistency.repeated_coordinates")',
  'reason +: the spoofing signal is named consistency.repeated_coordinates');
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e004')
             ->> 'score')::int, 97,
  'score +: the repeat is a 3-point signal, not a finding (D-028)');

-- Silent: the SAME client at the same doorstep. This is the false positive that would
-- make the whole signal useless, and it must never fire.
select ok(not (app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e005') -> 'reasons'
  @? '$[*] ? (@.code == "consistency.repeated_coordinates")'),
  'consistency -: identical coordinates for the SAME client are normal and cost nothing');
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e005')
             ->> 'score')::int, 100,
  'score +: a second visit to the same address still scores 100');

-- Silent: two clients at one MODELLED place of care. Both visits bind to the same
-- service_location_version, which is structural proof of a shared address.
select ok(not (app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e009') -> 'reasons'
  @? '$[*] ? (@.code == "consistency.repeated_coordinates")'),
  'consistency -: two clients at one modelled service location are not a repeat');
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e009')
             ->> 'score')::int, 100,
  'score +: the shared-location visit scores 100');

-- ═══ Consistency reads 0047's findings; it never recomputes them ════════════
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e006')
             -> 'components' ->> 'consistency')::int, 0,
  'consistency +: a live impossible_travel finding costs the whole component');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e006') -> 'reasons'
  @? '$[*] ? (@.code == "consistency.impossible_travel")',
  'reason +: the finding is cited by id, not re-derived (invariant 13)');
select ok(not (app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e006') -> 'reasons'
  @? '$[*] ? (@.code == "consistency.overlap")'),
  'consistency -: a DISMISSED finding stops costing points');
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e006')
             ->> 'band'), 'verified',
  'band +: a cross-visit finding does not by itself unverify a clean capture (D-028)');

-- ═══ The worst case: every component that can fail, failing ════════════════
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'components',
  jsonb_build_object('location', 15, 'time', 0, 'schedule', 0,
                     'identity', 0, 'device', 0, 'consistency', 5),
  'score +: the worst case decomposes exactly as the deduction table says');
select is((app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007')
             ->> 'score')::int, 20, 'score +: the worst case totals 20');
select is(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') ->> 'band',
  'high_risk', 'band +: 20 bands as high_risk');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'reasons'
  @? '$[*] ? (@.code == "identity.unassigned_caregiver")',
  'reason +: a clock by someone other than the assigned caregiver is named');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'reasons'
  @? '$[*] ? (@.code == "device.offline_capture")',
  'reason +: an offline replay is named, and costs device points, not location points');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'reasons'
  @? '$[*] ? (@.code == "device.session_missing")',
  'reason +: a capture with no device session is named');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'reasons'
  @? '$[*] ? (@.code == "time.late_start")',
  'reason +: lateness is measured against the policy grace, and is named');
select ok(app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'reasons'
  @? '$[*] ? (@.code == "schedule.unscheduled")',
  'reason +: an arrival after the visit was already a no-show is unscheduled work');
select is(
  (select sum((value)::int)::int from jsonb_each_text(
     app.visit_trust_score('aaaaaaaa-0000-0000-0000-00000000e007') -> 'components')),
  20, 'score +: the components sum to the score — the subtraction always adds up');

-- ═══ The closed vocabulary and the D-030 canary, swept over every fixture ═══
select is((
  select count(*)::int
    from public.visit v
    cross join lateral jsonb_array_elements(
      app.visit_trust_score(v.id) -> 'reasons') r
   where v.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and (r ->> 'code') not in (
       'location.outside_geofence','location.low_accuracy','location.unavailable',
       'time.late_start','time.no_clock_out','schedule.unscheduled',
       'identity.unassigned_caregiver','device.offline_capture','device.session_missing',
       'consistency.impossible_travel','consistency.overlap',
       'consistency.repeated_coordinates')),
  0, 'trust +: every reason code emitted is in the closed trust.v1 vocabulary (D-028)');
select is((
  select count(*)::int
    from public.visit v
   where v.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and (app.visit_trust_score(v.id))::text like '%39.2904%'),
  0, 'trust +: no captured latitude appears anywhere in a score payload (D-030)');
select is((
  select count(*)::int
    from public.visit v
    cross join lateral jsonb_array_elements(
      app.visit_trust_score(v.id) -> 'reasons') r
   where v.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and r ?| array['lat','lng','latitude','longitude','coordinates','geo','point']),
  0, 'trust +: no reason object carries a coordinate key (invariant 5)');

-- ═══ app.record_trust_assessment ════════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.record_trust_assessment('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  '%CAREOS_AAL2_REQUIRED%', 'record -: an unverified session cannot pin evidence');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000d5', 'aal2');
select throws_like(
  $$select app.record_trust_assessment('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  '%CAREOS_FORBIDDEN%',
  'record -: schedule.read may read a score but may not pin one to the record');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.record_trust_assessment('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  '%CAREOS_FORBIDDEN%',
  'record -: tenant-B admin holds no visit.verify.act and is refused first');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000a7', 'aal2');
select throws_like(
  $$select app.record_trust_assessment('aaaaaaaa-0000-0000-0000-0000000000ff')$$,
  '%CAREOS_NOT_FOUND%', 'record -: an unknown visit id is refused');
select lives_ok(
  $$select app.record_trust_assessment('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  'record +: visit.verify.act at AAL2 appends a snapshot');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.record_trust_assessment('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  'record +: a second call appends a SECOND snapshot — re-scoring is not idempotent');

reset role;
select is((select count(*)::int from public.visit_trust_assessment
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'), 2,
  'record +: two calls left two rows; both readings survive (invariant 1)');
select is((select distinct score from public.visit_trust_assessment
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'), 75,
  'record +: the persisted score is the computed score, unrounded and unedited');
select is((select distinct band from public.visit_trust_assessment
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  'verified_with_exception', 'record +: the persisted band matches its own arithmetic');
select is((select distinct model_version from public.visit_trust_assessment
            where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'), 'trust.v1',
  'record +: the snapshot names the weight set, so it stays interpretable');

-- ═══ Append-only, both layers (invariant 1) ════════════════════════════════
-- Layer 1: the trigger, probed as superuser — the grant cannot be the only defence,
-- because a future definer RPC runs with the table owner's rights.
select throws_like(
  $$update public.visit_trust_assessment set score = 100
     where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: visit_trust_assessment UPDATE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.visit_trust_assessment
     where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'$$,
  '%CAREOS_APPEND_ONLY%',
  'append-only: visit_trust_assessment DELETE raises CAREOS_APPEND_ONLY');
-- Layer 2 is the grant matrix asserted at the top of this file.

-- ═══ The audit trail carries ids, one enum and one integer — nothing else ══
select is((select count(*)::int from audit.audit_event
            where action = 'visit.trust_assessed'), 2,
  'audit +: every recorded assessment emitted an audit event (invariant 7)');
select is((select count(*)::int from audit.audit_event
            where action = 'visit.trust_assessed'
              and payload::text like '%39.%'), 0,
  'audit -: no coordinate reaches an audit payload (D-030, invariant 5)');
select is((
  select count(*)::int from audit.audit_event e
   where e.action = 'visit.trust_assessed'
     and exists (select 1 from jsonb_object_keys(e.payload) k
                  where k not in ('visit_id','band','score','model_version'))),
  0, 'audit -: the payload carries exactly {visit_id, band, score, model_version}');

-- ═══ RLS matrix on the snapshots, per principal class, both polarities ═════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_trust_assessment), 2,
  'trust +: visit.verify.read at AAL2 reads the tenant''s assessments');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000d5', 'aal2');
select is((select count(*)::int from public.visit_trust_assessment), 2,
  'trust +: schedule.read reads them too (docs/17 §3.9 read scope)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select is((select count(*)::int from public.visit_trust_assessment), 0,
  'trust -: the same admin at AAL1 sees nothing (invariant 3)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.visit_trust_assessment), 0,
  'trust -: the scored visit''s own caregiver sees no assessment (disclosed by a human)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.visit_trust_assessment), 0,
  'trust -: an unrelated caregiver sees nothing');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.visit_trust_assessment), 0,
  'trust -: tenant-B admin sees no tenant-A assessment (tenant isolation)');

reset role;
select * from finish();
rollback;
