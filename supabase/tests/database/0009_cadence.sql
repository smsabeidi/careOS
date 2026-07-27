-- pgTAP · cadence engine: RLS enabled+forced on the new tables, tenant/care-team/
-- AAL scoping on obligations, definer-only writes, and the deterministic evaluator
-- (materialize → transition → satisfy) proven end-to-end on synthetic fixtures.
-- Style mirrors 002_rls_matrix.sql (session simulator, matrix probes) and
-- 003_append_only.sql (privilege-layer denial). Runs seedless.
-- @trace: E10/S5, docs/07 §7
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only) ──────────────────────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'cad.admin@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cad.cg1@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'cad.cg2@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'cad.cg3@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'cad.admin@brookmead.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Tenant B');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A',     'cad.admin@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cad.cg1@meadowbrook.test',   'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A2', 'cad.cg2@meadowbrook.test',   'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A3', 'cad.cg3@meadowbrook.test',   'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'Admin B',      'cad.admin@brookmead.test',   'staff');

insert into public.permission (key, description) values
  ('compliance.read', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'bbbbbbbb-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'compliance.read'),
  ('bbbbbbbb-0000-0000-0000-00000000e0ad', 'compliance.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad'),
  ('bbbbbbbb-0000-0000-0000-0000000000ad', 'bbbbbbbb-0000-0000-0000-00000000e0ad');

-- clientA1 is deep overdue (admitted 400d ago, annual rule); clientA2 is fresh.
insert into public.client (id, tenant_id, status, first_name, last_name, admitted_on) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'active', 'Client', 'A-One', current_date - 400),
  ('aaaaaaaa-0000-0000-0000-00000000c002', 'aaaaaaaa-0000-0000-0000-000000000001', 'active', 'Client', 'A-Two', current_date - 10),
  ('bbbbbbbb-0000-0000-0000-00000000c001', 'bbbbbbbb-0000-0000-0000-000000000001', 'active', 'Client', 'B-One', current_date - 400);

-- Caregiver A1 is on Client A1's care team; A2 and A3 are unassigned.
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000c001',
   'aaaaaaaa-0000-0000-0000-0000000000c1', 'caregiver');

-- Template whose final instance satisfies the annual assessment rule.
insert into public.form_template (id, tenant_id, key, title, schema) values
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'rn_assessment', 'RN Assessment', '{}');

-- Rules: annual client assessment (A + B), plus one staff rule (A).
insert into public.cadence_rule
  (id, tenant_id, key, name, applies_to, trigger_kind, interval_days, satisfied_by_template_key, comar_source_ref) values
  ('aaaaaaaa-0000-0000-0000-0000000ca001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'assessment.annual', 'Annual RN assessment', 'client', 'interval_days', 365, 'rn_assessment', 'COMAR 10.07.05.__'),
  ('bbbbbbbb-0000-0000-0000-0000000ca001', 'bbbbbbbb-0000-0000-0000-000000000001',
   'assessment.annual', 'Annual RN assessment', 'client', 'interval_days', 365, 'rn_assessment', 'COMAR 10.07.05.__');
insert into public.cadence_rule
  (id, tenant_id, key, name, applies_to, trigger_kind, interval_days, comar_source_ref) values
  ('aaaaaaaa-0000-0000-0000-0000000ca002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'credential.rn_license', 'RN license renewal', 'staff', 'credential_expiry', null, 'COMAR 10.07.05.__');

-- A staff obligation (evaluator does not yet generate these) — for the self-scope probe.
insert into public.obligation (id, tenant_id, cadence_rule_id, staff_id, due_on, status) values
  ('aaaaaaaa-0000-0000-0000-00000000b003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-0000000ca002', 'aaaaaaaa-0000-0000-0000-0000000000c3', current_date + 30, 'open');

-- ── RLS is enabled AND forced on both new tables ───────────────────────────
select is((select relrowsecurity from pg_class where oid = 'public.cadence_rule'::regclass), true,
  'cadence_rule: RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.cadence_rule'::regclass), true,
  'cadence_rule: RLS forced');
select is((select relrowsecurity from pg_class where oid = 'public.obligation'::regclass), true,
  'obligation: RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.obligation'::regclass), true,
  'obligation: RLS forced');

-- ── Deterministic evaluator: materialize + transition ──────────────────────
select app.evaluate_compliance();

select is((select count(*)::int from public.obligation
            where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and client_id is not null), 2,
  'evaluator materialized one obligation per active tenant-A client (A1, A2)');
