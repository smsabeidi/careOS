# CareOS — Security, Identity & Compliance Implementation

**Client:** American Care Team (Maryland) · **Document:** 09 of 15 · **Version:** 1.1 (Draft) · **Prepared by:** OCTSERVICES LLC

> **Change note (v1.1, Aug 11 2026):** §2 gains **§2.1**, the device posture for the web field surface (**D-022**) — the native-app row is marked as the contract for an app that is not in Phase 1, and the open residue is routed to **V19**. §4 gains **§4.1**, the dual classification of location data as PHI-by-linkage with closed capture points and a closed egress rule (**D-030**). §6 records that **no geocoding or address-validation vendor is in the boundary** (**D-025**) and applies the pending **D-013** amendment: the LLM row reads OpenAI, the Anthropic and Deepgram rows are marked superseded, and V4's BAA-before-PHI condition is restated as still open. §5 and the §10 "stolen caregiver phone" row follow those two changes.

**Implements:** Doc 02 §6 (HIPAA matrix incl. 2026 NPRM direction) · Doc 03 §7 (security intent) · Doc 06 (platform) · Doc 07 (RLS/schema) · Doc 17 (verified-visit capture, location classification).

> **Purpose.** The operational security design: how identity, authorization, encryption, secrets, logging, vendor management, and incident response are actually implemented and evidenced on Supabase + Vercel. Written to be handed to an auditor. HIPAA compliance is a *program*, not a feature — this document defines the technical half and the operating rhythms of the administrative half.

---

## 1. Security architecture principles (inherited + stack-specific)

1. **Postgres RLS is the perimeter.** Every read/write is authorized at the row, in the database, regardless of which lane it came through. The app can have bugs; the perimeter holds.
2. **PHI exists only inside BAA-covered systems, and only in production.** Non-prod = synthetic data, always (D-006).
3. **Minimum necessary is engineered, not promised** — ID-only payloads, PHI-minimizer before AI calls, scrubbed logs, no PHI in URLs/email/push.
4. **Every consequential action is attributable** — to a human (AAL2 session) or a system actor, on the hash-chained audit ledger.
5. **Fail closed for access; fail open for care** — authorization errors deny; platform outages never block care delivery (offline-first field ops).

## 2. Identity & authentication (Supabase Auth)

| Control | Implementation |
|---|---|
| Staff enrollment | Invite-only (`app_user.status='invited'`); no self-signup. First login forces password (zxcvbn-scored, breached-password check) **and TOTP MFA enrollment** — session stays AAL1-limited (no PHI) until MFA completes. |
| MFA | TOTP mandatory for all staff; recovery codes issued once, hashed at rest; family portal: MFA strongly encouraged, required for any document access. SMS OTP is **not** an accepted second factor for staff (SIM-swap risk). |
| AAL2 gating | PHI-class tables/policies require `app.is_aal2()` (Doc 07). Step-up prompt on demand; AAL2 idle timeout 15 min → re-challenge; absolute session 12 h web / 30 d mobile refresh with rotation + reuse detection. |
| JWTs | Asymmetric **ES256**, short-lived access tokens (≤1 h) via JWKS — verified by PostgREST, PowerSync, and our servers alike. Custom claims kept minimal (no PHI in tokens). |
| Session revocation | `app.revoke_user_access(user)`: bans auth user, revokes refresh tokens, sets `status='separated'` + `separated_at`, ends open `care_team_assignment`s, expires PowerSync sync buckets, invalidates device push tokens. Target ≤ 15 min from HR trigger — **beats the proposed 2026 rule's 1-hour bar**. Drill quarterly. |
| Device posture (native app) | *Retained as the contract for a native app, which **D-022 removed from Phase 1**. This row is **not** the shipped field posture — see §2.1.* Biometric/PIN app-lock; encrypted local DB (SQLCipher-class via PowerSync-supported encryption); jailbreak/root detection → PHI features disabled; remote device deactivation list checked at sync. |
| Device posture (web field surface) | The caregiver EVV surface is the responsive web app (D-022). Its controls are in §2.1 — different controls, not the row above restated in weaker words. |
| Service identities | `system` app_user rows per worker (audit attribution); machine creds scoped + rotated (§5). Non-human principals reach AAL2 by signing-key custody rather than TOTP, scoped to broker-minted ≤5-minute tokens (D-020). |

