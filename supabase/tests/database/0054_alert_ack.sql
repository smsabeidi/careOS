-- pgTAP · alert_ack (0054) + ai_capability.config (0055): the attention queue's
-- acknowledgement ledger is tenant-pinned, append-only, self-read-only and RPC-written;
-- app.ack_alert is self-only by construction, idempotent as a return value, refuses an
-- unknown lane, and every fresh ack lands exactly one audit event; and the 0055 config
-- column accepts an object, refuses a secret-bearing key, and refuses a non-object.
-- Style mirrors 0052_visit_ai_capabilities.sql (pg_temp.login idiom).
-- @trace: ST-238, ST-233, docs/designs/intelligent-front-door.md W5/W2
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — two tenants, two users in A) ─────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000a4c01', 'ack.u1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-0000000a4c02', 'ack.u2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-0000000a4c01', 'ack.u1.b@brookmead.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000a4ca', 'Ack Tenant A'),
  ('bbbbbbbb-0000-0000-0000-00000000a4cb', 'Ack Tenant B');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000a4c01', 'aaaaaaaa-0000-0000-0000-00000000a4ca',
   'Ack User A1', 'ack.u1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-0000000a4c02', 'aaaaaaaa-0000-0000-0000-00000000a4ca',
   'Ack User A2', 'ack.u2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-0000000a4c01', 'bbbbbbbb-0000-0000-0000-00000000a4cb',
   'Ack User B1', 'ack.u1.b@brookmead.test', 'staff');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;
create function pg_temp.logout() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ── 1 · Schema invariants ───────────────────────────────────────────────────
select ok((select relrowsecurity from pg_class where oid = 'public.alert_ack'::regclass),
  'alert_ack: RLS enabled');
select ok((select relforcerowsecurity from pg_class where oid = 'public.alert_ack'::regclass),
  'alert_ack: RLS forced');
select ok(not has_table_privilege('authenticated', 'public.alert_ack', 'insert'),
  'alert_ack: no INSERT grant — app.ack_alert is the only writer');
select ok(not has_table_privilege('authenticated', 'public.alert_ack', 'update'),
  'alert_ack: no UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.alert_ack', 'delete'),
  'alert_ack: no DELETE grant');

-- ── 2 · Append-only: owner-level UPDATE and DELETE both raise ───────────────
insert into public.alert_ack (tenant_id, user_id, source, source_id) values
  ('aaaaaaaa-0000-0000-0000-00000000a4ca', 'aaaaaaaa-0000-0000-0000-0000000a4c01',
   'notification', 'aaaaaaaa-0000-0000-0000-00000000f001');
select throws_ok(
  $$update public.alert_ack set source = 'offer'
     where user_id = 'aaaaaaaa-0000-0000-0000-0000000a4c01'$$,
  'P0001', null, 'alert_ack: UPDATE raises (append-only)');
select throws_ok(
  $$delete from public.alert_ack
     where user_id = 'aaaaaaaa-0000-0000-0000-0000000a4c01'$$,
  'P0001', null, 'alert_ack: DELETE raises (append-only)');

-- ── 3 · app.ack_alert — self-only writes, idempotent, closed lane enum ──────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000a4c02', 'aal2');
select is((app.ack_alert('credential', 'aaaaaaaa-0000-0000-0000-00000000f002')
             ->> 'unchanged')::boolean, false,
  'ack_alert: a fresh ack writes');
select is((app.ack_alert('credential', 'aaaaaaaa-0000-0000-0000-00000000f002')
             ->> 'unchanged')::boolean, true,
  'ack_alert: a second tap is a return value, not an error and not a second row');
select is((select count(*) from public.alert_ack
            where user_id = 'aaaaaaaa-0000-0000-0000-0000000a4c02'
              and source = 'credential')::int, 1,
  'ack_alert: exactly one row after the double tap');
select throws_like(
  $$select app.ack_alert('surprise_lane', 'aaaaaaaa-0000-0000-0000-00000000f003')$$,
  'CAREOS_BAD_SOURCE%',
  'ack_alert: an unknown lane is refused loudly');
select pg_temp.logout();

-- The audit event landed, exactly once, under the acker's tenant.
select is((select count(*) from audit.audit_event
            where action = 'alert.acknowledged'
              and tenant_id = 'aaaaaaaa-0000-0000-0000-00000000a4ca')::int, 1,
  'ack_alert: one fresh ack = one audit event (idempotent replay adds none)');

-- ── 4 · Read scope: your own acks only; tenant B sees nothing of A ──────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-0000000a4c02', 'aal2');
select is((select count(*) from public.alert_ack)::int, 1,
  'read: a user sees exactly their own acks, not their colleague''s');
select pg_temp.logout();
select pg_temp.login('bbbbbbbb-0000-0000-0000-0000000a4c01', 'aal2');
select is((select count(*) from public.alert_ack)::int, 0,
  'read: tenant B sees none of tenant A''s acks');
select pg_temp.logout();

-- ── 5 · 0055 · ai_capability.config — object or null, never a credential ────
insert into public.ai_capability (tenant_id, key, name, tier, requires_human, model, config)
values ('aaaaaaaa-0000-0000-0000-00000000a4ca', 'ack.test_cap', 'Config test', 'T1', false,
        'gpt-5.6-luna', '{"actions":{"app.schedule_visit":{"params":{}}}}'::jsonb);
select is((select config -> 'actions' is not null from public.ai_capability
            where key = 'ack.test_cap'
              and tenant_id = 'aaaaaaaa-0000-0000-0000-00000000a4ca'), true,
  'config: an action-allowlist object is storable');
select throws_ok(
  $$update public.ai_capability set config = '{"api_key":"x"}'::jsonb
     where key = 'ack.test_cap'$$,
  '23514', null, 'config: a secret-bearing key is refused by CHECK');
select throws_ok(
  $$update public.ai_capability set config = '"just a string"'::jsonb
     where key = 'ack.test_cap'$$,
  '23514', null, 'config: a non-object is refused by CHECK');

select * from finish();
rollback;
