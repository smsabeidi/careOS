# CareOS — Master Index & Decision Log

**Client:** American Care Team (Maryland) · **Document:** 00 of 15 (package index) · **Version:** 1.0 · **Prepared by:** OCTSERVICES LLC
**Engagement codename:** Project Keystone · **Product working name:** CareOS *(rebrandable)*

> **Purpose.** The map of the whole package, the authoritative decision log, and the launch-blocking verification checklist. When documents conflict, this file says which one wins. Start here.

---

## 1. The package at a glance

**The mission in one paragraph.** American Care Team runs on its founder's memory and a sprawl of overwrite-prone Google Drive folders, under Maryland RSA licensure (COMAR 10.07.05), HIPAA, and federal EVV. CareOS replaces that with a single, HIPAA-grade, role-aware, AI-native operating platform — append-only records that make lost data impossible, database-enforced least privilege, COMAR cadences executed by software, verified visits, a credential-gated workforce, and an intelligence layer that carries the administrative load and un-clones the founder. Built on **Supabase + Vercel** (ratified, D-001), to a **$15M-product quality bar**, with the explicit aim of beating every incumbent in the category on data integrity, AI depth, field UX, and velocity (Doc 06 §10).

| # | Document | Purpose | Primary audience | Status |
|---|---|---|---|---|
| 00 | **Master Index & Decision Log** (this file) | Map, decisions, verification gates | Everyone | Living |
| 01 | Product Requirements (PRD) | What & why: modules M1–M13, FR/NFR, personas, RBAC matrix | All | v0.9 |
| 02 | Maryland Compliance & Regulatory Matrix | COMAR/EVV/HIPAA → requirements; cadences; forms inventory | Compliance, eng | v0.9 |
| 03 | Solution Architecture (v1) | Principles, data model & versioning design *(stack sections superseded by 06)* | Eng | v0.9 † |
| 04 | Delivery Plan, Roadmap, Cost & Discovery | Build-vs-buy, phases, ROM cost, discovery Qs | Client, PM | v0.9 |
| 05 | Intelligence Layer & Automation Architecture | AI thesis, FR-AI-*, tiers T0–T3, phased AI rollout | All | v0.9 |
| 06 | **Solution Architecture v2 — Supabase + Vercel** | The authoritative platform architecture | Eng | v1.0 |
| 07 | Database Schema & Data Dictionary | Binding DDL: RBAC, versioning, audit chain, EVV, cadence, AI tables | Eng | v1.0 |
| 08 | API & Integration Specification | Access lanes, RPC catalog, error/idempotency standards, ISAS/Twilio/Checkr/QBO/e-sign | Eng | v1.0 |
| 09 | Security, Identity & Compliance Implementation | Auth/AAL2, secrets custody, control mapping, vendor register, IR | Eng, auditor | v1.0 |
| 10 | Frontend, Mobile & Design System | IA, forms runtime, conflict UX, tokens, offline-first field app, a11y | Design, eng | v1.0 |
| 11 | AI Implementation Specification | Model routing, PHI-minimizer, extraction, RBAC-aware RAG, agents, evals, cost | AI eng | v1.0 |
| 12 | Testing, Quality & Acceptance | pgTAP compliance suite, E2E gates, canary-PHI, UAT, release gates | QA, client | v1.0 |
| 13 | DevOps, Reliability & Operations | Envs, CI/CD, migrations, SLOs, on-call, DR, exit runbook | Eng/ops | v1.0 |
| 14 | Data Migration & Cutover | Drive→CareOS pipeline, scorecards, parallel-run, rollback | All | v1.0 |
| 15 | Master Build Plan | Team, epics, Sprint 0–8 with stories & ACs | PM, eng | v1.0 |
| 16 | AI & Automation Master Plan | The 37-workflow automation map, waves, provider posture, AI cost | AI eng, PM | v1.0 |
| 17 | **Verified Visit & Workforce Intelligence** | EVV capture, geofencing, exceptions, approved hours, EVV adapters, workforce AI | Eng | v1.0 |

† Doc 03's design principles, core data-model concepts, and the immutable-versioning design remain authoritative; only its stack/hosting sections are superseded by Doc 06.

**Precedence rule.** (1) This decision log > any document body on ratified decisions. (2) Doc 06/07 > Doc 03 on platform and physical schema. (3) Later version > earlier within a number. (4) Conflicts anyone spots get logged here and resolved explicitly — never silently.

## 2. Reading paths

- **The founder / CEO (20 min):** Doc 01 §1–3 → Doc 06 §1 & §10 → Doc 05 §1 → Doc 14 §1 & §5 → this file §4 (what we must verify before her data touches anything).
- **An engineer joining the build:** 06 → 07 → 08 → 09 → 13 → 12 → their epic in 15 (01/02/05 as reference).
- **Compliance / auditor:** 02 → 09 → 07 §4–5 (audit & append-only DDL) → 12 §3/§6 (evidence machinery) → 13 §8 (contingency).
- **The AI reviewer:** 05 → 11 → 09 §10 (threat model) → 12 (eval gates).

## 3. Decision log (authoritative)

