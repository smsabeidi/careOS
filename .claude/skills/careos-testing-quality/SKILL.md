---
name: careos-testing-quality
description: How CareOS is tested and what "done" means. Use whenever you write, modify, or debug tests; add fixtures or seed data; touch CI test stages; decide what layer a test belongs at; handle a flaky test; or prepare a release. Also fires when a schema/policy change needs its pgTAP coverage, when an E2E journey changes, or when someone (including you) is tempted to skip/weaken a failing check.
---

# CareOS Testing & Quality Playbook

Deep spec: `docs/12`. Tests here are **compliance evidence**, not hygiene — the traceability matrix (FR → test IDs → results) is a client deliverable generated from CI.

## Pick the right layer

Logic/pure functions → **Vitest**. Anything RLS/append-only/RPC-guard/cadence/audit → **pgTAP** (in the database, where it's enforced — a Playwright test of a permission is not a substitute). API shapes/idempotency/webhooks → contract tests with recorded fixtures. User journeys → **Playwright** (web) / **Maestro** (mobile). Perf → k6 against budgets. AI → eval harness (see ai-layer skill).

## pgTAP patterns (the crown jewels — extend, never dilute)

- **Matrix coverage:** every table lists expected allow/deny in `db/tests/matrix.yaml` per (role × row-situation × op); the generator asserts each. New table/policy without a matrix entry fails CI by design.
- **AO probes:** UPDATE/DELETE as every role on every [AO] table must raise `CAREOS_APPEND_ONLY`; grant probes confirm privileges absent.
- **RPC guards:** call each RPC missing AAL2 / permission / preconditions and assert exact `CAREOS_*` codes; idempotency = same domain key twice ⇒ one effect.
- **Cadence time-travel:** use the injected clock fixture; assert obligation dates for admission/48-h/annual/45-90-120 supervisory, grace transitions, RN-only waivers, DST/leap edges.
- **Audit chain:** insert sequence → recompute → linkage holds; simulated superuser tamper breaks verification.

Tag every test with the FR/ST it evidences (`-- @trace: FR-M3-004, ST-021`) — the matrix generator reads these.

## E2E discipline

Critical journeys (docs/12 §4) are release gates — extend them when flows change, in the same PR. The **airplane-mode Maestro suite** and the **revocation drill** are sacred. Selectors: `data-testid` only. Keep full E2E < 20 min via parallel shards; a journey that can't run headless in CI isn't done.

## Fixtures: Meadowbrook only

All non-prod data comes from the deterministic synthetic generator (`packages/fixtures`). Need a new scenario (expiring license mid-sprint, out-of-fence rural client, Spanish-speaking family)? **Extend the generator** — never hand-write records inline, never "borrow" anything real. AI golden docs are generated synthetic + hand-degraded scans.

## The canary-PHI suite

Planted fake-PHI markers must never appear in logs, Sentry, email, push, AI request bodies (outside allowlists), or error responses. It runs nightly + on release. You may **add** markers and sinks; you may not remove or relax assertions — a canary "fix" that isn't a code fix is an incident.

## Flakes & failing checks

Flaky ⇒ quarantine tag + issue + fix within the sprint; quarantine >2 weeks escalates. A failing gate is **never** resolved by deleting/skipping the test, loosening an assertion, widening a tolerance, or regenerating a snapshot without stating the diff's meaning in the PR. Fix the code, or escalate with analysis.

## Release gate self-check (before calling a build shippable)

CI fully green (unit + pgTAP + contract + evals + canary) · E2E journeys green on staging · axe-clean on gated flows · budgets met (Lighthouse-CI, k6 smoke) · no open crit/high security findings · migration rehearsed + rollback note · Security Advisor zero · CHANGELOG + runbook deltas. Red gates have no override except a logged engagement-lead decision.
