-- pgTAP · 0013 — legal authority is a global, append-only catalog that cannot be
-- published without a named human (D-015)
--
-- The assertion that matters most here is negative: NO path exists by which a row
-- reaches 'verified' or 'published' without verified_by + verified_at + source_sha256.
-- verified_by is an FK to public.app_user, so an AI capability — which has no row there
-- and cannot acquire one — can never satisfy it. That is the research brief's
-- "no form is required because an AI found it online" rule, enforced in Postgres.
-- @trace: ST-112, D-015
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── It is a GLOBAL catalog, on the public.permission pattern ───────────────
select hasnt_column('public', 'legal_authority', 'tenant_id',
  'legal_authority has NO tenant_id — public law is not tenant data');

select is(
  (select relrowsecurity from pg_class where oid = 'public.legal_authority'::regclass),
  true, 'RLS is enabled on legal_authority even though it is global');
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.legal_authority'::regclass),
  true, 'RLS is FORCED on legal_authority (invariant 2 holds for global tables too)');

-- Read-only to clients: the perimeter for a global catalog is "no write grants".
select is_empty(
  $$ select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'legal_authority'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT','UPDATE','DELETE') $$,
  'authenticated holds NO write grants on legal_authority');
select isnt_empty(
  $$ select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'legal_authority'
        and grantee = 'authenticated' and privilege_type = 'SELECT' $$,
  'authenticated may read the authority catalog');

select isnt_empty(
  $$ select 1 from pg_trigger
      where tgname = 'trg_legal_authority_ao'
        and tgrelid = 'public.legal_authority'::regclass $$,
  'legal_authority is append-only');

-- ── The load-bearing CHECK ─────────────────────────────────────────────────
select isnt_empty(
  $$ select 1 from pg_constraint
      where conname = 'authority_published_requires_human' and contype = 'c' $$,
  'authority_published_requires_human exists');

-- Publishing with no human verifier must be impossible, not merely discouraged.
select throws_ok(
  $$ insert into public.legal_authority
       (authority_level, jurisdiction, issuing_body, citation, title, review_status)
     values (4, 'US-MD', 'MDH', 'COMAR 10.07.05.99', 'Fabricated', 'published') $$,
  '23514',
  NULL,
  'a PUBLISHED authority with no verifier and no checksum is rejected');

select throws_ok(
  $$ insert into public.legal_authority
       (authority_level, jurisdiction, issuing_body, citation, title, review_status,
        source_sha256, verified_at)
     values (4, 'US-MD', 'MDH', 'COMAR 10.07.05.98', 'Fabricated', 'verified',
             extensions.digest(convert_to('x','utf8'),'sha256'), now()) $$,
  '23514',
  NULL,
  'a VERIFIED authority with a checksum but no named human verifier is rejected');

-- The permissive case: unverified rows ARE allowed, because that is how honestly
-- unreviewed research is represented rather than laundered into apparent authority.
select lives_ok(
  $$ insert into public.legal_authority
       (authority_level, jurisdiction, issuing_body, citation, title, review_status)
     values (4, 'US-MD', 'MDH', 'COMAR 10.07.05.97', 'Unreviewed probe', 'unverified') $$,
  'an UNVERIFIED authority may be recorded with no verifier — that is the honest state');

-- ── Append-only bites ──────────────────────────────────────────────────────
select throws_ok(
  $$ update public.legal_authority set citation = 'tampered'
      where citation = 'COMAR 10.07.05.97' $$,
  'P0001', NULL,
  'UPDATE on legal_authority is refused — corrections supersede, never overwrite');

-- ── Effective window coherence ─────────────────────────────────────────────
select throws_ok(
  $$ insert into public.legal_authority
       (authority_level, jurisdiction, issuing_body, citation, title,
        effective_from, effective_to)
     values (4, 'US-MD', 'MDH', 'COMAR 10.07.05.96', 'Backwards window',
             '2026-01-01', '2025-01-01') $$,
  '23514', NULL,
  'an authority whose effective_to precedes effective_from is rejected');

-- ── The publish RPC is permission-gated and definer-only ───────────────────
select has_function('app', 'publish_authority',
  ARRAY['uuid','text','bytea','text'], 'app.publish_authority exists');
select is_empty(
  $$ select 1 from information_schema.role_routine_grants
      where routine_schema = 'app' and routine_name = 'publish_authority'
        and grantee in ('anon','public') $$,
  'app.publish_authority is not callable by anon/public');

-- ── The seeded Maryland authorities are honestly labelled ──────────────────
-- Every citation in 0014 was researched from primary text but reviewed by NO licensed
-- human, and docs/02 is absent from the repo. They must therefore all be 'unverified'.
-- If this test ever fails because a row says 'published', a human must have attested it
-- through app.publish_authority — which is exactly the intended way for it to change.
select is_empty(
  $$ select citation from public.legal_authority
      where jurisdiction = 'US-MD'
        and review_status in ('verified','published')
        and verified_by is null $$,
  'no Maryland authority claims verified/published status without a verifier');

-- ── The rule tables can now point at real authority ────────────────────────
select has_column('public', 'cadence_rule', 'legal_authority_id',
  'cadence_rule can cite a structured authority');
select has_column('public', 'credential_type', 'legal_authority_id',
  'credential_type can cite a structured authority');

-- The UI must branch on authority_is_verified before rendering a shield icon.
select has_view('public', 'cadence_rule_authority',
  'cadence_rule_authority view exists');
select is(
  (select 'security_invoker=true' = any(reloptions)
     from pg_class where oid = 'public.cadence_rule_authority'::regclass),
  true,
  'cadence_rule_authority is security_invoker — retrieval runs as the user (invariant 9)');

select finish();
rollback;
