-- pgTAP · Payroll boundary (0050): that approved_work_segment and payroll_export are
-- tenant-scoped, AAL2-gated and append-only in BOTH layers; that payroll_period is
-- no-delete but status-mutable and RPC-only; that self-approval is refused by the RPC
-- AND by a CHECK; that rounding is half-away-from-zero at the grain the policy names;
-- that corrections fold into payroll minutes where public.verified_visit deliberately
-- leaves them out; that an open critical exception blocks approval and a dismissed one
-- does not; that a period will not close while a completed visit still waits on a human,
-- and says how many; that the export carries four columns and a stable content hash and
-- names no client; and that neither a coordinate nor a rejection reason reaches an audit
-- payload, an outbox payload or a queue message (invariant 5, D-030).
-- @trace: ST-208, D-024, D-027, D-030
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions, two tenants) ────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'pay.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'pay.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'pay.cg2.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'pay.cg3.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'pay.nurse.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'pay.admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Payroll Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Payroll Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Payroll Admin A', 'pay.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Lead Caregiver A1', 'pay.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Caregiver A2', 'pay.cg2.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Caregiver A3', 'pay.cg3.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Nurse A', 'pay.nurse.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Payroll Admin B', 'pay.admin.b@brookmead.test', 'staff');

-- The keys 0050 inserts into the catalog, re-stated so this file reads alone.
insert into public.permission (key, description) values
  ('visit.approve', 'test'), ('payroll.read', 'test'), ('payroll.manage', 'test'),
  ('schedule.read', 'test'), ('visit.verify.read', 'test')
on conflict (key) do nothing;

-- Three principal classes on purpose:
--   payroll_admin  — approves AND runs payroll (the desk)
--   lead_caregiver — holds visit.approve and nothing else (the self-approval probe:
--                    the only way to prove the bar is real is to hand somebody the
--                    permission and watch it still refuse)
--   (cg2, cg3, nurse hold no payroll permission at all)
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'payroll_admin', 'Payroll Admin'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'lead_caregiver', 'Lead Caregiver'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'payroll_admin', 'Payroll Admin');
-- schedule.read and visit.verify.read ride along on the desk role because a payroll
-- administrator who cannot open the day's visits or the exception queue cannot do the
-- job — and because several assertions below read public.visit and
-- public.visit_exception_state through this principal's own RLS rather than around it.
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.approve'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'payroll.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'payroll.manage'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'visit.verify.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0c1', 'visit.approve'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'visit.approve'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'payroll.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'payroll.manage'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000e0c1'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'Payroll', 'ClientA'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'Payroll', 'ClientB');

-- The nurse is care-team-only. She is the probe for "clinical access is not pay access":
-- being on the case lets her read the client's care, never the caregiver's wages.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000d1', 'rn_case_manager');

-- Tenant-scope policy: quarter-hour rounding and the 40-hour default ceiling. Every
-- visit below binds to it (policy_id), the D-014 way, so the arithmetic is reproducible.
insert into public.visit_policy
  (id, tenant_id, scope_kind, version_no, rounding_policy, overtime_weekly_minutes,
   created_by) values
  ('aaaaaaaa-0000-0000-0000-000000007001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'tenant', 1, 'nearest_15', 2400, 'aaaaaaaa-0000-0000-0000-0000000000ad');

-- Visits. Inserted as postgres with no JWT ⇒ the audit and outbox triggers no-op (seed
-- guard), so the ledgers read at the end hold only what the 0050 RPCs actually emitted.
-- 2026-06-01 is a Monday, so 06-01…06-07 is one whole ISO week — the payroll period.
--   IN the period window (the export set):
--     e001 completed, cg1, clocked 13:07→15:04  → 117 verified, 120 rounded
--     e005 completed, cg2, clocked 13:00→15:00  → 120 verified, 120 rounded
--     e007 completed, cg1, clock-out CORRECTED  → 90 on the raw ledger, 120 corrected
--   OUTSIDE the window (the refusal probes, kept out so the close test stays tractable):
--     e002 completed, open CRITICAL exception   → CAREOS_APPROVAL_BLOCKED
--     e003 still scheduled                      → CAREOS_BAD_STATE
--     e004 completed, never clocked             → CAREOS_NO_HOURS
--     e006 completed, clock-out before clock-in → CAREOS_INCOHERENT_LEDGER
insert into public.visit
  (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status,
   policy_id, note) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-01 13:00:00+00', '2026-06-01 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-happy'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-20 13:00:00+00', '2026-06-20 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-blocked'),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-21 13:00:00+00', '2026-06-21 15:00:00+00', 'scheduled',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-scheduled'),
  ('aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-22 13:00:00+00', '2026-06-22 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-unclocked'),
  ('aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   '2026-06-02 13:00:00+00', '2026-06-02 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-cg2'),
  ('aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-23 13:00:00+00', '2026-06-23 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-incoherent'),
  ('aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-06-03 13:00:00+00', '2026-06-03 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-corrected'),
  -- e008 exists only to hang cg3's synthetic overtime week off. It has its OWN visit
  -- precisely because the approval RPC supersedes the head segment of the visit it acts
  -- on: parking eight hand-written segments on a visit the RPCs also touch would let one
  -- fixture silently rewrite another (which is how this file first failed).
  ('aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-08 13:00:00+00', '2026-06-08 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000007001', 'pay-overtime-week'),
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', null,
   '2026-06-01 13:00:00+00', '2026-06-01 15:00:00+00', 'completed',
   null, 'pay-tenant-b');

