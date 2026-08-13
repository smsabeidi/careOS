# CareOS — DevOps, Reliability & Operations (SRE) Specification

**Client:** American Care Team (Maryland) · **Document:** 13 of 15 · **Version:** 1.1 (Draft) · **Prepared by:** OCTSERVICES LLC

> **Change note (v1.1, Aug 11 2026):** §5 is rewritten against the jobs actually registered, including the new **`careos_visit_sweep`**, and the queue names are corrected to the built outbox. §6 gains **§6.1**, verified-visit and EVV observability (`app.evv_observability`), including the metric set and the geographic breakdown that **D-030** prohibits. §7's page list gains heartbeat staleness. §9 gains two written runbooks — **§9.1** the sweep stops running, **§9.2** EVV submissions start rejecting.

**Implements:** Doc 06 §5/§9 (backbone, reliability posture) · Doc 09 (security ops) · Doc 12 §9 (release gates) · Doc 17 §13 (verified-visit observability).

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

**The `pg_cron` register**, as registered in the migrations that own each job:

| Job | Schedule | Runs | Registered in |
|---|---|---|---|
| `careos_cadence_tick` | hourly at :05 | `app.evaluate_compliance()` — client-side obligations | 0034 |
| `careos_staff_cadence` | hourly at :10 | `app.evaluate_staff_compliance()` — staff-side obligations | 0038 |
| `careos_queue_pump` | every minute | `app.pump_queues()` — pg_net → the worker Edge Function | 0034 |
| `careos_offer_expiry` | every 5 min | `app.expire_offers()` | 0037 |
| **`careos_visit_sweep`** | **every 5 min** | **`app.sweep_visit_exceptions()`** — the five verified-visit detectors | **0047** |
| `careos_retention_sweep` | daily 03:15 | `app.retention_sweep()` — governed; no retention rule is seeded until V14 rules | 0034 |
| `careos_deadman` | every 5 min | `app.check_heartbeats()` | 0034 |

Every one of them is wrapped in `app.run_job(job_key, expected_interval_seconds, sql)` (0034), which executes the tick and writes `public.job_heartbeat` in an exception-safe wrapper: a job that throws records `last_error` **and still heartbeats**, so a wedged job is visible as *stale* rather than as silence. `app.check_heartbeats()` flags anything quieter than 2× its expected interval, and a heartbeat row seeded with `last_ok_at` NULL is RED until the job's first green pass — health is earned, never assumed. `app.health_check()` is the outer probe, called from outside the Supabase boundary by the `deadman` GitHub Actions workflow every 30 min, because if pg_cron itself wedges then layers 1–2 go quiet with it. *(Superseded: this section previously named an "obligation escalation sweep (15 min)" and an "audit-anchor export (daily 02:00)". Escalation happens inside the two cadence ticks; the daily anchor export described in §8 has no `pg_cron` registration — an ops gap, not a decision.)*

