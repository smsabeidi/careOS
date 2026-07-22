---
name: careos-api-workflows
description: How data moves in CareOS. Use whenever you add or modify an endpoint, Server Action, Route Handler, Postgres RPC, webhook, Realtime channel, queue consumer, or any integration call (ISAS/EVV, Twilio, Checkr, QuickBooks, DocuSign, Deepgram, email) — and whenever you're deciding WHERE a piece of logic belongs (client query vs RPC vs server orchestration). Also fires for pagination, error responses, idempotency, retries, or rate limiting questions.
---

# CareOS API & Workflow Playbook

Deep spec: `docs/08`. Async backbone: `docs/06 §5`.

## Lane selection (decide first, every time)

- **Lane A — `supabase-js` + user JWT:** plain reads and simple owned-row writes. RLS is the contract. If you're tempted to "post-filter" results in JS, the policy is wrong — fix the policy.
- **Lane B — Postgres RPC (`app.*`):** anything transactional or consequential: status transitions, finalize/sign, clock in/out, assignment, approvals, waivers. One transaction = domain writes + audit + outbox. If a mutation matters, it's an RPC.
- **Lane C — Route Handler / Server Action:** orchestration only — AI tasks, integrations, file intake, exports, webhooks. Uses a **user-scoped** client (RLS applies server-side). `service_role` is never available here. External side effects go through the outbox → worker, not inline.

Realtime channels broadcast `{entity_type, entity_id, event}` only; clients refetch.

## Non-negotiable mechanics

- **Errors:** RFC 9457 `application/problem+json` via the shared helper; `code` from the `CAREOS_*` catalog (docs/08 §2). Postgres `raise exception 'CAREOS_X'` maps 1:1 — add new codes to the catalog file, never ad-hoc strings. No PHI in error bodies.
- **Idempotency:** Lane-C mutations accept `Idempotency-Key` (persisted 48 h, response replay). Lane-B uses domain keys (`client_event_id` on device events; obligation/offer IDs). Every worker is idempotent on event id.
- **Concurrency:** writes carry `row_version`; mismatch → `409` + `CAREOS_CONFLICT_KEEP_BOTH` + server copy → the keep-both merge UI. Never last-write-wins.
- **Pagination:** keyset (`after` cursor + `limit ≤ 200`), stable order documented. No OFFSET on hot paths.
- **Outbox pattern:** inside the RPC transaction: `perform pgmq.send('q_events', jsonb_build_object('type', …, 'id', …));`. Workers: read batch → process → ack; failures → bounded retry → DLQ (alerting owns it from there). New queue = consumer + DLQ + dashboard + runbook entry (see devops skill).

## Webhook endpoints (inbound) — fixed skeleton

Verify provider signature **and** timestamp window (≤5 min) → on failure `401` + security log (no retry-friendly detail) → on success: respond `2xx` fast, enqueue payload to `q_integrations`, process in the worker. Never do real work inline; never trust payload contents beyond schema-parse (zod).

## Integration doctrine (per docs/08 §6)

- **ISAS/EVV:** build against the `evv_submission` state machine; CareOS is operational truth, ISAS is the state's Medicaid EVV record — reconcile, don't overwrite. **ISAS being down never blocks care or clocking.** Rejects create corrections (new events), never edits.
- **Twilio:** minimized bodies (see phi-safety), Messaging Service, verify inbound signatures, honor STOP.
- **Checkr:** webhooks advance `credential` rows; adjudication is always human.
- **QuickBooks:** export EVV-verified billables only; idempotent external refs; CareOS never becomes the ledger.
- **Deepgram:** short-lived scoped tokens minted server-side; transcripts only into the note pipeline.
- **Email:** notification-not-content, always (phi-safety rule 2).
- **DocuSign:** external signers only; completed envelopes archived + hash-linked.

## Contract governance

`/api/v1` is path-versioned; additive = fine, breaking = `/v2` + overlap. CI regenerates types + OpenAPI + RPC catalog and diffs them — a breaking diff fails the build; don't "fix" that by regenerating snapshots without flagging the break in the PR description.
