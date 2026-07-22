# CareOS — Solution Architecture v2 (Supabase + Vercel Edition)

**Client:** American Care Team (Maryland) · **Document:** 06 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Supersedes:** Doc 03 §4 (stack), §8 (integrations hosting), §10–11 (DevOps/reliability specifics). **Carries forward unchanged:** Doc 03 §1 (architecture principles), §5 (core data model concepts), §6 (immutable versioning design), §7 (security architecture intent), §9 (offline-first requirements).

> **Purpose.** The client has ratified **Supabase** as the backend platform and **Vercel** as the application platform. This document is the authoritative technical architecture on that stack — verified for HIPAA viability (mid-2026), engineered to an enterprise bar, and designed to beat the incumbent market (AlayaCare, WellSky, AxisCare, Axxess, HHAeXchange) on the axes where they are weakest: data integrity, AI-native depth, field UX, and speed of evolution.

---

## 1. Why this stack is the right call (an honest ratification, not a rubber stamp)

The pivot from the AWS-primitives design (Doc 03) to Supabase + Vercel is **approved with conditions**. The reasoning:

**What we gain.**
1. **The compliance spine drops in natively.** CareOS's two deepest design commitments — *append-only versioning* and *database-enforced row-level security* — are Postgres-native patterns. Supabase **is** Postgres. Nothing in the core design is compromised; most of it gets simpler.
2. **Verified HIPAA path on every tier of the stack.** As of mid-2026: Supabase signs BAAs for Team/Enterprise orgs with a **HIPAA add-on** and per-project **High-Compliance mode** that runs *continuous* configuration checks via its Security Advisor (e.g., it warns if connection logging is disabled — on by default for HIPAA projects since July 2026). Vercel signs a BAA **self-serve on Pro** (HIPAA add-on in billing) and on Enterprise, covering its entire global infrastructure, with annual HIPAA audits and Secure Compute (private networking) available at Enterprise. PowerSync — the offline sync engine — achieved **SOC 2 + HIPAA compliance in January 2026** on its Cloud offering and offers self-hosted editions. Every layer can be under BAA.
3. **Velocity as a competitive weapon.** One integrated data platform (DB + Auth + Storage + Realtime + Queues + Cron + Vector) plus one integrated app platform (build → preview → deploy → edge) removes an entire infrastructure-engineering headcount from the plan and cuts iteration time dramatically. Against incumbents shipping quarterly on legacy stacks, CareOS ships weekly.
4. **AI-native by construction.** `pgvector` lives *inside* the system of record, so the Agency Brain's retrieval index inherits the same RLS, the same backups, the same BAA boundary as the data itself — no second data platform to secure.
5. **Lower run-rate.** Managed Postgres + serverless app hosting at this agency's scale (≤100 staff, low-thousands of visits/month) costs a fraction of the ECS/EKS footprint in Doc 03, with better DX.

**What we accept, eyes open (managed risks — mitigations in §9 and Doc 13).**
| # | Trade-off | Mitigation |
|---|-----------|------------|
| R1 | Platform coupling to two vendors | Everything of value is **standard Postgres + standard React/Next.js**. Exit = `pg_dump` + containerized Next.js. No proprietary data formats anywhere. Exit runbook in Doc 13 §10. |
| R2 | Serverless constraints (function duration, cold starts) for long AI/document jobs | All long work is **queue-based** (Supabase Queues/pgmq) executed by workers, never inline in requests. §5. |
| R3 | "Eligibility ≠ compliance" — a BAA doesn't configure anything | Shared-responsibility matrix (§8), High-Compliance mode + Security Advisor as continuous control, and our own control mapping (Doc 09). |
| R4 | Fine-grained network topology (VPCs, private subnets) is abstracted away | Compensating controls: DB network restrictions/IP allowlisting, RLS as the authoritative perimeter, Vercel Secure Compute at Enterprise if later required, secrets custody rules (Doc 09 §5). |
| R5 | PowerSync adds a third PHI-path vendor | BAA with PowerSync Cloud (HIPAA since Jan 2026), or self-host the sync service inside our boundary. Decision D-003, Doc 00. |

**Launch-blocking conditions (Doc 00 §4 checklist):** executed BAAs with Supabase (+ HIPAA add-on enabled, project set High-Compliance), Vercel (HIPAA add-on), PowerSync, the model provider (Anthropic API BAA or Bedrock), Deepgram, Twilio, and the observability vendor — **before any PHI enters any environment.**