### 2.1 Device posture on the web field surface (D-022)

The controls above were written for a managed native app on a device the agency enrols. D-022 made the responsive web app the caregiver EVV surface and narrowed D-003/PowerSync to a future-optional lane, so the field device is now a browser on a caregiver's own mid-range Android: it cannot be app-locked by us, cannot be attested, and cannot be wiped. What follows is what actually holds. It is a different control set reaching the same objective, not the native row with the verbs softened.

| Control | Implementation (web) |
|---|---|
| Session lifetime | Supabase SSR cookie session, refreshed in `apps/web/src/middleware.ts` on every request; §2's AAL2 idle 15 min → re-challenge and 12 h absolute web session govern the field surface too. The "30 d mobile refresh" clause has **no field surface** under D-022 and applies only if a native app is built. A shorter absolute session for shared or personal devices is an open decision (**V19**). |
| Step-up gating | Unauthenticated → `/login`; authenticated at AAL1 on any path outside `{/login, /mfa, /accept}` → `/mfa` step-up. `/accept` is AAL1 by design (a new hire has no TOTP factor yet and invitation acceptance exposes no PHI). The demo persona bypass is route-gating only, is doubly guarded (`CAREOS_DEMO_MODE` **and** `NODE_ENV !== 'production'`), and never touches `app.is_aal2()` — the database gate is untouched by it. |
| Response caching | `next.config.ts` sends `Cache-Control: no-store` on `/(office\|clinical\|exec\|today\|family)/:path*`; RSC keeps PHI out of the JS bundle (§4). |
| Service-worker cache scope | `apps/web/public/sw.js` is an **allowlist, not a denylist**, and is a security boundary in its own right: (1) non-GET is never intercepted, so every Server Action — the clock RPC and every other write — bypasses the worker entirely; (2) cross-origin is never intercepted, so Supabase traffic goes straight to the network; (3) navigations are **network-only** and are never written to a cache, with a synthesised, data-free offline document as the fallback (inline, so it cannot be poisoned by a `/login` redirect at install time); (4) everything else passes through unless its path is on `STATIC_PREFIXES` — `/_next/static/`, the icons, `/manifest.webmanifest`, `/auth-art.jpg`. **No PHI response can enter the cache**, and a new route or data path cannot become cacheable by accident; someone has to add it on purpose. One cache key (`careos-v1-shell`); activation deletes every other. |
| Durable device storage | Exactly one store: the IndexedDB clock queue `careos-offline` (`src/lib/offline/queue.ts`), holding `visit_id`, the event kind, the device's own coordinates for that attempt, the device capture time, and two opaque ids. No name, address, note, diagnosis or schedule. Free text is **structurally** excluded — a location-exception reason needs the rejected event to exist server-side first, so it is an online-only action. Entries are deleted on successful delivery; the module degrades to a no-op (never a silent drop) where IndexedDB is blocked. |
| Location capture | One best-effort fix per clock attempt, hard-capped, then the watch is released. No background location, no mid-visit polling — see §4.1. |
| What replaces remote wipe | Three things, because no one of them is a wipe. (a) **Revocation is server-side:** `app.revoke_user_access` bans the auth user and revokes refresh tokens, so a lost device's session dies within the ≤1 h access-token tail against a ≤15 min operational target — the same control, and it never depended on the device co-operating. (b) **There is little to wipe:** the SW cache holds build output and brand assets; the queue holds ID-shaped rows that delete themselves on delivery. (c) **RLS is the perimeter:** a recovered cookie without a live AAL2 session reads no PHI. |
| Shared-device posture | **Open (V19).** Sign-out is a Server Action calling `supabase.auth.signOut()`; it ends the session but cannot reach IndexedDB, so an undelivered queue entry survives sign-out — deliberate for the caregiver's own phone (undelivered work must not be destroyed), undecided for a shared one. V19 must also rule on whether a `Permissions-Policy: geolocation=(self)` header is set (none is today) and whether the field surface is restricted to enrolled devices at all. |

