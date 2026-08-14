/**
 * JOURNEY — the note coach is advisory and bound to a draft, and recording is honest
 * about needing a signal (ST-235/ST-236, Front Door W3).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real component source; not proven.
 * Two reasons, both stated rather than hidden:
 *   · `e2e/specs/front-door` has no Playwright project yet (playwright.config.ts declares
 *     caregiver-mobile, operations-desktop, settings-desktop and a11y). Until ST-244 adds
 *     one, this file is enumerated by nothing. The W8 evidence journey sits in the same
 *     position — this is a program-level gap, not a local one.
 *   · The coaching cards live inside the voice review sheet, which a headless browser
 *     cannot reach: it needs a real microphone and a live transcription call. That half
 *     therefore SKIPS at run time with the reason spelled out, rather than asserting
 *     something weaker and calling it proof.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W3, docs/10 four-state doctrine):
 *   1. RECORDING IS GATED ON A SIGNAL, AND SAYS SO. Voice notes are a round trip — audio
 *      out, draft back. Offline, the control is stopped BEFORE the microphone opens and
 *      the caregiver is given the alternative in the same sentence: type the note. A
 *      caregiver who speaks for ninety seconds into a dead connection and is then told it
 *      failed has lost the note and the trust; this is the assertion that keeps that from
 *      shipping. The typed path stays reachable in the same breath.
 *   2. THE COACH IS BOUND TO A DRAFT. Nothing coach-shaped renders on the day itself —
 *      no loose "Get coaching" button on a visit card, no teaser. It exists beside a note
 *      that exists, and only when `front_door.note_coach` is on for the agency (the flag
 *      is resolved server-side in app/today/page.tsx; off means nothing is sent at all).
 *   3. IT ADVISES; IT NEVER WRITES. Inside the coach panel the only controls are "ask
 *      again" and "dismiss". There is no apply, no insert, no rewrite — and the note's own
 *      text is byte-identical before and after a coaching round. That is the whole product
 *      claim: the words stay the caregiver's (invariant 8, and the record's integrity).
 *
 * WHAT THIS DOES NOT PROVE: that a suggestion quotes the note verbatim. That guardrail is
 * a pure function and is proven where it can be driven with adversarial input —
 * apps/web/src/app/today/coach-parse.test.ts (19 cases, runnable today).
 */

import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";
import { TodayPage } from "../../support/today-page";

const REQUIREMENT = { personas: ["caregiver" as const] };

/** The one sentence a caregiver with no signal must be given (ST-236). */
const OFFLINE_COPY = /No connection — type your note, or record when you're back online/;

test.describe("Front Door · the note coach and the voice delta", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "caregiver");
    await gotoVerified(page, "/today");
  });

  test("recording is stopped, and explained, when there is no connection", async ({
    page,
    context,
  }) => {
    const today = new TodayPage(page);
    await today.open();

    const card = today.visitCards.first();
    await expect(
      card,
      "The seeded caregiver has no visit on today's schedule at all."
    ).toBeVisible();

    const record = card.getByRole("button", { name: "Voice note" });
    await expect(
      record,
      "With a signal, the record control is offered normally — this is the baseline the " +
        "offline state is measured against."
    ).toBeEnabled();
    await expect(page.getByText(OFFLINE_COPY)).toHaveCount(0);

    /* ── The signal dies ────────────────────────────────────────────────────── */
    await context.setOffline(true);
    await expect(today.connectionChip).toHaveText("Offline");

    await expect(
      record,
      "Recording needs the round trip. The control must be stopped BEFORE the microphone " +
        "opens — not after ninety seconds of speech have already been lost."
    ).toBeDisabled();

    const explanation = card.getByText(OFFLINE_COPY);
    await expect(
      explanation,
      "A disabled control with no sentence beside it is a dead end. The copy names the " +
        "cause and the alternative in one line (docs/10 voice)."
    ).toBeVisible();

    await expect(
      card.getByRole("link", { name: "type your note" }),
      "The typed path is unaffected by this gate and must be reachable from the sentence " +
        "itself — it is what the caregiver is being asked to do instead."
    ).toBeVisible();

    /* ── The signal returns ─────────────────────────────────────────────────── */
    await context.setOffline(false);
    await expect(today.connectionChip).toHaveText("Live", { timeout: 60_000 });
    await expect(
      record,
      "Recovery is automatic. Nothing about the offline state may survive the reconnect."
    ).toBeEnabled({ timeout: 60_000 });
    await expect(card.getByText(OFFLINE_COPY)).toHaveCount(0);

    await today.expectFieldVocabulary();
  });

  test("the coach exists only beside a drafted note, and never writes into it", async ({
    page,
  }) => {
    const today = new TodayPage(page);
    await today.open();

    /* ── 1. Nothing coach-shaped sits loose on the day ──────────────────────── */
    await expect(
      page.getByRole("button", { name: /Get coaching/ }),
      "The coach is bound to a draft. A visit card with no note on it must offer no " +
        "coaching control — and when front_door.note_coach is off, the server sends none " +
        "at all, so this holds in both flag states."
    ).toHaveCount(0);

    /* ── 2. The review sheet — reachable only with a microphone ─────────────── */
    const sheet = page.getByRole("region", { name: /Review the drafted visit note/ });
    const drafted = (await sheet.count()) > 0;
    test.skip(
      !drafted,
      "NOT RUN — reaching the coach needs a drafted note, which needs a real microphone " +
        "and a live transcription call. This half asserted nothing. Drive it with a " +
        "fake-media browser and a seeded draft, or prove the guardrail directly in " +
        "src/app/today/coach-parse.test.ts."
    );

    const noteField = sheet.getByRole("textbox").first();
    const before = await noteField.inputValue();

    await sheet.getByRole("button", { name: "Get coaching" }).click();

    /* ── 3. Exactly one of the four states, in words ────────────────────────── */
    const coach = sheet.getByRole("region", { name: "Note coaching" });
    await expect(coach).toBeVisible();
    const states = [
      coach.getByText("This note reads well — specific and connected to the goals."),
      coach.getByText("Coaching is unavailable right now — your note is unaffected."),
      coach.getByText("There's nothing to coach yet — write a few lines first."),
      coach.locator("article"),
    ];
    const rendered = await Promise.all(states.map((s) => s.count()));
    expect(
      rendered.filter((n) => n > 0).length,
      "One state, always: suggestions, 'this reads well', 'nothing to coach yet', or " +
        "'unavailable — your note is unaffected'. Silence after a press is the coach " +
        "failing without saying so."
    ).toBe(1);

    /* ── 4. Advisory by construction ────────────────────────────────────────── */
    for (const forbidden of [/apply/i, /insert/i, /rewrite/i, /use this/i, /fix/i]) {
      await expect(
        coach.getByRole("button", { name: forbidden }),
        "No control anywhere may write a suggestion into the note. The words are the " +
          "caregiver's, and a record they did not write is not their record."
      ).toHaveCount(0);
    }
    expect(
      await noteField.inputValue(),
      "A coaching round must leave the note byte-identical."
    ).toBe(before);
  });
});
