---
name: careos-mobile-offline
description: The field-app law. Use for ALL mobile work — the Expo/React Native app, PowerSync sync rules or schema, offline behavior, the EVV clock-in/out flow, GPS/geofence capture, voice notes, push notifications, device security, or mobile testing. Fires whenever offline-first correctness, sync scope, or anything a caregiver touches on a phone is involved — including backend changes to tables the mobile app syncs.
---

# CareOS Mobile & Offline Playbook

Deep spec: `docs/10 §6`, sync plane `docs/08 §6.8`, device posture `docs/09 §2`. Prime directive: **care delivery never blocks on our uptime — the app works fully offline and reconciles honestly.**

## Sync architecture rules

- **PowerSync sync rules mirror `care_team_assignment`.** A device receives only its user's world: their shifts ±14 d, assigned clients' chart-lite, templates, own credentials/inbox. Adding a table to sync = justify scope in the PR + update the sync-rule fixture matrix test (device sees exactly what the matrix says, nothing more).
- **Writes go up through PostgREST/RPCs under the user's JWT.** The sync plane can never widen access; if a write needs privilege the user lacks, the design is wrong — fix the RPC/policy, don't route around RLS.
- **Schema evolution is additive** for synced tables; contractions coordinate a client-release + sync-rule sequence (see db skill + docs/13 §3). Never rename/retype a synced column in place.
- Revocation: separated users' buckets evict at next sync; the revocation drill test covers this — keep it passing.

## Offline write pattern (fixed)

Every device-originated event carries a **`client_event_id` (UUID, generated at tap time)** → local queue with per-item status (pending/sent/failed+retry) → RPC replays are idempotent on that key. UI confirms locally and instantly ("Clocked in 2:01 PM — will sync"); sync status is truthful. Never invent a "we'll assume it worked" path and never drop a queued item silently.

## The three honest states

**Live / Syncing / Offline** — persistent amber banner offline with queued count ("3 updates will send automatically"). Feature behavior per state is defined in docs/10 §6; degraded AI paths (voice → record-locally, Brain → cached policy search) come from docs/11 §10. Any new feature must state its offline behavior in the PR — "requires connectivity" is acceptable only with an explicit, kind UI state.

## EVV capture flow (do not improvise)

Geofenced card activates near window → single tap → GPS best-of-N over ~5 s with accuracy shown → local confirm → queue. **Out-of-fence:** non-blocking reason prompt → `exception` flag → coordinator review. Clock-out mirrors + task checklist. Time captured is device event time (`at`), server records `received_at` — never conflate. Everything lands in append-only `visit_event`.

## Push & notifications

Expo push payloads: title + deep link + IDs, **never PHI** ("New message about one of your clients"). Full content renders in-app post-auth (+AAL2 where PHI). Test payload shapes against the canary suite.

## Device security posture

Biometric/PIN app-lock · encrypted local DB (PowerSync-supported encryption — required, not optional) · screenshot-discouraged flag on PHI screens · root/jailbreak → PHI features degrade · deactivation list checked at sync. Don't cache PHI outside the encrypted store (no AsyncStorage PHI, no image-cache leaks of documents).

## Testing gates you own

The **airplane-mode Maestro suite** is a release gate: full visit offline → honest queue states → reconnect → server truth verified incl. EVV submission → conflict-during-offline resolves keep-both. Cold start < 2 s to Today with no network on mid-tier Android. If your change could affect these, run them before "done".
