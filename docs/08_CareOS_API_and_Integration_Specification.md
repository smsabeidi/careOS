# CareOS — API & Integration Specification

**Client:** American Care Team (Maryland) · **Document:** 08 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 01 module requirements · Doc 06 §4–5 (access lanes, async backbone) · Doc 07 (RPCs, tables) · Doc 17 (Verified Visit & Workforce Intelligence — the 0043–0052 surface, §2.1/§2.2, §3.2–§3.9, §6.1, §8 here).

> **Purpose.** The binding contract for how clients (web, mobile, agents, integrations) talk to CareOS, and the engineering spec for every external integration. Anything not specified here follows the conventions in §2.

---

## 1. Access model — three lanes (recap + rules)

| Lane | Transport | Use for | Auth | Hard rules |
|---|---|---|---|---|
| **A — Data API** | `supabase-js` (PostgREST) with **user JWT** | Simple reads; simple owned-row writes | Supabase Auth JWT (AAL2 for PHI) | RLS is the contract. No joins that bypass scoping; generated TS types (`packages/db-types`) are the schema source of truth. |
| **B — RPC** | `rpc('app.…')` | Transactional workflows: finalize, clock in/out, assign shift, acknowledge, waive, approve AI action | Same JWT; RPC re-checks perms | Only lane that changes consequential state. Every RPC: validates AAL2 + permission, is idempotent where retried, emits `app.emit_audit`, enqueues outbox events in-transaction. |
| **C — Server API** | Next.js Route Handlers `/api/v1/*` + Server Actions | Orchestration: AI tasks, integrations, file intake, exports, webhooks | Session (user-scoped Supabase client) or signed machine credentials | Never holds `service_role` (Doc 09 §5). External side-effects go through the outbox (Doc 06 §5), not inline. |

**Realtime:** channels `tenant:{id}:visits`, `tenant:{id}:alerts`, `user:{id}:inbox` broadcast `{entity_type, entity_id, event}` **only**; clients refetch via Lane A under their own RLS.

## 2. Conventions (binding for Lane C; Lane B mirrors where applicable)

- **Versioning:** path-versioned `/api/v1/…`; breaking changes → `/v2` with ≥6-month overlap; additive changes are non-breaking by contract.
- **Errors:** RFC 9457 `application/problem+json` — `{type, title, status, detail, instance, code}`; `code` from a stable catalog (`CAREOS_APPEND_ONLY`, `CAREOS_AAL2_REQUIRED`, `CAREOS_NOT_ON_CARE_TEAM`, `CAREOS_CREDENTIAL_BLOCK`, `CAREOS_CONFLICT_KEEP_BOTH`, …; §2.1 catalogs the Verified Visit additions). Postgres exceptions map 1:1 to codes: the RPC raises `'<CODE>: <plain-language detail>'` with an explicit SQLSTATE, and the code is the substring before the first colon. **No PHI in error bodies, ever** — including in the detail half, which names entity kinds (`visit`, `client`) and numbers, never people, addresses or coordinates.
- **Idempotency:** all Lane-C mutating endpoints accept `Idempotency-Key` (UUID), persisted 48 h with response replay; Lane-B RPCs use domain keys (`client_event_id`, obligation id). Replay is a **return value, never an error** — the RPC returns the prior effect flagged `replayed: true` (clock) or `unchanged: true` (assignment, policy, EVV build/submit). §2.2 specifies the clock contract, which is what makes offline replay safe.
- **Concurrency:** optimistic — writes carry `row_version`; mismatch → `409` + `CAREOS_CONFLICT_KEEP_BOTH` + server copy, and the client renders the keep-both merge UX (Doc 10 §4). Nothing is silently overwritten (P2).
- **Pagination:** keyset (`?after=<cursor>&limit=`), max 200; stable ordering documented per resource.
- **Rate limiting:** Vercel WAF baseline + per-user token budget (auth endpoints 10/min, mutation lanes 120/min, AI endpoints per Doc 11 §8 cost caps) → `429` with `Retry-After`.
- **Headers:** requests carry `X-Request-Id` (generated if absent) propagated through OTel traces and into `audit_event.payload.request_id`.
- **Webhooks (inbound):** every provider endpoint verifies the provider's signature **and** timestamp window (≤5 min), enforces allow-listed source where offered, responds `2xx` fast, and defers work to `q_integrations`. Unverified → `401` + security alert.
- **Webhooks (outbound, future SaaS):** HMAC-SHA256 signed, `X-CareOS-Signature`, retries with exponential backoff ×6 → DLQ.

### 2.1 Error catalog — Verified Visit & Workforce Intelligence (0043–0052)

Two SQLSTATEs carry the whole layer: **`42501`** (insufficient privilege) for "you may not do this", mapped to `403`, and **`P0001`** (raise_exception) for "this cannot be done to this row right now", mapped to `409` for state conflicts and `422` for input the domain rejects. `CAREOS_NOT_FOUND` maps to `404`. The distinction is deliberate — a client retrying a `42501` will never succeed without a permission change, while a `P0001` is often actionable by the user.

