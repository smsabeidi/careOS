/**
 * JOURNEY — approving hours, and the two refusals that protect somebody's paycheque.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4, docs/17 §4.7 §7.2 §12, D-020, D-024, D-027):
 *
 *   1. APPROVAL IS A HUMAN DECISION THAT APPENDS. The button carries the figure the
 *      DATABASE computed (`app.compute_visit_minutes` — this screen does no arithmetic,
 *      invariant 13), and approving appends an `approved_work_segment` rather than editing
 *      the visit. The confirmation says so; if it ever said "updated", this fails.
 *
 *   2. LEAVING THE MINUTES BLANK IS NOT THE SAME AS TYPING THEM. The adjust form's minutes
 *      field starts empty on purpose: an empty field sends no number, so the database
 *      applies the agency's rounding policy and records WHICH rule it used, while a filled
 *      one is stored as a manual override. That distinction is the difference between "the
 *      system rounded" and "a person overrode", and a caregiver disputing an hour is owed
 *      it. Asserted here because a pre-filled default is the obvious "helpful" regression.
 *
 *   3. NOBODY APPROVES THEIR OWN HOURS (D-027). Refused inside the RPC and again by a
 *      CHECK constraint — but the person deserves the sentence, not a stack trace. The
 *      screen must say it plainly and say that nothing was changed.
 *
 *   4. AN UNRESOLVED CRITICAL EXCEPTION BLOCKS THE MONEY, AND SAYS WHERE TO GO. The
 *      approve control is unreachable, the reason is stated, nothing is lost, and a link
 *      leads to the finding that is holding it. A blocked screen with no exit is how
 *      payroll deadlines turn into invariant violations.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { SELF_APPROVER_NAME, skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const PAYROLL = { personas: ["payroll" as const] };
const SELF = { personas: ["selfApprover" as const], selfApproverName: true };

/**
 * ./loading.tsx mirrors the real layout down to the <h1>, which is the point of a
 * layout-mirroring skeleton — and the reason the heading is NOT proof the page arrived.
 * Until the skeleton's own `aria-busy` region is gone, every card is still parked in
 * React's streaming buffer and a reader sees placeholders.
 */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/**
 * The index of the first card carrying `control`, as a POSITION rather than a filter.
 *
 * A locator that filters on the control cannot be used past the click: pressing Approve
 * or Adjust… replaces that button, the filter stops matching this card, and `.first()`
 * silently slides onto the next one — every later assertion would then be made about a
 * visit nobody touched. Position is stable for as long as the card is on screen.
 */
async function pin(cards: Locator, control: (card: Locator) => Locator): Promise<number> {
  const total = await cards.count();
  for (let i = 0; i < total; i += 1) {
    if (await control(cards.nth(i)).count()) return i;
  }
  return -1;
}