-- Clock ledger. 39.2904 is the canary payload: it must never appear downstream of this
-- table in any audit payload, outbox payload or queue message (D-030).
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   latitude, longitude, accuracy_m, method) values
  ('aaaaaaaa-0000-0000-0000-00000000ea01', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-06-01 13:07:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea02', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-06-01 15:04:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea51', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_in',  '2026-06-02 13:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea52', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_out', '2026-06-02 15:00:00+00', 39.2904, -76.6122, 12, 'web'),
  -- e006: the clock-out precedes the clock-in. An incoherent ledger, not zero hours.
  ('aaaaaaaa-0000-0000-0000-00000000ea61', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-06-23 15:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea62', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-06-23 13:00:00+00', 39.2904, -76.6122, 12, 'web'),
  -- e007: clocked out an hour and a half in, then corrected to the true departure.
  ('aaaaaaaa-0000-0000-0000-00000000ea71', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-06-03 13:00:00+00', 39.2904, -76.6122, 12, 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000ea72', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-06-03 14:30:00+00', 39.2904, -76.6122, 12, 'web');
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at, method,
   capture_source, corrects_event_id) values
  ('aaaaaaaa-0000-0000-0000-00000000ea73', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e007', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'correction', '2026-06-03 15:00:00+00', 'manual', 'manual',
   'aaaaaaaa-0000-0000-0000-00000000ea72');

-- 0047's ledger. e002 carries an OPEN critical finding (nothing disposed it); e001
-- carries a critical finding that a human DISMISSED. Both are 'critical' — the only
-- difference is `open`, which is exactly what the approval gate is allowed to care about.
insert into public.visit_exception
  (id, tenant_id, visit_id, caregiver_id, kind, severity, dedupe_key) values
  ('aaaaaaaa-0000-0000-0000-0000000e2001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'impossible_travel', 'critical', 'pay-e002-it'),
  ('aaaaaaaa-0000-0000-0000-0000000e1001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'overlapping_visits', 'critical', 'pay-e001-ov');
insert into public.visit_exception_disposition
  (tenant_id, exception_id, disposition, reason, acted_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000e1001',
   'dismissed', 'Double-booked in the roster, not in the field.',
   'aaaaaaaa-0000-0000-0000-0000000000ad');

-- Overtime fixture for cg3, hung off e008 in the FOLLOWING ISO week (2026-06-08…06-14) so
-- it stays out of the exported period. Four 10-hour days = 2400, plus a corrected fifth
-- day worth 120, = 2520 approved minutes against a 2400 ceiling ⇒ 120 overtime minutes.
-- Two decoys prove the sum is honest: a SUPERSEDED segment (what we used to think) and a
-- REJECTED one (what we refused to pay) — neither may be counted.
insert into public.approved_work_segment
  (id, tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
   rounding_applied, pay_code, decision, approval_note, approved_by, supersedes_id) values
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-08', 600, 600, 'none', 'regular', 'approved', null,
   'aaaaaaaa-0000-0000-0000-0000000000ad', null),
  ('aaaaaaaa-0000-0000-0000-00000000f002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-09', 600, 600, 'none', 'regular', 'approved', null,
   'aaaaaaaa-0000-0000-0000-0000000000ad', null),
  ('aaaaaaaa-0000-0000-0000-00000000f003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-10', 600, 600, 'none', 'regular', 'approved', null,
   'aaaaaaaa-0000-0000-0000-0000000000ad', null),
  ('aaaaaaaa-0000-0000-0000-00000000f004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-11', 600, 600, 'none', 'regular', 'approved', null,
   'aaaaaaaa-0000-0000-0000-0000000000ad', null),
  -- Superseded by f006: this is the number we replaced, and it must not be summed.
  ('aaaaaaaa-0000-0000-0000-00000000f005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-12', 480, 480, 'none', 'regular', 'approved', null,
   'aaaaaaaa-0000-0000-0000-0000000000ad', null),
  ('aaaaaaaa-0000-0000-0000-00000000f006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-12', 480, 120, 'none', 'regular', 'approved', 'Corrected down.',
   'aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000f005'),
  -- A refusal to pay: zero minutes by constraint, and excluded from the sum by decision.
  ('aaaaaaaa-0000-0000-0000-00000000f007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e008', 'aaaaaaaa-0000-0000-0000-0000000000c3',
   '2026-06-14', 240, 0, 'none', 'regular', 'rejected', 'Fixture rejection.',
   'aaaaaaaa-0000-0000-0000-0000000000ad', null);

-- A throwaway period for the no_delete / status-mutability probes, so the real period
-- the RPCs drive is never poked at by hand.
insert into public.payroll_period
  (id, tenant_id, starts_on, ends_on, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000009009', 'aaaaaaaa-0000-0000-0000-000000000001',
   '2026-07-01', '2026-07-07', 'aaaaaaaa-0000-0000-0000-0000000000ad');

-- Session simulator (identical to 002/003/0011/0049).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ Posture: RLS enabled AND forced (docs/07 §1 convention 4) ══════════════
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('approved_work_segment','payroll_period','payroll_export')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'posture: RLS is enabled + forced on all three payroll tables');

