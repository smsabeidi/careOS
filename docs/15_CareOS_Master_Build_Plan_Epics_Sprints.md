# CareOS — Master Build Plan: Epics, Stories & Sprint Map

**Client:** American Care Team (Maryland) · **Document:** 15 of 15 · **Version:** 1.1 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 04 phases on the Doc 06 stack; stories trace to Doc 01/05 FRs; gates per Doc 12; ops per Doc 13; the verified-visit layer per Doc 17.

> **Change note (v1.1, Aug 10 2026):** E08 (EVV & ISAS) and the S4/S6 EVV theme are **delivered** as ST-200…ST-216 — recorded in the new §4.1 with each acceptance criterion mapped to the pgTAP file that proves it. E07 (mobile field app & offline sync) is **withdrawn from Phase 1** under **D-022**, taking ST-032 and ST-033 with it; the offline obligation moved to the PWA queue and is delivered inside the same band. §8 records the **D-027** scope trade explicitly: approved hours came *into* Phase 1, the payroll ledger and any payroll provider stay Phase 2+.

> **Purpose.** The execution spine: who builds what, in what order, with acceptance criteria — Phase 1 planned to the story level for the first four sprints and to the epic level thereafter. This plan assumes the Doc 00 §4 verification checklist starts **day one**, because BAAs and state EVV onboarding are the true critical path, not code.

---

## 1. Team (revised for the integrated stack — leaner than Doc 04)

| Role | FTE | Notes |
|---|---|---|
| Engagement lead / architect (Salim) | 1.0 | Owns decisions, client, architecture |
| Senior full-stack (web + DB) | 2.0 | Next.js + Postgres/RLS depth |
| ~~Senior mobile (RN/Expo)~~ | ~~1.0~~ | ~~Owns PowerSync + field UX~~ — **withdrawn from Phase 1 (D-022).** The field surface is the responsive web app with a PWA offline queue, so field UX is owned by the full-stack pair and the designer. The role returns only if a native app is built |
| AI engineer | 1.0 | Pipeline, Brain, evals (pairs with full-stack) |
| Product designer | 1.0 → 0.5 after S5 | Design system + field usability |
| QA/SDET | 1.0 | Owns pgTAP/E2E/device farm |
| RN clinical SME (fractional) | 0.2 | Template/COMAR validation, UAT |
| Compliance/HIPAA advisor (fractional) | 0.1 | Risk analysis, policies, BAA review |

The Supabase/Vercel consolidation removes the dedicated infra/platform role from Doc 04's model — ops is absorbed by the team per Doc 13. Six-to-seven builders, senior-heavy: the $15M-bar strategy is *fewer, better people on a sharper spec* — which is what this document set is for.

## 2. Epic map (→ module/FR trace)

| Epic | Name | Traces to |
|---|---|---|
| E01 | Platform foundations (envs, CI/CD, monorepo, observability skeleton) | Doc 13 |
| E02 | Identity, tenancy & RBAC (auth, MFA/AAL2, roles, assignments, revocation) | M1 · FR-X-010… |
| E03 | Client management & intake | M2 |
| E04 | Forms engine: templates, versioning, signatures, finalize, conflicts | M3 · FR-X-001… |
| E05 | Audit spine & anchors | FR-X-020… |
| E06 | Scheduling & workforce guardrails | M4 |
| ~~E07~~ | ~~Mobile field app & offline sync~~ — **withdrawn from Phase 1 (D-022)**; the field surface is the responsive web app and offline capture is a PWA + IndexedDB queue, delivered inside E08 (ST-212). PowerSync returns only if a native app is built | M6 · Doc 10 §6 |
| E08 | **Verified Visit & Workforce Intelligence** (EVV & ISAS, and everything the verified record powers: places of care, visit policy, clock engine, exception engine, trust score, canonical EVV, approved hours, workforce analytics) — **delivered**, §4.1 | M5 · Doc 08 §6.1 · **Doc 17** |
| E09 | Credentials & HR workforce record | M7 |
| E10 | Compliance cadence engine & survey readiness | M8 |
| E11 | Document intelligence (intake + credentials) | FR-AI-001/002/053 |
| E12 | Agency Brain v1 + approvals inbox + AI governance plane | FR-AI-090/091 · Doc 11 §2–3,5,6 |
| E13 | Notifications, on-call & escalations | M10 |
| E14 | Exec dashboard & reporting v1 | M12 |
| E15 | Migration tooling & cutover | Doc 14 |
| E16 | Voice notes & field assistant v1 | FR-AI-011/030 |
| (Phase 2+) | Coordination agent full, billing/QBO, family portal, matching ML, analytics NL | Doc 05 §8 |

