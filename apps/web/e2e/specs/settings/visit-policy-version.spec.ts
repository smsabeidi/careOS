/**
 * JOURNEY — saving the visit policy appends a NEW VERSION, and no control on the screen
 * ever says "edit".
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (invariant 1, docs/17 §3.4 §12, migration 0044):
 *   1. THE COPY IS PART OF THE INVARIANT. Invariant 1 ends with "including in UI copy":
 *      a screen that says "edit" or "update" teaches people the record can be changed,
 *      and then someone asks why the old value cannot simply be corrected. So the primary
 *      control reads `Save a new version`, the helper text says the version in force is
 *      kept, and — this is the assertion that does the work — NO interactive control
 *      anywhere on the surface is labelled edit / update / overwrite / replace / save
 *      changes. Prose may explain that "a policy is never edited in place"; a *button*
 *      may not offer to do it.
 *   2. SAVING GENUINELY APPENDS. The version history for the scope gains a higher version
 *      number and keeps every earlier one, with the reason and the author attached. A
 *      visit already measured against version N must still be measurable against it.
 *   3. A REASON IS MANDATORY. `Why this is changing` is `required`; the version carries it
 *      forward to whoever reads the history a year from now.
 *
 * The journey changes one integer — the late threshold — and hands it back on the way out.
 * That second save is not cleanup: it is the same append again, and leaving the policy
 * where it was found keeps a release gate from drifting the agency's rules one run at a
 * time. Both versions stay on the record, which is precisely the point.
 */

import { expect, test, type Page } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["admin" as const] };

/** Labels no BUTTON, LINK or SUBMIT on this surface may carry (invariant 1). */
const OVERWRITE_WORDS = /\b(edit|update|overwrite|replace|save changes|modify)\b/i;

/** Every version number the history section is currently showing, highest first. */
async function versionNumbers(page: Page): Promise<number[]> {
  const history = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "Every version of this scope" }) })
    .last();
  const labels = await history.getByText(/^Version \d+$/).allInnerTexts();
  return labels
    .map((text) => Number.parseInt(text.replace("Version ", ""), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
}

test.describe("Settings · visit policy", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "admin");
    await gotoVerified(page, "/settings/visit-policy");
    await expect(page.getByRole("heading", { name: "Visit policy", level: 1 })).toBeVisible();
  });

  test("offers only to save a new version — no control anywhere says edit", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Save a new version", exact: true }),
      "The primary control names what actually happens: a version is appended."
    ).toBeVisible();

    await expect(
      page.getByText("Saving creates a new version. The one in force now is kept."),
      "The promise sits beside the button that makes it."
    ).toBeVisible();

    /* ── The copy assertion, scoped to controls ──────────────────────────────── */
    // Deliberately NOT a whole-page text search. The page legitimately explains "A policy
    // is never edited in place" — banning the word outright would force that sentence out
    // and lose the explanation. What must never exist is a CONTROL offering the act.
    const controls = page.getByRole("main").getByRole("button");
    const buttonNames = await controls.allInnerTexts();
    const linkNames = await page.getByRole("main").getByRole("link").allInnerTexts();

    for (const name of [...buttonNames, ...linkNames]) {
      expect(
        name.trim(),
        `invariant 1 (including in UI copy): a control labelled "${name.trim()}" offers to ` +
          `change a ratified record in place. Policies are appended, never edited.`
      ).not.toMatch(OVERWRITE_WORDS);
    }
  });

  test("saving appends a version and keeps every earlier one", async ({ page }) => {
    const before = await versionNumbers(page);

    /* ── Change one integer ──────────────────────────────────────────────────── */
    const lateThreshold = page.getByLabel("Counts as late after");
    await expect(
      lateThreshold,
      "The lateness threshold is the field this journey moves — a whole number of minutes " +
        "with no downstream side effect beyond the rule it names."
    ).toBeVisible();

    const original = await lateThreshold.inputValue();
    const originalMinutes = Number.parseInt(original, 10);
    expect(originalMinutes, "The policy field must hold a whole number of minutes.").toBeGreaterThan(0);
    const changed = String(originalMinutes + 1);

    /* ── A reason is mandatory ───────────────────────────────────────────────── */
    const reason = page.getByLabel("Why this is changing");
    await expect(reason).toHaveAttribute("required", "");

    await lateThreshold.fill(changed);
    await reason.fill(
      "E2E release gate: proving that a policy save appends a version rather than editing one."
    );
    await page.getByRole("button", { name: "Save a new version", exact: true }).click();

    const outcome = page.getByRole("status");
    await expect(outcome).toBeVisible();

    /* ── A new version exists, and the old ones are all still there ──────────── */
    await expect
      .poll(async () => (await versionNumbers(page))[0] ?? 0, {
        message:
          "invariant 1: saving must append the next version. If the highest version number " +
          "did not rise, the policy was written in place.",
      })
      .toBeGreaterThan(before[0] ?? 0);

    const after = await versionNumbers(page);
    for (const version of before) {
      expect(
        after,
        `Version ${version} disappeared from the history. A version already governing a ` +
          `measured visit must stay readable forever.`
      ).toContain(version);
    }

    await expect(
      page.getByText(
        "E2E release gate: proving that a policy save appends a version rather than editing one."
      ),
      "The reason travels onto the new version and is shown to whoever reads the history."
    ).toBeVisible();

    /* ── Hand the agency's rules back, by appending again ────────────────────── */
    await page.getByLabel("Counts as late after").fill(original);
    await page
      .getByLabel("Why this is changing")
      .fill("E2E release gate: restoring the threshold. Both versions stay on the record.");
    await page.getByRole("button", { name: "Save a new version", exact: true }).click();
    await expect(page.getByRole("status")).toBeVisible();

    await expect
      .poll(async () => (await versionNumbers(page)).length, {
        message: "Restoring is another append, so the history grows again — it never shrinks.",
      })
      .toBeGreaterThan(after.length);
  });
});