| Code | SQLSTATE | Raised by | Meaning |
|---|---|---|---|
| `CAREOS_GEOFENCE_UNVERIFIED` | `P0001` | `app.clock_visit` | Location could not be verified and the resolved policy sets `allow_location_exception = false`. **Nothing is appended** on this branch: the raise would roll an append back, so an INSERT here would be code that provably never persists. |
| `CAREOS_ALREADY_CLOCKED_IN` | `P0001` | `app.clock_visit` | `clock_in` while the ledger already shows an open `clock_in` for this visit. Read from `visit_event`, never from the projection. |
| `CAREOS_NOT_CLOCKED_IN` | `P0001` | `app.clock_visit` | `clock_out` with no open `clock_in` to close. |
| `CAREOS_EXCEPTION_NOT_ALLOWED` | `P0001` | `app.request_location_exception` | The resolved policy forbids a location exception for this visit, so the caregiver's escape hatch is closed by configuration. |
| `CAREOS_POLICY_MISSING` | `P0001` | `app.resolve_visit_policy` (hence `app.visit_policy_for` and `app.clock_visit`), `app.upsert_visit_policy`, `app.compute_overtime`, `app.workforce_features` | The tenant has no `scope_kind='tenant'` `visit_policy` row — the resolution floor is absent. Configuration fix, not a retry. |
| `CAREOS_APPROVAL_BLOCKED` | `P0001` | `app.approve_visit_hours` | *n* unresolved `critical` `visit_exception` rows on the visit. Dispose them first; the count is in the detail. |
| `CAREOS_SELF_APPROVAL` | `42501` | `app.approve_visit_hours`, `app.reject_visit_hours` | The actor is the visit's caregiver. Refused again at the constraint layer by `chk_approved_work_segment_no_self`, so a future RPC that forgets the discipline still cannot write the row. |
| `CAREOS_PERIOD_NOT_READY` | `P0001` | `app.close_payroll_period` | Completed visits inside the period are still awaiting approval; the count is in the detail. |
| `CAREOS_STALE_VERSION` | `P0001` | `app.verify_service_location`, `app.set_service_location_geofence` | The targeted `service_location_version` is no longer current. Re-read the current version and re-target — history is never rewritten. |
| `CAREOS_BAD_KIND` | `P0001` | `app.create_service_location` | `p_kind` is outside the `service_location.kind` domain. |
| `CAREOS_BAD_ADDRESS` | `P0001` | `app.create_service_location`, `app.revise_service_location` | `p_address.line1` is absent; a street line is the minimum a normalised address needs. |
| `CAREOS_BAD_PRECISION` | `P0001` | `app.verify_service_location` | `p_precision` is outside the `geo_precision` domain. |
| `CAREOS_BAD_COORDINATES` | `P0001` | `app.verify_service_location` | Latitude/longitude missing or out of range — `app.geo_point` returned NULL. |
| `CAREOS_BAD_RADIUS` | `P0001` | `app.set_service_location_geofence` | Radius outside 25–5000 m. |

Also raised by this layer, reusing corpus-wide codes: `CAREOS_AAL2_REQUIRED` and `CAREOS_FORBIDDEN` (`42501`) on every gated RPC; `CAREOS_NOT_FOUND` (`P0001`) for out-of-tenant or absent subjects; `CAREOS_HUMAN_REQUIRED` (`42501`) where D-020 forbids an agent principal (`app.dispose_visit_exception`, `app.approve_visit_hours`, `app.reject_visit_hours`, `app.close_payroll_period`, `app.export_payroll_period`); `CAREOS_REASON_REQUIRED` (`P0001`) wherever a reason is mandatory. Layer-local validation codes, all `P0001`: `CAREOS_BAD_EVENT`, `CAREOS_BAD_REASON_CODE`, `CAREOS_BAD_SEVERITY`, `CAREOS_BAD_DISPOSITION`, `CAREOS_BAD_SCOPE`, `CAREOS_BAD_SETTING`, `CAREOS_BAD_WINDOW`, `CAREOS_BAD_TIMESTAMP`, `CAREOS_BAD_MINUTES`, `CAREOS_BAD_PAY_CODE`, `CAREOS_BAD_STATE`, `CAREOS_NO_HOURS`, `CAREOS_INCOHERENT_LEDGER` (clock-out precedes clock-in), `CAREOS_EVV_NO_TIMES`, `CAREOS_EVV_INCOMPLETE`, `CAREOS_NO_TENANT_CONTEXT`, and `CAREOS_PHI_LEAK` (raised by `app.raise_visit_exception_internal` when an evidence payload carries anything but IDs and numbers — invariant 5 enforced at the write, not in review).

### 2.2 Clock idempotency — the offline replay contract

The clock is the one RPC a client may call from a queue it filled while disconnected (D-022: the field surface is the responsive web app with a PWA/IndexedDB queue, not a sync engine). Safety comes from one caller-supplied key and one partial unique index, not from client discipline:

