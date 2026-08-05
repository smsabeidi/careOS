# Forms Intelligence & Compliance Knowledge Layer — Principal Engineering Analysis

**Date:** 2026-08-02 · **Status:** Analysis for decision · **Author:** engineering
**Input:** stakeholder research brief, "U.S. Eldercare Forms Intelligence and Compliance Knowledge Layer"
**Basis:** direct reading of migrations 0001–0011, `apps/web/src/**`, `supabase/tests/database/**`, docs/00 and 06–15
**Not:** a legal opinion. Every regulatory assertion below is attributed to the brief and marked as requiring human verification.

---

## 0.0 Corrections after merge (2026-08-03)

This analysis was written against a local tree at commit `23dab19`. The branch has since
advanced by ten commits (AI plane, approvals inbox, EVV clock-in, consent/family portal,
corporate rebrand). The following claims are **superseded**; everything not listed here was
re-verified against the merged tree and still holds.

| Claim in this document | Status after merge |
|---|---|
| "The AI layer is 100% unbuilt" (§2.3) | **False now.** Migrations 0014–0016 build it: `ai_capability`, `ai_interaction`, `ai_prompt_template`, `ai_disposition`, `knowledge_document`, `knowledge_chunk`, `ai_proposal(+_event)`, `extraction_job/_field`, `agent_task/_step`. |
| "No pgvector" (§2.3) | **False now.** Installed in `0015_ai_governance.sql`. |
| "`ai_interaction` [AO] vs a mutable status column is an unresolved contradiction" (§2.3) | **Resolved upstream**, using the interaction-row + append-only disposition-chain shape this analysis recommended: `ai_disposition` exists. |
| "`packages/ai/client.ts` (invariant 10) is 100% prose" | Partly. There is still **no `packages/` directory**; the AI client landed at `apps/web/src/lib/ai/client.ts`. Invariant 10's stated path is now doc-vs-code drift worth reconciling. |
| AI tables live in an `ai.*` schema (docs/07 §10) | Built in **`public`**, not a separate schema. Another docs/07 reconciliation item. |
| D-002 (Anthropic-direct) framing throughout | **Superseded by D-013** — OpenAI ratified as primary provider (2026-08). |
| D-012 (Apple 2026, light-only) framing | **Superseded** by the corporate rebrand (Inter type system). |
| "Migration 0012/0013/0014" as proposed numbers | Taken upstream by consent/family, visit events and the AI plane. This work landed as **0017–0019**, and its decisions as **D-014–D-019** (D-013 was taken). |
| "`scripts/check-matrix.sh` does not exist" (§2.4) | **Fixed by this branch** (ST-110). |
| "The ST-103 drift gate is currently red" (§2.4) | Was still red on `main` via the phantom `D-000`; **fixed by this branch** (DN-0008a rename). |

**Re-verified and still true:** no `retention_until`, `legal_hold`, `app.retention_sweep()`,
`domain_event` (outbox) or `public.document` in any migration; `app.approve_ai_action` still
absent; and **ST-115 remains open** — `app.assert_schedulable` still has no production caller
while `public.visit` and `public.shift` still carry direct `insert, update` grants
(`0011_scheduling.sql:137,193`), so the credential-lapse guard is still bypassable via Lane A.

---

## 0. Verdict

The brief's architecture is substantially correct. Its central claim — that this must be a *jurisdiction-aware knowledge layer with deterministic applicability and human-verified provenance*, not a PDF library and not a model fine-tuned on forms — is right, and it matches CareOS's ratified two-engine doctrine exactly. I would adopt roughly 85% of it.

Its **sequencing is wrong for CareOS**, and three of its premises are contradicted by facts in this repository — two of them in CareOS's favour.

The finding that should drive the decision is this: **the brief's single binding requirement is currently impossible in CareOS, and not by a small margin.** The brief states that "a record completed in 2026 must remain reproducible using the exact form version and rule set that applied on the date of completion." Today CareOS fails that at three independent layers (§2.1). It also already ships, in the demo tenant, a compliance table that renders the literal string `Doc 02 §3 — enrich with COMAR cite` in a column headed **Regulation** behind a shield icon, under footer copy promising a surveyor that every row traces to its regulation. That is the brief's own Risk 2 — "labeling a form as legally required without sufficient authority" — already live in the product.

So the recommendation is not "build the national layer" or "don't build it." It is: **the first phase of the brief's own architecture is work CareOS must do anyway to keep the promises it has already made to one Maryland agency.** Do that, and the national layer becomes a seam rather than a rewrite. Skip it, and CareOS is shipping compliance theatre at n=1 and would be shipping it at n=50.

---

## 1. What CareOS already has that the brief assumes must be invented

The brief was written without sight of this codebase and therefore proposes several mechanisms from scratch. Six already exist, and they are better starting points than anything greenfield. This materially reduces the cost of the layer.

