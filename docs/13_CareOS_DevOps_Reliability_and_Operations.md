# CareOS — DevOps, Reliability & Operations (SRE) Specification

**Client:** American Care Team (Maryland) · **Document:** 13 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 06 §5/§9 (backbone, reliability posture) · Doc 09 (security ops) · Doc 12 §9 (release gates).

> **Purpose.** How CareOS is built, shipped, observed, kept alive, and recovered — on Supabase + Vercel, to an enterprise operations bar, with a team small enough to actually run it.

---

## 1. Environments & data policy

| Env | Platform | Data | Purpose |
|---|---|---|---|
| Local | Supabase CLI (Docker) + `next dev` | Meadowbrook synthetic | Full-stack local incl. RLS/queues/cron |
| Preview (per-PR) | Vercel Preview + **Supabase branch** (ephemeral) | Synthetic seed | Every PR = a full working stack URL; auto-destroyed on merge/close |
| Staging | Dedicated Supabase project (High-Compliance config mirrored) + Vercel env | Synthetic only — **never PHI** | Integration sandboxes, E2E, chaos & restore drills, UAT |
| Production | Supabase **High-Compliance** project + Vercel (BAA) | PHI | The only PHI environment (D-006) |

Config parity enforced by a checked-in config manifest (auth settings, RLS force, network restrictions, log drains) diffed against live settings weekly — drift = P2 ticket.

## 2. Repository & workflow

pnpm monorepo (`apps/web`, `apps/mobile`, `packages/{db-types,api-client,ui,ai,config}` + `db/` migrations + `compliance/` generated artifacts). Trunk-based: short-lived branches → PR (review required; CODEOWNERS on `db/`, `packages/ai`, auth code) → squash to `main` = deploy to staging → **manual promote** to prod (two-person: engineer + lead) — promotion is one click, rollback is one click. Feature flags (DB-backed, per-tenant) decouple deploy from release; risky features ship dark.

## 3. Database change management

Sequential SQL migrations via Supabase CLI; **expand → migrate → contract** (new columns nullable/dual-written → backfill job → contract in a later release); destructive DDL requires a decision-log entry + rehearsed rollback note. Every migration PR runs: fresh-migrate + pgTAP (Doc 12 §3) + policy-catalog regeneration (drift check) + type generation (compile break = contract break caught). Prod apply happens in the promote step with statement-timeout guards and a pre-apply PITR bookmark noted in the release record. Mobile schema changes follow PowerSync compatibility rules (additive sync-rule evolution; client migration handlers shipped ahead of contraction).

## 4. CI/CD pipeline (GitHub Actions)

`lint/typecheck` → `unit` → `db: migrate+pgTAP` → `build (web, mobile EAS)` → `ai-evals` (if `packages/ai` or registry touched) → `deploy preview` → `e2e (Playwright vs preview)` → merge → `staging deploy` → nightly: full E2E + Maestro device farm + canary suite + k6 smoke → `promote` (gated by Doc 12 §9 checklist, auto-verified where possible). Target: PR-to-preview < 10 min; full nightly < 45 min. Supply-chain: pinned actions, lockfile-only installs, provenance attestation on builds, secret-scanning blocking.

## 5. Schedulers & workers (ops view)

`pg_cron`: cadence tick (hourly), obligation escalation sweep (15 min), audit-anchor export (daily 02:00), retention sweep (weekly, governed), queue-health probe (5 min). Edge Function consumers: `q_notifications`, `q_evv_isas`, `q_integrations` (invoked on schedule + on-demand). Vercel Cron: AI job orchestrator (`q_ai_jobs`), reconciliation reports (nightly), config-drift check (weekly). All workers: idempotent, visibility-timeout tuned, max-retry → DLQ; DLQ depth and oldest-message age are paging metrics.

## 6. Observability

OpenTelemetry end-to-end: `X-Request-Id` → traces (web → RPC → worker) exported to the BAA'd store; Sentry (BAA) for errors/session health behind the scrubber (Doc 09 §7); Supabase + Vercel **log drains** → BAA'd log store with retention tiers (security-relevant 6 yr archival). Dashboards (four golden signals + domain): API latency/error budgets, queue depths & lag, sync health (PowerSync replication slot lag, **WAL retention headroom** — a known Postgres/logical-replication ops item), EVV pipeline funnel (captured→submitted→accepted), cadence-engine tick health, AI capability metrics/cost (Doc 11), auth anomalies (Doc 09 §7). Synthetic probes: login+read canary every minute from two regions; mobile sync canary hourly.

## 7. SLOs, alerting & on-call

| SLO | Target | Notes |
|---|---|---|
| Web/API availability | 99.9% monthly | Error-budget policy: budget burn >50% mid-month → feature freeze, reliability sprint |
| API latency | reads p95<400 ms · writes p95<800 ms | Per Doc 06 §9 |
| EVV submission freshness | 95% of visits submitted <1 h; 100% <24 h (queue-drain guarantee) | Aging alerts 24 h/72 h |
| Notification delivery | p95 <60 s event→push/SMS | |
| Sync recovery | Post-reconnect delta <5 s p95 | |

Alert matrix: **page** (24×7) = availability burn, DLQ growth, replication-slot/WAL headroom low, audit-chain verify failure, canary-PHI hit, auth-anomaly cluster; **ticket** = performance-budget drift, cost-guardrail warnings, config drift, Security-Advisor finding (P1 ticket, page if PHI-relevant). On-call: weekly rotation across the 3–4 engineers, comp-time policy, escalation to lead in 15 min unacked; every page maps to a runbook.

## 8. Backup, DR & continuity

Supabase PITR → **RPO ≤ 5 min**; **RTO ≤ 4 h** exercised by **quarterly restore drills** into an isolated project with checksum + audit-chain verification and a timed report (drill artifacts stored for auditors — this is also §164.308 contingency-plan evidence). Storage bucket versioning + replication per platform; audit anchors exported daily to independent WORM object storage (the tamper-evidence backstop lives *outside* the primary vendor). Regional posture: primary US-East; documented cold-standby restore path; read replica added in Phase 2 doubles as reporting isolation. **Continuity truth:** field care continues through any backend outage (offline-first, Doc 10 §6) — the DR story leads with that in client communications.

## 9. Runbooks (maintained in `ops/runbooks/`, drilled)

Access revocation ≤15 min (Doc 09 §2) · Suspected PHI exposure (Doc 09 §8) · ISAS outage/backlog drain · Queue DLQ triage · PowerSync replication-slot/WAL recovery · Model-provider outage (flip capability flags, comms template) · Restore drill script · Secret rotation · Vercel/Supabase incident (status-page monitors + degraded-mode comms) · Break-glass access (dual-control, auto-incident).

## 10. Cost guardrails & the exit runbook

Monthly cost review vs. budget envelopes (platform, AI per Doc 11 §8, comms); anomaly alerts at 130% run-rate; per-capability AI hard ceilings. **Exit runbook (R1 mitigation, Doc 06):** quarterly-verified procedure — `pg_dump` full + Storage sync to neutral object store + audit-anchor archive → restore rehearsal onto vanilla Postgres 16 + containerized Next.js behind any host → gap list (Auth swap = the largest item) maintained honestly. Leverage is the point: we stay on this stack because it's *good*, not because we're stuck.