- The caller generates a **UUIDv4 `p_client_event_id`** *before* the first attempt and persists it with the queued action. Every retry of that action carries the same key. `app.request_location_exception` derives its key deterministically per `(visit, event)` for the same reason, so a double-tap replays rather than double-clocking.
- `public.visit_event.client_event_id` is covered by **`uq_visit_event_client_event` — a partial unique index on `(tenant_id, visit_id, client_event_id) where client_event_id is not null`**. Partial, because a live online clock event carries no key at all and many NULLs must coexist on one visit; `tenant_id` leads the key as cheap insurance against a cross-tenant `visit_id` collision.
- On a match, `app.clock_visit` **returns the prior event with `replayed: true`** — never a second row, never an error, never a state transition re-run. The returned `distance_bucket` is recomputed from what was **bound at capture time** (the event's `service_location_version_id`, then its `policy_id`), so a replay reports the decision that was made rather than re-litigating it against today's configuration.
- Corollaries the client may rely on: replay is safe after an unknown outcome (timeout, lost response); the index is a backstop, not the mechanism (two racing flushes serialise into one accepted event and one refusal); and offline events stay distinguishable — they land with `is_offline = true` and `capture_source = 'offline'`, are never presented as ordinarily verified, and pass through the `app.detect_*` rules like any other event.

## 3. RPC catalog (Lane B — the workflow surface)

### 3.1 Core workflow RPCs

| RPC | Args (abridged) | Guard | Effects (all audit + outbox) |
|---|---|---|---|
| `app.finalize_form` | instance, version | AAL2 · `form.finalize`/author · signatures complete | status→final; supersedes prior |
| `app.correct_form` | instance, content, reason | AAL2 · author/`form.correct` | new version `kind='correction'` (reason mandatory) |
| `app.sign_version` | version, method | AAL2 · role in template's required set | `signature` row bound to `content_hash` |
| ~~`app.clock_in` / `app.clock_out`~~ | ~~shift, geo, at, client_event_id~~ | ~~caregiver-of-shift~~ | **Superseded by D-023/D-029.** No such functions were ever built: migration 0013 shipped a single `app.clock_visit(p_visit, …)` keyed on the **visit** (the scheduled care event), not the shift (the roster window), and 0046 re-signed it. See §3.4. |
| `app.log_task_done` | visit, task, at, client_event_id | caregiver-of-shift | append `visit_event` |
| `app.assign_shift` | shift, caregiver | `schedule.write` · `assert_schedulable` | status→scheduled; notify |
| `app.offer_shift` | shift, caregiver[] | `schedule.write` | offers + Coordination-Agent handoff (T1) |
| `app.accept_offer` | offer | offeree | first-accept wins (row lock); rest expire |
| `app.cancel_shift` | shift, reason | `schedule.write` | status+reason; family/caregiver notify |
| ~~`app.review_visit_exception`~~ | ~~visit, disposition, note~~ | ~~`evv.review`~~ | **Superseded by D-024.** Built as `app.dispose_visit_exception(exception, disposition, reason)` against an append-only disposition ledger, gated on `visit.verify.act`; there is no `evv.review` permission key. See §3.5. |
| ~~`app.submit_evv` (worker)~~ | ~~visit~~ | ~~system~~ | **Lane corrected by D-026.** Built as a *user-scoped* RPC (`evv.manage`) that appends a submission attempt and hands off through the outbox; the worker lane is `app.reconcile_evv`, which is granted to `service_role` alone. See §3.6 and §6.1. |
| `app.upsert_credential_from_extraction` | employee, fields, doc, ai_id | `hr.write` | credential `pending`→human `verify_credential` |
| `app.verify_credential` | credential, disposition | `hr.verify` | verified/rejected + expiry obligations |
| `app.waive_obligation` | obligation, reason | RN role (COMAR waiver) | status→waived, reason logged |
| `app.satisfy_obligation` (system) | obligation, entity | system | linked evidence |
| `app.acknowledge_alert` | notification | recipient | ack trail (escalation stop) |
| `app.approve_ai_action` / `app.reject_ai_action` | ai_interaction, edit? | tier-scoped perm (`ai.approve.t1` etc.) | HITL disposition; T1 executes post-approval (Doc 11 §5) |
| `app.grant_family_access` / `app.revoke_family_access` | client, user, scope | `client.write` + consent doc | portal link rows |
| `app.start_discharge` / `app.complete_discharge` | client, forms | `client.write` · RN sign | 30-day completion clock obligation |
| `app.export_survey_packet` | client?/agency, range | `compliance.export` | evidence bundle job → signed URL (audited) |

The Verified Visit & Workforce Intelligence surface (migrations 0043–0052, Doc 17) adds the RPCs below. Signatures are exact, including defaults — PostgREST resolves named arguments, so a parameter name is part of the contract. Every one is `security definer` with `set search_path`, revoked from `public` and `anon`, and gated on `app.is_aal2()` before anything else unless the **Lane** column says otherwise. Three lanes appear:

- **client** — `grant execute … to authenticated`; callable as `rpc('app.…')` under the user's JWT. There are **no REST endpoints for any of this** (Doc 17 §2.1: the board proposal's `POST /visits/:id/clock-in` would have made Lane C a consequential-state lane, which §1 forbids).
- **worker** — `grant execute … to service_role` only; unreachable from any request path (invariant 6).
- **internal** — no grant at all; reachable only from a definer body that already proved the caller, or from pgTAP. Listing them here is deliberate: an ungranted function is part of the contract precisely because clients must not depend on it.

### 3.2 Service locations (0043)

| RPC | Signature | Lane · guard | Effects (audit + outbox) |
|---|---|---|---|
| `app.create_service_location` | `(p_client uuid, p_kind text, p_label text, p_address jsonb, p_is_primary boolean default false) returns jsonb` | client · AAL2 · `location.manage` | `service_location` + version 1, `normalized_address` from `app.normalize_address`; `location.created` |
| `app.revise_service_location` | `(p_location uuid, p_address jsonb, p_reason text) returns jsonb` | client · AAL2 · `location.manage` · reason mandatory | **appends** a `service_location_version` with `supersedes_id`; returns `unchanged:true` when the normalised address is identical; `location.revised` |
| `app.verify_service_location` | `(p_version uuid, p_lat double precision, p_lng double precision, p_precision text, p_note text default null) returns jsonb` | client · AAL2 · `location.manage` · version must be current | the human attestation D-025 requires (`verified_by`, `verified_at`) plus `geo`; `location.verified` (payload carries `geo_precision`, never the point) |
| `app.set_service_location_geofence` | `(p_version uuid, p_radius_m int, p_reason text) returns jsonb` | client · AAL2 · `location.manage` · 25–5000 m | per-location radius override on the version; `location.geofence_set` |