select is((select status from public.obligation
            where cadence_rule_id = 'aaaaaaaa-0000-0000-0000-0000000ca001'
              and client_id = 'aaaaaaaa-0000-0000-0000-00000000c001'), 'overdue',
  'client admitted 400d ago under an annual rule is transitioned to overdue');
select is((select status from public.obligation
            where cadence_rule_id = 'aaaaaaaa-0000-0000-0000-0000000ca001'
              and client_id = 'aaaaaaaa-0000-0000-0000-00000000c002'), 'open',
  'freshly-admitted client is open (due next year)');

-- Session simulator (identical to 002_rls_matrix.sql)
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── cadence_rule: tenant-scoped read (positive + negative) ──────────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.cadence_rule), 2,
  'admin A sees exactly tenant-A cadence rules (client + staff) and none of tenant B');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.cadence_rule), 1,
  'admin B sees only tenant-B cadence rules (tenant isolation)');

-- ── obligation: perm / care-team / AAL / tenant scoping ─────────────────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.obligation where client_id is not null), 2,
  'compliance.read admin (AAL2) sees both tenant-A client obligations');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.obligation), 0,
  'unassigned caregiver with no compliance.read and no obligations sees nothing');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.obligation), 1,
  'care-team caregiver (AAL2) sees exactly their client''s obligation');
select is((select client_id from public.obligation), 'aaaaaaaa-0000-0000-0000-00000000c001'::uuid,
  'and it is the assigned client''s obligation');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.obligation), 0,
  'same caregiver at AAL1 sees nothing (invariant 3: AAL2 for PHI)');

reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c3', 'aal2');
select is((select count(*)::int from public.obligation), 1,
  'staff subject sees their own staff obligation and nothing else');
select is((select staff_id from public.obligation), 'aaaaaaaa-0000-0000-0000-0000000000c3'::uuid,
  'and it is their own obligation');

reset role;
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000000ad', 'aal2');
select is((select count(*)::int from public.obligation), 1,
  'tenant-B admin sees only tenant-B obligations');
select is((select bool_and(tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') from public.obligation), true,
  'and every visible obligation is tenant B (no cross-tenant leak)');

-- ── Read view carries the derived status under the caller''s RLS ───────────
reset role;
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000c1', 'aal2');
select is((select computed_status from public.cadence_obligation_status
            where client_id = 'aaaaaaaa-0000-0000-0000-00000000c001'), 'overdue',
  'cadence_obligation_status view exposes computed_status to the care-team caregiver');

-- ── Writes are definer-only: authenticated has no INSERT/UPDATE grant ───────
select throws_ok(
  $$update public.obligation set status = 'satisfied'$$,
  '42501', null, 'authenticated: obligation UPDATE is permission-denied (evaluator/RPC only)');
select throws_ok(
  $$insert into public.obligation (tenant_id, cadence_rule_id, client_id, due_on)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000ca001',
            'aaaaaaaa-0000-0000-0000-00000000c001', current_date)$$,
  '42501', null, 'authenticated: direct obligation INSERT is permission-denied');
select throws_ok(
  $$insert into public.cadence_rule (tenant_id, key, name, applies_to)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'x', 'X', 'client')$$,
  '42501', null, 'authenticated: direct cadence_rule INSERT is permission-denied (admin RPC only)');

-- ── Satisfaction: a final matching form satisfies + regenerates next cycle ──
reset role;
insert into public.form_instance (id, tenant_id, template_id, client_id, status, created_by, updated_at)
values ('aaaaaaaa-0000-0000-0000-00000000f101', 'aaaaaaaa-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-00000000f001', 'aaaaaaaa-0000-0000-0000-00000000c001',
        'final', 'aaaaaaaa-0000-0000-0000-0000000000ad', now());

select app.evaluate_compliance();

select is((select count(*)::int from public.obligation
            where client_id = 'aaaaaaaa-0000-0000-0000-00000000c001' and status = 'satisfied'
              and satisfied_by_entity = 'form_instance'
              and satisfied_by_id = 'aaaaaaaa-0000-0000-0000-00000000f101'), 1,
  'a final matching form satisfies the overdue obligation and records the evidence ref');
select is((select count(*)::int from public.obligation
            where client_id = 'aaaaaaaa-0000-0000-0000-00000000c001'
              and status in ('open','at_risk','overdue')), 1,
  'and the next cycle is re-materialized (exactly one live obligation remains)');

reset role;
select * from finish();
rollback;
