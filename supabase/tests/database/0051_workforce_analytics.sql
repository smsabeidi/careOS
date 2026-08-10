-- pgTAP · 0051 workforce analytics: that the two supporting views are security_invoker so
-- rows compose through the caller's own RLS; that app.workforce_features and
-- app.evv_observability refuse an AAL1 session, a principal without workforce.read, an
-- incoherent window and a foreign caregiver; that a definer aggregate is pinned to the
-- caller's tenant and cannot see another agency; that every docs/17 §10 metric is exactly
-- the arithmetic this file's fixed fixture implies — including the 7-element Sunday..
-- Saturday lateness array and the bound-policy override of the tenant floor; and that no
-- coordinate and no raw accuracy radius reaches either view or either return value
-- (invariant 5, D-030). Style mirrors 0011_scheduling.sql / 0045_verified_visit.sql.
-- @trace: ST-209, D-024, D-028, D-030, docs/17 §10, §13
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Weekday buckets and work_date are session-time-zone derived (0051 header: there is no
-- tenant.time_zone column yet). Pinning UTC here makes every expected number below
-- arithmetic rather than "whatever the runner's TZ happened to be".
set local time zone 'UTC';

-- ── Fixtures (synthetic only — Meadowbrook conventions, three tenants) ─────
-- Tenant A carries the whole story. Tenant B proves isolation. Tenant C has no visit
-- policy at all, which is the only way to reach CAREOS_POLICY_MISSING honestly.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'wf.admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'wf.cg1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'wf.cg2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'wf.admin.b@brookmead.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'wf.cg1.b@brookmead.test'),
  ('cccccccc-0000-0000-0000-0000000000ad', 'wf.admin.c@thirdtenant.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'WF Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'WF Tenant B'),
  ('cccccccc-0000-0000-0000-000000000001', 'WF Tenant C');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'WF Admin A', 'wf.admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001',
   'WF Caregiver A1', 'wf.cg1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001',
   'WF Caregiver A2', 'wf.cg2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'WF Admin B', 'wf.admin.b@brookmead.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001',
   'WF Caregiver B1', 'wf.cg1.b@brookmead.test', 'staff'),
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-000000000001',
   'WF Admin C', 'wf.admin.c@thirdtenant.test', 'staff');

-- The key 0051 inserts; restated here so the test is self-sufficient against a fixture
-- ordering change (the 0011 test precedent).
insert into public.permission (key, description) values
  ('workforce.read', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001',
   'wf_admin', 'WF Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001',
   'wf_admin', 'WF Admin'),
  ('cccccccc-0000-0000-0000-00000000e0ad', 'cccccccc-0000-0000-0000-000000000001',
   'wf_admin', 'WF Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'workforce.read'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'workforce.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'schedule.read'),
  ('cccccccc-0000-0000-0000-00000000e0ad', 'workforce.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad'),
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-00000000e0ad');
-- Caregivers A1/A2 hold NO role at all — they are the "authenticated but not entitled"
-- principal class every gate below has to refuse.

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'WF', 'ClientA1'),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'WF', 'ClientA2'),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'WF', 'ClientB1');

insert into public.service_type (id, tenant_id, code, name, evv_required, payer_kind)
values
  ('aaaaaaaa-0000-0000-0000-000000005201', 'aaaaaaaa-0000-0000-0000-000000000001',
   'PCA', 'Personal Care Aide', true, 'medicaid');

-- Visit policy. Tenant A's floor keeps 0044's default 7-minute late threshold and carries
-- a deliberately small overtime ceiling (180 min) so a five-visit fixture can actually
-- cross it. The client-scope row raises the threshold to 45 for client A1 and is bound to
-- ONE visit, which is how this file proves the per-visit bound policy beats the floor.
insert into public.visit_policy
  (id, tenant_id, scope_kind, scope_id, version_no, overtime_weekly_minutes, created_by)
