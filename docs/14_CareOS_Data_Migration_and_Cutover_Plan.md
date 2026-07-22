# CareOS — Data Migration & Cutover Plan

**Client:** American Care Team (Maryland) · **Document:** 14 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 01 G1 (100% consolidation) · Doc 02 §7 (forms inventory) · reuses the Doc 11 §4 extraction pipeline · feeds Doc 15 Sprint plan.

> **Purpose.** A decade of operating truth lives in sprawling Google Drive folders, personal drives, and paper. Getting it into CareOS *safely* — with provenance, without losing anything, without poisoning the new system with duplicates — is a first-class engineering project, not an afterthought. It is also, run correctly, **the agency's first real compliance audit**: the migration scorecard tells the founder exactly where her records stand against COMAR before a surveyor ever asks.

---

## 1. Principles

1. **Nothing is deleted; everything is provenance-tagged.** Legacy files land as `document` rows (`source='migration'`, original path + timestamps preserved) and, where structured, as versioned records (`form_version.kind='import'`). The originals archive read-only.
2. **AI classifies, humans adjudicate.** The same extraction pipeline that powers intake (Doc 11 §4) does the heavy lifting; every merge/identity decision above a confidence bar is one-click-reviewed, below it human-decided. **No auto-merge, ever.**
3. **Migrate by cohort, not big-bang.** Pilot cohort proves the machine; the rest follows in waves; the old world stays readable until sign-off.
4. **The scorecard is a deliverable.** Per-client and per-employee COMAR completeness (which required documents exist, are current, are signed) — gaps become remediation tasks in CareOS itself.

## 2. Scope & source inventory (Sprint 3 start)

Sources: agency shared Drive(s), founder's drive, any staff personal folders in operational use (**discovery item — a real risk to surface gently but firmly**), email attachments of record, paper (scan service if volume warrants). Inventory tooling: scoped read-only Drive OAuth crawl → manifest (path, owner, modified, mime, hash) → dedupe by hash → volume/type report. Expected classes map to the Doc 02 §7 forms inventory: client charts (assessments, plans of care, visit notes, MARs, consents), personnel files (licenses, TB, CPR, background checks, I-9-adjacent), policies/procedures (→ Agency Brain corpus), admin/financial (retention-only, mostly out of structured scope).

## 3. Pipeline (reusing production machinery)

```
Drive crawl → manifest → fetch to intake bucket (hash-verified)
   → classify (doc type + which client/employee it likely belongs to)
   → extract (structured fields where templates exist)
   → ENTITY RESOLUTION: candidate match (name+DOB fuzzy · employee roster)
        ├─ high confidence → one-click confirm queue
        ├─ ambiguous → adjudication queue (side-by-side)
        └─ no match → new-record proposal (reviewed)
   → load: document rows + form_version(kind='import') + credential rows (pending verify)
   → per-record provenance: {original_path, original_modified, migration_batch}
   → SCORECARD: per-client / per-employee completeness vs. COMAR checklist
```

Throughput plan: automated passes run in batches (queue-based, off-peak); human adjudication staffed by the coordinator + HR with a dedicated review UI (same components as intake review — nothing new to learn). Estimated effort at ACT's scale (≈50–70 staff, active + 6-yr retained clients): low-thousands of documents; adjudication is days, not weeks, once the confirm queue does the easy 80%.

## 4. Data-quality gates (before any cohort goes live)

Zero unresolved identity ambiguities in the cohort · every active client has: current assessment, plan of care, consents (or a logged gap task with owner/date) · every active employee has: verified licensure + unexpired mandatory credentials (or a gap task; `assert_schedulable` will enforce from day one — surface this early so go-live doesn't "surprise-block" scheduling) · random 5% human audit of extractions per batch ≥99% field accuracy on critical fields · duplicate-client scan clean.

## 5. Cutover sequence

| Stage | What happens | Exit |
|---|---|---|
| M0 Pilot cohort (Sprint 7) | 5 clients + their care teams fully migrated; staff work them in CareOS while legacy stays read-only reference | Pilot staff sign off; defect list triaged |
| M1 Wave migration (Sprint 8) | Remaining active clients/employees in 2–3 waves; scorecard gaps → remediation tasks | Gates §4 green per wave |
| M2 Parallel-run (2 weeks) | New work happens **in CareOS only**; legacy Drive locked read-only (edit rights removed — the overwrite risk ends here); daily delta sweep catches stragglers | Zero critical deltas 5 consecutive days |
| M3 Authoritative cutover | CareOS declared system of record (dated, signed by founder); legacy archived (retention-preserved, access-logged) | Go-live acceptance (Doc 12 §8) |
| M4 Historical backfill (Phase 2, optional) | Discharged-client records within 6-yr retention migrated document-level | Retention ledger complete |

**Rollback:** any stage before M3 can pause/revert to legacy without data loss (CareOS work is exportable; legacy untouched). Post-M3 rollback is a DR event (Doc 13 §8), not a migration event — by design, because parallel-run has already proven the system.

## 6. Roles (RACI-lite)

OCTSERVICES: pipeline, tooling, batches, quality reports (R/A). Coordinator + HR: adjudication + gap remediation (R). Founder/RN lead: clinical-record judgment calls, waiver decisions, cohort sign-offs (A). All: the migration doubles as hands-on training — adjudication *is* onboarding to the review UI.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Records exist only on paper / personal accounts | Early inventory question set (kickoff), scan workflow, amnesty framing ("bring it in, no blame") |
| Poor scan quality defeats extraction | Textract adjunct path (Doc 06 §3); manual-entry queue with images side-by-side |
| Identity collisions (same-name clients) | DOB/address adjudication rules; no-auto-merge principle |
| Scorecard reveals serious gaps | That's the *point* — gaps found by us are fixable; found by a surveyor they're citations. Framed to the founder exactly that way. |
| Staff keep using Drive out of habit | M2 edit-lock + change-management plan (Doc 04 §7) + founder modeling the behavior |
