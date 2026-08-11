/**
 * JOURNEY — in-fence clock-in → visit in progress → complete visit.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real component source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4 "Today→clock-in in-fence", docs/17 §12):
 *   1. A caregiver standing at the attested pin can start a visit with one tap, and the
 *      screen says so in words a tired person can act on — `Clocked in · 9:02 AM` and
 *      `Visit in progress`, never a status code (invariant 14).
 *   2. The card then offers exactly one next action — `Complete visit` — because docs/17
 *      §7.1 allows the caregiver two actions in the whole flow and no more.
 *   3. Completing the visit leaves it completed and the control inert, so a second tap
 *      cannot ask the ledger for something it has already recorded.
 *   4. Throughout, the screen never says EVV, GPS, geofence, accuracy, radius or a metre
 *      count (D-030, docs/17 §7.1). That assertion is the reason this journey exists at
 *      the UI layer at all: pgTAP can prove the event landed, but only a rendered page can
 *      prove what a caregiver was told about it.
 *
 * WHAT THIS DOES NOT PROVE: that `visit_event` holds exactly one clock-in row. That is
 * 0046's pgTAP idempotency assertion, and it belongs there — this spec asserts what the
 * person saw, not what the ledger holds.
 */

import { expect, test } from "@playwright/test";
import { IN_FENCE, skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";
import { TodayPage } from "../../support/today-page";

const REQUIREMENT = { personas: ["caregiver" as const], geo: true };

test.describe("Caregiver · in-fence clock-in", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page, context }) => {
    // Standing at the address on file. `app.evaluate_location` judges accuracy before
    // distance, so the fix is tight as well as close — a wide fix at the right address is
    // still `needs_reason`, and that case is the sibling spec's subject.
    await context.setGeolocation(IN_FENCE ?? { latitude: 0, longitude: 0, accuracy: 12 });
    await signIn(page, "caregiver");
    await gotoVerified(page, "/today");
  });

  test("starts the visit, shows the arrival in words, and completes it", async ({ page }) => {
    const today = new TodayPage(page);
    await today.open();

    const card = today.firstClockableCard();
    await expect(
      card,
      "The seeded caregiver has no visit today that is still waiting to be clocked in. " +
        "Re-seed the Meadowbrook day before running the clock journeys."
    ).toBeVisible();

    /* ── 1. One tap ─────────────────────────────────────────────────────────── */
    await card.getByRole("button", { name: "Clock in", exact: true }).click();

    // "Checking location…" then "Saving…" are the only things shown while the fix is
    // acquired; neither is asserted as a required frame because a fast tight fix can skip
    // straight past them, and a test that demands a spinner is testing the network.

    /* ── 2. The result, in the polite live region the screen reader reads ────── */
    await expect(
      card.getByRole("status").filter({ hasText: "Visit in progress" }),
      "After an accepted clock-in the card must say `Visit in progress` in a live region."
    ).toBeVisible();

    await expect(
      card.getByText(/^Clocked in · /),
      "The arrival must be stated as a time of day, not a duration or a coordinate."
    ).toBeVisible();

    /* ── 3. The visit is live, and the only next action is to finish it ─────── */
    // `revalidatePath('/today')` fires inside the Server Action, the card re-renders with
    // status=in_progress, and ClockButton remounts on its `key={v.status}` — so the CTA
    // becomes `Complete visit` without a manual reload.
    await expect(card.getByText("In progress")).toBeVisible();
    const complete = card.getByRole("button", { name: "Complete visit", exact: true });
    await expect(complete).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Clock in", exact: true }),
      "docs/17 §7.1: two actions, ever. A live visit must not still offer `Clock in`."
    ).toHaveCount(0);

    await today.expectFieldVocabulary();

    /* ── 4. Complete it ─────────────────────────────────────────────────────── */
    await complete.click();

    await expect(card.getByText("Completed")).toBeVisible();
    const done = card.getByRole("button", { name: "Visit completed", exact: true });
    await expect(done).toBeVisible();
    await expect(
      done,
      "A completed visit's control is inert — tapping it again would only earn a refusal."
    ).toBeDisabled();

    await today.expectFieldVocabulary();
  });
});