values
  ('aaaaaaaa-0000-0000-0000-000000007001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'tenant', null, 1, 180, 'aaaaaaaa-0000-0000-0000-0000000000ad'),
  ('bbbbbbbb-0000-0000-0000-000000007001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'tenant', null, 1, 180, 'bbbbbbbb-0000-0000-0000-0000000000ad');
insert into public.visit_policy
  (id, tenant_id, scope_kind, scope_id, version_no, late_threshold_minutes,
   overtime_weekly_minutes, created_by)
values
  ('aaaaaaaa-0000-0000-0000-000000007002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'client', 'aaaaaaaa-0000-0000-0000-00000000c001', 1, 45, 180,
   'aaaaaaaa-0000-0000-0000-0000000000ad');

-- Six tenant-A visits with FIXED windows in March 2026, so every number below is
-- arithmetic. Inserted as postgres (no JWT) ⇒ the audit and outbox triggers no-op.
--   e001 Mon 03-02 09:00–11:00  c1/clientA1  in 09:20 out 11:00   late 20, verified
--   e002 Mon 03-09 09:00–11:00  c1/clientA1  in 09:30 out 11:15   late 30 BUT the bound
--                                                                 client policy allows 45
--   e003 Tue 03-03 13:00–15:00  c1/clientA1  in 12:50 out 15:00   arrived early
--   e004 Wed 03-04 17:00–19:00  c1/clientA2  never clocked        missed
--   e005 Thu 03-05 09:00–11:00  c1/clientA1  in 09:00, no out     missing clock-out
--   e006 Fri 03-06 09:00–10:00  c2/clientA2  in 09:00 out 10:00   the clean second worker
insert into public.visit
  (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status,
   service_type_id, policy_id, verification_status, evv_status) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-02 09:00:00+00', '2026-03-02 11:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005201', null, 'verified', 'accepted'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-09 09:00:00+00', '2026-03-09 11:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005201',
   'aaaaaaaa-0000-0000-0000-000000007002', 'exception', 'rejected'),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-03 13:00:00+00', '2026-03-03 15:00:00+00', 'completed',
   'aaaaaaaa-0000-0000-0000-000000005201', null, 'verified', 'reconciled'),
  ('aaaaaaaa-0000-0000-0000-00000000e004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-04 17:00:00+00', '2026-03-04 19:00:00+00', 'missed',
   'aaaaaaaa-0000-0000-0000-000000005201', null, 'pending', 'not_required'),
  ('aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   '2026-03-05 09:00:00+00', '2026-03-05 11:00:00+00', 'in_progress',
   null, null, 'pending', 'submitted'),
  ('aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   '2026-03-06 09:00:00+00', '2026-03-06 10:00:00+00', 'completed',
   null, null, 'verified', 'not_required');
-- Tenant B's single visit — the isolation control.
insert into public.visit
  (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status,
   verification_status) values
  ('bbbbbbbb-0000-0000-0000-00000000e001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-0000000000c1',
   '2026-03-02 09:00:00+00', '2026-03-02 11:00:00+00', 'completed', 'verified');

