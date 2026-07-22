---
name: careos-devops-operations
description: The build-ship-run law for CareOS. Use for anything touching CI/CD workflows, environments and branching, deploys/promotions, database migration deployment, secrets and credentials, environment variables, queue workers or cron jobs, log drains/observability wiring, alerts/SLOs, backups/DR, or runbooks. Fires whenever infrastructure-ish YAML/config is edited, a new background job is added, or a secret needs a home.
---

# CareOS DevOps & Operations Playbook

Deep spec: `docs/13`. Secrets custody: `docs/09 §5`. The posture: **PHI only in production; everything else is fast, synthetic, and disposable.**

## Environment law

Local (Supabase CLI + Meadowbrook) → **per-PR preview** (Vercel Preview + ephemeral Supabase branch, synthetic seed, auto-destroyed) → staging (High-Compliance config mirrored, synthetic only, integration sandboxes) → production (the only PHI env; High-Compliance; Security Advisor findings are P1). Config parity lives in the checked-in manifest — if you change a platform setting, change the manifest in the same PR or you've created drift.

## Pipeline (don't reorder, don't skip)

`lint/typecheck → unit → db: fresh-migrate + pgTAP → build → ai-evals (if AI touched) → preview deploy → e2e → merge=staging → nightly (full E2E + device farm + canary + k6) → manual two-person promote`. Rollback is one click (previous deployment + PITR bookmark noted pre-migration). Feature flags decouple deploy from release — risky work ships dark by default.

## Migration deploys

Expand → migrate (queue-run idempotent backfills) → contract later. Before prod apply: rehearsed on staging, rollback note written, PITR bookmark recorded in the release entry, statement timeouts on. Contractions coordinate with mobile sync-rule sequencing (mobile skill). Never `db push` by hand at prod.

## Secrets (the custody matrix is law)

`service_role` → Edge Function secrets + CI only. Provider keys (Anthropic/Deepgram/Twilio/Checkr/QBO/DocuSign) → Vercel server-only env or Vault rows, least scope. Webhook signing secrets → env + provider dashboard. Nothing in the repo (scanner blocks); every secret has an owner + rotation date in the register; touching offboarding? run the rotation touch-list. If a secret needs a *new* home, that's an escalation, not an improvisation.

## Adding a worker / cron / queue (checklist — all items)

Idempotent on event id · visibility timeout + bounded retries → **DLQ** · DLQ depth + oldest-age wired to alerts · dashboard panel added · runbook entry (what it does, how to drain, how to replay) · registered in the schedule table in docs/13 §5 · attributed `system` actor for audit. A worker without its DLQ + runbook is half-shipped.

## Observability rules

OTel spans propagate `X-Request-Id` end-to-end; logs/errors only through the scrubber (phi-safety); new alert = severity (page vs ticket) + owner + runbook link — an alert nobody can act on is noise, delete or fix it. SLOs and the error-budget policy (docs/13 §7) govern: budget burn >50% mid-month = feature freeze, and you don't argue with the policy in a PR.

## DR & the drills you don't postpone

PITR RPO ≤5 min / RTO ≤4 h; quarterly restore drill into an isolated project with checksum + audit-chain verification, timed and archived (auditor evidence). Audit anchors export daily to independent WORM storage — never point that at the primary vendor. Access-revocation drill quarterly (≤15 min, incl. mobile eviction). The exit runbook (pg_dump + containerized Next.js) gets its quarterly verification too — leverage requires it working.

## When you're "just" changing YAML

CI workflow edits get the same review bar as code (they gate compliance evidence) · pinned action versions, lockfile-only installs · no new outbound network in CI without allowlist reasoning · anything that weakens a gate (removed stage, softened threshold) must say so loudly in the PR title.
