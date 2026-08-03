# Form & Content-Requirement Inventory — What Is Actually Required, and What CareOS Has

**Date:** 2026-08-03 · **Status:** Research findings for decision
**Method:** primary-source web research (COMAR, eCFR/govinfo, CMS, Maryland MGA statute, OHCQ) + direct repo measurement
**Coverage:** 4 of 13 planned research lenses completed (3 lost to connection errors, 6 to an account rate limit). The Maryland COMAR lens failed and was performed by hand instead — it is the best-sourced section here. Two completed lenses ran without the safety classifier available; their claims are treated as unverified-until-cited like all others.
**Not a legal opinion.** Every item is marked with its verification status. Nothing here should reach production as a compliance assertion without licensed-human review.

---

## 0.0 Corrections after merge (2026-08-03)

Written against commit `23dab19`; the branch has since advanced ten commits. The regulatory
research below is unaffected — it is sourced externally — but two statements about CareOS are not:

- **"The AI layer is 100% unbuilt"** is false after the merge (migrations 0014–0016 build the
  AI plane, approvals/proposals, extraction and agents; pgvector is installed).
- **EVV is no longer wholly absent:** `public.visit_event` and a web-based clock-in landed
  upstream. The §7 blocker ranking still holds directionally — the open question is not whether
  CareOS can capture a visit but whether **Maryland ISAS accepts third-party EVV at all** (V17),
  which remains unresolved.

The three-templates finding, the 88-vs-17 content-requirement ratio, the COMAR 10.07.05
inventory, the retention conflict and the verified seed defects are all unchanged. The cadence
defects this document identified are **fixed** by migration 0019 (ST-114).

---

## 1. The direct answer

**Q: Did we get all the forms/fields required by states and federal?**
No. CareOS has **three form templates** — `rn_assessment`, `visit_note`, `plan_of_care`, roughly 13 fields total — and they exist only in `supabase/seed.sql`, which is local/preview per D-006. **Zero form templates ship in any production migration.** Three cadence rules exist, all carrying the literal placeholder citation `Doc 02 §3 — enrich with COMAR cite`. Against a measured requirement surface of **105+ distinct documentation obligations**, that is a demo.

**Q: Do we have everything for companies to use it seamlessly?**
No — and forms are not the top blocker. See §7.

**But the framing "get all the forms" is the wrong goal, and the research says so decisively.**

---

## 2. The reframe: 88 content requirements vs. 17 prescribed forms

Across the completed lenses, every documentation obligation was classified as *prescribed form* (a specific official form you must reproduce and use), *content requirement* (a regulation names required content; the agency authors its own form), or *industry practice*.

| Classification | Count | Share |
|---|---:|---:|
| **Content requirement** — agency authors the form | **88** | 84% |
| **Prescribed form** — an official form must be used | 17 | 16% |
| Industry practice | 6 | — |
| Unclear | 1 | — |

And of those 17 prescribed forms, **most do not apply to a Maryland Residential Service Agency at all** (§3). The genuinely prescribed surface for this customer is roughly six to eight items, and they are overwhelmingly *state web portals and EDI transactions*, not documents CareOS would render.

The primary sources are emphatic and consistent on this point:

- **HIPAA prescribes zero chart or consent templates.** 45 CFR 164.520/164.508/164.504(e) name required *content*. HHS's own model Notices of Privacy Practices are explicitly optional — "covered entities may use these models."
- **Medicare's home health CoPs do not require CMS-485 or any certification form.** Medicare Benefit Policy Manual Ch.7 §30.5.1: certification statements "can be included in varying forms or formats as long as the content requirements … are met."
- **Maryland's RSA rule prescribes no client-record forms.** COMAR 10.07.05.14 enumerates what the clinical record must *contain*; the agency designs the form. The forms OHCQ actually publishes are agency-facing and administrative — RSA License Application (`APPLICATION_RSA-License-06.26.2026-A.pdf`), the PCA worker-classification certification, address/name/branch change forms, the complaint form, Outside Trainer Approval — and most are **Smartsheet web forms submitted on the state's own portal.**

**What this changes.** There is no Maryland form library to acquire, because one does not exist. The work is not research-and-transcription; it is *satisfying an enumerated content specification with well-designed forms*. That is a design problem CareOS is well positioned to do better than incumbents, and it is dramatically cheaper than the brief's 50-state acquisition programme implies.

