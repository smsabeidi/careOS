"use server";

/**
 * Server actions for /operations/workforce (docs/17 §7.2, §11).
 *
 * There is exactly one action here, and it is the T2 capability: drafting one caregiver's
 * operational profile for a human reviewer (D-028). Three rules hold:
 *
 *  1. **It is never automatic.** A profile is produced only when a person clicks for one.
 *     Nothing on this route runs it on load, on a schedule, or on someone else's behalf.
 *  2. **It writes no employment record.** The only row this path can create is the
 *     ai_interaction ledger entry runCapability writes for every model call — the
 *     evidence that a draft was requested, by whom, against which prompt version.
 *     D-021: the system never proposes separation, and it certainly never records one.
 *  3. **The database is the authority.** The permission is re-checked here with the same
 *     app.has_perm() the RLS policies use, and app.workforce_features refuses again in
 *     SQL if the session is not AAL2 or the permission is missing. This check is UX; the
 *     RPC's is the perimeter.
 *
 * No revalidatePath: nothing rendered by this route changes as a result of this action —
 * the draft lives only in the requesting browser until a human does something with it —
 * and revalidating would re-run the whole weekly report (another model call) to redraw
 * figures that did not move.
 */

import { supabaseServer } from "@/lib/supabase/server";
import {
  draftOperationalProfile,
  type OperationalProfileDraft,
  type WindowSpec,
} from "@/lib/ai/visit-intelligence";

export type ProfileActionResult = {
  ok: boolean;
  error?: string;
  draft?: OperationalProfileDraft;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CAREOS_* refusals → plain language (docs/10 voice), never a PHI fragment.
 * The character class includes digits: CAREOS_AAL2_REQUIRED truncates to CAREOS_AAL under
 * [A-Z_] and then matches no case at all, so the one refusal a person can actually fix
 * would render as "something went wrong".
 */
function friendly(raw: string | undefined): string {
  const code = raw?.match(/CAREOS_[A-Z0-9_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs verifying first — unlock with your authenticator and try again. Nothing was drafted.";
    case "CAREOS_FORBIDDEN":
      return "Your role does not include workforce analytics, so nothing was drafted.";
    case "CAREOS_NOT_FOUND":
      return "That team member is not available to you. Nothing was drafted.";
    case "CAREOS_POLICY_MISSING":
      return "This agency has no visit rules set yet, so lateness and overtime cannot be measured. Nothing was drafted.";
    case "CAREOS_BAD_WINDOW":
      return "That date range cannot be reported on. Pick a shorter range and try again.";
    case "CAREOS_NO_TENANT_CONTEXT":
      return "Your session has no agency attached. Sign out and back in — nothing was drafted.";
    default:
      return "The draft could not be produced. Nothing was written about this person, and the figures on screen are unchanged.";
  }
}

export async function requestOperationalProfile(input: {
  caregiverId: string;
  from: string;
  to: string;
}): Promise<ProfileActionResult> {
  if (!UUID.test(input.caregiverId ?? "") || !DATE.test(input.from ?? "") || !DATE.test(input.to ?? "")) {
    return { ok: false, error: "That request was not understood. Reload the page and try again." };
  }

  const supabase = await supabaseServer();

  // Re-guard inside the action: a Server Action is a public endpoint, and the page's
  // guard does not travel with the POST.
  const { data: allowed, error: permError } = await supabase
    .schema("app")
    .rpc("has_perm", { p: "workforce.read" });
  if (permError) return { ok: false, error: friendly(permError.message) };
  if (allowed !== true) {
    return {
      ok: false,
      error: "Your role does not include workforce analytics, so nothing was drafted.",
    };
  }

  const window: WindowSpec = { from: input.from, to: input.to };
  try {
    const draft = await draftOperationalProfile(supabase, input.caregiverId, window);
    if (draft.error) return { ok: false, error: `${draft.error.title}. ${draft.error.body}` };
    return { ok: true, draft };
  } catch {
    // draftOperationalProfile does not throw by design; this is the belt for the braces.
    return { ok: false, error: friendly(undefined) };
  }
}