| Brief requirement | What already exists | Evidence |
|---|---|---|
| A cross-tenant shared corpus in an RLS-forced world | `public.permission` — the repo's one table with **no `tenant_id`**, tagged `-- CFG (global catalog)`, RLS `enable`+`force`, policy `using (true)`, `select` grant, **zero write grants** | [`0002_identity_rbac.sql:35`](../../supabase/migrations/0002_identity_rbac.sql), `:134-138`; ratified in `matrix.yaml` |
| Version pinning for historical rendering | `form_template` is `unique(tenant_id, key, version)` with each version its own row; `form_instance.template_id` pins one row and `create_form` never re-points it | [`0005_forms_engine.sql:19-27`](../../supabase/migrations/0005_forms_engine.sql), `0006:40-42` |
| "Legal requirement vs operational best practice," modelled in data not copy | `cadence_rule.grace_days` is annotated `(regulatory)`; `at_risk_days` is annotated `operational notice lead-time (NOT regulation)` | [`0009_cadence.sql:38-39`](../../supabase/migrations/0009_cadence.sql) |
| Provenance binding that is constraint-true, not comment-true | `signature` ↔ `form_version` composite FK on `(id, content_hash)` (D-011). This is the exact pattern to reuse for source-document checksums | `0005:77`, `0005:108-111`; asserted twice in pgTAP |
| A deterministic guard that explains its own refusal | `app.assert_schedulable` returns structured JSON `{schedulable, blockers:[{reason,...}]}` — the shape the brief's "why is this form required" explanation artifact needs | [`0011_scheduling.sql:267-332`](../../supabase/migrations/0011_scheduling.sql) |
| A working applicability predicate | `credential_type.required_for_roles[]` × `blocks_scheduling` — a one-dimensional prototype of the requirement graph | `0011_scheduling.sql:293-305` |

Two more worth naming. `form_version.kind` **already** accepts `'import'` and `'ai_draft'` ([`0005:71-72`](../../supabase/migrations/0005_forms_engine.sql)) though no RPC emits them — the provenance vocabulary for machine-originated content was designed in and left unwired. And docs/14 already specifies the customer-form ingestion pipeline end to end (hash-verified fetch → classify → extract → entity resolution with no auto-merge → load as `kind='import'` → completeness scorecard), with an agreed acceptance bar of *random 5% human audit per batch, ≥99% field accuracy on critical fields*. The brief's §7 is largely a re-derivation of docs/14 §2–4.

**Consequence:** the corpus-placement question — which I expected to be the hardest problem here — is not open. It is "apply the `public.permission` pattern." That is a ratified, tested, in-repo precedent, and it is a far stronger position to defend than an invented one.

---

## 2. The five load-bearing gaps

These are the reasons the layer cannot simply be built on top of what exists.

### 2.1 Historical rendering is impossible today — at three layers

This is the brief's binding requirement and CareOS fails it three separate ways:

1. **Definitions are mutable.** `form_template` carries **no** `forbid_mutation` trigger. The trigger is attached to `form_version`, `signature`, `audit_event`, `audit_anchor`, `credential_event`, `care_plan`, `care_plan_item`, `schedule_exception` — and not to the one table whose mutation silently rewrites how every historical record renders. `matrix.yaml` records it without `append_only: true`, and `003_append_only.sql` inserts a `form_template` as a fixture but asserts immutability only on `form_version`/`signature`/`audit_event`. The gap is untested as well as unenforced.
2. **Records cannot prove their definition.** `form_version` carries no `template_version_id` and no `template_schema_hash`. The definition is resolved live at request time from `form_instance.template_id` ([`office/forms/[id]/page.tsx:17,50`](../../apps/web/src/app/office/forms/%5Bid%5D/page.tsx)). Version pinning is structural but not *provable* from the record.
3. **The UI cannot render a prior version at all.** The page fetches every version's `content`, then drops it in the props mapping — only `versions[0]` reaches the runtime, and no route accepts a version id. The history rail is a non-interactive `<ol>` showing kind/author/time/hash. There is no code path that renders a non-latest `form_version`'s answers.

And the rule side is worse than the form side: `cadence_obligation_status` recomputes `effective_due_on` and `computed_status` at read time from the **live** `cadence_rule` row ([`0009:139-146`](../../supabase/migrations/0009_cadence.sql)). Editing a rule retroactively re-renders the compliance status of every past obligation. `cadence_rule` has no version, no `effective_from`/`effective_to`, no append-only trigger, and `unique(tenant_id, key)` — so parallel active versions are impossible *by constraint*, and a rule change is an in-place UPDATE. The brief's "pin the rule set too" requirement is not merely unimplemented; the current schema forbids it.

Two smaller items compound this. A field removed from a template hides answers that persist in the append-only record (the render loop and the conflict diff both iterate `props.fields`, so content keys absent from the current template are invisible — [`form-runtime.tsx:343,236-241`](../../apps/web/src/components/form-runtime.tsx)). And `select` options are bare strings used as both value and label, so the stored datum is the English display string — re-labelling an option in a new template version changes what historical answers *appear* to say.

### 2.2 The authority concept has already forked, and the weaker fork is on screen

At n=2 tables there are already two different columns carrying two different kinds of value:

- `credential_type.source_ref` — real citations (`COMAR 10.07.05.10/.11`)
- `cadence_rule.comar_source_ref` — internal document pointers, seeded with the literal placeholder `Doc 02 §3 — enrich with COMAR cite` ([`seeds/cadence.sql:29-41`](../../supabase/seeds/cadence.sql))

The column name embeds a single jurisdiction (`comar_`). Neither carries issuing authority, retrieval date, checksum, effective dating, verification status, or reviewer. No pgTAP test asserts anything about either. And [`office/compliance/page.tsx:174-181`](../../apps/web/src/app/office/compliance/page.tsx) renders `comar_source_ref` verbatim under a shield icon in a column headed **Regulation**, with closing copy telling the reader every row traces to its regulation for a surveyor.

