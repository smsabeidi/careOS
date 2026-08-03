-- pgTAP · 0014 — COMAR fidelity: month arithmetic, clock injection, one-shot admission
--
-- The month-vs-day assertions are the point. Before ST-114 the engine encoded COMAR's
-- "3 months" as 90 days; these tests fail if anyone ever rounds a calendar month back
-- into a day count, because they pick start dates where the two genuinely differ.
-- @trace: ST-114, D-016
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Structure ──────────────────────────────────────────────────────────────
select has_column('public', 'cadence_rule', 'interval_months',
  'cadence_rule can express a calendar-month period');
select has_function('app', 'cadence_period', ARRAY['integer','integer'],
  'app.cadence_period exists');
select has_function('app', 'evaluate_compliance', ARRAY['date'],
  'the evaluator accepts an injected clock');

-- ── Calendar months are not fixed day counts ───────────────────────────────
-- Start dates chosen where the two genuinely diverge. Many spans coincide (Dec 1 + 3
-- months and Dec 1 + 90 days are both Mar 1 in a common year), which is precisely why
-- the original 90/120-day encoding looked correct in casual testing and was not.
-- From 2026-03-01 the gap is two days — two days of a missed supervisory visit.
select is(
  (date '2026-03-01' + app.cadence_period(null, 3))::date, date '2026-06-01',
  '3 months from 2026-03-01 is 2026-06-01 (what COMAR 10.07.05.12 actually says)');
select is(
  (date '2026-03-01' + app.cadence_period(90, null))::date, date '2026-05-30',
  '90 days from 2026-03-01 is 2026-05-30 (what the old encoding computed)');
select isnt(
  (date '2026-03-01' + app.cadence_period(null, 3))::date,
  (date '2026-03-01' + app.cadence_period(90, null))::date,
  '3 months and 90 days diverge — the defect ST-114 fixed');
select is(
  (date '2026-03-01' + app.cadence_period(null, 4))::date, date '2026-07-01',
  '4 months from 2026-03-01 is 2026-07-01');
select isnt(
  (date '2026-03-01' + app.cadence_period(null, 4))::date,
  (date '2026-03-01' + app.cadence_period(120, null))::date,
  '4 months and 120 days diverge (2026-07-01 vs 2026-06-29)');

-- Month-end clamping must not throw: Jan 31 + 1 month is Feb 28/29, not an error.
select is(
  (date '2026-01-31' + app.cadence_period(null, 1))::date, date '2026-02-28',
  'month arithmetic clamps 2026-01-31 + 1 month to 2026-02-28 rather than overflowing');

select is(app.cadence_period(null, null), NULL::interval,
  'a rule with neither unit yields NULL, keeping the evaluator total');

-- ── A rule may not carry two units, or none ────────────────────────────────
select throws_ok(
  $$ insert into public.cadence_rule
       (tenant_id, key, name, applies_to, trigger_kind, interval_days, interval_months)
     select id, 'zz_probe_both', 'both units', 'client', 'interval_days', 30, 1
       from public.tenant limit 1 $$,
  '23514', NULL,
  'an interval rule carrying BOTH days and months is rejected');

select throws_ok(
  $$ insert into public.cadence_rule
       (tenant_id, key, name, applies_to, trigger_kind, interval_days, interval_months)
     select id, 'zz_probe_neither', 'no unit', 'client', 'interval_days', null, null
       from public.tenant limit 1 $$,
  '23514', NULL,
  'an interval rule carrying NEITHER unit is rejected — the evaluator stays total');

-- ── The seeded supervisory rules use the regulation's own units ────────────
select is(
  (select interval_months from public.cadence_rule where key = 'supervisory.90d'), 3,
  'supervisory.90d is 3 CALENDAR MONTHS per COMAR 10.07.05.12, not 90 days');
select is(
  (select interval_days from public.cadence_rule where key = 'supervisory.90d'), NULL,
  'supervisory.90d no longer carries a day count');
select is(
  (select interval_months from public.cadence_rule where key = 'supervisory.120d'), 4,
  'supervisory.120d is 4 CALENDAR MONTHS per COMAR 10.07.05.12');
select is(
  (select interval_days from public.cadence_rule where key = 'supervisory.45d'), 45,
  'supervisory.45d stays in DAYS — the regulation states 45 days, not 1.5 months');

-- ── The obligations COMAR requires that the engine used to miss ────────────
select isnt_empty(
  $$ select 1 from public.cadence_rule where key = 'carenote.weekly' and interval_days = 7 $$,
  'the weekly care-note obligation (COMAR 10.07.05.14D) exists');
select isnt_empty(
  $$ select 1 from public.cadence_rule
      where key = 'assessment.initial' and trigger_kind = 'on_admission' $$,
  'the initial-assessment obligation exists and uses on_admission');

-- ── on_admission actually materializes (it was a dead enum value) ──────────
select lives_ok(
  $$ select app.evaluate_compliance(current_date) $$,
  'the evaluator runs with an injected clock');

select isnt_empty(
  $$ select o.id from public.obligation o
       join public.cadence_rule r on r.id = o.cadence_rule_id
      where r.trigger_kind = 'on_admission' $$,
  'on_admission rules now materialize obligations — before ST-114 they never could');

-- One-shot: re-running must not create a second live obligation per client.
select is(
  (select count(*) from public.obligation o
     join public.cadence_rule r on r.id = o.cadence_rule_id
    where r.key = 'assessment.initial'),
  (select count(*) from public.client c
    where c.status = 'active' and c.admitted_on is not null),
  'exactly one initial-assessment obligation exists per admitted active client');

select lives_ok($$ select app.evaluate_compliance(current_date) $$, 'evaluator is idempotent');
select is(
  (select count(*) from public.obligation o
     join public.cadence_rule r on r.id = o.cadence_rule_id
    where r.key = 'assessment.initial'),
  (select count(*) from public.client c
    where c.status = 'active' and c.admitted_on is not null),
  're-running the evaluator does not duplicate one-shot admission obligations');

-- ── Clock injection genuinely changes the verdict ──────────────────────────
-- This is what makes temporal correctness testable at all: the same obligation must
-- read differently at two different evaluation dates.
select is(
  app.cadence_status('open', current_date + 200, 0, 14, current_date), 'open',
  'an obligation 200 days out is open today');
select is(
  app.cadence_status('open', current_date + 200, 0, 14, current_date + 195), 'at_risk',
  'the same obligation is at_risk when evaluated 195 days later');
select is(
  app.cadence_status('open', current_date + 200, 0, 14, current_date + 201), 'overdue',
  'and overdue the day after it is due');

-- ── Every seeded rule is traceable to a catalogued authority ───────────────
select is_empty(
  $$ select key from public.cadence_rule
      where key like any (array['assessment.%','supervisory.%','carenote.%'])
        and legal_authority_id is null $$,
  'every client-facing COMAR rule links to a legal_authority row');

-- ...and none of them may pretend to be verified. This is the honesty gate: if a rule
-- ever renders a shield icon, a human must have attested it via app.publish_authority.
select is_empty(
  $$ select cadence_rule_id from public.cadence_rule_authority
      where authority_is_verified $$,
  'no seeded Maryland rule claims verified authority — all are honestly unverified');

select is_empty(
  $$ select key from public.cadence_rule
      where comar_source_ref like 'Doc 02%' $$,
  'the "Doc 02 §3 — enrich with COMAR cite" placeholder no longer exists in any rule');

select finish();
rollback;