The four things that genuinely require acquisition or integration, rather than design, are:

1. **Structured federal instruments** — OASIS ships as a machine-readable data dictionary (`itm_mstr.csv`, Data Submission Specifications V3.02.0; ~441 non-filler items). That is a data-modelling task against a published spec, not transcription. Same shape for MDS.
2. **A small set of genuinely prescribed federal forms** — I-9; and for Medicare-certified providers only, ABN (CMS-R-131), HHCCN (CMS-10280), NOMNC (CMS-10123), DENC.
3. **State portal submissions** — OHCQ licensure and change forms; the MDH reportable-event report under COMAR 10.09.84.05 (form not located).
4. **State systems that are the record** — see §6. This is the big one.

---

## 3. Scoping correction: most of the federal layer does not bind this customer

A Maryland **Residential Service Agency** under COMAR 10.07.05 is a state-licensed home-care provider. It is **not** a Medicare-certified home health agency. Therefore:

- **42 CFR Part 484 (Home Health CoPs) does not bind American Care Team**, and neither does OASIS, HH QRP, HHCAHPS, HHVBP, or PDGM — unless and until they obtain a CMS certification number.
- **The Maryland MOLST mandate does not reach an RSA.** HG §5-608.1 and COMAR 10.01.21.04 name assisted living programs, home health agencies, hospices, hospitals, kidney dialysis centers and nursing homes. "Residential service agency" does not appear in COMAR 10.01.21.02's definitions. An RSA will routinely *receive* a MOLST; it is not obligated to complete one. **Verify whether American Care Team holds any additional license** (e.g. home health agency under COMAR 10.07.10) — if so, the mandate attaches.

The stakeholder brief lists "Residential Service Agency" within the assisted-living family. That is a category error worth correcting: in Maryland, RSA is a *home-care* licensure category under 10.07.05, distinct from Assisted Living Programs under 10.07.14.

**Implication:** the OASIS work, the HH CoP work, and most of the federal notice layer belong to the *expansion* case, not the current customer. Building them now would be speculative scope. They matter as the ceiling competitors are built to, and as the destination if the founder pursues Medicare certification — which is a business decision, not an engineering one.

---

## 4. What COMAR 10.07.05 actually requires (verified by hand, primary text)

### 4.1 The clinical record — COMAR 10.07.05.14

Twelve enumerated elements:

health care orders currently in effect · nurse's assessment · rehabilitation plans, if appropriate · the care plan · medications administered or taken, including **dosage, route of administration, and frequency** · history of sensitivities or allergic reactions · nutritional requirements including specific dietary plans · medically necessary supplies and equipment · care notes · contact information for the client's physicians and the client representative · discharge documents: directions for the safe continuation of care after discharge, and a discharge summary (where skilled services were provided) including reason for discharge.

**Care-note cadence (§D):** on admission **and at least weekly**; upon any significant change in the client's condition; when the care plan is modified. Entries must be "detailed, legible, chronological, dated, and signed with the name and title" of the provider.

### 4.2 Plan of care contents — COMAR 10.07.05.12

Must address: services provided · frequency and timing · delivery method and personnel · **long- and short-range goals** · physical safety needs.

CareOS's `plan_of_care` template has ~4 fields against five named content areas.

### 4.3 Assessment and supervision — COMAR 10.07.05.12

- RN assessment **before services** (unless no skilled care anticipated); **annually**; on client/representative request.
- **Within 48 hours** where the client needs any of an enumerated clinical list: wound care, catheter care, stage 3–4 ulcers, ventilator services, medication adjustments, infusion therapy, specialized nutrition, high-risk monitoring.
- **Documented-exception path:** if the RN determines the 48-hour assessment is unnecessary, that must be documented and the assessment conducted **within 7 calendar days.**
- Suspension during weather emergencies, natural disasters, or declared emergencies.
- **Nursing supervision on site:** every **45 days** if staff administers medications; every **3 months** if staff assists with self-administration; every **4 months** with no medication involvement; more frequently if clinical status warrants.
- **On-call:** 24/7 availability; response **within 1 hour**; maintain inquiry logs recording personnel identity, content, and timestamps.

### 4.4 Personnel — COMAR 10.07.05.10