## 3. Phase-1 sprint map (2-week sprints; S0 starts at contract)

| Sprint | Theme | Headline outcomes |
|---|---|---|
| **S0** | Foundations & unblocking | BAAs executed/in-flight (Supabase+add-on, Vercel, PowerSync, Anthropic, Deepgram, Twilio, Sentry/logs) · ISAS onboarding + 10DLC + Checkr initiated · monorepo/CI/envs live · schema core migrated (tenancy, users, RBAC, audit) with pgTAP green · design tokens + component shells · Meadowbrook seed v1 |
| **S1** | Identity & clients | Invite/MFA/AAL2 flows · roles/permissions seeded · client CRUD + care-team assignment + RLS matrix proven · office shell + universal nav · revocation runbook drill #1 |
| **S2** | Forms engine core | Template runtime (5 priority COMAR forms) · draft/version/append-only · signatures + finalize RPC · conflict keep-both UX · audit trail visible on every record |
| **S3** | Scheduling + web field shell | Scheduler grid + assignment + `assert_schedulable` · shift lifecycle · `/today`: auth, Today, client card *(browser, per D-022 — the Expo shell and PowerSync read path are withdrawn)* · migration inventory crawl kicks off (Doc 14 §2) |
| S4 | EVV — **delivered as ST-200…ST-216 (§4.1)** | Clock-in/out RPC + geofence + **PWA offline queue** + exception engine · canonical state-agnostic EVV record with the ISAS adapter shipped disabled in `reconcile` mode (D-026) · live visit board · **plus, under D-024/D-027/D-028: four orthogonal state axes, approved hours + period close/export, deterministic trust score** |
| S5 | Credentials & cadence | Credential vault + expiry engine · cadence rules seeded from Doc 02 §3 · obligations dashboard + notifications/escalations · scheduling guard fully wired |
| S6 | Document intelligence + Brain v1 | Intake extraction pipeline + review UI · credential extraction · knowledge corpus ingest + Brain (policy Q&A, cite-or-abstain) · approvals inbox + capability flags + PHI-minimizer + canary suite · **the EVV-theme half of this sprint delivered with S4 as ST-209/ST-210/ST-215: workforce analytics and the four verified-visit AI capabilities (Doc 16 §2.9)** |
| S7 | Field completeness + pilot migration | Voice notes (T2) · task checklists · family-update drafts (T2, behind flag) · exec dashboard v1 · pilot cohort migrated (M0) · founder demo = full loop |
| S8 | Hardening & UAT | Perf/load, pentest window, restore drill, chaos drills · UAT tranches + fixes · wave migration (M1) begins · release-gate checklist to green |

Phase-1 exit = Doc 04 Milestone-2 acceptance: the agency runs intake→schedule→visit→document→comply→prove on CareOS for the pilot-plus cohort, parallel-run underway. (Phases 2–3 continue per Doc 04 roadmap + Doc 05 §8 AI phases — plan refresh at S8 retro.)

## 4. Story detail — Sprints 0–3 (IDs stable; ACs are the acceptance contract)

### Sprint 0
- **ST-001 Vendor gate execution** — run Doc 00 §4 checklist; every BAA signed or dated-in-flight; ISAS/10DLC/Checkr applications submitted. *AC: register (Doc 09 §6) fully populated; no red "unknown" rows; PHI embargo confirmed with client in writing.*
- **ST-002 Monorepo + CI/CD** — per Doc 13 §2–4. *AC: PR → preview stack (Vercel preview + Supabase branch) < 10 min; pgTAP stage wired; secret-scanning blocking.*
- **ST-003 Schema core migration 0001–0004** — tenancy, app_user, RBAC, helpers, audit chain, forbid_mutation (Doc 07 §3–4). *AC: pgTAP: RLS matrix on core tables, append-only probes, chain verification — all green in CI.*
- **ST-004 Environment hardening** — High-Compliance config on prod project, network restrictions, log drains, Sentry scrubbed. *AC: config manifest matches live; Security Advisor zero findings; canary-PHI test harness runs.*
- **ST-005 Design foundation** — tokens, core components, Storybook + visual regression. *AC: Doc 10 §3 tokens implemented; 10 base components with states; a11y lint on.*
- **ST-006 Meadowbrook seed v1** — synthetic universe generator. *AC: deterministic seed; edge personas present; powers local/preview/staging.*

