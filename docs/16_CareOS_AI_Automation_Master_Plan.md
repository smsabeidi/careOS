# Doc 16 — CareOS AI Automation Master Plan

Status: Partially ratified — provider ratified as D-013 (2026-08-01); §2.8 staff-lifecycle rows ratified as D-021 (2026-08-04); remaining §7 proposals open
Owner: Head of AI Product
Date: 2026-08-01 (amended 2026-08-04: §2.8 added per D-021)
Cross-references: docs/00 (decision log), docs/07 (schema), docs/08 (API), docs/09 (security/vendor register), docs/10 (frontend), docs/11 (AI implementation spec), docs/15 (build plan), `supabase/migrations/0014_ai_plane.sql`, `supabase/seeds/zz_ai.sql`, `apps/web/src/lib/ai/client.ts`

---

## 1. Executive summary

The thesis of CareOS is that staff give care and the platform runs the office. Every hour a nurse spends typing an assessment, every morning a coordinator spends phoning replacements for an overnight call-out, every week an owner spends assembling survey evidence is an hour taken from clients. The industry evidence says this burden is enormous and quantifiable: CMS's own estimates put a single start-of-care assessment at 57.3 clinician minutes (source: CMS OASIS-E OMB filing via corridorgroup.com), nursing literature puts documentation at 25–40% of clinical time (source: JMIR Nursing 2025; AACN), 51% of home-care agencies now rank scheduling churn as their top operational challenge (source: AxisCare 2026 trends survey), and caregiver turnover of 75% annually (source: Activated Insights 2025 Benchmarking Report) guarantees the churn never stops. Healthcare back-office work is roughly twice the G&A share of other industries, with an estimated $175B/year automatable (source: stellaintl.com).

This codebase is unusually well positioned to absorb that burden, for three reasons that competitors cannot easily copy:

1. **Append-only provenance is already the substrate.** Every form version, signature, visit event, credential event, schedule exception, and AI interaction is an immutable, hash-linked record. AI output enters the system as an `ai_draft` form version with an `ai_interaction_id` foreign key — the provenance path exists in the schema today. No incumbent (WellSky, AlayaCare, Axxess, HHAeXchange, AxisCare) markets verifiable citations, an append-only AI ledger, or surveyor-ready evidence trails; their scribes are trust-me boxes at exactly the moment payers are auto-downcoding claims with weak documentation (source: Cigna policy, Oct 2025, via homehealthcarenews.com).
2. **Deterministic engines already answer the questions AI should never answer.** Credential expiry, COMAR cadence obligations, and schedulability (`app.assert_schedulable`) are computed in SQL. The AI layer narrates, prioritizes, and drafts around engine outputs; it never computes a deadline, an eligibility verdict, or a dollar (invariant 13). Making this boundary explicit is itself a sellable trust posture no competitor articulates.
3. **Tiered autonomy is DB-enforced, not a slide.** The `ai_capability` registry with T0–T3 tiers, where T2/T3 require a licensed human disposer, is live in migration 0014. AlayaCare's AlayaFlow auto-resolves EVV verification failures with no disposer; that governance gap is our attack surface, and our survey-defense story.

The competitive whitespace this plan claims: compliance-grade AI provenance, governed autonomy, the automated daily huddle (no vendor ships one; LTC literature shows formalized huddles measurably reduce staff moral distress — source: PMC 2023/2024 LTC huddle studies), and documentation AI for private-duty/Medicaid personal care (the entire scribe race — WellSky Scribe, Netsmart Bells, HCHB Curate — is skilled home health/OASIS; our RSA/COMAR beachhead has none).

The plan below maps 41 workflows, assigns each a tier and an OpenAI primitive, sequences them into six waves, and shows the unit economics close: full deployment for a 100-staff, 300-client agency costs roughly $130–300/month in model spend against an estimated 230–280 staff-hours/week returned.

---

## 2. The automation map

Assumptions for impact scoring: a 100-staff agency (~80 caregivers, 8 RNs, ~6 office/coordination staff, owner), ~300 active clients, ~1,500 visits/week. Impact is estimated hours saved per week for that agency, stated honestly — ranges reflect adoption and note-mix uncertainty. Build size: S (≤1 sprint), M (1–2 sprints), L (2+ sprints or new infrastructure).

AI treatment legend: **Auto (T0/T1)** = runs without per-item approval (notify/log, or low-stakes act-with-audit) · **Draft+approve (T2)** = AI proposes, licensed human disposes · **Insight** = surfaced signal only, no action · **Det+narrate** = deterministic engine computes, LLM only explains/prioritizes in plain language.