Residual risk, stated plainly: an unlocked device with a live AAL2 session. That is bounded by the idle timeout and by revocation, not by remote wipe, and the §10 "stolen caregiver phone" row is read through this table for the web surface.

## 3. Authorization (recap + operations)

Role catalog and permissions are **data** (Doc 07 §3), seeded from the Doc 01 RBAC matrix; changes to roles/permissions are themselves audited config events. **Access reviews:** quarterly — system-generated report (users × roles × last-activity × assignments) signed off by the administrator; leavers list reconciled against `separated_at` (evidence for the revocation control). **Break-glass:** a sealed `owner`-role emergency credential (Vault-stored, dual-control) whose use pages everyone and auto-opens an incident.

## 4. Data protection

| Layer | Implementation |
|---|---|
| In transit | TLS 1.2+ everywhere (platform-enforced); HSTS; no PHI in query strings **ever** (lint + WAF rule). |
| At rest | Platform AES-256 (Supabase/Vercel/PowerSync attestations on file). |
| Column-level | Supabase **Vault** envelope encryption for highest-sensitivity fields (`client.medicaid_id`, SSN-class HR fields, integration tokens); column privileges revoked; access only via audited accessor RPCs. |
| Files | Private buckets + storage RLS; signed URLs TTL ≤ 5 min, minted server-side post-authz; AV scan on ingest; EXIF-strip on photos. |
| Backups | Supabase PITR (RPO ≤ 5 min); backup access = platform-controlled, covered by BAA; restore drills quarterly (Doc 13 §8). |
| Client-side | `Cache-Control: no-store` on PHI responses; RSC keeps PHI out of JS bundles; mobile screens with PHI flag `FLAG_SECURE`/screenshot-discouraged mode *(native-app control — a browser has no equivalent, and D-022 makes the browser the field surface; see §2.1 for what does hold there)*. |

### 4.1 Location data is PHI-by-linkage, and its capture points are closed (D-030)

A caregiver's coordinates at a visit are the client's home address. That makes location a **dual classification the rest of this document does not have a row for**: it is PHI about the client *and* workforce PII about the caregiver, at the same time, in the same value. Neither classification relaxes the other — the client's protections apply because it is their address, and the caregiver's apply because it is a record of where an employee's body was at a timestamp. Everything below follows from taking both seriously at once.

| Control | Implementation |
|---|---|
| Capture points (closed list) | **Clock-in and clock-out only**, through `app.clock_visit`. No continuous tracking, no background location, no mid-visit polling, no capture on any other screen. The browser acquires one best-effort fix per attempt (`apps/web/src/app/today/locate.ts`): it watches, keeps the tightest fix, stops early at 60 m, gives up hard at 8 s, and releases the watch either way. A missing fix is a lawful outcome (`location_status='unavailable'`), never an error. |
| Where raw values live | Exactly two places. `public.visit_event.latitude/longitude/accuracy_m` and the derived `distance_m`, behind RLS + `app.is_aal2()`; and the caregiver's own IndexedDB queue, for as long as an offline event is undelivered (§2.1). Nowhere else, ever. |
| Egress (closed rule) | Coordinates and coordinate-derived metres **never** appear in: `audit.audit_event.payload`, `domain_event`/outbox payloads, notification payloads, telemetry or analytics, error messages, URLs, or any AI prompt. The clock event's audit payload is `{visit_id, method, capture_source, location_status, is_offline}` — the enums that make the event legible after the fact, and nothing that would survive an export. |
| What the caregiver sees | A `distance_bucket` — `inside` / `near` / `far` — returned by `app.clock_visit`. Never metres, never an accuracy radius. Telling a caregiver they are "312 m away" is surveillance-grade precision serving no operational purpose in a doorway. |
| What an administrator sees | Metres, as evidence, inside RLS-gated surfaces only (`public.verified_visit`). Distance is legitimate evidence on a review screen and illegitimate on a telemetry surface, because telemetry is the thing that gets charted, exported and pasted into a ticket. |
| Telemetry | `public.evv_capture_fact` selects **no** coordinate column and buckets accuracy before it is aggregated; `app.evv_observability` reports the histogram and refuses a geographic breakdown outright (Doc 13 §6.1). |
| Enforcement, not intention | The pgTAP suite plants a distinctive latitude, clocks a visit, and asserts zero occurrences downstream in the audit chain and the outbox (`supabase/tests/database/0046_clock_engine.sql`); the `verified_visit` and `evv_capture_fact` view definitions are grepped in their own catalog for coordinate columns, so the property stays true rather than remembered. |