Required in the personnel file **before the individual is referred to clients**: criminal history records check (state CHRC or private agency check per Health-General Title 19, Subtitle 19) · verification of current professional licensure or certification · basic health screening including tuberculosis screening · verification of references · verification of employment history · Form I-9 · verification of identity and employment eligibility · in-person interview · skills assessment and demonstration. Training records are retained in the personnel file; records maintained in the agency's business office.

Every one of these maps cleanly onto `credential_type.blocks_scheduling = true`.

**Refinement from the workforce lens:** Health-General §19-1902's criminal-history mandate reaches only "eligible employees" — a defined term that excludes licensed/certified staff, who go through the Board of Nursing CHRC programme instead. So there are **two distinct background-check pathways**, and CareOS models one.

### 4.5 Training — COMAR 10.07.05.11

Seven required topics: personal care instruction and supervised practice · identifying situations requiring RN referral including significant change in condition · record keeping · ethical behavior and confidentiality · CPR · standard precautions for infection control · prevention of abuse and neglect.

**The regulation specifies no hours and no renewal frequency.** Training from anyone other than the agency requires **written OHCQ approval** (Outside Trainer Approval Form).

---

## 5. Verified defects in what CareOS has already encoded

These are live, and each is the exact failure mode the "never cite regulations from memory" rule exists to prevent.

| # | Defect | Evidence |
|---|---|---|
| 1 | **Retention has three conflicting numbers.** `careos-compliance-context` says "~6-year retention." COMAR 10.07.05.15 says **5 years** after discharge (minors: until 21, or 5 years after the record is made, whichever is later) and cites HG §4-403. But the current text of **HG §4-403 says 7 years** after the record is made (minors: age of majority + 7), with a mandatory pre-destruction notice and 60-day retrieval window. The COMAR text appears stale relative to the statute. CareOS must retain to the **longest applicable clock** — and this is a compliance-counsel question, not an engineering one. | COMAR 10.07.05.15; Md. HG §4-403; `.claude/skills/careos-compliance-context/SKILL.md` |
| 2 | **Supervisory intervals are encoded in the wrong unit.** COMAR says 45 days / **3 months** / **4 months**. CareOS encodes `supervisory.45d/.90d/.120d` as `interval_days`. Calendar months are not fixed day counts; for a deadline engine this is a correctness bug, not a rounding preference. | COMAR 10.07.05.12; `supabase/seeds/cadence.sql` |
| 3 | **CPR renewal interval is likely wrong.** Seeded `cpr` uses `renewal_interval_days = 365`. COMAR names CPR as a topic with no interval; typical AHA BLS card validity is **2 years**. The seeded value has no regulatory basis. | `supabase/seeds/credentials.sql`; COMAR 10.07.05.11 |
| 4 | **TB re-screen interval is invented.** COMAR 10.07.05.10B says "basic health screening, including tuberculosis screening" with **no interval**. The seeded `tb_screen` carries one. | COMAR 10.07.05.10B; `supabase/seeds/credentials.sql` |
| 5 | **The weekly care-note cadence does not exist in CareOS at all**, and two of its three triggers are event-driven — while `trigger_kind='on_event'` is a dead enum value the evaluator never implements. | COMAR 10.07.05.14D; `supabase/migrations/0009_cadence.sql:205-219` |
| 6 | **The 48-hour rule is modelled without its trigger list or its exception path.** No enumerated clinical triggers, no 7-calendar-day documented-exception branch. | COMAR 10.07.05.12 |
| 7 | **Personnel-record retention is unspecified in COMAR 10.07.05** — .15's 5-year rule is explicitly for *client* records. Medicaid participation supplies a 6-year floor (COMAR 10.09.36.03, 10.09.84.05); HIPAA supplies 6 years for its own documentation. CareOS has no retention implementation at all. | Workforce lens; `grep retention supabase/migrations/` → zero hits |

**Maryland is also stricter than HIPAA in a way CareOS does not model.** HG §4-303 caps a disclosure authorization at **one year**, requires the provider be named, and requires the authorization, the actions taken in response, and any revocation to be **filed in the medical record**. HIPAA requires none of those. CareOS has no consent or authorization table.

---

## 6. The architectural finding: for the dominant payer, the state holds the record

This is the most consequential result in the research and it is not in the stakeholder brief.

For a Maryland RSA doing personal assistance, the dominant payer is **Medicaid fee-for-service LTSS** — Community First Choice (COMAR 10.09.84), Community Personal Assistance Services (COMAR 10.09.20), and the Home and Community-Based Options Waiver (COMAR 10.09.54). **LTSS is carved out of HealthChoice MCO managed care**, so MCO provider manuals govern skilled home health, not personal assistance.