Queues and consumers: the outbox `q_events` (0027) plus `q_notify` and `q_ai_jobs` (0034), drained by the worker Edge Function through the `service_role` RPC contract (`queue_read`/`queue_archive`/`read_domain_event`/…) — the function is a thin REST client and Postgres remains the authority. *(Superseded: the previously named `q_notifications`, `q_evv_isas` and `q_integrations` do not exist. EVV in particular has **no dedicated queue**: `app.submit_evv` emits on the outbox in the same transaction as its audit row, which is a deliberate choice recorded in 0049 — a `q_evv` would have required re-signing 0034's queue allowlist and would have bought nothing the outbox does not already guarantee.)* Vercel Cron: reconciliation reports (nightly), config-drift check (weekly). All workers: idempotent, visibility-timeout tuned, max-retry → DLQ; DLQ depth and oldest-message age are paging metrics.

**What `careos_visit_sweep` carries.** It is the only thing that raises `missing_clock_out`, `missed_visit`, `overlapping_visits`, `impossible_travel` and `documentation_missing`, and it is the only automated path to the `scheduled → missed` transition on `visit.status` (0026's transition catalog). Clock-in and clock-out are synchronous RPCs and are unaffected by its health; location exceptions are raised inline by `app.clock_visit`. So when the sweep stops, care keeps working and *detection* stops — see §9.1 for why that is the failure mode worth paging on. Every detector takes an injectable `p_now` and is idempotent through `dedupe_key`, which is what makes a catch-up run safe and a double tick harmless.

## 6. Observability

OpenTelemetry end-to-end: `X-Request-Id` → traces (web → RPC → worker) exported to the BAA'd store; Sentry (BAA) for errors/session health behind the scrubber (Doc 09 §7); Supabase + Vercel **log drains** → BAA'd log store with retention tiers (security-relevant 6 yr archival). Dashboards (four golden signals + domain): API latency/error budgets, queue depths & lag, sync health (PowerSync replication slot lag, **WAL retention headroom** — a known Postgres/logical-replication ops item; *dormant in Phase 1, since D-022 makes PowerSync future-optional*), EVV pipeline funnel (captured→submitted→accepted — §6.1), cadence-engine tick health, job heartbeats (§5), AI capability metrics/cost (Doc 11), auth anomalies (Doc 09 §7). Synthetic probes: login+read canary every minute from two regions; mobile sync canary hourly *(likewise dormant until a native app exists — a probe for an undeployed plane must be disabled, not left to page)*.

### 6.1 Verified-visit & EVV observability

The EVV pipeline funnel above is served by one function rather than by dashboard queries written twice:

```
app.evv_observability(p_from date, p_to date) returns jsonb
```

AAL2 + `workforce.read`, window capped at 366 days (a cost bound — this scans a tenant's clock ledger). Refusals are `CAREOS_NO_TENANT_CONTEXT`, `CAREOS_AAL2_REQUIRED`, `CAREOS_FORBIDDEN`, `CAREOS_BAD_WINDOW`. It reads two `security_invoker` views — `public.evv_capture_fact` (per clock event) and `public.workforce_visit_fact` (per visit) — so row access composes through the caller's own RLS and only the aggregate crosses a definer.

| Metric | Shape |
|---|---|
| Clock-in success rate | `clock_in{attempts, succeeded, rejected, success_rate}`. A `*_rejected` ledger row is the durable evidence that somebody tried and the rule said no; without it there is no denominator and no rate. |
| Location-status distribution | `location_status{verified, low_accuracy, outside_geofence, unavailable, suspicious, not_required, unrecorded}` |
| Accuracy histogram — **bucketed, never raw** | `accuracy_histogram_m{0-25, 25-50, 50-100, 100-250, 250-1000, 1000+, unknown}`. The boundaries live in one place (`evv_capture_fact.accuracy_bucket`), so "never raw values" cannot be true on one surface and false on another. `unknown` is its own bucket: a device that reported no accuracy is operationally different from one that reported an excellent fix, and folding them would flatter the metric. |
| Exception rate by kind | `exception_rate_by_kind{<kind>: {count, rate_per_visit}}` — per visit in the window, so 0.02 reads as "two visits in a hundred hit this" |
| Missing clock-out | `missing_clock_out{clocked_in, missing, rate}` |
| EVV acceptance rate | `evv{accepted, rejected, open, acceptance_rate}` — `reconciled` counts as accepted, because under the Maryland reconcile posture (D-026) reconciliation *is* the accepted outcome and treating it as undecided would report zero for the only mode the agency ships in |
| Sweep latency | `sweep{job_key, expected_interval_seconds, last_ok_at, seconds_since_last_ok, stale}`, read from `public.job_heartbeat` — platform telemetry with zero tenant data. A sweep that has never run reports `stale`, not unknown. |
| Lawful breakdown | `by_service_type[]` — visits, clock-in success rate and missing-clock-out rate per `service_type.code`, with `unassigned` as a real bucket (a visit with no service type is itself an EVV completeness problem) |

**A geographic breakdown is prohibited (D-030).** A distribution of where caregivers clock in answers no question about whether EVV capture is working, and it builds a location history of named people inside the one surface built for dashboards, exports and screenshots — surveillance telemetry wearing an operations-metric costume. The function has no such dimension and must not grow one. `evv_capture_fact` does not select `latitude`, `longitude`, `distance_m` or even raw `accuracy_m`, and the pgTAP suite greps the view's own catalog definition to keep that structural rather than remembered. Doc 17 §13 also asked for a **browser-family** breakdown; there is no user-agent column anywhere in the schema (`visit_event.device_session_id` is opaque and rotating and is explicitly not a device fingerprint), so the dimension is omitted rather than invented. Both omissions are named in the return value's `dimensions_omitted` array, so a consumer charting them learns *why* the data is absent instead of assuming the query failed. The `org_id` dimension collapses to the caller's own tenant — CareOS has no sub-org unit, and a cross-tenant breakdown would be exactly the privileged retrieval invariant 9 forbids.

## 7. SLOs, alerting & on-call

| SLO | Target | Notes |
|---|---|---|
| Web/API availability | 99.9% monthly | Error-budget policy: budget burn >50% mid-month → feature freeze, reliability sprint |
| API latency | reads p95<400 ms · writes p95<800 ms | Per Doc 06 §9 |
| EVV submission freshness | 95% of visits submitted <1 h; 100% <24 h (queue-drain guarantee) | Aging alerts 24 h/72 h |
| Notification delivery | p95 <60 s event→push/SMS | |
| Sync recovery | Post-reconnect delta <5 s p95 | |

Alert matrix: **page** (24×7) = availability burn, DLQ growth, replication-slot/WAL headroom low, audit-chain verify failure, canary-PHI hit, auth-anomaly cluster, **any stale `job_heartbeat` — the `deadman` workflow failing is itself the page (§9.1)**; **ticket** = performance-budget drift, cost-guardrail warnings, config drift, Security-Advisor finding (P1 ticket, page if PHI-relevant). On-call: weekly rotation across the 3–4 engineers, comp-time policy, escalation to lead in 15 min unacked; every page maps to a runbook.

## 8. Backup, DR & continuity

Supabase PITR → **RPO ≤ 5 min**; **RTO ≤ 4 h** exercised by **quarterly restore drills** into an isolated project with checksum + audit-chain verification and a timed report (drill artifacts stored for auditors — this is also §164.308 contingency-plan evidence). Storage bucket versioning + replication per platform; audit anchors exported daily to independent WORM object storage (the tamper-evidence backstop lives *outside* the primary vendor). Regional posture: primary US-East; documented cold-standby restore path; read replica added in Phase 2 doubles as reporting isolation. **Continuity truth:** field care continues through any backend outage (offline-first, Doc 10 §6) — the DR story leads with that in client communications.

## 9. Runbooks (maintained in `ops/runbooks/`, drilled)

Access revocation ≤15 min (Doc 09 §2) · Suspected PHI exposure (Doc 09 §8) · **The visit sweep stops running (§9.1)** · **EVV submissions start rejecting (§9.2)** · ISAS outage/backlog drain · Queue DLQ triage · PowerSync replication-slot/WAL recovery (future-optional under D-022) · Model-provider outage (flip capability flags, comms template) · Restore drill script · Secret rotation · Vercel/Supabase incident (status-page monitors + degraded-mode comms) · Break-glass access (dual-control, auto-incident).

The two most likely verified-visit incidents are written out here because both fail *quietly* — the surfaces they feed keep rendering, with fewer rows.

### 9.1 The visit sweep stops running

**Signal.** The `deadman` workflow fails with `stalled` containing `visit_sweep`; or `app.evv_observability(from, to) -> 'sweep' ->> 'stale'` is true; or the exception inbox stops gaining rows while the schedule keeps moving.

**What it means.** Clocking still works — `app.clock_visit` is synchronous, and location exceptions are raised inline by it. What stops is *detection*: nobody is told a caregiver never arrived, `visit.status` never advances `scheduled → missed`, and schedule-adherence and workforce metrics quietly flatter because a missed visit still counts as scheduled. Payroll approval keeps flowing, because `CAREOS_APPROVAL_BLOCKED` only trips on unresolved critical exceptions **that exist**. That is the reason this pages rather than tickets: an outage of the detector is invisible in every surface the detector feeds.

**Triage.**
1. `select * from public.job_heartbeat where job_key = 'visit_sweep';` — a recent `last_error_at` means the job ran and threw; a stale `last_ok_at` with no recent error means the tick never fired.
2. Never fired → is pg_cron itself alive? Check `cron.job` for `careos_visit_sweep` and `cron.job_run_details` for recent rows, and compare against the other 5-minute jobs (`careos_deadman`, `careos_offer_expiry`). If all of them are quiet, this is a platform incident, not a visit-layer one — switch to the Supabase-incident runbook.
3. Ran and threw → `last_error` carries the raw `sqlerrm` from the failing detector, and the sweep is sequential, so the counts in its return tell you how far it got.

**The failure mode that does not page.** A green heartbeat is not the same as a working sweep. Each detector resolves `app.visit_policy_for(visit)` per visit and, when that raises `CAREOS_POLICY_MISSING` — no `scope_kind='tenant'` row for that tenant — **skips the visit and continues**, deliberately: an unconfigured tenant is 0044's gap, not a finding, and one agency's missing config must not stop detection for every other agency in the project. The consequence to know at 3 a.m. is that such a tenant gets a perfectly healthy heartbeat and zero detections. If the heartbeat is green and the queue is still empty, check `select 1 from public.visit_policy where tenant_id = … and scope_kind = 'tenant'` before looking anywhere else; the fix is `app.upsert_visit_policy` at tenant scope, and it is configuration, not code. Note also that the detectors distinguish this from a real fault on purpose — any other exception re-raises rather than being swallowed as a config gap.

**Recovery.** Re-register the schedule if the row is gone:
`select cron.schedule('careos_visit_sweep', '*/5 * * * *', $$select app.run_job('visit_sweep', 300, 'select app.sweep_visit_exceptions()')$$);`
Then catch up with `select app.sweep_visit_exceptions();` from a maintenance session as the owning role. **Do not grant execute to `authenticated` to run it** — the function deliberately has no client grant, and invariant 6 keeps `service_role` out of request paths. Because every detector is idempotent through `dedupe_key`, one catch-up run after an hour of downtime raises each exception once, not twelve times.

**What the catch-up does and does not restore.** The detectors judge against `p_now`, so a catch-up raises the exceptions that are *still* true — visits that should have been marked missed are, and the ledger self-heals. The **notifications that would have gone out at the time did not**, and no replay recreates them. Tell the coordinator the queue they are looking at is retrospective, and check the missed-visit rows by hand for anything that needed a call hours ago.

**Verify.** `job_heartbeat.last_ok_at` fresh · `app.evv_observability(...) -> 'sweep' ->> 'stale'` is `false` · the `deadman` workflow green on its next 30-minute pass.

**Do not** "fix" a red heartbeat in a new environment by seeding a green row. A sweep that has never run is red on purpose (the 0039 posture); silencing it removes the only signal that it never started.

### 9.2 EVV submissions start rejecting

**Signal.** `app.evv_observability(from, to) -> 'evv'` shows `rejected` climbing and `acceptance_rate` falling; `visit.evv_status = 'rejected'` counts rise; the `evv.rejected` domain event fires on the outbox. Note that **no detector raises the `evv_rejected` exception kind automatically** — the kind exists in the vocabulary and is available to `app.raise_visit_exception`, but a rejection does not put itself in the exception inbox today. The status projection and the domain event are the signal.

**First question: should this be possible at all?** Maryland ships as `evv_adapter ('isas','MD', mode='reconcile', enabled=false)`, seeded by `app.seed_evv_adapters` (D-026), and with no enabled adapter `app.submit_evv` returns `{ok: true, skipped: true, reason: 'adapter_disabled'}`. `public.evv_adapter` carries **`select` only** for `authenticated` and has no configuration RPC, so enabling one is a privileged database change, not a toggle anyone reaches from a screen. Rejections therefore mean somebody deliberately enabled an adapter. Confirm that was intentional and that V17/V10/D-Q16 are closed — no live submission endpoint is authorised until they are. If it was enabled ahead of them, that is the incident, and the containment below is also the fix.

**Triage.**
1. Us or them? `select response_code, count(*) from public.evv_submission where status = 'rejected' and created_at > now() - interval '24 hours' group by 1 order by 2 desc;` — one dominant code across many caregivers and clients points at a far-side or format change; a scatter of codes points at per-record data problems.
2. Per record: `app.build_evv_record` computes `element_completeness` and `is_complete` deterministically, and `app.submit_evv` refuses an incomplete record with `CAREOS_EVV_INCOMPLETE` rather than transmitting it. So a *rejection* is a record we believed complete and the far side did not — read `element_completeness` on the rejected records against the vendor's code.
3. `response_message` is vendor prose we did not write, truncated at 500 characters by CHECK. **It stays on the row.** It is never rendered to a caregiver surface, never placed in a notification, and never fed to a model (invariant 5, D-030). Quote `response_code` in the incident channel; do not paste messages.

**Containment.** Set the adapter `enabled = false` (or `mode = 'disabled'` — the `chk_evv_adapter_enabled_mode` constraint keeps those two from contradicting each other) rather than letting attempts keep hammering a payer that is refusing them. This is a privileged write from a maintenance session, since there is no client write path; record it in the incident log the way any out-of-band DDL-adjacent change is recorded. Nothing is lost: `evv_record` is append-only and hash-identified (`record_sha256`), `evv_submission` is append-only and attempt-numbered, and `app.submit_evv` returns the in-flight attempt instead of duplicating it — so resubmission after the fix is a new attempt against the same canonical record.

**Recovery.** Fix the data or the adapter → rebuild (`app.build_evv_record`, which supersedes the prior record via `supersedes_id` rather than editing it) → re-enable → resubmit. The worker reports the outcome back through `app.reconcile_evv`, which is `service_role`-only and never reachable from a request path; it appends the outcome row and projects it onto `visit.evv_status`.

**Do not** edit `evv_record` or `evv_submission` rows (both append-only), write `visit.evv_status` directly (it is a projection, and D-024's column grants make it unwritable from a client anyway), or clear rejections to make a dashboard green. If the far side changed its contract, that is a Doc 08 integration change with a decision-log entry, not a hotfix.

**Comms.** Acceptance rate is billing exposure. Tell the administrator, in plain language, which visits are unsubmitted and that the care record itself is unaffected — the visit happened, it is verified, and only the transmission is stuck.

## 10. Cost guardrails & the exit runbook

Monthly cost review vs. budget envelopes (platform, AI per Doc 11 §8, comms); anomaly alerts at 130% run-rate; per-capability AI hard ceilings. **Exit runbook (R1 mitigation, Doc 06):** quarterly-verified procedure — `pg_dump` full + Storage sync to neutral object store + audit-anchor archive → restore rehearsal onto vanilla Postgres 16 + containerized Next.js behind any host → gap list (Auth swap = the largest item) maintained honestly. Leverage is the point: we stay on this stack because it's *good*, not because we're stuck.

### §9.x · Runbook — the eval gate is red (or UNARMED)

**What it means.** A registry prompt regressed against its case set (`scripts/evals/`), or
the gate could not run. UNARMED (missing `OPENAI_API_KEY` or unreachable local registry)
is printed explicitly and is never a pass in CI — a gate that proved nothing must not
read as green (the deadman §9.1 posture).

**Triage.** 1) Read the per-case failures — each names the capability, the case, and the
exact assertion (`missing required substring` / `forbidden substring present`). A
`forbidden substring` failure on an adversarial case means an INJECTION LANDED: treat as
a release blocker, never loosen the case. 2) A prompt change caused it → fix the prompt
(a new `ai_prompt_template` VERSION — never edit v1) or, if the case is genuinely wrong,
change the case in the same PR with the reasoning in the commit. 3) UNARMED in CI →
the `OPENAI_API_KEY` repo secret is missing/rotated; restore it (docs/09 §5 custody).

### §9.y · Runbook — the attention queue is empty but shouldn't be

The `/inbox` unified queue is a read model over six sources plus the caller's own
`alert_ack` rows. An empty queue with known-open work means either (a) the caller acked
everything — check `audit.audit_event action='alert.acknowledged'` for who and when
(dismissal is deliberately audit-visible), or (b) a SOURCE query is failing closed —
each source section renders its own honest degradation line rather than vanishing, so a
missing section names the broken source. Acks are append-only and per-user: nothing can
"un-see" an alert for somebody else, and a re-fired condition arrives as a new source
row that no existing ack matches.