-- ═══ Grants: read-only for humans, definer-only for every write ═════════════
select ok(has_table_privilege('authenticated', 'public.approved_work_segment', 'select'),
  'grant +: authenticated may read segments (RLS gates the rows)');
select ok(not has_table_privilege('authenticated', 'public.approved_work_segment', 'insert'),
  'grant -: no INSERT on approved_work_segment — a forgeable segment is forgeable money');
select ok(not has_table_privilege('authenticated', 'public.approved_work_segment', 'update'),
  'grant -: no UPDATE on approved_work_segment (append-only)');
select ok(not has_table_privilege('authenticated', 'public.approved_work_segment', 'delete'),
  'grant -: no DELETE on approved_work_segment (append-only)');
select ok(has_table_privilege('authenticated', 'public.payroll_period', 'select'),
  'grant +: authenticated may read payroll periods');
select ok(not has_table_privilege('authenticated', 'public.payroll_period', 'insert'),
  'grant -: no INSERT on payroll_period (RPC-only)');
select ok(not has_table_privilege('authenticated', 'public.payroll_period', 'update'),
  'grant -: no UPDATE on payroll_period — the close gate would be bypassable');
select ok(not has_table_privilege('authenticated', 'public.payroll_period', 'delete'),
  'grant -: no DELETE on payroll_period');
select ok(has_table_privilege('authenticated', 'public.payroll_export', 'select'),
  'grant +: authenticated may read export provenance');
select ok(not has_table_privilege('authenticated', 'public.payroll_export', 'insert'),
  'grant -: no INSERT on payroll_export (a forged export is a forged provenance claim)');
select ok(not has_table_privilege('authenticated', 'public.payroll_export', 'update'),
  'grant -: no UPDATE on payroll_export (append-only)');
select ok(not has_table_privilege('authenticated', 'public.payroll_export', 'delete'),
  'grant -: no DELETE on payroll_export (append-only)');

select ok(has_function_privilege('authenticated',
  'app.compute_visit_minutes(uuid)', 'execute'),
  'grant +: authenticated may execute app.compute_visit_minutes');
select ok(has_function_privilege('authenticated',
  'app.compute_overtime(uuid,date)', 'execute'),
  'grant +: authenticated may execute app.compute_overtime');
select ok(has_function_privilege('authenticated',
  'app.approve_visit_hours(uuid,integer,text,text)', 'execute'),
  'grant +: authenticated may execute app.approve_visit_hours');
select ok(has_function_privilege('authenticated',
  'app.reject_visit_hours(uuid,text)', 'execute'),
  'grant +: authenticated may execute app.reject_visit_hours');
select ok(has_function_privilege('authenticated',
  'app.open_payroll_period(date,date)', 'execute'),
  'grant +: authenticated may execute app.open_payroll_period');
select ok(has_function_privilege('authenticated',
  'app.close_payroll_period(uuid)', 'execute'),
  'grant +: authenticated may execute app.close_payroll_period');
select ok(has_function_privilege('authenticated',
  'app.export_payroll_period(uuid)', 'execute'),
  'grant +: authenticated may execute app.export_payroll_period');
select ok(not has_function_privilege('anon',
  'app.approve_visit_hours(uuid,integer,text,text)', 'execute'),
  'grant -: anon may not execute app.approve_visit_hours');
select ok(not has_function_privilege('anon',
  'app.export_payroll_period(uuid)', 'execute'),
  'grant -: anon may not execute app.export_payroll_period');
select ok(not has_function_privilege('authenticated',
  'app.round_minutes(integer,text)', 'execute'),
  'grant -: app.round_minutes is internal plumbing, not a client lane');
select ok(not has_function_privilege('service_role',
  'app.approve_visit_hours(uuid,integer,text,text)', 'execute'),
  'grant -: service_role holds no payroll lane (invariant 6)');

-- ═══ app.round_minutes — the truth table, boundaries included ═══════════════
-- Run as the owner: this is pure arithmetic and needs no session.
select is(app.round_minutes(117, 'none'), 117,
  'rounding +: none leaves 117 alone');
select is(app.round_minutes(117, 'nearest_1'), 117,
  'rounding +: nearest_1 is identity on whole minutes');