`p_address` is `{line1, line2, city, state, postal_code, country}`. Nothing here edits a version in place — the geographic source of truth is append-only so that a verified visit's binding can never be rewritten under it (the `form_template`/`form_version` precedent, D-014).

### 3.3 Visit policy (0044)

| RPC | Signature | Lane · guard | Effects (audit + outbox) |
|---|---|---|---|
| `app.upsert_visit_policy` | `(p_scope_kind text, p_scope_id uuid, p_scope_value text, p_settings jsonb, p_reason text) returns jsonb` | client · AAL2 · `policy.manage` · reason mandatory | appends a new `visit_policy` version with `supersedes_id`; `policy.updated` |
| `app.resolve_visit_policy` | `(p_client uuid, p_service_type uuid default null, p_at timestamptz default now()) returns public.visit_policy` | client · tenant scope (no AAL2 — policy is configuration, not PHI) | read-only, `stable`; field-by-field merge up the ladder `client → service_type → payer_kind → program → tenant`, most specific non-null wins, tenant row is the floor |
| `app.visit_policy_for` | `(p_visit uuid) returns public.visit_policy` | client · tenant scope | the same resolution keyed by visit, at `now()` — the rule that governs a clock event is the rule in force when it happens; what was in force at verification time stays readable forever through `visit.policy_id` |

Both readers are granted to `authenticated` on purpose: a caregiver must be able to see the grace period they are being measured against. Missing tenant floor → `CAREOS_POLICY_MISSING`.

### 3.4 The clock (0046)

```
app.clock_visit(
  p_visit uuid,
  p_event text,                                  -- 'clock_in' | 'clock_out'
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy double precision default null,
  p_client_event_id text default null,
  p_captured_at timestamptz default null,        -- DEVICE time; diagnostics only
  p_offline boolean default false,
  p_reason_code text default null,
  p_note text default null,
  p_device_session_id text default null
) returns jsonb
```

**Re-signed per D-029**, by `drop function … (uuid, text, double precision, double precision, double precision)` followed by create — never `create or replace`, which would have *overloaded* the 0013 function and broken PostgREST's named-argument resolution (the D-016 failure). The six appended parameters are all defaulted, so **every existing five-argument call site resolves to the new function unchanged**, including the named-argument call in `apps/web/src/app/today`.

Lane · guard: **client** · AAL2 · caller is the visit's assigned `caregiver_id` — no permission key, by design (a caregiver needs no grant to clock their own visit). Behaviour is specified in Doc 17 §4.4; the contract a client codes against is:

| Field | Meaning |
|---|---|
| `ok` | the event was accepted into the ledger as a clock event |
| `replayed` | this call matched a prior `client_event_id` — §2.2 |
| `event_id`, `occurred_at` | the appended `visit_event`; `occurred_at` is **server time**, never caller-supplied |
| `status`, `verification_status` | the two `visit` projections after the call (`scheduled → in_progress → completed`; `pending · verified · exception · manual_review`) |
| `location_status` | `verified · low_accuracy · outside_geofence · unavailable · not_required` |
| `needs_reason` | the attempt was recorded as `clock_in_rejected`/`clock_out_rejected`; the UI offers *Try again* / *Request exception*. **No exception is raised for a retry.** |
| `distance_bucket` | `inside · near · far · null` — **metres never leave the database** (D-030). There is no field, header or error detail anywhere in this contract that carries a coordinate or a distance. |

| RPC | Signature | Lane · guard | Effects (audit + outbox) |
|---|---|---|---|
| `app.request_location_exception` | `(p_visit uuid, p_event text, p_reason_code text, p_note text) returns jsonb` | client · AAL2 · assigned caregiver · policy `allow_location_exception` | records the *request* as an `exception_requested` event carrying the caregiver's reason, then replays the clock through `app.clock_visit` under a deterministic `client_event_id`. It never appends a clock event itself — 0046 is the single writer of clock events. Refuses with `CAREOS_EXCEPTION_NOT_ALLOWED`. |

### 3.5 Exceptions, corrections and trust (0047–0048)

| RPC | Signature | Lane · guard | Effects (audit + outbox) |
|---|---|---|---|
| `app.dispose_visit_exception` | `(p_exception uuid, p_disposition text, p_reason text) returns jsonb` | client · AAL2 · `visit.verify.act` · human principal | appends to `visit_exception_disposition` (`acknowledged·resolved·dismissed·escalated·reopened`); reason mandatory; `visit.exception.disposed`. Agents are refused with `CAREOS_HUMAN_REQUIRED` (D-020) |
| `app.correct_visit_event` | `(p_event uuid, p_occurred_at timestamptz, p_reason text) returns jsonb` | client · AAL2 · `visit.correct` | appends a `correction` event with `corrects_event_id`; the original is never touched; raises a `manual_correction` exception so the correction is itself reviewable; audits as `visit.event_corrected` with the old→new **timestamps** and no free text (the reason lives in the row, under RLS); `visit.corrected` |
| `app.visit_trust_score` | `(p_visit uuid) returns jsonb` | client · AAL2 · `visit.verify.read` ∨ `visit.verify.act` ∨ `schedule.read` | computes the `trust.v1` score, band and component breakdown; **writes nothing** |
| `app.record_trust_assessment` | `(p_visit uuid) returns uuid` | client · AAL2 · `visit.verify.act` | computes and appends a `visit_trust_assessment` snapshot; returns its id |

