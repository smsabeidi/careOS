# CareOS — Master Build Plan: Epics, Stories & Sprint Map

**Client:** American Care Team (Maryland) · **Document:** 15 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 04 phases on the Doc 06 stack; stories trace to Doc 01/05 FRs; gates per Doc 12; ops per Doc 13.

> **Purpose.** The execution spine: who builds what, in what order, with acceptance criteria — Phase 1 planned to the story level for the first four sprints and to the epic level thereafter. This plan assumes the Doc 00 §4 verification checklist starts **day one**, because BAAs and state EVV onboarding are the true critical path, not code.

---

## 1. Team (revised for the integrated stack — leaner than Doc 04)

| Role | FTE | Notes |
|---|---|---|
| Engagement lead / architect (Salim) | 1.0 | Owns decisions, client, architecture |
| Senior full-stack (web + DB) | 2.0 | Next.js + Postgres/RLS depth |
| Senior mobile (RN/Expo) | 1.0 | Owns PowerSync + field UX |
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
| E07 | Mobile field app & offline sync | M6 · Doc 10 §6 |
| E08 | EVV & ISAS integration | M5 · Doc 08 §6.1 |
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
| **S3** | Scheduling + mobile shell | Scheduler grid + assignment + `assert_schedulable` · shift lifecycle · Expo app: auth, Today, client card · PowerSync sync rules v1 (read path) · migration inventory crawl kicks off (Doc 14 §2) |
| S4 | EVV | Clock-in/out RPCs + geofence + offline queue + exceptions · ISAS sandbox submission state machine · live visit board |
| S5 | Credentials & cadence | Credential vault + expiry engine · cadence rules seeded from Doc 02 §3 · obligations dashboard + notifications/escalations · scheduling guard fully wired |
| S6 | Document intelligence + Brain v1 | Intake extraction pipeline + review UI · credential extraction · knowledge corpus ingest + Brain (policy Q&A, cite-or-abstain) · approvals inbox + capability flags + PHI-minimizer + canary suite |
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
- **ST-032 Mobile shell** — Expo auth + biometric lock + Today + client card. *AC: cold start <2 s offline on mid-tier Android; PHI screens flagged secure.*
- **ST-033 PowerSync read path** — sync rules v1 mirroring assignments. *AC: device receives only assigned-client scope (verified against fixture matrix); revocation eviction re-tested with sync active.*
- **ST-034 Migration inventory crawl** — Doc 14 §2 tooling. *AC: manifest + volume report delivered to founder; personal-drive question raised in writing.*

*(S4–S8 stories exist at outline level in the tracker seed file `plan/backlog.yaml` shipped with this package; they are elaborated at each sprint boundary against these same conventions.)*

## 5. Definition of Done (every story)

Code reviewed · tests at the right layer added (pgTAP for any schema/policy touch — non-negotiable) · a11y pass on new UI · audit events for consequential actions · docs/runbook deltas written · feature-flagged if risk >low · demo-able on preview URL.

## 6. Critical path & external dependencies (watch list)

BAA execution set (S0) → **PHI embargo lifts only when green** · ISAS onboarding/modality answer (D-Q16) → gates S4 real submissions (sandbox/state fixtures otherwise) · 10DLC approval → gates SMS in S3+ (in-app push fallback ready) · Checkr account → gates onboarding flow in S5 · Founder time: 2 h/week structured (demo + decisions) — protected in the engagement calendar · pilot cohort staff availability for S7 UAT.

## 7. Operating rhythm

Sprint demo every 2 weeks **to the founder, on the live preview, using Meadowbrook** — each demo doubles as usability testing (Doc 10 §9) and rolling acceptance (Doc 12 §8) · weekly written status (done/next/risks/decisions-needed, one page) · decision log updated in Doc 00 §3 within 24 h of any ratified change · monthly: cost review, AI-metrics review, risk-register refresh · S8 retro produces the Phase-2 plan revision.

## 8. Top delivery risks (beyond Doc 04's register)

| Risk | Mitigation |
|---|---|
| BAA/tier friction (any vendor) with PHI features blocked | Fallback paths pre-priced: Bedrock-min-AWS (AI), self-host PowerSync, alternate log store; embargo protects compliance while features ship on synthetic data |
| ISAS modality unknowns | Earliest possible state contact (S0); pipeline built provider-agnostic behind the `evv_submission` state machine |
| Scope gravity ("boil the ocean" pulls Phase-2 items forward) | The tier system + this document are the contract; new wants → decision log + trade, not silent absorption |
| Founder bandwidth | The 2 h/week structure + async Loom demos; RN SME absorbs clinical-detail load |
| Adoption stall among non-technical staff | Doc 04 §7 plan + pilot-cohort champions + the migration-as-training effect (Doc 14 §6) |
