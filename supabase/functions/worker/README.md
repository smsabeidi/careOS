# worker — the automation-runtime queue consumer

One POST-only Edge Function, invoked every minute by the `careos_queue_pump` pg_cron job
through pg_net (migration 0034). Each invocation reads one bounded batch (≤10, 60 s
visibility timeout) from `q_events` and `q_notify`, acts, archives, and heartbeats.
Throughput comes from cadence, not loops — a stuck invocation can never run away.

## What it consumes

`q_events` messages are IDs-only (invariant 5): `{type, event_id, tenant_id}`. To act,
the worker refetches the `domain_event` row via `app.read_domain_event` — the message is
a cue, the row is the truth.

`identity.separated` (0032 saga, phase 2): the DB already closed every policy at commit
(0022 active-principal closure). This lane closes the auth layer: a Supabase admin API
ban (`ban_duration: 87600h` — rehire is a fresh account, never an unban), which the Auth
server enforces on every token grant *including refresh* — so the one call both bans and
makes every refresh token unusable immediately. (There is no admin sign-out-by-user-id
endpoint in supabase/auth; `admin.signOut()` takes a user's own session JWT. A hard
`auth.sessions` delete would need a definer RPC — a 0035 candidate.) Then
`app.complete_revocation_step_system` writes `auth_ban` and `refresh_revoke` back to the
checklist, and `push_invalidate` completes as an honest no-op ("no push tokens exist
yet") until the mobile app exists. When the desk finishes the three human steps, the
last completion emits `identity.revocation_verified` — the docs/09 §3 evidence row.

`document.destroy` (0029 saga, phase 2): `app.read_document_for_destruction` → Storage
API blob delete → `app.complete_document_destruction` removes the metadata row. A null
location means the row is already gone (crash-replay) — completion answers
`already_gone`; an unstamped row raises `CAREOS_BAD_STATE` and pages via the poison path.

Anything else on `q_events` is archived with a type-only log line — those consumers
arrive with Phase-4 wiring. `q_notify` is fully stubbed ("notify: no sender configured")
until the Phase-3 senders land.

## The three-layer deadman

Layer 1: every worker pass and pg_cron job writes `public.job_heartbeat` (the worker's
keys are `worker.q_events` and `worker.q_notify`; only a clean pass advances them).
Layer 2: the `careos_deadman` pg_cron job runs `app.check_heartbeats` every 5 minutes
inside the database and flags anything quieter than 2× its expected interval.
Layer 3: `.github/workflows/deadman.yml` probes `app.health_check` from outside the
Supabase boundary every 30 minutes — the only layer that still notices when pg_cron
itself wedges. A red run on that workflow is a page, not a flake.

## Poisoned messages

A handler error leaves the message un-archived; the 60 s visibility timeout redelivers
it on a later pass. At `read_ct >= 5` the worker archives it anyway (quarantine into
pgmq's archive table, e.g. `pgmq.a_q_events`) and records a false heartbeat carrying
`poison:<error class>` — the queue never wedges (S8-2), and the stall surfaces through
all three deadman layers. To replay after fixing the cause: inspect the archive table,
then `pgmq.send` an equivalent message; there is no in-place unarchive.

Logs and responses carry counts, msg ids, event types, and error classes only — never
payload contents (invariant 5). `CAREOS_*` codes are PHI-free by definition (docs/08 §2).

## Secrets (docs/09 §5 custody — Edge secrets only, never Vercel)

| Secret | Where | Notes |
|---|---|---|
| `CAREOS_WORKER_SECRET` | Edge Function secrets (`supabase secrets set CAREOS_WORKER_SECRET=…`) | The auth gate. Must equal the Vault secret `careos_worker_secret` the pump sends. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by the Edge runtime | Never set these in Vercel — `service_role` exists only in Edge secrets and CI (invariant 6). |
| `careos_worker_url`, `careos_worker_secret` | Supabase Vault (DB side) | Read by `app.pump_queues` (0034). Unconfigured → honest `pump.queues` false heartbeat, never a silent no-op. |
| `SUPABASE_URL`, `CAREOS_DEADMAN_KEY` | GitHub repo secrets | For the deadman workflow. CI already holds DB creds per docs/09 §5 — no new custody location. |

Prerequisite: `app` must be a PostgREST-exposed schema (already in `config.toml`
`api.schemas`; mirror in the hosted dashboard's API settings).

## Deploy

```sh
supabase functions deploy worker --no-verify-jwt
```

`--no-verify-jwt` is safe here, and required: the caller is pg_net, which cannot mint
Supabase JWTs, so JWT verification would only force smuggling the anon key into cron
config for zero security (the anon key is public by design). The real gate is the
`x-careos-worker-secret` header, compared in constant time; a bad or missing secret is
a 401 before any queue read. Everything past the gate is bounded by the 0034
service_role RPC contract — the function holds no authority Postgres didn't grant it.

Manual invocation (smoke test):

```sh
curl -s -X POST "$SUPABASE_URL/functions/v1/worker" \
  -H "x-careos-worker-secret: $CAREOS_WORKER_SECRET" \
  -H "Content-Type: application/json" -d '{}'
# → {"processed":N,"archived":N,"failed":N,"failure_classes":[]}
```
