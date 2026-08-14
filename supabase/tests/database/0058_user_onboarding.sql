-- pgTAP · onboarding_milestone (0058): the first-run progress ledger is tenant-pinned,
-- append-only, RPC-only on BOTH sides (no client grants at all), self-scoped by
-- construction, AAL2-gated with a refusal rather than a silent empty, idempotent on a
-- repeat tap, closed against an invented milestone, and audited on every fresh record.
-- Also pins the two grants the /welcome surface compiles against: the milestone RPCs are
-- callable by authenticated, and app.feature_enabled (0026) still is — the flag read is
-- what keeps the surface dark, so a silent revoke would fail the wrong way.
-- Style mirrors 0054_alert_ack.sql (pg_temp.login idiom).
-- @trace: W-ONB, docs/14 §6, docs/10 §8, invariant 1, invariant 5, invariant 7
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — two tenants, two users in A) ─────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000b501', 'onb.u1.a@meadowbrook.test'),
  ('aaaaaaaa-0000-0000-0000-00000000b502', 'onb.u2.a@meadowbrook.test'),
  ('bbbbbbbb-0000-0000-0000-00000000b501', 'onb.u1.b@brookmead.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000000b5', 'Onb Tenant A'),
  ('bbbbbbbb-0000-0000-0000-0000000000b5', 'Onb Tenant B');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-00000000b501', 'aaaaaaaa-0000-0000-0000-0000000000b5',
   'Onb User A1', 'onb.u1.a@meadowbrook.test', 'staff'),
  ('aaaaaaaa-0000-0000-0000-00000000b502', 'aaaaaaaa-0000-0000-0000-0000000000b5',
   'Onb User A2', 'onb.u2.a@meadowbrook.test', 'staff'),
  ('bbbbbbbb-0000-0000-0000-00000000b501', 'bbbbbbbb-0000-0000-0000-0000000000b5',
   'Onb User B1', 'onb.u1.b@brookmead.test', 'staff');

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

-- ── 1 · Schema invariants: RLS on and forced, and no table grants at all ────
select ok((select relrowsecurity from pg_class
            where oid = 'public.onboarding_milestone'::regclass),
  'onboarding_milestone: RLS enabled');
select ok((select relforcerowsecurity from pg_class
            where oid = 'public.onboarding_milestone'::regclass),
  'onboarding_milestone: RLS forced');
select ok(not has_table_privilege('authenticated', 'public.onboarding_milestone', 'select'),
  'onboarding_milestone: no SELECT grant — app.my_onboarding_milestones is the only reader');
select ok(not has_table_privilege('authenticated', 'public.onboarding_milestone', 'insert'),
  'onboarding_milestone: no INSERT grant — app.record_onboarding_milestone is the only writer');
select ok(not has_table_privilege('authenticated', 'public.onboarding_milestone', 'update'),
  'onboarding_milestone: no UPDATE grant');
select ok(not has_table_privilege('authenticated', 'public.onboarding_milestone', 'delete'),
  'onboarding_milestone: no DELETE grant');
select ok(not has_table_privilege('anon', 'public.onboarding_milestone', 'select'),
  'onboarding_milestone: anon has nothing');

-- The grants the /welcome surface compiles against.
select ok(has_function_privilege('authenticated',
            'app.record_onboarding_milestone(text)', 'execute'),
  'authenticated can call app.record_onboarding_milestone');
select ok(has_function_privilege('authenticated',
            'app.my_onboarding_milestones()', 'execute'),
  'authenticated can call app.my_onboarding_milestones');
select ok(not has_function_privilege('anon',
            'app.record_onboarding_milestone(text)', 'execute'),
  'anon cannot call app.record_onboarding_milestone');
-- 0026 granted this; the dark-by-default flag read depends on it (blueprint item 2).
select ok(has_function_privilege('authenticated', 'app.feature_enabled(text,boolean)', 'execute'),
  'authenticated can call app.feature_enabled (0026 grant intact)');
-- Seeding is not a client action.
select ok(not has_function_privilege('authenticated', 'app.seed_onboarding_flags(uuid)', 'execute'),
  'authenticated cannot call app.seed_onboarding_flags');

-- ── 2 · Append-only: owner-level UPDATE and DELETE both raise ───────────────
insert into public.onboarding_milestone (tenant_id, user_id, milestone) values
  ('aaaaaaaa-0000-0000-0000-0000000000b5', 'aaaaaaaa-0000-0000-0000-00000000b501',
   'step_first_look');
select throws_like(
  $$update public.onboarding_milestone set milestone = 'welcome_completed'
     where user_id = 'aaaaaaaa-0000-0000-0000-00000000b501'$$,
  '%CAREOS_APPEND_ONLY%', 'onboarding_milestone: UPDATE raises (append-only)');
select throws_like(
  $$delete from public.onboarding_milestone
     where user_id = 'aaaaaaaa-0000-0000-0000-00000000b501'$$,
  '%CAREOS_APPEND_ONLY%', 'onboarding_milestone: DELETE raises (append-only)');
-- The allowlist is a structural floor, not just an RPC courtesy.
select throws_ok(
  $$insert into public.onboarding_milestone (tenant_id, user_id, milestone) values
      ('aaaaaaaa-0000-0000-0000-0000000000b5', 'aaaaaaaa-0000-0000-0000-00000000b501',
       'step_invented')$$,
  '23514', null, 'onboarding_milestone: CHECK refuses a milestone outside the allowlist');

-- ── 3 · record_onboarding_milestone: self-only, idempotent, closed allowlist ─
select pg_temp.login('aaaaaaaa-0000-0000-0000-00000000b502', 'aal2');
select is((app.record_onboarding_milestone('step_language') ->> 'unchanged')::boolean, false,
  'record: a fresh milestone writes');