select is(app.round_minutes(117, 'nearest_5'), 115,
  'rounding +: nearest_5 takes 117 down to 115');
select is(app.round_minutes(117, 'nearest_6'), 120,
  'rounding +: nearest_6 is tenths of an hour — 117 becomes 120');
select is(app.round_minutes(117, 'nearest_15'), 120,
  'rounding +: nearest_15 is quarter hours — 117 becomes 120');
select is(app.round_minutes(7, 'nearest_15'), 0,
  'rounding +: 7 minutes is below the quarter-hour half-way point and rounds to 0');
select is(app.round_minutes(8, 'nearest_15'), 15,
  'rounding +: 8 minutes is above it and rounds to 15');
-- THE BANKER'S-ROUNDING CANARY. 15/6 = 2.5 exactly, and 2 is even: numeric round() goes
-- away from zero (3 ⇒ 18) while float8 round() goes to even (2 ⇒ 12). If this assertion
-- ever reads 12, somebody dropped the ::numeric cast and half the boundary timesheets in
-- the agency just lost minutes.
select is(app.round_minutes(15, 'nearest_6'), 18,
  'rounding +: half rounds away from zero, not to even (the ::numeric cast is real)');
select ok(app.round_minutes(null, 'nearest_15') is null,
  'rounding +: no minutes in, no minutes out');

-- ═══ Structural guards — CHECKs hold for every writer that will ever exist ══
select throws_ok($$
  insert into public.approved_work_segment
    (tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
     approved_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001',
          'aaaaaaaa-0000-0000-0000-0000000000c1', '2026-06-01', 120, 120,
          'aaaaaaaa-0000-0000-0000-0000000000c1')
$$, '23514', null,
  'segment -: approving your own hours is refused by CHECK, not just by the RPC (D-027)');
select throws_ok($$
  insert into public.approved_work_segment
    (tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
     decision, approval_note, approved_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001',
          'aaaaaaaa-0000-0000-0000-0000000000c1', '2026-06-01', 120, 120,
          'rejected', 'a reason', 'aaaaaaaa-0000-0000-0000-0000000000ad')
$$, '23514', null, 'segment -: a rejection carrying minutes is refused (it approves nothing)');
select throws_ok($$
  insert into public.approved_work_segment
    (tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
     decision, approved_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001',
          'aaaaaaaa-0000-0000-0000-0000000000c1', '2026-06-01', 120, 0,
          'rejected', 'aaaaaaaa-0000-0000-0000-0000000000ad')
$$, '23514', null, 'segment -: a rejection with no reason is refused (DN-0050a)');
select throws_ok($$
  insert into public.approved_work_segment
    (id, tenant_id, visit_id, caregiver_id, work_date, verified_minutes,
     approved_minutes, approved_by, supersedes_id)
  values ('aaaaaaaa-0000-0000-0000-00000000ffff',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001',
          'aaaaaaaa-0000-0000-0000-0000000000c1', '2026-06-01', 120, 120,
          'aaaaaaaa-0000-0000-0000-0000000000ad',
          'aaaaaaaa-0000-0000-0000-00000000ffff')
$$, '23514', null, 'segment -: a segment cannot supersede itself (a chain of one)');
select throws_ok($$
  insert into public.approved_work_segment
    (tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
     approved_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000e001',
          'aaaaaaaa-0000-0000-0000-0000000000c1', '2026-06-01', -5, 120,
          'aaaaaaaa-0000-0000-0000-0000000000ad')
$$, '23514', null, 'segment -: negative verified minutes are refused');
select throws_ok($$
  insert into public.payroll_period (tenant_id, starts_on, ends_on, created_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-07-31', '2026-07-01',
          'aaaaaaaa-0000-0000-0000-0000000000ad')
$$, '23514', null, 'period -: an inverted window is refused');
select throws_ok($$
  insert into public.payroll_period (tenant_id, starts_on, ends_on, status, created_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001', '2026-08-01', '2026-08-07', 'locked',
          'aaaaaaaa-0000-0000-0000-0000000000ad')
$$, '23514', null, 'period -: a locked period with nobody attributed to the lock is refused');
select throws_ok($$
  insert into public.payroll_export
    (tenant_id, period_id, row_count, total_minutes, content_sha256, exported_by)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000009009', 1, 60, 'not-a-sha',
          'aaaaaaaa-0000-0000-0000-0000000000ad')
$$, '23514', null, 'export -: a hash-shaped hash or nothing (provenance must be real)');

-- ═══ Append-only / no-delete, in the trigger layer (even for the owner) ═════
select throws_like(
  $$update public.approved_work_segment set approved_minutes = 999$$,
  '%CAREOS_APPEND_ONLY%',
  'segment -: UPDATE raises CAREOS_APPEND_ONLY even as superuser (invariant 1)');