Trust output is deterministic SQL over six weighted components and is **evidence, never an automated adverse action** (D-028): nothing in this catalog lets a score change an employment record, and the only capability that characterises an individual is T2 with a required human disposer (Doc 17 §11).

### 3.6 EVV (0049)

| RPC | Signature | Lane · guard | Effects (audit + outbox) |
|---|---|---|---|
| `app.build_evv_record` | `(p_visit uuid) returns jsonb` | client · AAL2 · `evv.manage` | canonicalises the six federal elements from the ledger (honouring corrections), scores `element_completeness`, hashes to `record_sha256`, appends an `evv_record`; a rebuild appends with `supersedes_id`, an unchanged rebuild returns `unchanged:true`; `evv.record.built` |
| `app.submit_evv` | `(p_visit uuid) returns jsonb` | client · AAL2 · `evv.manage` | resolves the enabled adapter, appends an `evv_submission` attempt (`status='pending'`), sets `visit.evv_status='pending'`; `evv.submitted`. **No adapter enabled → `{ok:true, skipped:true, reason:'adapter_disabled'}`**, which is the shipped Maryland posture. An incomplete record → `CAREOS_EVV_INCOMPLETE`; an attempt already in flight is returned, not duplicated |
| `app.reconcile_evv` | `(p_submission uuid, p_status text, p_external_reference text, p_response_code text, p_response_message text) returns jsonb` | **worker** (`service_role`) | appends the outcome as a **new** submission row for the same `(evv_record_id, adapter_id, attempt_no)` and projects it onto `visit.evv_status`; `p_status ∈ {submitted, accepted, rejected, reconciled}`; emits `evv.accepted`/`evv.rejected`. `p_response_message` is vendor prose — truncated, never rendered to a caregiver surface, never put in a notification, never fed to a model |

### 3.7 Approval and payroll (0050)

| RPC | Signature | Lane · guard | Effects (audit + outbox) |
|---|---|---|---|
| `app.compute_visit_minutes` | `(p_visit uuid) returns jsonb` | client · AAL2 · `payroll.read` ∨ `payroll.manage` ∨ `visit.approve` ∨ `schedule.read` | verified/scheduled/late/overrun minutes from the ledger, rounded per policy; read-only |
| `app.compute_overtime` | `(p_caregiver uuid, p_week_start date) returns jsonb` | client · AAL2 · `payroll.read` ∨ `payroll.manage` | weekly minutes against `visit_policy.overtime_weekly_minutes`; read-only |
| `app.approve_visit_hours` | `(p_visit uuid, p_approved_minutes int default null, p_pay_code text default 'regular', p_note text default null) returns jsonb` | client · AAL2 · `visit.approve` · human principal | appends an `approved_work_segment`; projects `approval_status='approved'`, `payroll_status='ready'`; `visit.hours.approved`. Refuses on `CAREOS_SELF_APPROVAL`, `CAREOS_APPROVAL_BLOCKED`, `CAREOS_NO_HOURS`, `CAREOS_INCOHERENT_LEDGER` |
| `app.reject_visit_hours` | `(p_visit uuid, p_reason text) returns jsonb` | client · AAL2 · `visit.approve` · human principal · reason mandatory | projects `approval_status='rejected'`, `payroll_status='not_ready'`; `visit.hours.rejected` |
| `app.open_payroll_period` | `(p_starts_on date, p_ends_on date) returns jsonb` | client · AAL2 · `payroll.manage` · human principal | opens a `payroll_period`; `payroll.period.opened` |
| `app.close_payroll_period` | `(p_period uuid) returns jsonb` | client · AAL2 · `payroll.manage` · human principal | `status='locked'`; refuses with `CAREOS_PERIOD_NOT_READY` while completed visits await approval; `payroll.period.closed` |
| `app.export_payroll_period` | `(p_period uuid) returns jsonb` | client · AAL2 · `payroll.manage` · human principal | returns the CSV rows plus `content_sha256`, appends a `payroll_export`, moves the period to `status='exported'` and its `ready` visits to `payroll_status='exported'`; `payroll.exported` |

Self-approval is refused twice — in the RPC and by `chk_approved_work_segment_no_self` — so it is structurally impossible rather than merely policed (D-027).

### 3.8 Workforce intelligence and observability (0051)

| RPC | Signature | Lane · guard | Effects |
|---|---|---|---|
| `app.workforce_features` | `(p_from date, p_to date, p_caregiver uuid default null) returns jsonb` | client · AAL2 · `workforce.read` | the aggregate per-caregiver feature set (IDs, never names; no coordinates; no free text). **The only input any AI capability may read for workforce analysis** (Doc 17 §10/§11) |
| `app.evv_observability` | `(p_from date, p_to date) returns jsonb` | client · AAL2 · `workforce.read` | clock-in success rate, location-status distribution, bucketed accuracy histogram, exception rate by kind, EVV acceptance rate — broken down by browser family, org and service type, **never by geography** (D-030) |

### 3.9 Worker and internal lanes

