# TakeCareOS — Deep Competitive Product Analysis

**Date:** 2026-08-12
**Subject:** takecareos.com (TakeCareOS, Inc.) — "The AI Operating System for Home Care Agencies"
**Analyst posture:** Public-surface only. Everything below is either directly observed on their public site and JavaScript bundle, or explicitly labelled as their claim. I never saw the product behind `/sign-in`, so no statement here should be read as verification that their software does what their marketing says.

---

## 1. The verdict in one paragraph

TakeCareOS is a one-person, YC-backed startup that has, in a matter of months, shipped a broader *surface* than CareOS has — rostering, CRM, messaging, timesheets, invoicing, forms, mobile PWA — and wrapped all of it in a single conversational front door called Atlas. They are not beating us on correctness, compliance depth, or data integrity; there is no evidence they have anything like our RLS perimeter, append-only history, autonomy-tier enforcement, or audit-chain verification, and their own security FAQ conspicuously does not claim HIPAA or a BAA. They are beating us on **legibility and reach**: a buyer can understand their whole product in ninety seconds, install it on a phone without an app store, and ask it a question in English. Our correct response is not to chase their breadth wholesale. It is to take the four or five *packaging* wins that are cheap for us because the hard machinery already exists in our database — the conversational front door, note-quality coaching, self-serve form conversion, a unified alert inbox, and an installable push-enabled field app — while treating their two genuine product gaps for us (in-platform messaging and revenue cycle) as decisions to ratify, not features to copy reflexively.

---

## 2. Who they actually are

Per their Y Combinator profile, TakeCareOS is a **Spring 2026** batch company, founded 2026, based in the SF Bay Area, with a listed **team size of one**. The founder is Ragav Sachdeva — PhD from Oxford, previously at Nvidia, Google, and Microsoft. Their YC partner is Andrew Miklas. Their homepage carries the trust markers you would expect at that stage: "built by engineering talent from" (Google, Microsoft, Nvidia logos) and "backed by the investors of" (Stripe, Airbnb, DoorDash, Dropbox logos) — investor-of-investor framing, not their own logos.

Their stated traction is **six agencies with 200+ employees** on the platform following recent pilots. Their stated market is US Medicaid HCBS (they size it at $140B+ annually) and Australian NDIS ($40B+).

That profile matters more than any individual feature. A solo founder serving six agencies across two regulatory regimes on two continents is running a breadth-first, depth-later strategy. Every gap identified later in this document is a predictable consequence of that choice, and every gap they have is one we can only exploit if we make our depth visible.

**Naming collision worth knowing:** they own `takecareos.com` and brand as "TakeCareOS"; the AI agent is "Atlas". Our product name is CareOS. There are also unrelated products at `care-os.com` (a bathroom health device) and `careos.tech` (a European home-care system). Our brand is not uniquely ours in this space, and theirs is closer to ours than any other. This is a trademark and SEO problem we should look at separately.

---

## 3. Their technical fingerprint (observed, not claimed)

I loaded their site in a browser and read the network waterfall. The public bundle tells us a lot:

- **Vite-built React single-page app.** Hashed asset names (`assets/index-BMPfgch1.js`), no Next.js/RSC signature, per-icon code-split chunks. This is a client-rendered SPA, not a server-component app.
- **Supabase for auth** — `assets/useSupabaseAuth-*.js` and `assets/supabaseAuth-*.js` ship in the sign-in route chunk. They are, almost certainly, on the same platform we are.
- **Workbox PWA** — `registerSW.js` and `workbox-window.prod.es5-*.js`. This is how they get "install without an app store," offline, and push.
- **Lexical** (Meta's rich-text editor framework) — shift notes and messaging are built on a real editor, not a textarea.
- **dnd-kit** — drag-and-drop, almost certainly the roster board.
- **react-pdf** — client-side PDF rendering, which is the substrate for their "PDF Form Converter."
- **Zod + a shadcn-style component layer** (`form`, `label`, `input`, `password-input`) with **lucide-react** icons.

Two conclusions follow. First, **their architectural choices are ours minus the server tier**: same database platform, same auth, but a client-rendered SPA rather than Next.js RSC. That means their authorization story is, at best, Supabase RLS — and if it is not RLS-forced with per-operation policies, a client-rendered app talking directly to PostgREST is a substantially larger attack surface than ours. I cannot verify their policies; I can say the shape of the app puts more weight on them.

Second, **there is nothing exotic here that we cannot build.** No proprietary infrastructure, no ML they own. Their moat is product decisions and shipping speed, not technology.

---

## 4. The product, module by module

Their homepage is a long scrolling product demo with live-looking mock UI. Reading it carefully yields their full information architecture. The in-app navigation, visible in their own screenshot, is:

**Overview** — Ask Atlas · Messages · Alerts
**Care** — Calendar · Participants · Docs
**Operations** — Team · Timesheets · Invoices · Register

That grouping is itself a lesson: three buckets, eleven destinations, and the AI is the first item under the first bucket rather than a separate destination.

### Ask Atlas (the conversational front door)

The centerpiece. A persistent "How can I help you today?" composer with an "Add context" affordance. Their own blog post on conversational AI names six concrete workflows:

1. Rostering — *"Schedule Maria for Tom's Friday morning shift and notify her"*
2. Report generation — *"Summarise Tom Bradley's last 4 weeks of shift notes for his plan review"*
3. Compliance queries — *"Which workers have credentials expiring in the next 30 days?"*
4. Timesheet variance flagging — surface discrepancies over 30 minutes from scheduled
5. Incident reporting — auto-prefill from shift notes and participant records
6. Budget tracking — *"What's the remaining budget for Aisha Hassan's Core Supports?"*

Their stated philosophy: *"the interface is language, the user doesn't need to know which module contains what they need."* And their stated governance: draft-and-review, human sign-off before commit, framed in the FAQ as *"Think of it as a very smart assistant, not an autonomous system."*

That governance claim is a **UX pattern**, not an enforced constraint. Nothing in their public material suggests tiers, disposer requirements, or database-level gating. We enforce ours in Postgres. That difference is invisible to a buyer today and is exactly the kind of thing we have to learn to make visible.

### Rostering / Calendar

Day/Week views, "Add Shift," drag-and-drop, recurring shifts, **group shifts** with participant ratios (their mock shows "Mark (1/2), Tom (1/2)"), staff availability, and NDIS line-item codes attached to the shift itself (`01_011_0107_1_1`, "Assist. w/ Daily Life – Weekday Daytime"). Assignment triggers a push notification: *"Shift scheduled. Liam has been notified."*

The group-shift ratio model is worth noting. Two participants sharing one worker at a 1:2 ratio, with billing derived from the ratio, is a real modelling problem that our schema does not currently express.

### Mobile shift flow

Their mock walks the full caregiver journey: push notification → Shift Details (SCHEDULED, start/end, duration, address, assigned worker, participant list) → **Start Shift** → SHIFT IN PROGRESS with a TIMELINE showing "Clocked in 09:00" and the address → **End Shift**. GPS captured at both events. Clock-ins outside the scheduled address are *"flagged immediately for coordinator review, before they affect billing."*

This is a straight analogue of our `/today` flow and the 0046 clock engine. Their version is a PWA; ours is a web surface with an offline queue.

### Shift notes + the "Shift Notes Companion"

This is, in my judgment, **their single best product idea**, and the cheapest for us to answer.

Their mock shows a note stream (multiple workers, timestamped, plain narrative) alongside an **AI SUGGESTIONS** panel that critiques the note *as it is being written*:

- *"Insufficient detail: What triggered the incident and what actions were taken?"*
- *"Goal linkage: KFC relates to Tom's dietary goals — was this discussed with him?"*
- *"Vague language: 'seemed fine' — describe observable mood or behaviour"*

Their NDIS audit post extends this: the companion *"flags vague notes in real-time during logging"* and prompts with *"This note does not describe what support activities were delivered."*

The insight underneath: **audit failures are documentation-quality failures, and quality has to be enforced at the point of capture, not at review time.** Their framing — *"Most NDIS audit failures are not caused by providers doing the wrong thing. They are caused by providers who cannot prove they did the right thing"* — is precisely the CareOS thesis, expressed better than we currently express it.

Note also the *goal linkage* check: it cross-references the note against the participant's plan goals. We have `care_plan_item`. We can do this.

### AI Form Converter (PDF → digital form)

Upload a PDF (their example: an NDIS incident and accident reporting form), and the system parses it into a structured digital form — their mock reads *"Auto-converted from PDF — 4 sections, 12 fields detected"* — preserving section headings, field types, date/time inputs, and radio groups (Participant/Worker/Visitor/Public; Injury/Medical/Behavioural/Property/Other).

Then Atlas **fills** the resulting form from context: shift notes, participant records, GPS data, and roster information. Their mock shows an Incident Report reaching "All fields filled" with Participant Name, Medicaid ID, Date, Time, Location, Staff on Shift, Incident Type, Description, Actions Taken — plus "Also available: Weekly Progress Report (draft)."

They weaponize this competitively. In their ShiftCare comparison, the attack line is that on incumbent platforms *"building a new form requires a support ticket to your vendor."* Self-serve form authoring is their wedge, and "bring us your paper forms, we'll digitize them on the call" is an extremely strong demo.

### Timesheets with AI variance review

A table with columns WORKER / SCHED. / ACTUAL / VAR. / STATUS, where variance is computed against GPS-verified clock times and the AI pre-triages. Their mock deliberately includes a catastrophic row — Liam O'Connor, scheduled 30h 45m, actual 0h 15m, variance −355m — next to trivial ±6-minute rows. That is a well-designed demo: it shows the system separating noise from the one thing a human must look at.

Their framing: *"Atlas surfaces exceptions that need decision, with context."* The work shifts from doing to reviewing.

### Invoices

Auto-generated from shifts, with a live "Generating…" state, per-participant invoice numbers (`INV-202603-00008`), and dollar totals. Sync to **Xero** and **MYOB**. They claim handling for split shifts, group ratios, and multi-code arrangements — and they attack ShiftCare specifically on "known UX issues with complex billing."

**This is the largest functional gap in our product relative to theirs.** We have `payroll_period` and `payroll_export` — a boundary to payroll — and nothing at all for revenue.

### Messaging

Full Slack-shaped messaging: `#general`, `#team-alpha`, `#incidents`, `#shift-swaps` channels with unread counts, direct messages, threads, emoji reactions, member counts. Their mock deliberately shows an *operational* conversation — a shift swap being agreed, the roster being updated, and a supervisor approving the swap — all inside the platform.

The strategic point is not "they have chat." It is that **coordination that happens in the platform is coordination that is captured, attributable, and auditable**, and coordination that happens in WhatsApp is evidence you do not have. Their "10 signs" post makes this argument explicitly: last-minute shift changes generating coordination threads outside the system is sign #4.

### Alerts

A single severity-ranked queue mixing sources that we currently keep in separate surfaces:

| Alert | Severity |
|---|---|
| Incident Report Filed — behavioural incident during shift | Critical |
| GPS: Clock-in 240m from location | Warning |
| Document 'First Aid Cert' expires in 7 days | Warning |
| Shift Cancellation — Emily Nguyen | Info |
| Timesheet Reminder — fortnightly timesheets due | Info |

Credential expiry, geofence violation, incident, cancellation, and a workflow nudge, in one list, with a Requests tab alongside. Their audit post specifies escalating credential alerts at **60, 30, and 0 days**, and — importantly — that expiry **prevents rostering**. That is our credential-wall behaviour; they market it, we bury it.

### Everything else they list

Their feature marquee, in full: Shift Rostering · Participant Profiles · Medicaid Invoicing · Team Messaging · Timesheets · Compliance Alerts · Care Plans · GPS Clock In/Out · Staff Credentials · AI Shift Summaries · Push Notifications · Incident Reports · Xero Integration · Document Storage · Voice Notes · Roles & Permissions · Progress Reports · Staff Availability · MYOB Integration · Full-Text Search · Recurring Shifts · Audit Trail · AI Form Filling · Custom Picklists · Mobile App · Service Agreements · Staff Onboarding · Group Shifts · Travel Billing · Expiry Reminders · Channels & DMs · PDF Form Converter · Participant Reports · Location Alerts · Custom Forms · Row-Level Security.

Note the last one. **They market "Row-Level Security" as a feature name to home-care agency owners.** We treat RLS as an invariant so basic it goes unmentioned. They are selling a fraction of what we have.

### Mobile: PWA, not native

Their `/install` page states plainly: *"TakeCareOS is a Progressive Web App (PWA). Once installed, it works offline, sends push notifications, and feels just like a native app."* The iOS path is Safari → Share → Add to Home Screen, with separate notification-troubleshooting instructions for iOS 18+ and iOS 17-and-earlier. An Android tab exists. No App Store, no Play Store, no review cycle.

For a company shipping this fast, that is the right call, and it deserves serious consideration on our side given D-003/D-009 still ratify a PowerSync + Expo path that has not been built.

### Security posture (their words)

From their FAQ: *"We use 256-bit encryption with US and Australian data residency options. Your participant data is protected by enterprise-grade security, and we're actively working toward SOC 2 certification."*

Read that carefully. "256-bit encryption" is a marketing phrase, not a control. SOC 2 is *in progress*. And across their entire public surface — homepage, FAQ, seven blog posts including one specifically on Medicaid HCBS — **I found no claim of HIPAA compliance and no mention of a Business Associate Agreement**, despite selling to US Medicaid providers who handle PHI. Either they have it and do not market it, or they do not have it. Either way, it is the softest part of their story and the hardest part of ours.

---

## 5. Their thesis, stated fairly

Strip the marketing and their argument is coherent and largely correct:

Care agencies do not fail because staff are careless; they fail because the operational load is distributed across disconnected tools and the proof of good work never gets captured. The fix is a single data model where scheduling, verification, documentation, compliance, and money all reference the same entities — and then a language interface on top of it, because a unified model is the only thing that makes a language interface useful. Their line: *"Generic AI tools bolted onto generic software don't know what NDIS support categories are."* And: conversational AI bolted onto separate systems is "much weaker" than AI built into a unified one.

They are right. It is the same bet we made. The difference is that they have shipped the interface and are backfilling the rigour, and we have shipped the rigour and have not built the interface.

---

## 6. Parity matrix — grounded in our actual repo, not our docs

Our column reflects what is in the tree today (52 migrations, 72 tables, the routes under `apps/web/src/app`, and the ten registered AI capability keys), not what is specified.

| Capability | TakeCareOS | CareOS today | Read |
|---|---|---|---|
| Rostering / calendar | Day/Week, drag-drop, recurring, group shifts w/ ratios | `/schedule`, `shift`/`visit`, Lane-B RPCs, `schedule_exception` | Parity on core; **no group-shift ratio model** |
| GPS clock in/out | PWA capture both ends, out-of-area flag | 0046 clock engine, PostGIS geofence, `visit_event` | **We are ahead** (policy engine, versioned locations) |
| Offline field capture | Claimed for PWA; *not claimed in their own EVV guide* | `/today` offline queue | Roughly even; ours is unverified in production too |
| Exceptions / variance | AI-triaged timesheet variance table | 0047 exception engine, dispositions, 0048 trust score | **We are well ahead**, and it is invisible |
| EVV state submission | No aggregator named, no state list | `evv_adapter`/`evv_record`/`evv_submission`, MD adapter shipped disabled | Both incomplete; ours is architecturally honest |
| Credentials | Expiry alerts 60/30/0, blocks rostering | `credential`, catalog of 10, lapse sweep 0024, credential wall | **We are ahead** |
| Onboarding / HR | "Staff Onboarding" listed | `employee`, invitation→accept, 10-item COMAR checklist, separation saga | **We are well ahead** |
| Care plans / goals | Care Plans, Progress Reports | `care_plan`, `care_plan_item`, supervisory visits, clinical flags | **We are ahead** |
| Notes | Notes + real-time quality companion | `note.voice_draft` capability | **They are ahead** on the coaching loop |
| Forms | PDF→digital converter, self-serve, AI fill | `form_template`/`form_version`/`form_instance`, `extraction_job` | Engine parity; **no PDF-import authoring path** |
| Documents | Storage, version history, access trail | `document` + hr-docs bucket + storage RLS twin, two-phase destruction | **We are ahead** |
| Messaging | Channels, DMs, threads, reactions | **Nothing** | **They are ahead** — full gap |
| Alerts | One severity-ranked queue, all sources | `/inbox`, `notification`, exceptions split across surfaces | They are ahead **on packaging only** |
| Conversational assistant | Atlas as primary nav | `/brain`, `brain.answer`, `tools.ts`, RLS-scoped retrieval | Machinery parity; **packaging gap** |
| AI governance | "Draft and review" as UX | T0–T3 enforced in DB, `ai_proposal`/`ai_disposition`, agent identity, budgets, prompt registry | **We are dramatically ahead** |
| Audit | "Audit Trail" listed | `audit_event` + `audit_anchor`, `verify_audit_chain`, append-only invariant | **We are dramatically ahead** |
| Invoicing / claims | Auto-generated, Xero + MYOB, travel billing | **Nothing** (`payroll_export`/`payroll_period` only) | **They are ahead** — full gap |
| Mobile | Installable PWA + push, documented | Web surfaces; no install page, push unproven | **They are ahead** on distribution |
| Family / client-facing | Not offered | `/family`, `family_link`, `family_update`, `shared_document` | **We are ahead** — they have no answer |
| Compliance regime depth | NDIS + HCBS, breadth-first | COMAR 10.07.05 fidelity, `legal_authority`, `consent`, `obligation`, `evidence_packet` | **We are dramatically ahead in one state** |
| Security perimeter | RLS listed as a feature; SOC 2 in progress; no HIPAA claim found | RLS forced + per-op policies + pgTAP matrix, AAL2 for PHI, PHI-egress law, 1,718 assertions | **Not comparable** |

---

## 7. What to take from them — ranked

I have ordered these by (value to us) ÷ (cost to us), and every one of the top five is cheap **specifically because the machinery already exists in our database and only the surface is missing**.

### 1. Promote the Brain from a page to the front door

Today the Brain is `/brain` — a destination you navigate to. Atlas is the first thing in their app and a persistent composer on every screen. We already have `brain.answer`, a tool layer in `lib/ai/tools.ts`, and — critically — retrieval that runs under the requester's JWT (invariant 9), which is a *better* foundation than theirs for a language interface, because every answer is already authorization-correct by construction.

Take: a global command bar (⌘K / a persistent composer), available from every surface, that answers questions and *drafts* actions into our existing proposal/disposition flow. Their six example prompts map almost one-to-one onto capabilities we already have. Add their "Add context" affordance — pinning the current client, visit, or employee into the prompt is what makes short questions work, and it is also a natural PHI-minimizer boundary.

Guardrail: every action-shaped request lands as an `ai_proposal` at its registered tier. We do not weaken tiering to make the demo smoother.

### 2. Note-quality companion at the point of capture

Their strongest idea and, for us, a T1 advisory capability with no autonomy risk. Three critique classes, exactly as they frame them: insufficient detail, goal linkage, vague language. We have `care_plan_item` to link goals against and a forms/notes surface to attach it to.

This is the feature most likely to change what a surveyor sees, because it changes the corpus rather than the reporting on it. It should be a story this sprint.

### 3. Self-serve PDF → digital form conversion

We have the forms engine (`form_template` → `form_version` → `form_instance`) and document extraction (`extraction_job`/`extraction_field`). What we lack is the authoring path: upload a PDF, detect sections and fields, produce a draft `form_version` for a human to confirm, then publish.

The sales value is disproportionate. "Bring the forms you use today" removes the single biggest objection in a switch conversation, and it is the exact place they attack incumbents. Note their honest framing — "4 sections, 12 fields detected" — which sets the expectation that a human confirms the parse. That is our append-only versioning model anyway.

### 4. One alert inbox, severity-ranked, all sources

We have every input they show and better ones besides — credential lapse, geofence violation, exceptions, incidents, notifications, offers — spread across `/inbox`, `/office/compliance`, `/office/credentials`, `/operations/exceptions`. Their version is a single table with a severity column and a Requests tab.

Take the packaging, not the plumbing. Add their 60/30/0-day credential ladder as explicit copy, and say out loud in the UI that expiry blocks rostering — we already enforce it and never tell anyone.

### 5. Make the field app installable, push-enabled, and documented

Their `/install` page is a real product asset: PWA, no app store, iOS and Android tabs, and separate notification-recovery instructions for iOS 18+ and iOS 17. Meanwhile our ratified mobile path (D-003 PowerSync, D-009 Expo foundation) is unbuilt, and migration 0013's header cites a "web EVV supersedes mobile" decision that **does not exist in the decision log** — a phantom decision already flagged in the EVV board analysis.

Their success with a PWA is real evidence for resolving that open question, and it should force it: either retro-ratify a PWA-first field app with a proper D-row, or revert to the Expo path. What we cannot do is keep building field surfaces against an unratified assumption. Separately, a one-page install guide costs a day and materially changes caregiver adoption.

### 6. Timesheet variance as a review queue with real columns

Their SCHED / ACTUAL / VAR / STATUS table with a −355m outlier next to ±6m noise is better *presentation* of something we model more rigorously. Our exception engine and trust score should surface as exactly this table on `/operations/timesheets`, with AI pre-triage ordering the queue and each row expanding to its evidence.

### 7. Decide the revenue-cycle question — do not reflexively copy it

Invoicing is their most substantial functional advantage, and it is not a feature we should clone. Xero/MYOB sync is an Australian SMB answer. For a Maryland RSA, the equivalent is claims through the state's channel plus private-pay invoicing, and QuickBooks rather than Xero. Our `payroll_export`/`payroll_period` boundary already establishes the pattern of exporting at a boundary rather than becoming a ledger.

This needs a decision-log entry answering three questions before any code: are we a biller or an export boundary; what is the Maryland claims path given ISAS is the system of record; and which accounting vendor enters the docs/09 §6 register (with BAA implications). Recommend raising it as a founder decision this week, since it is on the critical path to anything that looks like a complete agency platform.

### 8. Messaging — take the principle, design it as a PHI surface

Their channels/DMs/threads is the other genuine gap, and the argument for it is strong: coordination outside the platform is evidence you do not have. But messaging is where PHI leaks. Under invariant 5, message *content* is PHI, which means no PHI in push payloads (IDs travel, content refetches under RLS — a pattern we already implement in 0036), append-only message history, retention and legal-hold coverage, and RLS scoping to care team membership rather than a flat channel model.

Recommend scoping v1 narrowly: entity-anchored threads (on a visit, a client, an exception) rather than free-floating Slack channels. It captures the operational value — the shift-swap conversation attached to the shift — with a fraction of the PHI surface, and it is strictly more useful for audit than a `#general` channel.

### 9. Group shifts with participant ratios

Their `Mark (1/2), Tom (1/2)` model is a real schema gap for us and a real billing construct. Lower priority for a Maryland RSA than for NDIS group programs, but worth confirming with the agency whether it occurs in their book of business before we assume it does not.

### 10. Their content engine

Seven long-form guides (nine to thirteen minutes each) covering EVV compliance, what HCBS is, NDIS audit expectations, fraud-protection legislation, when you have outgrown your software, what conversational AI means — plus a head-to-head comparison page against ShiftCare that names Brevity and CareMaster as well. That is a complete, repeatable SEO and sales-enablement motion: regulatory explainers capture search intent, the "outgrown your software" post creates the switching narrative, and the comparison page closes it.

Our website repo is essentially empty and `docs/marketing/website-prd.md` is unexecuted. The Maryland-specific equivalents write themselves: COMAR 10.07.05 for RSA owners, what Maryland's ISAS actually requires, what an OHCQ surveyor asks to see. We have deeper regulatory ground truth than they do — we simply have not published any of it.

**A caution that applies to all of it:** their compliance guides are marketing, not sources. Nothing in them may be cited in our docs or code. `careos-compliance-context` and docs/02 remain the only citation path.

---

## 8. Where we win, and why nobody can currently tell

These are real, expensive, and near-invisible to a buyer. Each needs a demo-able surface, not more engineering.

**Authorization is in the database, not the app.** RLS enabled *and forced*, explicit grants, a policy per operation, and a pgTAP matrix that fails CI when a table is added without coverage. They list "Row-Level Security" as a feature bullet. We should be able to show a policy matrix on screen.

**AAL2 for PHI.** MFA-verified sessions gate every PHI surface. They do not mention MFA anywhere.

**History cannot be overwritten.** Append-only for form versions, signatures, audit events, visit events, agent steps. Corrections reference what they correct; there is no update path in the schema, not merely none in the UI. Their "version history" claim is unspecified.

**The audit chain is verifiable.** `audit_anchor` plus `app.verify_audit_chain` means we can prove the log has not been altered. Almost nobody in this market can do that, and it is a devastating thing to show a surveyor.

**AI autonomy is enforced in Postgres, not promised in copy.** T0–T3 tiers, `trg_proposal_human_disposer` making human disposition structural, `trg_onboarding_human_verifier` making it impossible for an agent to attest an onboarding item, per-capability kill switches, monthly budgets, registry-versioned prompts, and an `ai_interaction` record for every call through one client. Their answer to "what if the AI makes a mistake" is "you review and approve." Ours is a trigger.

**Retrieval runs as the user.** No privileged retrieval path exists. Every AI answer is authorization-correct by construction — which, incidentally, is why our conversational front door will be *safer* than theirs the moment we ship it.

**Regulatory depth in one jurisdiction.** `legal_authority`, `consent`, `obligation`, `evidence_packet`, `supervisory_visit`, COMAR fidelity, cadence rules as deterministic rules-engine work rather than LLM judgment. They cover two national frameworks at breadth; we cover one state at depth. For an OHCQ survey, depth is the only thing that counts.

**A family surface.** `/family`, `family_link`, `family_update`, `shared_document`. They have no client- or family-facing product at all. For private-pay home care, the family *is* the buyer, and this is a differentiator they cannot answer quickly.

**Proof.** 1,718 pgTAP assertions across 40 files, a check-matrix gate, a spec-drift gate. Their public surface offers no evidence of any test posture.

The action item is not to build more of this. It is a **"Show me" surface** — one screen that renders the policy matrix, the audit-chain verification result, the AI tier table with kill-switch states, and the current pgTAP/gate status. That screen is a sales weapon and an internal health dashboard at once, and it is perhaps two days of work against data we already have.

---

## 9. What not to take

**Their security posture.** Do not let "SOC 2 in progress, 256-bit encryption, no HIPAA claim" become a benchmark for acceptable speed. Our AI still runs synthetic-only pending the OpenAI BAA (D-006/D-013), and that is the correct posture even though it is slower than theirs.

**Auto-generated invoices as LLM output.** Money is rules-engine work (invariant 13). If we build billing, rates, units, and eligibility are deterministic; the AI may explain and reconcile, never compute.

**Dual-market breadth.** NDIS and HCBS simultaneously, with a team of one, is how you end up with two shallow compliance stories. Our advantage is Maryland depth. Widen only after the first agency is live and surveyed.

**"Draft and review" as a substitute for enforcement.** Their governance is a convention. Ours is a constraint. Under demo pressure it will be tempting to add a fast path that skips a tier; that is a failed task under invariant 8, regardless of how good the demo looks.

**Their claims as facts.** Their EVV guide names offline clock-in and IVR telephony as compliance requirements while claiming neither for themselves, and never names a single state aggregator they integrate with. That is a company writing checks its product may not cash. We should not use their content as a source, and we should not assume they have shipped everything the homepage animates.

---

## 10. Strategic read

They are ahead on surface area and packaging; we are ahead on everything that determines whether an agency survives a survey. The race is asymmetric: **they must acquire depth, which is slow, regulated, and unglamorous; we must acquire packaging, which is fast and mostly design work.** We are on the better side of that trade, but only if we act on it — depth that nobody can see loses to breadth that demos well, every time, in a sales conversation.

Three things would change my assessment. If they announce HIPAA compliance with executed BAAs and SOC 2 completion, their softest flank closes. If they publish named state-aggregator integrations (Sandata, HHAeXchange, CareBridge, AuthentiCare), they get real US distribution and the EVV question stops being ours to win. If they raise and hire past one engineer, the depth gap closes faster than the packaging gap.

Meanwhile our own house has open items that this analysis makes more urgent, not less: the Verified Visit branch is built and verified locally but **not merged and not deployed**; docs 07–16 amendments never landed; the queue/cron/net paths have never been exercised against real infrastructure; there is no web test runner, so the new UI has zero E2E or a11y coverage; and the phantom mobile decision in migration 0013 still has no D-row. Shipping the packaging wins above on top of unmerged, undeployed, untested work would be the wrong order. **Land and deploy first, then package.**

---

## 11. Recommended sequence

1. **This week, no code:** raise the revenue-cycle decision (biller vs export boundary, Maryland claims path, accounting vendor + BAA) and the mobile decision (retro-ratify PWA-first or revert to Expo) as decision-log entries. Both currently block real work.
2. **Land the outstanding work:** merge and deploy the Verified Visit branch, land the docs 07–16 amendments, stand up a web test runner. Nothing below should start first.
3. **Then, in order:** note-quality companion → global Brain command bar → unified alert inbox with the 60/30/0 ladder → PDF form import → install page and push → timesheet review queue → "Show me" evidence screen.
4. **In parallel, non-engineering:** execute `docs/marketing/website-prd.md` with three Maryland-specific regulatory guides and one comparison page. Route every regulatory claim through `careos-compliance-context` before publishing.
5. **Separately:** get a legal read on the CareOS / TakeCareOS name collision before we spend on the brand.

---

## 12. What I could not determine

Pricing (not published anywhere). Anything behind `/sign-in` — the real product, its data model, its actual AI quality, whether the homepage animations reflect shipped functionality. Whether they hold a BAA or claim HIPAA compliance in private sales material. Which state EVV aggregators, if any, they integrate with. Whether their offline claim is real beyond a service-worker cache. Their retention, deletion, and legal-hold behaviour. Their true customer count beyond the six agencies stated on their YC profile.

If you want the next layer of detail, the highest-value move is a demo. They offer a free 60-minute demo with no commitment at `/hello`, and an hour inside the product would answer most of the list above.

---

**Sources:** takecareos.com (homepage, `/install`, `/blog` and all seven posts, sitemaps, and the production JavaScript bundle) · ycombinator.com/companies/takecareos · CareOS repo state at commit `c16fbeb`, branch `st-200-verified-visit-workforce-intelligence`.
