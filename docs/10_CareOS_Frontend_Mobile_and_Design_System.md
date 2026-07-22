# CareOS — Frontend, Mobile & Design System Specification

**Client:** American Care Team (Maryland) · **Document:** 10 of 15 · **Version:** 1.0 (Draft) · **Prepared by:** OCTSERVICES LLC
**Implements:** Doc 01 personas & P4 ("built for non-technical hands") · Doc 06 §4 · Doc 08 (lanes) · Doc 05 experience surfaces.

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
| **`/today` (mobile-first)** | Caregiver | Today's visits · Visit detail (tasks, directions, notes) · Clock in/out · Voice note · My schedule · My documents/credentials · Ask CareOS (Brain, scoped) · Inbox |
| **`/clinical`** | RN / case manager | My clients · Client chart (summary, care plan, forms, visits, MAR) · Assessment & care-plan editor (AI draft review) · Supervisory-visit workflow · Approvals inbox (T1/T2) · Incident workflow |
| **`/office`** | Coordinator / HR / Biller | Live visit board (map + statuses) · Scheduler (week grid, open-shift fill) · Exceptions queue (EVV/no-shows) · Intake pipeline (extraction review) · Employee directory & credential wall · Onboarding tracker · Claim-readiness & export |
| **`/exec`** | Founder / admin | Command dashboard (census, staffing, compliance heat, alerts) · Ask-anything analytics (NL→governed query) · Ops briefing · Settings (roles, templates, rules — config-audited) |
| **`/family`** | Family | Approved updates feed · Visit calendar (scoped) · Documents (consented) · Contact/on-call |
| Shared | All | Auth/MFA/step-up · Notifications center · Profile · Help (Brain-powered) |

Navigation: bottom tabs (mobile) / left rail (desktop), ≤5 items per persona; universal search (⌘K) scoped by RLS; every entity has a stable deep link (used by notifications).

## 3. Design system

- **Tokens.** Type: Inter (UI) at a 1.25 modular scale, 16 px base (17 px mobile field surfaces); tabular numerals for schedules. Spacing: 4-pt grid. Radius: 8/12. Elevation: 2 shadow levels max. Color: warm neutral surface ramp; accent **teal-700 #0F766E** (trustworthy, not hospital-cold); semantic set — success green, warning amber, danger red, info blue — each with AA-verified pairs; **compliance states are color + icon + label, never color alone.**
- **Dark mode:** supported from day one (night-shift caregivers); PHI-visibility unaffected.
- **Components.** shadcn/ui + Radix primitives as the accessible base, wrapped as CareOS components with locked variants: `StatusChip`, `PersonCard`, `VisitCard`, `ComplianceBadge`, `AIAssistLabel`, `SignatureBlock`, `OfflineBanner`, `ConflictResolver`, `ApprovalCard`, `EmptyState`. Storybook is the contract; visual-regression snapshots in CI (Doc 12 §4).
- **Motion:** 150–200 ms ease-out micro-transitions only; `prefers-reduced-motion` honored.
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

RSC-first (rosters/charts/dashboards server-rendered; zero PHI in bundles), client islands for the forms runtime, scheduler, map board, voice capture; Server Actions for mutations with optimistic UI + rollback toasts; Suspense skeletons everywhere (no spinner-walls); TanStack Query for client-side cache with RLS-scoped keys; map = MapLibre + self-hosted tiles or provider-with-DPA (client geocodes stored our side; no PHI in tile requests). Performance budgets (enforced in CI): LCP < 2.5 s @ 4G mid-tier Android, INP < 200 ms, route JS < 170 KB gz for field surfaces.

## 6. Mobile app (Expo RN + PowerSync) — the offline-first field tool

- **Local-first data:** PowerSync-managed encrypted SQLite; sync rules mirror `care_team_assignment` (a device holds only its user's world: their shifts ±14 d, their clients' charts-lite, templates, their credentials/inbox). Cold start < 2 s to Today screen **with no network**.
- **EVV capture flow:** geofenced clock-in card activates near/at window → single tap → GPS sampled (best-of-N over 5 s, accuracy shown) → instant local confirm ("Clocked in 2:01 PM — will sync") → `client_event_id` idempotency; out-of-fence → non-blocking reason prompt → exception flag. Clock-out mirrors + task checklist confirmation. Telephony IVR fallback documented for no-smartphone edge cases.
- **Offline doctrine:** three honest states — Live / Syncing / Offline (persistent amber banner with queued-count "3 updates will send automatically"). Writes queue with per-item status; failures surface retry, never silent drop. Airplane-mode E2E suite is a release gate (Doc 12 §4).
- **Voice notes:** hold-to-talk → live transcript (Deepgram streaming; offline = record locally, batch later) → structured draft (T2) → caregiver confirms sections → saves as versioned note. Hands-busy mode: large controls, high contrast, works with gloves.
- **Notifications:** Expo push; **payload = title + deep link + entity IDs only, never PHI** ("New message about one of your clients"); notification center in-app renders full content post-auth.
- **Security posture:** biometric/PIN app-lock, screenshot-discouraged flag on PHI screens, root/jailbreak degradation, remote deactivation at sync (Doc 09 §2).
- **Accessibility in the field:** minimum 48 dp targets (56 dp for clock actions), dynamic-type to 200% without loss, TalkBack/VoiceOver-verified flows for the caregiver core loop, high-contrast mode toggle.

## 7. Accessibility & internationalization

WCAG 2.1 AA is a release gate: automated axe scans in CI + manual audit of the caregiver loop, forms runtime, and approvals inbox each release; full keyboard operability; focus management on route change; form errors announced via live regions. i18n from day one: ICU message catalogs, `en` + `es` at launch (staff-language mix confirmed in discovery D-Q17), locale-aware dates/times (schedules always also show timezone-safe absolutes), translation keys mandatory (hard-coded strings fail lint). Client-facing family updates support per-recipient language (FR-AI-063, human-verified for care-critical content).

## 8. Empty, loading, error & degraded states (doctrine)

Every screen ships all four states by definition of done: **empty** = friendly explanation + primary action ("No visits today — view your week"); **loading** = skeletons mirroring layout; **error** = what happened + what's preserved + retry; **degraded** = AI-unavailable variants (voice→type fallback offer, Brain→"here's who to ask" routing per AI-7). Storybook stories required for each.

## 9. Design QA & handoff

Figma library mirrors tokens/components 1:1 (names match code); every PRD flow has a linked prototype; design review = accessibility annotations (roles, labels, focus order) + state coverage checklist; weekly design-eng sync walks the live app against Figma — drift is a bug. Founder-facing demo builds every sprint (Doc 15 §7) double as usability tests with 2–3 real caregivers/nurses from the pilot cohort; findings feed the backlog with a standing 15% UX-polish capacity.
