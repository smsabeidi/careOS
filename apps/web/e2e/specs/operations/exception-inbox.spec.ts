/**
 * JOURNEY — the exception inbox: deterministic ranking, and a disposition that cannot
 * happen without a reason.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4 "exception review", docs/17 §7.2 §11 §12):
 *   1. THE ORDER IS ARITHMETIC, NOT JUDGEMENT. docs/17 §11 ratifies the queue order as
 *      deterministic — severity × recency × payroll impact × whether anyone has decided —
 *      with "the model only writes the *why*" (invariant 13). The rendered order is
 *      checked against that: findings are grouped by kind, groups are ordered by their
 *      most urgent member, and urgency never increases as you read down. A queue that
 *      reshuffles or that sorts by an LLM's opinion fails here.
 *   2. EVERY CARD SAYS WHY IT SITS WHERE IT DOES. `ranking.ts` writes that sentence in
 *      TypeScript; it starts "Ranked …". If a model ever starts writing the ordering
 *      rationale, this assertion is what notices.
 *   3. A DECISION CANNOT BE TAKEN WITHOUT A REASON. `app.dispose_visit_exception` refuses
 *      a blank one with CAREOS_REASON_REQUIRED — but a coordinator should never meet that
 *      refusal, so the control is unreachable until there are words in the field.
 *      Whitespace does not count as words, which is asserted explicitly because "  " is
 *      exactly what a trim-less implementation would let through.
 *   4. THE DECISION IS APPENDED, NOT APPLIED (invariant 1). The confirmation says the
 *      finding itself is unchanged — the copy carries the append-only promise, and if
 *      someone reworded it to "updated" this test fails.
 */

import { expect, test, type Locator } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["coordinator" as const] };

/** ./ranking.ts BAND_LABEL, most urgent first. Order here is the assertion. */
const BANDS = ["Needs attention now", "Today", "When you can"] as const;

function bandRank(text: string): number {
  const index = BANDS.findIndex((band) => text.includes(band));
  return index === -1 ? BANDS.length : index;
}

/** The urgency band of every card in one kind-group, in the order it renders. */
async function bandsIn(group: Locator): Promise<number[]> {
  const cards = group.locator("article.card");
  const count = await cards.count();
  const bands: number[] = [];
  for (let i = 0; i < count; i += 1) {
    bands.push(bandRank(await cards.nth(i).innerText()));
  }
  return bands;
}

test.describe("Operations · exception inbox", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "coordinator");
    await gotoVerified(page, "/operations/exceptions");
    await expect(page.getByRole("heading", { name: "Findings", level: 1 })).toBeVisible();
    /* ./loading.tsx mirrors the real layout down to the <h1>, which is the point of a
     * layout-mirroring skeleton — and the reason the heading above is NOT proof the queue
     * arrived. Wait on the skeleton's own `aria-busy` region instead; until it is gone,
     * every finding is still parked in React's streaming buffer and a reader sees nothing. */
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  });

  test("ranks the queue deterministically and explains every position", async ({ page }) => {
    const groups = page.getByRole("main").locator("section").filter({ has: page.locator("article.card") });
    const groupCount = await groups.count();
    test.skip(
      groupCount === 0,
      "The seeded tenant has no open findings, so there is no order to check. Seed a " +
        "visit with a missing clock-out and a location exception, then re-run."
    );

    /* ── Within a group: urgency never increases as you read down ────────────── */
    const leadBands: number[] = [];
    for (let g = 0; g < groupCount; g += 1) {
      const bands = await bandsIn(groups.nth(g));
      expect(bands.length, "A rendered group must contain at least one finding.").toBeGreaterThan(0);
      const sorted = [...bands].sort((a, b) => a - b);
      expect(
        bands,
        "docs/17 §11: the queue order is arithmetic. Within a kind-group, a finding that " +
          "needs attention now must never render below one that can wait."
      ).toEqual(sorted);
      leadBands.push(bands[0]);
    }

    /* ── Across groups: ordered by their most urgent member ──────────────────── */
    const sortedLeads = [...leadBands].sort((a, b) => a - b);
    expect(
      leadBands,
      "Groups are ordered by their most urgent member, so the lead card's band must never " +
        "become more urgent further down the page."
    ).toEqual(sortedLeads);

    /* ── Every card carries the deterministic explanation ────────────────────── */
    const cards = page.locator("article.card");
    const cardCount = await cards.count();
    for (let i = 0; i < cardCount; i += 1) {
      await expect(
        cards.nth(i).getByText(/Ranked (critical|a warning|informational),/),
        "Each finding states why it sits where it does, and that sentence is written by " +
          "ranking.ts — never by a model (invariant 13)."
      ).toBeVisible();
    }
  });

  test("refuses to close a finding without a reason, then records the decision beside it", async ({
    page,
  }) => {
    const cards = page.locator("article.card");
    await expect(
      cards.filter({ has: page.getByRole("button", { name: "Resolve", exact: true }) }).first(),
      "No open finding is available to this coordinator. Either the queue is clear or the " +
        "persona lacks visit.verify.act — both make this journey unprovable, so seed one."
    ).toBeVisible();

    /* Pin the card by position before touching it. A locator that FILTERS on the Resolve
     * button cannot be used past the click: choosing a decision replaces that button with
     * the reason form, so the filter stops matching this card and `.first()` silently
     * slides onto the next one — every later assertion would then be made about a finding
     * nobody opened. Position is stable for as long as the card is on screen. */
    const total = await cards.count();
    let index = -1;
    for (let i = 0; i < total; i += 1) {
      if (await cards.nth(i).getByRole("button", { name: "Resolve", exact: true }).count()) {
        index = i;
        break;
      }
    }
    expect(index, "The first finding offering a decision must be findable.").toBeGreaterThanOrEqual(0);
    const card = cards.nth(index);

    /* ── 1. Choosing a decision opens the reason first ───────────────────────── */
    await card.getByRole("button", { name: "Resolve", exact: true }).click();

    await expect(card.getByText("Resolve this finding")).toBeVisible();
    await expect(
      card.getByText("Settled. The reason is the account of how it was settled."),
      "The screen says what the decision means before it is taken."
    ).toBeVisible();

    const save = card.getByRole("button", { name: /Save\s*·\s*Resolve/ });
    const reason = card.getByLabel("What was actually done about it");

    /* ── 2. The reason is mandatory, and whitespace is not a reason ──────────── */
    await expect(
      save,
      "CAREOS_REASON_REQUIRED is the database's refusal; a person must never meet it."
    ).toBeDisabled();
    await expect(card.getByText("A reason is required — it goes on the record.")).toBeVisible();

    await reason.fill("   ");
    await expect(
      save,
      "Whitespace is not a reason. `reason.trim()` guards the control for exactly this case."
    ).toBeDisabled();

    /* ── 3. A real reason, in the words a surveyor reads a year from now ─────── */
    await reason.fill(
      "Called the caregiver: the clock-out was taken in the lift and did not send. Time confirmed against the family's own note."
    );
    await expect(save).toBeEnabled();
    await save.click();

    /* ── 4. Appended, not applied ────────────────────────────────────────────── */
    const outcome = card.getByRole("status");
    await expect(outcome).toBeVisible();
    await expect(
      outcome,
      "invariant 1: a decision adds a row. The confirmation must say the finding itself is " +
        "unchanged — never that it was updated."
    ).toContainText("the finding itself is unchanged");
    await expect(outcome).toContainText("on the record beside your name");
  });
});