| ID | Date (2026) | Decision | Rationale / conditions |
|---|---|---|---|
| **D-001** | Jul 20 | **Stack ratified: Supabase (backend platform) + Vercel (app platform)** — client-directed, architect-endorsed | Postgres-native fit for the versioning/RLS spine; verified BAA paths on both; velocity & TCO. **Conditions:** §4 checklist green before any PHI; Doc 06 §1 risk table accepted; exit runbook maintained (Doc 13 §10). Supersedes Doc 03 stack. |
| **D-002** | Jul 20 | **AI inference: Anthropic Claude API under direct Anthropic BAA (primary); Amazon Bedrock in a minimal dedicated AWS account (fallback/multi-model).** Claude vision is the primary document-extraction engine; Textract adjunct only if degraded-scan accuracy demands | One BAA boundary; frontier multimodal extraction quality; Bedrock path preserved for resilience. Embedding-model provider under BAA = open verification item (§4). |
| **D-003** | Jul 20 | **Offline sync: PowerSync** — Cloud with BAA (HIPAA since Jan 2026) preferred; self-hosted edition in-boundary as fallback | Native Supabase integration (logical replication in, RLS-governed writes out); writes remain RLS-authorized; sync plane cannot widen access (Doc 08 §6.8). |
| **D-004** | Jul 20 | **E-signature: native click-to-sign for internal signatures** (AAL2 + content-hash binding); DocuSign under BAA for external parties only | Stronger binding to the exact record version; removes vendor round-trip from the daily clinical loop (Doc 08 §5). |
| **D-005** | Jul 20 | **Email is notification-not-content: zero PHI in email, structurally** | Takes the email provider out of the PHI supply chain entirely (Doc 08 §6.6). |
| **D-006** | Jul 20 | **PHI exists only in production.** All other environments run the synthetic Meadowbrook universe | Removes the largest accidental-exposure class; preview/staging stay fast and safe (Doc 13 §1, Doc 12 §7). |
| **D-007** | Jul 20 | **Explicit-grant Data API posture from day one** (no default table exposure) | Best practice; also pre-aligns with Supabase's 2026 explicit-exposure default rollout (Doc 07 §1–2). |
| **D-008** | Jul 20 | **A minimal AWS account is held in reserve** (Bedrock, Textract) but is *not* part of the launch boundary unless D-002 fallback triggers | Keeps the vendor surface minimal without closing doors. |
| — | earlier | Two-engine doctrine (deterministic vs. AI); "AI proposes, licensed human disposes"; T0–T3 autonomy tiers; append-only + hash-chain + keep-both; multi-tenant SaaS-ready schema | Doc 05 §1–2, Doc 03/07 — reaffirmed unchanged on the new stack. |
| **D-009** | Jul 21 | **Phase 1 resequenced wedge-first (records spine first):** S1 identity/clients · S2 forms engine · S3 credentials+cadence · S4 scheduling+guardrails+exec dashboard · S5 mobile foundation · S6 EVV+onboarding · S7 doc-intelligence+Brain+scorecard+M0 · S8 field completeness+hardening+UAT. Same total scope as Doc 15; order changes only. | Design doc `admin-main-design-20260721-180844` (approved, 3-round adversarial review). Deltas: Doc 15 §3/§4 (ST-031 splits into ST-031a/b; ST-030–033 move), Doc 15 §6 (D-Q16 gates S6; Checkr gates S6), Doc 00 §4 V8 "Before S5"→"Before S6", V5/V6 "Before S6"→"Before S7", `plan/backlog.yaml` sprint fields, Doc 14 §5 (M0 at S7–S8). Velocity checkpoint at S1 retro (>25% slippage → re-baseline). |
| **D-010** | Jul 21 | **Accepted expansions (SELECTIVE EXPANSION review):** ST-101 thin survey-evidence packet at S4 (reclassified: unscheduled baseline scope from Doc 08 §3 / Doc 12 §4) · ST-102 Meadowbrook demo tenant · ST-103 spec-corpus drift gate in CI · ST-104 founder-knowledge capture from S1 (dark until V1/V2; policy-only content, capture-time redaction) · ST-105 timed mock survey drill in S8 UAT. Skipped: founder pulse digest. If the S1 velocity checkpoint fails, expansions are first-cut (E4 exempt). | CEO plan `ceo-plans/2026-07-21-careos-phase1-resequence.md` (3-round adversarial review). |
| **D-011** | Jul 22 | **Schema-core hardening (deviations from Doc 07 DDL, from the 11-section deep review):** (1) `audit.compute_chain` serializes per-tenant appends via advisory xact lock + deterministic canonical hash input — the specced trigger forks under concurrent inserts; (2) function EXECUTE privileges revoked by default; `app.emit_audit` has no client grants (was a forgeable-ledger endpoint); `app.emit_audit_system` added for workers (service_role only); (3) `signature.content_hash` bound by composite FK to `form_version(id, content_hash)` — constraint-true e-sign; (4) `form_instance`/`form_version`/`signature` have no client write grants — all mutations via the Lane-B RPC catalog (transition-guard-by-privilege; version_no server-assigned; keep-both detection in `app.save_draft`); (5) `audit_anchor` PK is (tenant_id, day); (6) client `geo`/`geofence` defer to the EVV migration and `medicaid_id` defers to the Vault migration (never plaintext). Full findings: `docs/reviews/2026-07-21-ceo-deep-review-raw.json` (106 findings; triage pending). | Doc 07 §4–5 amendments pending; migrations 0001–0006 implement. |
| **D-012** | Jul 23 | **Design-system rebrand to an "Apple 2026" visual language — client-directed** (this session), superseding the Doc 10 §3 tokens. Changes: type Inter → **Instrument Serif (display/large-titles/numerals) + Instrument Sans (all UI, 400/500/600)**; accent teal-700 → **Apple system blue `#007AFF`** (AA text variant `#0058b8`); warm-stone surfaces → **Apple systemGray cool ramp** (`#f2f2f7` grouped canvas, white panels); added translucent "material" chrome (frosted sidebar/bars), larger continuous-corner radii, softer elevation, CSS spring motion. **Token *names* preserved so every surface re-skins from `globals.css`.** **Conditions (invariants held, non-negotiable):** WCAG 2.1 AA contrast; compliance/status = color + icon + label (never color alone); four-state doctrine; `prefers-reduced-motion`/`-transparency` honored; plain-language voice; no new runtime deps / no GSAP on field surfaces (CSS-only motion, budgets intact); zero data-flow/PHI changes (visual-only). **Open tradeoff to revisit:** Doc 10 §3 ratified **dark mode for night-shift caregivers** — this rebrand is **light-only** (client-confirmed "no dark mode for now"); flagged for founder sign-off before pilot, easy to restore. Doc 10 §3 body aligned in v1.1. | Client directive, session 2026-07-23. Foundation: `apps/web/src/app/globals.css` (+ `layout.tsx`, `ui.tsx`, `shell.tsx`, `icons.tsx`). |
| **D-013** | Aug 1 | **OpenAI ratified as the primary model provider — user decision (2026-08), superseding D-002 / Doc 11 Anthropic-direct.** Resolves the Doc 16 §3.5 divergence: the built v1 AI plane (`apps/web/src/lib/ai/client.ts`, migration 0014) and all Doc 16 waves run on OpenAI (workhorse gpt-5.6-luna, synthesis gpt-5.6-terra, transcription gpt-transcribe, embeddings text-embedding-3-small; model IDs pinned per capability in the `ai_capability` registry). **STT consolidates on OpenAI transcription, replacing Doc 11's Deepgram** (one BAA fewer; V7 Deepgram row void). **Conditions (non-negotiable):** OpenAI **BAA + Safety-Retention provisioning executed and registered in docs/09 §6 before any real PHI enters a prompt** (V4 now reads OpenAI, not Anthropic); until then synthetic/de-identified only per D-006; per-workload ZDR-eligible lanes for synchronous PHI paths, BAA/Safety-Retention lane for Batch/Files; fine-tuning and `store:true` capture remain synthetic-or-de-identified only, forever (Doc 16 §3.3). D-008's reserve AWS account is unchanged as the fallback path. | Doc 16 §3/§7 proposal ratified by user direction, 2026-08. Implemented: migrations 0014–0015, `zz_ai*.sql` seeds. Doc 11 provider sections + docs/09 §6 vendor-register amendment pending. |

