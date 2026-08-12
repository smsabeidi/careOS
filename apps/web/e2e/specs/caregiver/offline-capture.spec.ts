/**
 * JOURNEY — offline capture → honest queued indicator → replay on reconnect, with no
 * double clock-in.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real component source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4 "airplane-mode suite", docs/17 §7.6, D-022, invariant 11):
 *   1. A caregiver in a basement can still start a visit. The tap is a LOCAL commit to
 *      IndexedDB, not a network call that fails — `Saved on this device`.
 *   2. The queued state is honest and specific. `Offline` names itself, and the panel
 *      names the number of taps it is holding rather than implying one.
 *   3. TAPPING AGAIN DOES NOT QUEUE A SECOND ARRIVAL. `enqueueClock` keeps one pending
 *      intent per (visit, event) — a caregiver who taps twice is asking "did that take?",
 *      not asking to arrive twice. The count in the panel is the visible proof, and it is
 *      the whole point of this spec: this is the failure mode that turns into a duplicate
 *      shift on somebody's paycheque.
 *   4. On reconnect the queue drains through the same RPC, the day catches up, and the
 *      indicator returns to `Live` — three states, no fourth, none of them lying.
 *
 * WHAT THIS DOES NOT PROVE: that the ledger holds exactly one clock-in event. Idempotency
 * is 0046's `client_event_id` uniqueness and its pgTAP replay assertion. What a browser
 * can prove is that the caregiver was never invited to create the duplicate — and that
 * after the drain they are looking at one arrival, not two.
 */

import { expect, test } from "@playwright/test";
import { IN_FENCE, skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";
import { TodayPage } from "../../support/today-page";

const REQUIREMENT = { personas: ["caregiver" as const], geo: true };

test.describe("Caregiver · offline capture and replay", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page, context }) => {
    await context.setGeolocation(IN_FENCE ?? { latitude: 0, longitude: 0, accuracy: 12 });
    await signIn(page, "caregiver");
    await gotoVerified(page, "/today");
  });

  test("holds the tap on the device, holds only one, and replays it on reconnect", async ({
    page,
    context,
  }) => {
    const today = new TodayPage(page);
    await today.open();

    const card = await today.firstClockableCard();
    await expect(
      card,
      "The seeded caregiver has no visit today still waiting to be clocked in."
    ).toBeVisible();

    /* ── 1. The signal dies ─────────────────────────────────────────────────── */
    await context.setOffline(true);
    // `useConnection` listens for the browser's own `offline` event; Playwright's
    // setOffline fires it. The chip is the caregiver's only warning, so it is asserted
    // before anything is recorded against it.
    await expect(today.connectionChip).toHaveText("Offline");
    await expect(page.getByText("You're offline")).toBeVisible();

    /* ── 2. The tap lands anyway ────────────────────────────────────────────── */
    const clockIn = card.getByRole("button", { name: "Clock in", exact: true });
    await clockIn.click();

    await expect(
      card.getByRole("status").filter({ hasText: "Saved on this device" }),
      "An offline tap must be committed locally and said out loud — never silently dropped."
    ).toBeVisible();
    await expect(
      card.getByText(/This sends by itself as soon as you have a signal/),
      "The queued message must tell the caregiver there is nothing else for them to do."
    ).toBeVisible();

    await expect(
      page.getByText("1 held on this device. They send by themselves as soon as you have a signal."),
      "The offline panel names the exact number of taps it is holding."
    ).toBeVisible();

    /* ── 3. The second tap — the duplicate that must not happen ──────────────── */
    // The control is deliberately still enabled while an attempt is held: a caregiver who
    // taps again is asking whether the first one took. The queue must answer by REPLACING
    // the held capture, not by adding a second one.
    await expect(
      clockIn,
      "docs/17 §7.6: a held attempt leaves the control tappable, because 'did that take?' " +
        "is a question a caregiver is entitled to ask."
    ).toBeEnabled();
    await clockIn.click();
    await expect(card.getByRole("status").filter({ hasText: "Saved on this device" })).toBeVisible();

    await expect(
      page.getByText("1 held on this device. They send by themselves as soon as you have a signal."),
      "Two taps, one pending arrival. A second queued entry here is a duplicate shift on a paycheque."
    ).toBeVisible();
    await expect(
      page.getByText(/^2 held on this device/),
      "The queue must never hold two pending clock-ins for the same visit."
    ).toHaveCount(0);

    /* ── 4. The signal comes back ───────────────────────────────────────────── */
    await context.setOffline(false);
    // `useConnection` flushes on the browser's `online` event, on visibility, on mount and
    // on a 20 s poll. The `online` event is the fast path; the generous expect timeout is
    // the honest allowance for the mobile browsers whose event is a rumour.
    await expect(today.connectionChip).toHaveText("Live", { timeout: 60_000 });

    /* ── 5. The day catches up, exactly once ────────────────────────────────── */
    // The replay owner calls `router.refresh()` after a drain that changed something.
    await expect(card.getByText("In progress")).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole("button", { name: "Complete visit", exact: true })).toBeVisible();
    await expect(
      card.getByText(/^Clocked in · /),
      "One arrival line, from the server's own reading of the ledger."
    ).toHaveCount(1);

    await expect(
      page.getByText(/came back needing your attention/),
      "A clean in-fence replay must not report anything as needing attention."
    ).toHaveCount(0);

    await today.expectFieldVocabulary();
  });
});
