/* ─────────────────────────────────────────────────────────────────────────────
   First-run onboarding — what a new person is asked to do, and whether to ask
   ───────────────────────────────────────────────────────────────────────────
   The ratified training doctrine is "learning by doing real work" (docs/14 §6),
   so this is a checklist of REAL actions on LIVE surfaces, not a tour. Every
   `href` below points at a screen that exists at HEAD; a step for a feature that
   is still dark would be a teaser, and docs/10 §10 forbids those.

   Progress lives in Postgres, not in the browser: a caregiver who signs in on a
   borrowed phone sees the work they already finished, and "progress is never
   lost" stays true across devices.

   THIS MODULE IS CLIENT-SAFE, and must stay that way. The checklist renders in a
   client island, so anything it imports as a VALUE travels to the browser — and
   a type-only import that becomes a value import is enough to drag `next/headers`
   into a client bundle and fail the build. Everything that needs a session lives
   in ./onboarding.server.ts; nothing here touches Supabase.

   NOTHING HERE IS PHI. A step carries a dictionary key, a route, and a shape —
   the reader's own name and role are the only personal facts on the surface.

   FAIL CLOSED, TOWARDS THE PRODUCT. `needsWelcome` answers false whenever it
   cannot prove the opposite. The failure that matters is not "somebody misses
   the welcome screen" — it is "somebody is held on a first-run screen and never
   reaches their work", and that one is never allowed to happen because a flag
   read, an RPC, or a migration was in a bad state.
──────────────────────────────────────────────────────────────────────────── */

import type { TranslationKey } from "@/lib/i18n/dictionaries";

/**
 * The database's milestone allowlist (0058, widened per-step by 0059).
 *
 * Derived from the step keys rather than listed again, because the two lists that must
 * agree are this one and the SQL CHECK — adding a third copy in between is just somewhere
 * else for them to drift apart.
 */
export type OnboardingMilestone =
  | "welcome_completed"
  | "welcome_skipped"
  | `step_${OnboardingStepKey}`;

/** Every step the checklist can return. One `step_<key>` milestone exists for each. */
export type OnboardingStepKey =
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

export type OnboardingStep = {
  key: OnboardingStepKey;
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
};

/**
 * The milestone a step records when somebody interacts with it.
 *
 * Every step has one (0059). Before that only three did, which meant an owner or a
 * coordinator could open every row on their checklist, come back, and be shown "0 of 3"
 * again — "progress is never lost" (docs/10 §1) was not true for two of the five roles.
 */
export function milestoneFor(step: OnboardingStep): OnboardingMilestone {
  return `step_${step.key}`;
}

/** The complete allowlist, in the order 0059's CHECK states it. Restated at the edges. */
export const ONBOARDING_MILESTONES: readonly OnboardingMilestone[] = [
  "welcome_completed",
  "welcome_skipped",
  "step_first_look",
  "step_language",
  "step_home_screen",
  "step_how_visits_work",
  "step_what_you_see",
  "step_who_to_contact",
  "step_clients",
  "step_intake",
  "step_compliance",
  "step_clinical_home",
  "step_reviews",
  "step_exec_overview",
  "step_evidence",
];

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
  },
];

const CAREGIVER_STEPS: OnboardingStep[] = [
  {
    key: "first_look",
    titleKey: "onboarding.step.first_look.title",
    bodyKey: "onboarding.step.first_look.body",
    href: "/today",
    kind: "link",
  },
  {
    key: "language",
    titleKey: "onboarding.step.language.title",
    bodyKey: "onboarding.step.language.body",
    kind: "language",
  },
  {
    key: "home_screen",
    titleKey: "onboarding.step.home_screen.title",
    bodyKey: "onboarding.step.home_screen.body",
    kind: "guide",
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
  },
  {
    key: "who_to_contact",
    titleKey: "onboarding.step.who_to_contact.title",
    bodyKey: "onboarding.step.who_to_contact.body",
    kind: "guide",
  },
];

/**
 * The opening line for a set of role keys, or null when no role matches.
 *
 * Deliberately no default: there is no honest sentence to write for somebody whose
 * roles we do not recognise, and `checklistFor` returns an empty list for exactly the
 * same people, so the surface is skipped rather than fudged. Precedence is kept beside
 * `checklistFor` because the greeting and the checklist must describe one job.
 */
export function introKeyFor(roles: string[]): TranslationKey | null {
  if (roles.includes("owner") || roles.includes("admin")) return "onboarding.intro.owner";
  if (roles.includes("coordinator") || roles.includes("hr")) return "onboarding.intro.coordinator";
  if (roles.includes("rn")) return "onboarding.intro.rn";
  if (roles.includes("caregiver")) return "onboarding.intro.caregiver";
  if (roles.includes("family")) return "onboarding.intro.family";
  return null;
}

/** The first-run checklist for a set of role keys. Empty when no role matches. */
export function checklistFor(roles: string[]): OnboardingStep[] {
  if (roles.includes("owner") || roles.includes("admin")) return OWNER_STEPS;
  if (roles.includes("coordinator") || roles.includes("hr")) return COORDINATOR_STEPS;
  if (roles.includes("rn")) return RN_STEPS;
  if (roles.includes("caregiver")) return CAREGIVER_STEPS;
  if (roles.includes("family")) return FAMILY_STEPS;
  return [];
}