---

## 2. System topology

```
                                   ┌──────────────────────────────────────────────┐
                                   │                USERS                          │
                                   │  Office (web) · Nurses/Caregivers (mobile)    │
                                   │  Founder (web+mobile) · Families (portal)     │
                                   └───────────┬───────────────────┬──────────────┘
                                               │ HTTPS             │ HTTPS + Sync
                        ┌──────────────────────▼─────────┐   ┌─────▼──────────────────────┐
                        │  VERCEL (BAA · Pro/Enterprise)  │   │  MOBILE APP (Expo RN)       │
                        │  Next.js 15 App Router          │   │  Local SQLite (encrypted)   │
                        │  · RSC pages / Server Actions   │   │  PowerSync SDK              │
                        │  · Route Handlers (REST/webhk)  │   │  EVV capture · Voice notes  │
                        │  · Middleware (auth, WAF)       │   └─────┬───────────▲──────────┘
                        │  · Vercel Cron (schedulers)     │         │ sync      │ writes (PostgREST,
                        │  · AI orchestration (server)    │         ▼           │  RLS-enforced)
                        └───────┬───────────────┬────────┘   ┌─────────────────┴──────────┐
                                │ supabase-js   │ direct      │  POWERSYNC (BAA / self-host)│
                                │ (user JWT)    │ HTTPS       │  logical replication ─────► │
                                ▼               ▼             └─────────────▲──────────────┘
        ┌───────────────────────────────────────────────────────────────────┴─────────────┐
        │                SUPABASE (BAA · HIPAA add-on · High-Compliance project)           │
        │  ┌─────────────────────────── POSTGRES 16 ─────────────────────────────────┐     │
        │  │  Row-Level Security (authoritative authz) · append-only version tables  │     │
        │  │  hash-chained audit_event · pgvector (Brain index) · PostGIS (geofence)  │     │
        │  │  pg_cron (cadence engine ticks) · pgmq/Queues (events, AI jobs, outbox)  │     │
        │  │  Vault/pgsodium (column crypto) · logical replication (→ PowerSync)      │     │
        │  └──────────────────────────────────────────────────────────────────────────┘     │
        │  Auth (MFA/TOTP, AAL2, ES256 JWT) · Storage (private buckets, RLS, signed URLs)  │
        │  Edge Functions (webhooks, queue workers) · Realtime (IDs-only channels)          │
        │  PITR backups · read replica (Phase 2) · log drains → BAA observability           │
        └───────────────┬───────────────────────────────────────────────┬─────────────────┘
                        │ server-side only (BAA endpoints)              │ signed webhooks
          ┌─────────────▼───────────────┐               ┌───────────────▼───────────────────┐
          │  AI PROVIDERS (under BAA)    │               │  INTEGRATIONS                      │
          │  Claude API (Anthropic BAA)  │               │  ISAS / LTSSMaryland (EVV)         │
          │   — generation, vision-OCR,  │               │  Twilio (SMS/voice, BAA)           │
          │     extraction, agents       │               │  Checkr (background checks)        │
          │  Embeddings (BAA provider)   │               │  QuickBooks Online (GL)            │
          │  Deepgram (medical STT, BAA) │               │  DocuSign (external sigs only)     │
          │  [fallback: Bedrock, min-AWS]│               │  Email = notification-only, no PHI │
          └──────────────────────────────┘               └────────────────────────────────────┘
```

**Trust boundaries.** (1) Client devices are untrusted; every request is authenticated and authorized *at the database* by RLS — the app layer is convenience, Postgres is the perimeter. (2) PHI exists only inside BAA-covered systems: Supabase, Vercel runtime, PowerSync, the AI/STT providers under BAA, Twilio message bodies (minimized), ISAS (a state system — permitted disclosure). (3) Everything else — email, push notifications, analytics, logs by default — is **PHI-free by design** (notification-not-content pattern, §6.4).

---

## 3. Platform component decisions (the authoritative stack table)

