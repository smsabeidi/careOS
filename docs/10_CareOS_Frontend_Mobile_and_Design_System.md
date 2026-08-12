# CareOS — Frontend, Mobile & Design System Specification

**Client:** American Care Team (Maryland) · **Document:** 10 of 15 · **Version:** 1.2 (Draft) · **Prepared by:** OCTSERVICES LLC

> **Change note (v1.1, Jul 23 2026):** §3 design tokens rebranded to the "Apple 2026" visual language per **D-012** (Instrument Serif/Sans, Apple system blue on systemGray, frosted materials, spring-feel CSS motion, **light-only**). Prior Inter / teal-700 / warm-neutral tokens and day-one dark mode are superseded; the night-shift dark-mode rationale is retained as an open item for founder sign-off.
> **Change note (v1.2, Aug 10 2026):** §6 rewritten for **D-022** — the responsive web app is the caregiver EVV surface and offline capture is a PWA + IndexedDB queue, not Expo/PowerSync; the superseded native specification is marked in place. §2 gains the `/operations` console and `/settings/visit-policy` (Doc 17 §7.2) and the per-persona rail ceiling rises from 5 to 7. §5 gains the service-worker boundary. The caregiver clock contract — two actions, the non-blocking exception affordance, the forbidden-vocabulary list and the distance-bucket-as-words rule — is now written down in §6 rather than living only in code.
**Implements:** Doc 01 personas & P4 ("built for non-technical hands") · Doc 06 §4 · Doc 08 (lanes) · Doc 05 experience surfaces · Doc 17 §7 (verified-visit surfaces).

> **Purpose.** The experience contract. CareOS wins adoption or dies here: the primary users are nurses and caregivers, often on a phone, sometimes offline, in someone's living room. Every decision below is subordinate to one test — **if it isn't obvious to a non-technical caregiver on a mid-tier Android in a basement, it's wrong.**

---

## 1. Experience principles

1. **One next action.** Every screen answers "what should I do right now?" before it shows anything else. Dashboards lead with exceptions, not data.
2. **Plain language, always.** "Ms. Johnson's yearly check-up is due Friday" — never "Obligation OBL-1042 (rule assessment.annual) pending." Regulatory names appear only in compliance-lead views.
3. **Progress is never lost.** Autosave everywhere; conflicts resolve as keep-both; offline is a first-class state with honest indicators — the UI twin of platform principle P2.
4. **Trust through visibility.** Anything AI-assisted is labeled; anything automated appears in a human-readable activity feed (AI-8). No dark automation in the UI either.
5. **Calm enterprise, not clinical gloom.** Warm neutral surfaces, one confident accent, generous type. It should feel like a well-run agency: composed, competent, humane.

## 2. Information architecture & screen inventory (v1)

