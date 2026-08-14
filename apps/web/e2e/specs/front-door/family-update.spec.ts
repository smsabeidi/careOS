/**
 * JOURNEY — the family update card is dark until it is switched on, and it refuses
 * without consent before it reads anything (ST-241, Front Door W7).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W7, invariants 5, 8, 13):
 *   1. A DARK FLAG RENDERS NOTHING. Migration 0057 seeds `front_door.family_weekly`
 *      disabled, and the client chart asks `app.feature_enabled` server-side. Off means
 *      no card, no heading, no disabled button and no hint the feature exists — a teaser
 *      for an unratified surface is the failure this test exists to catch.
 *   2. THE CONSENT REFUSAL IS DETERMINISTIC AND SPOKEN. With the flag on and a client who
 *      has no family-portal consent covering updates, pressing the button returns the
 *      sentence "No active consent on file — a draft was not generated" and says plainly
 *      that nothing was read and nothing was written. The check is SQL over migration
 *      0012's consent ledger and runs BEFORE any visit note is assembled, so this refusal
 *      is not a model declining — it is the platform never asking (invariant 13).
 *
 * WHY THE FLAG STATE ARRIVES AS AN ENVIRONMENT VARIABLE. A browser cannot read a feature
 * flag: the gate is server-side by design, and the only honest way for a spec to know
 * which side of it an environment sits on is to be told. `CAREOS_E2E_FLAG_FAMILY_WEEKLY`
 * is that answer — unset or "off" means the dark default (0057's seed), and "on" means an
 * owner has flipped it for the E2E tenant through the audited path. An environment whose
 * variable disagrees with its database fails here rather than quietly asserting nothing,
 * which is the intended pressure: the variable must describe reality.
 *
 * The coordinator persona is the reader — the role that holds care-team access to a client
 * chart and may dispose proposals in the approvals inbox.
 */

import { expect, test } from "@playwright/test";
import { skipReason, type Requirement } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT: Requirement = { personas: ["coordinator"] };

/** "on" when an owner has enabled `front_door.family_weekly` for the E2E tenant. */
const FLAG_ON = (process.env.CAREOS_E2E_FLAG_FAMILY_WEEKLY ?? "").toLowerCase() === "on";

/**
 * A seeded client with NO active `family_portal` consent covering `updates`. Supplied
 * rather than discovered: finding one from the browser would mean reading consent rows
 * through the UI, and the refusal under test must be arranged, not stumbled upon.
 */
const CLIENT_WITHOUT_CONSENT = process.env.CAREOS_E2E_NO_CONSENT_CLIENT_ID ?? null;

/** Any client chart will do for the dark-flag check; this one is optional there. */
const ANY_CLIENT = process.env.CAREOS_E2E_CLIENT_ID ?? CLIENT_WITHOUT_CONSENT;

/**
 * The house sentence for the platform half, plus this journey's own arrangement. Both
 * halves name what is missing and state that nothing was asserted — a skipped run must
 * never be mistaken for a passing one.
 */
function skipFor(extra: string[]): string {
  const platform = skipReason(REQUIREMENT);
  if (platform) {
    return extra.length ? `${platform} Also missing: ${extra.join(", ")}.` : platform;
  }
  if (extra.length === 0) return "";
  return (
    `NOT RUN — this journey could not be arranged. Missing: ${extra.join(", ")}. ` +
    `This journey asserted nothing. See apps/web/e2e/README.md.`
  );
}

const CARD_HEADING = /Family update/;
const DRAFT_BUTTON = /Draft this week's update/;

test.describe("Front Door · family update — dark by default, consent-gated when on", () => {
  test.describe("with the flag off (0057's seeded default)", () => {
    /* One modifier, one sentence, both decided at load time from the environment — so a
       skipped run always names the single reason it was skipped for. */
    const reason = FLAG_ON
      ? "NOT RUN — CAREOS_E2E_FLAG_FAMILY_WEEKLY is 'on' for this environment, so the dark " +
        "state cannot be observed here. Nothing was asserted about the flag-off rendering."
      : skipFor([
          ...(ANY_CLIENT ? [] : ["CAREOS_E2E_CLIENT_ID or CAREOS_E2E_NO_CONSENT_CLIENT_ID"]),
        ]);
    test.skip(() => reason.length > 0, reason);

    test("renders nothing at all — no card, no button, no teaser", async ({ page }) => {
      await signIn(page, "coordinator");
      await gotoVerified(page, `/office/clients/${ANY_CLIENT}`);

      // The chart itself must be on screen, or absence proves nothing: a redirect to a
      // permission home page also has no family-update card.
      await expect(
        page.getByRole("heading", { name: "Records" }),
        "The client chart must have rendered — otherwise the missing card below is a " +
          "redirect, not a dark feature."
      ).toBeVisible();

      await expect(
        page.getByRole("heading", { name: CARD_HEADING }),
        "A dark flag renders NOTHING. A visible section heading here means the surface " +
          "leaked a feature the tenant has not switched on."
      ).toHaveCount(0);

      await expect(
        page.getByRole("button", { name: DRAFT_BUTTON }),
        "Not a disabled button either: a control the reader cannot use still advertises " +
          "an unratified capability."
      ).toHaveCount(0);

      await expect(
        page.getByText(/Draft sent for approval/),
        "And no residue of the flow's copy anywhere on the page."
      ).toHaveCount(0);
    });
  });

  test.describe("with the flag on and no consent on file", () => {
    const reason = !FLAG_ON
      ? "NOT RUN — CAREOS_E2E_FLAG_FAMILY_WEEKLY is not 'on', so the card is dark here by " +
        "design and the consent refusal cannot be reached. Nothing was asserted about it."
      : skipFor([...(CLIENT_WITHOUT_CONSENT ? [] : ["CAREOS_E2E_NO_CONSENT_CLIENT_ID"])]);
    test.skip(() => reason.length > 0, reason);

    test("refuses in words before it reads a single visit note", async ({ page }) => {
      await signIn(page, "coordinator");
      await gotoVerified(page, `/office/clients/${CLIENT_WITHOUT_CONSENT}`);

      await expect(
        page.getByRole("heading", { name: CARD_HEADING }),
        "With the flag on, the card is part of the chart."
      ).toBeVisible();

      const button = page.getByRole("button", { name: DRAFT_BUTTON });
      await expect(
        button,
        "The control is a real <button> with its purpose in its accessible name — " +
          "keyboard-reachable, not a clickable div."
      ).toBeVisible();

      await button.click();

      await expect(
        page.getByText(/No active consent on file — a draft was not generated/),
        "The refusal is the deterministic pre-check speaking, in the exact words the " +
          "coordinator needs: consent is absent, so no draft exists."
      ).toBeVisible();

      await expect(
        page.getByText(/Nothing was read from this week's visits and nothing was written/),
        "And it says what did NOT happen. The pre-check runs before the period's notes " +
          "are assembled, so a refusal means no visit note ever entered a prompt " +
          "(invariant 5) — the copy has to be able to claim that truthfully."
      ).toBeVisible();

      await expect(
        page.getByText(/Draft sent for approval/),
        "A refusal must never render the success sentence: nothing went to the approvals " +
          "inbox, and saying otherwise would send a coordinator looking for a draft that " +
          "does not exist."
      ).toHaveCount(0);
    });
  });
});
