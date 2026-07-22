---
name: careos-compliance-context
description: The regulatory ground truth for engineering decisions. Use whenever work touches compliance rules or cadences, assessments/supervisory visits, credentials/personnel requirements, retention or deletion, legal holds, consents, discharge, EVV/ISAS obligations, audit evidence/exports, or any UI copy naming a regulation. Also use before citing COMAR/HIPAA/EVV requirements anywhere — engineers (and agents) must not cite regulations from memory.
---

# CareOS Compliance Context (for engineers)

Authoritative mapping: `docs/02` (read the section before building against it). This skill is the working quick-reference + the discipline rules. **Never cite a regulation from memory — trace it to docs/02, and encode the citation in `source_ref`.**

## The cadence quick-reference (deterministic engine — Engine 1, never LLM)

| Rule key | Cadence | Source (per docs/02 §3) |
|---|---|---|
| `assessment.initial` | At/for admission | COMAR 10.07.05 assessment reqs |
| `assessment.48h_high_acuity` | ≤48 h for high-acuity admissions | COMAR 10.07.05 |
| `assessment.annual` | Every 365 d | COMAR 10.07.05 |
| `supervisory.45d / .90d / .120d` | By medication-involvement level (administers / assists / none) | COMAR 10.07.05.12 |
| `oncall.response_log` | 24/7 coverage; 1-h response evidence | COMAR 10.07.05 |
| `records.retention` | ~6-year retention; discharge record completion ≤30 d | COMAR 10.07.05.15 |
| Personnel gates | License verify, background check, TB screen, training before serving | COMAR 10.07.05.10–.11 |

Implementation rules: cadences live as `compliance_rule` rows with `source_ref` populated (a surveyor traces software behavior to regulation through that column); date math in `app.evaluate_compliance()` only; **waivers are RN-only with mandatory reason** (the RPC enforces both); "significant change" triggers are event-driven rules, not hardcoded.

## EVV / ISAS doctrine

Six Cures-Act elements per visit (service, individual, caregiver, date, location, begin/end). Maryland Medicaid EVV = **ISAS within LTSSMaryland** — the state's system of record for Medicaid EVV; CareOS reconciles, never presumes to replace. **ISAS down never blocks care**; rejects become corrections (new events), and the reconciliation report is the compliance artifact. Non-Medicaid clients get identical CareOS EVV minus submission.

## Retention, deletion & holds

Default `retention_until` ≈ 6 years per record class; deletion **only** via the governed `app.retention_sweep()` (audited); `legal_hold` freezes an entity graph and wins over retention. Any feature that could remove data (including "cleanup" scripts) routes through this — there is no other delete path, don't create one. Client-record exports/discharge packets are permissioned, watermarked, audited.

## HIPAA posture in code terms

We build to the stricter 2026 proposed bar already ratified in docs/02/09: mandatory MFA (AAL2), encryption everywhere, **access revocation ≤15 min** (drill-verified), audit chain + anchors, annual pentest / 6-mo scans on the calendar. Minimum-necessary is the allowlist machinery (phi-safety skill) — if a feature needs more data than its allowlist, that's a design conversation, not a schema widening.

## The audit-evidence mindset (apply to every feature)

Every consequential feature must be able to answer **"show me"** in seconds: who did it, when, to which version, under what authority, and what the AI contributed (provenance labels + `ai_interaction` links). If you can't point to where a feature's evidence lives (audit event, version row, signature, obligation link), the feature isn't finished. When adding a new consequential action, add its `audit_event.action` name to the catalog and its plain-language rendering to the activity feed map.

## Escalate to humans (RN SME / compliance advisor), don't decide

Interpreting an ambiguous COMAR requirement · anything that changes what counts as "satisfied" for an obligation · consent/notice wording · new data collection about clients or staff · anything a surveyor or lawyer would read. Engineering encodes the ruling; licensed humans make it.
