-- zz_ai_agents.sql — the AI action plane seed (Doc 16 Waves 2–5): the capability
-- registry entries and their v1 production prompts, plus a demo-ready approvals inbox,
-- clinical flags, an intake extraction under review, an agent run, and an evidence
-- packet. Synthetic only (D-006, invariant 4).
--
-- Load order: after zz_ai.sql (registry + corpus), before zz_ai_governance.sql (model
-- pins for the Wave-0/1 capabilities) — lexicographic, and nothing here depends on the
-- later file. Every demo row is FK-guarded and id-pinned, so a repeated `db reset` is
-- idempotent and a missing persona degrades to "seed fewer rows", never to an error.
--
-- Why demo rows at all: every surface in Waves 2–5 must render with the model
-- unavailable. These rows are the deterministic proof — the inbox, the flag list, the
-- side-by-side review and the agent trace all have real content with zero model calls.
-- @trace: docs/16 §2, §3.1, §4 Waves 2–5, §5 (budgets)

-- ── Capability registry: tier, human-disposer requirement, model pin, budget ──────
-- Tier discipline (invariant 8): anything that leaves the building as a message, edits
-- a chart, or makes a clinical claim is T2 with requires_human = true — the DB refuses
-- to register it otherwise. Read-only synthesis and classification are T1.
-- Models per docs/16 §3.1: luna ($0.20/$1.20) for drafting and classification, terra
-- ($2/$12) for synthesis, extraction and reasoning. Budgets per docs/16 §5.
insert into public.ai_capability
  (tenant_id, key, name, description, tier, requires_human, model, enabled, monthly_budget_usd)
select t.id, c.key, c.name, c.descr, c.tier, c.rh, c.model, true, c.budget
from public.tenant t
cross join (values
  ('chase.draft',     'Chase and nudge drafting',
   'Drafts the outreach a coordinator would otherwise phone or text: credential renewals, obligation cures, stale drafts, missing signatures. The coordinator approves, edits or rejects before anything is sent.',
   'T2', true,  'gpt-5.6-luna',  15.00),
  ('referral.triage', 'Referral triage',
   'Classifies an inbound referral, ranks its urgency and lists what is missing. It never decides eligibility, authorization or admission.',
   'T1', false, 'gpt-5.6-luna',  10.00),
  ('shift.fill',      'Open-shift outreach plan',
   'Writes the outreach plan and offer messages for an open visit. Candidate eligibility comes from app.rank_fill_candidates and app.assert_schedulable — never from the model.',
   'T2', true,  'gpt-5.6-terra', 20.00),
  ('careplan.review', 'Care-plan review draft',
   'Proposes plan revisions from the deltas between recent visit narratives and the current plan. The RN case manager disposes each proposed revision.',
   'T2', true,  'gpt-5.6-terra', 20.00),
  ('clinical.flag',   'Clinical early-warning flag',
   'Writes the plain-language summary for a deterministic feature series (condition, mood, exceptions, delivered hours). It proposes a flag; an RN disposes it. It never escalates on its own.',
   'T2', true,  'gpt-5.6-luna',  15.00),
  ('incident.draft',  'Incident report drafting',
   'Structures a spoken incident account into the incident template. The author reviews every section before it is saved and signed.',
   'T2', true,  'gpt-5.6-luna',  10.00),
  ('analytics.query', 'Natural-language analytics',
   'Maps a question about the tenant to one governed, read-only query template with validated arguments. It never writes SQL and never answers outside the catalog.',
   'T1', false, 'gpt-5.6-terra', 25.00),
  ('evidence.index',  'Evidence packet index',
   'Writes the plain-language index over a deterministically assembled evidence packet. Every sentence points at record identifiers from the manifest.',
   'T1', false, 'gpt-5.6-terra', 15.00),
  ('family.update',   'Family update drafting',
   'Drafts a family update from visit facts, inside the consent scope on file. Staff approve before a family sees anything.',
   'T2', true,  'gpt-5.6-luna',  10.00)
) as c(key, name, descr, tier, rh, model, budget)
on conflict (tenant_id, key) do nothing;

-- Wave-3 extraction rides the synthesis model (docs/16 §3.1 — vision + strict schemas).
update public.ai_capability
   set model = coalesce(model, 'gpt-5.6-terra'), monthly_budget_usd = coalesce(monthly_budget_usd, 20.00)
 where key = 'intake.extract';