-- The clock ledger. Coordinates are REAL here on purpose: the canary assertions further
-- down are only meaningful if there is a coordinate available to leak. Accuracy radii are
-- chosen to land one event in each §13 bucket, including two with no radius at all.
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
   latitude, longitude, accuracy_m, method, location_status, capture_source) values
  -- e001: the arrival, the departure, and a manually entered duplicate arrival that must
  -- NOT displace the real one (0045's earliest-clock_in rule) but MUST count as an
  -- override.
  ('aaaaaaaa-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-03-02 09:20:00+00', 39.2904, -76.6122,   12, 'web',
   'verified', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-03-02 11:00:00+00', 39.2904, -76.6122,   30, 'web',
   'verified', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e001', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-03-02 09:22:00+00', 39.2904, -76.6122,   75, 'manual',
   'verified', 'manual'),
  -- e002: a low-accuracy arrival, its departure, and a correction event.
  ('aaaaaaaa-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-03-09 09:30:00+00', 39.2904, -76.6122,  150, 'web',
   'low_accuracy', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a005', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-03-09 11:15:00+00', 39.2904, -76.6122,  150, 'web',
   'verified', 'web'),
  -- e003: an early arrival outside the fence, and a departure with no radius at all.
  ('aaaaaaaa-0000-0000-0000-00000000a007', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-03-03 12:50:00+00', 39.2904, -76.6122,  500, 'web',
   'outside_geofence', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a008', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e003', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_out', '2026-03-03 15:00:00+00', 39.2904, -76.6122, null, 'web', null, 'web'),
  -- e005: one refused attempt, then an arrival, and no departure ever.
  ('aaaaaaaa-0000-0000-0000-00000000a009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in_rejected', '2026-03-05 08:58:00+00', 39.2904, -76.6122, 2000, 'web',
   'outside_geofence', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a010', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e005', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'clock_in',  '2026-03-05 09:00:00+00', 39.2904, -76.6122, 2000, 'web',
   'unavailable', 'web'),
  -- e006: caregiver A2's single, entirely uneventful visit.
  ('aaaaaaaa-0000-0000-0000-00000000a011', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_in',  '2026-03-06 09:00:00+00', 39.2904, -76.6122,   12, 'web',
   'verified', 'web'),
  ('aaaaaaaa-0000-0000-0000-00000000a012', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e006', 'aaaaaaaa-0000-0000-0000-0000000000c2',
   'clock_out', '2026-03-06 10:00:00+00', 39.2904, -76.6122,   12, 'web',
   'verified', 'web');
-- e002's correction, in its own statement so corrects_event_id points at what it corrects
-- from the moment it exists. visit_event is append-only at both layers (0013), so a
-- back-fill by UPDATE would be impossible anyway — a correction is born pointing or it
-- never points at all.
insert into public.visit_event
  (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at, method,
   capture_source, corrects_event_id) values
  ('aaaaaaaa-0000-0000-0000-00000000a006', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-00000000e002', 'aaaaaaaa-0000-0000-0000-0000000000c1',
   'correction', '2026-03-09 09:28:00+00', 'manual', 'web',
   'aaaaaaaa-0000-0000-0000-00000000a004');

-- Six exceptions, one per §10 counter family, so each counter is proved independently.
insert into public.visit_exception
  (tenant_id, visit_id, caregiver_id, kind, severity, dedupe_key) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'outside_geofence', 'warning', 'wf-1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e002',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'low_accuracy', 'info', 'wf-2'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e005',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'missing_clock_out', 'critical', 'wf-3'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e002',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'impossible_travel', 'critical', 'wf-4'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'documentation_missing', 'warning', 'wf-5'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e003',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'overlapping_visits', 'warning', 'wf-6');

-- Trust snapshots. e002 gets TWO, so the histogram proves it takes the latest and not the
-- first (0048 appends a new row per re-score).
insert into public.visit_trust_assessment
  (tenant_id, visit_id, score, band, components, reasons, model_version, computed_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e001',
   95, 'verified', '{"location":35}'::jsonb, '[]'::jsonb, 'trust.v1',
   '2026-03-02 12:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e002',
   92, 'verified', '{"location":35}'::jsonb, '[]'::jsonb, 'trust.v1',
   '2026-03-09 12:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e002',
   60, 'requires_review', '{"location":10}'::jsonb, '[]'::jsonb, 'trust.v1',
   '2026-03-09 18:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000e003',
   80, 'verified_with_exception', '{"location":25}'::jsonb, '[]'::jsonb, 'trust.v1',
   '2026-03-03 16:00:00+00');

-- Session simulator (identical to 002/003/0011/0045).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ═══ Posture: the views are invoker-scoped, the functions are client-callable ═══════
-- security_invoker is the entire security model of these views. Without it each one runs
-- as its owner, who bypasses RLS, and hands every authenticated caller every tenant's
-- schedule and clock ledger.
select ok(
  (select 'security_invoker=true' = any (coalesce(reloptions, '{}'))
     from pg_class where oid = 'public.workforce_visit_fact'::regclass),
  'workforce_visit_fact +: the view is security_invoker — base-table RLS applies');
select ok(
  (select 'security_invoker=true' = any (coalesce(reloptions, '{}'))
     from pg_class where oid = 'public.evv_capture_fact'::regclass),
  'evv_capture_fact +: the view is security_invoker — base-table RLS applies');

select ok(has_table_privilege('authenticated', 'public.workforce_visit_fact', 'select'),
  'posture: authenticated can select public.workforce_visit_fact');
select ok(has_table_privilege('authenticated', 'public.evv_capture_fact', 'select'),
  'posture: authenticated can select public.evv_capture_fact');
select ok(not has_table_privilege('authenticated', 'public.workforce_visit_fact', 'insert'),
  'posture: authenticated has no insert on public.workforce_visit_fact');
select ok(not has_table_privilege('authenticated', 'public.evv_capture_fact', 'insert'),
  'posture: authenticated has no insert on public.evv_capture_fact');
select ok(not has_table_privilege('anon', 'public.workforce_visit_fact', 'select'),
  'posture: anon cannot select public.workforce_visit_fact');
select ok(not has_table_privilege('anon', 'public.evv_capture_fact', 'select'),
  'posture: anon cannot select public.evv_capture_fact');

select ok(has_function_privilege('authenticated',
  'app.workforce_features(date,date,uuid)', 'execute'),
  'posture: authenticated can call app.workforce_features (it self-gates on permission)');
select ok(has_function_privilege('authenticated',
  'app.evv_observability(date,date)', 'execute'),
  'posture: authenticated can call app.evv_observability');
select ok(not has_function_privilege('anon',
  'app.workforce_features(date,date,uuid)', 'execute'),
  'posture: anon cannot call app.workforce_features');
select ok(not has_function_privilege('anon',
  'app.evv_observability(date,date)', 'execute'),
  'posture: anon cannot call app.evv_observability');
select ok(not has_function_privilege('service_role',
  'app.workforce_features(date,date,uuid)', 'execute'),
  'posture: service_role cannot call app.workforce_features (no request-path reach)');
select ok(not has_function_privilege('service_role',
  'app.evv_observability(date,date)', 'execute'),
  'posture: service_role cannot call app.evv_observability (no request-path reach)');

select is(
  (select count(*)::int from public.permission where key = 'workforce.read'),
  1, 'posture: the workforce.read key ships in the migration, not the seed');

-- Both functions pin search_path — 001_schema_invariants asserts this product-wide, and it
-- is restated here so a definer aggregate over PHI-derived rows carries its own proof.
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and p.proname in ('workforce_features','evv_observability')
      and (p.proconfig is null
           or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))),
  0, 'posture: both 0051 functions pin search_path');

