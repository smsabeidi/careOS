"use server";

/* ─────────────────────────────────────────────────────────────────────────────
   Today · the clock actions (docs/17 §4.4, §7.1, §7.6 · D-022, D-029, D-030)
   ───────────────────────────────────────────────────────────────────────────
   Two writes live here and both are one call into the database, because the
   database is the authority (invariants 2 and 6):

     · app.clock_visit — the single writer of clock events and the single mover
       of visit.status. It gates AAL2, gates assignment, resolves the policy,
       evaluates the geofence, appends the ledger row, advances the four D-024
       projections and emits the outbox event. Nothing here re-decides any of
       that; this file translates outcomes into words.
     · app.request_location_exception — the caregiver's "Request exception". It
       records the stated reason as its own `exception_requested` event and
       re-enters the clock RPC with a deterministic idempotency key, so a
       double-tap replays instead of double-clocking.

   THREE PROPERTIES THIS FILE OWNS:

   1. METRES NEVER REACH A CAREGIVER (D-030, DN-0046c). The RPC returns
      distance_bucket ('inside' | 'near' | 'far'), never a distance; this module
      passes that enum through and the UI turns it into a sentence. The words
      GPS, geofence, accuracy, radius, metres and EVV appear in no caregiver
      string in this slice (docs/17 §7.1).
   2. NOTHING THROWS. Every path returns {ok, …}. A server action that throws
      renders an unstyled error page to somebody standing at a client's door.
   3. ERRORS ARE TRANSLATED, NOT ECHOED. A CAREOS_* code becomes a
      TranslationKey and then a sentence in the caregiver's own language; a raw
      Postgres message is never surfaced, because it can name a table, a
      constraint, or a row (invariant 5).

   RE-GUARDING. The house rule is to re-guard inside the action. The real gate
   for a clock event is not a role — it is "are you the assigned caregiver on
   this visit", which only Postgres can answer and which app.clock_visit answers
   first. So this file asserts the two things it can assert without lying: that
   somebody is signed in, and that the arguments are members of the enums the
   RPC accepts. A refusal returns friendly words rather than a redirect, which
   would throw a caregiver out of their place mid-visit.
──────────────────────────────────────────────────────────────────────────── */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { getT } from "@/lib/i18n/server";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import {
  REASON_CODES,
  type ClockInput,
  type ClockKind,
  type ClockResult,
  type DistanceBucket,
  type ReasonCode,
} from "./contract";

/* ── CAREOS_* → plain language (docs/10 voice: what happened · what is kept ·
      what to do next). The key is resolved against the caller's dictionary, so
      a Spanish-speaking caregiver reads Spanish in a stairwell at 6am. ─────── */

