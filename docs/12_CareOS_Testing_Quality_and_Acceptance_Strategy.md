# CareOS — Testing, Quality & Acceptance Strategy

**Client:** American Care Team (Maryland) · **Document:** 12 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** verification for Docs 01–11; acceptance mechanics for Doc 04 milestones; release gates referenced by Doc 13 CI.

> **Purpose.** In a compliance product, tests are not engineering hygiene — they are the *evidence* that the guarantees we sell (nothing lost, least privilege, cadences enforced, AI governed) are true, continuously. This document defines what is tested, how, with what data, and what "done" and "accepted" mean.

---

## 1. Quality philosophy

1. **The guarantees get the strongest tests.** Append-only, RLS, audit chain, cadence math, EVV integrity, and AI tier-gating are tested *in the database*, where they're enforced — not just through the UI.
2. **Traceability is a deliverable.** Every FR/NFR maps to named tests; the matrix is generated, versioned, and shown at acceptance. "Prove it" is answerable for requirements, not just records.
3. **Synthetic data only outside production.** No exceptions, ever (D-006). A seeded persona universe ("Meadowbrook" dataset: 25 clients, 40 staff, 90 days of visits, deliberate edge cases) powers every environment and demo.
4. **Test the failure modes on purpose.** Offline, conflict, ISAS-down, AI-down, low-confidence, injection — the degraded paths are release-gated, because that's where trust is won or lost.

## 2. The pyramid (tools & scope)

| Layer | Tooling | Scope highlights |
|---|---|---|
| Static | TypeScript strict, ESLint (custom rules: no-PHI-in-logs, no-raw-model-fetch, translation-keys), secret-scanning, dependency audit | Every PR |
| Unit | Vitest (web/packages), RN testing-library (mobile) | Forms-runtime logic, minimizer allowlists, matching scorer, cadence date math (property-based for intervals/DST), utils |
| **Database** | **pgTAP** in CI against migrated ephemeral DB | §3 — the crown-jewel suite |
| API/contract | Vitest + supertest against preview env; recorded-fixture contract tests per integration (ISAS payloads, Twilio, Checkr, QBO, DocuSign) | Error codes, idempotency replay, pagination, webhook signature rejection |
| E2E web | Playwright | §4 critical journeys, a11y (axe) scans, visual regression (Storybook + key screens) |
| E2E mobile | Maestro (+ Detox where needed) on device farm | §4 incl. the **airplane-mode suite** |
| Load | k6 | p95 budgets (Doc 06 §9) at 3× projected peak (Mon 8 am shift-start storm; end-of-month billing) |
| AI | Eval harness (Doc 11 §9) wired as CI gates | Golden sets, safety suites, calibration |
| Security | SAST (Semgrep), DAST (ZAP baseline) each release; **annual third-party pentest + 6-month vuln scans** (NPRM cadence, Doc 09 §9) | Findings SLA: crit 48 h · high 7 d |

## 3. The pgTAP compliance suite (what makes this product defensible)

Run on every PR against a from-scratch migrated database:

- **RLS matrix.** Generated tests over (role × representative-row × operation): for each table, fixtures create rows owned by tenant-A/tenant-B, on-team/off-team, AAL1/AAL2 sessions; assertions enumerate expected allow/deny. Adding a table without matrix coverage **fails the build** (coverage manifest check). ~700 assertions at v1.
- **Append-only.** For every [AO] table: `UPDATE`/`DELETE` as every role (incl. a simulated table-owner path) raises `CAREOS_APPEND_ONLY`; privilege probes confirm grants absent.
- **Audit chain.** Insert sequence → recompute hashes → assert linkage; simulated tamper (superuser row edit in test) breaks verification; anchor job output matches recomputation.
- **RPC guards.** `finalize_form` without signatures/AAL2/permission fails with exact codes; `clock_in` idempotency (same `client_event_id` twice → one event); geofence in/out cases (PostGIS fixtures); `assert_schedulable` blocks lapsed-credential assignment.
- **Cadence engine.** Time-travel fixtures (`clock` injection): admission → initial/48-h/annual obligations at correct dates; medication-involvement 45/90/120 supervisory cadence; grace transitions `open→at_risk→overdue`; waiver path requires RN role + reason; leap-year/DST edges.
- **AI invariants.** Tier-gating (T1 cannot reach `executed` without approval row), capability-flag kill switch honored, budget hard-stop.

