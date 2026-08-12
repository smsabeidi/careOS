# CareOS — Marketing Website PRD

**Audience:** Web design & build team (external) · **Owner:** Product/Founder · **Version:** 1.0 · **Date:** 2026-08-05
**Sources:** Spec corpus `docs/00`–`docs/16` (this PRD is derived from ratified specs; nothing here is invented). Where a claim needs verification before it can go public, it is flagged inline and collected in §15.

> **Purpose.** Everything the website team needs to design and write the CareOS marketing site: what the product is, who it's for, every feature worth selling, the differentiators, the proof points, the messaging bank, the recommended site structure, the design direction, and — critically — the claims-discipline rules that keep a healthcare-compliance product's marketing honest. Read §15 (claims discipline) before writing a single headline.

---

## 1. How to use this document

Sections 2–10 are **raw material**: the product, the market, the pillars, the full feature ocean, the trust story. Sections 11–14 are **direction**: personas, sitemap, page briefs, messaging bank, design language. Section 15 is **law**: legal/compliance guardrails on claims. Section 16 tells you what is live vs. in-flight vs. roadmap so the site never oversells. Section 17 lists assets needed. When in doubt about any claim, check §15, then ask — this is a regulated-industry product and a wrong superlative is a liability, not a typo.

---

## 2. What CareOS is

**One-liner:** CareOS is the AI-native operating platform for home-care agencies — records that can never be lost, compliance that runs itself, a field app that works offline, and governed AI that carries the administrative load.

**Elevator pitch (30 seconds):** Home-care agencies run on the founder's memory and a sprawl of overwrite-prone shared drives — while carrying HIPAA, state licensure, and federal EVV obligations that can end the business on a bad survey day. CareOS replaces that with a single, HIPAA-grade, role-aware platform: append-only records that make lost data structurally impossible, database-enforced least privilege, regulatory cadences executed by software, GPS-verified visits, a credential-gated workforce, and an intelligence layer that drafts the paperwork, fills the shifts, and briefs the team every morning — while a licensed human approves anything that matters. Staff give care. The platform runs the office.

**Boilerplate paragraph (for footer / press / about):** CareOS is a care-operations platform purpose-built for licensed home-care agencies. It unifies client records, clinical forms, scheduling, electronic visit verification, credentials, compliance cadences, and family communication on one system — with an append-only, tamper-evident record architecture and a governed AI layer in which artificial intelligence proposes and a licensed human disposes. CareOS is built for HIPAA compliance, designed around Maryland RSA requirements (COMAR 10.07.05) and federal EVV mandates, and engineered to an enterprise quality bar.

**Category:** Home-care agency management software / care operations platform (competing set: AlayaCare, WellSky, AxisCare, Axxess, HHAeXchange).

**The founding thesis (the emotional core the site should carry):** this is not "software features" — it is de-risking and liberating a seven-figure business, and making the founder removable from the critical path *on purpose*. Every hour a nurse spends typing, every morning a coordinator spends phoning replacements, every week an owner spends assembling survey evidence is an hour taken from clients.

---

## 3. Market context (why now, why this)

The industry burden is enormous and quantifiable — these are the third-party statistics that anchor the problem narrative (all must be re-verified and freshly cited before publication, §15):

| Stat | Source (as recorded in spec corpus) |
|---|---|
| A single start-of-care assessment ≈ 57.3 clinician minutes | CMS OASIS-E OMB filing |
| Documentation consumes 25–40% of clinical time | JMIR Nursing 2025; AACN |
| 51% of home-care agencies rank scheduling churn their #1 operational challenge; scheduling is also the #1 AI ask (64%) | AxisCare 2026 trends survey |
| Caregiver turnover ≈ 75% annually — the churn never stops | Activated Insights 2025 Benchmarking Report |
| Healthcare back-office ≈ 2× the G&A share of other industries; ~$175B/yr automatable | Stella Intl |
| 11.8% first-pass claim denial rate; $25–181 rework cost per denial | Experian State of Claims 2025; Aptarro |
| One provider doubled referral conversion (20.7% → 44.8%) with automated referral handling | The Rowan Report |
| Payers are auto-downcoding claims with weak documentation | Cigna policy, Oct 2025 |

**The whitespace CareOS claims** (no incumbent occupies these): compliance-grade AI provenance (verifiable citations, an append-only AI ledger, surveyor-ready evidence trails), database-enforced governed autonomy, the automated daily huddle (no vendor ships one), and documentation AI for private-duty / Medicaid personal care (the entire ambient-scribe race — WellSky Scribe, Netsmart Bells, HCHB Curate — targets skilled home health / OASIS; the RSA/COMAR segment has none).

---

## 4. Positioning & competitive frame

Incumbents are broad, legacy, online-first, and AI-thin. CareOS is narrow-and-deep where it matters. The one-table thesis (this is the backbone of a "Why CareOS" or comparison page):

| Axis | Incumbents | CareOS |
|---|---|---|
| Data integrity | App-level edit history at best; audits reconstructed manually | **Database-enforced append-only records + hash-chained audit trail**; survey evidence in seconds |
| AI | Bolt-on chatbots, marketing-grade "AI" | **AI-native fabric**: governed autonomy tiers, a permissions-aware Brain, document-driven intake, agents that leave a full audit trail |
| Field UX | Online-first portals that fail in basements and dead zones | **True offline-first** (encrypted on-device data + sync), voice-first documentation |
| Compliance | Checklists bolted onto generic records | **Compliance by construction**: regulatory cadences as executable, source-cited rules |
| Fit | Generic multi-state feature sprawl | Purpose-built for the agency operating model — then productizable |
| Velocity & TCO | Legacy stacks, quarterly releases, per-seat sprawl | Modern integrated platform, weekly releases, a fraction of the run-rate |

