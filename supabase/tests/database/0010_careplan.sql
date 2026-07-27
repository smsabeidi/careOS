-- pgTAP · care planning + supervisory cadence: RLS enabled+forced, tenant × care-team
-- × AAL2 policy matrix, append-only enforcement, and audit emission.
-- Style mirrors 002_rls_matrix.sql / 003_append_only.sql.
-- @trace: docs/07 §10 (care planning), docs/07 §7 (45/90/120 supervisory cadence)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'rn.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'cg2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'admin.b@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nurse A', 'rn.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A2', 'cg2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B', 'admin.b@brookmead.test', 'staff');

insert into public.permission (key, description) values
  ('client.read.all', 'test'), ('form.write.all', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'rn', 'Registered Nurse'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0f1', 'client.read.all'),
  ('aaaaaaaa-0000-0000-0000-00000000e0f1', 'form.write.all'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'client.read.all');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000e0f1'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');

-- RN A is the case manager for client A1; caregiver A2 is assigned to no one.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000e1', 'rn_case_manager');

-- Session simulator (identical to 002/003/005)
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Schema invariant: RLS enabled + forced on every new table ──────────────
select ok((select relrowsecurity and relforcerowsecurity
             from pg_class where oid = 'public.care_plan'::regclass),
  'care_plan has RLS enabled + forced');
select ok((select relrowsecurity and relforcerowsecurity
             from pg_class where oid = 'public.care_plan_item'::regclass),
  'care_plan_item has RLS enabled + forced');
select ok((select relrowsecurity and relforcerowsecurity
             from pg_class where oid = 'public.supervisory_visit'::regclass),
  'supervisory_visit has RLS enabled + forced');

-- ── Positive path: assigned RN (form.write.all, on care team, AAL2) ────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000e1', 'aal2');

insert into public.care_plan (id, tenant_id, client_id, version, status, authored_by)
  values ('aaaaaaaa-0000-0000-0000-00000000c901',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000c001', 1, 'active',
          'aaaaaaaa-0000-0000-0000-0000000000e1');
select is((select count(*)::int from public.care_plan
             where id = 'aaaaaaaa-0000-0000-0000-00000000c901'), 1,
  'assigned RN authors + reads a care plan (Lane A insert under RLS with-check, AAL2)');

insert into public.care_plan_item (tenant_id, care_plan_id, kind, seq, text, target)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000c901', 'goal', 1,
          'Maintain safe mobility at home', 'No falls over the next 90 days');
select is((select count(*)::int from public.care_plan_item
             where care_plan_id = 'aaaaaaaa-0000-0000-0000-00000000c901'), 1,
  'RN adds + reads a care plan item under the parent plan scope');

insert into public.supervisory_visit (id, tenant_id, client_id, rn_id, kind, due_on)
  values ('aaaaaaaa-0000-0000-0000-00000000c951',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-00000000c001',
          'aaaaaaaa-0000-0000-0000-0000000000e1', '45_day', current_date + 10);
select is((select count(*)::int from public.supervisory_visit
             where id = 'aaaaaaaa-0000-0000-0000-00000000c951'), 1,
  'RN schedules + reads a supervisory visit');

update public.supervisory_visit
   set status = 'completed', completed_on = current_date,
       updated_at = now(), row_version = row_version + 1
 where id = 'aaaaaaaa-0000-0000-0000-00000000c951';
select is((select status from public.supervisory_visit
             where id = 'aaaaaaaa-0000-0000-0000-00000000c951'), 'completed',
  'RN completes a scheduled supervisory visit (mutable status transition)');

-- ── Audit: every consequential action emitted an event (read as postgres) ──
reset role;
select is((select count(*)::int from audit.audit_event
             where entity_type = 'care_plan' and action = 'care_plan.author'
               and entity_id = 'aaaaaaaa-0000-0000-0000-00000000c901'), 1,
  'authoring a care plan emitted exactly one audit event');
select is((select count(*)::int from audit.audit_event
             where entity_type = 'supervisory_visit'
               and action in ('supervisory_visit.schedule','supervisory_visit.complete')
               and entity_id = 'aaaaaaaa-0000-0000-0000-00000000c951'), 2,
  'scheduling and completing a supervisory visit each emitted an audit event');