| Layer | Choice | Why (and what it replaces from Doc 03) |
|---|---|---|
| Database | **Supabase Postgres 16** — RLS, `pgvector`, PostGIS, `pg_cron`, `pgmq` (Queues), Vault/pgsodium | Replaces RDS. Identical engine; the versioning + RLS design (Doc 03 §5–6) transfers verbatim. Extensions cover vector search, geofencing, scheduling, and durable queues **in-boundary**. |
| AuthN | **Supabase Auth** — email+password, **TOTP MFA mandatory for staff**, AAL2 enforced in RLS, asymmetric ES256 JWTs, SSO/SAML available later | Replaces Cognito. AAL claims let policies *require* MFA for PHI access at the row level (Doc 09 §2). |
| AuthZ | **Postgres RLS + permission catalog** (Doc 07) | Unchanged in concept; now the *only* authz engine — no second policy system to drift. |
| Files | **Supabase Storage** — private buckets, storage RLS policies, short-TTL signed URLs, AV-scan on ingest | Replaces S3+KMS direct. Same S3 semantics, same boundary as the DB. |
| Queues/async | **Supabase Queues (pgmq)** + `pg_cron` | Replaces SQS/EventBridge. Transactional outbox becomes trivial: domain write + event enqueue in **one transaction** (§5). |
| Server logic | **Next.js Route Handlers/Server Actions** (Vercel) for orchestration; **Supabase Edge Functions** for webhooks + queue workers close to data | Replaces ECS services. Long jobs are queue-driven workers, never request-inline. |
| Web app | **Next.js 15+ (App Router, RSC)** on Vercel | Replaces generic React/ALB. Preview deployments pair with Supabase branching for full-stack ephemeral envs (Doc 13). |
| Mobile | **Expo React Native + PowerSync** — encrypted local SQLite, sync rules mirroring assignments, offline write queue via PostgREST under RLS | Replaces WatermelonDB/custom sync. PowerSync is HIPAA-compliant (Jan 2026), integrates Supabase natively (logical replication in; RLS-checked writes out). Doc 10 §6. |
| Realtime | **Supabase Realtime** — channels carry **IDs only**, clients refetch under RLS | Live visit boards without PHI in the transport layer. |
| AI inference | **Claude via Anthropic API under an Anthropic BAA** (primary); **Amazon Bedrock in a minimal, dedicated AWS account** (fallback/multi-model) | Replaces Doc 05's Bedrock-primary stance *for this stack*: one fewer cloud when the direct BAA suffices. Vision-capable Claude also covers document extraction (see next row). Verify tier at contract (Doc 00 §4). |
| Document OCR/extraction | **Claude vision extraction (structured outputs)** primary; **AWS Textract via the minimal AWS account** as adjunct for degraded/handwritten faxes | Replaces Textract-primary. 2026 frontier multimodal extraction under one BAA simplifies the boundary; Textract stays available where classic OCR wins. |
| Speech-to-text | **Deepgram medical STT under BAA** (streaming + batch) | Replaces Transcribe Medical (no AWS dependency needed for the happy path). |
| Text-to-speech | **On-device OS TTS** (mobile) | Zero PHI egress, zero cost, offline-capable. Cloud TTS deferred. |
| E-signature | **Native CareOS click-to-sign** bound to version hash (internal); **DocuSign under BAA** only for external parties | Replaces DocuSign-primary. Internal signatures = identity (AAL2 session) + intent + version `content_hash` + audit event — stronger and cheaper (Doc 08 §5). |
| Messaging | **Twilio under BAA** (SMS/voice, 10DLC registered), minimized content | Unchanged. |
| Email | **Notification-not-content**: transactional email ("You have a new task in CareOS") with zero PHI, via Resend/Postmark | Removes email from the PHI boundary entirely. |
| Observability | **Sentry under BAA** (errors/traces, scrubbed) + Vercel & Supabase **log drains** into a BAA-covered store; OpenTelemetry throughout | Replaces CloudWatch-centric plan. PHI-scrubbing at emit is a hard rule (Doc 09 §7, Doc 13 §6). |
| IaC/config | Declarative repo: SQL migrations (Supabase CLI), `vercel.json`, config-as-code for both platforms | Replaces Terraform-heavy plan; Terraform providers optional later. |

**Two 2026 platform defaults we align with now:** (a) Supabase's Data API is moving to *explicit-grant* exposure for new tables (rolling out Apr–Oct 2026) — our schema uses explicit `GRANT`s from day one (Doc 07 §2), so the change is a no-op for us; (b) HIPAA projects keep connection logging enabled (platform default since July 2026) — required by our own audit posture anyway.