### Sprint 1
- **ST-010 Invite → MFA → AAL2 onboarding** — *AC: staff cannot reach PHI routes at AAL1 (E2E); TOTP mandatory; recovery codes once; session policies per Doc 09 §2.*
- **ST-011 Roles & permission seeding + admin UI (read-only v1)** — *AC: Doc 01 RBAC matrix seeded; grants config-audited.*
- **ST-012 Client record + care-team assignment** — CRUD, geocoding, RLS. *AC: pgTAP matrix (admin/RN/assigned/unassigned caregiver × ops) green; off-team caregiver sees nothing (E2E).* 
- **ST-013 Office shell + universal search** — *AC: ⌘K search RLS-scoped; nav per Doc 10 §2; four-state doctrine on every screen shipped.*
- **ST-014 Access-revocation runbook + drill** — `app.revoke_user_access` + checklist. *AC: drill evidence: separated test user fully dead ≤15 min incl. mobile sync eviction.*

### Sprint 2
- **ST-020 Template runtime (JSON-Schema renderer)** — field set v1, autosave drafts. *AC: 5 priority templates (RN assessment, plan of care, visit note, consent, incident) render from `form_template` rows; autosave ≤3 s visible.*
- **ST-021 Versioning + append-only + corrections** — *AC: every save = new version; UPDATE/DELETE impossible (pgTAP); correction flow requires reason; history timeline UI.*
- **ST-022 Native signature + finalize** — *AC: finalize blocked until required roles signed (RPC test); signature bound to content hash; post-final locked with correction path only; AAL2 step-up on stale session (E2E).*
- **ST-023 Conflict keep-both UX** — *AC: simulated concurrent edit → 409 → side-by-side merge → both antecedents preserved & linked (E2E + pgTAP lineage check).* 
- **ST-024 Record audit visibility** — "History" on client/form. *AC: plain-language event stream; hash excerpt visible on final versions.*

### Sprint 3
- **ST-030 Scheduler v1** — week grid, create/assign/cancel, recurrence. *AC: `assert_schedulable` blocks lapsed-credential assignment with plain-language reason (E2E); open-shift state modeled.*
- **ST-031 Shift lifecycle + notifications skeleton** — *AC: offer/accept RPC race-safe (first-accept wins under concurrency test); ID-only payloads verified by canary.*
- **ST-032 Mobile shell** — ~~Expo auth + biometric lock + Today + client card. *AC: cold start <2 s offline on mid-tier Android; PHI screens flagged secure.*~~ — **WITHDRAWN from Phase 1 (D-022).** The responsive web app is the caregiver EVV surface; `/today` is the same Next.js application every other persona uses. The device-posture half of this story's AC did not disappear with it — it became **V19** (Doc 00 §4): a web device-posture section for Doc 09 §2 covering session lifetime on shared devices, PWA cache scope and purge, and what replaces remote wipe, required before pilot.
- **ST-033 PowerSync read path** — ~~sync rules v1 mirroring assignments. *AC: device receives only assigned-client scope; revocation eviction re-tested with sync active.*~~ — **WITHDRAWN from Phase 1 (D-022).** Offline capture is a PWA + IndexedDB queue replaying through the same Lane-B RPC, made safe by the `client_event_id` idempotency key rather than by a sync engine (delivered as ST-212). D-003 is *narrowed*, not revoked: PowerSync remains the ratified answer if a native app is ever built, and V3 (PowerSync BAA) consequently moves to the future-optional register.
- **ST-034 Migration inventory crawl** — Doc 14 §2 tooling. *AC: manifest + volume report delivered to founder; personal-drive question raised in writing.*