## 4. E2E critical journeys (release-gated)

Web: intake-from-document (upload→extract→review→client created with provenance) · assessment→AI care-plan draft→RN edit→sign→finalize→locked→correction path · schedule→credential-block→resolve→assign · open-shift fill with agent (approve plan→SMS mock→accept→confirmed) · exception review · survey-packet export · access-revocation drill (user separated → all surfaces dead ≤15 min, PowerSync eviction verified).
Mobile (device farm incl. mid-tier Android): login+MFA+biometric lock · Today→clock-in in-fence · out-of-fence reason flow · task checklist+voice note→structured draft→confirm · **airplane-mode suite:** full visit offline → queued states honest → reconnect → sync → server truth verified incl. EVV submission; conflict during offline edit → keep-both UX resolves with both versions preserved.
Accessibility: axe-clean on gated flows + manual screen-reader pass on caregiver loop and approvals inbox each release (Doc 10 §7).

## 5. Integration testing posture

Sandbox-mode connections in staging for Twilio/Checkr/DocuSign/QBO; ISAS per state-provided test modality (Discovery D-Q16) with recorded-fixture contract tests as the fallback harness; chaos drills quarterly: ISAS-down (queue drains, aging alerts fire), model-provider-down (degradation matrix behaviors, Doc 11 §10), Supabase restore drill (Doc 13 §8).

## 6. PHI-safety verification (continuous)

**Planted-canary suite:** distinctive fake-PHI markers seeded through fixtures; automated assertions that markers never appear in: log drains, Sentry events, email bodies, push payloads, AI request bodies outside allowlists, error responses. Runs nightly against staging + on every release. Any hit = SEV-2.

## 7. Test data management

The Meadowbrook synthetic universe is generated by seed scripts (deterministic, versioned) — realistic names/addresses flagged synthetic, edge personas built-in (client with 4 caregivers, caregiver with expiring license mid-sprint, high-acuity 48-h case, Spanish-speaking family, out-of-fence rural client). Prod-to-staging data flow: **prohibited**; schema-only migrations rehearse on Meadowbrook. AI golden sets are synthetic-PHI documents (generated + hand-corrupted scans for realism).

## 8. Acceptance & UAT (how the client signs off)

Per Doc 04 milestones, each acceptance tranche gets: (1) the **traceability matrix** slice (FR → tests → pass evidence) auto-generated from CI; (2) scripted UAT sessions with real staff on Meadowbrook (coordinator, RN, caregiver, founder tracks — 60–90 min each) with structured findings capture (blocker/major/minor); (3) exit criteria: zero blockers, majors triaged with dates, all release gates green. Founder demo cadence (Doc 15 §7) keeps acceptance continuous rather than big-bang.

## 9. Release gates (the checklist that ships a build)

CI green (all layers incl. pgTAP + AI evals + canary suite) · E2E critical journeys pass on staging · a11y scan clean on gated flows · performance budgets met (Lighthouse-CI + k6 smoke) · no open crit/high security findings · migration rehearsed with rollback note · Security-Advisor findings zero · CHANGELOG + runbook deltas written · feature flags default-safe. **A red gate has no override path except a logged decision by the engagement lead — and that logs to the decision record.**

## 10. Quality metrics (tracked on the exec dashboard, internal)

Escaped-defect rate (prod bugs per release) · flake rate <2% (quarantine-and-fix policy) · pgTAP assertion count trend (must grow with schema) · E2E runtime <20 min (parallelized) · time-to-green on main · UAT blocker trend across tranches · canary-suite hit count (target: forever zero).