And the two highest-value payer records — **the Plan of Service and the EVV visit record — are authored and held in a state system (LTSSMaryland / ISAS), not by the agency.** The Plan of Service is signed by the participant, the supports planner (a separate entity), and the provider. Services must be preauthorized in the POS.

**CareOS is therefore not the system of record for the two documents that determine whether the agency gets paid.** It reconciles against them. This is already the ratified doctrine for EVV in `careos-compliance-context` ("ISAS is the state's system of record; CareOS reconciles, never presumes to replace") — but it extends further than EVV, to the care plan itself, and that has not been designed for.

**Still unverified and on the critical path:** whether Maryland ISAS is an **open** model (third-party alternate EVV vendors may certify and submit) or a **closed** state-only model. Search results asserted vendors "must integrate with ISAS" but no authoritative Maryland source confirmed it. This is D-Q16/V10, still the longest-lead external dependency in the plan, and it determines whether CareOS can capture EVV at all or must drive caregivers into a state app.

---

## 7. Honest blocker ranking — forms are not first

For American Care Team to run its business on CareOS today, in order:

1. **EVV / ISAS integration.** Unresolved modality (D-Q16/V10). Without it, Medicaid visits cannot be verified or billed. Blocks revenue.
2. **Billing and payroll.** EVV → claim (837P/CMS-1500 via Maryland Medicaid EDI), payroll reconciliation. CareOS has `billable_visit`/`claim_export` in the data dictionary and **nothing in code**. Blocks revenue.
3. **The scheduling write path.** `app.assert_schedulable` exists, is granted, is pgTAP-tested, and **has no production caller**; `visit`/`shift` carry direct write grants, so the credential guard is bypassable. Blocks safe operation.
4. **Retention, legal hold, and the document/storage layer.** None exist in code. Blocks compliance.
5. **Consent/authorization model.** No table. Maryland's 1-year authorization rule is unmodelled. Blocks compliance.
6. **The form content layer** — this section's subject.
7. **Migration off the incumbent.** Unassessed; the market lens did not complete.

Forms are sixth. Building a national form corpus before items 1–5 would be optimizing the wrong constraint. That said, item 6 is cheap *because* of §2 — satisfying ~40 content requirements for one provider type in one state is design work measured in weeks, not a research programme measured in analyst-years.

---

## 8. On "the world's first AI-native OS for eldercare"

The ambition is good and the architecture genuinely supports a strong version of it. But the market-research lens did not complete, so I cannot tell you what competitors currently claim, and I will not assert it.

What I can say from the evidence in hand:

**Defensible today.** CareOS's integrity spine is unusually strong for this market — append-only versions, a hash-chained audit ledger, and an e-signature binding that is *constraint-true* rather than policy-true (the `signature` ↔ `form_version` composite FK on `content_hash`). Very little software in any regulated vertical can prove "this signature belongs to exactly this content" at the database layer. That is a real, demonstrable differentiator and it already exists.

**Not yet defensible.** "AI-native" is currently an aspiration: there is no `packages/`, no `ai` schema, no pgvector, no model-calling code anywhere in the repo. The AI layer is 100% specification. Claiming AI-native today would be claiming a capability that does not exist — in a regulated market, where the buyer is a licensed operator and the reader may eventually be a surveyor or a plaintiff's attorney, an unearned claim is a liability rather than an asset.

**The wedge I would actually claim** — supported by §2 — is this: because most eldercare documentation is a *content requirement* rather than a prescribed form, incumbents ship form *builders* and leave agencies to guess whether their forms satisfy the regulation. CareOS can ship forms that are **traceable to the requirement they satisfy**, with the authority record, the effective date, and the verifier attached — and answer "why is this required, under what authority, as of what date" from stored rules. That is a claim about *provenance and explainability*, it is architecturally true of CareOS's design, and it is much harder to copy than a form library. Lead with that.

---

## 9. What to build, in order