select is((app.record_onboarding_milestone('step_language') ->> 'unchanged')::boolean, true,
  'record: a repeat tap is a return value, not an error and not a second row');
select is((app.record_onboarding_milestone('welcome_completed') ->> 'unchanged')::boolean, false,
  'record: a second distinct milestone is its own row');
select throws_like(
  $$select app.record_onboarding_milestone('step_take_the_tour')$$,
  'CAREOS_BAD_MILESTONE%',
  'record -: an invented milestone is refused loudly');
select throws_like(
  $$select app.record_onboarding_milestone(null)$$,
  'CAREOS_BAD_MILESTONE%',
  'record -: a null milestone is refused loudly');
select pg_temp.logout();

-- The double tap left one row, not two (asserted outside the session: the table carries
-- no client SELECT grant, so only the definer path — or this superuser probe — sees it).
select is((select count(*) from public.onboarding_milestone
            where user_id = 'aaaaaaaa-0000-0000-0000-00000000b502'
              and milestone = 'step_language')::int, 1,
  'record: exactly one row after the double tap');

-- Audit landed once per FRESH record — the replay added none (invariant 7).
select is((select count(*) from audit.audit_event
            where action = 'onboarding.milestone'
              and tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000b5')::int, 2,
  'record: one fresh milestone = one audit event (idempotent replay adds none)');
select is((select count(*) from audit.audit_event
            where action = 'onboarding.milestone'
              and payload ->> 'milestone' = 'welcome_completed')::int, 1,
  'record: the audit payload names the milestone (IDs and enums only — no PHI)');

-- ── 4 · Read scope: your own progress via the RPC, nobody else's ────────────
select pg_temp.login('aaaaaaaa-0000-0000-0000-00000000b502', 'aal2');
select results_eq(
  $$select app.my_onboarding_milestones()$$,
  $$values ('step_language'::text), ('welcome_completed'::text)$$,
  'read +: the RPC returns the caller''s own milestones');
select pg_temp.logout();

-- Colleague A1 has a milestone of their own (the fixture row) and sees ONLY that one:
-- A2's two rows are invisible even though both users share tenant A.
select pg_temp.login('aaaaaaaa-0000-0000-0000-00000000b501', 'aal2');
select results_eq(
  $$select app.my_onboarding_milestones()$$,
  $$values ('step_first_look'::text)$$,
  'read -: a colleague in the same tenant sees none of another user''s milestones');
select pg_temp.logout();

-- Tenant B sees nothing of tenant A.
select pg_temp.login('bbbbbbbb-0000-0000-0000-00000000b501', 'aal2');
select is((select count(*) from app.my_onboarding_milestones())::int, 0,
  'read -: tenant B sees none of tenant A''s milestones');
-- And the table itself is unreachable directly, whoever asks.
select throws_ok(
  $$select 1 from public.onboarding_milestone$$,
  '42501', null, 'read -: a direct SELECT on the table is refused (no grant)');
select throws_ok(
  $$insert into public.onboarding_milestone (tenant_id, user_id, milestone) values
      ('bbbbbbbb-0000-0000-0000-0000000000b5', 'bbbbbbbb-0000-0000-0000-00000000b501',
       'welcome_skipped')$$,
  '42501', null, 'write -: a direct INSERT is refused (no grant)');
select throws_ok(
  $$update public.onboarding_milestone set milestone = 'welcome_skipped'$$,
  '42501', null, 'write -: a direct UPDATE is refused (no grant)');
select throws_ok(
  $$delete from public.onboarding_milestone$$,
  '42501', null, 'write -: a direct DELETE is refused (no grant)');
select pg_temp.logout();

-- ── 5 · AAL1 is refused, not silently emptied (docs/10 §8 probe rule) ───────
select pg_temp.login('aaaaaaaa-0000-0000-0000-00000000b502', 'aal1');
select throws_like(
  $$select app.my_onboarding_milestones()$$,
  'CAREOS_AAL2_REQUIRED%',
  'read -: an AAL1 session is refused — an empty list would be a lie about progress');
select throws_like(
  $$select app.record_onboarding_milestone('welcome_skipped')$$,
  'CAREOS_AAL2_REQUIRED%',
  'record -: an AAL1 session cannot record progress');
select pg_temp.logout();
select is((select count(*) from public.onboarding_milestone
            where user_id = 'aaaaaaaa-0000-0000-0000-00000000b502')::int, 2,
  'AAL1: the refused write left no row behind');

-- ── 6 · The flag ships dark, with a stated reason ───────────────────────────
select is(app.seed_onboarding_flags('aaaaaaaa-0000-0000-0000-0000000000b5'), 1,
  'seed_onboarding_flags: seeds one flag for a fresh tenant');
select is(app.seed_onboarding_flags('aaaaaaaa-0000-0000-0000-0000000000b5'), 0,
  'seed_onboarding_flags: a re-run is a no-op (idempotent, never re-enables)');
select is(
  (select enabled from public.feature_flag
    where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000b5' and key = 'onboarding.welcome'),
  false, 'onboarding.welcome: the flag row exists and is DISABLED');
select ok(
  (select btrim(coalesce(disabled_reason, '')) <> '' from public.feature_flag
    where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000b5' and key = 'onboarding.welcome'),
  'onboarding.welcome: the dark row states why it is dark');
-- The read side the surface actually uses, from inside a session.
select pg_temp.login('aaaaaaaa-0000-0000-0000-00000000b502', 'aal2');
select is(app.feature_enabled('onboarding.welcome', true), false,
  'feature_enabled: the welcome surface reads OFF even against a default of true');
select pg_temp.logout();

select * from finish();
rollback;
