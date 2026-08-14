"use server";

/**
 * Acknowledging a row in the attention queue (ST-238, Front Door W5).
 *
 * DISMISSAL IS A RECORD, NOT A DELETION. `app.ack_alert` (migration 0054) appends to an
 * append-only ledger and emits an audit event, because "who was shown this credential
 * warning, and when did they clear it" is the question that follows an incident. There is
 * no un-ack: a source whose condition re-fires produces a new source row, which arrives
 * un-acked by construction (invariant 1).
 *
 * SELF-ONLY BY CONSTRUCTION. The RPC writes for `auth.uid()` and never for a parameter,
 * so "acknowledge somebody else's queue" is not expressible — this action cannot pass a
 * user id because the function does not take one. The lane enum is closed in the database
 * too, so a typo'd caller is refused rather than inventing a seventh lane.
 *
 * INVARIANT 6: the user-scoped server client, so RLS and the active-principal check apply
 * server-side exactly as they would in the browser. `service_role` has no business here.
 *
 * PROPOSALS ARE NOT ACKNOWLEDGEABLE. The queue renders no acknowledge button on a
 * proposal row, and this action refuses the lane as well — a draft is cleared by being
 * approved or rejected, and letting somebody make one vanish without deciding it would
 * quietly defeat invariant 8. The refusal is stated in both places on purpose.
 *
 * @trace ST-238, migration 0054, invariants 1, 6, 7, 8
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";

/** The lanes this action will pass to the database, minus the one that must be decided. */
const ACKNOWLEDGEABLE = ["credential", "exception", "clinical", "notification", "offer"];

export type AckResult = {
  ok: boolean;
  /** True when the row was already acknowledged — a second tap is a no-op, not an error. */
  unchanged?: boolean;
  /** Plain language, always naming what did and did not happen. */
  message?: string;
  error?: string;
};

function codeOf(raw: string | undefined): string | null {
  return raw?.match(/CAREOS_[A-Z0-9_]+/)?.[0] ?? null;
}

function friendly(raw: string | undefined): string {
  switch (codeOf(raw)) {
    case "CAREOS_NO_TENANT_CONTEXT":
      return "Your workspace could not be resolved on this session. Nothing was acknowledged — sign in again.";
    case "CAREOS_BAD_SOURCE":
      return "That alert is not one this queue can acknowledge. Nothing was changed.";
    case "CAREOS_NOT_FOUND":
      return "That alert could not be identified. Nothing was changed — refresh and try again.";
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs a fresh verification. Nothing was acknowledged — unlock with your authenticator and try again.";
    case "CAREOS_FORBIDDEN":
      return "Your account is not allowed to acknowledge this alert. Nothing was changed.";
    default:
      return "The acknowledgement was not saved, so this row is still in your queue. Nothing else changed — try again.";
  }
}

/**
 * Acknowledge one row for the signed-in reader.
 *
 * Returns rather than throws: the queue turns every outcome into a visible state, and a
 * thrown error would replace a working queue with an error boundary over one row.
 */
export async function acknowledgeAlert(source: string, sourceId: string): Promise<AckResult> {
  const lane = source?.trim();
  const id = sourceId?.trim();

  if (!lane || !id) {
    return { ok: false, error: "That alert could not be identified. Nothing was changed." };
  }
  if (lane === "proposal") {
    return {
      ok: false,
      error:
        "A proposal is cleared by approving or rejecting it, not by acknowledging it. Nothing was changed — open the draft and decide.",
    };
  }
  if (!ACKNOWLEDGEABLE.includes(lane)) {
    return { ok: false, error: "That alert is not one this queue can acknowledge. Nothing was changed." };
  }

  const profile = await getProfile();
  if (!profile) {
    return { ok: false, error: "Your session has ended. Nothing was acknowledged — sign in again." };
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .schema("app")
    .rpc("ack_alert", { p_source: lane, p_source_id: id });

  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { ok?: boolean; unchanged?: boolean };
  const unchanged = result.unchanged === true;

  // The queue is server-rendered, so the acked row has to leave the next render too —
  // the client hides it immediately, this makes the hiding true.
  revalidatePath("/inbox");

  return {
    ok: true,
    unchanged,
    message: unchanged
      ? "Already acknowledged. Your earlier acknowledgement stays on the record — this one added nothing."
      : "Acknowledged. It is off your queue and on the record, with your name and the time.",
  };
}