| Function | Lane | Why it is not client-callable |
|---|---|---|
| `app.queue_notification(p_recipient uuid, p_template_key text, p_title text, p_subject_type text default null, p_subject_id uuid default null, p_channel text default 'in_app', p_dedupe_key text default null) returns uuid` | worker (`service_role`) | pre-existing (0036, hardened in 0039); 0047 re-declares it to add three visit template keys (`visit.location_unverified`, `visit.missing_clock_out`, `visit.missed`) to the **closed** map, carrying the six existing keys over verbatim. Titles are PHI-free by construction only because that map is closed — an unknown key raises `CAREOS_BAD_TEMPLATE` |
| `app.detect_missing_clock_out(p_now timestamptz default now()) returns int` · `app.detect_missed_visits(p_now timestamptz default now()) returns int` · `app.detect_overlapping_visits(p_visit uuid default null, p_now timestamptz default now()) returns int` · `app.detect_impossible_travel(p_visit uuid default null, p_now timestamptz default now()) returns int` · `app.detect_documentation_gaps(p_visit uuid default null, p_now timestamptz default now()) returns int` | internal (no grant) | each is idempotent via `dedupe_key`, returns the count of **new** exceptions, and takes an injected clock so temporal rules are testable (D-016). The three `p_visit`-scoped detectors take a `p_now` the Doc 17 §4.5 sketch omitted; the built signature governs |
| `app.sweep_visit_exceptions(p_now timestamptz default now()) returns jsonb` | internal (no grant) | the pg_cron entry point, every 5 minutes via `app.run_job('visit_sweep', 300, …)`; returns per-rule counts. A client that wants a fresh queue reads the tables — it does not drive the engine |
| `app.raise_visit_exception(p_visit uuid, p_kind text, p_severity text, p_evidence jsonb, p_dedupe_key text) returns jsonb` · `app.raise_visit_exception_internal(p_tenant uuid, p_visit uuid, p_caregiver uuid, p_kind text, p_severity text, p_detected_by text, p_rule_key text, p_evidence jsonb, p_dedupe_key text, p_source_event uuid, p_actor uuid) returns uuid` · `app.notify_visit_verifiers(p_tenant uuid, p_template_key text, p_visit uuid, p_dedupe_scope text) returns int` | internal (no grant) | every exception in the product is born in `…_internal`, which is also the sole emitter of `visit.exception.raised` and which rejects any evidence payload carrying anything but IDs and numbers with `CAREOS_PHI_LEAK`. Re-raising an existing `(tenant, visit, kind, dedupe_key)` is idempotent — a return value, not an error |
| `app.evaluate_location(p_accuracy_m double precision, p_distance_m double precision, p_max_accuracy_m int, p_radius_m int) returns text` | internal (no grant) | the whole geofence rule, `immutable`, four numbers in and one enum out. Not exposed because D-030 forbids showing a caregiver metres — there is nothing for a browser to preview. It can never return `suspicious` |
| `app.normalize_address(...)` · `app.geo_point(...)` · `app.distance_m(...)` · `app.visit_policy_chain(...)` · `app.round_minutes(...)` · `app.seed_visit_policy(...)` · `app.seed_evv_adapters(...)` · `app.seed_visit_ai_capabilities(...)` · `app.seed_visit_feature_flags(...)` | internal (no grant) | primitives and seeders; callable only from the definer bodies above and from pgTAP |

Lane-A reads for these surfaces go through the views the migrations ship — `public.verified_visit`, `public.visit_exception_state`, `public.workforce_visit_fact`, `public.evv_capture_fact` — under the caller's own RLS, not through bespoke endpoints.

## 4. Representative Lane-C endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/intake/documents` | POST (multipart) | Ingest referral/credential doc → Storage → `q_ai_jobs` extraction (Doc 11 §4) |
| `/api/v1/intake/{job}/review` | GET/POST | Extraction draft fetch / reviewer commit (writes via user-scoped RPCs) |
| `/api/v1/voice/notes` | POST (stream) | Deepgram relay → structured note draft (T2) |
| `/api/v1/brain/query` | POST | Agency Brain Q&A (RBAC-aware retrieval; SSE stream; citations) |
| `/api/v1/exports/quickbooks` | POST | Build claim/invoice export batch |
| `/api/v1/webhooks/{twilio\|checkr\|docusign\|powersync}` | POST | Signed inbound webhooks → `q_integrations` |
| `/api/v1/admin/*` | — | Settings, templates, rules (permission-gated; config-audit on every change) |

## 5. Native e-signature spec (internal signatures — D-004)

Legally robust internal e-sign without a vendor round-trip: (1) signer authenticated at **AAL2** (MFA-verified session — recorded); (2) explicit intent UI ("Sign as RN — this creates a permanent record"); (3) signature row binds `content_hash` of the exact `form_version` (any content change = new version = new signature required); (4) immutable `signature` + `audit_event` capture who/when/IP/UA/method; (5) rendered PDFs stamp signer, timestamp, and hash excerpt. External parties (physician orders, client consents where remote) route through **DocuSign under BAA**, with the completed envelope archived to `document` and hash-linked to the instance.

## 6. Integration specifications

### 6.1 EVV — a state-agnostic canonical record behind a translating adapter (D-026)