function messageKeyFor(raw: string | undefined): TranslationKey {
  const code = raw?.match(/CAREOS_[A-Z_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "clock.errAal2";
    case "CAREOS_FORBIDDEN":
      return "clock.errNotYours";
    case "CAREOS_NOT_FOUND":
      return "clock.errNotFound";
    case "CAREOS_ALREADY_CLOCKED_IN":
      return "clock.errAlreadyIn";
    case "CAREOS_NOT_CLOCKED_IN":
      return "clock.errNotIn";
    case "CAREOS_GEOFENCE_UNVERIFIED":
      return "clock.errLocationRequired";
    case "CAREOS_EXCEPTION_NOT_ALLOWED":
      return "clock.errExceptionNotAllowed";
    case "CAREOS_BAD_EVENT":
    case "CAREOS_BAD_REASON_CODE":
      return "clock.errBadRequest";
    default:
      return "clock.errGeneric";
  }
}

function codeOf(raw: string | undefined): string | undefined {
  return raw?.match(/CAREOS_[A-Z_]+/)?.[0];
}

/** app.clock_visit's jsonb, restated. Cast at the boundary — no generated DB types exist. */
type ClockRpcRow = {
  ok: boolean;
  replayed: boolean;
  event_id: string | null;
  status: string | null;
  verification_status: string | null;
  location_status: string | null;
  occurred_at: string | null;
  needs_reason: boolean;
  distance_bucket: DistanceBucket | null;
};

function blank(): Omit<ClockResult, "ok"> {
  return {
    replayed: false,
    needsReason: false,
    status: null,
    verificationStatus: null,
    locationStatus: null,
    occurredAt: null,
    distanceBucket: null,
  };
}

function fromRpc(row: ClockRpcRow): ClockResult {
  return {
    ok: row.ok === true,
    replayed: row.replayed === true,
    needsReason: row.needs_reason === true,
    status: row.status,
    verificationStatus: row.verification_status,
    locationStatus: row.location_status,
    occurredAt: row.occurred_at,
    distanceBucket: row.distance_bucket ?? null,
  };
}

/* ── Clock in / complete visit ─────────────────────────────────────────────── */

export async function clockVisit(input: ClockInput): Promise<ClockResult> {
  const t = await getT();

  const profile = await getProfile();
  if (!profile) {
    return { ok: false, ...blank(), code: "CAREOS_UNAUTHENTICATED", error: t("clock.errSignedOut") };
  }
  if (input.event !== "clock_in" && input.event !== "clock_out") {
    return { ok: false, ...blank(), code: "CAREOS_BAD_EVENT", error: t("clock.errBadRequest") };
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.schema("app").rpc("clock_visit", {
    p_visit: input.visitId,
    p_event: input.event,
    p_lat: input.latitude,
    p_lng: input.longitude,
    p_accuracy: input.accuracyM,
    p_client_event_id: input.clientEventId,
    p_captured_at: input.capturedAt,
    p_offline: input.offline,
    p_device_session_id: input.deviceSessionId,
  });

  if (error) {
    return {
      ok: false,
      ...blank(),
      code: codeOf(error.message),
      error: t(messageKeyFor(error.message)),
    };
  }

  const result = fromRpc(data as ClockRpcRow);
  // A soft refusal moved nothing on the visit: there is nothing to revalidate, and
  // re-rendering would tear down the exception affordance the caregiver is reading.
  if (result.ok) revalidatePath("/today");
  return result;
}

/* ── Request exception — the caregiver says why, and the clock stands ───────── */

export async function requestLocationException(
  visitId: string,
  event: ClockKind,
  reasonCode: ReasonCode,
  note: string | null
): Promise<ClockResult> {
  const t = await getT();

  const profile = await getProfile();
  if (!profile) {
    return { ok: false, ...blank(), code: "CAREOS_UNAUTHENTICATED", error: t("clock.errSignedOut") };
  }
  if (event !== "clock_in" && event !== "clock_out") {
    return { ok: false, ...blank(), code: "CAREOS_BAD_EVENT", error: t("clock.errBadRequest") };
  }
  if (!(REASON_CODES as readonly string[]).includes(reasonCode)) {
    return { ok: false, ...blank(), code: "CAREOS_BAD_REASON_CODE", error: t("clock.errBadRequest") };
  }

  // The note is the caregiver's own sentence and lands in visit_event.note — an RLS-gated
  // PHI column, which is the right home for it. Trimmed and capped here so a stray paste
  // cannot become a record nobody can read; never echoed into a message, URL or log.
  const trimmed = (note ?? "").trim().slice(0, 500);

  const supabase = await supabaseServer();
  const { data, error } = await supabase.schema("app").rpc("request_location_exception", {
    p_visit: visitId,
    p_event: event,
    p_reason_code: reasonCode,
    p_note: trimmed.length ? trimmed : null,
  });

  if (error) {
    return {
      ok: false,
      ...blank(),
      code: codeOf(error.message),
      error: t(messageKeyFor(error.message)),
    };
  }

  // The RPC returns { ok, request_event_id, reason_code, clock }. `clock` is the nested
  // result of the app.clock_visit call it made on the caregiver's behalf — that inner
  // object is the one that says whether the visit actually moved.
  const wrapper = data as { ok: boolean; clock: ClockRpcRow | null } | null;
  if (!wrapper?.clock) {
    return { ok: false, ...blank(), code: "CAREOS_UNKNOWN", error: t("clock.errGeneric") };
  }

  const result = fromRpc(wrapper.clock);
  if (result.ok) revalidatePath("/today");
  return result;
}

/* ── Offline replay (§7.6) ─────────────────────────────────────────────────── */

/**
 * Refusals the DATABASE decided, and will decide identically forever. Retrying one is
 * pointless; the entry has been answered and may be forgotten. Everything NOT on this
 * list — a dropped connection, an expired session, an unrecognised failure — leaves the
 * entry queued, because the difference between "the server said no" and "the server never
 * heard us" is the difference between a recorded refusal and a lost shift.
 */
const TERMINAL_CODES = new Set([
  "CAREOS_FORBIDDEN",
  "CAREOS_NOT_FOUND",
  "CAREOS_ALREADY_CLOCKED_IN",
  "CAREOS_NOT_CLOCKED_IN",
  "CAREOS_GEOFENCE_UNVERIFIED",
  "CAREOS_BAD_EVENT",
  "CAREOS_BAD_REASON_CODE",
]);

/**
 * Deliver one queued clock capture. Same RPC, same idempotency key, `p_offline` true — so
 * the replay is flagged `capture_source='offline'` on the ledger and is never presented as
 * ordinarily verified (§7.6), and a duplicate delivery returns `replayed: true` rather than
 * a second event (D-022).
 *
 * `delivered` answers the queue's only question: may this entry be forgotten? Yes when the
 * server reached a verdict — accepted, replayed, soft-refused (`needs_reason`, which is a
 * verdict with no error attached), or terminally refused. No for anything that smells like
 * transport: a queue that drops an entry because the tunnel closed mid-flight is a payroll
 * defect wearing a network error's clothes.
 */
export async function replayQueuedClock(input: ClockInput): Promise<{
  delivered: boolean;
  result: ClockResult;
}> {
  const result = await clockVisit({ ...input, offline: true });
  const answered =
    result.error === undefined || (result.code !== undefined && TERMINAL_CODES.has(result.code));
  return { delivered: answered, result };
}
