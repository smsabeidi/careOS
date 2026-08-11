"use server";

/**
 * /operations server actions — the human's decision over a detected exception
 * (docs/17 §6.3, §7.2).
 *
 * There is exactly one write in this slice, and it is a thin wrapper over
 * `app.dispose_visit_exception`. Three rules hold:
 *
 *  1. **The database is the authority.** AAL2, `visit.verify.act`, the human-only
 *     assertion (`app_user.kind = 'staff'` — invariant 8: agents propose, people
 *     dispose), the disposition vocabulary and the mandatory reason are all enforced
 *     inside the RPC. This file re-states the role gate so the refusal is honest and
 *     fast, and translates `CAREOS_*` codes into plain language; it never becomes the
 *     gate itself.
 *  2. **Append-only.** A disposition is a new row on `visit_exception_disposition`.
 *     Nothing is updated, nothing is overwritten, and re-submitting the same decision
 *     comes back `unchanged: true` rather than writing a second one (the RPC's own
 *     idempotency posture) — so the UI can say "already recorded" instead of lying about
 *     a fresh write.
 *  3. **No PHI leaves.** The reason is free text a person typed; it is written to an
 *     RLS-governed PHI table and never placed in a URL, a log line, a redirect or an
 *     error message. The values returned here are ids and enums.
 *
 * Every action returns `{ ok, error? }` and never throws: a failed disposition must
 * never cost the coordinator the queue they were working.
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";

/** The vocabulary `visit_exception_disposition.disposition` accepts (docs/17 §3.8). */
export type Disposition = "acknowledged" | "resolved" | "dismissed" | "escalated" | "reopened";

const DISPOSITIONS: readonly Disposition[] = [
  "acknowledged",
  "resolved",
  "dismissed",
  "escalated",
  "reopened",
];

/** The reason is `text not null` with no length ceiling in the schema; the UI caps it so
 *  a paste accident cannot become an unbounded row. */
const MAX_REASON_CHARS = 1000;

export type DispositionResult = {
  ok: boolean;
  error?: string;
  /** The state the finding is in after this call. */
  disposition?: Disposition;
  /** True when the same decision was already on the record — nothing was written twice. */
  unchanged?: boolean;
};

/** CAREOS_* refusals → plain language (docs/10 voice). Anything else stays generic. */
function friendly(raw: string | undefined): string {
  const code = raw?.match(/CAREOS_[A-Z0-9_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs a fresh verification before you can close a finding. Unlock with your authenticator and try again — nothing was recorded.";
    case "CAREOS_FORBIDDEN":
      return "Your role can read this queue but cannot close findings. Nothing was recorded.";
    case "CAREOS_HUMAN_REQUIRED":
      return "Only a person can close a finding. Nothing was recorded.";
    case "CAREOS_BAD_DISPOSITION":
      return "That is not one of the decisions this queue accepts. Nothing was recorded.";
    case "CAREOS_REASON_REQUIRED":
      return "A reason is required — it goes on the record beside your name. Nothing was recorded.";
    case "CAREOS_NOT_FOUND":
      return "That finding is not available on your account. It may need a verified (MFA) session, or it may not be yours to see. Nothing was recorded.";
    default:
      return "The decision could not be saved. Nothing was recorded and the finding is exactly as it was. Try again.";
  }
}

/**
 * Record a disposition over one detected exception.
 *
 * The reason is validated here as well as in the RPC on purpose: the point is that the
 * person is *asked* for it in the flow, rather than meeting a raw
 * `CAREOS_REASON_REQUIRED` after they have already committed to a decision.
 */
export async function disposeVisitException(
  exceptionId: string,
  disposition: Disposition,
  reason: string
): Promise<DispositionResult> {
  const id = exceptionId?.trim();
  if (!id) return { ok: false, error: "That finding could not be identified. Nothing was recorded." };

  if (!DISPOSITIONS.includes(disposition)) {
    return { ok: false, error: "That is not one of the decisions this queue accepts. Nothing was recorded." };
  }

  const trimmed = reason?.trim().slice(0, MAX_REASON_CHARS) ?? "";
  if (!trimmed) {
    return {
      ok: false,
      error: "Add a reason before saving. It goes on the record beside your name, and a surveyor can ask to see it.",
    };
  }

  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Your session has ended. Sign in again to continue." };

  const supabase = await supabaseServer();

  // Re-guard the permission the surface was guarded on. RLS and the RPC remain the real
  // perimeter; this exists so the refusal is plain language rather than a database error.
  const { data: canAct } = await supabase.schema("app").rpc("has_perm", { p: "visit.verify.act" });
  if (canAct !== true) {
    return { ok: false, error: "Your role can read this queue but cannot close findings. Nothing was recorded." };
  }

  const { data, error } = await supabase.schema("app").rpc("dispose_visit_exception", {
    p_exception: id,
    p_disposition: disposition,
    p_reason: trimmed,
  });
  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { unchanged?: boolean; disposition?: string };

  revalidatePath("/operations/exceptions");
  revalidatePath("/operations");

  return {
    ok: true,
    disposition,
    unchanged: result.unchanged === true,
  };
}