The rule is closed on purpose and before the surfaces existed. Migration 0013 had already excluded lat/lng from its audit payload by instinct; D-030 generalises that instinct into a rule, so that ten new surfaces do not each get to make the decision again and get it right nine times.

## 5. Secrets & credential custody matrix (binding)

| Secret | Lives in | Never in | Rotation |
|---|---|---|---|
| Supabase `service_role` key | Supabase Edge Function secrets; CI deploy context (masked) | Vercel runtime env, client code, repo | 90 d + on personnel change |
| Supabase `anon` key | Public by design (RLS is the guard) | — | On incident |
| DB direct credentials (migrations) | CI secret store only | Laptops (use `supabase login` per-dev), runtime | 90 d |
| OpenAI (`OPENAI_API_KEY`) / Twilio / Checkr / QBO / DocuSign | Vercel encrypted env (server-only) or Vault rows; least-scope per key | Client bundles, logs | 90 d + on incident |
| PowerSync connection (replication role) | PowerSync config (its own credential vault) | App code | 180 d |
| Webhook signing secrets | Vercel env + provider dashboards | Repo | 180 d |
| Break-glass owner credential | Vault, dual-control sealed | Anyone's head | On use |

Rules: no secret in the repo (secret-scanning in CI blocks); every secret has an owner + rotation date in the vendor register; personnel offboarding checklist includes credential rotation touch-list. Two entries are absent on purpose, and their absence is itself a control: **the model-provider row named Anthropic and Deepgram until D-013 consolidated the whole model plane (inference, transcription, embeddings) onto OpenAI** — those keys are superseded, not co-existing, and either one appearing in an env is drift; and **no geocoding or map-provider key exists in any custody location**, because there is no such vendor (D-025, §6) — a key of that shape appearing anywhere would itself be the finding.

## 6. Vendor & BAA register (the PHI supply chain)

| Vendor | Role in PHI path | Instrument | Status gate |
|---|---|---|---|
| Supabase | DB, Auth, Storage, Functions, Queues | BAA + HIPAA add-on + High-Compliance project | **Launch-blocking** |
| Vercel | App runtime/hosting | BAA (Pro HIPAA add-on / Enterprise) | **Launch-blocking** |
| PowerSync | Mobile sync plane | BAA (Cloud, HIPAA since Jan 2026) **or** self-host in-boundary | ~~Launch-blocking (mobile)~~ → **future-optional (D-022)**; V3 is required only if a native app is built |
| OpenAI | The whole model plane: LLM inference (generation + vision extraction), transcription, embeddings | API **BAA + Safety-Retention** provisioning; per-workload ZDR-eligible lanes for synchronous PHI paths — else Bedrock fallback under AWS BAA (D-008 reserve account) | **Launch-blocking** (AI features) — **V4, open** |
| ~~Anthropic~~ | ~~LLM inference (gen + vision extraction)~~ | — | **Superseded by D-013** — not in the boundary |
| ~~Deepgram~~ | ~~Medical STT~~ | — | **Void (D-013)** — STT consolidated onto OpenAI transcription; V7's Deepgram clause no longer applies |
| Geocoding / address validation | **None — deliberately outside the boundary (D-025)** | — | n/a; see the note below before adding one |
| Twilio | SMS/voice (minimized PHI) | BAA | Blocking for messaging |
| Sentry | Error/trace telemetry (scrubbed) | BAA + server-side scrubbing | Blocking for observability |
| Log store (Axiom/Datadog) | Log drains (scrubbed) | BAA | Blocking for observability |
| Checkr | Background checks (PII) | Standard DPA (+BAA posture verify) | Sprint-0 start (lead time) |
| DocuSign | External signatures | BAA | Before external-sign feature |
| QuickBooks | Financial (no clinical PHI) | Standard terms; PHI-free mapping enforced | Phase 2 |
| Resend/Postmark | Email (zero PHI by design) | Standard terms — **kept out of PHI path structurally** | — |
| ISAS/LTSSMaryland | State EVV system | State onboarding/agreements | Sprint-0 start (lead time) |