| Surface / route | Persona | Core screens (v1) |
|---|---|---|
| **`/today` (mobile-first)** | Caregiver | Today's visits · Visit detail (tasks, directions, notes) · **Clock in / Complete visit** · **Connection state (Live / Syncing / Offline)** · Voice note · My schedule · My documents/credentials · Ask CareOS (Brain, scoped) · Inbox — all per §6 |
| **`/clinical`** | RN / case manager | My clients · Client chart (summary, care plan, forms, visits, MAR) · Assessment & care-plan editor (AI draft review) · Supervisory-visit workflow · Approvals inbox (T1/T2) · Incident workflow |
| **`/office`** · **`/schedule`** | Coordinator / HR / Biller | Scheduler (week grid, open-shift fill — `/schedule`) · Intake pipeline (extraction review) · Client roster & charts · Compliance & evidence packets · Employee directory & credential wall · Onboarding tracker · Claim-readiness & export |
| **`/operations`** | Coordinator / Owner | Live visit board (active / completed / late / exceptions / missed + the day's visit table) · Exception inbox (deterministically ranked, AI-narrated) · Attendance (scheduled vs actual) · Timesheets (approve hours, close period, export) · EVV console (canonical records, submissions, reconciliation) · Workforce intelligence · Places of care (service locations + geocode attestation) |
| **`/exec`** | Founder / admin | Command dashboard (census, staffing, compliance heat, alerts) · Ask-anything analytics (NL→governed query) · Ops briefing · Settings (roles, templates, rules, **visit policy** — config-audited) |
| **`/family`** | Family | Approved updates feed · Visit calendar (scoped) · Documents (consented) · Contact/on-call |
| Shared | All | Auth/MFA/step-up · Notifications center · Profile · Help (Brain-powered) |

*(The live visit board and the exception queue moved out of `/office` into `/operations` when the verified-visit layer landed; `/office` keeps the pipelines and the people, `/operations` owns the day.)*

**The `/operations` console (Doc 17 §7.2).** Seven sub-surfaces plus the policy editor, each gated on one permission key, each carrying the full four-state doctrine of §8:

| Route | Permission | What it answers |
|---|---|---|
| `/operations` | `visit.verify.read` | What is happening on the floor right now |
| `/operations/exceptions` | `visit.verify.read` (dispose needs `visit.verify.act`) | What needs a human, in urgency order |
| `/operations/attendance` | `visit.verify.read` | Scheduled vs actual, per caregiver |
| `/operations/timesheets` | `payroll.read` (act needs `visit.approve` / `payroll.manage`) | Whose hours are approvable, what blocks the close |
| `/operations/evv` | `evv.read` | What the state record says and where each submission stands |
| `/operations/workforce` | `workforce.read` | Patterns across the workforce (and the T2 per-person draft) |
| `/operations/locations` | `location.manage` | Where care actually happens, and who attested to the pin |
| `/settings/visit-policy` | `policy.manage` | The rules the engine applies, with an inheritance preview |

Navigation: bottom tabs (mobile) / left rail (desktop), **≤7 items per persona** (raised from 5 when `/operations` was seated — the ceiling is a ceiling, not a target, and something leaves the rail when something joins it); the **first four rail items are the mobile tab bar**, so rail order is the phone layout; universal search (⌘K) scoped by RLS; every entity has a stable deep link (used by notifications).

## 3. Design system

- **Tokens (rebranded — D-012, "Apple 2026").** Type: **Instrument Serif** (display only: large titles & hero numerals) + **Instrument Sans** (all UI, 400/500/600) at a 16 px base (17 px mobile field surfaces); tabular numerals for schedules. Spacing: 4-pt grid. Radius: continuous-corner scale 6/8/12/16/22/28. Elevation: soft Apple shadows; frosted translucent chrome (sidebar/bars) via `backdrop-filter`. Color: **Apple systemGray** cool surface ramp (`#f2f2f7` grouped canvas, white panels); accent **Apple system blue `#007AFF`** (AA small-text variant `#0058b8`); semantic set — success green, warning orange, danger red, info blue — each **WCAG AA-verified** (muted tertiary darkened to clear AA on both canvas and cards); **compliance states are color + icon + label, never color alone.** *(Supersedes prior Inter / teal-700 #0F766E / warm-neutral tokens.)*
- **Dark mode:** **removed in the D-012 rebrand — light-only** (`color-scheme: light` locked). The original night-shift-caregiver rationale is preserved as an open item for founder sign-off; restorable as a first-class Apple dark theme. PHI-visibility unaffected either way.
- **Components.** shadcn/ui + Radix primitives as the accessible base, wrapped as CareOS components with locked variants: `StatusChip`, `PersonCard`, `VisitCard`, `ComplianceBadge`, `AIAssistLabel`, `SignatureBlock`, `OfflineBanner`, `ConflictResolver`, `ApprovalCard`, `EmptyState`. Storybook is the contract; visual-regression snapshots in CI (Doc 12 §4). *(Storybook and visual regression are not provisioned — Doc 12 §2. Until they are, the component contract is enforced by review and by TypeScript, and no state-coverage or visual-regression claim may be cited as evidence.)*
- **Motion (D-012):** spring-feel **CSS-only** transitions (transform/opacity), sub-300 ms for UI, with gentle page-enter/stagger; no motion library on field surfaces (JS budgets intact). `prefers-reduced-motion` and `prefers-reduced-transparency` honored (frost → solid; motion → static).
- **Voice & tone:** encouraging, specific, blame-free ("Couldn't reach the server — your note is saved on this phone and will send automatically."). Error messages always say what happened + what's saved + what to do.

## 4. The forms runtime (the make-or-break component)

JSON-Schema-driven renderer bound to `form_template.schema/ui` (Doc 07 §5):
- **Field set v1:** text, long-text (voice-dictation button inline), number, date/time, select/multi, boolean, signature, photo (EXIF-stripped), body-map annotation, med-entry row, computed/read-only.
- **Autosave:** debounced 3 s + on-blur → draft `form_version`s (kind `edit`); visible "Saved ✓ 2:41 PM" state; navigating away never loses input.
- **Validation:** inline, plain-language, on-blur + on-submit summary ("2 things need attention"); required-for-final vs required-for-save distinguished (compliance completeness ≠ typing interruption); documentation-QA suggestions (FR-AI-012) render as dismissible advisories, never blockers.
- **Conflict keep-both UX:** on `row_version` mismatch — side-by-side "Your version / Their version (Maria, 2:38 PM)" with per-field pick-or-merge; outcome saved as a new version; both antecedents preserved and linked. **There is no "overwrite" button anywhere in CareOS.**
- **Finalize & sign:** review screen renders the exact version content + hash excerpt; AAL2 step-up if stale; explicit intent copy; post-sign state is visibly locked with "Create correction" as the only edit path (reason required).
- **AI drafts (T2):** arrive as `ai_draft` versions in a review layout — AI text visually distinct until accepted per-section; accept/edit/reject per block; provenance label persists on the record ("Drafted with AI · reviewed & signed by R. Njeri, RN").

## 5. Web architecture notes

RSC-first (rosters/charts/dashboards server-rendered; zero PHI in bundles), client islands for the forms runtime, scheduler, map board, voice capture, **the clock control and the connection indicator**; Server Actions for mutations with optimistic UI + rollback toasts; Suspense skeletons everywhere (no spinner-walls); TanStack Query for client-side cache with RLS-scoped keys; map = MapLibre + self-hosted tiles or provider-with-DPA (client geocodes stored our side; no PHI in tile requests). Performance budgets (enforced in CI): LCP < 2.5 s @ 4G mid-tier Android, INP < 200 ms, route JS < 170 KB gz for field surfaces.

**The service worker is a security boundary, not a performance trick.** A worker is a programmable proxy in front of every request the app makes, and its cache is durable storage on a device that may be shared, lost or seized — so the rule is not "cache carefully", it is *cache nothing that could carry PHI, by construction*. `public/sw.js` is therefore an **allowlist**: non-GET requests are never intercepted (every Server Action, including the clock RPC, is a POST); cross-origin requests are never touched; navigations are network-**only**, because every HTML document in this app is an authenticated PHI surface; and everything else reaches the network unless its URL is on the static prefix list (content-hashed build output, the manifest, brand icons). A new route or data endpoint therefore cannot become cacheable by accident — it has to be added on purpose. The offline fallback document is **synthesised inline** in the worker rather than precached, so it cannot be poisoned by the auth middleware redirecting `/offline.html` to `/login`; it carries three sentences and zero data, in the device's language (EN/ES). There is no Background Sync handler and there will not be one: it would have to hold a session's credentials and reconstruct a PHI write outside React's knowledge, whereas replaying from the page under the caregiver's live session keeps RLS in the path. `/sw.js` and the manifest are explicitly exempt from the auth gate in `middleware.ts` — while they were not, the worker never registered and offline capture silently did not exist.

## 6. The field surface — responsive web + PWA offline (D-022)

> **Superseded by D-022 (Aug 9 2026).** This section previously specified an **Expo/React-Native app with PowerSync-managed encrypted SQLite** as the Phase-1 field tool ("local-first data: sync rules mirror `care_team_assignment`… cold start < 2 s with no network"; "Expo push"; "biometric/PIN app-lock… remote deactivation at sync"). That specification is superseded: **the responsive web app is the caregiver EVV surface**, and offline capture is a **PWA + IndexedDB queue replaying through the same Lane-B RPC**, made safe by the `client_event_id` idempotency key (Doc 17 §4.4) rather than by a sync engine. D-003 (PowerSync) is *narrowed*, not revoked — it remains the ratified answer **if** a native app is ever built — and Doc 15's ST-032 (Expo shell) and ST-033 (PowerSync read path) are withdrawn from Phase 1. Everything below that is surface-independent survived the change unaltered: the three-state offline doctrine, the ID-only notification payload rule, and the field-accessibility floor.

- **Where it runs.** `/today` is the same Next.js application every other persona uses, rendered mobile-first and installable as a PWA (`manifest.webmanifest` + `sw.js`, §5). One codebase, one auth session, one RLS perimeter — a caregiver's browser is a first-class client, not a degraded one. **Open item:** the four native-only controls this replaced (biometric app-lock, screenshot flags, root/jailbreak degradation, remote wipe) have no browser equivalent, so a **web device-posture section for Doc 09 §2** — session lifetime on shared and personal devices, PWA cache scope and purge, and what replaces remote wipe — is required before pilot and is tracked as **V19** in Doc 00 §4.

- **Two actions. Ever.** `Clock in` → `Clocked in · 9:02 AM · Visit in progress` → `Complete visit`. Everything else the control can render is a consequence of one of those two taps, and every consequence is a sentence a tired person in a stairwell can act on. There is no third button, no map, no "verify" step and no settings.

- **The four outcomes of a tap** (the control is a state machine over exactly what `app.clock_visit` returns): **accepted** — the visit advances and the card says when, in words; **needs reason** — a *soft* refusal, where the attempt is on the ledger, the visit did not move, and the caregiver is offered `Try again` and `Request exception`; **queued** — no network, so the tap is committed to this device and replays later (offline doctrine, below); **refused** — a `CAREOS_*` code already translated by the server action into plain language, rendered as-is and never as a raw database message.

- **The exception affordance never blocks care.** `Request exception` is offered exactly when the database says a reason is needed, which is the same thing as "policy allows one" — `app.clock_visit` raises `CAREOS_GEOFENCE_UNVERIFIED` (a hard refusal with no soft path) when `visit_policy.allow_location_exception` is false, and if policy changes between the refusal and the request, `app.request_location_exception` refuses with `CAREOS_EXCEPTION_NOT_ALLOWED` and the caregiver reads *that* sentence instead. The picker offers the seven `visit_event.reason_code` values as plain sentences about what happened, not as enum names ("My phone couldn't find where I am", "The address on file looks wrong", "This is an emergency visit"), plus an optional one-line note. The copy is explicit that nothing is lost and nothing is blocked: *"Nothing was lost and your visit isn't blocked. Try again, or tell us why and carry on."*

- **The vocabulary is a contract (Doc 17 §7.1, D-030).** These words appear **nowhere** a caregiver can see them — not in a label, an error, a tooltip, a placeholder or a screen-reader string:

| Never shown to a caregiver | What the surface says instead |
|---|---|
| EVV | nothing — the caregiver clocks in; the compliance object is the platform's business |
| GPS, geolocation, coordinates, latitude/longitude | "Checking location…" |
| geofence, radius, fence | "the address on file for this visit" |
| accuracy, ±m, signal strength | nothing — accuracy is diagnostic evidence for the RLS-gated admin surfaces |
| metres, distance, "312 m away" | a bucket rendered as words (below) |

- **`distance_bucket` is rendered as words, never as a number.** The RPC returns `inside | near | far` precisely so the UI can be helpful without displaying surveillance-grade precision: `near` → *"You may be at a different entrance than the one on file."*; `far` → *"This doesn't look like the address on file for this visit."*; anything else → *"We couldn't verify your location yet."* A metre value has no route to a caregiver's screen because it has no route into the client-side type (`ClockResult` carries `distanceBucket` and no `distance`).

- **Acquiring a position is patient, then decisive.** A phone's first fix is usually a cell-tower estimate hundreds of metres wide; the real fix arrives seconds later. Submitting the first one would fail legitimate caregivers standing in the right doorway and turn a hardware warm-up into an exception with somebody's name on it. So the client watches, keeps the tightest fix, stops early once accuracy is ≤ 60 m, and gives up at a hard 8-second cap — a caregiver at a door will not wait out a thinking phone, and a visit must always be clockable. **No fix at all is a lawful answer**, not an error: it becomes a location *status*. Throughout, the only thing displayed is "Checking location…".

- **One idempotency key per user-initiated attempt**, minted on tap and held across that attempt's fallback into the offline queue. A fresh tap mints a fresh key; reusing one would replay an old decision, and minting one mid-attempt would let a lost response double-clock. A replayed attempt returns "Already recorded — nothing was duplicated." rather than an error.

- **Offline doctrine: three honest states, and no fourth.** **Live** (the queue is empty *and* the browser believes it has a network) · **Syncing (n)** (naming the exact number of taps still owed to the server) · **Offline** (stated plainly, never hidden behind an optimistic spinner). The chip is always present so a caregiver learns where to look before they need it; the amber panel appears only when something is actually owed, and it offers `Send now`. A failed write surfaces for retry and is **never** silently dropped — including the case where a *queued* clock comes back refused on reconnect, which is counted, said out loud, and paired with the one instruction that helps: open the visit and clock it again, where the reason picker is waiting.

- **What may be queued, and what may never be.** The IndexedDB queue holds the visit **ID**, the event kind, the device's own position for that attempt, the device capture time, and two opaque ids. It holds **nothing that names a client** — no name, address, note, diagnosis or schedule — and **no free text a person typed**: a location-exception reason needs the rejected event to already exist server-side, so requesting an exception is an online-only action by construction, which keeps every typed field out of device storage entirely. One pending intent per (visit, event): tapping again while an attempt is held replaces the held capture rather than joining it, because a caregiver tapping twice is asking "did that take?", not asking to arrive twice. Entries are deleted on delivery. When IndexedDB is missing or blocked (private-mode Safari, hardened profiles) the module degrades to a no-op and the caregiver is told so — *"This device wouldn't hold the entry, so nothing was recorded."* — never a silent drop.

- **Voice notes:** hold-to-talk → live transcript → structured draft (T2) → caregiver confirms sections → saves as versioned note. Offline records locally and batches on reconnect. Hands-busy mode: large controls, high contrast, works with gloves. *(Doc 16 §3.1 consolidated STT on the OpenAI transcription endpoint per D-013; the Deepgram naming in Doc 11 is superseded there.)*

- **Notifications:** the built channels are `in_app`, `email` and `sms` (`public.notification`, migration 0036); the native push channel this section previously assumed went away with the Expo app and no browser push replacement is built. The rule is unchanged, because it was never about the transport: **payload = template key + deep link + entity IDs only, never PHI** ("New message about one of your clients"); full content renders post-auth in the in-app centre. Doc 17 §9 is the verified-visit notification set — management by exception, nothing sent when operations are normal.

- **Accessibility in the field:** minimum 44 px targets (clock actions are full-width with a 44 px minimum height), dynamic type to 200% without loss, screen-reader-verified flows for the caregiver core loop, and each clock outcome announced through its own polite live region so a screen-reader user hears the result of their tap without hunting for it. Live regions wrap **text only** — the reason form sits outside them, because a live region containing a select and a textarea re-announces itself as the caregiver fills it in.

## 7. Accessibility & internationalization

WCAG 2.1 AA is a release gate: automated axe scans in CI + manual audit of the caregiver loop, forms runtime, and approvals inbox each release; full keyboard operability; focus management on route change; form errors announced via live regions. i18n from day one: ICU message catalogs, `en` + `es` at launch (staff-language mix confirmed in discovery D-Q17), locale-aware dates/times (schedules always also show timezone-safe absolutes), translation keys mandatory (hard-coded strings fail lint). Client-facing family updates support per-recipient language (FR-AI-063, human-verified for care-critical content).

## 8. Empty, loading, error & degraded states (doctrine)

Every screen ships all four states by definition of done: **empty** = friendly explanation + primary action ("No visits today — view your week"); **loading** = skeletons mirroring layout; **error** = what happened + what's preserved + retry; **degraded** = AI-unavailable variants (voice→type fallback offer, Brain→"here's who to ask" routing per AI-7). Storybook stories required for each.

**The degraded state on a narrated surface is a specific contract.** On `/operations` and `/operations/workforce`, a kill switch, a budget stop, a rate limit, a missing key and a malformed completion all end in the same place: **the narration is absent, an honest human-facing note says so, and every deterministic figure still renders in full**. Narration is additive — the ranked queue, the counters, the minutes and the blockers are computed in SQL or in pure TypeScript and never depend on a model being reachable. AI is an accelerant on these screens, never a dependency (Doc 16 §6). An empty list is also probed for its cause before it is allowed to claim there is nothing to do: an AAL1 session that RLS has filtered to zero rows must not render as "no visits today".

## 9. Design QA & handoff

Figma library mirrors tokens/components 1:1 (names match code); every PRD flow has a linked prototype; design review = accessibility annotations (roles, labels, focus order) + state coverage checklist; weekly design-eng sync walks the live app against Figma — drift is a bug. Founder-facing demo builds every sprint (Doc 15 §7) double as usability tests with 2–3 real caregivers/nurses from the pilot cohort; findings feed the backlog with a standing 15% UX-polish capacity.