select throws_like(
  $$delete from public.approved_work_segment$$,
  '%CAREOS_APPEND_ONLY%', 'segment -: DELETE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.payroll_period$$,
  '%CAREOS_APPEND_ONLY%', 'period -: DELETE is refused (no_delete, the 0036 posture)');
select lives_ok(
  $$update public.payroll_period set status = 'locked',
      locked_by = 'aaaaaaaa-0000-0000-0000-0000000000ad', locked_at = now()
    where id = 'aaaaaaaa-0000-0000-0000-000000009009'$$,
  'period +: status still moves in place — the table is no-delete, not append-only');

-- ═══ app.compute_visit_minutes — the arithmetic, as the payroll desk ════════
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');

select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'verified_minutes')::int,
  117, 'minutes +: 13:07 to 15:04 is 117 whole minutes, floored');
select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'scheduled_minutes')::int,
  120, 'minutes +: the scheduled window is 120 minutes');
select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'late_minutes')::int,
  7, 'minutes +: arriving at 13:07 on a 13:00 visit is 7 late minutes');
select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'overrun_minutes')::int,
  4, 'minutes +: leaving at 15:04 on a 15:00 visit is 4 overrun minutes');
select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'rounded_minutes')::int,
  120, 'minutes +: the bound policy rounds 117 to a quarter hour (D-014 binding)');
select is(
  app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'rounding_policy',
  'nearest_15', 'minutes +: the rounding rule applied is named in the return');
select ok(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e004')
     ->> 'verified_minutes') is null,
  'minutes +: a visit nobody clocked has null minutes, never 0');
select ok(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e004')
     ->> 'late_minutes') is null,
  'minutes +: a visit nobody arrived at is not "on time" (greatest() ignores nulls)');
select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e006')
     ->> 'verified_minutes')::int,
  -120, 'minutes +: an incoherent ledger reports negative, it is not clamped to zero');

-- Corrections: payroll reads the corrected fact; public.verified_visit reads the literal
-- ledger. The two DISAGREE on this visit, on purpose, and this is the pair that says so.
select is(
  (app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e007')
     ->> 'verified_minutes')::int,
  120, 'minutes +: a 0047 correction folds into payroll minutes (90 raw becomes 120)');
select is(
  (select vv.verified_minutes from public.verified_visit vv
    where vv.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e007'),
  90, 'minutes +: public.verified_visit still reports the literal ledger (0045 contract)');

select throws_like(
  $$select app.compute_visit_minutes('bbbbbbbb-0000-0000-0000-00000000e001')$$,
  '%CAREOS_NOT_FOUND%',
  'minutes -: tenant A''s desk cannot compute tenant B''s hours (tenant isolation)');

-- ═══ app.approve_visit_hours — the happy path and every refusal ═════════════
select is(
  (app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'approved_minutes')::int,
  120, 'approve +: the default approval is the rounded verified figure');
select is(
  (select s.rounding_applied from public.approved_work_segment s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and s.caregiver_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  'nearest_15', 'approve +: the segment records which rule produced the number');
select is(
  (select s.verified_minutes from public.approved_work_segment s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and s.caregiver_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  117, 'approve +: the unrounded fact is recorded alongside what a human approved');
select is(
  (select v.approval_status || '/' || v.payroll_status from public.visit v
    where v.id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'approved/ready', 'approve +: both projected axes move (D-024)');
select is(
  (app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'unchanged')::boolean,
  true, 'approve +: re-approving the same minutes is unchanged, never an error');
select is(
  (select count(*)::int from public.approved_work_segment s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and s.caregiver_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  1, 'approve +: an idempotent replay appends no second segment');
select is(
  (app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e001')
     ->> 'segment_id')::uuid,
  (select s.id from public.approved_work_segment s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and s.caregiver_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  'approve +: the replay points at the segment that already exists, not a new one');

select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e003')$$,
  '%CAREOS_BAD_STATE%',
  'approve -: a scheduled visit has delivered nothing to approve');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  '%CAREOS_APPROVAL_BLOCKED%',
  'approve -: an open critical exception blocks approval (§4.7)');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e004')$$,
  '%CAREOS_NO_HOURS%',
  'approve -: a visit with no clock pair is corrected, not approved');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e006')$$,
  '%CAREOS_INCOHERENT_LEDGER%',
  'approve -: a clock-out before its clock-in is not negative pay');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e005',
      p_pay_code => 'bonus')$$,
  '%CAREOS_BAD_PAY_CODE%', 'approve -: an unregistered pay code is refused');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e005', -30)$$,
  '%CAREOS_BAD_MINUTES%', 'approve -: negative approved minutes are refused');
select throws_like(
  $$select app.approve_visit_hours('bbbbbbbb-0000-0000-0000-00000000e001')$$,
  '%CAREOS_NOT_FOUND%',
  'approve -: tenant A''s desk cannot approve tenant B''s visit (tenant isolation)');