test.describe("Operations · approving hours", () => {
  test.skip(unavailable(PAYROLL), skipReason(PAYROLL));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "payroll");
    await gotoVerified(page, "/operations/timesheets");
    await expect(page.getByRole("heading", { name: "Timesheets", level: 1 })).toBeVisible();
    await settled(page);
  });

  test("approves the measured figure and records the decision beside the name", async ({ page }) => {
    // A pending card that is NOT blocked: the block is a separate journey below, and an
    // approve button disabled for a good reason would make this one falsely red.
    const cards = page
      .locator("div.card")
      .filter({ hasNot: page.getByText("critical exception") });
    /* `Approve 2 h` — the button carries the figure only when the database HAS one, and
     * says a bare "Approve hours" when the visit was never clocked. This journey is about
     * approving the measured figure, so it must land on a visit that has one; a card
     * chosen on `/^Approve\b/` alone picks up never-clocked visits, and the RPC then
     * refuses with "no hours to approve" — a correct refusal, wrongly read as a failure. */
    const approveButton = (card: Locator) => card.getByRole("button", { name: /^Approve \d/ });
    await expect(
      cards.filter({ has: page.getByRole("button", { name: /^Approve \d/ }) }).first(),
      "No unblocked visit with a measured figure is waiting on a decision. Seed a completed " +
        "visit (clocked in AND out) inside an open period, worked by someone other than the " +
        "payroll persona."
    ).toBeVisible();

    const index = await pin(cards, approveButton);
    expect(index, "A visit awaiting an unblocked decision must be findable.").toBeGreaterThanOrEqual(0);
    const card = cards.nth(index);

    /* ── The screen never calculates anyone's time ───────────────────────────── */
    await expect(
      card.getByText("Measured", { exact: true }),
      "The card shows the database's measured figure beside the decision. Exact, because " +
        "the rounding note underneath also contains the word 'measured' and the assertion " +
        "is about the labelled figure, not the prose."
    ).toBeVisible();

    const approve = card.getByRole("button", { name: /^Approve\b/ });
    await expect(approve).toBeEnabled();
    await approve.click();

    const outcome = card.getByRole("status");
    await expect(outcome).toBeVisible();
    await expect(
      outcome,
      "invariant 1 + D-024: approving appends a decision with a name against it; it never " +
        "edits the visit."
    ).toContainText("The decision is on the record with your name against it");
  });

  test("the adjust form starts blank, so 'as measured' stays distinguishable from an override", async ({
    page,
  }) => {
    const cards = page
      .locator("div.card")
      .filter({ hasNot: page.getByText("critical exception") });
    const adjustButton = (card: Locator) => card.getByRole("button", { name: "Adjust…", exact: true });
    await expect(
      cards.filter({ has: page.getByRole("button", { name: "Adjust…", exact: true }) }).first(),
      "No unblocked visit is waiting on a decision."
    ).toBeVisible();

    const index = await pin(cards, adjustButton);
    expect(index, "A visit awaiting an unblocked decision must be findable.").toBeGreaterThanOrEqual(0);
    const card = cards.nth(index);

    await adjustButton(card).click();

    const minutes = card.getByLabel("Approved minutes — leave blank to accept the measured figure");
    await expect(minutes).toBeVisible();
    await expect(
      minutes,
      "invariant 13: a pre-filled figure resubmitted untouched would be stored as a manual " +
        "override and destroy the distinction between 'CareOS measured this' and 'a person " +
        "decided this'. The field must start empty."
    ).toHaveValue("");

    await expect(
      card.getByText(/Fill it in only to record a deliberate override/),
      "The screen explains the distinction before the person can blur it."
    ).toBeVisible();
  });

  test("an unresolved critical exception blocks the money and points at the finding", async ({
    page,
  }) => {
    const blocked = page
      .locator("div.card")
      .filter({ hasText: /critical exceptions? on this visit/ })
      .first();
    test.skip(
      (await blocked.count()) === 0,
      "No pending visit currently carries an unresolved critical exception. Seed one " +
        "(a missing clock-out on a completed visit will do) to exercise the payroll block."
    );

    await expect(
      blocked.getByText(/so the hours cannot be approved yet/),
      "The block states its reason in the caller's own words."
    ).toBeVisible();
    await expect(
      blocked.getByText("Nothing is lost — the clock record stands and the hours wait here."),
      "docs/10 voice: a refusal says what is preserved."
    ).toBeVisible();

    await expect(
      blocked.getByRole("button", { name: /^Approve\b/ }),
      "D-024: hours with an unresolved critical finding cannot be approved."
    ).toBeDisabled();

    const link = blocked.getByRole("link", { name: "Open the exception" });
    await expect(link, "A blocked screen must offer the way out of the block.").toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { name: "Findings", level: 1 })).toBeVisible();
  });
});

test.describe("Operations · nobody approves their own hours (D-027)", () => {
  test.skip(unavailable(SELF), skipReason(SELF));

  test("refuses the self-approval in plain language and changes nothing", async ({ page }) => {
    await signIn(page, "selfApprover");
    await gotoVerified(page, "/operations/timesheets");
    await expect(page.getByRole("heading", { name: "Timesheets", level: 1 })).toBeVisible();
    await settled(page);

    const ownShift = page
      .locator("div.card")
      .filter({ hasText: SELF_APPROVER_NAME ?? "" })
      /* …that nothing ELSE is holding. An unresolved critical exception disables the same
       * button for a different reason (D-024), and pressing a control that was already
       * dead would prove nothing about D-027: the refusal under test has to come back from
       * the database, so the button must be live when it is pressed. */
      .filter({ hasNot: page.getByText("critical exception") })
      .filter({ has: page.getByRole("button", { name: /^Approve\b/ }) })
      .first();
    test.skip(
      (await ownShift.count()) === 0,
      "The self-approver persona has no unblocked visit of their own awaiting a decision. " +
        "Seed one, or the D-027 refusal cannot be reached through the product."
    );

    const approve = ownShift.getByRole("button", { name: /^Approve\b/ });
    await expect(
      approve,
      "The refusal belongs to the database, not to a greyed-out control."
    ).toBeEnabled();
    await approve.click();

    const refusal = ownShift.getByRole("status");
    await expect(refusal).toBeVisible();
    await expect(
      refusal,
      "D-027: the refusal is enforced twice in the database. The screen owes the person the " +
        "sentence — who to ask, and the fact that nothing moved."
    ).toContainText("You cannot approve or reject your own hours");
    await expect(refusal).toContainText("Nothing was changed");
  });
});
