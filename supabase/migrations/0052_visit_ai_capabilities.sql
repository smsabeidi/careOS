-- ST-210 · Migration 0052 — the visit AI registry: four capabilities, four kill switches
-- The Verified Visit layer (0043–0051) manufactures deterministic facts. This migration
-- is where the probabilistic half is DECLARED — and declaring it is the entire point.
-- Invariant 8 ("AI proposes, a licensed human disposes") is enforced by rows in
-- public.ai_capability and the CHECK 0014 put on them, not by prose in a doc. Nothing
-- here calls a model. It records what may be called, at which tier, under whose
-- disposition, against which model pin and monthly cap, and lays the four feature-flag
-- switches this layer ships with (the 0026 §C mechanism).
--
-- What lands:
--   * app.seed_visit_ai_capabilities(tenant) — docs/17 §11's four NEW capabilities plus
--     their v1 registry prompts (invariant 10: a prompt is a row, never a string literal
--     in code, so a capability registered without one is uncallable by construction).
--   * app.seed_visit_feature_flags(tenant) — four public.feature_flag rows, two of them
--     explicitly OFF with a stated reason.
--   * Both applied to every tenant that exists when this migration runs.
--
-- Why visit.operational_profile is T2 with a required human disposer (D-028): it is the
-- only capability in this slice that characterises an individual employee. D-021 ratified
-- that "the system never proposes termination" — separation is always human-initiated and
-- automation begins after the human act — and a per-person operational profile is exactly
-- the artifact that erodes that rule by accident, one helpful summary at a time. So the
-- database refuses the unsafe registration outright: ai_capability_tier_human (0014)
-- makes T2/T3 ⇒ requires_human structurally true, and no later migration, seed, or admin
-- RPC can register this capability as auto-execute. That refusal is the single most
-- important claim in this slice's pgTAP. The capability additionally ships with its kill
-- switch OFF: whether an agency profiles its own caregivers is a decision an owner makes
-- deliberately, not a default they inherit from a migration.
--
-- The other three (visit.exception_triage, workforce.weekly_report,
-- payroll.readiness_brief) are T1 narration over deterministic output — the R4
-- "Det+narrate" pattern of docs/16. Ranking (severity × recency × payroll impact × client
-- risk), minutes, money and eligibility are computed in SQL (invariant 13); the model
-- writes only the why. All four read app.workforce_features (docs/17 §10) and nothing
-- else: IDs, counts and enums — never a name, never a free-text note, and never a
-- coordinate (invariant 5, D-030). Each registered prompt states that boundary in its own
-- text, so a future v2 that drops the clause is visible in a diff.
--
-- Deliberately NOT registered here: ops.daily_brief and ops.nl_query (docs/17 §11 rows 2
-- and 6). Those are docs/16's X5 and X4, which already live in the registry under their
-- real keys — huddle.brief (0015 seed) and analytics.query (0016 seed). §11 marks both
-- "(extend …)", and extending a capability means a new ai_prompt_template VERSION
-- authored alongside the surface that needs it, not a second capability row under an
-- alias. A duplicate would fork the kill switch and the budget of a live capability and
-- leave two rows to disable in an incident (DN-0052a).
--
-- Model pins and budgets follow D-013 and docs/16 §3.1/§5: gpt-5.6-luna ($0.20/$1.20) for
-- drafting and per-item narration, gpt-5.6-terra ($2/$12) for synthesis and reasoning;
-- caps sit in the same $10–25/month band the 0015/0016-era registry uses, sized by
-- cadence — a per-visit triage narration runs far more often than a weekly report.
--
-- Feature flags are written as EXPLICIT rows rather than left to app.feature_enabled's
-- default argument, because a default lives at the call site and a row lives in the
-- database. evv.submission must read false no matter what a future caller passes: D-026
-- conditions any live submission on V17 / D-Q16 and ships the ISAS adapter disabled.
--
-- Idiom: a per-tenant seeding function plus `select f(t.id) from public.tenant t` is the
-- 0044 app.seed_visit_policy precedent, and it exists because production runs the
-- migration chain and never runs seeds — anything a real agency needs on day one has to
-- land here. Both functions are definer with no grants of any kind (the 0027
-- emit_event_internal posture): provisioning plumbing, not a request-path lane. Neither
-- emits audit nor outbox: there is no session, no actor and no consequential act at
-- migration time (invariant 7 governs user actions; app.set_feature_flag already emits
-- for every later flip). No new permission keys either — the registry is read by any
-- tenant member, flags are flipped under platform.manage (0026), and workforce.read
-- belongs to 0051.
-- @trace: ST-210, D-013, D-021, D-026, D-028, D-030, docs/17 §10, §11, §14, docs/16 §3.1

