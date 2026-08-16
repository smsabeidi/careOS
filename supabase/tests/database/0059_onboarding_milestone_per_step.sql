-- pgTAP · onboarding_milestone (0059): the allowlist widens to one milestone per checklist
-- step, expand-only. 0058's matrix (RLS, zero grants, append-only, self-scope, AAL1
-- refusal, audit) still governs and is not repeated here. This file proves only what 0059
-- changed: every one of the thirteen step keys is recordable, both welcome terminators
-- still are, the list is still CLOSED with a CAREOS_* refusal, idempotency survived, and
-- the CHECK and the RPC guard agree — a guard wider than its CHECK would turn a clean
-- refusal into a raw 23514 on a caregiver's screen, and a CHECK wider than its guard would
-- accept values no surface reads.
-- Style mirrors 0058_user_onboarding.sql (pg_temp.login idiom).
-- @trace: W-ONB, docs/10 §1 "progress is never lost", invariant 12 (expand-only)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Fixtures (synthetic only — one tenant, one user) ────────────────────────
insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-00000000b501', 'onb59.u1@meadowbrook.test');
insert into public.tenant (id, name) values
  ('cccccccc-0000-0000-0000-0000000000b5', 'Onb59 Tenant');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('cccccccc-0000-0000-0000-00000000b501', 'cccccccc-0000-0000-0000-0000000000b5',
   'Onb59 User', 'onb59.u1@meadowbrook.test', 'staff');

create function pg_temp.login(p_user uuid, p_aal text) returns void
language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

select pg_temp.login('cccccccc-0000-0000-0000-00000000b501', 'aal2');

-- ── Every step key the checklist can return is recordable ───────────────────
-- The thirteen keys of OnboardingStep["key"] in apps/web/src/lib/onboarding.ts, each
-- prefixed `step_`. Before 0059 the office and family checklists had no recordable step
-- at all, so their progress reset on every visit.
select lives_ok(
  format('select app.record_onboarding_milestone(%L)', m),
  format('%s is an accepted first-run milestone', m)
) from unnest(array[
  'step_first_look', 'step_language', 'step_home_screen', 'step_how_visits_work',
  'step_what_you_see', 'step_who_to_contact', 'step_clients', 'step_intake',
  'step_compliance', 'step_clinical_home', 'step_reviews', 'step_exec_overview',
  'step_evidence'
]) as m;

-- ── The widening took nothing away ─────────────────────────────────────────
select lives_ok(
  $$select app.record_onboarding_milestone('welcome_completed')$$,
  'welcome_completed still accepted after the widening'
);
select lives_ok(
  $$select app.record_onboarding_milestone('welcome_skipped')$$,
  'welcome_skipped still accepted after the widening'
);

-- ── Still closed, and still refused with a CAREOS_* code ───────────────────
select throws_like(
  $$select app.record_onboarding_milestone('step_not_a_real_step')$$,
  '%CAREOS_BAD_MILESTONE%',
  'an unlisted step is refused with CAREOS_BAD_MILESTONE, not a raw violation'
);
select throws_like(
  $$select app.record_onboarding_milestone(null)$$,
  '%CAREOS_BAD_MILESTONE%',
  'a null milestone is refused with CAREOS_BAD_MILESTONE'
);

-- ── Idempotency survived the change ────────────────────────────────────────
select is(
  (app.record_onboarding_milestone('step_clients')->>'unchanged')::boolean,
  true,
  're-recording a step is idempotent, not a second row'
);

-- ── The CHECK moved with the guard ─────────────────────────────────────────
-- Both lists are read from the catalog rather than retyped, and compared as SETS, so a
-- future widening that misses either side — a CHECK value the guard refuses, or a guard
-- value the CHECK would turn into a raw 23514 on a caregiver's screen — fails this file
-- instead of reaching production. The regexp keys on the milestone shape
-- ('welcome_*' / 'step_*'), which is what keeps error-code and message literals in the
-- function body out of the comparison.
reset role;
select set_eq(
  $$ select m[1] from regexp_matches(
       (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid = 'public.onboarding_milestone'::regclass
           and conname  = 'onboarding_milestone_milestone_check'),
       '''((?:welcome|step)_[a-z_]+)''', 'g') m $$,
  array['welcome_completed','welcome_skipped','step_first_look','step_language',
        'step_home_screen','step_how_visits_work','step_what_you_see',
        'step_who_to_contact','step_clients','step_intake','step_compliance',
        'step_clinical_home','step_reviews','step_exec_overview','step_evidence'],
  'the CHECK carries exactly the fifteen-milestone allowlist — no more, no fewer'
);
select set_eq(
  $$ select m[1] from regexp_matches(
       pg_get_functiondef('app.record_onboarding_milestone(text)'::regprocedure),
       '''((?:welcome|step)_[a-z_]+)''', 'g') m $$,
  $$ select m[1] from regexp_matches(
       (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid = 'public.onboarding_milestone'::regclass
           and conname  = 'onboarding_milestone_milestone_check'),
       '''((?:welcome|step)_[a-z_]+)''', 'g') m $$,
  'the RPC guard and the CHECK agree value-for-value, in both directions'
);
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.onboarding_milestone'::regclass
             and conname  = 'onboarding_milestone_milestone_check'
             and contype  = 'c'),
  'the milestone allowlist is still enforced by a CHECK constraint'
);

select * from finish();
rollback;