Compounding it: **docs/02 — the Maryland Compliance & Regulatory Matrix, the sole cited authority for every COMAR reference in this codebase and in `careos-compliance-context`— is not in the repository.** docs/ contains 00 and 06–15 only. The traceability chain terminates outside the codebase. You cannot build a provenance layer whose root document is missing.

### 2.3 The AI layer is unbuilt — and so is every control that would police it

Zero AI code exists: no `ai` schema, no `ai.*` tables, no `packages/` directory (though `pnpm-workspace.yaml` declares the glob), no model-calling code. `form_version.ai_interaction_id` is a bare uuid with no FK and no CHECK, awaiting a table that does not exist. pgvector is not installed — `0001` creates only `pgcrypto`; `vector`, `postgis`, `pg_cron` and `pgmq` are all specified in docs/07 §2 and absent.

More importantly, the enforcement controls the brief's AI strategy depends on are vapor:

- **"No raw model fetches — lint-enforced"** (docs/11 §1): there is no ESLint config anywhere and no `lint` script in any package.json.
- **The planted-PHI canary suite** (docs/12 §6): `tests/canary/` does not exist. CLAUDE.md forbids editing it; there is nothing to edit.
- **AI eval gates as release gates** (docs/11 §9): CI has exactly two jobs — pgTAP and the drift gate. No eval stage, no canary stage, no red-team stage.
- **`app.approve_ai_action`** — the RPC the entire T1/T2 HITL state machine depends on — is named in docs/08 and docs/11 and exists in neither the migrations nor the granted RPC catalog.

There is also a **spec-internal defect worth fixing before anyone builds it**: docs/11 §1 orders the client pipeline as "PHI-minimizer applied → registry resolve → budget check." That is impossible, because §6 defines the minimizer *as* the capability's registry-resolved input schema. Registry resolution must precede minimization, and §1 omits the capability-flag check that §2 says happens on every call.

And docs/07 §10 tags `ai_interaction` **[AO]** while docs/11 §3 gives it a mutable status column. Append-only and a mutating state machine cannot coexist under `forbid_mutation()`. The repo has already solved this shape twice (`form_instance` mutable-with-no-write-grants + `form_version` [AO]; `obligation` + the `security_invoker` status view) — the resolution is an interaction row plus an append-only disposition chain, not a status column.

### 2.4 The governance machinery is currently red