---

## 4. Application architecture (Vercel side)

- **One Next.js app, four role-scoped surfaces** (`/office`, `/clinical`, `/exec`, `/family`) sharing a component system (Doc 10). Mobile is a separate Expo app sharing a typed API/client package in the monorepo (`pnpm` workspaces: `apps/web`, `apps/mobile`, `packages/db-types`, `packages/api-client`, `packages/ui`, `packages/ai`).
- **Data access pattern — three lanes** (full contract in Doc 08): Lane A `supabase-js` with the **user's JWT** for straightforward reads/writes (RLS does the work); Lane B **Postgres RPCs** for transactional workflows (finalize form, clock in/out, acknowledge alert) — atomic, RLS-aware, audit-emitting; Lane C **server orchestration** (Route Handlers/Server Actions) for anything touching integrations or AI — which *still* uses a user-scoped client so RLS applies server-side. The `service_role` key never ships in Lane C paths; it lives only in Edge Function secrets for narrowly-scoped system jobs (Doc 09 §5).
- **Rendering doctrine:** React Server Components for data-heavy views (rosters, charts, dashboards) — zero PHI in client bundles until authorized fetch; client components only for interactivity (forms runtime, schedulers, voice capture).
- **Middleware:** session refresh, AAL2 gating for PHI routes, tenant resolution, security headers (CSP, no-store on PHI responses), Vercel WAF/Firewall rules in front.

## 5. Asynchronous backbone (how the cadence engine, agents, and integrations actually run)

Everything long-running or external follows one pattern — **transactional outbox → queue → worker → audit**:

1. A domain mutation (RPC) writes its rows **and** enqueues a `domain_event` to `pgmq` *in the same transaction* — no dual-write problem, ever.
2. Workers consume queues: **Supabase Edge Functions** on schedule (`pg_cron` → invoke) for in-boundary work (notifications fan-out, ISAS submission, embeddings), **Vercel Cron + Route Handlers** for AI orchestration (extraction, drafting, agent steps). Every worker is idempotent (event `id` = idempotency key), uses visibility timeouts + bounded retries → dead-letter queue with alerting (Doc 13 §7).
3. `pg_cron` ticks the **cadence engine** (hourly): evaluates `compliance_rule`s (COMAR intervals — 48-hr assessment, annual reassessment, 45/90/120-day supervisory visits, credential expiries) into `compliance_obligation` rows → events → notifications/escalations. Deterministic, testable, in-database — exactly as Docs 01/02 demand.
4. Named queues: `q_events` (fan-out), `q_notifications`, `q_ai_jobs`, `q_evv_isas`, `q_integrations`, each with a DLQ.

## 6. Data architecture highlights (full schema in Doc 07)

- **6.1 Append-only spine, enforced three ways:** privilege (no `UPDATE/DELETE` granted on version/audit/MAR tables), trigger (`app.forbid_mutation()` raises on any attempt), and pattern (edits = new `form_version` rows; "finalize" is a status transition via RPC). Optimistic concurrency surfaces conflicts as **keep-both**, never silent loss — the direct fix for pain #1.
- **6.2 Tamper-evident audit:** every consequential action appends to `audit_event` with a per-tenant **hash chain** (`hash = sha256(prev_hash ‖ canonical(row))`) computed by trigger; a daily `audit_anchor` root hash is exported to write-once external storage so even a DB admin can't rewrite history undetected.
- **6.3 EVV:** PostGIS geofence check at clock-in/out (`ST_DWithin(client.geofence, point, radius)`), captured with GPS accuracy + method; anomalies flag for review (never silently reject); `evv_submission` runs a per-visit state machine against **ISAS** with reconciliation reports (Doc 08 §6.1).
- **6.4 PHI minimization as schema doctrine:** notification/queue/Realtime payloads carry **entity IDs, never PHI**; recipients refetch under their own RLS. Email contains zero PHI structurally. `document` metadata separates classification from content.
- **6.5 Multi-tenancy preserved:** `tenant_id` on every row + RLS scoping — ACT is tenant #1; the SaaS-productization option stays open at zero marginal cost.
- **6.6 Retention & holds:** 6-year COMAR retention via `retention_until` + governed deletion procedure; `legal_hold` freezes any entity graph.

