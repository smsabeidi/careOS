-- pgTAP · Outbox: domain_event + pgmq land in the same transaction as the domain write
-- (invariant 7), trigger-driven for scheduling, zero client grants, append-only.
-- @trace: ST-130
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — Meadowbrook conventions) ────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'cg1.a@meadowbrook.test');

insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Caregiver A1', 'cg1.a@meadowbrook.test', 'staff');

insert into public.permission (key, description) values
  ('schedule.write', 'test'), ('schedule.read', 'test')
on conflict (key) do nothing;
insert into public.role (id, tenant_id, key, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin', 'Admin');
insert into public.role_permission (role_id, permission_key) values
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.write'),
  ('aaaaaaaa-0000-0000-0000-00000000e0ad', 'schedule.read');
insert into public.user_role (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-00000000e0ad');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('aaaaaaaa-0000-0000-0000-00000000c001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Client', 'One');

-- Session simulator
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── Posture: zero client grants, emitters locked down ──────────────────────
select ok(not has_table_privilege('authenticated', 'public.domain_event', 'select'),
  'outbox: authenticated has no SELECT on domain_event');
select ok(not has_table_privilege('authenticated', 'public.domain_event', 'insert'),
  'outbox: authenticated has no INSERT on domain_event');
select ok(not has_function_privilege('authenticated',
  'app.emit_event(text,text,uuid,jsonb)', 'execute'),
  'outbox: authenticated cannot call app.emit_event directly');
select ok(not has_function_privilege('authenticated',
  'app.emit_event_internal(uuid,uuid,text,text,uuid,jsonb)', 'execute'),
  'outbox: authenticated cannot call the internal emitter');
select ok(has_function_privilege('service_role',
  'app.emit_event_system(uuid,text,text,uuid,jsonb)', 'execute'),
  'outbox: service_role can call app.emit_event_system');
select ok(not has_function_privilege('authenticated',
  'app.emit_event_system(uuid,text,text,uuid,jsonb)', 'execute'),
  'outbox: authenticated cannot call app.emit_event_system');

-- ── No tenant context ⇒ no event ───────────────────────────────────────────
select throws_like(
  $$select app.emit_event('probe.event', 'probe', null)$$,
  '%CAREOS_NO_TENANT_CONTEXT%',
  'outbox: emitting without an active principal is refused');

-- ── Trigger-driven scheduling events, same-transaction queue delivery ──────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000000ad', 'aal2');
select lives_ok(
  $$select app.schedule_visit('aaaaaaaa-0000-0000-0000-00000000c001',
      now() + interval '1 day', now() + interval '1 day 2 hours',
      p_note => 'outbox-probe')$$,
  'outbox: admin opens a visit');
select lives_ok(
  $$select app.assign_visit(
      (select id from public.visit where note = 'outbox-probe'),
      'aaaaaaaa-0000-0000-0000-0000000000c1')$$,
  'outbox: admin assigns the caregiver (no required credentials — schedulable)');
select lives_ok(
  $$select app.record_callout(
      (select id from public.visit where note = 'outbox-probe'), 'sick call')$$,
  'outbox: the caregiver calls out');

reset role;   -- postgres reads the outbox + queue directly
select is(
  (select count(*)::int from public.domain_event
    where entity_id = (select id from public.visit where note = 'outbox-probe')),
  3, 'outbox: opened + assigned + vacated = three domain events for the visit');
select is(
  (select array_agg(event_type order by created_at)
     from public.domain_event
    where entity_id = (select id from public.visit where note = 'outbox-probe')),
  array['visit.opened','visit.assigned','visit.vacated'],
  'outbox: the event types tell the visit''s story in order');
select is(
  (select count(*)::int from pgmq.q_q_events q
    where (q.message ->> 'event_id')::uuid in
      (select id from public.domain_event
        where entity_id = (select id from public.visit where note = 'outbox-probe'))),
  3, 'outbox: every domain event has its pgmq message in the same transaction');
select is(
  (select created_by from public.domain_event
    where entity_id = (select id from public.visit where note = 'outbox-probe')
    order by created_at limit 1),
  'aaaaaaaa-0000-0000-0000-0000000000ad'::uuid,
  'outbox: events carry the acting principal');

-- ── Append-only, even for the superuser ────────────────────────────────────
select throws_like(
  $$update public.domain_event set event_type = 'tampered'$$,
  '%CAREOS_APPEND_ONLY%', 'outbox: domain_event UPDATE raises CAREOS_APPEND_ONLY');
select throws_like(
  $$delete from public.domain_event$$,
  '%CAREOS_APPEND_ONLY%', 'outbox: domain_event DELETE raises CAREOS_APPEND_ONLY');

reset role;
select * from finish();
rollback;
