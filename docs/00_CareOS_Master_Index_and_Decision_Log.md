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

## 4. Launch-blocking verification checklist (nothing PHI until every row is green)

| # | Item | Owner | Verify by |
|---|---|---|---|
| V1 | Supabase: Team/Enterprise org · **BAA executed** · HIPAA add-on enabled · prod project **High-Compliance** · Security Advisor zero findings | Salim | Sprint 0 |
| V2 | Vercel: **BAA executed** (Pro HIPAA add-on or Enterprise) · log-drain + scrubbing configured · decide Secure Compute (Enterprise) now-vs-later | Salim | Sprint 0 |
| V3 | PowerSync: **BAA executed** (Cloud) *or* self-host decision + deployment plan | Salim | Sprint 0 (blocks mobile PHI) |
| V4 | Anthropic: API tier with **BAA executed**; zero-retention posture confirmed in writing | Salim | Sprint 0 (blocks AI features) |
| V5 | Embedding-model provider under BAA selected (Anthropic-partner / OpenAI-BAA / Bedrock-Titan-fallback) | AI eng | Before S6 |
| V6 | Vercel AI Gateway explicitly **out of PHI path** unless its BAA scope is verified in writing | AI eng | Before S6 |
| V7 | Deepgram BAA (voice) · Twilio BAA + 10DLC registration · Sentry BAA · log-store BAA | Salim | S0 start; blocks respective features |
| V8 | Checkr agreement + Maryland CHRC procedure documented | HR advisor | Before S5 |
| V9 | DocuSign BAA (external sign) | Salim | Before external-sign feature |
| V10 | ISAS/LTSSMaryland onboarding contact made; integration modality answered (D-Q16) | Salim + founder | S0 start (longest external lead) |
| V11 | HIPAA risk analysis v1 completed & filed (pre-launch gate) · policy set adopted (sanctions, training, contingency) | Compliance advisor | Before M0 pilot |
| V12 | Client counsel review: BAA set, consent/notice templates, breach-notification readiness | Founder + counsel | Before M0 pilot |

## 5. Why CareOS wins (the one-table competitive thesis)

Incumbents (AlayaCare, WellSky, AxisCare, Axxess, HHAeXchange) are broad, legacy, online-first, and AI-thin. CareOS is narrow-and-deep where it matters: **provable integrity** (append-only + hash-chained audit — "show me" answered in seconds), **compliance by construction** (COMAR cadences as executable, source-referenced rules), **a field app that works in basements** (true offline-first + voice), **governed AI that actually removes admin work** (document-driven intake, the Agency Brain, tiered autonomy with a human always disposing), and **weekly-shipping velocity on a modern integrated stack**. Full table: Doc 06 §10. The commercial punchline for the founder is unchanged from Doc 01: this is not software features — it is de-risking and liberating a seven-figure business, and making her removable from the critical path *on purpose*.

## 6. Package conventions

Requirement IDs: `FR-Mx-nnn`/`NFR-x-nnn` (Doc 01), `FR-AI-nnn` (Doc 05), stories `ST-nnn` (Doc 15), decisions `D-nnn` (here), verifications `V-nn` (§4). Error codes `CAREOS_*` (Doc 08 §2). All documents are version-fronted; substantive edits bump the version and land a line in §3 or the doc's own change note. The package is maintained in the engagement repo (`docs/`) alongside the code it governs — documentation drift is treated as a bug, same as policy-catalog drift (Doc 07 §11).