**The governance attack line** (use with care, §15): at least one incumbent's automation auto-resolves EVV verification failures with no human disposer. CareOS makes the opposite promise structural: anything clinical, compliance-final, or adverse to an employee **cannot execute** without a licensed human's recorded approval — enforced in the database, not in a policy PDF. When a payer asks "did AI write this?", CareOS converts a liability question into a demonstrable audit answer: every AI-touched record carries its full lineage — model, prompt version, inputs manifest, confidence, and the named human who approved it.

---

## 5. The five value pillars (the site's core architecture)

Every page, section, and demo should ladder up to one of these.

### Pillar 1 — Nothing is ever lost. Ever.
The industry's quiet catastrophe is overwritten and vanished records. CareOS is append-only at the database layer: every save is a new version; edits never destroy history; corrections reference what they correct; there is **no overwrite button anywhere in the product** — not in the UI, not in the API, not for administrators. When two people edit the same record, CareOS keeps both versions and walks them through a side-by-side merge; both originals are preserved and linked forever. Every consequential action lands on a tamper-evident, hash-chained audit ledger whose daily anchor hashes are exported to independent write-once storage — so even a database administrator cannot rewrite history undetected. Autosave everywhere; progress survives dead batteries, dead zones, and dropped connections.

**Site copy angle:** "The record you signed is the record that exists — provably, forever."