-- e001 also carries a critical finding — DISMISSED. If `open` were ignored, the happy
-- path above would have been blocked; it was not, which is the assertion.
select is(
  (select count(*)::int from public.visit_exception_state s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'
      and s.severity = 'critical' and not s.open),
  1, 'approve +: the dismissed critical finding on the approved visit is closed, not gone');

-- ═══ app.reject_visit_hours — a refusal to pay is a record too ══════════════
select is(
  (app.reject_visit_hours('aaaaaaaa-0000-0000-0000-00000000e004',
     'CANARY-REASON no clock-out was ever captured') ->> 'decision'),
  'rejected', 'reject +: a visit with a broken ledger CAN be rejected (it cannot be approved)');
select is(
  (select s.approved_minutes from public.approved_work_segment s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e004'),
  0, 'reject +: a rejection approves zero minutes');
select ok(
  (select s.approval_note like 'CANARY-REASON%' from public.approved_work_segment s
    where s.visit_id = 'aaaaaaaa-0000-0000-0000-00000000e004'),
  'reject +: the reason is durable in the segment, on an AAL2-gated PHI table');
select is(
  (select v.approval_status || '/' || v.payroll_status from public.visit v
    where v.id = 'aaaaaaaa-0000-0000-0000-00000000e004'),
  'rejected/not_ready', 'reject +: both projected axes move the other way');
select is(
  (select v.verification_status from public.visit v
    where v.id = 'aaaaaaaa-0000-0000-0000-00000000e004'),
  'pending',
  'reject +: the verification axis is untouched — four axes or not four axes (D-024)');
select is(
  (app.reject_visit_hours('aaaaaaaa-0000-0000-0000-00000000e004', 'again') ->> 'unchanged')::boolean,
  true, 'reject +: re-rejecting is unchanged, never an error');
select throws_like(
  $$select app.reject_visit_hours('aaaaaaaa-0000-0000-0000-00000000e006', '  ')$$,
  '%CAREOS_REASON_REQUIRED%', 'reject -: a blank reason is no reason');
select throws_like(
  $$select app.reject_visit_hours('aaaaaaaa-0000-0000-0000-00000000e003', 'nope')$$,
  '%CAREOS_BAD_STATE%', 'reject -: a scheduled visit has no hours to rule on');

-- ═══ Period lifecycle: open → (not ready) → locked → exported ═══════════════
select is(
  (app.open_payroll_period('2026-06-01', '2026-06-07') ->> 'status'),
  'open', 'period +: the desk opens the first week of June');
select is(
  (app.open_payroll_period('2026-06-01', '2026-06-07') ->> 'unchanged')::boolean,
  true, 'period +: re-opening the same window returns the existing period');
select throws_like(
  $$select app.open_payroll_period('2026-09-30', '2026-09-01')$$,
  '%CAREOS_BAD_WINDOW%', 'period -: an inverted window is refused by the RPC too');

select throws_like(
  $$select app.export_payroll_period(
      (select id from public.payroll_period
        where starts_on = '2026-06-01' and ends_on = '2026-06-07'))$$,
  '%CAREOS_BAD_STATE%', 'export -: an open period is closed before it is exported');

-- e005 and e007 are still pending inside the window: the close must refuse AND count.
select throws_like(
  $$select app.close_payroll_period(
      (select id from public.payroll_period
        where starts_on = '2026-06-01' and ends_on = '2026-06-07'))$$,
  '%CAREOS_PERIOD_NOT_READY: 2 completed%',
  'period -: the close names how many visits are still waiting (docs/10 voice)');

select is(
  (app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e005')
     ->> 'approved_minutes')::int,
  120, 'approve +: cg2''s two clean hours approve to 120');
-- An explicit override on a visit whose default happens to agree: the NUMBER is the same,
-- the PROVENANCE is not, and provenance is what a wage-and-hour review reads.
select is(
  (app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e007', 120)
     ->> 'rounding_applied'),
  'manual', 'approve +: a human-supplied figure records "manual", never a rounding rule');

select is(
  (app.close_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07')) ->> 'status'),
  'locked', 'period +: with nothing pending, the period closes');
select is(
  (select p.locked_by from public.payroll_period p
    where p.starts_on = '2026-06-01' and p.ends_on = '2026-06-07'),
  'aaaaaaaa-0000-0000-0000-0000000000ad'::uuid,
  'period +: the close is attributed to the human who ran it');
select is(
  (app.close_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07')) ->> 'unchanged')::boolean,
  true, 'period +: closing a closed period is unchanged, never an error');

-- ═══ The export: four columns, one hash, no client ══════════════════════════
select is(
  (app.export_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07')) ->> 'row_count')::int,
  3, 'export +: three payroll lines (cg1 twice, cg2 once)');
select is(
  (app.export_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07'))
     ->> 'total_minutes')::int,
  360, 'export +: 120 + 120 + 120 approved minutes');
select is(
  (app.export_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07')) ->> 'unchanged')::boolean,
  true, 'export +: re-exporting unchanged data returns the same artifact, not a new one');
select is(
  (select count(*)::int from public.payroll_export e
    where e.period_id = (select id from public.payroll_period
                          where starts_on = '2026-06-01' and ends_on = '2026-06-07')),
  1, 'export +: three calls, one export row — idempotency is a return value');
select ok(
  (select e.content_sha256 ~ '^[0-9a-f]{64}$' from public.payroll_export e limit 1),
  'export +: the content hash is a sha256 (provenance a surveyor can check)');
select is(
  (select p.status from public.payroll_period p
    where p.starts_on = '2026-06-01' and p.ends_on = '2026-06-07'),
  'exported', 'export +: the period reaches its terminal status');
select is(
  (select count(*)::int from public.visit v
    where v.id in ('aaaaaaaa-0000-0000-0000-00000000e001',
                   'aaaaaaaa-0000-0000-0000-00000000e005',
                   'aaaaaaaa-0000-0000-0000-00000000e007')
      and v.payroll_status = 'exported'),
  3, 'export +: axis 3 closes on every visit that was in the file (D-024)');

-- Invariant 5, at the artifact that leaves the building.
select ok(
  (app.export_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07'))
     -> 'rows')::text not like '%ClientA%',
  'export -: no client name appears in the export (a payroll file is not a disclosure)');
select ok(
  (app.export_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07'))
     -> 'rows')::text not like '%00000000c001%',
  'export -: no client id appears in the export either');
select ok(
  (app.export_payroll_period(
     (select id from public.payroll_period
       where starts_on = '2026-06-01' and ends_on = '2026-06-07'))
     -> 'rows')::text not like '%39.2904%',
  'export -: no coordinate reaches the payroll file (D-030)');
select is(
  (select count(*)::int
     from jsonb_array_elements(
       app.export_payroll_period(
         (select id from public.payroll_period
           where starts_on = '2026-06-01' and ends_on = '2026-06-07')) -> 'rows') r
    where (select count(*) from jsonb_object_keys(r.value)) <> 4),
  0, 'export +: every line carries exactly four fields and no fifth');

select throws_like(
  $$select app.close_payroll_period(
      (select id from public.payroll_period
        where starts_on = '2026-06-01' and ends_on = '2026-06-07'))$$,
  '%CAREOS_BAD_STATE%', 'period -: an exported period cannot be reclosed');

-- ═══ app.compute_overtime — a sum and a comparison, nothing else ════════════
select is(
  (app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c3', '2026-06-08')
     ->> 'total_minutes')::int,
  2520, 'overtime +: superseded and rejected segments are excluded from the week');
select is(
  (app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c3', '2026-06-08')
     ->> 'regular_minutes')::int,
  2400, 'overtime +: the first 40 hours are regular');
select is(
  (app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c3', '2026-06-08')
     ->> 'overtime_minutes')::int,
  120, 'overtime +: the remaining two hours are overtime');
select is(
  (app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c3', '2026-06-10')
     ->> 'week_start'),
  '2026-06-08', 'overtime +: a Wednesday resolves to its ISO Monday, not a rolling window');
select is(
  (app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c3', '2026-06-01')
     ->> 'overtime_minutes')::int,
  0, 'overtime +: the previous week has no overtime (clock injection, not wall clock)');
select throws_like(
  $$select app.compute_overtime('bbbbbbbb-0000-0000-0000-0000000000ad', '2026-06-08')$$,
  '%CAREOS_NOT_FOUND%',
  'overtime -: a tenant-B principal is not a caregiver tenant A can total');

-- ═══ Principal: the lead caregiver who HOLDS visit.approve ══════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');

select ok(has_function_privilege('authenticated',
  'app.approve_visit_hours(uuid,integer,text,text)', 'execute'),
  'self -: the probe is meaningful — this principal really can call the RPC');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e002')$$,
  '%CAREOS_SELF_APPROVAL%',
  'self -: a caregiver holding visit.approve still cannot approve their own hours (D-027)');
select throws_like(
  $$select app.reject_visit_hours('aaaaaaaa-0000-0000-0000-00000000e002', 'mine')$$,
  '%CAREOS_SELF_APPROVAL%',
  'self -: nor reject them — nobody rules on their own hours');
select lives_ok(
  $$select app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  'timesheet +: a caregiver may read the minutes on their own visit');
select is(
  (select count(*)::int from public.approved_work_segment s
    where s.caregiver_id = 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  3, 'segment +: their own timesheet reads back (e001, e007 approved; e004 rejected)');
select ok(
  (select count(*)::int from public.approved_work_segment s
    where s.caregiver_id <> 'aaaaaaaa-0000-0000-0000-0000000000c1') > 0,
  'segment +: visit.approve is an approver lane — it reads the tenant''s segments too');
select is(
  (select count(*)::int from public.payroll_period), 0,
  'period -: no payroll.read means no periods, even for a lead caregiver');
select is(
  (select count(*)::int from public.payroll_export), 0,
  'export -: and no export provenance either');
select throws_like(
  $$select app.open_payroll_period('2026-10-01', '2026-10-07')$$,
  '%CAREOS_FORBIDDEN%', 'period -: opening a period needs payroll.manage');

-- AAL1 downgrade on the same principal: PHI-linked reads and every write close.
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is(
  (select count(*)::int from public.approved_work_segment), 0,
  'segment -: AAL1 sees no segments (invariant 3)');
select throws_like(
  $$select app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_AAL2_REQUIRED%', 'minutes -: AAL1 cannot read hours');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e005')$$,
  '%CAREOS_AAL2_REQUIRED%', 'approve -: AAL1 cannot approve hours');

-- ═══ Principal: a caregiver with no payroll permission at all ═══════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select throws_like(
  $$select app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_FORBIDDEN%',
  'minutes -: a co-worker''s hours are not yours to read');
select throws_like(
  $$select app.approve_visit_hours('aaaaaaaa-0000-0000-0000-00000000e007')$$,
  '%CAREOS_FORBIDDEN%', 'approve -: approving needs visit.approve');
select throws_like(
  $$select app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c3', '2026-06-08')$$,
  '%CAREOS_FORBIDDEN%', 'overtime -: totalling somebody else''s week needs payroll.read');
select lives_ok(
  $$select app.compute_overtime('aaaaaaaa-0000-0000-0000-0000000000c2', '2026-06-01')$$,
  'overtime +: but everyone may total their own week');
-- The narrow read this policy is FOR: no permission of any kind, one visible row.
select is(
  (select count(*)::int from public.approved_work_segment), 1,
  'segment +: a caregiver with no payroll permission sees exactly one row');
select is(
  (select s.caregiver_id from public.approved_work_segment s),
  'aaaaaaaa-0000-0000-0000-0000000000c2'::uuid,
  'segment -: and it is their own — nobody else''s pay is visible');

-- ═══ Principal: the nurse on the care team — clinical access is not pay access ══
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000d1', 'aal2');
select is(
  (select count(*)::int from public.approved_work_segment), 0,
  'segment -: care-team membership does not disclose a caregiver''s pay');
select throws_like(
  $$select app.compute_visit_minutes('aaaaaaaa-0000-0000-0000-00000000e001')$$,
  '%CAREOS_FORBIDDEN%',
  'minutes -: a nurse on the case reads the care, not the wages');

-- ═══ Principal: tenant B's payroll admin — the tenancy perimeter ════════════
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.approved_work_segment), 0,
  'segment -: tenant-B admin sees nothing (tenant isolation)');
select is(
  (select count(*)::int from public.payroll_period), 0,
  'period -: tenant-B admin sees no tenant-A periods');
select is(
  (select count(*)::int from public.payroll_export), 0,
  'export -: tenant-B admin sees no tenant-A exports');
select throws_like(
  $$select app.close_payroll_period(
      (select id from public.payroll_period
        where starts_on = '2026-06-01' and ends_on = '2026-06-07'))$$,
  '%CAREOS_NOT_FOUND%',
  'period -: a tenant-A period id is not found from tenant B (ids are not authority)');

-- ═══ Canary: what the ledgers must NOT contain (invariant 5, D-030) ═════════
reset role;
select is(
  (select count(*)::int from audit.audit_event
    where payload::text like '%39.2904%'),
  0, 'canary -: no coordinate reaches any audit payload');
select is(
  (select count(*)::int from public.domain_event
    where payload::text like '%39.2904%'),
  0, 'canary -: no coordinate reaches any outbox payload');
select is(
  (select count(*)::int from pgmq.q_q_events q
    where q.message::text like '%39.2904%'),
  0, 'canary -: no coordinate reaches any queue message');
select is(
  (select count(*)::int from audit.audit_event
    where payload::text like '%CANARY-REASON%'),
  0, 'canary -: a rejection reason is free text about a person — never in an audit payload');
select is(
  (select count(*)::int from public.domain_event
    where payload::text like '%CANARY-REASON%'),
  0, 'canary -: nor in an outbox payload (consumers refetch under RLS)');
select is(
  (select count(*)::int from audit.audit_event
    where payload::text like '%ClientA%' and entity_type in
      ('approved_work_segment','payroll_period','payroll_export')),
  0, 'canary -: no client name reaches a payroll audit payload');

-- ═══ The ledgers DID record what happened (the other half of the canary) ════
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.hours_approved'),
  3, 'audit +: three approvals are on the chain (e001, e005, e007)');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'visit.hours_rejected'),
  1, 'audit +: the rejection is on the chain too');
select is(
  (select count(*)::int from public.domain_event
    where event_type in ('payroll.period.closed','payroll.exported')),
  2, 'outbox +: the close and the export each emitted exactly one event (invariant 7)');
select is(
  (select count(*)::int from public.domain_event
    where event_type = 'visit.hours.approved'),
  3, 'outbox +: one approval event per approval, none for the idempotent replays');

reset role;
select * from finish();
rollback;
