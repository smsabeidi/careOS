# CareOS — Security, Identity & Compliance Implementation

**Client:** American Care Team (Maryland) · **Document:** 09 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 02 §6 (HIPAA matrix incl. 2026 NPRM direction) · Doc 03 §7 (security intent) · Doc 06 (platform) · Doc 07 (RLS/schema).

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
| Device posture (mobile) | Biometric/PIN app-lock; encrypted local DB (SQLCipher-class via PowerSync-supported encryption); jailbreak/root detection → PHI features disabled; remote device deactivation list checked at sync. |
| Service identities | `system` app_user rows per worker (audit attribution); machine creds scoped + rotated (§5). |

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
| Client-side | `Cache-Control: no-store` on PHI responses; RSC keeps PHI out of JS bundles; mobile screens with PHI flag `FLAG_SECURE`/screenshot-discouraged mode. |

## 5. Secrets & credential custody matrix (binding)

| Secret | Lives in | Never in | Rotation |
|---|---|---|---|
| Supabase `service_role` key | Supabase Edge Function secrets; CI deploy context (masked) | Vercel runtime env, client code, repo | 90 d + on personnel change |
| Supabase `anon` key | Public by design (RLS is the guard) | — | On incident |
| DB direct credentials (migrations) | CI secret store only | Laptops (use `supabase login` per-dev), runtime | 90 d |
| Anthropic / Deepgram / Twilio / Checkr / QBO / DocuSign | Vercel encrypted env (server-only) or Vault rows; least-scope per key | Client bundles, logs | 90 d + on incident |
| PowerSync connection (replication role) | PowerSync config (its own credential vault) | App code | 180 d |
| Webhook signing secrets | Vercel env + provider dashboards | Repo | 180 d |
| Break-glass owner credential | Vault, dual-control sealed | Anyone's head | On use |

Rules: no secret in the repo (secret-scanning in CI blocks); every secret has an owner + rotation date in the vendor register; personnel offboarding checklist includes credential rotation touch-list.

## 6. Vendor & BAA register (the PHI supply chain)

| Vendor | Role in PHI path | Instrument | Status gate |
|---|---|---|---|
| Supabase | DB, Auth, Storage, Functions, Queues | BAA + HIPAA add-on + High-Compliance project | **Launch-blocking** |
| Vercel | App runtime/hosting | BAA (Pro HIPAA add-on / Enterprise) | **Launch-blocking** |
| PowerSync | Mobile sync plane | BAA (Cloud, HIPAA since Jan 2026) **or** self-host in-boundary | **Launch-blocking** (mobile) |
| Anthropic | LLM inference (gen + vision extraction) | API BAA (qualifying tier) — else Bedrock fallback under AWS BAA | **Launch-blocking** (AI features) |
| Deepgram | Medical STT | BAA | Blocking for voice features |
| Twilio | SMS/voice (minimized PHI) | BAA | Blocking for messaging |
| Sentry | Error/trace telemetry (scrubbed) | BAA + server-side scrubbing | Blocking for observability |
| Log store (Axiom/Datadog) | Log drains (scrubbed) | BAA | Blocking for observability |
| Checkr | Background checks (PII) | Standard DPA (+BAA posture verify) | Sprint-0 start (lead time) |
| DocuSign | External signatures | BAA | Before external-sign feature |
| QuickBooks | Financial (no clinical PHI) | Standard terms; PHI-free mapping enforced | Phase 2 |
| Resend/Postmark | Email (zero PHI by design) | Standard terms — **kept out of PHI path structurally** | — |
| ISAS/LTSSMaryland | State EVV system | State onboarding/agreements | Sprint-0 start (lead time) |

Register reviewed quarterly; every vendor: attestation on file (SOC 2/ISO/HIPAA audit), subprocessor list acknowledged, breach-notification terms recorded.

## 7. Logging, monitoring & PHI-safe telemetry

- **Three streams:** (1) *business audit* = `audit.audit_event` (hash-chained, §Doc 07); (2) *platform logs* = Supabase (auth, PostgREST, connection — kept ON per HIPAA-project default) + Vercel request logs → **log drains** to the BAA'd store, 1-yr hot / 6-yr archival for security-relevant classes; (3) *app telemetry* = OTel traces + Sentry, both behind a **scrubber** (allow-list serialization: IDs, codes, durations — never form content, names, or free text; enforced by a lint rule on log call-sites + a canary test that plants fake PHI and asserts absence downstream, Doc 12 §6).
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
| Stolen caregiver phone | Local data + session | App-lock, encrypted DB, short tokens, remote deactivate, minimal sync scope |
| Credential stuffing | Auth endpoints | Breached-pw check, MFA, rate limits, impossible-travel detection |
| Insider over-access | Curiosity browsing | Least-privilege RLS, access-pattern anomalies, quarterly reviews, audit visibility deters |
| History tampering | Admin/DBA edits | No-UPDATE privilege, triggers, hash chain + external anchors, chain-verify alarms |
| Prompt injection via faxes | Malicious doc → agent | Untrusted-input isolation, tool allowlists, T-tier gates, no raw-doc-to-action path (Doc 11 §7) |
| Webhook forgery | Integration endpoints | Signatures + timestamp windows + allowlists |
| Supply chain | npm deps, CI | Lockfiles, provenance/audit in CI, dependency review, minimal Edge Function deps |
| Data exfil via exports | Legit features abused | Export permission + volume anomaly alerts + watermarked, audited packets |
