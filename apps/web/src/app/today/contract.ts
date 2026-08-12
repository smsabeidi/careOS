/* ─────────────────────────────────────────────────────────────────────────────
   Today · the clock contract, shared by the server action and the field UI
   ───────────────────────────────────────────────────────────────────────────
   This module exists for a hard Next.js rule and one design rule.

   The hard rule: a `"use server"` file may export ONLY async functions. The
   reason-code list is a value, so it cannot live in actions.ts — and it must be
   one list, because the picker the caregiver sees and the argument the RPC
   validates have to be the same seven strings. They are the visit_event
   reason_code enum (migration 0045), restated here once.

   The design rule: this is the only place where the shape of a clock outcome is
   written down. app.clock_visit returns jsonb; no generated database types
   exist; so the boundary is declared by hand, in one file, and both sides read
   it. Where this disagrees with the database, the database wins and this file
   is the thing that gets corrected.

   D-030 is visible in the shape itself: there is a `distanceBucket`, and there
   is no distance. A metre value has no route to a caregiver's screen because it
   has no route into this type.
──────────────────────────────────────────────────────────────────────────── */

export type ClockKind = "clock_in" | "clock_out";

/** public.visit_event.reason_code (0045), ordered as the picker offers them: the most
 *  common field reality first, "another reason" last. */
export const REASON_CODES = [
  "gps_unavailable",
  "alternate_location",
  "address_incorrect",
  "emergency_visit",
  "device_issue",
  "network_failure",
  "other",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Buckets, never metres (D-030 / DN-0046c). 'near' is within 3× the geofence radius. */
export type DistanceBucket = "inside" | "near" | "far";

export type ClockInput = {
  visitId: string;
  event: ClockKind;
  /** The device's own position for this attempt. Null is lawful — see DN-0046b. */
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  /** Idempotency key for THIS attempt (D-022). Replay is a return value, never an error. */
  clientEventId: string;
  /** Device clock at capture — diagnostics only; server time is authoritative (§3.6). */
  capturedAt: string | null;
  /** True only when this is the replay of a queued offline capture (§7.6). */
  offline: boolean;
  deviceSessionId: string | null;
};

export type ClockResult = {
  ok: boolean;
  /** True when the database recognised this attempt and returned its original decision. */
  replayed: boolean;
  /** The caregiver must say why before this clock can stand (§4.4 step 7, soft refusal). */
  needsReason: boolean;
  /** visit.status after the write: 'scheduled' | 'in_progress' | 'completed' | … */
  status: string | null;
  verificationStatus: string | null;
  locationStatus: string | null;
  /** Server time the event was recorded at. Formatted for display by the caller. */
  occurredAt: string | null;
  distanceBucket: DistanceBucket | null;
  /** Plain-language, translated, PHI-free. Present only when something went wrong. */
  error?: string;
  /** The CAREOS_* code, for the client's branching. An enum, never free text. */
  code?: string;
};