-- ═══ The views under RLS — one positive and one negative per principal class ════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is(
  (select count(*)::int from public.workforce_visit_fact
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  1, 'workforce_visit_fact +: the assigned caregiver sees their own visit');
select is(
  (select count(*)::int from public.evv_capture_fact
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  3, 'evv_capture_fact +: the assigned caregiver sees their own three clock events');
select is(
  (select count(*)::int from public.workforce_visit_fact
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e006'),
  0, 'workforce_visit_fact -: a caregiver sees nothing of a co-worker''s visit');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is(
  (select count(*)::int from public.workforce_visit_fact),
  0, 'workforce_visit_fact -: an AAL1 session sees nothing (PHI ⇒ AAL2)');
select is(
  (select count(*)::int from public.evv_capture_fact),
  0, 'evv_capture_fact -: an AAL1 session sees nothing (PHI ⇒ AAL2)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is(
  (select count(*)::int from public.workforce_visit_fact),
  1, 'workforce_visit_fact +: an unrelated caregiver sees exactly their own one visit');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select count(*)::int from public.workforce_visit_fact
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'workforce_visit_fact -: tenant-B admin sees nothing of tenant A (tenant isolation)');
select is(
  (select count(*)::int from public.evv_capture_fact
    where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0, 'evv_capture_fact -: tenant-B admin sees nothing of tenant A (tenant isolation)');

-- ═══ app.workforce_features — the refusals ═════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.workforce_features('2026-03-01', '2026-03-31')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'features -: an AAL1 session is refused before anything is read');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.workforce_features('2026-03-01', '2026-03-31')$$,
  '%CAREOS_FORBIDDEN%',
  'features -: a caregiver without workforce.read is refused (the RLS stand-in)');
select throws_ok(
  $$select app.workforce_features('2026-03-01', '2026-03-31')$$,
  '42501', null,
  'features -: the permission refusal raises the authz errcode');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.workforce_features('2026-03-31', '2026-03-01')$$,
  '%CAREOS_BAD_WINDOW%',
  'features -: a window that ends before it starts is refused');
select throws_like(
  $$select app.workforce_features('2024-01-01', '2026-03-31')$$,
  '%CAREOS_BAD_WINDOW%',
  'features -: a window longer than 366 days is refused (cost bound)');
select throws_like(
  $$select app.workforce_features('2026-03-01', '2026-03-31',
      'bbbbbbbb-0000-0000-0000-0000000000c1')$$,
  '%CAREOS_NOT_FOUND%',
  'features -: a caregiver from another tenant is not found, not leaked');

