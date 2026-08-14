/* ─────────────────────────────────────────────────────────────────────────────
   First-run onboarding — what a new person is asked to do, and whether to ask
   ───────────────────────────────────────────────────────────────────────────
   The ratified training doctrine is "learning by doing real work" (docs/14 §6),
   so this is a checklist of REAL actions on LIVE surfaces, not a tour. Every
   `href` below points at a screen that exists at HEAD; a step for a feature that
   is still dark would be a teaser, and docs/10 §10 forbids those.

   Progress lives in Postgres, not in the browser: a caregiver who signs in on a
   borrowed phone sees the work they already finished, and "progress is never
   lost" stays true across devices. Milestones are append-only rows recorded by
   `app.record_onboarding_milestone`; this module only ever reads them.

   NOTHING HERE IS PHI. A step carries a dictionary key, a route, and a shape —
   the reader's own name and role are the only personal facts on the surface.

   FAIL CLOSED, TOWARDS THE PRODUCT. `needsWelcome` answers false whenever it
   cannot prove the opposite. The failure that matters is not "somebody misses
   the welcome screen" — it is "somebody is held on a first-run screen and never
   reaches their work", and that one is never allowed to happen because a flag
   read, an RPC, or a migration was in a bad state.
──────────────────────────────────────────────────────────────────────────── */

import { featureEnabled } from "@/lib/flags";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { supabaseServer } from "@/lib/supabase/server";

/** The database's milestone allowlist (0058). Anything else is refused by the RPC. */
export type OnboardingMilestone =
  | "welcome_completed"
  | "welcome_skipped"
  | "step_language"
  | "step_home_screen"
  | "step_first_look";

export type OnboardingStep = {
  key:
    | "first_look"
    | "language"
    | "home_screen"
    | "how_visits_work"
    | "what_you_see"
    | "who_to_contact"
    | "clients"
    | "intake"
    | "compliance"
    | "clinical_home"
    | "reviews"
    | "exec_overview"
    | "evidence";
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** Live surfaces only — a step must never point at a feature that is still dark. */
  href?: string;
  /**
   * How the row behaves, and the only discriminant a renderer should read:
   *   link     — navigates to `href`, which is real work on a real screen
   *   language — the inline locale control (the existing setLocalePreference action)
   *   guide    — an expandable explainer that stays on /welcome
   */
  kind: "link" | "language" | "guide";
  /** Recorded when the reader interacts with the row. Absent = nothing to record. */
  milestone?: OnboardingMilestone;
};

/** The flag the whole first-run surface hangs from. Seeded disabled until PD-5. */
export const WELCOME_FLAG = "onboarding.welcome";

/* ── The checklists ──────────────────────────────────────────────────────────
 * Precedence matches `homeFor` exactly (first match wins), because the checklist
 * and the home screen must agree about who somebody is. A person holding two role
 * keys gets one checklist — the one for the surface they are about to land on.
 * ────────────────────────────────────────────────────────────────────────── */

const OWNER_STEPS: OnboardingStep[] = [
  {
    key: "exec_overview",
    titleKey: "onboarding.step.exec_overview.title",
    bodyKey: "onboarding.step.exec_overview.body",
    href: "/exec",
    kind: "link",
  },
  {
    key: "evidence",
    titleKey: "onboarding.step.evidence.title",
    bodyKey: "onboarding.step.evidence.body",
    href: "/office/evidence",
    kind: "link",
  },
  {
    key: "compliance",
    titleKey: "onboarding.step.compliance.title",
    bodyKey: "onboarding.step.compliance.body",
    href: "/office/compliance",
    kind: "link",
  },
];

const COORDINATOR_STEPS: OnboardingStep[] = [
  {
    key: "clients",
    titleKey: "onboarding.step.clients.title",
    bodyKey: "onboarding.step.clients.body",
    href: "/office/clients",
    kind: "link",
  },
  {
    key: "intake",
    titleKey: "onboarding.step.intake.title",
    bodyKey: "onboarding.step.intake.body",
    href: "/office/intake",
    kind: "link",
  },
  {
    key: "compliance",
    titleKey: "onboarding.step.compliance.title",
    bodyKey: "onboarding.step.compliance.body",
    href: "/office/compliance",
    kind: "link",
  },
];

const RN_STEPS: OnboardingStep[] = [
  {
    key: "clinical_home",
    titleKey: "onboarding.step.clinical_home.title",
    bodyKey: "onboarding.step.clinical_home.body",
    href: "/clinical",
    kind: "link",
  },
  {
    // A guide card, not a second link: /clinical is already one row above, and two rows
    // pointing at one screen is two primary actions on a screen that is allowed one.
    key: "reviews",
    titleKey: "onboarding.step.reviews.title",
    bodyKey: "onboarding.step.reviews.body",
    kind: "guide",
  },
  {
    key: "language",
    titleKey: "onboarding.step.language.title",
    bodyKey: "onboarding.step.language.body",
    kind: "language",
    milestone: "step_language",
  },
];

const CAREGIVER_STEPS: OnboardingStep[] = [
  {
    key: "first_look",
    titleKey: "onboarding.step.first_look.title",
    bodyKey: "onboarding.step.first_look.body",
    href: "/today",
    kind: "link",
    milestone: "step_first_look",
  },
  {
    key: "language",
    titleKey: "onboarding.step.language.title",
    bodyKey: "onboarding.step.language.body",
    kind: "language",
    milestone: "step_language",
  },
  {
    key: "home_screen",
    titleKey: "onboarding.step.home_screen.title",
    bodyKey: "onboarding.step.home_screen.body",
    kind: "guide",
    milestone: "step_home_screen",
  },
  {
    key: "how_visits_work",
    titleKey: "onboarding.step.how_visits_work.title",
    bodyKey: "onboarding.step.how_visits_work.body",
    kind: "guide",
  },
];

const FAMILY_STEPS: OnboardingStep[] = [
  {
    key: "what_you_see",
    titleKey: "onboarding.step.what_you_see.title",
    bodyKey: "onboarding.step.what_you_see.body",
    kind: "guide",
  },
  {
    key: "language",
    titleKey: "onboarding.step.language.title",
    bodyKey: "onboarding.step.language.body",
    kind: "language",
    milestone: "step_language",
  },
  {
    key: "who_to_contact",
    titleKey: "onboarding.step.who_to_contact.title",
    bodyKey: "onboarding.step.who_to_contact.body",
    kind: "guide",
  },
];

/** The first-run checklist for a set of role keys. Empty when no role matches. */
export function checklistFor(roles: string[]): OnboardingStep[] {
  if (roles.includes("owner") || roles.includes("admin")) return OWNER_STEPS;
  if (roles.includes("coordinator") || roles.includes("hr")) return COORDINATOR_STEPS;
  if (roles.includes("rn")) return RN_STEPS;
  if (roles.includes("caregiver")) return CAREGIVER_STEPS;
  if (roles.includes("family")) return FAMILY_STEPS;
  return [];
}

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