| **D-014** | Aug 3 | **Form definitions are immutable and records are bound to them.** `form_template` gains `schema_hash` (stamped BEFORE INSERT) + `unique(id, schema_hash)` + an `app.forbid_mutation()` trigger; `form_version` gains `(template_id, template_schema_hash)` bound by composite FK and derived for every insert path by `app.set_form_version_binding()`. | Closes the historical-rendering hole at the constraint layer, applying the D-011 e-sign pattern one level up. `form_template` was the only consequential table with no append-only trigger, so a single UPDATE of `schema` silently changed what a signed record appeared to say — untested as well as unenforced. Expand-only; no grant changes. **Note:** a GENERATED column is rejected by Postgres ("generation expression is not immutable" — the jsonb→text cast is STABLE); the trigger is equivalent *only because* the table is now append-only, so the two changes may not be separated. Migration 0017; pgTAP `0017_definition_binding.sql`. |
| **D-015** | Aug 3 | **Legal authority is a structured, append-only, global catalog** (`public.legal_authority`) on the ratified `public.permission` pattern — no `tenant_id`, RLS enabled+forced, permissive read policy, zero write grants, non-AAL2. Publication requires a named human verifier **and** a source-document checksum (CHECK `authority_published_requires_human`); the only write path is `app.publish_authority`, gated on a new `compliance.authority.publish` permission. | "Legal authority" had forked at n=2 tables, and the weaker fork (`cadence_rule.comar_source_ref`, seeded with the literal placeholder `Doc 02 §3 — enrich with COMAR cite`) rendered to users under a "Regulation" heading behind a shield icon. `verified_by` is an FK to `public.app_user`, so an AI capability — which has no row there — can never satisfy it: the "no AI-authored requirement" rule enforced in Postgres rather than asserted in a prompt. **Conditions:** the free-text columns are deprecated, not dropped; contraction needs its own migration + decision entry. **docs/02 must be located (V13) before any authority is promoted past `unverified`.** Migration 0018. |
| **D-016** | Aug 3 | **The cadence engine states periods in the regulation's own units, and its clock is injectable.** `cadence_rule` gains `interval_months`; `app.cadence_period(days, months)` is the single interval source; `app.evaluate_compliance()` is replaced by `app.evaluate_compliance(p_today date default current_date)` and implements the previously dead `on_admission` trigger kind as a one-shot obligation. | COMAR 10.07.05.12 sets nursing supervision at 45 days / **3 months** / **4 months**; the engine encoded 90 and 120 days. From 2026-03-01 those diverge by two days — two days of a missed supervisory visit. Clock injection makes temporal correctness testable at all. **The old zero-arg function is dropped, not overloaded** — `create or replace` with a new signature overloads, making `app.evaluate_compliance()` ambiguous and breaking the ops cron; caught by 0009's existing pgTAP suite. `on_event` is left explicitly unimplemented rather than half-built. Migration 0019. |
| **D-017** | Aug 3 | **Regulatory citations enter the corpus as `unverified` and are promoted only by a human.** The Maryland COMAR authorities seeded by 0019 carry `review_status='unverified'`, `verified_by` NULL, `source_sha256` NULL, and a note recording how and when they were read. The compliance UI shows the shield icon only when `cadence_rule_authority.authority_is_verified` is true. | They were read from primary COMAR text on 2026-08-02 via the third-party mirror `mdrules.elaws.us`; Maryland's official COMAR home moved to **regs.maryland.gov** in March 2026 and did not respond to automated retrieval. No licensed human has reviewed them and docs/02 is absent. A pgTAP assertion fails if any Maryland rule ever renders as verified without a verifier. **Unresolved conflict for counsel (V14):** COMAR 10.07.05.15 states 5 years' retention after discharge and cites Health-General §4-403, whose current text reads 7 years after the record is made. No retention rule is seeded. |
| **D-018** | Aug 3 | **Global (tenant-less) catalog tables are a ratified class**, declared via a mandatory `scope: tenant\|global` key in `matrix.yaml` and enforced by `scripts/check-matrix.sh`. | `001_schema_invariants` asserts RLS enabled+forced on every table but **never asserts `tenant_id` presence**, so a table missing `tenant_id` by accident was indistinguishable from a deliberate global catalog. `public.permission` has been such a catalog since 0002 without the convention being written down. Resolves docs/07 §1's "every domain table carries `tenant_id`" against an existing compliant deviation. |
| **D-019** | Aug 3 | **The pgTAP matrix-coverage gate is real.** `scripts/check-matrix.sh` enforces: every table has an entry; every entry has a table; every entry declares `scope`; `append_only: true` matches the actual `forbid_mutation` triggers in both directions; every listed test file exists. Wired into CI as its own job. Local design-note markers renamed `D-0008a` → `DN-0008a`. | `matrix.yaml`'s header had claimed this script failed CI since 0005; it did not exist. The `D-0008a` markers collided with the reserved `D-nnn` namespace and tripped the drift gate as a phantom `D-000` citation — which was failing on `main` until this change. |
| **D-020** | Aug 4 | **Machine AAL2: non-human actors act as themselves, under the same perimeter.** Every AI agent and queue worker acts under its own per-agent `kind='system'` `app_user` row (the docs/09 §2 service-identity pattern) with a dedicated per-agent role granting **only its charter's permissions**. The worker holds the project's JWT signing secret (Edge Function secret, 90-day rotation per docs/09 §5) and mints **≤5-minute** JWTs with `sub` = the agent's `app_user` id and `aal='aal2'` — for `kind='system'` principals, AAL2 is satisfied by **signing-key custody rather than TOTP**, scoped exclusively to broker-minted short-TTL tokens. RLS applies to agents exactly as to humans (invariant 9 extends to agents); retrieval and writes run under the agent's own identity, so `app.emit_audit` attributes every action correctly. **Guardrails ratified with it:** a per-agent kill switch (`agent_identity.enabled` + `feature_flag`); a DB trigger pinning `ai_proposal_event` dispositions to `kind='staff'` actors — agents propose, humans dispose, invariant 8 made structural; and the onboarding human-verifier trigger (0033). | Closes S1-3/S3-2/S5-11 — the "no minting component exists" finding: agents previously had no identity to act under, so agent work either couldn't run or would have run privileged. **Alternative rejected:** adding `or is_system_actor()` to every PHI policy — ~40 policy edits and a permanent legibility cost; one broker beats forty exemptions. Migration 0035 (agent identity), riding 0027 (outbox) and 0034 (cron/heartbeat). |
| **D-021** | Aug 4 | **Staff-lifecycle workflows H1–H4 join the automation map (Doc 16 §2.8).** Doc 16 §2 mapped no offboarding, hiring-pipeline, training-tracking, or background-check workflow. Ratified: **H1** hiring pipeline (deterministic readiness via `employee_file_status`; Owner disposes the hire, Coordinator disposes drafts) · **H2** offboarding (revocation saga 0032 is deterministic; **the system never proposes termination** — separation is always human-initiated, automation begins after the human act) · **H3** in-service/training tracking (hours ledger = `credential(category='training')` + staff-side obligations, deterministic) · **H4** background-check orchestration (**adjudication is a permanent human anti-capability, FR-AI-052**, enforced structurally by the `verified_by` FK + human-verifier trigger 0033; Checkr gated on V8; the Maryland CHRC two-pathway question — Health-General §19-1902 vs Board of Nursing — stays an HR-advisor item, never auto-resolved). | The staff lifecycle spine (invite → onboard → credential → schedule → separate) landed in migrations 0027–0033 but was unmapped in Doc 16, so automation would otherwise have grown around it ad hoc. Deterministic gates decide; LLMs draft outreach and narratives only (T2). The H rows reuse the existing C9/C4/C5/C1/C3/C8/O4/X5 machinery rather than duplicating it. Full rows: Doc 16 §2.8. |
| **D-022** | Aug 9 | **The responsive web app is the caregiver EVV surface. The "no native mobile app" claim asserted in migration 0013's header is retro-ratified here, and D-003 (PowerSync) is narrowed to a future-optional lane rather than the Phase-1 field plan.** Offline capture is a **PWA + IndexedDB queue replaying through the same Lane-B RPC**, made safe by the `client_event_id` idempotency key (Doc 17 §4.4), not by a sync engine. Doc 15 E07/ST-032 (Expo shell) and ST-033 (PowerSync read path) are **withdrawn from Phase 1**; V3 (PowerSync BAA) is consequently **not launch-blocking** and moves to the future-optional register. | Migration 0013 shipped a working browser clock-in in the ST-013 wave whose header cited "Decision (docs/00 §3): NO native mobile app" — **a decision that was never logged**. The corpus and the code have therefore disagreed since 0013 landed, and every subsequent EVV story would have compounded the divergence. Ratifying the built direction (rather than reverting a working surface) is the cheaper and more honest close, but it is a *narrowing of D-003*, not a silent supersession: PowerSync remains the ratified answer **if** a native app is ever built. **Conditions:** the browser surface inherits the docs/09 §2 device-posture obligations that were written for a managed app — a web-specific posture section is required before pilot (see V19); offline events are never presented as ordinarily verified (Doc 17 §7.6). |
| **D-023** | Aug 9 | **`visit` is the scheduled care event; `shift` is the caregiver roster window.** Migration 0011's naming wins over docs/07 §6's inverted usage. EVV columns attach **additively to the existing `public.visit` row**; no second visit table is created, ever. | 0011's own header made this reconciliation a required deliverable of "the S4 EVV migration" and flagged it rather than deciding it. Two live vocabularies (docs/07 §6 vs 0011) plus the board proposal's third would have made every downstream query ambiguous. The built naming wins because ~30 migrations, the scheduling RPC layer, the outbox event names (`visit.assigned`, `visit.vacated`) and the UI already speak it; docs/07 §6 is amended to match. |
| **D-024** | Aug 9 | **Verification, approval, payroll and EVV are four orthogonal state axes on `visit`, not one enum.** `verification_status`, `approval_status`, `payroll_status`, `evv_status` are independent columns, each a *projection* of an append-only ledger (`visit_event`, `visit_exception`, `approved_work_segment`, `evv_submission`). `visit.status` keeps its existing care-delivery meaning. **Table-wide UPDATE on `public.visit` is revoked from `authenticated` and re-granted column-by-column**, so the four projection columns and the two binding columns are writable only by definer RPCs. | The board proposal specified a single 19-state machine, which cannot express ordinary daily combinations ("verified but unapproved", "approved but EVV-rejected") without a state explosion, and would have forced illegal states to be representable. Four axes are independently testable and independently auditable. The column-grant tightening is a genuine privilege reduction over 0011's table-wide grant and is asserted in pgTAP. |
| **D-025** | Aug 9 | **Address normalisation is deterministic and in-database; geocodes are human-verified or adapter-supplied. No geocoding vendor is added to the boundary.** `app.normalize_address()` is a pure `immutable` SQL function (USPS-style suffix/directional folding); `service_location_version` carries `geo`, `geo_precision`, `geo_source`, `geo_provider*` and a **required human attestation** (`verified_by` + `verified_at`, CHECK-enforced) before a location counts as verified. The vendor seam exists and is **disabled**. | The board proposal named Google's Address Validation API. Client addresses are PHI, and **Google Maps Platform is not among Google's BAA-eligible services** — adopting it would have been a HIPAA finding, not a feature. It is also unnecessary: geofence evaluation needs a *trusted coordinate*, and a coordinator confirming a pin once at intake is more defensible than an API guess. Registering a BAA-eligible provider later is a `geo_source='provider'` row and an adapter, with no schema change. The `verified_by` FK to `public.app_user` means an AI capability can never satisfy it (the D-015 pattern). |
| **D-026** | Aug 9 | **The EVV canonical model is state-agnostic; adapters translate.** `evv_record` carries exactly the six federally required elements; `evv_adapter` rows carry `(target, state_code, mode, enabled)`. Maryland ships as `('isas','MD', mode='reconcile', enabled=false)`. **V17 no longer blocks the build** — it decides the value of one column. | The open-vs-closed Maryland question (V17) had blocked EVV design since S0 because the corpus assumed the answer determined the architecture. It does not: in a **closed** model CareOS reconciles against ISAS as the state's system of record; in an **open** model the same canonical record flips to `mode='capture'` with an adapter implementation. Both need the identical internal record. Building Maryland's format into the database — which the board proposal explicitly warned against and which every incumbent did — is what would have made the answer load-bearing. **Condition:** no live submission endpoint is wired until D-Q16/V10/V17 resolve; the adapter ships disabled and feature-flagged. |
| **D-027** | Aug 9 | **Approved hours land in Phase 1; the payroll *ledger* is internal and export-only.** `approved_work_segment` (verified vs approved minutes, pay codes, append-only corrections) + `payroll_period` + `payroll_export` (CSV, content-hashed). No payroll vendor, no accounting book of record, no QuickBooks integration. Self-approval is structurally impossible. | This is a **scope trade under docs/15 §8**, not a silent absorption: docs/15 §2 places billing/QBO in Phase 2+, and the board asked for payroll-ready hours. The resolution splits the concern — *approving hours* is a care-operations act that belongs with the verified visit and is worthless if deferred (an unapprovable timesheet makes the whole layer decorative), while *paying* people is an accounting integration that stays Phase 2+. The clean boundary means adding a payroll provider later requires no rework of the visit spine. Doc 01's "never the accounting book of record" non-goal is preserved. |
| **D-028** | Aug 9 | **The visit trust score is deterministic evidence, never an automated adverse action.** `app.visit_trust_score` is pure SQL over six weighted components (`trust.v1`); snapshots are append-only. Administrators see bands and reasons, not unexplained numbers. Any capability that characterises an individual employee (`visit.operational_profile`) is **T2 with a required human disposer** and can write no employment record. | Invariant 8 and D-021's "the system never proposes termination" already bind here, but a per-person score is the exact artifact that erodes them by accident. Deterministic computation means a caregiver disputing a score gets an arithmetic answer, not a model's opinion — which is also what survives a wage-and-hour challenge. The board's "the scoring model should eventually be learned" is explicitly **not** adopted for anything employee-facing. |
| **D-029** | Aug 9 | **`app.clock_visit` is re-signed by drop-and-create, not overloaded.** The canonical signature gains six defaulted parameters (`p_client_event_id`, `p_captured_at`, `p_offline`, `p_reason_code`, `p_note`, `p_device_session_id`). Existing five-argument call sites resolve to the new function unchanged. | D-016 established that `create or replace` with a new signature *overloads* rather than replaces, and that ambiguous overloads break PostgREST's named-argument resolution — the exact failure that broke the ops cron. Dropping first and re-creating with defaults preserves every caller while making the new capture fields additive. The 0013 pgTAP file is updated to the new signature in the same commit (a signature change, not a weakened assertion). |
| **D-030** | Aug 9 | **Caregiver location is PHI-by-linkage and its capture points are closed.** Coordinates are captured **only** at clock-in and clock-out. No continuous tracking, no background location, no mid-visit polling. Coordinates never enter audit payloads, outbox payloads, notification payloads, telemetry, or any AI prompt; the caregiver UI is shown a `distance_bucket` (`inside`/`near`/`far`), never metres. Observability breakdowns by **geography are prohibited**; by browser/org/service type are permitted. | A caregiver's coordinates at a visit reveal the client's home address, so location is PHI about the *client* and workforce PII about the *caregiver* simultaneously — a dual classification the corpus had not stated. Migration 0013 already excluded lat/lng from audit payloads; this generalises that instinct into a closed rule before ten new surfaces each make their own decision. The `distance_bucket` return is deliberate: a caregiver being told they are "312 m away" is surveillance-grade precision serving no operational purpose. |