-- A JWT whose subject has no app_user row at all: app.current_tenant_id() fails closed
-- (0022), and the function must say so rather than aggregate over an empty tenant.
reset role;
select pg_temp.login('dddddddd-0000-0000-0000-00000000dead', 'aal2');
select throws_like(
  $$select app.workforce_features('2026-03-01', '2026-03-31')$$,
  '%CAREOS_NO_TENANT_CONTEXT%',
  'features -: a principal with no active tenant context is refused');
select throws_like(
  $$select app.evv_observability('2026-03-01', '2026-03-31')$$,
  '%CAREOS_NO_TENANT_CONTEXT%',
  'observability -: a principal with no active tenant context is refused');

reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.workforce_features('2026-03-01', '2026-03-31')$$,
  '%CAREOS_POLICY_MISSING%',
  'features -: an agency with no policy floor gets the documented refusal, not a guess');

-- ═══ app.workforce_features — the arithmetic (docs/17 §10) ═════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');

select lives_ok(
  $$select app.workforce_features('2026-03-01', '2026-03-31')$$,
  'features +: an AAL2 admin holding workforce.read gets an answer (happy path)');
select is(
  (select jsonb_array_length(
     app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers')),
  2, 'features +: both tenant-A caregivers with visits in the window are returned');

-- The whole §10 contract in one assertion: exact key set, exact values. Every number is
-- derived in the fixture comment above; if any of them moves, this is the line that says
-- which metric drifted.
select is(
  app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers' -> 0,
  jsonb_build_object(
    'caregiver_id',                'aaaaaaaa-0000-0000-0000-0000000000c1',
    'visits_scheduled',            5,
    'visits_completed',            3,
    'visits_missed',               1,
    'late_count',                  1,
    'avg_late_minutes',            20.0,
    'early_count',                 1,
    'overrun_minutes',             15,
    'undertime_minutes',           35,
    'verified_rate',               0.6667,
    'location_exception_count',    2,
    'manual_override_count',       2,
    'missing_clock_out_count',     1,
    'overlap_count',               1,
    'impossible_travel_count',     1,
    'documentation_missing_count', 1,
    'schedule_adherence_pct',      40.0,
    'overtime_minutes',            50,
    'client_continuity_pct',       80.0,
    'trust_band_histogram',
      jsonb_build_object('verified', 1, 'verified_with_exception', 1,
                         'requires_review', 1, 'high_risk', 0),
    'day_of_week_lateness',
      jsonb_build_array(null, 25.0, 0.0, null, 0.0, null, null)),
  'features +: caregiver A1''s twenty §10 metrics are exactly the fixture''s arithmetic');

select is(
  (select array_agg(k order by k)
     from jsonb_object_keys(
       app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers' -> 0) k),
  array['avg_late_minutes','caregiver_id','client_continuity_pct','day_of_week_lateness',
        'documentation_missing_count','early_count','impossible_travel_count',
        'late_count','location_exception_count','manual_override_count',
        'missing_clock_out_count','overlap_count','overrun_minutes','overtime_minutes',
        'schedule_adherence_pct','trust_band_histogram','undertime_minutes',
        'verified_rate','visits_completed','visits_missed','visits_scheduled'],
  'features +: the object carries the §10 metric set and nothing else — no name, no note');

-- The bound-policy override, isolated. e002 ran 30 minutes late against a tenant floor of
-- 7, and is NOT counted late, because the client-scope policy bound to it allows 45.
-- Without the bound policy late_count would be 2, so this single number is the whole
-- D-014 binding argument.
select is(
  (select late_threshold_minutes from public.workforce_visit_fact
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e002'),
  45, 'features +: the visit''s BOUND policy threshold is what the fact row carries');
select is(
  (select late_threshold_minutes from public.workforce_visit_fact
    where visit_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  null::int,
  'features +: an unbound visit carries no threshold and falls back to the floor');

-- day_of_week_lateness is threshold-INDEPENDENT: it reports raw lateness per weekday, which
-- is exactly what makes "his Monday mornings are the problem" a deterministic finding.
-- Monday (index 1) averages e001''s 20 and e002''s 30 even though e002 is not "late".
select is(
  app.workforce_features('2026-03-01', '2026-03-31')
    -> 'caregivers' -> 0 -> 'day_of_week_lateness' ->> 1,
  '25.0', 'features +: Monday''s average lateness is raw minutes, not a policy verdict');
select ok(
  (app.workforce_features('2026-03-01', '2026-03-31')
    -> 'caregivers' -> 0 -> 'day_of_week_lateness' -> 0) = 'null'::jsonb,
  'features +: a weekday with no clocked visit is null, never a flattering zero');
select is(
  jsonb_array_length(app.workforce_features('2026-03-01', '2026-03-31')
    -> 'caregivers' -> 0 -> 'day_of_week_lateness'),
  7, 'features +: the lateness array is always seven elements, Sunday..Saturday');

-- The second caregiver: the clean case, and the proof that grouping is per caregiver.
select is(
  app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers' -> 1
    -> 'schedule_adherence_pct',
  to_jsonb(100.0::numeric),
  'features +: caregiver A2''s single on-time visit is 100% adherence');
select is(
  app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers' -> 1
    -> 'client_continuity_pct',
  to_jsonb(0.0::numeric),
  'features +: a caregiver who saw a client once has zero continuity');

-- p_caregiver narrows, and does not change the metrics it returns.
select is(
  (select jsonb_array_length(app.workforce_features('2026-03-01', '2026-03-31',
     'aaaaaaaa-0000-0000-0000-0000000000c1') -> 'caregivers')),
  1, 'features +: p_caregiver narrows the result to one object');
select is(
  app.workforce_features('2026-03-01', '2026-03-31',
    'aaaaaaaa-0000-0000-0000-0000000000c1') -> 'caregivers' -> 0,
  app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers' -> 0,
  'features +: narrowing changes the population, never the arithmetic');

-- The window is a real filter: March alone excludes nothing, a single day excludes almost
-- everything.
select is(
  app.workforce_features('2026-03-02', '2026-03-02') -> 'caregivers' -> 0
    ->> 'visits_scheduled',
  '1', 'features +: a one-day window returns only that day''s visit');

-- Tenant isolation on the DEFINER path — the one that would be a cross-tenant read if the
-- hand-stated tenant pin were ever dropped.
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is(
  (select jsonb_array_length(
     app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers')),
  1, 'features +: tenant-B admin sees exactly one caregiver — their own');
select is(
  app.workforce_features('2026-03-01', '2026-03-31') -> 'caregivers' -> 0
    ->> 'caregiver_id',
  'bbbbbbbb-0000-0000-0000-0000000000c1',
  'features -: tenant-B admin never sees a tenant-A caregiver (tenant isolation)');
select is(
  app.workforce_features('2026-03-01', '2026-03-31') ->> 'org_id',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'features +: org_id is always the caller''s own tenant, never a parameter');

-- ═══ app.evv_observability — the refusals ══════════════════════════════════════════
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal1');
select throws_like(
  $$select app.evv_observability('2026-03-01', '2026-03-31')$$,
  '%CAREOS_AAL2_REQUIRED%',
  'observability -: an AAL1 session is refused');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select throws_like(
  $$select app.evv_observability('2026-03-01', '2026-03-31')$$,
  '%CAREOS_FORBIDDEN%',
  'observability -: a caregiver without workforce.read is refused');
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select throws_like(
  $$select app.evv_observability('2026-03-31', '2026-03-01')$$,
  '%CAREOS_BAD_WINDOW%',
  'observability -: a window that ends before it starts is refused');
select throws_like(
  $$select app.evv_observability('2024-01-01', '2026-03-31')$$,
  '%CAREOS_BAD_WINDOW%',
  'observability -: a window longer than 366 days is refused (cost bound)');

-- ═══ app.evv_observability — the numbers (docs/17 §13) ═════════════════════════════
select lives_ok(
  $$select app.evv_observability('2026-03-01', '2026-03-31')$$,
  'observability +: an AAL2 admin holding workforce.read gets an answer (happy path)');
select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'clock_in',
  jsonb_build_object('attempts', 7, 'succeeded', 6, 'rejected', 1,
                     'success_rate', 0.8571),
  'observability +: clock-in success is six of seven attempts, refusals included');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'location_status',
  jsonb_build_object('verified', 6, 'low_accuracy', 1, 'outside_geofence', 2,
                     'unavailable', 1, 'suspicious', 0, 'not_required', 0,
                     'unrecorded', 2),
  'observability +: the location-verdict distribution covers every event, including nulls');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'accuracy_histogram_m',
  jsonb_build_object('0-25', 3, '25-50', 1, '50-100', 1, '100-250', 2,
                     '250-1000', 1, '1000+', 2, 'unknown', 2),
  'observability +: accuracy is reported in the six §13 buckets plus unknown');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'missing_clock_out',
  jsonb_build_object('clocked_in', 5, 'missing', 1, 'rate', 0.2000),
  'observability +: one of five clocked visits never clocked out');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'evv',
  jsonb_build_object('accepted', 2, 'rejected', 1, 'open', 1,
                     'acceptance_rate', 0.6667),
  'observability +: acceptance counts reconciled as accepted (D-026 reconcile mode)');

select is(
  app.evv_observability('2026-03-01', '2026-03-31')
    -> 'exception_rate_by_kind' -> 'missing_clock_out',
  jsonb_build_object('count', 1, 'rate_per_visit', 0.1667),
  'observability +: exception rate is per visit in the window, not per event');

select is(
  (select count(*)::int from jsonb_object_keys(
     app.evv_observability('2026-03-01', '2026-03-31') -> 'exception_rate_by_kind') k),
  6, 'observability +: every exception kind present in the window gets a bucket');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'by_service_type' -> 0,
  jsonb_build_object(
    'service_type_id', 'aaaaaaaa-0000-0000-0000-000000005201',
    'code', 'PCA', 'visits', 4,
    'clock_in_success_rate', 1.0000, 'missing_clock_out_rate', 0.0000),
  'observability +: the service-type breakdown reports the PCA lane');
select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'by_service_type' -> 1
    ->> 'code',
  'unassigned',
  'observability +: a visit with no service type is its own bucket, never dropped');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'sweep' ->> 'job_key',
  'visit_sweep', 'observability +: the 0047 sweep heartbeat is reported');