**ST-113 — Maryland RSA content-requirement set (P0).**
Author the form templates that satisfy COMAR 10.07.05.14 (12 elements), .12 plan-of-care (5 content areas), and the care-note cadence. Ship them in a **production migration**, not a local seed — following `0008_credentials.sql`, which correctly seeds its permission catalog into the migration itself. Each template row links to a `legal_authority` record (proposed as D-014 in the prior analysis) carrying citation, source URL, checksum, retrieved date, effective date, verifier, and verification status.
*Estimated: ~12–18 templates, ~150–250 fields. Engineering ~8–12 days. RN SME review ~20–30 hours — the binding constraint at 0.2 FTE.*

**ST-114 — Cadence rules corrected and completed (P0).**
Fix the three verified defects (retention clock, month-vs-day supervisory intervals, CPR/TB intervals). Implement `trigger_kind='on_event'` and `'on_admission'` in `app.evaluate_compliance()`. Add the weekly care-note rule, the 48-hour rule with its enumerated trigger list and 7-day exception branch, and the on-call 1-hour response log. Add a clock parameter to the evaluator so temporal correctness is testable — `app.cadence_status` already takes `p_today` and is the established pattern.

**ST-115 — Credential types completed (P0).**
Expand from ~4 seeded types to the full COMAR 10.07.05.10 pre-referral set, with **two background-check pathways** (eligible-employee CHRC vs. Board of Nursing), all with `blocks_scheduling = true`. Then **wire `app.assert_schedulable` into the write path and close the direct grants on `visit`/`shift`** — the guard is worthless while the mutation path bypasses it.

**ST-116 — Consent and authorization model (P1).**
Consent/authorization table with Maryland's 1-year expiry, named-provider requirement, and the record-filing obligation for the authorization, actions taken, and revocation.

**Not now:** OASIS/Part 484 (does not bind this customer), the national corpus (gated on D-019), the payer manual layer beyond Maryland Medicaid LTSS.

---

## 10. Open questions requiring a human

| Question | Who | Blocks |
|---|---|---|
| **Retention: 5 years (COMAR) or 7 (HG §4-403), or cumulative?** Two Maryland texts disagree. | Compliance counsel | All retention work; the number is currently wrong in the skill file |
| Does American Care Team hold any license beyond the RSA (home health under 10.07.10, hospice)? Changes MOLST, and potentially Part 484 applicability. | Founder | Scoping of §3 |
| **Is Maryland ISAS open or closed** to third-party EVV vendors? | Founder + MDH contact (V10/D-Q16) | Whether CareOS can capture EVV at all |
| Are the 7 training topics required *before* first client visit? COMAR ties interview and skills assessment to "before referral"; training has no stated deadline. | OHCQ interpretation | Credential blocking logic |
| Is there any Maryland annual in-service **hour** requirement for RSA caregivers? None found; vendor sources claim none. | Compliance advisor | Training cadence rules |
| Identity and current revision of the MDH "Department form" for the 7-day reportable-event report under COMAR 10.09.84.05. | Compliance advisor | Incident reporting |
| Does OHCQ enforce an **annual TB re-screen** as unwritten survey practice? | Compliance advisor | Credential intervals |
| Whether a Certified Medication Technician may practice in a home/RSA setting — MBON lists assisted living, school health, adult day care, DDA ALUs, group homes; **not home care**. | RN SME | Medication administration model |

---

## 11. What this research could not establish

Stated plainly, because a gap named is safer than a gap papered over:

- The Maryland Medicaid/EVV lens and the hospice/SNF/ALF lens **did not complete** (connection errors). Maryland Medicaid findings here come from the payer lens only.
- The **acquisition/interop lens, the "seamless" lens, and the market lens did not run** (rate limit). So: terminology licensing posture (LOINC/SNOMED/RxNorm/CPT), machine-readability of eCFR/Federal Register/state codes, migration paths off incumbents, and what competitors actually ship are all **unresearched**. The blocker ranking in §7 is my own judgement from the repo, not from market research.
- COMAR text was read via a third-party mirror (`mdrules.elaws.us`); the official source moved to `regs.maryland.gov` in March 2026 and did not respond to automated fetch. **Every COMAR citation here should be re-verified against the official source before it is encoded.**
- Two completed lenses ran without the safety classifier available. Their outputs were used only where they carry a primary-source URL.
- The current Maryland MOLST version/revision date, the current Form I-9 edition (uscis.gov returned 403), and the DENC form number are all unverified.

This is exactly the condition the `legal_authority` record (D-014) is designed for: every one of these becomes a row with `review_status`, a named verifier, and a checksum — and **nothing reaches `published` without a human.**