### Proposed decisions awaiting ratification (ST-231, drafted 2026-08-12 — NOT ratified)

These four are **proposals**, not decisions. None carries a D-number until the founder
ratifies it; nothing below may be cited as ratified. They are the W0 deliverable of the
Front Door program (docs/designs/intelligent-front-door.md) — each blocks a named later
wave and nothing else.

**PD-1 · Messaging posture** (blocks any messaging build). CareOS has no in-platform
messaging; coordination happens off-platform, which is evidence the agency does not have.
Options: **(a) entity-anchored threads** — conversations attach to a visit, client, or
exception; append-only message ledger; RLS scoped to the parent entity's care team;
recommended by the CEO review as the narrowest PHI surface with the highest audit value —
**(b)** free-floating channels/DMs (Slack shape; widest PHI surface, weakest anchoring to
evidence), or **(c)** defer entirely. Non-negotiables under any yes: message content is
PHI (invariant 5) — push/notification payloads carry IDs only; append-only history
(invariant 1); retention + legal-hold coverage before launch; no PHI in Realtime payloads.

**PD-2 · Revenue cycle** (blocks any billing build). Options: **(a) export boundary** —
CareOS produces claim/invoice-ready artifacts with content hashes (the D-027
`payroll_export` pattern) and an accounting vendor of record consumes them; recommended:
it preserves doc 01's "never the accounting book of record" non-goal — or **(b)** CareOS
becomes the biller (claims submission + private-pay invoicing in-product). Open inputs
either way: the Maryland Medicaid claims path given ISAS as system of record (extends
D-Q16/V10/V17), and the vendor choice (QuickBooks-class) which requires a docs/09 §6
register entry + BAA analysis before any data flows. Money stays rules-engine work
(invariant 13) under both options.

