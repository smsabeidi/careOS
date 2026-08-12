# TODOS

Deferred work, each item approved for deferral in the 2026-08-12 CEO review
(`~/.gstack/projects/smsabeidi-careOS/ceo-plans/2026-08-12-intelligent-front-door.md`).
Source analysis: `docs/reviews/2026-08-12-takecareos-competitive-product-analysis.md`.

## P2 — Offline voice-note capture (audio in the offline queue)
**What:** Let caregivers record voice notes with no connectivity; queue audio locally, sync on reconnect.
**Why:** v1 voice is online-only (CEO review R2); basements and dead zones are real for field staff.
**Context:** `apps/web/src/lib/offline/queue.ts` is a JSON-event replay queue with no blob handling. Offline audio needs IndexedDB blob storage, quota/eviction policy, upload replay, and at-rest protection — which is gated on **V19** (web device-posture section for docs/09 §2). Do not start before V19 closes.
**Effort:** M (human) → S–M (CC). **Depends on:** V19; W3 shipped.

## P2 — OCR path for scanned/photographed forms
**What:** Extend W4's PDF import to image-only PDFs via OCR, with a published accuracy bar.
**Why:** v1 imports digital-text PDFs only (CEO review R3); paper-native agencies hit the honest-fallback copy today.
**Context:** Scanned uploads are already stored for later conversion. OCR vendor-or-local choice must go through the docs/09 §6 register (BAA implications). Field-detection accuracy on scans needs its own eval corpus before this ships.
**Effort:** M–L (human) → M (CC). **Depends on:** W4 shipped; §6 register decision.

## P2 — Generic NL→action extraction (the platform layer)
**What:** Extract the scheduling-concrete W2 pipeline into a generic NL→`ai_proposal` layer.
**Why:** Deliberately deferred (CEO review R6) to avoid premature generalization and tier laundering; the trigger is the SECOND accepted action class.
**Context:** Keep the tier rule (proposal tier = max(router, target)), per-action allowlist, and per-capability eval sets when generalizing. `apps/web/src/lib/ai/registry.ts` is the governance unit.
**Effort:** M (human) → S (CC). **Depends on:** a second action class accepted by the founder.

## P3 — Group shifts with participant ratios
**What:** Model multi-participant shifts (e.g. 1 worker : 2 clients) with ratio-aware billing implications.
**Why:** TakeCareOS models this; our schema does not express it.
**Context:** Confirm with American Care Team whether group service occurs in their book of business BEFORE building. Touches `visit`/`shift` modelling (D-023 vocabulary) — needs a decision-log entry if it changes the visit model.
**Effort:** M (human) → S–M (CC). **Depends on:** agency confirmation.

## P1 — Messaging v1 (entity-anchored threads) — BLOCKED on W0 decision (a)
**What:** In-platform coordination threads anchored to a visit/client/exception; append-only, RLS to care team, no PHI in push payloads, retention + legal-hold covered.
**Why:** Coordination in WhatsApp is evidence we don't have; one of the two genuine functional gaps vs TakeCareOS.
**Context:** Deliberately NOT started until the founder ratifies the messaging-posture decision entry drafted in W0 (ST-231a). v1 scope recommendation on record: entity-anchored threads, not free-floating channels.
**Effort:** L (human) → M (CC). **Blocked by:** decision entry (a).

## P1 — Revenue cycle v1 — BLOCKED on W0 decision (b)
**What:** Whatever the ratified decision says: claims/invoicing build vs export boundary (QuickBooks-class vendor, Maryland claims path under ISAS).
**Why:** The other genuine functional gap; invoicing is TakeCareOS's most substantial functional advantage.
**Context:** `payroll_period`/`payroll_export` (D-027) establish the export-boundary pattern. Money is rules-engine work (invariant 13) — no LLM computation. Vendor entry requires docs/09 §6 + BAA analysis.
**Effort:** L–XL (human) → M–L (CC). **Blocked by:** decision entry (b).

## Parallel track (not a TODO — has a start date)
Content engine in the website repo (3 Maryland regulatory guides + 1 comparison page), starting
alongside W1 per CEO review R5; trademark/name-collision legal read goes first since it gates
the comparison page. Claims route through `careos-compliance-context` — never from memory.
