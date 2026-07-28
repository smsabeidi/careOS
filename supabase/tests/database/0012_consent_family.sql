-- pgTAP · consent + family access (0012): RLS enabled+forced per table, the family-access
-- gate (link + latest-consent-scope), AAL2 gating, append-only probes, no raw-visit leak to
-- family, the column-minimized family_calendar RPC, and consent revocation closing access.
-- Style mirrors 002_rls_matrix.sql / 003_append_only.sql / 0011_scheduling.sql.
-- @trace: docs/07 §11, docs/09, Wave 5
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only) ──────────────────────────────────────────────
insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-0000000000ad', 'fam.admin.a@meadowbrook.test'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'fam.kin.a@meadowbrook.test'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'fam.kin.other@meadowbrook.test');

insert into public.tenant (id, name) values
  ('cccccccc-0000-0000-0000-000000000001', 'Family Tenant A');

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-000000000001', 'Fam Admin A', 'fam.admin.a@meadowbrook.test', 'staff'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001', 'Grace Kin', 'fam.kin.a@meadowbrook.test', 'family'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000001', 'Unlinked Kin', 'fam.kin.other@meadowbrook.test', 'family');

insert into public.permission (key, description) values
  ('family.manage', 'test'), ('client.read.all', 'test')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name) values
  ('cccccccc-0000-0000-0000-00000000e0ad', 'cccccccc-0000-0000-0000-000000000001', 'fam_admin', 'Fam Admin'),
  ('cccccccc-0000-0000-0000-00000000e0c1', 'cccccccc-0000-0000-0000-000000000001', 'family', 'Family');
insert into public.role_permission (role_id, permission_key) values
  ('cccccccc-0000-0000-0000-00000000e0ad', 'family.manage'),
  ('cccccccc-0000-0000-0000-00000000e0ad', 'client.read.all');
insert into public.user_role (user_id, role_id) values
  ('cccccccc-0000-0000-0000-0000000000ad', 'cccccccc-0000-0000-0000-00000000e0ad'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-00000000e0c1'),
  ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-00000000e0c1');

insert into public.client (id, tenant_id, first_name, last_name) values
  ('cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-000000000001', 'Fam', 'ClientA');

-- Grace is actively linked; consent granted for updates+calendar+documents. Inserted as
-- postgres (no JWT) ⇒ audit trigger no-ops, no chain fork.
insert into public.family_link (id, tenant_id, client_id, family_user_id, relationship) values
  ('cccccccc-0000-0000-0000-00000000f001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-0000000000c1', 'daughter');
insert into public.consent (id, tenant_id, client_id, kind, scope, status, recorded_by) values
  ('cccccccc-0000-0000-0000-00000000a001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'family_portal',
   array['updates','calendar','documents'], 'granted', 'cccccccc-0000-0000-0000-0000000000ad');
insert into public.family_update (id, tenant_id, client_id, author_id, title, body) values
  ('cccccccc-0000-0000-0000-00000000b001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'cccccccc-0000-0000-0000-0000000000ad',
   'A good week', 'She is doing well.');
insert into public.shared_document (id, tenant_id, client_id, title, doc_kind, shared_by) values
  ('cccccccc-0000-0000-0000-00000000d001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', 'Plan of Care', 'care_plan', 'cccccccc-0000-0000-0000-0000000000ad');
insert into public.visit (id, tenant_id, client_id, scheduled_start, scheduled_end) values
  ('cccccccc-0000-0000-0000-00000000e001', 'cccccccc-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-00000000c001', now() + interval '2 hours', now() + interval '4 hours');

-- ── Invariant: RLS enabled AND forced on every new table ───────────────────
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('consent','family_link','family_update','shared_document')
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS enabled + forced on consent, family_link, family_update, shared_document');

-- Session simulator (identical to 002/003/0011).
create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

-- ── family_update: linked+consented family sees it; unlinked family does not ──
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.family_update), 1,
  'family_update +: linked family with updates-consent (AAL2) sees the shared update');

reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal1');
select is((select count(*)::int from public.family_update), 0,
  'family_update -: same family user at AAL1 sees nothing (invariant 3: AAL2 for PHI)');

reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.family_update), 0,
  'family_update -: an unlinked family user sees nothing');

-- ── family never gets raw visit access; the calendar RPC is the only path ──
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.visit), 0,
  'visit -: family has NO direct grant on the raw visit table (note may be PHI)');
select is((select count(*)::int from app.family_calendar('cccccccc-0000-0000-0000-00000000c001')), 1,
  'family_calendar +: linked+consented family sees the visit via the minimized RPC');

reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from app.family_calendar('cccccccc-0000-0000-0000-00000000c001')), 0,
  'family_calendar -: an unlinked family user gets nothing from the RPC');
select is((select count(*)::int from app.family_client('cccccccc-0000-0000-0000-00000000c001')), 0,
  'family_client -: an unlinked family user gets no client identity');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from app.family_client('cccccccc-0000-0000-0000-00000000c001')), 1,
  'family_client +: linked family sees their loved one via the minimized identity RPC');

-- ── family sees their OWN link ─────────────────────────────────────────────
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.family_link), 1,
  'family_link +: a family user sees their own link');
reset role;
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c2', 'aal2');
select is((select count(*)::int from public.family_link), 0,
  'family_link -: a family user does not see another users link');

-- ── append-only: consent / family_update / shared_document reject mutation ──
reset role;
select throws_like($$update public.consent set note = 'x'$$, '%CAREOS_APPEND_ONLY%',
  'consent UPDATE raises CAREOS_APPEND_ONLY (even as superuser)');
select throws_like($$delete from public.family_update$$, '%CAREOS_APPEND_ONLY%',
  'family_update DELETE raises CAREOS_APPEND_ONLY');
select throws_like($$update public.shared_document set title = 'x'$$, '%CAREOS_APPEND_ONLY%',
  'shared_document UPDATE raises CAREOS_APPEND_ONLY');
select ok(not has_table_privilege('authenticated', 'public.consent', 'update'),
  'authenticated has no UPDATE grant on consent (append-only)');
select ok(not has_table_privilege('authenticated', 'public.family_update', 'delete'),
  'authenticated has no DELETE grant on family_update (append-only)');

-- ── revoking consent closes access with NO edit (a newer revoked row wins) ──
insert into public.consent (tenant_id, client_id, kind, scope, status, recorded_by) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-00000000c001',
   'family_portal', array[]::text[], 'revoked', 'cccccccc-0000-0000-0000-0000000000ad');
select pg_temp.login('cccccccc-0000-0000-0000-0000000000c1', 'aal2');
select is((select count(*)::int from public.family_update), 0,
  'consent revocation: after a newer revoked consent row, family sees no updates (access closed, no edit)');
select is((select count(*)::int from app.family_calendar('cccccccc-0000-0000-0000-00000000c001')), 0,
  'consent revocation: the calendar RPC also returns nothing once consent is revoked');

-- ── RPC privilege posture (invariant 6: no anon) ───────────────────────────
reset role;
select ok(has_function_privilege('authenticated', 'app.family_calendar(uuid)', 'execute'),
  'authenticated can call app.family_calendar');
select ok(not has_function_privilege('anon', 'app.family_calendar(uuid)', 'execute'),
  'anon cannot call app.family_calendar');
select ok(not has_function_privilege('anon', 'app.on_family_link(uuid,text)', 'execute'),
  'anon cannot call app.on_family_link');

reset role;
select * from finish();
rollback;