### 2.1 Cross-cutting / platform

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| X1 | Policy Q&A Brain (**built v1**) | Staff phone coordinator/compliance lead for policy answers; abstains bounce back to humans | Auto (T1), cite-or-abstain | Responses API, structured outputs | `knowledge_document` corpus, `ai_interaction` ledger | 3 | shipped |
| X2 | Brain retrieval upgrade: embeddings + hybrid RRF | Keyword-RAG misses paraphrased questions → avoidable abstains | Auto (T1) | text-embedding-3-small + pgvector (query embedded per-user, search under RLS); Batch for corpus backfill | `knowledge_document` → `knowledge_chunk` | 2 (via lower abstain rate) | M |
| X3 | Brain live-data tools (`get_client_summary`, `get_obligations`) | "Is Mrs. K's assessment due?" = open three screens or call the office | Auto (T1), read-only tools executed under requester's JWT | Responses API strict tool calling | client, cadence_obligation_status, care_team_assignment | 3 | M |
| X4 | NL analytics over the tenant ("clients with 2+ missed visits this month") | Owner/coordinator exports nothing — the query is simply not askable today | Auto (T1), read-only governed query templates; grammar-constrained tool args | Strict tools + Lark/regex grammars (never free SQL) | visit, schedule_exception, client, census aggregates | 4 | L |
| X5 | **Daily Huddle Brief** (per-role morning operations brief: overnight call-outs, at-risk clients, coverage gaps, overdue obligations, expiring credentials, yesterday's exceptions, unsigned queue) | The coordinator morning scramble — "several hours each day" industry-wide (source: rosemarksystem.com); owner reads five panels and chases by phone; no formal huddle exists in home care | Auto (T0 generate + T1 notify); every item deep-links; all facts from deterministic queries, LLM narrates and ranks only | Batch API nightly (50% off) on gpt-5.6-terra; per-role render | schedule_exception, visit_event, cadence_obligation_status, credential_expiry, signature gaps, attention-panel queries | 20 | M |
| X6 | Knowledge-gap capture from Brain abstains | Nobody mines abstains; corpus gaps persist | Auto (T0) cluster + weekly digest; curated answers stay human-authored (FR-AI-092) | Batch + embeddings clustering | `ai_interaction` status=abstained | 1 | S |
| X7 | AI usage/cost self-digest | Owner reads raw ledger rows in /office/ai | Auto (T0) weekly rollup with anomaly flags | Batch | `ai_interaction` tokens/cost/tier/status | 0.5 | S |

### 2.2 Owner / admin

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| O1 | Attention triage → dispatch (turn AttentionPanel reads into drafted nudges/assignments) | Owner reads ranked exceptions, then chases each human by phone/text; no in-app nudge | Draft+approve (T2) for outbound messages; Auto (T1) for in-app task creation | gpt-5.6-luna + structured outputs | form_instance.status, client.status, staleness signals | 5 | M |
| O2 | Compliance evidence packet assembly / surveyor "show me" | Survey prep = continuous-readiness binder + episodic surge of screenshots; no export exists | Auto (T1) deterministic bundle assembly (records, signatures, hash chain, audit trail) + T0 narrative index | Structured outputs for the index; assembly itself is not AI | signature, form_version chains, audit_event, cadence heartbeat | 4 (amortized) | M |
| O3 | Census / ops briefing narrative | Read-only panels; growth decisions offline | Insight (folded into huddle brief, owner edition) | Batch + terra | client status funnel, admissions trend, payer/language mix | 2 | S |
| O4 | Coverage-gap staffing forecast ("which caregivers become unschedulable in 30d and which clients that strands") | Owner spots gaps visually; no forward view | Det+narrate (expiry engine computes; LLM writes the impact story) | luna, structured outputs | credential_expiry, care_team_assignment, visit forward schedule | 3 | S |
| O5 | Audit-prep drill (mock-survey Q&A over the tenant's own records) | Mock surveys are consultant-run; readiness is a binder doctrine (source: mcbeeassociates.com) | Auto (T1): Brain grounded on own records + policy corpus, citations resolve to record IDs | Responses API tools + embeddings | knowledge_document + evidence bundles (O2) | 2 | M |

### 2.3 Coordinator

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| C1 | **Open-shift fill agent** (call-out → ranked candidates → outreach plan → SMS offers, first-accept-wins) | Coordinator phones caregivers one by one; scheduling is the industry's #1 pain (51%) and its #1 AI ask (64%) (source: axiscare.com 2026 trends) | Draft+approve (T2): coordinator approves the outreach plan via `app.approve_ai_action`; candidate eligibility is `app.assert_schedulable` — deterministic, never LLM | Responses API + strict tools; luna for drafting; minimized Twilio payloads (IDs travel, content refetched) | assert_schedulable blockers, week hours, prior-assignment familiarity, language match, city, vacatedBy context | 18 | L |
| C2 | No-show / call-out prediction | Every call-out is a surprise; replacement hunt starts at zero | Insight first (heuristic risk score from exception history); classical ML (logistic/GBM) later per spec — explicitly not LLM | None initially; features from SQL | schedule_exception rates, visit_event punctuality, shift patterns | 4 | M |
| C3 | Schedule exception digest + drafted chases (credential-lapsed visit, late note >24h) | Coordinator reads exception list, chases by phone/text | Draft+approve (T2) messages; Auto (T1) detection | luna + structured outputs | exception kind/detail, credential_expiry | 4 | S |
| C4 | Credential renewal chase (drafted reminders + document re-verification) | Filter, text caregiver, collect doc, verify — all off-system; a 40-caregiver agency handles 200+ expiry events/yr (source: inmyteam.com); lapses block scheduling and payment | Draft+approve (T2) outreach, personalized by renewal-lead-time history from `credential_event`; vision extraction of returned doc (T2, human verifies; expiry math stays in the SQL engine) | Vision `detail:"original"` + strict schema; luna drafting | credential_expiry buckets, credential_event behavior, blocks_scheduling | 6 | M |
| C5 | COMAR obligation cure (Compliance-Watch agent) | Coordinator filters overdue/at-risk, coordinates the cure by phone, starts the satisfying form by hand | Auto (T0 notify / T1 open remediation task); Draft+approve (T2) for booking/outreach drafts; satisfying template suggestion is deterministic (`satisfied_by_template_key`); explanations cite `comar_source_ref` → knowledge_document | luna; Batch nightly sweep | cadence_obligation_status (severity × days_until_due), heartbeat series | 7 | M |
| C6 | **Intake packet → chart** (classify → extract → validate → side-by-side review → commit) | ~8–12 min data entry per referral, 5–8 hrs/wk at 30–50 referrals/wk (source: worldviewltd.com); packet review claims ~70 min (weak source, automationedge.com) | Draft+approve (T2), never auto-commit; per-field confidence, two-pass self-check; commits carry `ai_draft` provenance | Vision `detail:"original"` + strict per-doc-type schemas + detectable refusal; small-model classify on luna, extraction on terra | uploaded docs; dedup against client roster | 10 | L |
| C7 | Referral triage + first-response drafting | Speed-to-respond drives conversion — one provider doubled conversion 20.7%→44.8% with automated referral handling (source: therowanreport.com) | Auto (T1) classify/urgency-rank inbound; Draft+approve (T2) response drafts | luna structured outputs | inquiry pipeline (client.status), extraction output (C6) | 5 + revenue-coupled | M |
| C8 | Stale-draft and missing-signature chase | Coordinator scans forms backlog, messages authors out-of-band | Auto (T1) detect; Draft+approve (T2) drafted nudge to author | luna | form_instance status/timestamps, signature × requires_signature_roles | 3 | S |
| C9 | New-hire onboarding checklist automation | Hiring/onboarding runs outside the system; missing docs discovered at scheduling time | Det checklist (rules) + Draft+approve (T2) welcome/doc-request drafts | luna | user_role, credential requirements per role, credential_event | 3 | M |
| C10 | Migration scorecard (per-client/per-employee COMAR completeness at cutover) | Manual chart audits during agency migration | Det checklist fed by C6/C4 extraction; gaps → remediation tasks (T1) | Vision + structured outputs (reuses intake pipeline) | imported docs, cadence rules | 2 (episodic, launch-critical) | M |

### 2.4 RN / clinical

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| R1 | **Ambient supervisory-visit drafting** (45/90/120-day visits recorded → diarized transcript → structured note draft) | RN documents each home visit by hand after the fact; ~25 supervisory visits/wk at this census | Draft+approve (T2): per-section accept/edit/reject in the clinical editor; provenance label persists ("Drafted with AI · reviewed & signed by …") | gpt-4o-transcribe-diarize (speaker labels) → terra strict-schema post-pass | supervisory_visit cadence, care_plan context, template schema | 9 | M |
| R2 | Care-plan review drafts from visit-note deltas | Plan revision has no UI; review_due_on approaches with no draft to react to | Draft+approve (T2): diff latest assessment/visit narratives vs current plan goals; propose revisions as new version | terra + structured outputs | care_plan(+items) lineage, form_version clinical fields, review_due_on | 5 | M |
| R3 | Clinical early-warning flags (condition/mood trajectory × exception spikes × duration shortfalls) | Deterioration noticed visit-by-visit, not longitudinally | Draft+approve (T2): flag proposed, RN disposes; never auto-escalates | luna over deterministic feature series | form_version structured fields (general_condition, mood), schedule_exception, visit_event durations | 4 | M |
| R4 | Signature queue prioritization | Queue ordered by updated_at only; RN guesses what is compliance-urgent | Det+narrate: rank by obligation due-date × age; LLM writes the one-line why | luna | unsigned detection join, cadence_obligation_status | 2 | S |
| R5 | Documentation-QA suggestions in the forms runtime (FR-AI-012) | Errors caught at finalize or by surveyor | Advisory only — dismissible, never blockers | luna structured outputs, cached-input pricing for template context | in-progress form content, template schema | 4 | M |
| R6 | Incident report drafting from voice (FR-AI-044) | Incident narratives typed under stress, often late | Draft+approve (T2) | gpt-transcribe → luna strict schema | incident template, visit context | 2 | S |

### 2.5 Caregiver / field

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| G1 | **Voice-to-visit-note** (speak 30–60s → structured note draft → per-section confirm) | Notes typed by hand on phones after each visit; documentation consumes 25–40% of clinical time industry-wide (source: JMIR Nursing 2025); late notes flagged only on the coordinator's board | Draft+approve (T2): author reviews/edits each section, then saves — draft lands as `ai_draft` form_version with `ai_interaction_id` provenance | gpt-transcribe ($0.0045/min, `keywords` from PHI-allowlisted vocab) → luna strict-schema structuring; offline record → batch on reconnect | visit context (auto-links note↔visit — closes gap 33), template schema, prior note structure | 80–120 (est. 90) | M |
| G2 | Missing clock-out detection + correction prompt | Forgot-to-clock = coordinator phone call; no correction UI | Auto (T1) detect + prompt; the correction itself is human with mandatory reason (EVV integrity) | Rules + luna for the plain-language prompt | visit_event pairs vs scheduled_end | 3 | S |
| G3 | Day-sheet brief (plain-language day plan, Spanish where primary) | Caregiver reads raw visit list | Auto (T0) | Batch nightly, luna | visit, client (address, primary_language), care_team_assignment | 2 | S |
| G4 | Late-note self-nudge (before it becomes a coordinator chase) | Silence until the exception board flags >24h | Auto (T1) | Rules + luna | form_instance drafts vs visit_event clock_out | 2 | S |

### 2.6 Family

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| F1 | Family update drafts from visit/supervisory data | No authoring UI exists; staff drafting is fully manual and mostly doesn't happen; families' top need is disruption-time communication (source: caretime.us) | Draft+approve (T2), hard-gated on `consent.scope` (reuse `on_family_link`); staff approves before anything is visible | luna structured outputs | family_update, form_version narratives, visit events, consent | 5 | M |
| F2 | Per-recipient translation (≈15% Spanish-speaking families) | Bilingual staff member translates ad hoc, or it doesn't happen | Draft+approve (T2); care-critical content human-verified (FR-AI-063) | luna | client.primary_language, F1 drafts | 2 | S |
| F3 | Communication-cadence detection ("family not updated in N weeks") | Invisible until a complaint call | Auto (T1) surface to coordinator | Rules + Batch | family_update recency × consent coverage | 1 | S |

### 2.7 Billing / EVV (deterministic-first domain)

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| B1 | EVV exception pre-adjudication (clock pair vs schedule vs auth window reconciliation, drafted fix narratives) | EVV↔billing↔auth misalignment is the biggest claims-error source (source: vertexsystems.com); 11.8% first-pass denial rate industry-wide, $25–181 rework per denial (source: Experian State of Claims 2025; aptarro.com) | Det rules classify every exception; Draft+approve (T2) for the documented correction narrative (manual corrections require reasons); billing export stays gated to EVV-verified visits — deterministic, per FR-AI-070 | luna for narratives only | visit_event, visit windows, schedule_exception, method=manual anomalies | 6 | M |
| B2 | Denial-risk pre-check before claim export | Errors surface ~60 days later as denials | Det completeness gates (signatures, EVV pair, note finalized); Insight narration of gaps | luna | signature completeness, visit_event, form status | 3 | M |

### 2.8 Staff lifecycle (H)

Ratified by D-021 (2026-08-04). The employee spine these rows ride on landed as migrations 0027–0033 (outbox, employee, documents, invitations, admin RPCs, revocation saga, onboarding engine); the agent identities that will run them land with 0034–0035 under D-020. The H rows deliberately **reuse existing machinery instead of duplicating rows**: C9 (onboarding checklist), C4 (credential chase + document extraction), C5 (obligation sweep), C1 (outreach/offer plumbing), C3/C8 (chase drafting), O4 (coverage-impact narration), X5 (huddle surfacing). What H adds is the lifecycle triggers and approval lanes, not new engines. Triggers are outbox events (0027), not polling.

| # | Workflow | Manual cost today | AI treatment | OpenAI primitive | Data it feeds on | Impact (hrs/wk) | Size |
|---|---|---|---|---|---|---|---|
| H1 | Hiring pipeline (candidate → invite → complete employee file) | Hiring runs off-system (texts, spreadsheets); at 75% annual caregiver turnover (§1) a 100-staff agency hires ~1–2/wk forever; file gaps surface at scheduling time | Det gate: `employee_file_status` (pure SQL) is the readiness verdict; Draft+approve (T2) for LLM-drafted outreach only — Coordinator disposes drafts, **Owner disposes the hire itself** | luna structured outputs (drafting only) | identity.invited / candidate outbox events (0027, 0030), employee_file_status (0033), credential requirements per role (reuses C9, C4) | 3 | M |
| H2 | Offboarding | Separation is a same-day scramble across accounts, schedules, and paperwork; every missed step is an access-revocation finding | The revocation saga (0032) is fully deterministic; Draft+approve (T2) for separation comms + file-closure narrative, Owner lane. **The system never proposes termination** — separation is always human-initiated; automation begins after the human act | luna (narratives only; reuses C3/C8 chase drafting) | identity.separated outbox event (0032), revocation_checklist, employee file, O4 coverage impact | 1 | S |
| H3 | In-service / training-hours tracking | COMAR in-service hours live on paper or spreadsheets; shortfalls surface at renewal or survey time | Det+narrate: hours ledger = `credential(category='training')` + staff-side cadence obligations (deterministic); Draft+approve (T2) reminder drafts; RN/Coordinator lane | luna; Batch nightly sweep (reuses C5's obligation machinery, surfaces via X5) | credential(category='training'), staff-side cadence_obligation_status, credential_event | 2 | S |
| H4 | Background-check orchestration | CHRC status chased by phone/fax; pathway ambiguity stalls hires | Det rules for chasing and status (stale `onboarding_item(chrc_background)` trigger); Draft+approve (T2) chase drafts. **Adjudication is a permanent human anti-capability (FR-AI-052)** — enforced structurally by the `verified_by` FK + human-verifier trigger (0033), not by prompt. The Maryland CHRC two-pathway question (Health-General §19-1902 vs Board of Nursing) stays an HR-advisor item, never auto-resolved | luna (chase drafts only; C8 pattern); Checkr integration gated on V8 | onboarding_item(chrc_background) staleness, employee_file_status, advisor_note | 1 | M |

**Estimated total: ~235–285 staff-hours/week returned** for a 100-staff agency at full deployment (~6–7% of total paid hours), dominated by voice-to-note. Roughly 60% of mapped items are drafting/chasing workflows where the data already sits in-system and the human glue is a phone/text loop.

---

## 3. Foundation model strategy

### 3.1 The honest architecture: RAG + structured outputs + evals first

Fine-tuning is for behavior; retrieval is for knowledge; almost everything in §2 is a knowledge-plus-format problem. The strategy, in OpenAI's own recommended order (collect data → build evals → iterate prompt + RAG → only then distill/fine-tune):

**Model tiering (registry-controlled, per capability).** Bump the `client.ts` default from gpt-4o-mini (now legacy-tier) to **gpt-5.6-luna** ($0.20/$1.20 per 1M — near-parity cost, current generation, 1.05M context). **gpt-5.6-terra** ($2/$12) for huddle synthesis, intake extraction, care-plan reasoning, and Brain escalation. Model IDs live in the `ai_capability` registry so every capability pins its own model and upgrades are pointer flips with eval gates, not code changes. Cached-input pricing ($0.02/1M on luna) rewards stable registry-versioned system prompts.

**Structured outputs everywhere.** Every extraction and drafting capability emits `strict: true` JSON schemas — guaranteed adherence plus a programmatically detectable `refusal` field that maps directly onto our cite-or-abstain doctrine. Tool calls use strict mode; deterministic-format outputs (enums, CAREOS_* codes) use grammar-constrained custom tools. Deadlines, cadences, eligibility, and money never enter a prompt as questions — they arrive as facts computed by SQL (invariant 13).

**Embeddings retrieval upgrade.** Replace keyword-RAG with text-embedding-3-small ($0.02/1M) + pgvector, hybrid FTS/vector RRF per Doc 11. The query is embedded, then the search executes under the requester's RLS — retrieval runs as the user, always (invariant 9). Corpus backfill via Batch at half price.

**Batch API is the nightly backbone.** Huddle briefs, compliance sweeps, digests, embedding backfills, and eval runs ride Batch at 50% off. PHI caveat: Batch rides the Files API and is not ZDR-eligible — nightly PHI batches run under the BAA/Safety-Retention regime only after the BAA is executed; until then, nightly jobs consume de-identified engine outputs and IDs only. Flex tier covers non-urgent synchronous jobs without JSONL plumbing.

**Voice.** gpt-transcribe ($0.0045/min, streaming partials, domain `keywords` limited to the capability's PHI allowlist) → luna strict-schema post-pass, human confirmation per section (T2). gpt-4o-transcribe-diarize for supervisory visits (speaker labels). Realtime API (gpt-realtime-2.1-mini) is deferred — at ~$0.30–0.60/min it is a premium path with no current workload that justifies it. Note: Doc 11 named Deepgram for STT; consolidating on OpenAI transcription simplifies the vendor register to one BAA — this is a vendor-register change requiring a docs/09 §6 entry (§7).

**Vision.** Credential documents, intake packets, paper forms via image input with `detail: "original"` (explicitly recommended for OCR/small text) + strict schemas + mandatory human review (T2). Expiry math and eligibility stay in the SQL engines.

### 3.2 The data flywheel: every human approval is a training label

The approvals inbox is a free RLHF-style labeler, and this is the actual moat — competitors can buy the same models; they cannot buy two years of licensed-human dispositions over real agency operations. Capture losslessly, starting now:

1. **Extraction corrections**: model output + human-corrected final + field-level diff, keyed to prompt-registry version + model ID (the `ai_interaction` ledger already carries the keys; add the disposition linkage).
2. **Accept/edit/reject dispositions** from `app.approve_ai_action`: (post-minimizer input, chosen output, rejected output) — literally the DPO training format.
3. **Pre/post-edit drafts** (huddle summaries, family updates) — natural SFT pairs for tone.
4. **Rejection reason codes** (wrong / tone / unsafe / incomplete) — cheap to capture now, impossible to backfill, and they double as eval rubrics.

Rule: no pair is useful unless it answers "which template version and model produced this?" — enforce registry keying on correction records from day one.

### 3.3 Fine-tuning: later, narrow, never on PHI

Fine-tune only when evals prove a prompt ceiling on a stable, high-volume format task (visit-note field extraction is the likely first candidate, at thousands of verified pairs). GPT-5.x is not fine-tunable; the tunable line is gpt-4.1-mini/nano (SFT/DPO) — i.e., fine-tuning means distilling a big-model prompt into a small student via Stored Completions, for cost/latency, evaluated against the same golden set and shipped behind the same registry/canary machinery as a prompt change. Constraints that are non-negotiable: fine-tuning endpoints sit outside ZDR (training files and model state retained until deleted), so any training upload is the highest class of data egress — **synthetic (Meadowbrook) first, Expert-Determination de-identified second, raw PHI never**. Never fine-tune the Brain: facts change, fine-tunes freeze them, and a tuned model cannot cite what it absorbed. `store:true` distillation capture runs only on synthetic traffic.

### 3.4 Eval harness: in-repo, CI-gated

OpenAI's hosted Evals platform is deprecated (read-only Oct 31 2026, shutdown Nov 30 2026) — evals live in-repo (Promptfoo or bespoke harness) against the Meadowbrook seed, exactly matching the existing invariant that eval gates live in CI. Golden sets per capability in four buckets — production sample, edge cases, adversarial, failure replays — version-controlled, 20–50 cases at launch growing toward hundreds; per-PR gate under ~10 minutes, full suite nightly via Batch. Layered evaluation, deterministic first: schema validity, citation resolution, and date/number exactness are code checks; LLM-as-judge only above that layer, cross-family where used, calibrated against human review — and a judge score never gates a T2/T3 disposition (that is the licensed human's job). Retained thresholds: extraction P/R ≥0.97 on critical fields, Brain groundedness ≥0.95, citation validity 100%. Production loop: score a 5–10% live sample for drift; every production failure becomes a golden-set case; disposition data doubles as free continuous eval signal.

### 3.5 The PHI line

Sequence, strictly: (1) today — PHI-minimizer keeps model inputs de-identified/ID-based; the synthetic Meadowbrook universe is the only "realistic" data any non-production environment or eval sees. (2) Execute the **OpenAI BAA + Safety Retention provisioning** (API BAAs are available; self-serve tiers are not BAA-eligible) and register it in docs/09 §6 — this is the prerequisite for any real PHI in prompts. (3) Per-workload lane choice: ZDR-eligible endpoints (responses, embeddings, transcription, realtime) for synchronous PHI paths where retention is unacceptable; BAA/Safety-Retention lane for Batch and Files. (4) Allowlist PHI-minimizer + redaction manifest + planted-PHI canary suite (Doc 11) ship before the first PHI-bearing capability, not after. Abuse-monitoring retention (≤30 days) and Modified Abuse Monitoring are noted in the vendor-register entry.

**Divergence to ratify:** Doc 11 mandates Anthropic-BAA-direct via Vercel AI SDK; the built v1 and this plan run on OpenAI. This is a ratified-spec conflict and must not stand silently — §7 proposes the decision-log entry (either ratify OpenAI as primary with the BAA path above, or plan the provider migration; the chokepoint architecture of `client.ts` makes either cheap). *Resolved: ratified as D-013 (docs/00 §3, 2026-08-01) — OpenAI primary, STT consolidated on OpenAI transcription.*

---

## 4. Sequenced build waves

Ordering logic: Wave 0 is the governance floor everything else stands on; Wave 1 maximizes wow-per-risk (read-only synthesis + author-reviewed drafting — no outbound side effects); outbound-message capabilities wait for the Approvals Inbox in Wave 2; agents with real-world side effects (SMS offers) wait for the durable agent runtime in Wave 4.

**Wave 0 — Governance floor (2 weeks, enabler).**
Model bump gpt-4o-mini → gpt-5.6-luna in the registry; `ai_prompt_template` versioned registry; `ai_capability_flag` kill switches; allowlist PHI-minimizer + redaction manifest + planted-PHI canary suite; in-repo eval harness with first golden sets, wired as a merge gate; `ai_budget` caps; BAA execution started; disposition-capture schema (§3.2) migrated. Demo moment: flip a kill switch and watch a capability refuse politely; show the ledger row for every call.

**Wave 1 — The morning that runs itself (S6-scale).**
Capabilities: **Daily Huddle Brief** (X5, owner + coordinator + RN editions, nightly Batch) · **voice-to-visit-note** (G1, with note↔visit auto-linkage) · **Brain embeddings upgrade + live-data tools** (X2, X3) · day-sheet brief (G3) · signature-queue prioritization (R4). Tiers: T0/T1 synthesis + T2 author-reviewed drafting (disposer = the author, inline in the forms runtime via `ai_draft` versions — no inbox needed yet). Demo moment: 7:55am, the owner opens /exec and the huddle brief is waiting — overnight call-out, two at-risk obligations, one expiring credential, each one tap from action; then a caregiver speaks for 30 seconds and watches a structured, provenance-labeled note draft assemble itself.

**Wave 2 — The chase engine (S7-scale).**
Ships the **Approvals Inbox UI** + full HITL state machine (`proposed→pending_review→approved/edited/rejected→executed`) + `app.approve_ai_action`. Capabilities: credential renewal chase (C4 drafting half) · stale-draft/signature nudges (C8, O1) · schedule-exception chases (C3) · Compliance-Watch v1 (C5: T0/T1 nudges + remediation tasks) · family updates + translation (F1, F2, F3 — consent-gated) · missing clock-out prompts (G2) · late-note self-nudge (G4) · knowledge-gap capture (X6). Demo moment: coordinator opens the inbox, reviews 12 drafted chase messages with reasons attached, approves them in 90 seconds; every send is a ledger row.

**Wave 3 — Paper becomes chart (E11).**
Capabilities: intake packet extraction pipeline (C6: classify → vision extract → validate → side-by-side review, never auto-commit) · referral triage + first-response drafts (C7) · credential document extraction (C4 vision half) · new-hire onboarding checklists (C9) · migration scorecard (C10 — the sales-demo weapon for agency cutover per D-009). Demo moment: a 30-page faxed referral packet becomes a reviewed, provenance-stamped chart in under five minutes, every field showing its confidence and its human approver.

**Wave 4 — The coordination agent (Phase 2 entry).**
Ships the durable `agent_task`/`agent_step` runtime with tool allowlists, step caps, and the red-team CI suite. Capabilities: open-shift fill agent (C1: callout → ranked schedulable candidates → approved outreach plan → minimized Twilio SMS → first-accept-wins) · no-show/call-out heuristic scoring (C2) · EVV exception pre-adjudication (B1) · denial-risk pre-check (B2). Demo moment: a 6:02am call-out; by 6:04 the coordinator has an approved outreach plan; by 6:20 the shift is filled, and the entire causal chain — prediction, ranking, blockers, offers, acceptance — is replayable from the audit ledger.

**Wave 5 — Clinical depth and the glass office (Phase 2).**
Capabilities: ambient supervisory-visit drafting (R1, diarized) · care-plan review drafts (R2) · clinical early-warning flags (R3) · documentation-QA advisories (R5) · incident-report voice drafting (R6) · NL analytics (X4) · evidence packet assembly + audit-prep drill (O2, O5) · census narrative (O3, O4). Demo moment: a surveyor asks "show me supervisory visits for this client"; the owner clicks once and hands over a hash-verified evidence packet with an AI-written plain-language index.

**Wave 6 — The flywheel pays out (Phase 3, conditional on volume).**
First distillation/SFT candidate (visit-note extraction) once one task crosses ~thousands of verified pairs and evals plateau under prompting; DPO for drafting tone from disposition pairs; classical-ML matching/churn models (explicitly not LLM); cost-optimization pass (cheap-first cascade, caching). Demo moment: the same extraction quality at a fraction of the unit cost, proven by the same golden set, shipped as a registry pointer flip.

---

## 5. Cost model

Per-agency monthly OpenAI spend at full deployment (100 staff, 300 clients, ~1,500 visits/week ≈ 6,500/month). Standard-tier pricing; Batch rows already at 50% off. Token figures are per-item averages including system prompt (cached-input discounts not credited — treat as headroom).

| Workload | Monthly volume | Model / lane | Est. tokens or minutes per item | Est. cost/mo |
|---|---|---|---|---|
| Voice-to-note: transcription | 4,500 notes (70% adoption) × 1.5 min | gpt-transcribe | 6,750 min × $0.0045 | $30 |
| Voice-to-note: structuring | 4,500 | luna, sync | 2K in / 0.6K out | $5 |
| Daily huddle briefs | ~300 (roles × days + coordinator variants) | terra, Batch | 8K in / 1.5K out | $5 |
| Brain Q&A (incl. 10% terra escalation) | 1,200 questions | luna → terra | 2.5K in / 0.5K out | $3 |
| Intake extraction (two-pass) | 100 packets × ~25 pages | terra vision, sync | ~30K in / 2K out per packet, ×2 passes | $19 |
| Credential doc extraction | ~35 docs | luna vision | small | $1 |
| Supervisory-visit transcription | ~110 visits × 35 min | transcribe-diarize | 3,850 min × $0.006 | $23 |
| Supervisory-visit structuring | ~110 | terra | 7K in / 1.5K out | $4 |
| Chase/nudge/exception drafts | ~1,000 messages | luna | tiny | $1 |
| Family updates + translation | ~300 | luna | 3K in / 0.8K out | $2 |
| Care-plan review drafts | ~120 | terra | 10K in / 2K out | $5 |
| NL analytics queries | ~600 | terra + tools | 4K in / 0.6K out | $9 |
| Embeddings (queries + corpus deltas) | — | 3-small | — | <$1 |
| EVV narratives, digests, misc | — | luna, Batch | — | $5 |
| Nightly eval suite (synthetic) | — | Batch | budgeted | $15 |
| **Subtotal** | | | | **~$128** |
| **With 2.3x safety factor** (retries, prompt growth, adoption spikes, terra drift) | | | | **~$300 ceiling** |

Gross-margin sanity: ~$130–300/month is **under $1 per client per month** of model COGS. Against plausible pricing of $10–15/client/month (~$3,000–4,500 MRR for this agency), AI COGS is 3–10% of revenue — comfortably inside SaaS gross-margin norms, with three untapped levers (cached-input pricing, Flex tier, Wave-6 distillation) before pricing pressure ever forces the issue. Budget enforcement is per-capability via `ai_budget` caps with kill-switch degradation, and the X7 digest keeps the owner's actual ledger spend visible.

---

## 6. Risks and guardrails

**Hallucination containment.** Cite-or-abstain everywhere a claim is made: Brain citations must resolve (100% validity gate); compliance explanations cite `comar_source_ref`; evidence indexes cite record IDs. Structured outputs with `strict: true` plus schema validation at the boundary; the detectable `refusal` field routes to abstain paths, never to silent degradation. Deterministic facts are injected, never asked: no model is ever asked "when is this due" or "is this caregiver eligible" — the engine answer travels in the prompt as ground truth. Layered eval gates (deterministic checks before judge calls) hold the line in CI.

**Tier enforcement.** T2/T3 human-disposer requirements are enforced in Postgres, not in application politeness — there is no code path that executes a gated capability without a disposition row, and the red-team CI suite (Wave 4) attacks exactly that. Anti-capabilities stay anti: background-check adjudication is always human (FR-AI-052); billing export is deterministically gated to EVV-verified visits (FR-AI-070); geofence exceptions record and flag but never block care (FR-AI-032). AlayaFlow's auto-resolution of verification failures is the cautionary tale, not the benchmark.

**Blast-radius controls.** Per-capability kill switches (`ai_capability_flag`), budget caps with graceful degradation, 10% canary rollouts, and a provider-down matrix in which every AI surface has a manual path — the huddle brief degrades to the live panels, voice notes degrade to typing, the fill agent degrades to the ranked list the coordinator already has. AI is an accelerant on CareOS, never a dependency for care delivery.

**PHI containment.** Allowlist minimizer + redaction manifest + planted-PHI canaries precede any PHI-bearing capability; IDs travel and content is refetched under RLS; retrieval executes as the requester; no PHI in Batch until the BAA/Safety-Retention lane is live; training uploads are synthetic-or-de-identified only, forever (§3.3, §3.5).

**The "simple" mandate.** Field staff never see a prompt box. The product surface of this entire plan is buttons and briefs: a huddle brief that is just the morning page, a microphone button that is just "speak your note," an inbox where every item is approve/edit/reject with a stated reason. Zero-config defaults per role; the only chat surface is the Brain, and it lives in the office, not in a caregiver's hand in a client's basement. Plain-language voice per docs/10 on every AI output: what happened, what is saved, what to do next. This is also the adoption defense — the HHCN Dec 2025 survey found integration and training burden are what stall agency AI adoption; a brief you read and a button you press require no training.

**Trust and market risks.** Payer scrutiny of AI-assisted documentation is rising (Cigna downcoding, Oct 2025) — our counter is provenance: every AI-touched record carries its `ai_interaction` lineage, human disposer, and hash chain, which converts "did AI write this?" from a liability question into a demonstrable audit answer. Ambient-scribe evidence is thin industry-wide (JMIR Oct 2025: 6 of 1,400+ studies met real-world-evidence criteria) — we do not market time-savings claims we have not measured in our own ledger; the X7 telemetry and disposition data let us publish real numbers instead.

---

## 7. Proposed decision-log entries (docs/00 §3)

Status of this list: item 1 is **ratified** (D-013); the §2.8 staff-lifecycle rows this doc did not originally map were proposed and ratified separately as **D-021** (2026-08-04), alongside **D-020** (machine AAL2 — the agent-identity basis the H rows and every agent-run capability in §2 execute under). Items 2–5 remain open proposals.

1. ~~**D-0XX Provider ratification.**~~ **Ratified as D-013 (2026-08-01):** OpenAI is the primary model provider with BAA + Safety Retention + per-workload ZDR lanes; STT consolidated on OpenAI transcription in place of Doc 11's Deepgram. Still pending from that entry: the docs/09 §6 vendor-register amendment and Doc 11 provider-section updates.
2. **D-0XX Doc 05 reconstruction.** The AI thesis document (FR-AI-* catalog) is absent from the repo; this document plus Doc 11 cross-references are the recovered source of record until Doc 05 is restored or this doc is ratified as its successor.
3. **D-0XX Client geocoding.** GPS/geofence anomaly detection (B1, G2 adjacencies) requires stored client geocodes; client address is text-only today. Additive column + geocoding step — new external data flow, needs vendor-register review.
4. **D-0XX Disposition capture schema.** Ratify the §3.2 correction/disposition linkage (extraction diffs, accept/reject pairs, reason codes) as an append-only extension of the AI plane, migrated in Wave 0.
5. **D-0XX Obligation waiver RPC** (noted unbuilt) — required before Compliance-Watch can represent waived state truthfully.

---

*Every capability in this plan operates under the standing invariants: AI proposes and a licensed human disposes for anything clinical, compliance-final, or adverse; deterministic questions get deterministic answers; retrieval runs as the user; every call is a ledger row; and nothing ships without its eval gate. Staff give care. The platform runs the office.*
