# CareOS — API & Integration Specification

**Client:** American Care Team (Maryland) · **Document:** 08 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 01 module requirements · Doc 06 §4–5 (access lanes, async backbone) · Doc 07 (RPCs, tables).

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
- **Errors:** RFC 9457 `application/problem+json` — `{type, title, status, detail, instance, code}`; `code` from a stable catalog (`CAREOS_APPEND_ONLY`, `CAREOS_AAL2_REQUIRED`, `CAREOS_NOT_ON_CARE_TEAM`, `CAREOS_CREDENTIAL_BLOCK`, `CAREOS_CONFLICT_KEEP_BOTH`, …). Postgres exceptions map 1:1 to codes. **No PHI in error bodies, ever.**
- **Idempotency:** all Lane-C mutating endpoints accept `Idempotency-Key` (UUID), persisted 48 h with response replay; Lane-B RPCs use domain keys (`client_event_id`, obligation id).
- **Concurrency:** optimistic — writes carry `row_version`; mismatch → `409` + `CAREOS_CONFLICT_KEEP_BOTH` + server copy, and the client renders the keep-both merge UX (Doc 10 §4). Nothing is silently overwritten (P2).
- **Pagination:** keyset (`?after=<cursor>&limit=`), max 200; stable ordering documented per resource.
- **Rate limiting:** Vercel WAF baseline + per-user token budget (auth endpoints 10/min, mutation lanes 120/min, AI endpoints per Doc 11 §8 cost caps) → `429` with `Retry-After`.
- **Headers:** requests carry `X-Request-Id` (generated if absent) propagated through OTel traces and into `audit_event.payload.request_id`.
- **Webhooks (inbound):** every provider endpoint verifies the provider's signature **and** timestamp window (≤5 min), enforces allow-listed source where offered, responds `2xx` fast, and defers work to `q_integrations`. Unverified → `401` + security alert.
- **Webhooks (outbound, future SaaS):** HMAC-SHA256 signed, `X-CareOS-Signature`, retries with exponential backoff ×6 → DLQ.

## 3. RPC catalog (Lane B — the workflow surface)

| RPC | Args (abridged) | Guard | Effects (all audit + outbox) |
|---|---|---|---|
| `app.finalize_form` | instance, version | AAL2 · `form.finalize`/author · signatures complete | status→final; supersedes prior |
| `app.correct_form` | instance, content, reason | AAL2 · author/`form.correct` | new version `kind='correction'` (reason mandatory) |
| `app.sign_version` | version, method | AAL2 · role in template's required set | `signature` row bound to `content_hash` |
| `app.clock_in` / `app.clock_out` | shift, geo, at, client_event_id | caregiver-of-shift | §Doc 07 — geofence, idempotent, EVV enqueue |
| `app.log_task_done` | visit, task, at, client_event_id | caregiver-of-shift | append `visit_event` |
| `app.assign_shift` | shift, caregiver | `schedule.write` · `assert_schedulable` | status→scheduled; notify |
| `app.offer_shift` | shift, caregiver[] | `schedule.write` | offers + Coordination-Agent handoff (T1) |
| `app.accept_offer` | offer | offeree | first-accept wins (row lock); rest expire |
| `app.cancel_shift` | shift, reason | `schedule.write` | status+reason; family/caregiver notify |
| `app.review_visit_exception` | visit, disposition, note | `evv.review` | exception resolution trail |
| `app.submit_evv` (worker) | visit | system | ISAS payload build + state machine advance |
| `app.upsert_credential_from_extraction` | employee, fields, doc, ai_id | `hr.write` | credential `pending`→human `verify_credential` |
| `app.verify_credential` | credential, disposition | `hr.verify` | verified/rejected + expiry obligations |
| `app.waive_obligation` | obligation, reason | RN role (COMAR waiver) | status→waived, reason logged |
| `app.satisfy_obligation` (system) | obligation, entity | system | linked evidence |
| `app.acknowledge_alert` | notification | recipient | ack trail (escalation stop) |
| `app.approve_ai_action` / `app.reject_ai_action` | ai_interaction, edit? | tier-scoped perm (`ai.approve.t1` etc.) | HITL disposition; T1 executes post-approval (Doc 11 §5) |
| `app.grant_family_access` / `app.revoke_family_access` | client, user, scope | `client.write` + consent doc | portal link rows |
| `app.start_discharge` / `app.complete_discharge` | client, forms | `client.write` · RN sign | 30-day completion clock obligation |
| `app.export_survey_packet` | client?/agency, range | `compliance.export` | evidence bundle job → signed URL (audited) |

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

### 6.1 ISAS / LTSSMaryland (EVV) — the compliance-critical one
- **Posture:** Maryland runs a **closed, state-mandated EVV** (ISAS within LTSSMaryland) for Medicaid personal-care services. CareOS is the operational system of record; **ISAS remains the state's system of record for Medicaid EVV** — we integrate/reconcile, we do not replace. Exact technical modality (API, SFTP batch, dual-entry alternative-EVV rules) is **Discovery item D-Q16** (Doc 04 §8) with the state/MCO onboarding contact — sequenced first because external lead times gate Phase 1 (Doc 15 §6).
- **Flow:** `visit_event` → worker builds the six federal Cures-Act elements (service type, individual, caregiver, date, location, begin/end time) → submit → state machine `pending→submitted→accepted|rejected→corrected→reconciled` with bounded retries → nightly **reconciliation report** (CareOS vs ISAS deltas) → coordinator exception queue. Rejects never edit history: corrections are new events referencing originals.
- **Non-Medicaid clients:** CareOS EVV runs identically (private-pay accountability is a product goal), minus state submission.
- **Failure doctrine:** ISAS down ⇒ care and clocking proceed; queue drains on recovery; aging submissions alert at 24 h/72 h.

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

### 6.8 PowerSync — sync plane (BAA or self-host; D-003)
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

## 8. Contract governance
Generated artifacts in CI: TS types from the DB schema, an OpenAPI 3.1 file for `/api/v1`, and the RPC catalog doc — all diffed on every PR; breaking-change detection fails the build (Doc 13 §4). Integration credentials live per Doc 09 §5 custody matrix; every integration has a sandbox mode wired into staging and contract tests with recorded fixtures (Doc 12 §5).