*(S4–S8 stories are elaborated at each sprint boundary against these same conventions. The tracker seed file `plan/backlog.yaml` this section originally referenced is **not present in the repository**; §4.1 below is written to the story level in its place for the work that has landed.)*

### 4.1 Verified Visit & Workforce Intelligence — ST-200…ST-216 (delivered)

Doc 17 is the design contract for this band and pins every table, column, function signature, permission key and error code it uses. Decisions D-022…D-030 (Doc 00 §3) are its ratified basis. Acceptance here is not a demo: **every database story's AC is mapped to the pgTAP file that proves it**, and those files run on every pull request against a from-scratch migrated database (Doc 12 §3.1).

- **ST-200 Layer ratification** — decisions D-022…D-030 logged in Doc 00 §3, Doc 17 written as the build contract, and a Docker-free pgTAP harness (`scripts/local-pg`). *AC: every table, column, function signature, permission key and error code the layer will use is pinned in Doc 17 before any migration is written; every point where the board proposal and the ratified corpus diverge is recorded with which one won and why (Doc 17 §2.1); the pgTAP suite runs locally without Docker.*

**The database layer (migrations 0043–0052 · ST-201…ST-210).** Ten migrations, ten pgTAP files, 1,718 assertions across the suite.

| Story | Migration | Acceptance criteria | Proven by |
|---|---|---|---|
| **ST-201** Places of care | `0043_geo_service_location.sql` | `app.normalize_address` is deterministic and `immutable`; geo primitives reject out-of-range input; `service_location` is PHI behind AAL2 with exactly three lawful readers; `service_location_version` is append-only at both layers; the four §6.1 RPCs are the only write path; a geocode counts as verified only with a human attestation (`verified_by` + `verified_at`, CHECK-enforced); no coordinate or address component reaches an audit or outbox payload | `tests/database/0043_geo_service_location.sql` |
| **ST-202** Visit policy | `0044_visit_policy.sql` | Tenant floor mandatory (absent ⇒ `CAREOS_POLICY_MISSING`); shipped defaults are the Doc 17 §3.4 numbers; readable by any tenant member at AAL1, writable by nobody directly; append-only at both layers; the ladder resolves client → service_type → payer_kind → tenant field-by-field; a scheduled version does not govern until it starts; `app.upsert_visit_policy` appends and refuses malformed scopes | `tests/database/0044_visit_policy.sql` |
| **ST-203** The verified visit | `0045_verified_visit.sql` | The four orthogonal state axes (D-024) exist on `public.visit` and are RPC-only — table-wide `UPDATE` revoked from `authenticated` and re-granted column-by-column, asserted not assumed; `visit_event` accepts the new event types and its idempotency key exactly once; append-only at both layers; `public.verified_visit` derives minutes from the ledger under the caller's own RLS | `tests/database/0045_verified_visit.sql` |
| **ST-204** Clock engine | `0046_clock_engine.sql` | `app.evaluate_location` is an exhaustive truth table that never returns `suspicious`; the re-signed `app.clock_visit` (D-029) keeps five-argument callers working, gates on AAL2 + assignment, replays idempotently, guards the clock sequence, binds the address and policy version at first clock-in and never re-resolves them, keeps clocking when a tenant has no policy at all, and returns a `distance_bucket` instead of metres | `tests/database/0046_clock_engine.sql` |
| **ST-205** Exception engine | `0047_exception_engine.sql` | Both append-only ledgers RLS-enclosed and immutable; five detectors deterministic, clock-injectable and idempotent (a second sweep raises nothing); corrections append with `corrects_event_id` and never overwrite; only a `kind='staff'` actor can dispose | `tests/database/0047_exception_engine.sql` |
| **ST-206** Trust score | `0048_trust_score.sql` | `trust.v1` arithmetic exact and reconstructible from its six components; snapshots append-only and definer-written; the read is verification-gated, AAL2 and tenant-scoped; reason codes come from a closed vocabulary — **no learned model, no automated adverse action** (D-028) | `tests/database/0048_trust_score.sql` |
| **ST-207** Canonical EVV | `0049_evv_canonical.sql` | `evv_record` carries exactly the six federally required elements and is state-agnostic; completeness object and its conjunction constraint-true; canonical hash stable under a no-op rebuild and moves when an element moves; **a disabled adapter is a no-op, not an error** (D-026); the worker lane is `service_role`-only with idempotent replays | `tests/database/0049_evv_canonical.sql` |
| **ST-208** Payroll boundary | `0050_payroll_boundary.sql` | `approved_work_segment` and `payroll_export` append-only at both layers; `payroll_period` no-delete, status-mutable, RPC-only; **self-approval refused by the RPC *and* by a CHECK**; rounding half-away-from-zero at the policy's grain; an open `critical` exception blocks approval and a dismissed one does not; a period will not close while a completed visit waits on a human, and says how many; the export carries a stable `content_sha256` and names no client (D-027) | `tests/database/0050_payroll_boundary.sql` |
| **ST-209** Workforce analytics | `0051_workforce_analytics.sql` | Supporting views are `security_invoker`; `app.workforce_features` and `app.evv_observability` refuse an AAL1 session, a principal without `workforce.read`, an incoherent window and a foreign caregiver; the definer aggregate is pinned to the caller's tenant; every Doc 17 §10 metric is exactly the arithmetic the fixture implies, including the 7-element Sunday–Saturday lateness array; neither view leaks a coordinate or a raw accuracy radius | `tests/database/0051_workforce_analytics.sql` |
| **ST-210** Visit AI registry | `0052_visit_ai_capabilities.sql` | The four Doc 17 §11 capabilities register idempotently with a pinned model and a budget cap; **the database refuses to register `visit.operational_profile` without a human disposer**, on INSERT and on later UPDATE (invariant 8, D-028); registry and flags are read-only from the client; the two dark flags read `false` even when the call site defaults `true`; the only pen on a flag is `app.set_feature_flag` under AAL2 + `platform.manage` | `tests/database/0052_visit_ai_capabilities.sql` |