- **The ST-103 drift gate fails today.** `bash scripts/spec-drift-gate.sh HEAD` exits 1 with ~13 failures: 11 tables from migrations 0008–0011 missing from `matrix.yaml`, one migration commit with no story/decision citation, and a false `D-000` citation (a regex artifact — `0008` invented a local `D-0008a/b/c` namespace that collides with the reserved `D-nnn` space and gets truncated by the gate's `D-[0-9]{3}` pattern).
- **`matrix.yaml` covers 14 of 25 tables**, and the enforcement script its own header promises — `scripts/check-matrix.sh` — does not exist and is not in CI. `matrix.yaml` is read by no pgTAP file and no generator; its only mechanical consumer is the drift gate's Rule 3, which greps for a leading `<table>:` and never parses the value.
- **`002_rls_matrix.sql` contains 9 assertions and every one queries `public.client`.** No other table is asserted despite the manifest listing 14. Total suite: 175 assertions against docs/12 §3's stated ~700 target.
- **No outbox table exists.** There is no `domain_event` table in any migration, so the second half of invariant #7 — "audit event *and* outbox event in the same transaction" — is unsatisfiable product-wide.
- **Retention and legal hold do not exist in code.** No `document` table, no `retention_until`, no `legal_hold`, no `app.retention_sweep()`. `grep -i -e retention -e legal_hold supabase/migrations/` returns zero.
- **`db/policies.md`**, specified as a generated artifact whose drift fails the build, does not exist; nor does its generator.
- **No application surface reads the audit ledger.** `audit.audit_event` has RLS forced with no policies and no grants, and no definer read-RPC exists. "Show me who did what" is answerable only as `postgres` in psql.

### 2.5 The audit ledger cannot record a platform action

`audit.audit_event.tenant_id` is `NOT NULL` with an FK to `public.tenant(id)`; `audit_anchor`'s PK is `(tenant_id, day)` per D-011; `app.emit_audit` raises `CAREOS_NO_TENANT_CONTEXT` without a tenant session; `app.emit_audit_system` is `service_role`-only and requires an explicit tenant argument.

**A corpus curation action — "reviewer R verified form F from source S on date D" — has no legal audit path today.** This is the single hardest structural blocker to the shared-corpus design, and it is not solvable by adding a column. Recommendation in §4.3.

---

## 3. Where I disagree with the brief

**3.1 The national scope is not the wedge, and the arithmetic does not close.**
docs/06 §10 positions CareOS's advantage explicitly *against* incumbents' "generic multi-state feature sprawl," describing it as "purpose-built to this agency's operating model — then productizable." Every document is headed *Client: American Care Team (Maryland)*. No second customer is named anywhere in the corpus. Reviewer capacity on record is **RN clinical SME at 0.2 FTE and compliance/HIPAA advisor at 0.1 FTE**, with founder time at 2 h/week (docs/15 §1, §7).

The brief's own Definition of Done for a supported state requires, per state per provider type: mapped statutes, collected licensing forms, Medicaid manuals, waiver programs, EVV architecture, incident rules, assessment/service-plan requirements, workforce requirements, retention rules, implemented forms, completed compliance review, verified sources and effective dates. That is not a 0.1-FTE task at any credible per-cell estimate. A 50-state × 6-provider-type matrix is 300 cells. Even at an implausibly optimistic 20 reviewed-hours per cell, that is 6,000 hours of *licensed* review — roughly three full-time regulatory analysts for a year, before any maintenance. Maintenance is the larger number, because §16's change-monitoring obligation never ends.

This is not an argument against the architecture. It is an argument that the corpus is a **staffed content operation wearing an engineering costume**, and the decision to fund it belongs to the founder, not to engineering. docs/15 §8 already names "scope gravity (boil the ocean pulls Phase-2 items forward)" as a top delivery risk, with the ratified mitigation "new wants → decision log + trade, not silent absorption." I am applying that mitigation here.

**3.2 Generalizing EVV now is premature.** The brief wants a state-EVV adapter model. Maryland's own modality is still open: D-Q16 is unresolved and V10 ("ISAS/LTSSMaryland onboarding contact made; integration modality answered") is the longest-lead external dependency in the whole plan. Generalizing an adapter interface before building one concrete instance produces an abstraction shaped by guesses. Build Maryland ISAS concretely; extract the interface when a second state exists.

**3.3 The canonical-ontology decision is not primarily technical.** Anchoring to LOINC/SNOMED/RxNorm/CPT carries licensing obligations that vary by code system and by use, and redistributing state and payer documents to customers has copyright and terms-of-use dimensions the brief itself flags but does not resolve. docs/09 §6's vendor register has **no row for outbound content retrieval from third-party websites** — the only outbound integrations listed are ISAS, Twilio, Checkr, QuickBooks, Deepgram, DocuSign, email and the AI providers. Any crawling adds a data flow not in the register, which CLAUDE.md requires be proposed before adoption. This is a counsel question gating an engineering choice, not the reverse.

---

## 4. What I would build

### The gate

Split the work at an explicit, ratifiable boundary:

> **Phase A and B serve the Maryland customer and must ship regardless. Phase C (the shared national corpus) does not begin until (i) a second paying tenant exists or is contracted, and (ii) a named, funded compliance-review capacity exists. Until both are true, Phase C exists only as a seam.**

This is the "earn the right" structure. It also means Phase A/B are not speculative investment — every item below is a promise CareOS has already made.

### 4.1 Phase A — make the existing evidence chain constraint-true

Nothing here is new scope. Each item closes a gap between what the product asserts and what it enforces.

**A1 — Definitions become immutable and provable.** Add `forbid_mutation` to `form_template`; add `template_version_id` and `template_schema_hash` to `form_version`, populated server-side in the three RPC insert sites. Bind them with the D-011 pattern — a composite FK `(template_version_id, template_schema_hash) → form_template(id, schema_hash)` — so "this record was authored under that definition" is constraint-true, exactly as the signature binding is. Add `append_only: true` to the `matrix.yaml` entry and an assertion to `003_append_only.sql`.

*Migration 0012 (expand). No client impact — `form_template` already has zero write grants and no RPC or migration has ever written it; all three seeded templates are version 1, so template versioning has never been exercised.* Confirm with ops that no process depends on in-place template edits before landing.

**A2 — Historical rendering becomes real.** A route accepting a version id; the page stops dropping `content` in the props mapping; the runtime renders a read-only prior version *under its own pinned definition*. Also fix the two conflict bugs found in the same component, which are live invariant violations today:

- "Continue from theirs" discards the user's unsaved delta while the card asserts *"Both versions are kept either way — nothing is lost,"* and sets `savedAt` so the UI shows a save that never happened. Autosave is disabled while a conflict is open, so the discarded delta can be arbitrarily large. This violates invariant #11 and invariant #14 simultaneously.
- "Keep my changes on top" needs two clicks: `resolveKeepMine` calls `setBase(...)` then `void save()` in the same tick, and `save` is a `useCallback` closed over the previous `base.id`, so the RPC re-sends the stale base and the server conflicts again.

**A3 — Authority becomes a record, not a string.** Replace free-text `source_ref`/`comar_source_ref` with a structured, append-only authority table. This is the brief's source-hierarchy concept, sized for one jurisdiction:

```sql
-- Migration 0013 (expand) · @trace: ST-1NN, D-0NN
create table public.legal_authority (                       -- [AO] CFG
  id              uuid primary key default gen_random_uuid(),
  authority_level int  not null check (authority_level between 1 and 12),
  jurisdiction    text not null,          -- 'US' | 'US-MD' | …
  issuing_body    text not null,          -- 'Maryland Department of Health'
  citation        text not null,          -- 'COMAR 10.07.05.12B'
  title           text not null,
  source_url      text,
  source_sha256   bytea,                  -- checksum of the retrieved document
  retrieved_at    timestamptz,
  effective_from  date not null,
  effective_to    date,                   -- null = currently in force
  review_status   text not null default 'discovered' check (review_status in
                    ('discovered','parsed','mapped','under_review','verified',
                     'published','superseded','retired','unverified')),
  verified_by     uuid references public.app_user(id),
  verified_at     timestamptz,
  superseded_by   uuid references public.legal_authority(id),
  -- The brief's Risk 2, enforced rather than documented:
  constraint authority_published_requires_human check (
    review_status <> 'published'
    or (verified_by is not null and verified_at is not null and source_sha256 is not null)
  )
);
create trigger trg_legal_authority_ao before update or delete
  on public.legal_authority for each row execute function app.forbid_mutation();
```

Then `cadence_rule.legal_authority_id` and `credential_type.legal_authority_id` as nullable FKs (expand), backfilled once a human supplies verified citations, and the compliance UI renders authority level + citation + verification state instead of a raw string. **The placeholder strings must leave the demo surface before any pilot** — either backfilled with verified citations or rendered explicitly as *unverified*.

Note the check constraint is the structural answer to "no form is marked required because an AI found it online." `verified_by` is an FK to a human `app_user`; an AI capability has no row there. This is enforced in the database, not in a prompt — which is the only enforcement CLAUDE.md accepts.

**A4 — Close the governance gates.** Write `scripts/check-matrix.sh` and wire it into CI. Backfill the 11 missing `matrix.yaml` entries. Fix the `D-0008a` namespace collision (rename to a non-colliding marker). Add `lint`/`test` scripts so CLAUDE.md's verification ritual is runnable at the root. Extend `002_rls_matrix.sql` past `public.client`. **Do this first** — landing new tables while the coverage gate is red is precisely the failure mode the gate exists to prevent.

### 4.2 Phase B — jurisdiction-ready, single-jurisdiction

Add the brief's dimensions to the *existing* engine without building a corpus.

**B1 — Rules become versioned and effective-dated.** `cadence_rule` gains `version`, `effective_from`, `effective_to`, `superseded_by`, an append-only trigger, and `unique(tenant_id, key, version)` replacing `unique(tenant_id, key)`. `obligation` gains `cadence_rule_version_id`, snapshotting the rule that applied. `cadence_obligation_status` joins the *snapshotted* rule, not the live one. This is expand → migrate → contract over existing rows and needs a decision-log entry per invariant #12.

Also widen `obligation.due_on` (`date`) to `due_at timestamptz`. docs/07 §7 specified `timestamptz`; the migration narrowed it without a decision entry. Sub-day deadlines — the brief's 48-hour high-acuity assessment and 1-hour on-call response, both claimed in `careos-compliance-context` — are inexpressible today. **This gets strictly harder after a multi-jurisdiction corpus loads**, so it must happen in Phase B or not at all.

**B2 — The applicability seam.** The requirement graph attaches at one identifiable place: `app.evaluate_compliance()` phase B hardcodes its entire applicability predicate as

```sql
client.status='active' AND client.admitted_on is not null
  AND r.applies_to='client' AND r.trigger_kind='interval_days'
```

([`0009:205-219`](../../supabase/migrations/0009_cadence.sql)). Replace that literal with a predicate resolved from a `requirement_applicability` table keyed on `(provider_type, jurisdiction, program, payer, trigger_event, effective_range)`. For Maryland-only, that table has one provider-type row and the behaviour is unchanged — which is the point: **the seam is proved by refactoring, not by speculation.**

The predicate representation should be relational rows, not a JSONB DSL. Reasons: pgTAP can assert a truth table directly; a compliance reviewer can read and eventually author rows; the planner can index it; and an explanation is a join result rather than an interpreter trace. `app.assert_schedulable`'s structured-blockers JSON is the established in-repo shape for the returned explanation.

While there: `trigger_kind` accepts four values but the evaluator implements only `interval_days`. `on_admission`, `on_event` and `credential_expiry` are dead enum values, so `assessment.initial` and credential-expiry obligations are **never materialized**. And `app.evaluate_compliance()` takes no clock argument and reads `current_date` directly in four places, so it cannot be time-travelled — while `app.cadence_status` is `IMMUTABLE` with the clock as a parameter and is the correct in-repo pattern. Temporal correctness cannot be tested until the evaluator accepts `p_today`.

**B3 — Tenant provider profile.** `tenant` gains a versioned profile (provider type, licensure category, jurisdiction, participating programs) with effective dating, so historical records resolve against the profile that applied then. There is no `provider_type`, `care_setting`, `jurisdiction`, `program` or `authorization` column anywhere in the schema today; `client.payer_type` is the only payer-like dimension.

**B4 — Form runtime, honestly scoped.** The runtime renders a proprietary flat dialect — `schema.fields[]` of `{key,label,type,options?,help?}` with six types — not JSON Schema, despite docs/07 §5 describing it as such. There is no validation, no required-marking, no conditional logic at *any* layer (not in the type, not client-side, and `finalize_form` checks only signer-role coverage). `form_template.ui` is defined and read by nothing.

For Phase B the additive subset is: `required`, `validation`, `visible_when`, and `options` as `{code,label}` pairs rather than bare strings. That last one is a **data-correctness fix, not a feature** — today the stored answer is the English display label, which makes answers untranslatable, un-mappable to any code system, and silently mutable by re-labelling. It is also the prerequisite for the brief's "answer once, populate N forms."

Repeatability, units, external code bindings, per-field confidence and source coordinates are Phase C. Note there is no Storage usage and no image rendering anywhere in the app except the MFA QR — there is **no foundation for side-by-side source-document review**, so extraction-review UI is a from-scratch build, not an extension.

Also fix, in the same pass: `number` fields persist `e.target.value` as a **string** into `content` and therefore into `content_hash` — the string/number confusion is baked into signed records; and `app.correct_form` appends a version without updating `form_instance.status` or `current_version_id`, so a corrected-final record renders correction content under a "final" banner with every required signer showing "waiting."

### 4.3 Phase C — the shared corpus, behind the gate

**Placement: the `public.permission` pattern, in a dedicated `reg` schema.** Global tables, no `tenant_id`, RLS `enable`+`force`, permissive read policy, `select` grants, zero write grants, all mutation via definer RPCs. Non-AAL2 for the published corpus (it is public reference data, not PHI); AAL2 and tenant scoping for the *upload staging* table, which may contain PHI in filled sample forms. **These are two different tables with two different trust boundaries and must not be conflated.**

Three cautions, all evidenced:

1. `001_schema_invariants.sql` iterates `public` and `audit` only. **A `reg` schema gets zero invariant coverage** unless the suite is extended in the same migration. Given that `0007` exists precisely because a `0001` default-privilege assumption "turned out not to bind" and was caught only by pgTAP, no new access path here should be reasoned as obviously safe.
2. `matrix.yaml` has no globality vocabulary — `public.permission`'s entry `{ authenticated: select, writes: none }` is grammatically indistinguishable from an untested tenant table. Add an explicit `scope: global` key so deliberate globality is distinguishable from a forgotten `tenant_id`. Note also that `001` asserts RLS enabled+forced on every table but **never asserts `tenant_id` presence**, so a tenantless table passes the invariant suite unmodified — the suite cannot currently catch an accidental global table.
3. **The audit blocker (§2.5) must be solved first.** My recommendation: a reserved platform `tenant` row that owns corpus curation actions, invisible to normal tenants via the existing `tenant_select_own` policy, so `emit_audit` works unchanged and corpus provenance lands in the same hash-chained ledger. The alternative — a second, non-tenant-keyed ledger — forks the evidence chain and I would not do it. Either way this needs a decision-log entry, because `audit.compute_chain`'s per-tenant advisory lock means all corpus ingestion then serializes on one lock; that ceiling must be accepted knowingly.

**Overlay resolution** is three-layer: global official → jurisdiction variant → tenant overlay. A tenant may add fields and branding; a tenant may **not** remove or weaken a field whose requirement row is authority-level ≤ 5. Enforce in the adoption RPC, and assert it in pgTAP — the forms tables have no client write grants, so adoption is only possible through Lane B, which is where the check belongs.

**AI's role, bounded structurally.** Every AI output in this layer lands as a *proposal* row that cannot reach `published` — the check constraint in A3 requires a human `verified_by`. Uploaded documents are untrusted input: docs/09's threat model already names document-borne prompt injection and mandates "no raw-doc-to-action path," but its blast-radius assumption (one document affects one client's draft) **does not hold when a document produces a shared template or rule.** That widening is the single most important new threat this layer introduces and needs its own red-team assertion in CI.

Two specific hazards to design against: docs/11 §6 explicitly exempts user-submitted free text from minimization ("minimization governs what *we* attach, not what the user says"), which under a customer-upload flow means an entire untrusted PDF enters the prompt un-minimized *by spec* — that exemption must be narrowed before any upload path ships. And docs/11 §8's content-hash-keyed embedding cache becomes a **cross-tenant membership oracle** once customer uploads are cached (a hit reveals another tenant ingested the identical document); partition the cache by tenant for the upload lane.

**Staleness must fail safe.** Detection will miss changes; that is not a solvable problem, only a mitigable one. The structural mitigation is a mandatory re-verification TTL per authority row, so an unverified-since-D record *surfaces as stale whether or not detection fired.* Silence must never read as currency.

---

## 5. Proposed decision-log entries

For docs/00 §3, in that file's format. These are proposals; ratification is the founder's.

| ID | Date (2026) | Decision | Rationale / conditions |
|---|---|---|---|
| **D-013** | Aug 2 | **Form definitions become append-only and record-bound.** `form_template` gains `forbid_mutation`; `form_version` gains `template_version_id` + `template_schema_hash` bound by composite FK. | Closes the historical-rendering hole at the constraint layer using the D-011 e-sign pattern. Zero client impact (no write grants, no RPC writes the table today). Conditions: confirm no ops process edits templates in place; add `append_only: true` to matrix.yaml and an assertion to `003_append_only.sql`. |
| **D-014** | Aug 2 | **Legal authority becomes a structured append-only record** (`public.legal_authority`), replacing free-text `source_ref`/`comar_source_ref`. Publication requires a named human verifier and a source checksum, enforced by CHECK. | Two forked authority columns already exist and one renders a placeholder to users under a "Regulation" heading. Makes the brief's Risk 2 structurally impossible. Conditions: placeholder strings removed from demo surfaces before pilot; docs/02 located or reconstructed first. |
| **D-015** | Aug 2 | **Compliance rules become versioned and effective-dated**; obligations snapshot their rule version; `obligation.due_on` widens to `due_at timestamptz`. | Editing a rule today retroactively rewrites historical compliance status. The `date` narrowing from docs/07 §7 was never logged and makes sub-day COMAR deadlines inexpressible. Expand→migrate→contract; hardest to do later. |
| **D-016** | Aug 2 | **Applicability is a relational predicate table**, resolved at the `evaluate_compliance` phase-B seam. Not a DSL, not an LLM. | Reaffirms invariant #13. Relational rows are pgTAP-assertable, reviewer-readable, indexable, and yield explanations as join results. Maryland-only initially: behaviour-preserving refactor. |
| **D-017** | Aug 2 | **Global catalog tables are a ratified class**, governed by the `public.permission` pattern (no `tenant_id`, RLS enable+force, permissive read policy, zero write grants), extended to a `reg` schema. `matrix.yaml` gains a `scope: global` key. | Resolves docs/07 §1's "every domain table has tenant_id" convention against an existing compliant deviation. Conditions: `001_schema_invariants` extended to cover `reg`; platform-tenant audit path (D-018) landed first. |
| **D-018** | Aug 2 | **Platform-level actions audit under a reserved platform tenant row.** | `audit_event.tenant_id` is NOT NULL and `audit_anchor` PK is `(tenant_id, day)`; corpus curation has no audit path otherwise. Accepts the known ceiling that `compute_chain`'s per-tenant advisory lock serializes corpus ingestion. |
| **D-019** | Aug 2 | **National corpus gated on two conditions**: a second contracted tenant, and named funded compliance-review capacity. Until both hold, Phase C exists only as a seam. | docs/06 §10 positions CareOS against multi-state sprawl; reviewer capacity is 0.2 + 0.1 FTE. Applies docs/15 §8's ratified mitigation for scope gravity. |
| **D-020** | Aug 2 | **`ai_interaction` is an append-only interaction row plus an append-only disposition chain**, not a mutable status column; docs/11 §1's pipeline order is corrected to registry-resolve → minimize. | Resolves the docs/07 §10 [AO] vs docs/11 §3 state-machine contradiction using the existing `form_instance`/`form_version` and `obligation`/status-view patterns. |

**New verification items for docs/00 §4:**

| # | Item | Owner | Verify by |
|---|---|---|---|
| V13 | **docs/02 located or reconstructed.** Every COMAR citation in code traces to it; it is not in the repo. | Founder + compliance advisor | Before any authority backfill |
| V14 | Copyright / terms-of-use posture for ingesting and **redistributing** government, state and payer documents; licensed assessment instruments identified separately | Counsel | Before any ingestion runs |
| V15 | Liability posture and disclaimer surface for telling a customer a form is **"required"**; E&O position | Counsel | Before any `required` row reaches production |
| V16 | Outbound web retrieval added to the docs/09 §6 vendor/data-flow register (no row exists today); OCR vendor BAA if one is needed | Salim | Before Phase C |
| V17 | Model-training restrictions on customer-uploaded forms confirmed in writing | Salim | Before customer upload ships |
| V18 | Named, funded compliance-review capacity for corpus verification | Founder | Gates D-019 |

---

## 6. Risk register (beyond the brief's ten)

| Risk | Mechanism | Blast radius | Structural mitigation | Detection signal |
|---|---|---|---|---|
| **Compliance theatre at n=1** | Placeholder `source_ref` rendered under "Regulation" with surveyor-traceability copy | A surveyor asks "show me" and the answer is an internal doc pointer to a missing document | D-014 CHECK constraint + remove placeholders from demo | pgTAP assertion that no rendered authority is a placeholder |
| **Silent history rewrite** | `form_template` mutable; `cadence_obligation_status` recomputes from live rules | Every historical record and every past obligation | D-013 + D-015 | pgTAP: mutate a template, assert prior record still renders identically |
| **AI-authored authority via a side door** | Change-monitoring auto-update, cached explanation, or re-verification job writes `published` | A wrong form becomes "required" across all tenants | `verified_by` FK to `app_user` — no AI has a row | CI assertion that no non-human path can set `published` |
| **Corpus injection widening** | Uploaded PDF influences a *shared* template or rule, not one client's draft | Cross-tenant | Two-lane ingestion; no raw-doc-to-publish path; red-team suite | Red-team CI stage (does not exist yet) |
| **Cross-tenant oracle via embedding cache** | Content-hash-keyed cache shared across tenants | Membership disclosure | Partition cache by tenant on the upload lane | Canary suite (does not exist yet) |
| **Review-capacity collapse** | 300-cell matrix against 0.1 FTE | The corpus goes stale and nobody knows | D-019 gate + mandatory re-verification TTL | Stale-authority count on the ops dashboard |
| **Governance gate rot** | Drift gate already red; matrix 14/25; `check-matrix.sh` absent | New tables land with zero RLS coverage | A4 before any new table | Gate exits 0 |
| **Guard outside the perimeter** | A deterministic guard exists but the write path is Lane A direct-grant, so it never runs (live today: `assert_schedulable` vs `visit`/`shift` grants) | The rule is decorative; the product asserts an enforcement it does not perform | Requirement-graph writes are Lane B only, zero client write grants, guard in-transaction | pgTAP asserts the direct-grant path is closed |
| **Wedge dilution** | National scope delays the paying customer | The engagement | D-019 | S-retro velocity checkpoint |

---

## 7. What I would not do

- **Not build a 50-state corpus, or a 3-state corpus, now.** Gated on D-019.
- **Not generalize the EVV adapter** before Maryland ISAS exists concretely (D-Q16/V10 still open).
- **Not adopt SNOMED/LOINC/CPT** before V14. A thin internal concept table with *optional* external code bindings keeps the door open at near-zero cost; committing to a licensed vocabulary does not.
- **Not build the OASIS item model.** It serves Medicare-certified home health; the customer is an RSA. The brief's own recommended scope includes it, but the brief was not written against a single-agency engagement.
- **Not rewrite the form runtime.** Extend the flat dialect with `required`/`validation`/`visible_when`/coded options. A JSON Schema migration is a Phase-C decision.
- **Not treat any regulatory claim in the brief as fact.** "OASIS-E2 effective April 1 2026," the Cures Act six-element list, the 12-level authority hierarchy, ~6-year retention, and the 45/90/120-day supervisory split with its medication-involvement trigger are all **claims from the brief**. Each becomes a `legal_authority` row with a named verifier and a hashed source document — never a constant in code or a value in a seed file. Note the 45/90/120 split is currently *unimplementable* regardless: it requires `employee.medication_involvement`, and neither the column nor an `employee` table exists (D-0008a substituted `app_user`).

---

## 8. First three stories

**ST-110 — Close the governance gates** *(Phase A4, prerequisite for everything)*
Files: `scripts/check-matrix.sh` (new), `supabase/tests/database/matrix.yaml`, `.github/workflows/ci.yml`, `supabase/migrations/0008_credentials.sql` + `0011_scheduling.sql` (rename `D-0008a/b/c` markers), root + `apps/web` `package.json`.
AC: `bash scripts/spec-drift-gate.sh HEAD` exits 0 · `check-matrix.sh` fails on a table absent from the manifest and runs in CI · all 25 tables present in `matrix.yaml` with a `scope` key · `pnpm typecheck && pnpm lint && pnpm test` runnable at root.

**ST-111 — Definitions become immutable and record-bound** *(Phase A1)*
Files: `supabase/migrations/0012_form_definition_binding.sql`, `0006_form_rpcs.sql` (three insert sites), `supabase/tests/database/003_append_only.sql`, `001_schema_invariants.sql`, `matrix.yaml`.
AC: `update public.form_template` raises `CAREOS_APPEND_ONLY` · `form_version.template_version_id`/`template_schema_hash` populated server-side and bound by composite FK · pgTAP asserts a 23503 violation on a mismatched pair (mirroring the signature test at `003_append_only.sql:60-67`) · existing 175 assertions stay green.

**ST-112 — Legal authority becomes a record** *(Phase A3)*
Files: `supabase/migrations/0013_legal_authority.sql`, `supabase/seeds/cadence.sql`, `supabase/seeds/credentials.sql`, `apps/web/src/app/office/compliance/page.tsx`, new pgTAP suite.
AC: `legal_authority` append-only with the publication CHECK · `cadence_rule`/`credential_type` carry nullable FKs · pgTAP asserts `review_status='published'` is impossible without `verified_by` + `verified_at` + `source_sha256` · compliance UI renders authority level + citation + verification state, and **renders unverified rows explicitly as unverified** rather than as a bare string under "Regulation."

---

## 9. Escalations — engineering must not decide these

| Question | Who | Blocks |
|---|---|---|
| Is the national corpus funded, and with what review capacity? | Founder | D-019, all of Phase C |
| Where is docs/02, and who attests the COMAR citations? | Founder + compliance advisor | V13, all authority backfill, ST-112 seeds |
| Copyright/redistribution posture on government, state and payer documents; licensed instruments | Counsel | V14, any ingestion |
| Liability posture for asserting a form is "required" | Counsel | V15, any `required` row in production |
| Who is the authorized verifier — RN SME, counsel, or both by authority level? | Founder + compliance advisor | The `verified_by` role model; there is **no permission key** for publishing a regulatory claim and no role corresponding to compliance counsel in the seeded catalog today |
| Is a cross-tenant shared corpus acceptable under the current BAA/security posture? | Founder + counsel | D-017 |
| Does the naming divergence resolve by renaming `cadence_rule`→`compliance_rule` or by amending docs/07 §7? | Founder | Flagged in `0009`'s own header, unresolved since; decide before a larger table set inherits it |

---

## Appendix — corrections to the spec corpus found during this analysis

Independent of the brief, and worth landing regardless:

- docs/00 §4 contradicts D-009 **in the same file**: V8 still reads "Before S5" and V5/V6 "Before S6," while D-009 records those exact deltas as V8→S6 and V5/V6→S7.
- docs/15 §3's sprint table still says Sprint 6 for doc-intelligence; D-009 moved it to Sprint 7, and docs/00 §35's precedence rule makes the decision log authoritative.
- docs/07 §5 describes `form_template.schema` as JSON Schema; the runtime implements a proprietary flat dialect.
- docs/07 §7 names `compliance_rule`/`compliance_obligation`/`source_ref`/`due_at`; migration 0009 landed `cadence_rule`/`obligation`/`comar_source_ref`/`due_on`. Flagged in the migration header, never resolved.
- docs/07 §12 claims migrations seed `compliance_rule` rows; migration 0009 seeds none into production — rules exist only in local/preview seeds, with placeholder citations. Contrast 0008, which seeds the permission catalog into the migration itself.
- `plan/backlog.yaml` (cited by docs/15 §4 and D-009) does not exist. `db/policies.md` and its generator do not exist.
- Story-ID hygiene: five commits on `st-013-apple-2026-rebrand` use ST-013, which docs/15 §4 defines as "Office shell + universal search," for the D-012 rebrand, exec command center, credentials/compliance surfaces and a demo-persona MFA change.
- **`app.assert_schedulable` is a deterministic guard that nothing enforces.** It is defined, granted and pgTAP-tested, but has no production caller — and `public.shift` and `public.visit` carry **direct `grant select, insert, update ... to authenticated`** (`0011:137,193`), gated by RLS scheduler-permission policies only. So the write path is Lane A, not Lane B, and the credential-lapse check is bypassable by construction: a holder of the scheduler permission can insert a visit through PostgREST without the guard ever running. The schedule UI is honest about being preview-only, but the grant is the perimeter and the guard is outside it.

  **This is the single most transferable lesson in the repo for the applicability engine.** A deterministic rules engine is worth nothing if the mutation path does not go through it. Every requirement-graph write path must be Lane B with the guard in-transaction — mirroring the forms engine, where `form_instance`/`form_version`/`signature` have zero client write grants precisely so the RPCs cannot be bypassed (D-011). Verify this property in pgTAP, not by inspection.
