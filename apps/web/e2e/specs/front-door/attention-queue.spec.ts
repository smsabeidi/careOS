/**
 * JOURNEY — the unified attention queue and the timesheet review queue
 * (ST-238 / ST-239, Front Door W5).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W5, D-012, D-028, invariant 8):
 *   1. SIX LANES, ONE LIST, SEVERITY IN WORDS. `/inbox` grows one section merging pending
 *      proposals, the credential ladder, open visit findings, clinical flags, unread
 *      notifications and open offers. Every row carries its severity as a WORD — Critical,
 *      Warning, For information — beside the lane it came from, because a coloured dot is
 *      not a status (D-012).
 *   2. `/inbox` REMAINS THE ONLY DISPOSITION SURFACE. A proposal row has no Acknowledge
 *      button; it expands in place into the existing approve / approve-with-edits / reject
 *      board. A draft that could be swept out of a queue without being decided would be
 *      invariant 8 leaking away one dismissal at a time.
 *   3. ACKNOWLEDGING IS A RECORD, NOT A DELETE, AND THE COPY SAYS SO. The queue states
 *      plainly that an acknowledgement carries your name and the time, is never removed,
 *      and never clears the row from anybody else's queue.
 *   4. THE FLAG IS SERVER-SIDE AND ABSOLUTE. With `front_door.inbox` off the section is
 *      not there at all — no heading, no teaser, no disabled button — and this journey
 *      asserts that absence before skipping the rest with a reason that names the flag.
 *   5. THE TIMESHEET QUEUE IS A REVIEW QUEUE (ST-239). SCHED / ACTUAL / VAR / STATUS on
 *      every row, and a trust assessment that expands as EVIDENCE: components rendered
 *      "n of max", reason codes in English, under the D-028 caption. No threshold, no
 *      recommendation, no action — and approve / adjust / send back still work.
 *
 * WHY NOTHING IS ACKNOWLEDGED HERE. `app.ack_alert` writes to an append-only ledger and
 * there is no un-ack by design (0054). A journey that clicked Acknowledge would quietly
 * consume the very rows the next run needs, and would report "nothing is waiting" as a
 * pass. So the affordance, its accessible role and its copy are asserted; the write is
 * proven in pgTAP (supabase/tests/database/0054_alert_ack.sql), where it can be rolled
 * back.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const QUEUE_REQUIREMENT = { personas: ["coordinator" as const] };
const TIMESHEET_REQUIREMENT = { personas: ["payroll" as const] };

/** The three words the severity chip is allowed to say (attention-severity.ts). */
const SEVERITY_WORDS = /^(Critical|Warning|For information)$/;

/** The six lane labels, closed to match `alert_ack`'s source CHECK. */
const LANE_LABELS = [
  "Approval",
  "Credential",
  "Visit finding",
  "Clinical flag",
  "Notification",
  "Shift offer",
];

const FLAG_OFF =
  "NOT RUN — the front_door.inbox flag is off for this tenant, so the attention queue is " +
  "correctly absent. This journey asserted the absence and nothing else. Enable the flag " +
  "with app.set_feature_flag to exercise the queue.";

/**
 * Flag off means ABSENT, not hidden. Before skipping, prove there is no half-rendered
 * surface behind the gate — a teaser, a disabled control or a stray heading would mean the
 * gate is cosmetic rather than server-side.
 */
async function assertNothingLeaks(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Needs your attention" }),
    "With the flag off the section must not exist at all."
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Acknowledge" }),
    "A disabled or hidden Acknowledge button behind a closed flag is still a leak."
  ).toHaveCount(0);
}