**The application layer (ST-211…ST-216).** The six stories landed together in one commit; the split below is the workstream split that commit describes. **These stories shipped with no automated test coverage of their own.** Their acceptance evidence is `pnpm typecheck` clean, 52 migrations applying from scratch, seeds idempotent across two consecutive runs, the RPCs they call proven at the database layer above, and manual walk-through. Their journeys are specified as J1–J7 in Doc 12 §4.1 and the harness is being provisioned separately; until a run is green in CI those specs are a plan, not coverage (Doc 12 §2). This is the single largest test debt in the band and is named here rather than left to be discovered at a release gate.

| Story | Delivered | Acceptance criteria |
|---|---|---|
| **ST-211** Caregiver clock flow (`/today`) | The clock control as a state machine over the RPC's four real outcomes; multi-pass position acquisition (tightest fix, early exit at 60 m, hard 8 s cap); the reason picker | Two actions ever; the exception path never blocks care; `distance_bucket` renders as words; **no caregiver-visible string contains GPS, geofence, radius, accuracy, metres or EVV** (Doc 10 §6) |
| **ST-212** PWA offline capture | Service worker + IndexedDB queue; the three-state indicator; the replayer | One idempotency key per user-initiated attempt, reused across retry and fallback, so a lost response cannot double-clock; the worker is an allowlist — non-GET, cross-origin and navigations are never cached, so no PHI response can enter the cache; the queue holds no name, address or free text; a refused replay is surfaced, never swallowed |
| **ST-213** Operations console | `/operations` live board, exception inbox, attendance, timesheets with approval and period close/export, EVV console, workforce surface | Each sub-surface gated on its Doc 17 §5 permission key; **queue ranking is deterministic in TypeScript** (severity × recency × payroll impact × client risk — invariant 13), with the caregiver's identity and the client's condition deliberately excluded as inputs; four-state doctrine on every screen |
| **ST-214** Places of care + policy editor | `/operations/locations` geocode attestation; `/settings/visit-policy` with inheritance preview | A pin is verified only by a named human (D-025) — the one surface where displaying a coordinate is legitimate, because someone is attesting to it; every policy save appends a version with a reason |
| **ST-215** Visit AI capabilities | `apps/web/src/lib/ai/visit-intelligence.ts` — the four capabilities on the `huddle.ts` pattern | Deterministic facts collected first; `to*PromptFacts()` **is** the declared PHI allowlist; strict response schemas; a parse guardrail drops any sentence carrying a number the model was not given, and any sentence that reads as an employment action; narration is additive and every figure renders without it; `visit.operational_profile` is T2 with a required human disposer and can write no employment record (D-028, D-021) |
| **ST-216** Meadowbrook verified-visit seed | `supabase/seeds/zz_verified_visit.sql` | Synthetic only (D-006); every derived value produced by the shipped engine that owns it, so fixtures cannot drift from the rules they illustrate; idempotent across consecutive runs; `app.sweep_visit_exceptions(now())` returns zero new exceptions against a freshly seeded database |