Register reviewed quarterly; every vendor: attestation on file (SOC 2/ISO/HIPAA audit), subprocessor list acknowledged, breach-notification terms recorded.

**Model provider (D-013 amendment).** This register named Anthropic as the LLM vendor and Deepgram as the STT vendor, per D-002 and Doc 11. D-013 ratified **OpenAI** as the primary provider for the AI plane that was actually built (`apps/web/src/lib/ai/client.ts`, migrations 0014–0015 — workhorse `gpt-5.6-luna`, synthesis `gpt-5.6-terra`, transcription `gpt-transcribe`, embeddings `text-embedding-3-small`, pinned per capability in the `ai_capability` registry) and consolidated speech-to-text onto OpenAI transcription: one BAA fewer, and V7's Deepgram clause is void. **The condition travels with the row and has not been met:** no real PHI enters a prompt until the OpenAI BAA and Safety-Retention provisioning are executed and recorded here. That is **V4, still open** — it reads OpenAI now, not Anthropic. Until it closes, every model path runs on synthetic or de-identified data (D-006); fine-tuning and `store:true` capture stay synthetic-or-de-identified permanently regardless (Doc 16 §3.3).

**No geocoding or address-validation vendor is in the boundary (D-025).** A service address is PHI, so a geocoder is a PHI processor — and the obvious candidate is disqualified on its own terms: **Google Maps Platform, which hosts the Address Validation API, is not among Google's BAA-eligible services.** Sending a client's address there would have been a HIPAA finding, not a feature. It is also unnecessary. Geofence evaluation needs a *trusted* coordinate, and a coordinator confirming a pin once at intake is more defensible than an API's guess. So address normalisation is deterministic and in-database (`app.normalize_address()` — a pure `immutable` SQL function doing USPS-style suffix and directional folding), and the coordinate is **human-attested**: `public.service_location_version` carries `geo`, `geo_precision` and `geo_source`, and cannot reach `verification='verified'` without `verified_by` **and** `verified_at` (CHECK `chk_slv_verified_needs_human`). `verified_by` is an FK to `public.app_user`, so an AI capability — which has no row there — can never satisfy it; the rule is enforced by a constraint rather than asserted in a prompt (the D-015 pattern).

The vendor seam exists and ships **disabled**. A future provider enters as two things together, never one: a `geo_source='provider'` row (carrying `geo_provider`, `geo_provider_place_id`, and `geo_provider_response_sha256` — provenance only, never the raw response), **and** a row in this register with a BAA executed first. No schema change is needed and none is a substitute for the register entry.

## 7. Logging, monitoring & PHI-safe telemetry

- **Three streams:** (1) *business audit* = `audit.audit_event` (hash-chained, §Doc 07); (2) *platform logs* = Supabase (auth, PostgREST, connection — kept ON per HIPAA-project default) + Vercel request logs → **log drains** to the BAA'd store, 1-yr hot / 6-yr archival for security-relevant classes; (3) *app telemetry* = OTel traces + Sentry, both behind a **scrubber** (allow-list serialization: IDs, codes, durations — never form content, names, free text, or coordinates (§4.1); enforced by a lint rule on log call-sites + a canary test that plants fake PHI and asserts absence downstream, Doc 12 §6).
- **Detections wired at launch:** impossible-travel & novel-device logins; RLS-denial spikes per user (enumeration probing); mass-export patterns; after-hours PHI access anomalies; Security-Advisor finding = P1 ticket; audit-chain verification job (recompute + compare anchors) daily; DLQ growth; webhook signature failures.
- **SIEM-lite:** the log store's alerting covers the above; a full SIEM is a scale-triggered upgrade, not a launch need.