test.describe("Front Door · /inbox — the unified attention queue", () => {
  test.skip(unavailable(QUEUE_REQUIREMENT), skipReason(QUEUE_REQUIREMENT));

  let queue: Locator;

  test.beforeEach(async ({ page }) => {
    await signIn(page, "coordinator");
    await gotoVerified(page, "/inbox");
    await expect(page.getByRole("heading", { name: "Approvals", level: 1 })).toBeVisible();

    queue = page.getByRole("region", { name: "Needs your attention" });
    if ((await queue.count()) === 0) {
      await assertNothingLeaks(page);
      test.skip(true, FLAG_OFF);
    }
  });

  test("the approvals board below the queue is untouched by the addition", async ({ page }) => {
    // The queue is additive. The surface it sits on top of — tiles, tab rail, board — has
    // to be exactly what it was, or W5 has quietly rewritten the disposition surface.
    await expect(page.getByRole("navigation", { name: "Proposal status" })).toBeVisible();
    await expect(page.locator("div.card").filter({ hasText: "Waiting for you" }).first()).toBeVisible();
  });

  test("every row carries its severity in words, its lane, and a way onward", async () => {
    await expect(queue).toBeVisible();

    const rows = queue.locator("li.card");
    const count = await rows.count();
    if (count === 0) {
      // An empty queue is a real state and it must say so honestly rather than render a
      // bare heading over nothing.
      await expect(
        queue.getByText("Nothing is waiting on you"),
        "An empty queue names itself; a heading over blank space reads as a broken page."
      ).toBeVisible();
      return;
    }

    for (let i = 0; i < Math.min(count, 10); i += 1) {
      const row = rows.nth(i);
      const chips = row.locator("span.chip");
      const severity = (await chips.nth(0).innerText()).trim();
      expect(
        SEVERITY_WORDS.test(severity),
        `Row ${i} led with "${severity}". Severity is a word — Critical, Warning or For ` +
          `information — never a colour on its own (D-012).`
      ).toBe(true);

      const lane = (await chips.nth(1).innerText()).trim();
      expect(
        LANE_LABELS,
        `Row ${i} came from lane "${lane}", which is not one of the six the queue merges. ` +
          `A seventh lane means a source is rendering without a severity rule.`
      ).toContain(lane);
    }
  });

  test("the queue is ordered by severity — every Critical sits above every Warning", async () => {
    const rows = queue.locator("li.card");
    const count = await rows.count();
    test.skip(count < 2, "NOT RUN — fewer than two rows in this tenant's queue to order.");

    const order: number[] = [];
    const rank: Record<string, number> = { Critical: 0, Warning: 1, "For information": 2 };
    for (let i = 0; i < Math.min(count, 15); i += 1) {
      order.push(rank[(await rows.nth(i).locator("span.chip").first().innerText()).trim()] ?? 99);
    }
    for (let i = 1; i < order.length; i += 1) {
      expect(
        order[i],
        "The queue is ranked by severity first. A Warning above a Critical means a " +
          "coordinator works the wrong thing first, which is the whole point of the queue."
      ).toBeGreaterThanOrEqual(order[i - 1]);
    }
  });

  test("a proposal is decided, never dismissed — it expands into the real board", async () => {
    const proposalRow = queue.locator("li.card").filter({ hasText: "Approval" }).first();
    test.skip(
      (await proposalRow.count()) === 0,
      "NOT RUN — no proposal is pending in this tenant, so there is no row to expand."
    );

    await expect(
      proposalRow.getByRole("button", { name: "Acknowledge" }),
      "A proposal row must offer no Acknowledge button. A draft leaves the queue by being " +
        "approved or rejected — anything else is a way to make an undecided draft vanish."
    ).toHaveCount(0);

    const open = proposalRow.getByRole("button", { name: "Review the draft" });
    await expect(open).toBeVisible();
    await expect(open, "The disclosure must announce its state to a screen reader.").toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");

    // The expansion is the EXISTING disposition board, not a second one: the editable
    // draft and all three equally-weighted decisions.
    await expect(
      proposalRow.getByLabel("Drafted message"),
      "The draft expands into the same editable board the page already uses — /inbox stays " +
        "the only disposition surface (W5)."
    ).toBeVisible();
    await expect(proposalRow.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(proposalRow.getByRole("button", { name: "Reject" })).toBeVisible();
  });

  test("acknowledging is offered as a record, and the copy says it is never a deletion", async () => {
    await expect(
      queue.getByText(/never deletes anything/),
      "The standing copy has to say what acknowledging does and does not do, before anyone " +
        "presses it: it records, it does not delete, and it does not clear anyone else's queue."
    ).toBeVisible();
    await expect(queue.getByText(/never clears it from anyone/)).toBeVisible();

    const ackable = queue.locator("li.card").filter({ hasNotText: "Approval" });
    const button = ackable.getByRole("button", { name: "Acknowledge" }).first();
    if ((await button.count()) > 0) {
      // A real <button>, reachable and operable by keyboard — never a clickable div.
      await expect(button).toBeEnabled();
      await button.focus();
      await expect(button).toBeFocused();
    }
    // Deliberately not clicked — see this file's header. The write is proven in pgTAP.
  });

  test("a credential row states the enforcement it is warning about", async () => {
    const credentialRow = queue.locator("li.card").filter({ hasText: "Credential" }).first();
    test.skip(
      (await credentialRow.count()) === 0,
      "NOT RUN — no credential is inside the 60-day ladder in this tenant."
    );
    await expect(
      queue.getByText("Expired credentials block scheduling — this is enforced automatically.").first(),
      "The consequence is already enforced by the platform, so the queue says it plainly " +
        "rather than leaving a coordinator to discover it when rostering fails."
    ).toBeVisible();
  });
});

test.describe("Front Door · /operations/timesheets — the review queue (ST-239)", () => {
  test.skip(unavailable(TIMESHEET_REQUIREMENT), skipReason(TIMESHEET_REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "payroll");
    await gotoVerified(page, "/operations/timesheets");
    await expect(page.getByRole("heading", { name: "Timesheets", level: 1 })).toBeVisible();
  });

  test("rows carry SCHED, ACTUAL, VAR and STATUS, and the decision controls still work", async ({
    page,
  }) => {
    const strip = page.getByRole("group", {
      name: "Booked, measured, difference, to approve and verification status",
    });
    if ((await strip.count()) === 0) {
      // Either the flag is off — in which case the old two-figure block is what renders —
      // or nothing is waiting on a decision. Say which, and assert no half-state.
      await expect(
        page.getByText("Var", { exact: true }),
        "With the flag off there must be no stray review-queue column heading."
      ).toHaveCount(0);
      test.skip(true, FLAG_OFF);
    }

    const first = strip.first();
    for (const heading of ["Sched", "Actual", "Var", "To approve", "Status"]) {
      await expect(
        first.getByText(heading, { exact: true }),
        `The review queue's ${heading} column has to be on the row itself — a reviewer ` +
          `compares booked against measured, and cannot do that across two screens.`
      ).toBeVisible();
    }

    // Every existing behaviour survives the reframing (the ST-239 acceptance criterion).
    const card = page.locator("div.card").filter({ has: strip.first() }).first();
    await expect(card.getByRole("button", { name: /^Approve/ })).toBeVisible();
    await expect(card.getByRole("button", { name: "Adjust…" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Send back" })).toBeVisible();

    // …and so do the surfaces below the queue.
    await expect(page.getByRole("heading", { name: "Pay periods" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Exports on record" })).toBeVisible();
  });

  test("the trust assessment expands as evidence, decomposed and captioned (D-028)", async ({
    page,
  }) => {
    const disclosure = page.getByText(/^Show the trust assessment/).first();
    test.skip(
      (await disclosure.count()) === 0,
      "NOT RUN — no visit in the pending queue carries a recorded trust assessment, or the " +
        "front_door.inbox flag is off."
    );

    await disclosure.click();

    await expect(
      page.getByText("Evidence for a human decision — never an automated action."),
      "D-028 is the caption on this panel, not a comment in a migration: a score about a " +
        "person that does not say what it is for becomes a verdict by default."
    ).toBeVisible();

    // The score decomposes. "n of max" is what makes it checkable rather than a character
    // assessment — a caregiver can point at the row a deduction stands on.
    await expect(page.getByText(/\d+ of 100/).first()).toBeVisible();
    await expect(
      page.getByText(/\d+ of (35|20|15|10|5)/).first(),
      "Each component renders against its trust.v1 maximum, so a reader knows whether 22 " +
        "is nearly full marks or barely half."
    ).toBeVisible();

    // Reason codes reach a human as English, never as an enum.
    const panel = page.locator("details[open] .card-inset").first();
    const text = await panel.innerText();
    expect(
      /location\.|time\.|schedule\.|identity\.|device\.|consistency\./.test(text),
      "A raw reason code on screen means the closed trust.v1 vocabulary lost its " +
        "translation — the panel must read in words a caregiver can dispute."
    ).toBe(false);

    // Evidence only: nothing on this panel acts.
    await expect(
      panel.getByRole("button"),
      "The trust panel has no controls at all. A button here is the beginning of the " +
        "automated adverse action D-028 forbids."
    ).toHaveCount(0);
  });
});
