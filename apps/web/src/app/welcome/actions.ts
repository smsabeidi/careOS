"use server";

/**
 * First-run welcome — the only two writes this surface makes (migration 0058).
 *
 * Both go through `app.record_onboarding_milestone` on the CALLER's own session, so the
 * database decides: AAL2, the milestone allowlist, the tenant, the audit row. Three rules
 * hold here and none of them are enforced by this file:
 *
 *  1. **The row is append-only and idempotent.** The RPC inserts for `auth.uid()` and does
 *     nothing on conflict, so a double tap, a replayed request and a second browser tab all
 *     converge on one row. Nothing in this file, and nothing in the copy it returns, says
 *     "update" — there is no update.
 *  2. **Onboarding may never lock somebody out.** A milestone is a convenience: it decides
 *     whether the welcome screen is offered again, never whether the product opens. So a
 *     refusal here returns a sentence and leaves the person exactly where they were, and
 *     the root redirect fails closed to their real home screen if this table is unreadable.
 *  3. **Errors are translated, not echoed.** A CAREOS_* code becomes a dictionary key
 *     resolved against the caller's own locale — a raw Postgres message never reaches a
 *     screen, and no identifier of any kind travels in an error string (invariant 5).
 *
 * These actions never throw. `completeWelcome` ends in `redirect("/")`, which is Next's
 * navigation signal rather than a failure, and it is deliberately outside every try block:
 * catching it would swallow the navigation.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getT } from "@/lib/i18n/server";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import type { OnboardingMilestone } from "@/lib/onboarding";
import { supabaseServer } from "@/lib/supabase/server";

export type ActionResult = { ok: boolean; error?: string };

/**
 * The same allowlist 0058 enforces, restated at the edge.
 *
 * A Server Action is a public endpoint, not a page child: the argument arrives over the
 * network and its TypeScript type is a compile-time fiction. The RPC would refuse an
 * unknown value anyway; refusing it here means an obviously-bogus call never becomes a
 * database round trip.
 */
const MILESTONES: ReadonlySet<string> = new Set<OnboardingMilestone>([
  "welcome_completed",
  "welcome_skipped",
  "step_language",
  "step_home_screen",
  "step_first_look",
]);

/**
 * CAREOS_* → plain language (docs/10 voice: what happened · what is kept · what to do).
 *
 * Only one refusal is worth its own sentence. A session that has dropped below a verified
 * one is ACTIONABLE — unlock and try again — so it says so. Every other refusal from this
 * RPC (an unknown milestone, a missing tenant context, a transport failure) leaves the
 * person in exactly the same place with exactly the same next step, and a taxonomy of
 * sentences that all mean "your progress wasn't stored, carry on" would be noise on the
 * calmest screen in the product.
 *
 * The digit in the class matters: `[A-Z_]` truncates CAREOS_AAL2_REQUIRED at CAREOS_AAL,
 * which matches nothing and would tell somebody "something went wrong" instead of
 * "verify". Pinned by src/lib/careos-error-codes.test.ts.
 */
function messageKeyFor(raw: string | undefined): TranslationKey {
  const code = raw?.match(/CAREOS_[A-Z0-9_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "clock.errAal2";
    default:
      return "onboarding.error.body";
  }
}

/** One insert, on the caller's own session. Shared by both exported actions. */
async function record(milestone: string): Promise<ActionResult> {
  const t = await getT();
  if (!MILESTONES.has(milestone)) return { ok: false, error: t("onboarding.error.body") };

  const supabase = await supabaseServer();
  const { error } = await supabase
    .schema("app")
    .rpc("record_onboarding_milestone", { p_milestone: milestone });

  if (error) return { ok: false, error: t(messageKeyFor(error.message)) };
  return { ok: true };
}

/**
 * Records that a checklist step was opened or followed.
 *
 * Called fire-and-forget from the island: the tick beside a row reflects what the person
 * just did, not whether we managed to store it. A failure here is deliberately quiet —
 * the row stays ticked for this session, the next visit simply shows it unticked, and the
 * flow completes either way.
 */
export async function recordMilestone(milestone: OnboardingMilestone): Promise<ActionResult> {
  return record(milestone);
}

/**
 * Ends the first run and hands the person to their home screen.
 *
 * `skipped` is recorded as its own milestone rather than as a flavour of "completed", so
 * the two are distinguishable forever: whoever reads this table later can tell "worked
 * through it" from "closed it", and neither reading requires guessing. Both stop the
 * welcome screen being offered again.
 *
 * On a refusal the person stays here with a sentence and can try again. That is the honest
 * outcome: skipping ahead while claiming the choice was stored would put a lie on a screen
 * whose whole job is to be trustworthy on somebody's first day.
 */
export async function completeWelcome(skipped: boolean): Promise<ActionResult> {
  const result = await record(skipped ? "welcome_skipped" : "welcome_completed");
  if (!result.ok) return result;

  // Drop the router cache for every segment before leaving: "/" decides where to send
  // this person by reading the milestone that was just written, and a cached answer from
  // sixty seconds ago would send them straight back here.
  revalidatePath("/", "layout");
  redirect("/");
}