-- ═══ §11 · Capability registrations ═══════════════════════════════════════════════════
-- One function, so the same four rows land identically in production (the call below), in
-- the synthetic universe (a `select app.seed_visit_ai_capabilities(t.id) from
-- public.tenant t;` line in supabase/seeds/, since seeds run after migrations), and for
-- any tenant provisioned after today. Idempotent per KEY, not per tenant: the
-- (tenant_id, key) unique absorbs a re-run, so a tenant that already holds three of the
-- four gets exactly the missing one.
create or replace function app.seed_visit_ai_capabilities(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  -- requires_human is stated per row rather than defaulted, because this column is the
  -- one invariant-8 asserts against — reading it should never require knowing the
  -- column default. The T2 row could not be written any other way regardless: the
  -- ai_capability_tier_human CHECK rejects T2/T3 with requires_human = false.
  insert into public.ai_capability
    (tenant_id, key, name, description, tier, requires_human, model, enabled,
     monthly_budget_usd)
  select p_tenant, c.key, c.name, c.descr, c.tier, c.rh, c.model, c.en, c.budget
  from (values
    ('visit.exception_triage', 'Visit exception triage',
     'Narrates the visit-exception queue. Ranking is deterministic (severity × recency × '
     'payroll impact × client risk, computed in SQL); the model writes only the why and '
     'the next step. It disposes nothing.',
     'T1', false, 'gpt-5.6-luna',  true,  10.00),

    ('workforce.weekly_report', 'Weekly workforce report',
     'Writes the weekly operations narrative from app.workforce_features: adherence, '
     'lateness, exception and overtime aggregates by caregiver ID. Patterns only — '
     'characterising an individual is a separate T2 capability.',
     'T1', false, 'gpt-5.6-terra', true,  15.00),

    ('payroll.readiness_brief', 'Payroll readiness brief',
     'Summarises what blocks a payroll period from closing: unapproved visits, open '
     'exceptions by kind, documentation gaps. Hours and money come from the approved-'
     'hours ledger; the model never computes either.',
     'T1', false, 'gpt-5.6-terra', true,  10.00),

    -- T2 + requires_human + kill switch off. See the header: D-028 and D-021.
    ('visit.operational_profile', 'Caregiver operational profile (draft)',
     'Drafts one caregiver''s operational pattern from app.workforce_features for an '
     'Owner or HR reviewer to read, edit and decide upon. It proposes no employment '
     'action, writes no employment record, and never proposes separation (D-021).',
     'T2', true,  'gpt-5.6-terra', false, 10.00)
  ) as c(key, name, descr, tier, rh, model, en, budget)
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;

  -- Prompts ride along in the same function because invariant 10 makes them part of the
  -- registration, not a follow-up: the AI client resolves the active version per
  -- capability and records it as ai_interaction.prompt_version, so a capability with no
  -- template row cannot lawfully be called at all. Every prompt below states the same
  -- three boundaries — deterministic facts are injected and never recomputed, nothing is
  -- invented, and no coordinate, address, name or clinical detail is ever received or
  -- requested (D-030, invariant 5).
  insert into public.ai_prompt_template
    (tenant_id, capability_key, version, system_prompt, active)
  select p_tenant, p.cap, 1, p.prompt, true
  from (values
    ('visit.exception_triage', $triage$You are the CareOS visit-exception narrator for a Maryland home-care agency. You receive a JSON list of open visit exceptions already ranked by the platform, each with its kind, status, severity, age, the record identifiers involved, and the deterministic evidence the rules engine recorded.

Rules:
1. Use only the facts given. Never reorder the list, never recompute a rank, and never invent an exception, a time, a duration, or a cause.
2. For each item write one or two sentences for the coordinator: what the engine found, what it blocks, and the next step available in the app.
3. You receive no coordinates, no addresses and no clinical detail, and you never ask for them. Distance, when present, arrives as a bucket (inside, near, far) — repeat the bucket, never turn it into a number or a place.
4. Never attribute intent. An exception is a record state, not an accusation: write "the clock-out is missing", never "the caregiver skipped the visit".
5. Plain language, sentence case, no exclamation points, no blame, no consequences you were not given.
6. If the list is empty, say in one sentence that the queue is clear, and stop.$triage$),

    ('workforce.weekly_report', $weekly$You are the CareOS workforce reporter. You receive one JSON object from app.workforce_features for a stated date range: per-caregiver counts, rates and minute aggregates, identified by ID. Every number in it was computed in SQL and is ground truth.

Rules:
1. Never compute, adjust, project, annualise or estimate a number. Report and compare only what the object contains; if a measure is absent, say the report does not cover it rather than filling the gap.
2. Refer to people by the identifier you were given. You have no names, no coordinates, no addresses and no client details, and you never ask for them.
3. Describe patterns, not people. "Six late starts, five of them Mondays" is a pattern; "unreliable" is a characterisation of a person, which is a different capability with a required human disposer.
4. Never propose or imply an employment consequence — no discipline, no termination, no reassignment, and no ranking of staff best to worst.
5. Correlation is not cause. You may note that two series move together; you may not say why.
6. Plain language, sentence case, no exclamation points, short paragraphs in ranked order of operational impact.$weekly$),

    ('payroll.readiness_brief', $payroll$You are the CareOS payroll-readiness briefer. You receive deterministic aggregates for one payroll period: approved and unapproved visit counts, approved minutes, open exceptions blocking approval by kind, and documentation gaps. The approved-hours ledger computed every figure.

Rules:
1. Never compute, convert, restate or estimate minutes, hours, rates or money of any kind. A figure that is not in the facts does not go in the brief.
2. Say what blocks the close, how many items each blocker holds, and what a human does next.
3. You never decide that a period may close, that a visit may be paid, or that an exception may be waived. Those are human acts on deterministic evidence.
4. Use the identifiers you were given. You receive no names, no coordinates, no addresses and no client details, and you never ask for them.
5. Plain language, sentence case, no exclamation points. Five sentences or fewer unless the blockers need more.
6. If nothing blocks the close, say so in one sentence, and stop.$payroll$),

    ('visit.operational_profile', $profile$You are the CareOS operational-profile drafter. You receive app.workforce_features for ONE caregiver over a stated date range: counts, rates and minute aggregates, by ID, computed in SQL. You write a draft for a named Owner or HR reviewer to read, edit and decide upon. You are not the decision, and this draft is never shown to the person it describes.

Rules:
1. Every sentence must trace to a figure in the facts. Never infer attitude, effort, honesty, health, family circumstances or intent — ever.
2. Never recommend, imply or rank an employment action: no discipline, no termination, no probation, no reassignment, no "consider whether". The system never proposes separation; a human initiates it, and this draft is not that act.
3. Name what changed and over what window, with the figures. Where a pattern has a benign explanation as well as a concerning one, state both and say plainly that the facts do not distinguish them.
4. You receive no coordinates, no addresses, no client identities and no clinical information, and you never ask for them.
5. If the window is short or the counts are small, say the sample is too small to characterise a person, and stop. Silence is a valid output.
6. Plain language, sentence case, no exclamation points, no praise, no judgement words.$profile$)
  ) as p(cap, prompt)
  on conflict (tenant_id, capability_key, version) do nothing;

  return v_count;
end $$;
-- Internal provisioning plumbing: no grants at all, to anybody (the 0027
-- emit_event_internal posture). Registration is a deploy-time act, not a request.
revoke all on function app.seed_visit_ai_capabilities(uuid)
  from public, anon, authenticated;

-- ═══ Feature flags — the four switches this layer ships with (0026 §C) ════════════════
-- Explicit rows, because app.feature_enabled(key, default) resolves an ABSENT row to the
-- caller's default: a story that ships dark must not depend on every future call site
-- remembering to pass false. A row is the switch; the default is only a fallback.
--   evv.offline_capture   OFF — the PWA offline queue (docs/17 §7.6) is capture without a
--                               network, and it stays dark until its replay path is
--                               proven (D-022 made the web the EVV surface; the queue is
--                               the part that can duplicate a clock event).
--   evv.submission        OFF — D-026: no live submission endpoint until V17 / D-Q16
--                               resolve; the Maryland ISAS adapter ships disabled.
--   visit.trust_score     ON  — D-028: deterministic arithmetic over evidence already in
--                               the tenant's own ledger, read-only, no adverse action.
--   workforce.intelligence ON — aggregate features (docs/17 §10) over the same ledger:
--                               IDs, counts, no coordinates, no names.
create or replace function app.seed_visit_feature_flags(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  -- updated_by stays null: nobody flipped these, the deploy laid them. Every later flip
  -- goes through app.set_feature_flag, which pins the actor and emits the audit event.
  insert into public.feature_flag (tenant_id, key, enabled, disabled_reason, updated_by)
  select p_tenant, f.key, f.en, f.reason, null::uuid
  from (values
    ('evv.offline_capture', false,
     'Offline clock capture stays dark until the PWA queue and its replay tests ship '
     '(docs/17 §7.6, D-022).'),
    ('evv.submission', false,
     'No live EVV submission endpoint until V17 / D-Q16 resolve; the ISAS adapter ships '
     'disabled (D-026).'),
    ('visit.trust_score', true, null::text),
    ('workforce.intelligence', true, null::text)
  ) as f(key, en, reason)
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.seed_visit_feature_flags(uuid)
  from public, anon, authenticated;

-- ═══ Apply to the tenants that exist now ══════════════════════════════════════════════
-- Hosted is covered here. Local and preview build the Meadowbrook universe in
-- supabase/seeds/ AFTER migrations run, so those tenants need the same two lines added to
-- a seed file. Until that lands, a synthetic tenant simply has no registry rows and no
-- flag rows: every capability reads as unregistered and every flag falls back to its call
-- site's default — inert and visible, never a silent auto-execute.
select app.seed_visit_ai_capabilities(t.id) from public.tenant t;
select app.seed_visit_feature_flags(t.id) from public.tenant t;