## 8. Incident response & breach handling

**Severities:** SEV-1 confirmed PHI exposure/tamper or platform-wide outage · SEV-2 suspected exposure or security control failure · SEV-3 contained security bug. **Flow:** detect → on-call (Doc 13 §9) → contain (revoke creds/sessions, disable capability flags, isolate) → assess with counsel whether a HIPAA **breach** (LoProCo risk assessment, documented) → notify per Breach Rule (individuals ≤60 d; HHS; media if ≥500) and **72-h posture** to align with the stricter proposed Security Rule + BAA commitments → eradicate/recover (PITR restore if integrity-affected; audit anchors prove scope) → blameless postmortem ≤5 business days with tracked actions. Tabletop exercise twice yearly (one scenario = "founder's account compromised"; one = "malicious insider edits history" — the audit chain must catch it).

## 9. HIPAA Security Rule control mapping (excerpt — full matrix maintained in `compliance/hipaa-map.md`)

| 45 CFR §164.312 control | CareOS implementation | Evidence |
|---|---|---|
| (a)(1) Access control | RLS catalog + permission grants; AAL2 gating | Policy catalog + pgTAP results |
| (a)(2)(i) Unique user ID | Supabase Auth per-human accounts; system actors named | User export |
| (a)(2)(iii) Auto logoff | AAL2 idle 15 min; session absolutes | Config + test |
| (a)(2)(iv) Encryption/decryption | AES-256 at rest; Vault column crypto | Attestations + schema |
| (b) Audit controls | Hash-chained `audit_event` + platform logs + drains | Anchor exports; chain-verify job |
| (c) Integrity | Append-only enforcement (privilege+trigger); content hashes; signatures bound to hashes | pgTAP `forbid_mutation` suite |
| (d) Person/entity authentication | Password policy + mandatory TOTP; ES256 JWTs | Auth config |
| (e) Transmission security | TLS 1.2+; signed webhooks; signed URLs ≤5 min | Config + scans |

**Administrative safeguards** (§164.308) operating rhythms: annual risk analysis (first one = pre-launch gate), sanctions policy, security-awareness training at onboarding + annual, contingency plan = Doc 13 DR + this §8, quarterly access reviews (§3), BA management = §6. **2026 NPRM readiness deltas tracked:** mandatory-MFA ✔ · encryption-no-exceptions ✔ · ≤1-h revocation ✔ (15-min target) · annual pentest + 6-month vuln scans → calendared with vendor selected in Sprint 0 · asset/data-flow inventory → auto-generated from the vendor register + architecture doc · network segmentation analog → project isolation, PHI-only-in-prod, Secure Compute option held.

## 10. Threat model (STRIDE-lite, top items)

| Threat | Vector | Mitigations |
|---|---|---|
| Stolen caregiver phone | Local data + session | **Web field surface (D-022, the shipped case — read §2.1):** server-side revocation, short tokens, AAL2 idle re-challenge, a cache that holds only build output, and a device queue of ID-shaped rows deleted on delivery. **Native app (if built):** app-lock, encrypted DB, remote deactivate, minimal sync scope. |
| Credential stuffing | Auth endpoints | Breached-pw check, MFA, rate limits, impossible-travel detection |
| Insider over-access | Curiosity browsing | Least-privilege RLS, access-pattern anomalies, quarterly reviews, audit visibility deters |
| History tampering | Admin/DBA edits | No-UPDATE privilege, triggers, hash chain + external anchors, chain-verify alarms |
| Prompt injection via faxes | Malicious doc → agent | Untrusted-input isolation, tool allowlists, T-tier gates, no raw-doc-to-action path (Doc 11 §7) |
| Webhook forgery | Integration endpoints | Signatures + timestamp windows + allowlists |
| Supply chain | npm deps, CI | Lockfiles, provenance/audit in CI, dependency review, minimal Edge Function deps |
| Data exfil via exports | Legit features abused | Export permission + volume anomaly alerts + watermarked, audited packets |
