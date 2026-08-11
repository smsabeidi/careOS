/**
 * JOURNEY — unverifiable location → "Try again" → "Request exception" → reason → the
 * visit proceeds anyway.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real component source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4 "out-of-fence reason flow", docs/17 §7.1 §12):
 *   1. A location the database cannot verify is a SOFT refusal. The visit does not move,
 *      nothing is lost, and the caregiver is told so — `Nothing was lost and your visit
 *      isn't blocked`. A hard block here would mean care not delivered because a phone
 *      could not see the sky.
 *   2. `Try again` is offered first, because the commonest cause is a bad first fix.
 *   3. `Request exception` opens a reason picker whose options are sentences about what
 *      happened, not enum names — a caregiver is describing their morning, not
 *      classifying an incident.
 *   4. Sending the reason lets the visit proceed, and the caregiver is told a coordinator
 *      will look at it. No accusation, no number, no metre count.
 *   5. Nowhere in the refusal does the screen say how far away it thinks the caregiver is
 *      (D-030). This is the assertion that matters most: "you are 312 m from the client's
 *      home" is surveillance-grade precision with no operational purpose, and it is
 *      exactly the sentence a well-meaning refactor would add.
 *
 * WHY `far` AND NOT `near`: the seeded anchor is a long way outside any policy tier, so
 * the outcome is unambiguous. The `near` hint ("You may be at a different entrance") is a
 * distance-bucket branch of the same state and is covered by 0046's pgTAP truth table.
 */

import { expect, test } from "@playwright/test";
import { OUT_OF_FENCE, skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";
import { TodayPage } from "../../support/today-page";

const REQUIREMENT = { personas: ["caregiver" as const], geo: true };

/** The plain-language reason the journey picks. Its enum is `address_incorrect`. */
const REASON_LABEL = "The address on file looks wrong";

test.describe("Caregiver · location that cannot be verified", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page, context }) => {
    await context.setGeolocation(OUT_OF_FENCE ?? { latitude: 0, longitude: 0, accuracy: 12 });
    await signIn(page, "caregiver");
    await gotoVerified(page, "/today");
  });

  test("refuses softly, offers a retry, then takes a reason and carries on", async ({ page }) => {
    const today = new TodayPage(page);
    await today.open();

    const card = today.firstClockableCard();
    await expect(
      card,
      "The seeded caregiver has no visit today still waiting to be clocked in."
    ).toBeVisible();

    /* ── 1. The soft refusal ────────────────────────────────────────────────── */
    await card.getByRole("button", { name: "Clock in", exact: true }).click();

    const unverified = card.getByRole("status").filter({ hasText: "We couldn't verify your location yet." });
    await expect(
      unverified,
      "An unverifiable location must announce itself politely, not fail silently."
    ).toBeVisible();

    await expect(
      card.getByText(/Try again, or tell us why and carry on\./),
      "The refusal must state that nothing was lost and the visit is not blocked."
    ).toBeVisible();

    // The visit did NOT move: a soft refusal records the attempt and leaves the status
    // alone, so the primary control is still `Clock in`.
    await expect(card.getByRole("button", { name: "Clock in", exact: true })).toBeVisible();
    await expect(card.getByText("In progress")).toHaveCount(0);

    // D-030 in the place it is most tempting to break.
    await today.expectFieldVocabulary();

    /* ── 2. Try again — the commonest fix, offered first ─────────────────────── */
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      unverified,
      "Still standing at the same wrong place: `Try again` must return the same honest state."
    ).toBeVisible();

    /* ── 3. Ask for an exception ────────────────────────────────────────────── */
    await card.getByRole("button", { name: "Request exception", exact: true }).click();

    const reason = card.getByLabel("Reason", { exact: true });
    await expect(reason).toBeVisible();

    // Send must stay unreachable until a reason exists — the RPC refuses a blank one with
    // CAREOS_REASON_REQUIRED, and a person should never meet that refusal.
    const send = card.getByRole("button", { name: "Send and carry on", exact: true });
    await expect(
      send,
      "A reason is required, so the send control is disabled until one is chosen."
    ).toBeDisabled();

    await expect(
      reason.getByRole("option", { name: REASON_LABEL }),
      "The picker's options are sentences about what happened, not enum names."
    ).toHaveCount(1);

    await reason.selectOption({ label: REASON_LABEL });
    await card.getByLabel("Anything to add (optional)").fill("Front door is round the back of the building.");

    await expect(send).toBeEnabled();
    await send.click();

    /* ── 4. The visit proceeds ──────────────────────────────────────────────── */
    // `app.request_location_exception` accepts the reason and starts the visit, flagging it
    // for review. Either sentence is a correct outcome depending on whether the policy
    // marks the visit `exception`; both mean "you may carry on, somebody will look".
    await expect(
      card.getByRole("status").filter({
        hasText: /(Visit in progress|Recorded\. Your coordinator will take a look at this one\.)/,
      }),
      "After a reason is given the caregiver must be told they may carry on."
    ).toBeVisible();

    await expect(card.getByText(/^Clocked in · /)).toBeVisible();
    await expect(card.getByRole("button", { name: "Complete visit", exact: true })).toBeVisible();

    await today.expectFieldVocabulary();
  });
});