**Known gaps carried out of the band, stated plainly:** no live EVV submission endpoint until V17/D-Q16 resolve (the adapter ships disabled and feature-flagged, D-026); the web device-posture section for Doc 09 §2 is outstanding (V19); the Doc 12 §4.1 journeys and the egress half of the coordinate canary are unbuilt; and no client geocoding vendor exists by design (D-025) — pins are human-attested at intake.

## 5. Definition of Done (every story)

Code reviewed · tests at the right layer added (pgTAP for any schema/policy touch — non-negotiable) · a11y pass on new UI · audit events for consequential actions · docs/runbook deltas written · feature-flagged if risk >low · demo-able on preview URL.

## 6. Critical path & external dependencies (watch list)

BAA execution set (S0) → **PHI embargo lifts only when green** · ISAS onboarding/modality answer (D-Q16/V17) → **no longer gates EVV design (D-026)**; it decides the value of one `evv_adapter` column and gates live submission only, which ships disabled and feature-flagged until it resolves · 10DLC approval → gates SMS in S3+ (in-app notification fallback ready) · Checkr account → gates onboarding flow in S5 · **V3 (PowerSync BAA) removed from the critical path (D-022)** — future-optional, required only if a native app is built · **V19 (web device-posture section for Doc 09 §2) added — required before pilot** · Founder time: 2 h/week structured (demo + decisions) — protected in the engagement calendar · pilot cohort staff availability for S7 UAT.

## 7. Operating rhythm

Sprint demo every 2 weeks **to the founder, on the live preview, using Meadowbrook** — each demo doubles as usability testing (Doc 10 §9) and rolling acceptance (Doc 12 §8) · weekly written status (done/next/risks/decisions-needed, one page) · decision log updated in Doc 00 §3 within 24 h of any ratified change · monthly: cost review, AI-metrics review, risk-register refresh · S8 retro produces the Phase-2 plan revision.

## 8. Top delivery risks (beyond Doc 04's register)

| Risk | Mitigation |
|---|---|
| BAA/tier friction (any vendor) with PHI features blocked | Fallback paths pre-priced: Bedrock-min-AWS (AI), self-host PowerSync, alternate log store; embargo protects compliance while features ship on synthetic data |
| ISAS modality unknowns | Earliest possible state contact (S0); pipeline built provider-agnostic behind the `evv_submission` state machine |
| Scope gravity ("boil the ocean" pulls Phase-2 items forward) | The tier system + this document are the contract; new wants → decision log + trade, not silent absorption. **Worked example — D-027 (Aug 9 2026):** the board asked for payroll-ready hours, and §2 places billing/QBO in Phase 2+. The trade was *made and logged*, not absorbed: **approved hours came into Phase 1** (`approved_work_segment` with verified-vs-approved minutes, pay codes and append-only corrections; `payroll_period`; `payroll_export` as content-hashed CSV; self-approval structurally impossible), because approving hours is a care-operations act that belongs with the verified visit and is worthless if deferred — an unapprovable timesheet makes the whole layer decorative. **The payroll ledger and every payroll provider stay Phase 2+**: no accounting book of record, no QuickBooks integration, no pay rates, no money. Doc 01's "never the accounting book of record" non-goal is preserved, and the clean boundary means adding a provider later requires no rework of the visit spine. This is the shape every future trade should take — a named decision, a stated boundary, and a reason the boundary is cheap to cross later |
| Founder bandwidth | The 2 h/week structure + async Loom demos; RN SME absorbs clinical-detail load |
| Adoption stall among non-technical staff | Doc 04 §7 plan + pilot-cohort champions + the migration-as-training effect (Doc 14 §6) |