### Pillar 2 — Compliance by construction, not by checklist.
Regulatory cadences (initial assessments, annual reassessments, supervisory visits at the regulation's own intervals, credential expiries) are executable rules evaluated by a deterministic engine — deadlines are computed by software, never guessed by staff and never "judged" by an AI. Obligations appear on dashboards with plain-language explanations, escalate when at risk, and require a licensed nurse with a recorded reason to waive. Regulatory citations shown in the product are human-verified against primary sources with document checksums — an AI is structurally incapable of publishing a regulation in CareOS. Scheduling is credential-gated: an expired license blocks assignment automatically, with a plain-language reason. And when a surveyor says "show me," the owner exports a hash-verified evidence packet — records, signatures, audit trail, and a plain-language index — in clicks, not weekends.

**Site copy angle:** "A survey should be a demonstration, not an emergency."

### Pillar 3 — A field app that works in basements.
The primary users are caregivers and nurses on mid-tier phones, in homes, often with no signal. The mobile app is offline-first by architecture: an encrypted local database holds each caregiver's world (their shifts, their clients, their forms — nothing more), opens to today's visits in under two seconds with no network, and syncs automatically when connectivity returns. Clock-in is one tap inside a GPS geofence with instant local confirmation; out-of-range clock-ins ask for a reason and flag for review — they never block care. Voice notes: hold to talk, watch a structured draft assemble itself, confirm section by section. Honest status states — Live / Syncing / Offline with a visible queue count — so staff always know exactly where their work stands. Large touch targets, dynamic type to 200%, screen-reader-verified core flows, English and Spanish from day one.

**Site copy angle:** "Built for a tired caregiver on a mid-tier Android in a basement — because that's who actually delivers care."

### Pillar 4 — AI that carries the load. Humans that stay in charge.
CareOS is AI-native, not AI-decorated: forty-plus mapped automation workflows across every role, from voice-to-visit-note to intake-packet extraction to a coordination agent that fills open shifts by SMS. But the headline is governance: a tiered autonomy model (T0–T3) **enforced in the database**, in which AI drafts, ranks, narrates, and proposes — and a licensed human approves, edits, or rejects anything clinical, compliance-final, or adverse to an employee. Every AI action is a ledger row: model, prompt version, inputs, confidence, cost, disposition, approver. The Brain answers policy and operational questions with citations or abstains — retrieval runs under the asking user's own permissions, so it structurally cannot reveal what that user couldn't already see. Deterministic questions (deadlines, eligibility, money) are never delegated to a model. Per-capability kill switches, budgets, and evaluation gates round out an AI story no incumbent can tell.

**Site copy angle:** "AI proposes. A licensed human disposes. Enforced in the database, not in a slide deck."

### Pillar 5 — Security that is the architecture, not a feature page.
Authorization lives in the database: row-level security on every table means every read and write is checked at the row, for every user, on every path — the app can have bugs; the perimeter holds. Mandatory multi-factor authentication for all staff; protected-health-information access requires an MFA-verified session. Column-level encryption for highest-sensitivity fields. No PHI in emails, push notifications, URLs, logs, or analytics — structurally, verified continuously by an automated canary suite that plants fake PHI and asserts it never leaks. Offboarded staff lose all access — web, mobile, synced device data — in a drilled ≤15-minute procedure. Every vendor in the PHI path operates under a Business Associate Agreement. Backups every five minutes; quarterly restore drills; and the field app's offline-first design means care delivery continues through any backend outage.

**Site copy angle:** "We didn't add security to CareOS. We built CareOS out of it."

---

## 6. The full feature ocean (catalog by module)

This is the exhaustive sellable-feature inventory. Feature-status flags (Live / Building / Roadmap) are in §16 — do not publish a feature as available without checking.

### 6.1 Client records & clinical forms
- Complete client chart: summary, care plan, forms, visit history, medication administration records, documents — role-scoped so each person sees exactly what their job requires.
- JSON-schema-driven forms runtime rendering the agency's own regulatory forms (assessments, plans of care, visit notes, consents, incident reports) with rich field types: text, voice-dictation-enabled long text, date/time, selects, signature, photo (metadata-stripped), body-map annotation, medication rows, computed fields.
- Autosave every few seconds and on field exit, with a visible "Saved ✓ 2:41 PM" state. Navigating away never loses input.
- Every save is a new immutable version; a full history timeline on every record; plain-language event stream ("Maria updated the care plan · 2:38 PM").
- Corrections after finalization are first-class: reason required, original preserved, correction linked — the only edit path on a signed record.
- Conflict resolution is "keep both": side-by-side your-version/their-version merge, per-field pick-or-merge, both antecedents preserved and linked. No silent overwrites anywhere in the product.
- Validation in plain language, with a crucial distinction: required-for-final vs. required-for-save — compliance completeness never interrupts typing.
- Documentation-quality suggestions render as dismissible advisories, never blockers.

### 6.2 Native e-signature
- Click-to-sign built in: signer authenticated with MFA, explicit intent screen ("Sign as RN — this creates a permanent record"), signature cryptographically bound to the exact content hash of the version being signed — any content change requires a new signature, enforced by the database itself.
- Finalization blocked until all required roles have signed; post-signature records are visibly locked.
- Rendered PDFs stamp signer, timestamp, and hash excerpt.
- External parties (physicians, remote family consents) route through DocuSign under BAA, with completed envelopes archived and hash-linked.

### 6.3 Compliance cadence engine & survey readiness
- Regulatory cadences (initial/48-hour assessment, annual reassessment, supervisory visits at 45 days / 3 months / 4 months per medication involvement, credential expiries, training hours) evaluated hourly by a deterministic engine — in the regulation's own units.
- Obligations dashboard with plain language ("Ms. Johnson's yearly check-up is due Friday"), risk states (open → at-risk → overdue), notifications and escalations.
- Waivers require a licensed nurse and a recorded reason.
- Verified legal authority catalog: every regulatory citation shown in the product was published by a named human verifier against a checksummed source document — structurally impossible for AI to author.
- One-click survey evidence packet export: records, signatures, hash-chain verification, audit trail, plain-language index — watermarked and audited.
- Mock-survey drill mode: Q&A over the agency's own records with citations that resolve to record IDs.

### 6.4 Scheduling & workforce guardrails
- Week-grid scheduler: create, assign, recurrence, cancellations with reasons, open-shift states.
- **Credential-gated assignment:** the schedulability check blocks assigning a caregiver with a lapsed credential — with a plain-language reason — before the mistake happens.
- Shift offers with race-safe first-accept-wins acceptance; automatic notification of family and staff on changes.
- Live visit board for the office: map plus real-time statuses.
- Exception queues for no-shows, late arrivals, and EVV anomalies with disposition trails.
- Open-shift fill agent (see §7): call-out → ranked eligible candidates → coordinator-approved outreach plan → SMS offers → first accept wins — the whole causal chain replayable from the audit ledger.

### 6.5 Electronic visit verification (EVV)
- One-tap geofenced clock-in/out with GPS accuracy capture; instant local confirmation that syncs later ("Clocked in 2:01 PM — will sync").
- Out-of-fence handling that records and flags but **never blocks care** — a non-blocking reason prompt, then an exception for coordinator review.
- Offline capture with idempotent event queuing — visits in dead zones reconcile cleanly on reconnect.
- Built around Maryland's state EVV program (ISAS / LTSSMaryland) with a per-visit submission state machine, bounded retries, nightly reconciliation reports, and a coordinator exception queue. Corrections never edit history — they are new events referencing the originals. *(State-integration specifics pending state onboarding — see §15.)*
- EVV runs identically for private-pay clients — accountability as a product feature, not just a Medicaid mandate.
- Missing clock-out detection with a friendly correction prompt; corrections are human, with mandatory reasons.

### 6.6 Credentials, HR & the staff lifecycle
- Credential vault per employee: licenses, TB tests, CPR, background checks, training hours — with verification workflow (AI extracts, a human verifies, expiry math stays in the deterministic engine).
- Expiry engine feeding both the compliance dashboard and the scheduling guard: lapses block scheduling automatically.
- Credential renewal chase: drafted, personalized reminder outreach and document re-verification on return (a 40-caregiver agency handles 200+ expiry events a year — CareOS makes it a review-and-approve flow).
- Hiring pipeline: candidate → invite → complete employee file, with a deterministic file-readiness verdict; the owner disposes the hire itself.
- Onboarding checklists auto-generated from role requirements; missing documents surface at onboarding, not at scheduling time.
- Background-check orchestration (Checkr integration) with a hard, structural rule: **adjudication is always human** — the system is built so it cannot auto-adjudicate.
- Offboarding: a deterministic revocation saga — accounts, sessions, schedules, synced devices, push tokens — target ≤15 minutes from HR trigger, drilled quarterly. The system never proposes termination; separation is always human-initiated.
- In-service training-hours ledger against regulatory requirements, with drafted reminders.
- Quarterly access reviews generated by the system; role and permission changes are themselves audited configuration events.

### 6.7 Intake & document intelligence
- Upload or fax-in a referral packet; CareOS classifies the document type, extracts structured fields with per-field confidence (vision AI, two-pass self-check on low-confidence fields), validates against cross-field rules, and detects duplicates against the existing roster — **never auto-merging, never auto-committing.**
- Side-by-side review: source image next to extracted fields, confidence-colored; low-confidence fields require explicit human touch; the reviewer commits, and every committed record carries import provenance.
- A 30-page referral packet becomes a reviewed, provenance-stamped chart in minutes, every field showing its confidence and its human approver.
- Referral triage: inbound inquiries classified and urgency-ranked, first-response drafts ready for approval — because speed-to-respond drives conversion.
- Credential documents (licenses, TB results, certifications) extracted the same way, human-verified, wired straight into the expiry engine.

### 6.8 The Agency Brain (ask-anything, with citations)
- Staff ask questions in plain language — policy questions ("what's our procedure for a missed medication?") and operational questions ("when is Ms. Z's reassessment due?").
- **Cite-or-abstain:** every answer cites its source; if the documentation doesn't contain the answer, the Brain says so and routes to the right human — it does not guess.
- **Permissions-aware by construction:** retrieval executes under the asking user's own credentials; there is no privileged retrieval path, so the Brain structurally cannot leak what the asker couldn't already see. A caregiver's Brain and the owner's Brain know different things — automatically.
- Live-data tools answer operational questions from the real system of record, read-only, under the user's permissions.
- Knowledge-gap capture: unanswerable questions cluster into a weekly digest so the agency's documented knowledge grows where staff actually need it — un-cloning the founder, question by question.
- Injection-hardened: retrieved documents are treated as reference material, never as instructions; the Brain has zero ability to modify data.

### 6.9 The Daily Huddle Brief (the category-defining feature — no vendor ships one)
- Every morning, each role opens CareOS to a brief that is already waiting: overnight call-outs, at-risk clients, coverage gaps, overdue obligations, expiring credentials, yesterday's exceptions, the unsigned queue — each item one tap from action.
- Every fact comes from deterministic queries; AI only narrates, ranks, and writes the plain-language "why this matters."
- Owner, coordinator, and nurse editions; caregiver day-sheets in plain language — in Spanish where that's the caregiver's language.
- The demo moment: it's 7:55 AM, the owner opens the dashboard, and the morning scramble has already been done.

### 6.10 Voice-first documentation
- Voice-to-visit-note: speak for 30–60 seconds; a structured, template-shaped note draft assembles itself; the caregiver confirms section by section; the saved note carries a permanent provenance label ("Drafted with AI · reviewed & signed by R. Njeri, RN").
- Works offline: record locally, transcribe and structure on reconnect.
- Ambient supervisory-visit drafting: record the home visit, get a speaker-labeled transcript and a structured note draft for per-section nurse review.
- Incident reports by voice — because incident narratives are typed under stress, late, or not at all.
- Hands-busy mode: large controls, high contrast, works with gloves.

### 6.11 Clinical intelligence (drafts, never decisions)
- Care-plan review drafts generated from the delta between recent assessments/visit narratives and the current plan — proposed as a new version for nurse review, ahead of the review-due date.
- Clinical early-warning flags from longitudinal signals (condition/mood trajectory, exception spikes, visit-duration shortfalls) — proposed to a nurse, who disposes; never auto-escalated.
- Signature queue prioritized by compliance urgency, with a one-line plain-language reason per item.
- Documentation-QA advisories inside the forms runtime — dismissible, never blocking.

### 6.12 The approvals inbox (the human command seat for all AI)
- One surface where every AI proposal lands: what the AI wants to do, why (inputs and citations), its confidence, and one-tap approve / edit / reject.
- The coordinator reviews a dozen drafted chase messages with reasons attached and approves them in ninety seconds; every send becomes a ledger row.
- Every disposition feeds quality metrics — the agency's own judgments continuously teach the system.

### 6.13 Communication, chase & escalation engine
- Automated detection + human-approved drafted messages for: credential renewals, stale drafts, missing signatures, schedule exceptions, late notes, obligation cures.
- SMS via a healthcare-grade path with minimized content ("Your 2:00 PM shift is confirmed — details in CareOS") — no diagnoses or care details in a text message, ever.
- On-call hotline with IVR and escalation policy; call metadata logged as compliance evidence for response-time requirements.
- Notification center with acknowledgment trails — escalations stop when someone actually acknowledges.
- Push notifications carry a title and a deep link, never PHI.

### 6.14 Family portal & updates
- Consent-gated portal: approved updates feed, scoped visit calendar, consented documents, contact/on-call info.
- AI-drafted family updates from visit and supervisory data — staff-approved before anything becomes visible, hard-gated on the client's consent scope.
- Per-recipient translation (e.g., Spanish-speaking families), with care-critical content human-verified.
- Communication-cadence detection: "this family hasn't been updated in three weeks" surfaces to the coordinator before it becomes a complaint call.

### 6.15 Executive command center & analytics
- Command dashboard: census, staffing, compliance heat, alerts — leads with exceptions, not data.
- Ask-anything analytics in natural language ("clients with 2+ missed visits this month") answered through governed, read-only query templates — never free-form SQL from a model.
- Coverage-gap staffing forecast: which caregivers become unschedulable in 30 days and which clients that strands — the expiry engine computes, AI writes the impact story.
- Census and operations briefing narratives folded into the owner's huddle edition.
- AI usage & cost self-digest: the owner sees exactly what the AI layer does and costs, weekly, with anomaly flags.

### 6.16 Billing readiness & finance
- Deterministic claim-readiness gates: billing export includes **only EVV-verified visits** with complete documentation and signatures — the biggest claims-error class closed by construction.
- EVV exception pre-adjudication: deterministic rules classify every clock/schedule/authorization mismatch; AI drafts the documented correction narrative; a human approves.
- Denial-risk pre-check before export — completeness gaps narrated in plain language ~60 days before they'd otherwise surface as denials.
- QuickBooks Online export with idempotent references and a monthly drift report. CareOS bills; QuickBooks books.

### 6.17 Migration: switching without fear (a first-class product)
- A decade of Google Drive folders, personal drives, and paper becomes a structured, provenance-tagged system of record: AI classifies and extracts; humans adjudicate every identity match; **nothing is deleted, nothing is auto-merged.**
- Every migrated record preserves its original path and timestamps.
- **The migration scorecard:** per-client and per-employee regulatory completeness — which required documents exist, are current, are signed — delivered before cutover. Run correctly, migration is the agency's first real compliance audit. Gaps found by us are fixable; found by a surveyor, they're citations.
- Cohort-by-cohort cutover with a parallel-run period and a rollback path at every stage before the final switch; the legacy drive goes read-only — the overwrite era ends on a specific, documented day.
- Adjudication doubles as staff training: learning the review UI *is* onboarding.

### 6.18 Platform & operations (the quiet flex)
- Enterprise reliability posture: 99.9% availability target, backups with ≤5-minute recovery-point objective, ≤4-hour recovery-time objective, quarterly restore drills with auditor-grade artifacts.
- Care delivery survives total backend outage — the field app is offline-first by architecture.
- Performance budgets as engineering law: sub-2.5-second page loads on 4G mid-tier Android, sub-2-second mobile cold start offline, sub-5-second sync recovery.
- Weekly release cadence behind feature flags; every change is tested against a ~700-assertion database-level compliance test suite before it ships.
- Multi-tenant architecture from day one — built for one agency's excellence, ready to become a product.
- No lock-in by design: standard Postgres, standard React — a maintained, quarterly-verified exit runbook. "We stay on this stack because it's good, not because we're stuck."

---

## 7. The AI story in depth (the headline differentiator — give it a full page)

**The honest architecture.** Three commitments no incumbent can copy-paste:

1. **Append-only provenance is the substrate.** AI output enters the system as a draft version with a foreign key to its full interaction record — model, prompt version, minimized-input manifest, confidence, cost, disposition, approver. No incumbent markets verifiable citations, an append-only AI ledger, or surveyor-ready AI evidence trails — at exactly the moment payers are auto-downcoding claims with weak documentation.
2. **Deterministic engines answer what AI never should.** Credential expiry, compliance deadlines, schedulability, and billing eligibility are computed in SQL. The AI narrates, prioritizes, and drafts *around* engine outputs; it never computes a deadline, an eligibility verdict, or a dollar. This boundary is itself a sellable trust posture no competitor articulates.
3. **Tiered autonomy is database-enforced, not a slide.** T0 (notify/log) · T1 (low-stakes act, human-approved plans, full audit) · T2 (AI drafts, licensed human approves every item) · T3 (human-only; AI may brief). There is no code path that executes a gated capability without a human disposition row — and a red-team CI suite attacks exactly that, every release.

**The guardrail vocabulary** (use these on the site; they're real, not marketing):
- **Cite-or-abstain** — every claim cites a resolvable source, or the system says "I don't know" and routes to a human.
- **The PHI-minimizer** — every AI call sees only an explicitly allowlisted set of fields for that task; an automated canary suite proves out-of-allowlist data can never reach a request.
- **Retrieval runs as the user** — no privileged AI data access exists, anywhere.
- **Kill switches** — every AI capability can be disabled platform-wide in seconds.
- **Budgets** — hard per-capability spend ceilings that degrade gracefully to manual paths.
- **Eval gates** — no prompt or model change ships without passing golden-set accuracy, groundedness, citation-validity, and safety suites in CI.
- **Anti-capabilities** — things the system is built to never do: adjudicate a background check, propose a termination, auto-resolve an EVV verification failure, auto-merge patient identities, bill an unverified visit.
- **Degrades to manual** — every AI surface has a non-AI path; AI is an accelerant, never a dependency for care.

**The "simple" mandate (adoption story):** field staff never see a prompt box. The product surface of the entire AI layer is buttons and briefs — a morning page you read, a microphone button you press, an inbox where every item is approve/edit/reject. Zero configuration per role. The only chat surface is the Brain, and it lives in the office.

**The flywheel (forward-looking, frame carefully per §15):** every human approval, edit, and rejection is captured as structured feedback keyed to the exact prompt and model version — the agency's licensed judgment continuously improves its own system. Competitors can buy the same models; they cannot buy years of licensed-human dispositions over real agency operations.

**Scale of impact (must be framed as engineering estimates, §15):** the automation map covers 41 workflows across owner, coordinator, nurse, caregiver, family, billing, and staff-lifecycle roles, with an engineering estimate of roughly 235–285 staff-hours returned per week for a 100-staff agency at full deployment — dominated by voice-to-note. Model spend at that scale is estimated at under $1 per client per month.

---

## 8. The trust & security page (content spec)

This page is a sales asset, not boilerplate — buyers in this market have compliance officers. Structure it as claims + mechanisms:

| Claim | Mechanism (public-safe detail) |
|---|---|
| Access control enforced in the database | Row-level security on every table; the application cannot bypass it; least-privilege scoping to each user's actual caseload |
| MFA everywhere | TOTP mandatory for all staff; PHI access requires an MFA-verified session; SMS one-time codes rejected as a second factor (SIM-swap risk) |
| Tamper-evident records | Append-only storage + per-tenant hash-chained audit ledger + daily anchor hashes exported to independent write-once storage; chain verified daily by an automated job |
| Encryption | TLS 1.2+ in transit; AES-256 at rest; column-level envelope encryption for highest-sensitivity fields; signed file URLs valid ≤5 minutes |
| PHI containment | No PHI in emails, push payloads, URLs, logs, or analytics — structurally; a planted-canary suite continuously verifies it |
| Fast offboarding | Access revocation drill: web, mobile, synced device data, push tokens — target ≤15 minutes, exercised quarterly |
| Vendor accountability | Every vendor in the PHI path under a Business Associate Agreement; register reviewed quarterly |
| Environments | Production is the only environment that ever contains PHI; all development and demos run a fully synthetic universe |
| Tested like it matters | ~700-assertion database-level compliance suite on every change: access-control matrix, append-only probes, audit-chain verification, cadence math, AI tier-gating |
| Resilience | ≤5-min recovery point, ≤4-hr recovery time, quarterly restore drills; field care continues through any backend outage |
| Incident readiness | Documented response runbooks, 72-hour posture, twice-yearly tabletop exercises — including "a malicious insider edits history" (the audit chain must catch it) |
| Continuous compliance posture | Aligned with the 2026 HIPAA Security Rule NPRM direction: mandatory MFA, encryption without exceptions, ≤1-hour access revocation (we target 15 minutes), annual penetration testing |

**Do not** publish: internal secret-custody details, threat-model specifics, vendor register rows beyond named categories, or anything from docs/09 §5. The table above is the approved altitude.

---

## 9. The switching story (dedicated page or prominent section)

Agencies don't fear new software; they fear losing ten years of records in the move. CareOS treats migration as a first-class engineered product (§6.17). The narrative arc for this page: (1) *We take everything* — Drive folders, personal drives, paper, email attachments; (2) *We lose nothing* — provenance-tagged, hash-verified, originals archived read-only; (3) *Humans decide every match* — no auto-merge, ever; (4) *You get a compliance audit for free* — the scorecard shows exactly where your records stand before a surveyor ever asks; (5) *You cut over in waves, with a rollback path* — pilot cohort, parallel run, then a dated, signed cutover day. Close with the reframe: "Gaps found during migration are fixable. Gaps found by a surveyor are citations."

---

## 10. Proof points & numbers bank

**Engineering targets safe to publish as targets** (never as guarantees, §15): 99.9% availability · ≤5-min recovery point · ≤4-hr recovery time · sub-2s offline mobile cold start · <2.5s page load on 4G mid-tier Android · 95% of EVV visits submitted within 1 hour, 100% within 24 · notification delivery p95 <60s · sync recovery <5s · extraction accuracy gates ≥0.97 precision/recall on critical fields · Brain groundedness ≥0.95 · citation validity 100% · single-document extraction under 60 seconds, full intake packet under 5 minutes.

**Demo moments (the site's "show, don't tell" inventory — each is a candidate hero video):**
1. 7:55 AM — the huddle brief is waiting: overnight call-out, two at-risk obligations, one expiring credential, each one tap from action.
2. A caregiver speaks for 30 seconds; a structured, provenance-labeled visit note assembles itself.
3. A 30-page faxed referral packet becomes a reviewed chart in under five minutes, every field showing its confidence and its human approver.
4. A 6:02 AM call-out; by 6:04 the coordinator approves an outreach plan; by 6:20 the shift is filled — the entire chain replayable from the audit ledger.
5. A surveyor asks "show me supervisory visits for this client"; the owner clicks once and hands over a hash-verified evidence packet.
6. Two people edit the same note; CareOS keeps both and merges them side by side; nothing was lost.
7. Airplane mode on: a full visit — clock-in, tasks, voice note, clock-out — completed offline, then synced perfectly.
8. An owner flips a kill switch and watches an AI capability refuse politely, with a ledger row for every prior call.

**Industry stats:** use §3's table, re-verified with fresh citations at publication.

---

## 11. Personas → what each needs to hear

| Persona | Their nightmare | The message | Features to lead with |
|---|---|---|---|
| **Owner / founder** (the buyer) | A bad survey day; the business lives in her head; she can never step away | "De-risk the business. Un-clone yourself." | Survey evidence packet · huddle brief · exec dashboard · audit chain · Brain · migration scorecard |
| **Administrator / compliance lead** | Missed cadences; unverifiable records; access sprawl | "Compliance that runs itself — and proves itself." | Cadence engine · verified citations · access reviews · evidence export · append-only records |
| **Coordinator** | The 6 AM call-out; the chase list that never ends | "Your morning scramble, already done." | Open-shift fill agent · exceptions queue · chase drafts inbox · live visit board · scheduler guardrails |
| **RN / case manager** | Documentation eating clinical time; signature backlogs; things slipping between visits | "Draft in seconds. Sign with confidence. Nothing slips." | Voice drafting · care-plan drafts · early-warning flags · prioritized signature queue · supervisory-visit workflow |
| **Caregiver** | Apps that fail in the field; typing notes on a phone at 9 PM; getting blamed for tech failures | "One tap to clock in. Speak your note. It just works — even offline." | Today screen · geofenced clock-in · voice notes · honest offline states · day-sheet in your language |
| **Family** | Silence; not knowing if mom was seen today | "You'll always know." | Updates feed · visit calendar · translated updates · on-call access |
| **Biller / HR** | Denials 60 days later; credential surprises; offboarding scrambles | "Clean claims, verified visits, no surprises." | EVV-verified billing gate · denial pre-check · credential vault · hiring pipeline · 15-minute revocation |

---

## 12. Recommended sitemap & page briefs

```
Home
├── Product
│   ├── Records & Compliance      (Pillars 1+2: forms, versions, signatures, cadences, survey packet)
│   ├── Scheduling & Workforce    (scheduler, guardrails, open-shift agent, credentials, staff lifecycle)
│   ├── Field App & EVV           (Pillar 3: offline-first mobile, voice, geofenced visits)
│   ├── AI & The Agency Brain     (Pillar 4: huddle, voice-to-note, intake intelligence, approvals inbox, governance)
│   └── Family Portal             (updates, translation, consent-gated access)
├── Why CareOS                    (manifesto + competitive frame + the five pillars)
├── Switching to CareOS           (§9 migration story + scorecard)
├── Trust & Security              (§8 content spec)
├── Company / About
├── Book a Demo                   (primary CTA sitewide)
└── FAQ
```

**Home page brief.** Hero: one pillar-4 or pillar-1 headline (see §13), one demo-moment video, one CTA ("Book a demo"). Then: the problem strip (three industry stats), the five pillars as a scrolling narrative (one screen each, product visual per pillar), the governance block ("AI proposes. A licensed human disposes." with the approvals-inbox visual), the trust strip (BAA / MFA / append-only / offline-first icons — claims per §8 only), the switching teaser, final CTA. Keep it exception-led, like the product: lead with what CareOS *prevents*, not feature counts.

**Per-product-page pattern.** Persona pain (one paragraph) → the demo moment (visual) → 3–5 feature blocks from §6 → the guarantee block (what's structural vs. best-effort) → cross-link to Trust → CTA.

**Comparison pages:** high value, high legal risk. Build the *category* comparison (the §4 table, "incumbents" unnamed or named only with verified, dated, sourced claims) — see §15 before naming any competitor.

**Pricing page:** do **not** build yet. Pricing is not ratified. Ship "Book a demo" until product ratifies a public price.

---

## 13. Messaging bank

**Master tagline (ratified in spirit — it closes the AI master plan):**
> **Staff give care. The platform runs the office.**

**Hero headline options:**
- The operating platform for home care that never loses a record, never misses a deadline, and never lets AI act alone.
- Home care runs on paperwork, phone calls, and memory. Until now.
- The record you signed is the record that exists. Provably. Forever.
- Your agency's morning scramble, already done by 7:55 AM.
- AI-native. Human-governed. Survey-ready.
- Compliance by construction. Care by humans.

**Section-line bank:**
- "Nothing is ever lost. There is no overwrite button anywhere in CareOS."
- "AI proposes. A licensed human disposes. Enforced in the database, not in a policy binder."
- "A survey should be a demonstration, not an emergency."
- "Built for a tired caregiver on a mid-tier Android in a basement."
- "Deadlines are computed, never guessed — and never left to an AI."
- "Every AI action is a ledger row: what it did, why, and which human approved it."
- "Ask anything. Get an answer with citations — or an honest 'I don't know' and the right person to ask."
- "Gaps found during migration are fixable. Found by a surveyor, they're citations."
- "Care delivery never blocks on our uptime."
- "We didn't add security to CareOS. We built CareOS out of it."
- "Un-clone the founder."
- "The offline app that's honest about being offline."

**CTA language:** "Book a demo" (primary) · "See the 7:55 AM demo" · "Walk through a survey drill" · "See how switching works."

**Words to avoid** (per product voice + claims discipline): "revolutionary," "guaranteed," "HIPAA-certified," "fully automated," "autonomous," "replaces your staff," "military-grade," "unhackable," clinical jargon on family-facing pages, regulatory citation numbers anywhere on the site (see §15).

---

## 14. Voice, tone & design direction

**Voice (inherit the product's ratified voice):** plain language, encouraging, specific, blame-free. Every claim states what happens, what's preserved, what to do next. Confident but never breathless — this product's aesthetic is *calm competence*, "a well-run agency: composed, competent, humane." Short declarative sentences. Concrete nouns (records, signatures, shifts, citations) over abstractions (solutions, synergies, workflows).

**Design language (align with the product's ratified "Apple 2026" system, D-012):**
- Type: **Instrument Serif** for display (large titles, hero numerals) + **Instrument Sans** for everything else (400/500/600).
- Color: cool systemGray surface ramp (`#f2f2f7` canvas, white panels); accent **system blue `#007AFF`** (AA small-text variant `#0058b8`); semantic green/orange/red/blue — all WCAG AA-verified; status is always color + icon + label, never color alone.
- Feel: generous whitespace, continuous-corner radii, soft elevation, frosted translucent chrome, spring-feel motion (CSS, sub-300 ms), light theme.
- The website should look like a sibling of the product — when a visitor books a demo, the product should feel like the website kept its promise.
- Accessibility: WCAG 2.1 AA minimum on the marketing site too — an accessibility-first product with an inaccessible website is a self-refutation. Honor `prefers-reduced-motion`.
- Product screenshots are the hero visual language (see §17) — real UI over abstract illustration wherever possible.

---

## 15. Claims discipline & legal guardrails (READ FIRST, non-negotiable)

This is a HIPAA-adjacent product for licensed healthcare agencies. Marketing errors here are not embarrassing — they are legally consequential. These rules bind every page:

1. **Never "HIPAA-certified" or "HIPAA-compliant" as a badge.** There is no HIPAA certification. Approved framing: "built for HIPAA compliance," "HIPAA-grade architecture," "every vendor in the PHI path under a Business Associate Agreement." HIPAA compliance is a program the *agency* runs; CareOS provides the technical safeguards and the evidence machinery.
2. **No unmeasured outcome claims.** The spec corpus explicitly commits: *we do not market time-savings claims we have not measured in our own ledger.* The "235–285 hours/week" figure is an engineering estimate — publishable only labeled as such ("designed to return…," "our engineering estimate…"), never as a customer result. No fabricated testimonials, case studies, or ROI figures, ever. When real measured numbers exist (the product's own telemetry is built to produce them), they replace estimates — that's the plan.
3. **No regulatory citation numbers on the website.** COMAR/CFR section numbers require human verification against primary sources even *inside* the product (a ratified decision). The marketing site should say "Maryland RSA requirements" / "federal EVV mandates" generically. Any specific citation must go through compliance review first.
4. **EVV/state-integration language stays capability-level.** The exact Maryland ISAS integration modality is an open verification item. Say "designed around Maryland's state EVV program"; do not promise submission mechanics until the state integration is verified.
5. **Targets are targets.** SLOs, latency budgets, and accuracy gates publish only with "target"/"designed for" framing — never "guaranteed."
6. **Every screenshot uses synthetic data only.** All demo data comes from the synthetic "Meadowbrook" universe (fictional clients, staff, addresses). Real PHI on a marketing asset is a reportable breach. Full stop. If a screenshot's provenance is uncertain, it does not ship.
7. **Competitor claims need evidence files.** Named-competitor statements (e.g., specific automation behavior) must carry a dated source archived before publication, and go through counsel. The safer default: compare against "legacy platforms" as a category.
8. **AI claims stay inside the governance frame.** Never "fully automated," "autonomous agents," or "AI-powered decisions." The accurate—and stronger—framing is always: AI drafts/proposes/ranks; humans approve; everything is audited. The governance *is* the differentiator; don't market it away.
9. **Product name check.** "CareOS" is a working name flagged as rebrandable in the master index. Confirm final name and trademark clearance before domain, logo, and launch.
10. **No security detail beyond §8's approved altitude.** No secret-custody specifics, no internal threat-model rows, no vendor-register internals.
11. **Product status honesty.** The site must not present roadmap features as shipped — see §16. "Coming soon" labeling or capability-level framing for in-flight work.
12. **Industry statistics get fresh citations.** Every §3 stat re-verified against its primary source, cited with publication and date, before it renders publicly.

---

## 16. Feature status map (so the site never oversells)

Status as of 2026-08-05 — **the web team must re-confirm this table with product at content freeze.** Phase 1 is an 8-sprint build currently in progress; the AI layer ships in waves.

| Status | Features |
|---|---|
| **Built / in hand** | Core record spine (append-only versions, audit chain, signatures binding, keep-both) · identity/MFA/RBAC · forms engine core · compliance cadence engine with verified-authority catalog · Agency Brain v1 (policy Q&A, cite-or-abstain) · AI governance plane (registry, tiers, kill switches, budgets, ledger) · staff lifecycle spine (hiring file, onboarding engine, revocation saga) · agent identity & machine-governance model |
| **In build (Phase 1 waves)** | Scheduler & guardrails · mobile field app & offline sync · EVV capture & state submission · document intelligence (intake + credential extraction) · approvals inbox · huddle briefs · voice-to-note · chase/nudge engine · exec dashboard · migration tooling & scorecard |
| **Roadmap (Phase 2+)** | Open-shift fill agent (full SMS loop) · ambient supervisory-visit drafting · care-plan drafts · early-warning flags · NL analytics · evidence-packet assembly UI · family portal & translated updates · billing/QBO integration · no-show prediction · fine-tuned distilled models |

Framing guidance: the site may describe the full vision (it is specced, ratified, and sequenced — this is not vaporware), but demo-able claims ("watch X happen") only attach to shipped features, and anything roadmap-tier gets capability-level framing without dates.

---

## 17. Assets required (production checklist for the web team)

1. **Screenshots / screen recordings** — from the Meadowbrook demo tenant only (§15.6): huddle brief (owner + coordinator editions) · voice-to-note flow (3 frames: speak → draft assembling → provenance label) · intake extraction side-by-side review · approvals inbox · keep-both conflict merge · scheduler with a credential-block message · mobile Today screen + offline banner + geofenced clock-in card · audit history timeline with hash excerpt · survey evidence packet export · Brain answer with citations · family update feed.
2. **Demo videos** — the eight §10 demo moments, 20–45 s each, silent-with-captions first (autoplay context).
3. **Diagrams** — "how governance works" (propose → review → approve → execute → ledger) · "nothing is lost" (version chain visual) · "works offline" (device ↔ sync ↔ cloud) — drawn in the D-012 visual language, not stock isometric clip-art.
4. **Trust page collateral** — the §8 table; BAA-coverage statement; a plain-language security overview PDF (compliance-reviewed) as a gated or open download.
5. **Copy review chain** — every page: product owner → compliance advisor (for §15 items) → founder sign-off. Budget real calendar time for this; it is the critical path, not design.
6. **Brand kit** — final name/trademark decision (§15.9), logo, Instrument Serif/Sans licensing for web, favicon/OG set.

---

## 18. Open questions for product (blockers the web team should file now)

1. Final product name / trademark clearance (§15.9) — blocks domain, logo, everything.
2. Public pricing posture — recommend "demo-first, no public pricing" for v1; ratify.
3. Named-competitor comparison pages: in or out for launch? (Counsel review either way.)
4. Which §16 "in build" features will be shipped at site launch? (Sets the demo-video list.)
5. Testimonial/design-partner permission from the pilot agency (American Care Team) — a founder quote is the single highest-value asset this site could have; needs consent and PHI-safe framing.
6. Blog/SEO strategy (compliance-topic content is a natural moat: "what a Maryland RSA survey actually checks," etc.) — separate workstream, not launch-blocking.

---

*Prepared from the CareOS spec corpus (docs/00–16). This document sells nothing the specs don't back — that discipline is itself the brand.*