**PD-3 · Web-push channel registration** (blocks Front Door W6b only; W6a install page is
unaffected). Web push transits browser vendors' push services — **FCM (Google), Apple
Push, Mozilla autopush** — a third-party data flow absent from the docs/09 §6 register,
which CLAUDE.md requires proposing before building. Scope if ratified: §6 register entry
(payloads are IDs + closed-map titles only, zero PHI — the 0039-M4 posture); a
`push_subscription` table (RLS + matrix + pgTAP); `'push'` added to the 0036
`notification.channel` CHECK; VAPID key custody per docs/09 §5; sender rides the existing
worker/queue plane; flag `front_door.push`, default off.

**PD-4 · Voice audio retention** (blocks Front Door W3's voice delta). When a caregiver
records a voice note, is the raw audio (a) part of the clinical record — retained under
the same schedule as the note it produced — or (b) transient input, destroyed via the
0029 two-phase saga once the human accepts the transcript, with the transcript as the
record? The plan assumes (b); the CEO review flagged that this is a compliance decision,
not an engineering default. **Resolution must route through `careos-compliance-context` /
docs/02 — no COMAR provision may be cited from memory (D-017).** Until ratified, voice
audio is stored as a 0029 document row and nothing is destroyed.

### Proposed decision awaiting ratification (W-ONB, drafted 2026-08-13 — NOT ratified)

Same standing as PD-1..PD-4: a proposal, carrying no D-number until the founder ratifies
it, citable as nothing but a proposal. It is the decision deliverable of the W-ONB wave
(docs/15 §4.3), which is built dark behind the flag named below and blocks on this entry.

**PD-5 · First-run onboarding surface** (blocks the W-ONB flag flip and nothing else).
The corpus specifies no first-run experience, and the only ratified statement about how
people learn CareOS is docs/14 §6: the migration doubles as hands-on training —
adjudication *is* onboarding to the review UI. A first-run screen therefore either
extends that doctrine or contradicts it, which makes it a decision rather than a detail.
Options: **(a) status quo** — no first-run surface; an invited user lands on their
persona home and learns by doing real work, exactly as docs/14 §6 describes. It costs
nothing and changes nothing, and it leaves day one for a caregiver, RN or family member
as an unexplained dashboard, which is the one population docs/14 §6 does not cover:
adjudication trains the coordinator and HR staff who do the adjudicating, not the
caregiver who never touches it — **(b) a guided-real-work welcome screen** at `/welcome`
[RECOMMENDED]: a role-aware greeting and a short checklist whose every item is a real
action on a live surface (open `/today`, choose your language, open the client roster),
progress recorded per user, the screen never shown again once completed or skipped. This
**extends** the docs/14 §6 doctrine rather than competing with it — the first work is
still real work; the screen only names it, sequences it, and records that it happened —
**(c) a conventional product tour** with coachmarks over the live UI [NOT RECOMMENDED]:
it contradicts the same doctrine by teaching *about* the product instead of through it,
and it collides with the docs/10 §10 no-teaser rule, since a tour earns its keep by
pointing at features while every `front_door.*` surface is dark and renders nothing —
a tour would either point at absent things or be rewritten the week a flag flips.

**Consequences under (b).** One append-only table (`onboarding_milestone`: one row per
user per milestone, RLS enabled + forced, no direct table grants, written only by an
AAL2 RPC that emits its audit event in the same transaction) and one new route. The
surface carries no PHI — the reader's own first name, role and locale only — so it adds
no egress class and no vendor. The checklist may name only surfaces live for that tenant:
a dark feature may never appear in it, which is the docs/10 §10 rule applied to
onboarding copy. Caregiver-visible steps obey D-030's closed vocabulary. No model call is
involved, so V4 does not gate it.

**Flag and rollback.** `onboarding.welcome`, seeded **disabled** with a stated reason, per
tenant, flipped only by `app.set_feature_flag` under AAL2 + `platform.manage` (the 0052
idiom). Rollback is the flag off: the route stops being reachable and the root redirect
resumes sending every user straight to their persona home. Recorded milestones stay —
append-only history is not deleted to undo a feature (invariant 1) — and the entry check
fails closed, so a flag read that errors sends the user home rather than into onboarding.
No state of this surface can lock a user out of the product.

**Why the boundary is cheap to cross later.** (b) and (c) differ in one function — the
role-to-checklist mapping. A later ratification of (c) would add a presentation layer over
the same milestone ledger, changing no table, no RPC and no flag; a later ratification of
(a) leaves an unreachable route and an inert, flag-dark table. The expensive direction is
the one this proposal avoids: building the tour first puts teaching copy about dark
features into the product, and every word of it would have to come back out before the
first `front_door.*` flag flips.

## 4. Launch-blocking verification checklist (nothing PHI until every row is green)

| # | Item | Owner | Verify by |
|---|---|---|---|
| V1 | Supabase: Team/Enterprise org · **BAA executed** · HIPAA add-on enabled · prod project **High-Compliance** · Security Advisor zero findings | Salim | Sprint 0 |
| V2 | Vercel: **BAA executed** (Pro HIPAA add-on or Enterprise) · log-drain + scrubbing configured · decide Secure Compute (Enterprise) now-vs-later | Salim | Sprint 0 |
| V3 | PowerSync: **BAA executed** (Cloud) *or* self-host decision + deployment plan | Salim | ~~Sprint 0~~ **Not launch-blocking (D-022)** — future-optional; required only if a native app is built |
| V4 | OpenAI: **BAA + Safety-Retention provisioning executed** and registered in docs/09 §6; zero-retention posture confirmed in writing (row updated per D-013, which superseded the original Anthropic wording) | Salim | **The production-enablement gate for the entire AI plane and the Front Door program** (docs/designs/intelligent-front-door.md, W0): every AI capability runs synthetic-only until green (D-006/D-013). Target: before any `front_door.*` flag flips. |
| V5 | Embedding-model provider under BAA selected (Anthropic-partner / OpenAI-BAA / Bedrock-Titan-fallback) | AI eng | Before S6 |
| V6 | Vercel AI Gateway explicitly **out of PHI path** unless its BAA scope is verified in writing | AI eng | Before S6 |
| V7 | Deepgram BAA (voice) · Twilio BAA + 10DLC registration · Sentry BAA · log-store BAA | Salim | S0 start; blocks respective features |
| V8 | Checkr agreement + Maryland CHRC procedure documented | HR advisor | Before S5 |
| V9 | DocuSign BAA (external sign) | Salim | Before external-sign feature |
| V10 | ISAS/LTSSMaryland onboarding contact made; integration modality answered (D-Q16) | Salim + founder | S0 start (longest external lead) |
| V11 | HIPAA risk analysis v1 completed & filed (pre-launch gate) · policy set adopted (sanctions, training, contingency) | Compliance advisor | Before M0 pilot |
| V12 | Client counsel review: BAA set, consent/notice templates, breach-notification readiness | Founder + counsel | Before M0 pilot |
| V13 | **docs/02 located or reconstructed.** It is the sole cited authority for every COMAR reference in this codebase and in `careos-compliance-context`, and it is not in the repository | Founder + compliance advisor | Before any `legal_authority` row is promoted past `unverified` (D-017) |
| V14 | **Retention conflict ruled on:** COMAR 10.07.05.15 says 5 years after discharge; Health-General §4-403 says 7 years after the record is made. CareOS has no retention implementation and must not invent one | Compliance counsel | Before any retention/`retention_sweep` code |
| V15 | All Maryland COMAR citations re-verified against **regs.maryland.gov** (official home since March 2026) and attested via `app.publish_authority` with a source checksum | Compliance advisor | Before pilot; blocks any "Regulation" shield in the UI |
| V16 | Whether American Care Team holds any licence beyond the RSA (home health COMAR 10.07.10, hospice). Determines whether the MOLST mandate and 42 CFR Part 484 attach at all | Founder | Scoping of the federal layer |
| V17 | **Maryland ISAS/LTSSMaryland: open or closed EVV model?** Determines whether CareOS can capture EVV or must drive caregivers into a state app. Extends D-Q16/V10 | Salim + founder | ~~Blocks EVV design~~ **No longer blocks design (D-026)** — decides `evv_adapter.mode`; still blocks any live submission |
| V19 | **Web device-posture section for docs/09 §2.** The §2 controls (app-lock, encrypted local store, remote deactivation) and the §10 "stolen caregiver phone" threat model were written for a managed native app; D-022 makes a browser the field surface. Needs: session-lifetime policy on shared/personal devices, PWA cache scope + purge, and what replaces remote wipe | Salim + eng | Before pilot |
| V18 | Copyright / terms-of-use posture for ingesting and **redistributing** government, state and payer documents; licensed terminologies (LOINC/SNOMED/CPT) identified separately. No row exists in the docs/09 §6 register for outbound web retrieval | Counsel | Before any corpus ingestion |

## 5. Why CareOS wins (the one-table competitive thesis)

Incumbents (AlayaCare, WellSky, AxisCare, Axxess, HHAeXchange) are broad, legacy, online-first, and AI-thin. CareOS is narrow-and-deep where it matters: **provable integrity** (append-only + hash-chained audit — "show me" answered in seconds), **compliance by construction** (COMAR cadences as executable, source-referenced rules), **a field app that works in basements** (true offline-first + voice), **governed AI that actually removes admin work** (document-driven intake, the Agency Brain, tiered autonomy with a human always disposing), and **weekly-shipping velocity on a modern integrated stack**. Full table: Doc 06 §10. The commercial punchline for the founder is unchanged from Doc 01: this is not software features — it is de-risking and liberating a seven-figure business, and making her removable from the critical path *on purpose*.

## 6. Package conventions

Requirement IDs: `FR-Mx-nnn`/`NFR-x-nnn` (Doc 01), `FR-AI-nnn` (Doc 05), stories `ST-nnn` (Doc 15), decisions `D-nnn` (here), verifications `V-nn` (§4). Error codes `CAREOS_*` (Doc 08 §2). All documents are version-fronted; substantive edits bump the version and land a line in §3 or the doc's own change note. The package is maintained in the engagement repo (`docs/`) alongside the code it governs — documentation drift is treated as a bug, same as policy-catalog drift (Doc 07 §11).

### D-031 — Appearance (light/dark) and language (EN/ES) become user choices

**Date:** 2026-08-02 · **Status:** Ratified · **Supersedes:** part of D-012 (light-only)

> **Numbering note (2026-08-09):** this entry was originally written as "D-014", colliding with the
> §3 table's D-014 (form-definition immutability, migration 0017). Because `scripts/spec-drift-gate.sh`
> resolves every `D-nnn` cited in a migration against this file, one number naming two decisions was a
> live ambiguity. Renumbered to **D-031**; no migration, test, or source file cited the appearance
> decision by number, so nothing else changes.

D-012 ratified an Apple-2026 rebrand that was deliberately **light-only**. That constraint is
lifted: the product now ships a full dark appearance and a Spanish locale, both chosen by the
user from a control cluster in the top-right chrome.

**Why the reversal is safe.** The rebrand put every component on semantic tokens
(`--bg`, `--panel`, `--text`, …) rather than hardcoded colours, so dark is a token override
plus a sweep of the few literal rules — no component file changed to support it. Contrast was
computed, not eyeballed: body text 15.4:1, secondary 6.7:1, and filled buttons received
dedicated AA-verified fill tokens because Apple's vivid dark blue under white text is only
3.65:1. Printing is locked to light tokens, since evidence packets are compliance artifacts
and browsers drop background colours but keep text colours.

**Why Spanish, and why only Spanish.** `client.primary_language` already carries `es`, and
docs/16 F2 calls for Spanish family communication. A locale that serves real recorded data is
a product feature; a dropdown of half-translated languages is decoration. The dictionary is
typed so a missing Spanish key fails the build.

**Coverage, stated honestly:** application chrome (navigation, appearance/language controls,
sign-out, persona switcher) and the persona surfaces are translated. Generated content — the
huddle brief narration, AI drafts, seeded demo records — remains in the language it was
written in; translating model output is capability F2, not chrome.