select results_eq(
  $$select ok from audit.verify_chain('aaaaaaaa-0000-0000-0000-000000000001')$$,
  $$values (true)$$,
  'the audit chain still verifies after the care-planning writes');

-- ── Negative: unassigned caregiver (no perm, off care team, AAL2) ──────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select throws_ok(
  $$insert into public.care_plan (tenant_id, client_id, version, status, authored_by)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-00000000c001', 2, 'draft',
            'aaaaaaaa-0000-0000-0000-0000000000c2')$$,
  '42501', null,
  'caregiver without form.write.all and off the care team cannot author a care plan');
select is((select count(*)::int from public.care_plan), 0,
  'unassigned caregiver sees no care plans');
select is((select count(*)::int from public.care_plan_item), 0,
  'unassigned caregiver sees no care plan items');
select is((select count(*)::int from public.supervisory_visit), 0,
  'unassigned caregiver sees no supervisory visits');

-- ── Negative: AAL2 gate on PHI ─────────────────────────────────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000e1', 'aal1');
select is((select count(*)::int from public.care_plan), 0,
  'the assigned RN at AAL1 sees nothing (invariant 3: AAL2 for PHI)');
select is((select count(*)::int from public.supervisory_visit), 0,
  'the assigned RN at AAL1 sees no supervisory visits');

-- ── Negative: tenant isolation ─────────────────────────────────────────────
reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.care_plan), 0,
  'tenant-B admin sees no tenant-A care plans');
select is((select count(*)::int from public.supervisory_visit), 0,
  'tenant-B admin sees no tenant-A supervisory visits');

-- ── Append-only: trigger layer (even a superuser cannot mutate history) ────
reset role;
select throws_like(
  $$update public.care_plan set status = 'discontinued'
     where id = 'aaaaaaaa-0000-0000-0000-00000000c901'$$,
  '%CAREOS_APPEND_ONLY%', 'care_plan UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like(
  $$delete from public.care_plan where id = 'aaaaaaaa-0000-0000-0000-00000000c901'$$,
  '%CAREOS_APPEND_ONLY%', 'care_plan DELETE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$update public.care_plan_item set seq = 99$$,
  '%CAREOS_APPEND_ONLY%', 'care_plan_item UPDATE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.care_plan_item$$,
  '%CAREOS_APPEND_ONLY%', 'care_plan_item DELETE raises CAREOS_APPEND_ONLY');

-- supervisory_visit is mutable, but a completed visit can never be reopened and its
-- identity columns are frozen (invariant 1 — no overwrite of a consequential fact).
select throws_like(
  $$update public.supervisory_visit set completed_on = null, status = 'scheduled'
     where id = 'aaaaaaaa-0000-0000-0000-00000000c951'$$,
  '%CAREOS_APPEND_ONLY%', 'a completed supervisory visit cannot be reopened');
select throws_like(
  $$update public.supervisory_visit set kind = '90_day'
     where id = 'aaaaaaaa-0000-0000-0000-00000000c951'$$,
  '%CAREOS_IMMUTABLE_KEY%', 'the kind of a supervisory visit is immutable');

-- ── Append-only: privilege layer (authenticated has no mutation grants) ────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000e1', 'aal2');
select throws_ok(
  $$update public.care_plan set status = 'draft'
     where id = 'aaaaaaaa-0000-0000-0000-00000000c901'$$,
  '42501', null,
  'authenticated: care_plan UPDATE is permission-denied before any trigger fires');
select throws_ok(
  $$delete from public.care_plan where id = 'aaaaaaaa-0000-0000-0000-00000000c901'$$,
  '42501', null, 'authenticated: care_plan DELETE is permission-denied (append-only)');
select throws_ok(
  $$delete from public.care_plan_item$$,
  '42501', null, 'authenticated: care_plan_item DELETE is permission-denied (append-only)');
select throws_ok(
  $$delete from public.supervisory_visit
     where id = 'aaaaaaaa-0000-0000-0000-00000000c951'$$,
  '42501', null, 'authenticated: supervisory_visit DELETE is permission-denied');

reset role;
select * from finish();
rollback;