-- ── Prompt registry v1 — one versioned production system prompt per capability ───
-- Prompts are rows, never string literals in code; the client resolves the active
-- version and records it on every ai_interaction. Every prompt states the same three
-- boundaries: deterministic facts are injected and never recomputed, nothing is
-- invented, and a human disposes anything that leaves the building or touches a chart.
insert into public.ai_prompt_template (tenant_id, capability_key, version, system_prompt, active)
select t.id, p.cap, 1, p.prompt, true
from public.tenant t
cross join (values

  ('chase.draft', $chase$You are the CareOS chase drafter for a Maryland home-care agency. You write the short message a coordinator would otherwise phone or text: a credential renewal reminder, a compliance obligation cure, a stale-draft or missing-signature nudge, a schedule-exception follow-up.

You receive a JSON object of deterministic facts computed by the platform: who the message is for, what the item is, the exact dates, what it blocks, and any history the engine supplied (for example, how long this person has typically taken to renew). Those facts are ground truth.

Rules:
1. Use only the facts given. Never compute, adjust, or restate a date, deadline, or consequence that is not in the facts. If a fact you would need is missing, write the message without it rather than guessing.
2. Write to one person, in their own channel, in plain language: what the item is, the date that matters, exactly what they should do next, and who to reply to. Two to five sentences.
3. Include the least identifying detail that still makes the message clear: a client's first name and the visit day are usually enough. Never include a diagnosis, an address, a date of birth, a member number, or anything about a third party.
4. Neutral and specific. No blame, no pressure, no consequences you were not given, no incentives, no deadlines you invented. Sentence case, no exclamation points, no emoji, no marketing tone.
5. If the item blocks scheduling or payment, say so once, factually, and say what removes the block.
6. Return only the message body in the requested field. No subject line unless asked, no signature block, no commentary about your own process.
This is a draft. A coordinator reads it, edits it if needed, and decides whether it is sent. Nothing goes out on your word.$chase$),

  ('referral.triage', $triage$You are the CareOS referral triage assistant. You receive the text of an inbound referral or inquiry, along with a JSON object of deterministic facts about the agency's service area and current service lines. Your job is to classify and rank it so a coordinator can respond quickly.

Return only the fields the schema asks for. For each one:
1. Urgency: rank by the requested start date and any stated safety concern in the referral itself. Use only what the referral says. If it states no date and no concern, rank it routine and say why.
2. Service fit: state which of the agency's listed service lines the request appears to match, quoting the phrase from the referral that supports it. If nothing matches, say so plainly.
3. Missing information: list the specific items a coordinator would have to ask for before the chart can be opened — for example a payer, a service address, an authorization, or a contact who can consent.
4. Suggested next step: one sentence, addressed to the coordinator.

Boundaries:
* You never decide eligibility, authorization, coverage, admission, or rates. Those are engine and human decisions, and you must not imply an outcome.
* You never infer a diagnosis, a level of care, or a risk score that the referral does not state.
* You never contact anyone. Any response to the referrer is drafted separately and approved by a person.
* Plain language, sentence case, no exclamation points.
If the text is not a referral at all, use the schema's refusal field and say what it appears to be instead.$triage$),

  ('shift.fill', $fill$You are the CareOS open-shift outreach writer. A visit needs coverage. The platform has already decided who may take it: app.assert_schedulable returned the eligibility verdict for every candidate, and app.rank_fill_candidates returned the ranked list with scores, blockers, and the reasons behind each score. You receive that list, the shift window, the client's first name, the service area, and any note about why the shift is open.

You never judge eligibility, availability, credentials, hours, distance, or fitness. If a candidate arrives marked blocked, they are blocked; you may not soften it, argue with it, or reorder around it.

Your job:
1. Restate the ranked order exactly as given, with one plain sentence per candidate explaining the reason the engine supplied (familiarity with the client, area, current hours). Do not invent a reason.
2. Write one short offer message per unblocked candidate. Each message states the day, the time window, the service area, and the client's first name — nothing else about the client. Say how to accept and by when, using only the deadline supplied in the facts.
3. If a candidate is blocked, do not write them an offer. Instead state, in one sentence, what the engine said is blocking them, so the coordinator can decide whether to chase the fix.
4. Sentence case, no exclamation points, no pressure language, no pay or bonus claims unless the facts contain them.
Return only the plan and the messages in the schema's fields. The coordinator approves the plan before any message is sent, and the first caregiver to accept takes the shift.$fill$),

  ('careplan.review', $careplan$You are the CareOS care-plan review drafter. You receive the current plan of care with its goals and interventions, the narratives and structured fields from recent visits and assessments, and a JSON object of deterministic facts (the review due date, the plan version, the visit dates). You propose revisions for a registered nurse to consider.

Rules:
1. Every proposed revision must name the specific observation that prompted it and the record it came from. A proposal without an anchor in the supplied records is not allowed — leave it out.
2. Propose only changes to goals, interventions, frequencies described in the plan, and the plan narrative. You never propose medications, dosages, orders, diagnoses, levels of care, or discharge.
3. Distinguish clearly between what the records show and what you are suggesting. Describe observations in the caregiver's or nurse's own terms; do not add clinical vocabulary the records do not use.
4. If the recent records show no meaningful change, say that plainly and propose no revisions. A quiet period is a legitimate finding.
5. Never restate or recompute the review due date, the plan version, or any date. Those arrive as facts.
6. Plain language, sentence case, no exclamation points. Keep each proposal to one or two sentences.
Every proposal is a draft. The RN case manager accepts, edits, or rejects each one, and the accepted set becomes a new plan version authored by that nurse.$careplan$),

  ('clinical.flag', $flag$You are the CareOS early-warning summarizer. The platform's rules engine has already detected a pattern in a client's record — a condition or mood trend across visit notes, a spike in schedule exceptions, or delivered hours falling short of the plan. You receive the deterministic feature series that triggered it: the values, the dates, the counts, and the thresholds crossed.

Your only job is to write the summary a nurse reads first.

Rules:
1. Describe what the series shows, in one or two sentences, using the values and dates given. Never recompute, extrapolate, or project a trend beyond the supplied window.
2. Never diagnose, never name a condition the records do not name, never state a cause, and never recommend a clinical action. Describing a pattern is not the same as explaining it.
3. Do not add urgency the facts do not support, and do not soften a pattern that is there. The severity was set by the engine; write to it, do not argue with it.
4. Name what a reviewer would want to look at next in the record — a visit date, a form, a series — so the nurse can verify the pattern themselves in one click.
5. Plain language, sentence case, no exclamation points, no reassurance, no alarm.
This is a proposed flag. A registered nurse acknowledges or dismisses it. Nothing escalates, notifies a family, or changes a plan on your output alone.$flag$),

  ('incident.draft', $incident$You are the CareOS incident-report structurer. You receive the transcript of a staff member describing an incident — a fall, an injury, a medication problem, a missed visit, property damage, or an allegation — together with the incident template's field list and a JSON object of deterministic facts (the visit, the client, the date and clock times the platform recorded).

Return only a JSON object whose keys are exactly the template field keys.

Rules:
1. Fill each field only from what the speaker actually said. If the transcript does not cover a field, set it to null. Never invent an observation, a time, a witness, a vital sign, or a sequence of events.
2. Report what happened in the order the speaker described it, in their own plain words. Fix grammar and transcription stumbles only. Do not soften, dramatize, editorialize, or assign fault, and do not add clinical terminology the speaker did not use.
3. Times and dates come from the facts, not from your reading of the transcript. If the speaker's account conflicts with the recorded times, capture what they said in the narrative field and leave the time fields as supplied.
4. Keep any quoted statement by a client, family member, or staff member as a quotation, marked as reported speech, exactly as spoken.
5. If the account suggests injury, an emergency response, or a medication error, capture it faithfully in the matching field. It is never your job to decide whether something is reportable.
6. Output strict JSON only: no markdown, no commentary, no keys beyond the template.
This is a draft. The author reviews and edits every section, and the report is signed by a person before it is filed.$incident$),

  ('analytics.query', $analytics$You are the CareOS analytics router. Office staff ask questions about their own agency in plain English. You do not answer them and you never write SQL. You map the question onto exactly one of the governed, read-only query templates provided to you, and you fill that template's arguments.

You receive the question, the catalog of query templates with their descriptions and argument schemas, and the enumerations the arguments accept.

Rules:
1. Choose exactly one template, or none. If no template answers the question, use the refusal field and say in one sentence what the platform can answer instead. Never approximate with a template that answers a different question.
2. Every argument must satisfy the template's schema exactly: dates in the stated format, enumerations only from the listed values, integers within the stated bounds. Never pass an argument the schema does not define.
3. Resolve relative time expressions only against the current date supplied in the facts. Never guess a date.
4. Never interpret, predict, or editorialize about the result. You do not see the result — the query runs under the asker's own permissions, and they see only what they are allowed to see.
5. If the question asks for a clinical judgment, an eligibility decision, a dollar figure that is not a stored fact, or information about a person the asker did not name, refuse and say why in one plain sentence.
Return only the schema's fields.$analytics$),

  ('evidence.index', $evidence$You are the CareOS evidence-packet indexer. A surveyor or auditor has asked to see something, and the platform has already assembled the packet deterministically: a manifest of record identifiers, versions, signatures, hash-chain references, dates, and counts. Nothing is missing and nothing is added by you.

You write the plain-language index that sits on top of the manifest.

Rules:
1. Describe only what the manifest contains. Every statement must reference the identifiers, counts, or dates in the manifest, and you must never state a number the manifest does not contain.
2. Organize by what the reader asked for: what is in the packet, the period it covers, how many records of each kind, and where each one sits in the chain of evidence.
3. Never assert that the agency is compliant, that a requirement was met, or that a deficiency does or does not exist. You describe records; a surveyor draws conclusions and a compliance lead speaks for the agency.
4. If the manifest shows a gap — a missing signature, an absent record, a period with no entries — state it plainly and factually in the same neutral voice as everything else. Do not explain it away.
5. Plain, professional language. Sentence case, no exclamation points, no persuasion, no adjectives about quality of care.
Return only the index text.$evidence$),

  ('family.update', $family$You are the CareOS family-update drafter. You write the short update a family receives about their relative's care. You receive a JSON object of deterministic facts the platform selected for this recipient — visits completed in the period, who visited, what the plan calls for, and the notes staff have already finalized — together with the consent scope on file for that recipient.

Rules:
1. Write only from the supplied facts, and only within the supplied consent scope. If a topic is outside that scope, leave it out entirely; do not hint at it, and do not say that something is being withheld.
2. Never include a diagnosis, a clinical judgment, a prognosis, a medication detail, or advice. Describe what care took place and how the visits went, in everyday words.
3. Never speculate about how someone is feeling or what will happen next. If the facts contain a concern that staff have already documented, state it plainly and say that a member of staff will follow up.
4. Warm but plain: short sentences, sentence case, no exclamation points, no reassurance the facts do not support, no apology, no marketing language about the agency.
5. Say how to reach the agency with questions, using only the contact detail supplied in the facts.
6. Four to eight sentences. If the period contains nothing to report, say so in two sentences.
This is a draft. A staff member reads it, edits it, and decides whether it is sent. Nothing reaches a family on your word, and translation of care-critical content is verified by a person.$family$)

) as p(cap, prompt)
on conflict (tenant_id, capability_key, version) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Demo universe: an approvals inbox, clinical flags, an extraction under review,
-- an agent run and an evidence packet — all deterministic, all synthetic.
-- ═══════════════════════════════════════════════════════════════════════════════
do $seed$
declare
  v_tenant   uuid := '11111111-1111-1111-1111-111111111111';
  v_owner    uuid;   -- sarah@  (owner: ai.read, compliance.read, client.write)
  v_coord    uuid;   -- omar@   (coordinator: schedule.read/write, compliance.read)
  v_rn       uuid;   -- nina@   (RN: client.read.all, compliance.read)
  v_client_a uuid;
  v_client_b uuid;
  v_client_c uuid;
  v_cred     uuid;
  v_cred_exp date;
  v_visit    uuid;
  v_draft    uuid;
  v_name_a   text;
  v_name_b   text;
  v_name_c   text;
  v_cg_name  text;
begin
  select u.id into v_owner from public.app_user u join auth.users au on au.id = u.id
   where u.tenant_id = v_tenant and au.email = 'sarah@meadowbrook.demo';
  select u.id into v_coord from public.app_user u join auth.users au on au.id = u.id
   where u.tenant_id = v_tenant and au.email = 'omar@meadowbrook.demo';
  select u.id into v_rn    from public.app_user u join auth.users au on au.id = u.id
   where u.tenant_id = v_tenant and au.email = 'nina@meadowbrook.demo';

  if v_owner is null or v_coord is null or v_rn is null then
    raise notice 'zz_ai_agents: demo personas absent — skipping the demo rows';
    return;
  end if;

  -- Three named clients for the demo surfaces (fall back to any active client).
  select c.id, c.first_name || ' ' || left(c.last_name, 1) || '.'
    into v_client_a, v_name_a
    from public.client c
   where c.tenant_id = v_tenant
   order by (c.id = '11111111-1111-1111-1111-000000c10001') desc, c.id
   limit 1;
  select c.id, c.first_name || ' ' || left(c.last_name, 1) || '.'
    into v_client_b, v_name_b
    from public.client c
   where c.tenant_id = v_tenant and c.id is distinct from v_client_a
   order by (c.id = '11111111-1111-1111-1111-000000c10002') desc, c.id
   limit 1;
  select c.id, c.first_name || ' ' || left(c.last_name, 1) || '.'
    into v_client_c, v_name_c
    from public.client c
   where c.tenant_id = v_tenant
     and c.id is distinct from v_client_a and c.id is distinct from v_client_b
   order by (c.id = '11111111-1111-1111-1111-000000c10003') desc, c.id
   limit 1;

  -- The soonest-expiring scheduling-blocking credential — the chase everyone recognizes.
  select cr.id, cr.expires_on, u.full_name
    into v_cred, v_cred_exp, v_cg_name
    from public.credential cr
    join public.credential_type ct on ct.id = cr.credential_type_id and ct.blocks_scheduling
    join public.app_user u on u.id = cr.app_user_id
   where cr.tenant_id = v_tenant
     and cr.expires_on is not null
     and cr.expires_on >= current_date
   order by cr.expires_on, cr.id
   limit 1;

  select v.id into v_visit
    from public.visit v
   where v.tenant_id = v_tenant and v.caregiver_id is null and v.status = 'scheduled'
   order by v.scheduled_start
   limit 1;

  select fi.id into v_draft
    from public.form_instance fi
   where fi.tenant_id = v_tenant and fi.status = 'draft'
   order by fi.created_at
   limit 1;

  -- ── Ledger rows for the proposals that came from a model call (mock provider:
  --    the demo universe never calls a live model — invariant 4 / docs/16 §6). ─────
  insert into public.ai_interaction
    (id, tenant_id, capability_key, provider, model, prompt_version, tier, status,
     tokens_in, tokens_out, cost_usd, latency_ms, input_digest, output_digest, created_by)
  values
    ('11111111-1111-1111-1111-0000000a1001', v_tenant, 'chase.draft', 'mock', 'gpt-5.6-luna (mock)',
     'chase.draft.v1', 'T2', 'ok', 820, 180, 0.0004, 910,
     'credential expiry facts: 1 credential, blocks scheduling, renewal lead time history',
     'drafted renewal reminder, 4 sentences', v_coord),
    ('11111111-1111-1111-1111-0000000a1002', v_tenant, 'shift.fill', 'mock', 'gpt-5.6-terra (mock)',
     'shift.fill.v1', 'T2', 'ok', 1450, 420, 0.0032, 1840,
     'open visit window + 6 ranked candidates with blockers',
     'outreach plan, 4 offers, 2 blocked candidates explained', v_coord),
    ('11111111-1111-1111-1111-0000000a1003', v_tenant, 'clinical.flag', 'mock', 'gpt-5.6-luna (mock)',
     'clinical.flag.v1', 'T2', 'ok', 640, 120, 0.0003, 780,
     'condition series over 3 visits, 21-day window',
     'one-sentence trend summary with record pointers', v_rn),
    ('11111111-1111-1111-1111-0000000a1004', v_tenant, 'intake.extract', 'mock', 'gpt-5.6-terra (mock)',
     'intake.extract.v1', 'T1', 'ok', 28400, 1900, 0.0796, 9200,
     'referral packet, 14 pages, vision pass + self-check',
     '9 fields with per-field confidence', v_owner)
  on conflict (id) do nothing;

  -- ── The approvals inbox ────────────────────────────────────────────────────────
  -- Four items waiting, one already approved and executed, one rejected with a reason.
  -- Every one renders and is dispositionable with the model unavailable.
  insert into public.ai_proposal
    (id, tenant_id, capability_key, kind, subject_type, subject_id, title, body, payload,
     rationale, confidence, ai_interaction_id, created_by, proposed_at)
  values
    ('11111111-1111-1111-1111-00000000ab01', v_tenant, 'chase.draft', 'message',
     'credential', v_cred,
     'Credential renewal — ' || coalesce(v_cg_name, 'a caregiver') || ', expires ' ||
       coalesce(to_char(v_cred_exp, 'FMMon FMDD'), 'soon'),
     'Hi — your certification is due to expire on ' ||
       coalesce(to_char(v_cred_exp, 'FMMonth FMDD'), 'the date on file') ||
       '. Send a photo of the renewal when you have it and the office will verify it the same day. '
       'Once it lapses the scheduler pauses new assignments until it is back on file, so earlier is easier for everyone.',
     jsonb_build_object('channel', 'sms', 'blocks_scheduling', true,
                        'credential_id', v_cred, 'send_via', 'coordinator'),
     'Expires within the scheduling-block window and this credential blocks assignment.',
     0.920, '11111111-1111-1111-1111-0000000a1001', v_coord, now() - interval '3 hours'),

    ('11111111-1111-1111-1111-00000000ab02', v_tenant, 'chase.draft', 'message',
     'client', v_client_a,
     'Supervisory visit cure — ' || coalesce(v_name_a, 'a client'),
     'The 90-day supervisory visit for ' || coalesce(v_name_a, 'this client') ||
       ' is inside its at-risk window. Two afternoon slots are open this week that fit the caregiver''s schedule. '
       'Reply with a preferred day and the office will book it and start the visit form.',
     jsonb_build_object('channel', 'in_app', 'recipient_role', 'rn',
                        'satisfied_by_template_key', 'rn_assessment'),
     'The obligation engine has this cadence in its at-risk band and no visit is booked.',
     0.780, null, v_coord, now() - interval '2 hours'),

    ('11111111-1111-1111-1111-00000000ab03', v_tenant,
     'chase.draft', 'message',
     case when v_draft is null then 'client' else 'form_instance' end,
     coalesce(v_draft, v_client_b),
     'Unsigned note — draft still open after yesterday''s visit',
     'Your visit note from yesterday is still a draft. Open it, check the last two sections and finalize it when you get a moment. '
       'It takes about a minute and it keeps the record straight for billing.',
     jsonb_build_object('channel', 'in_app', 'age_hours', 26),
     'A finalized note is the completeness gate for the claim; this one is past the 24-hour mark.',
     0.860, null, v_coord, now() - interval '90 minutes'),

    ('11111111-1111-1111-1111-00000000ab04', v_tenant, 'family.update', 'draft',
     'client', v_client_c,
     'Family update — ' || coalesce(v_name_c, 'a client') || ', past two weeks',
     'Here is a short update on the past two weeks. All six scheduled visits took place, and the same two caregivers covered them, which has kept the routine steady. '
       'Personal care and medication reminders went as planned, and meals were prepared at each visit. '
       'The team noted a little more fatigue in the afternoons and has passed that to the nurse, who will follow up at the next supervisory visit. '
       'If you have questions, call the office and ask for the care coordinator.',
     jsonb_build_object('consent_scope_required', 'visit_summary', 'period_days', 14, 'visits', 6),
     'Six completed visits in the period and no family update on record for 19 days.',
     0.810, null, v_coord, now() - interval '55 minutes'),

    ('11111111-1111-1111-1111-00000000ab05', v_tenant, 'shift.fill', 'assignment',
     'visit', v_visit,
     'Coverage plan — open visit, four caregivers to offer',
     'Four caregivers are schedulable for this window. In order: two have worked with this client before, and two are nearby with room in their week. '
       'The offer goes to all four at once and the first to accept takes the shift. Two further caregivers were skipped because a required credential has lapsed.',
     jsonb_build_object('ranked', 4, 'blocked', 2, 'first_accept_wins', true, 'visit_id', v_visit),
     'The visit is unassigned and starts within 48 hours. Ranking and eligibility come from the scheduling engine.',
     0.740, '11111111-1111-1111-1111-0000000a1002', v_coord, now() - interval '5 hours'),

    ('11111111-1111-1111-1111-00000000ab06', v_tenant, 'chase.draft', 'message',
     'client', v_client_b,
     'Missed-visit follow-up — ' || coalesce(v_name_b, 'a client'),
     'We are following up on the visit that did not take place yesterday. The office is arranging cover and will confirm the new time today.',
     jsonb_build_object('channel', 'sms', 'exception_kind', 'no_show'),
     'A no-show exception was logged and no follow-up contact is on record.',
     0.690, null, v_coord, now() - interval '1 day')
  on conflict (id) do nothing;

  -- Dispositions: the plan was approved then executed; the missed-visit message was
  -- rejected with a reason (the reason codes are the eval rubric — docs/16 §3.2).
  insert into public.ai_proposal_event
    (id, tenant_id, proposal_id, action, note, edited_body, actor, created_at)
  values
    ('11111111-1111-1111-1111-00000000ac01', v_tenant, '11111111-1111-1111-1111-00000000ab05',
     'approve', 'Order looks right. Sending to all four.', null, v_coord, now() - interval '4 hours'),
    ('11111111-1111-1111-1111-00000000ac02', v_tenant, '11111111-1111-1111-1111-00000000ab05',
     'execute', 'Offers sent; first accept wins.', null, v_coord, now() - interval '4 hours' + interval '3 minutes'),
    ('11111111-1111-1111-1111-00000000ac03', v_tenant, '11111111-1111-1111-1111-00000000ab06',
     'reject', 'The family was called this morning and the visit is already rebooked.', null,
     v_coord, now() - interval '20 hours')
  on conflict (id) do nothing;

  -- ── Clinical early-warning flags (R3) — proposed, an RN disposes ───────────────
  insert into public.clinical_flag
    (id, tenant_id, client_id, kind, severity, summary, evidence, status,
     ai_interaction_id, created_by, created_at)
  values
    ('11111111-1111-1111-1111-00000000cf01', v_tenant, v_client_a, 'condition_trend', 'high',
     'General condition was recorded as declining on the last two visits after a run of stable entries, and both notes mention increased afternoon fatigue.',
     jsonb_build_object(
       'metric', 'general_condition',
       'series', jsonb_build_array('Stable','Stable','Declining','Declining'),
       'window_days', 21,
       'source', 'form_version.structured_fields'),
     'open', '11111111-1111-1111-1111-0000000a1003', v_rn, now() - interval '6 hours'),
    ('11111111-1111-1111-1111-00000000cf02', v_tenant, v_client_b, 'exception_spike', 'medium',
     'Three schedule exceptions in fourteen days, two of them late starts on the same morning route.',
     jsonb_build_object(
       'metric', 'schedule_exception_count',
       'window_days', 14, 'count', 3,
       'kinds', jsonb_build_array('late_start','late_start','reschedule')),
     'open', null, v_rn, now() - interval '2 days'),
    ('11111111-1111-1111-1111-00000000cf03', v_tenant, v_client_c, 'visit_shortfall', 'medium',
     'Delivered visit hours this month are below the hours the plan of care calls for, by roughly a fifth.',
     jsonb_build_object(
       'metric', 'delivered_vs_planned_hours',
       'planned_hours', 40, 'delivered_hours', 31, 'window_days', 30),
     'open', null, v_rn, now() - interval '3 days')
  on conflict (id) do nothing;

  -- ── Intake extraction under review (C6) — varied confidence, partially accepted ─
  insert into public.extraction_job
    (id, tenant_id, kind, source_name, page_count, status, client_id, ai_interaction_id,
     created_by, created_at)
  values
    ('11111111-1111-1111-1111-00000000ec01', v_tenant, 'intake_packet',
     'referral-packet-inbound.pdf', 14, 'extracted', null,
     '11111111-1111-1111-1111-0000000a1004', v_owner, now() - interval '40 minutes')
  on conflict (id) do nothing;

  insert into public.extraction_field
    (id, tenant_id, job_id, field_key, extracted_value, confidence, page_ref,
     accepted_value, accepted, accepted_by, accepted_at)
  values
    ('11111111-1111-1111-1111-00000000ed01', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'client.first_name',     'Harold',                     0.990, 1, 'Harold', true, v_owner, now() - interval '30 minutes'),
    ('11111111-1111-1111-1111-00000000ed02', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'client.last_name',      'Whitfield',                  0.980, 1, 'Whitfield', true, v_owner, now() - interval '30 minutes'),
    ('11111111-1111-1111-1111-00000000ed03', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'client.dob',            '1938-04-11',                 0.940, 1, null, null, null, null),
    ('11111111-1111-1111-1111-00000000ed04', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'client.address_line1',  '812 Sligo Creek Pkwy',       0.870, 2, null, null, null, null),
    ('11111111-1111-1111-1111-00000000ed05', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'client.city',           'Takoma Park',                0.910, 2, null, null, null, null),
    ('11111111-1111-1111-1111-00000000ed06', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'client.primary_phone',  '(301) 555-0148',             0.760, 2, null, null, null, null),
    ('11111111-1111-1111-1111-00000000ed07', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'payer.type',            'medicaid',                   0.930, 3, null, null, null, null),
    ('11111111-1111-1111-1111-00000000ed08', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'payer.member_id',       'MD-4471-88203',              0.540, 3, null, null, null, null),
    ('11111111-1111-1111-1111-00000000ed09', v_tenant, '11111111-1111-1111-1111-00000000ec01',
     'referral.requested_start', '2026-06-15',              0.810, 5, null, null, null, null)
  on conflict (id) do nothing;

  -- ── An agent run, replayable from its steps (Wave 4) ───────────────────────────
  insert into public.agent_task (id, tenant_id, kind, subject_id, status, goal, created_by, created_at)
  values
    ('11111111-1111-1111-1111-00000000aa01', v_tenant, 'shift_fill', v_visit, 'awaiting_approval',
     'Fill the open visit that starts within 48 hours.', v_coord, now() - interval '5 hours')
  on conflict (id) do nothing;

  insert into public.agent_step
    (id, tenant_id, task_id, seq, tool, input_digest, output_digest, status, created_at)
  values
    ('11111111-1111-1111-1111-00000000ae01', v_tenant, '11111111-1111-1111-1111-00000000aa01', 1,
     'rank_fill_candidates', 'visit id + window', '6 candidates ranked, 2 blocked', 'ok',
     now() - interval '5 hours'),
    ('11111111-1111-1111-1111-00000000ae02', v_tenant, '11111111-1111-1111-1111-00000000aa01', 2,
     'assert_schedulable', '6 caregiver ids + window', '4 schedulable, 2 credential blockers', 'ok',
     now() - interval '5 hours' + interval '2 seconds'),
    ('11111111-1111-1111-1111-00000000ae03', v_tenant, '11111111-1111-1111-1111-00000000aa01', 3,
     'draft_outreach', '4 candidates + shift facts', '4 offer drafts, 1 plan', 'ok',
     now() - interval '5 hours' + interval '4 seconds'),
    ('11111111-1111-1111-1111-00000000ae04', v_tenant, '11111111-1111-1111-1111-00000000aa01', 4,
     'await_disposition', 'proposal id', 'waiting on a coordinator', 'running',
     now() - interval '5 hours' + interval '5 seconds')
  on conflict (id) do nothing;

  -- ── One assembled evidence packet (O2). narrative is null on purpose: the packet
  --    is complete and defensible without the model — the index is an accelerant. ──
  insert into public.evidence_packet
    (id, tenant_id, client_id, scope, record_count, manifest, narrative, generated_by, created_at)
  values
    ('11111111-1111-1111-1111-00000000ee01', v_tenant, v_client_a,
     'supervisory_visits.trailing_12_months', 4,
     jsonb_build_object(
       'scope', 'supervisory_visits.trailing_12_months',
       'client_id', v_client_a,
       'assembled_from', jsonb_build_array('form_version','signature','audit_event'),
       'form_versions', 4, 'signatures', 4, 'audit_events', 12,
       'hash_chain', 'verified at assembly time',
       'period', jsonb_build_object('from', (current_date - 365)::text, 'to', current_date::text)),
     null, v_owner, now() - interval '1 day')
  on conflict (id) do nothing;
end $seed$;