- **Posture.** CareOS is the operational system of record. Where a state runs a **closed, state-mandated EVV** — the working assumption for Maryland's ISAS within LTSSMaryland, for Medicaid personal-care services — **that state's system remains the system of record for Medicaid EVV**: we integrate and reconcile, we do not replace. What this section previously drew as a corollary — that the exact modality (API, SFTP batch, dual-entry alternative-EVV rules) had to be settled before EVV could be designed — is **superseded by D-026**. It does not have to be, because the internal record is identical under an open and a closed model; CareOS builds the canonical object and lets an adapter translate. **Discovery item D-Q16** (Doc 04 §8) and **V17** (open-vs-closed) both remain open: they now select an `evv_adapter` column value and gate the flip to live submission, not the design.
- **The canonical record.** `public.evv_record` carries exactly the six federally required Cures-Act elements, named for what they are and nothing else: `service_type_id`, `client_id`, `service_date`, `service_location_version_id`, `caregiver_id`, `start_at`/`end_at`. It is built by `app.build_evv_record` (§3.6) deterministically from the append-only ledger — honouring corrections, so a time a human already fixed is never quietly re-filed — with `element_completeness`, `is_complete` and a canonical `record_sha256`. No state's field names, code lists or file layout appear anywhere in the schema. Building a single state's format into the database is what would have made the open-vs-closed answer load-bearing; every incumbent did it, and it is the mistake this design refuses.
- **The adapter seam.** `public.evv_adapter` is one row per `(tenant_id, target, state_code)` with `target ∈ {isas, sandata, hhax, none}`, `mode ∈ {capture, reconcile, dual, disabled}`, `enabled boolean`, `adapter_version`, and a `config jsonb` that is **structurally non-secret** — a CHECK refuses any object carrying `api_key`, `secret`, `client_secret`, `password`, `token` or `bearer`, because adapter credentials live in Vault (Doc 09 §5). A second CHECK makes `enabled` with `mode='disabled'` unrepresentable. Maryland ships as **`('isas','MD', mode='reconcile', enabled=false)`**, seeded for every tenant. Flipping to an open model is one row update plus an adapter implementation; flipping the state is a new row. Neither is a migration.
- **Flow.** `visit_event` → `app.build_evv_record` (client lane, `evv.manage`) → `app.submit_evv` appends an `evv_submission` attempt and hands off through the outbox (`evv.submitted` on `q_events`) → the Edge Function worker holds the vendor connection and reports back through **`app.reconcile_evv`, which is granted to `service_role` alone** → append-only state machine `pending → submitted → accepted|rejected → reconciled`, each outcome a **new row** for the same `(evv_record_id, adapter_id, attempt_no)`, projected onto `visit.evv_status`. Nightly **reconciliation report** (CareOS vs state deltas) feeds the coordinator exception queue. Rejects never edit history: corrections are new events referencing originals, and a rebuilt record appends with `supersedes_id`.
- **Disabled is a first-class state, not an error.** With no enabled adapter, `app.submit_evv` returns `{ok:true, skipped:true, reason:'adapter_disabled'}`. That is the shipped Maryland posture and the reason the whole layer is exercisable end-to-end today: capture, canonicalisation, completeness and hashing are all live and tested; only the last hop is dark. **No live submission endpoint is wired until D-Q16/V10/V17 resolve** (D-026 condition), and the path is feature-flagged (`evv.submission`, `evv.offline_capture`) as well as adapter-disabled.
- **PHI direction of travel.** Vendor codes come back; client details do not. `evv_submission.response_message` is vendor prose, truncated and bounded by CHECK, and nothing downstream may render it to a caregiver surface, put it in a notification, or feed it to a model.
- **Non-Medicaid clients:** CareOS EVV runs identically (private-pay accountability is a product goal), minus state submission — `service_type.evv_required` and `payer_kind` decide, not a hard-coded payer list.
- **Failure doctrine:** the state system down ⇒ care and clocking proceed; the outbox drains on recovery; aging submissions alert at 24 h/72 h.

### 6.2 Twilio (SMS/voice) — BAA required
Messaging Service + registered **10DLC** campaign (lead time — start Sprint 0). Content rule: operational minimum ("Your 2:00 PM shift is confirmed — details in CareOS"), no diagnoses or care details in SMS. Inbound webhooks signature-verified; STOP/HELP honored natively; `sms_log` stores delivery states with minimized bodies. Voice: on-call hotline → IVR → escalation policy; call metadata logged to the on-call log (COMAR 1-hr response evidence).

### 6.3 Checkr (background checks) — supports COMAR 10.07.05.10
Candidate invite from onboarding flow → status webhooks (`invitation.completed`, `report.completed`, adjudication) → `credential` rows of type `background_check` with report reference (no raw report content stored beyond required determinations). **Adjudication is always human** (FR-AI-052 boundary); Maryland State CHRC handled procedurally alongside (tracked as a credential type with document evidence).

### 6.4 QuickBooks Online (GL) — CareOS bills, QBO books
OAuth2 connection (tokens in Vault). Export batches map `billable_visit` (EVV-verified only — FR-AI-070 gate) → invoices/journal entries with idempotent external refs; payroll summary export per period; drift report reconciles QBO vs CareOS monthly. CareOS never becomes the accounting book of record (Doc 01 non-goal).

### 6.5 Deepgram (medical STT) — BAA required
Short-lived scoped tokens minted server-side; live streaming for field dictation (mobile) and batch for uploads; transcripts land only in the structured-note pipeline (never raw into logs). Fallback: record-locally → batch on reconnect (offline path, Doc 10 §6).

### 6.6 Email (Resend/Postmark) — notification-not-content (D-005)
Templates contain zero PHI by construction (lint-enforced: template variables whitelisted to names-of-things-in-CareOS only, e.g., "a document requires your signature"). Deep links require full auth (+AAL2 for PHI). Bounce/complaint webhooks maintain suppression list.

### 6.7 DocuSign — external signatures only (BAA)
Envelope create from finalized versions; recipient auth ≥ access-code/SMS; `envelope.completed` webhook → archive + hash-link; voided envelopes audited.

### 6.8 PowerSync — sync plane (BAA or self-host; D-003, **narrowed by D-022**)
**Not the Phase-1 field plan.** D-022 ratified the responsive web app as the caregiver EVV surface, so offline capture ships as a PWA + IndexedDB queue replaying through the same Lane-B RPC, made safe by the `client_event_id` idempotency contract in §2.2 — not by a sync engine. D-003 is unchanged as the ratified answer **if** a native app is ever built, and the spec below is what would then apply; V3 (PowerSync BAA) is consequently not launch-blocking. Nothing in the Verified Visit layer depends on it.

