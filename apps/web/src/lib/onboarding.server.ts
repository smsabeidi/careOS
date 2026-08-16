/* ─────────────────────────────────────────────────────────────────────────────
   First-run onboarding — the reads that need a session
   ───────────────────────────────────────────────────────────────────────────
   Split from ./onboarding.ts so that module can stay client-safe: the checklist
   renders in a client island, and a single value imported from a module that
   reaches for `next/headers` puts server code in the browser bundle.

   Server-only. Both reads run as the CALLER (invariant 6) — the milestone RPC is
   self-scoped by construction and `feature_enabled` resolves the tenant from the
   caller's own claim, so service_role has no business in either path.
──────────────────────────────────────────────────────────────────────────── */

import { featureEnabled } from "@/lib/flags";
import { supabaseServer } from "@/lib/supabase/server";
import { checklistFor, WELCOME_FLAG } from "@/lib/onboarding";

/* ── Progress ────────────────────────────────────────────────────────────── */

/**
 * The caller's own milestones, or null when the read itself failed.
 *
 * The two callers below want opposite things from a failure — a checklist would
 * rather render unchecked than not at all, while the router would rather skip the
 * whole surface — so the distinction between "no milestones" and "could not ask"
 * is kept here and each caller collapses it its own way.
 */
async function readMilestones(): Promise<string[] | null> {
  try {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.schema("app").rpc("my_onboarding_milestones");
    if (error || !Array.isArray(data)) return null;
    return data.filter((m): m is string => typeof m === "string");
  } catch {
    return null;
  }
}

/**
 * The milestones this user has already recorded.
 *
 * A failed read answers with an empty set: the checklist then renders every row
 * unchecked, which is a screen somebody can still finish. Recording is idempotent
 * in the database, so re-doing a step that was already done costs nothing.
 */
export async function getMilestones(): Promise<Set<string>> {
  return new Set((await readMilestones()) ?? []);
}

/**
 * Should this person see /welcome before their home screen?
 *
 * True only when all of it is provable: the flag is on, the roles yield a checklist
 * worth showing, and the person has neither finished nor skipped the welcome. Every
 * other outcome — flag off, RPC gone, no matching role, unreadable progress — is
 * false, and false means the root route sends them straight to `homeFor`.
 */
export async function needsWelcome(roles: string[]): Promise<boolean> {
  try {
    if (!(await featureEnabled(WELCOME_FLAG, false))) return false;
    // No checklist for these roles means /welcome would be a blank screen. The four-state
    // doctrine says skip straight through rather than show an empty one.
    if (checklistFor(roles).length === 0) return false;
    const done = await readMilestones();
    if (done === null) return false; // could not read progress → do not hold anybody up
    return !done.includes("welcome_completed") && !done.includes("welcome_skipped");
  } catch {
    return false;
  }
}
