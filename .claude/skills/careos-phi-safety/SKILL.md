---
name: careos-phi-safety
description: The PHI/PII data-egress law for CareOS. MUST be used whenever code sends data anywhere — logging, error handling, notifications (email/SMS/push), Realtime, queue payloads, analytics/telemetry, file exports, AI/model prompts, third-party API calls, or URL construction. Also use when reviewing any PR that touches those paths. If data leaves a Postgres row or renders outside an authenticated PHI surface, this skill applies.
---

# CareOS PHI Safety Playbook

Deep spec: `docs/09` (esp. §7 telemetry, §5 secrets) and `docs/11 §6` (AI minimizer). HIPAA's minimum-necessary standard is implemented here as engineering allowlists, not policy documents.

## Data classes (from docs/07 tags)

**PHI** — anything about a client (name, address, DOB, diagnoses, meds, visit content, documents, even the fact of being a client). **PII** — workforce personal data (home contact, SSN-class, pay, health screenings). **OPS/CFG** — safe. When unsure, treat as PHI.

## The seven hard rules

1. **IDs travel; content is refetched under RLS.** Notifications, push, Realtime, queue messages, webhooks, emails: entity IDs + neutral titles only. "New message about one of your clients" ✅ · "Update on Mary Johnson's wound care" ❌.
2. **Email contains zero PHI structurally.** Templates use a whitelisted variable set (first names of *staff recipients*, counts, deep links). Adding a template variable = PR review by this rule.
3. **Logs/telemetry use allowlist serialization.** Log objects via the `logSafe()` helpers (IDs, codes, enums, durations, booleans). Never log: form content, free text, names, addresses, transcripts, prompts, model outputs, document text. The nightly **canary suite** plants fake-PHI markers and greps every sink — a hit is a SEV-2. Don't write a raw `console.log(obj)` on domain objects, ever.
4. **Errors are code-shaped.** `CAREOS_*` + neutral detail. Exception messages must not interpolate row content. Sentry runs behind the scrubber; new event context fields need allowlist entries.
5. **No PHI in URLs** — path/query carry opaque UUIDs only; exports/downloads via short-TTL signed URLs minted server-side after authz; `Cache-Control: no-store` on PHI responses.
6. **AI prompts = the capability's declared allowlist, nothing more.** Every model call goes through `packages/ai/client.ts`; each capability's zod input schema *is* its allowlist (docs/11 §6). Never spread a row into a prompt; never add fields to a capability's schema without justification in the PR ("needed for the task" per field). Free text a user explicitly submits for AI processing is in-scope by definition.
7. **Third parties in the PHI path require a BAA row in docs/09 §6.** No new SDK/API that receives PHI without the register updated and the vendor gate green. If the data is minimized to non-PHI, say so explicitly in the PR and show the payload shape.

## Environment law

PHI exists **only** in production (D-006). Fixtures come from the Meadowbrook synthetic generator — extend the generator, don't hand-write "realistic" records. Copying prod data anywhere is prohibited; de-identification requests escalate to a human.

## PR self-check (run it every time this skill fires)

- [ ] Every new outbound payload shape written out and classified
- [ ] Notification/queue/Realtime payloads: IDs only
- [ ] New log statements use `logSafe`; no raw domain objects
- [ ] Error paths interpolate codes, not content
- [ ] AI capability schemas unchanged, or each added field justified
- [ ] No new vendor/data flow, or register updated + flagged
- [ ] Canary suite still passes locally (`pnpm test:canary`)