Reads: logical replication from Postgres filtered by **sync rules** that mirror `care_team_assignment` scoping (a caregiver's device receives *only* their clients/shifts/templates). Writes: SDK upload queue → PostgREST/RPCs **under the user's JWT** — RLS remains the single write-authority; the sync plane can never widen access. Token: Supabase Auth ES256 JWTs verified via JWKS. Ops: replication-slot/WAL monitoring per vendor guidance (Doc 13 §7).

## 7. Sequence — open-shift fill (Coordination Agent, T1)

```
Coordinator          CareOS (Lane B/C)                 Agent worker            Caregivers
    │  cancel/callout ▶ app.cancel_shift ──► outbox q_events
    │                                        └─► agent_task(open_shift_fill)
    │                                             rank candidates (matching svc)
    │                                             draft outreach plan
    │ ◄── notification: "Fill plan ready (T1)" ◄──┘
    │  app.approve_ai_action ─────────────────► execute plan:
    │                                             offer_shift → Twilio SMS (minimized)
    │                                                            ◄── "ACCEPT" reply
    │                                           app.accept_offer (first wins, locked)
    │ ◄── confirmed + full audit trail of every step (agent_step ledger)
```

## 8. Domain events (the outbox contract)

Every consequential RPC writes a `domain_event` row and sends on pgmq `q_events` **in the same transaction** as its effect (invariant 7, migration 0027 pattern). Three emitters exist, and which one a function uses is a statement about identity, not style: `app.emit_event` (session principal), `app.emit_event_internal` (session principal passed explicitly, for definer bodies that already resolved the actor), and `app.emit_event_system` (no session principal at all — sweeps and the EVV worker, where `auth.uid()` is NULL and the session emitters would raise `CAREOS_NO_TENANT_CONTEXT`).

**Payloads are IDs and enums only.** Consumers refetch under their own RLS; a subscriber never learns anything from a payload it could not have read for itself. In this layer that rule has a sharp edge: **no event carries a coordinate, a distance, an address or a person's name** (D-030). `location.verified` carries `geo_precision`, never the point; the clock events carry `location_status`, never metres; `evv.rejected` carries the vendor `response_code`, never the vendor message.

| Event | Entity | Emitted by |
|---|---|---|
| `location.created` | `service_location` | `app.create_service_location` |
| `location.revised` | `service_location` | `app.revise_service_location` |
| `location.verified` | `service_location` | `app.verify_service_location` |
| `location.geofence_set` | `service_location` | `app.set_service_location_geofence` |
| `policy.updated` | `visit_policy` | `app.upsert_visit_policy` |
| `visit.clock_in.verified` | `visit` | `app.clock_visit` — location `verified` or `not_required` |
| `visit.clock_in.exception` | `visit` | `app.clock_visit` — any other accepted location status |
| `visit.clock_out.completed` | `visit` | `app.clock_visit` |
| `visit.exception.raised` | `visit_exception` | every raise path, via `app.raise_visit_exception_internal` |
| `visit.exception.disposed` | `visit_exception` | `app.dispose_visit_exception` |
| `visit.corrected` | `visit_event` | `app.correct_visit_event` |
| `visit.missed` | `visit` | `app.detect_missed_visits` (system emitter) |
| `visit.hours.approved` | `visit` | `app.approve_visit_hours` |
| `visit.hours.rejected` | `visit` | `app.reject_visit_hours` |
| `evv.record.built` | `evv_record` | `app.build_evv_record` |
| `evv.submitted` | `evv_submission` | `app.submit_evv` |
| `evv.accepted` / `evv.rejected` | `evv_record` | `app.reconcile_evv` (system emitter) |
| `payroll.period.opened` | `payroll_period` | `app.open_payroll_period` |
| `payroll.period.closed` | `payroll_period` | `app.close_payroll_period` |
| `payroll.exported` | `payroll_export` | `app.export_payroll_period` |

The boundary of that list is itself part of the contract, so consumers do not code against events that never arrive:

- **Lifecycle events come from the trigger, not the clock.** `visit.started` and `visit.completed` are emitted by `trg_visit_domain_events` (0027) off the `visit.status` delta, in the same transaction. The three clock events above carry the *verification* story, which no single row delta expresses — a subscriber that wants both gets both.
- **Worker reconciliation is selective.** `submitted` and `reconciled` outcomes reported through `app.reconcile_evv` land on the **audit chain only** (`app.emit_audit_system(…, 'evv.reconciled', …)`); no domain event is minted for them because nothing subscribes. Only `accepted` and `rejected` fan out.
- **`visit.at_risk` is named in Doc 17 §8 but is not yet emitted.** The late-start path notifies (Doc 17 §9) rather than emitting, and the overlap and impossible-travel nudges likewise notify without an event of their own. A consumer must not wait on it today.
- **`visit.hours.rejected` and `payroll.period.opened` are emitted although Doc 17 §8 does not name them.** Both are consequential acts with an outbox obligation under invariant 7; the built emitters are authoritative and this table is the list to code against.

## 9. Contract governance
Generated artifacts in CI: TS types from the DB schema, an OpenAPI 3.1 file for `/api/v1`, and the RPC catalog doc — all diffed on every PR; breaking-change detection fails the build (Doc 13 §4). Integration credentials live per Doc 09 §5 custody matrix; every integration has a sandbox mode wired into staging and contract tests with recorded fixtures (Doc 12 §5).