## 7. AI layer on this stack (design in Doc 05; implementation in Doc 11)

The Doc 05 architecture maps cleanly: **L0** = §5 backbone; **L1 services** = server-side modules in `packages/ai` calling BAA endpoints (Claude generation/vision, Deepgram STT, embeddings) with the PHI-minimizer in front of every call; **retrieval** = `knowledge_chunk` (pgvector + FTS hybrid) queried **as the requesting user** so RLS makes over-retrieval impossible by construction; **L2 agents** = durable step loops over `q_ai_jobs` with per-agent tool allowlists, spend/step caps, and kill switches; **HITL tiers T0–T3** enforced by the `ai_interaction` state machine and approval inbox; every AI event lands on the audit chain. The only material change from Doc 05: **Anthropic-BAA-direct is primary** (one boundary, no extra cloud), Bedrock demoted to fallback via a minimal AWS account if multi-model or managed guardrails are later wanted.

## 8. Shared-responsibility summary (who secures what)

| Concern | Supabase/Vercel/PowerSync do | **We must do** (owned in Doc 09/13) |
|---|---|---|
| Infra, physical, hypervisor, platform patching | ✔ (attested: SOC 2, ISO 27001, HIPAA audits) | Verify attestations annually; keep BAAs current |
| Encryption at rest/in transit | ✔ AES-256 / TLS | Column-level crypto for SSN-class fields; short-TTL signed URLs; key custody |
| Platform security features | Provided | **Configure & keep configured**: High-Compliance mode, MFA enforcement, RLS on every table, network restrictions, log drains — Security Advisor findings = P1 tickets |
| App-layer authz, audit, PHI flows | — | Entirely ours: RLS catalog, audit chain, PHI-minimizer, no-PHI-in-logs/URLs/email |
| Breach detection & notification | Platform-side events reported to us | Our IR runbook, 72-hr posture, evidence from audit chain (Doc 09 §8) |

## 9. Reliability, performance & scale posture (details in Doc 13)

- **Targets:** 99.9% availability for the web platform; **RPO ≤ 5 min** (Supabase PITR — an improvement over Doc 03's ≤1 hr), **RTO ≤ 4 hr** with quarterly restore drills. Field operations tolerate total backend outage: the mobile app is offline-first, EVV events queue locally and reconcile on restore — *care delivery never blocks on our uptime*.
- **Performance budgets:** API reads p95 < 400 ms, writes p95 < 800 ms; web LCP < 2.5 s on 4G mid-tier Android; mobile cold start < 2 s; sync delta < 5 s post-reconnect.
- **Scale headroom:** the agency's volumes (≤100 staff, ~10³ visits/mo) are ~1% of a single Supabase instance's comfort zone; compute scales vertically first, read replica in Phase 2, and the multi-tenant schema is the SaaS growth path.

## 10. How this beats the market (the competitive thesis, made technical)

| Axis | Incumbents (AlayaCare, WellSky, AxisCare, Axxess, HHAeXchange…) | CareOS |
|---|---|---|
| Data integrity | App-level edit history at best; audits reconstructed manually | **Database-enforced append-only + hash-chained audit**; survey evidence in seconds |
| AI | Bolt-on chatbots, marketing-grade "AI" | **AI-native fabric**: governed autonomy tiers, RBAC-aware Brain, document-driven intake, agents on the audit log |
| Field UX | Online-first portals that fail in basements and dead zones | **True offline-first** (local SQLite + sync), voice-first documentation |
| Compliance | Checklists on top of generic records | **Compliance by construction**: COMAR cadences as executable rules; High-Compliance platform posture |
| Fit | Generic multi-state feature sprawl | Purpose-built to this agency's operating model — then productizable |
| Velocity & TCO | Legacy stacks, quarterly releases, per-seat sprawl | Modern integrated platforms, weekly releases, a fraction of the run-rate |

---

**Decision records for this document** (logged authoritatively in Doc 00 §3): D-001 stack ratification with conditions · D-002 AI inference path (Anthropic-BAA primary) · D-003 offline sync via PowerSync (BAA or self-host) · D-004 native e-sign internal / DocuSign external · D-005 notification-not-content email · D-006 PHI-only-in-production environments · D-007 explicit-grant Data API posture · D-008 minimal-AWS account held in reserve.