select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'sweep' -> 'stale',
  'true'::jsonb,
  'observability +: a sweep that has never run is stale, not unknown (0039 H1)');

select is(
  app.evv_observability('2026-03-01', '2026-03-31') ->> 'visits',
  '6', 'observability +: the visit denominator excludes nothing but cancellations');

-- ═══ D-030: no geography dimension, no browser dimension, and both are SAID ════════
select is(
  app.evv_observability('2026-03-01', '2026-03-31') -> 'dimensions_omitted',
  jsonb_build_array('browser_family', 'geography'),
  'observability +: the two impossible dimensions are named, not silently absent');
select is(
  (select count(*)::int from jsonb_object_keys(
     app.evv_observability('2026-03-01', '2026-03-31')) k
    where k ~* '(geo|location_bucket|lat|lng|region|zip|postal)'),
  0, 'observability -: there is no geographic breakdown of caregiver location (D-030)');

-- ═══ Canary: no coordinate and no raw accuracy radius escapes (invariant 5, D-030) ══
select ok(
  pg_get_viewdef('public.workforce_visit_fact'::regclass) !~* '(latitude|longitude)',
  'canary -: workforce_visit_fact''s definition names no coordinate column');
select ok(
  pg_get_viewdef('public.evv_capture_fact'::regclass) !~* '(latitude|longitude)',
  'canary -: evv_capture_fact''s definition names no coordinate column');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'evv_capture_fact'
      and column_name in ('latitude','longitude','accuracy_m','distance_m')),
  0, 'canary -: evv_capture_fact exposes the bucket, never the radius or the point');
select ok(
  app.workforce_features('2026-03-01', '2026-03-31')::text
    not like '%39.2904%'
  and app.workforce_features('2026-03-01', '2026-03-31')::text
    not like '%76.6122%',
  'canary -: the workforce feature set carries no fixture coordinate');
select ok(
  app.evv_observability('2026-03-01', '2026-03-31')::text
    not like '%39.2904%'
  and app.evv_observability('2026-03-01', '2026-03-31')::text
    not like '%76.6122%',
  'canary -: the observability payload carries no fixture coordinate');
select ok(
  app.workforce_features('2026-03-01', '2026-03-31')::text !~* '(full_name|note|address)',
  'canary -: the workforce feature set carries ids and numbers, never a name or note');

-- Both functions are STABLE, which is what structurally prevents an analytics read from
-- writing an audit row, an outbox event or anything else (the 0025 read_audit_trail
-- posture: the calling surface owns the access audit, the function owns the refusal).
reset role;
select is(
  (select array_agg(p.provolatile::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and p.proname in ('evv_observability','workforce_features')),
  array['s','s'],
  'posture: both functions are STABLE — an analytics read cannot write anything');

reset role;
select * from finish();
rollback;
