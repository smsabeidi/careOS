/**
 * JOURNEY — the command bar opens on every authenticated surface, is reachable without a
 * keyboard, traps focus while it is open, and does not exist at all when its flag is off
 * (ST-232, Front Door W1).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real component source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W1, invariants 5 + 8, D-012):
 *   1. THE FLAG IS THE WHOLE GATE. `front_door.command_bar` is read server-side, and when
 *      it is off the bar is ABSENT — no trigger, no button, and no keyboard shortcut that
 *      quietly still works. A dark feature that answers ⌘K is a dark feature that shipped.
 *   2. THERE IS A WAY IN WITHOUT A KEYBOARD. A caregiver on a phone has no ⌘K, so the
 *      journey asserts the button on both form factors: a top-bar control on a desktop
 *      viewport, a thumb-reachable button above the tab bar on a phone one.
 *   3. THE DIALOG BEHAVES LIKE A DIALOG. It is `aria-modal`, it is labelled, focus lands
 *      inside it, Tab cannot walk out of it, and Escape closes it and gives focus back.
 *      This is the part a screen-reader user experiences as the feature working at all.
 *   4. NOTHING ABOUT A PERSON ENTERS THE URL. Opening, pinning and closing the bar never
 *      put a name or an id in the address bar (invariant 5) — the bar is state, not a route.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE HERE: that an answer or a draft is correct. Those
 * assertions need a model, and a deployment without a key still works — every capability
 * degrades to a deterministic path — so they skip and name `CAREOS_E2E_MODEL_CONFIGURED`
 * rather than assert something weaker against a fallback. The open/close/a11y assertions
 * above still run in that case, which is the point of splitting them.
 *
 * The coordinator is the reader: they are the role the bar is designed around, and the
 * only one who also sees the drafting lane when `front_door.actions` is on.
 */

import { expect, test, type Page } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["coordinator" as const] };
const MODEL_REQUIREMENT = { personas: ["coordinator" as const], model: true };

/** Any authenticated surface will do — the bar mounts from the shell, not from a page. */
const SURFACE = "/schedule";

const trigger = (page: Page) => page.getByTestId("command-bar-trigger");
const fab = (page: Page) => page.getByTestId("command-bar-fab");
const dialog = (page: Page) => page.getByTestId("command-bar-dialog");

/**
 * The bar is flagged off for this tenant, which is a legitimate state and its own
 * contract — so the flag-off journey below asserts it, and every flag-on journey skips
 * with a reason naming the flag instead of failing.
 */
async function barIsDark(page: Page): Promise<boolean> {
  return (await trigger(page).count()) === 0 && (await fab(page).count()) === 0;
}

const DARK_REASON =
  "NOT RUN — front_door.command_bar is off for this tenant, so the bar is not rendered " +
  "and this journey asserted nothing about it. Flip the flag with app.set_feature_flag " +
  "on a synthetic tenant to exercise it.";

test.describe("Front Door · command bar", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "coordinator");
    await gotoVerified(page, SURFACE);
  });

  test("when the flag is off the bar does not exist — not even the shortcut", async ({ page }) => {
    test.skip(!(await barIsDark(page)), "The bar is switched ON for this tenant; the flag-off contract is not the live one.");

    await expect(
      trigger(page),
      "A dark feature renders nothing: no top-bar control, not even a disabled one."
    ).toHaveCount(0);
    await expect(fab(page), "No phone button either — dark is dark on every form factor.").toHaveCount(0);

    // The shortcut is the part that is easy to leave live by accident, because it lives in
    // a client island rather than in the server render. If the mount returned null, the
    // listener was never attached and this does nothing at all.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(
      dialog(page),
      "⌘K must do nothing when the flag is off — an overlay behind a dark flag is the " +
        "feature shipping without the decision to ship it."
    ).toHaveCount(0);

    await page.keyboard.press("/");
    await expect(dialog(page), "\"/\" must do nothing either.").toHaveCount(0);
  });

  test("opens with the keyboard and with the button, and closes with Escape", async ({ page }) => {
    test.skip(await barIsDark(page), DARK_REASON);

    /* ── The chord ────────────────────────────────────────────────────────────── */
    await page.keyboard.press("ControlOrMeta+k");
    const panel = dialog(page);
    await expect(panel, "⌘K / Ctrl-K opens the bar from any authenticated surface.").toBeVisible();
    await expect(
      panel,
      "It is a real modal dialog, so assistive technology treats the page behind it as inert."
    ).toHaveAttribute("aria-modal", "true");
    await expect(
      page.getByRole("dialog", { name: /Ask or find anything/ }),
      "The dialog carries an accessible name — an unlabelled modal is an unexplained modal."
    ).toBeVisible();

    /* ── Focus lands inside, on the thing you came to type into ───────────────── */
    await expect(
      page.getByLabel(/Ask a question about agency policy|Describe the schedule change/),
      "Opening the bar puts the cursor in the composer; a modal that opens with focus " +
        "still on the page behind it is a modal a keyboard user cannot reach."
    ).toBeFocused();

    /* ── Escape closes and hands focus back ───────────────────────────────────── */
    await page.keyboard.press("Escape");
    await expect(panel, "Escape closes the bar.").toHaveCount(0);
    await expect(
      trigger(page),
      "Focus returns to the control that opened it, so the keyboard user keeps their place."
    ).toBeFocused();

    /* ── The button, for everyone who does not know the chord ─────────────────── */
    await trigger(page).click();
    await expect(panel, "The visible button opens the same bar.").toBeVisible();
    await page.keyboard.press("Escape");

    /* ── "/" is a shortcut only when nobody is typing ─────────────────────────── */
    await page.keyboard.press("/");
    await expect(
      panel,
      "\"/\" opens the bar when focus is not in a field — the shortcut a coordinator " +
        "reaches for without thinking."
    ).toBeVisible();
  });

  test("focus is trapped while the bar is open", async ({ page }) => {
    test.skip(await barIsDark(page), DARK_REASON);

    await trigger(page).click();
    const panel = dialog(page);
    await expect(panel).toBeVisible();

    // Enough tabs to walk past every control in the panel and, without a trap, out into
    // the page behind it — which is exactly the bug this asserts against.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await panel.evaluate((node) => node.contains(document.activeElement));
      expect(
        inside,
        `Tab ${i + 1} left the dialog. Focus must cycle inside an aria-modal dialog — ` +
          "otherwise a keyboard user is operating a surface they cannot see."
      ).toBe(true);
    }

    await page.keyboard.press("Shift+Tab");
    expect(
      await panel.evaluate((node) => node.contains(document.activeElement)),
      "Shift-Tab wraps backwards inside the dialog too."
    ).toBe(true);
  });

  test("the way in survives a phone, and nothing about a person reaches the URL", async ({ page }) => {
    test.skip(await barIsDark(page), DARK_REASON);

    /* ── Desktop: the top-bar control, and no floating button competing with it ── */
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(trigger(page), "On a desktop the way in is a top-bar control.").toBeVisible();
    await expect(
      fab(page),
      "…and the phone button is hidden there, so the two never stack up in one corner."
    ).toBeHidden();

    /* ── Phone: the button IS the feature — field users have no keyboard ───────── */
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      fab(page),
      "On a phone the button must be visible and thumb-reachable: a caregiver has no ⌘K, " +
        "and a feature reachable only by chord is a feature only the office has."
    ).toBeVisible();

    await fab(page).click();
    await expect(dialog(page), "The phone button opens the same bar.").toBeVisible();

    const url = new URL(page.url());
    expect(
      `${url.search}${url.hash}`,
      "Opening the bar is state, never a route: no query string, no fragment, and so no " +
        "chance of a name or a record id landing in a browser history or a server log " +
        "(invariant 5)."
    ).toBe("");
  });

  test("the empty state says what the bar is for, and the composer is properly labelled", async ({
    page,
  }) => {
    test.skip(await barIsDark(page), DARK_REASON);

    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();

    await expect(
      page.getByText(/Ask about agency policy/),
      "The empty state is not a blank box: it says what can be asked and what happens to " +
        "the answer (four-state doctrine)."
    ).toBeVisible();
    await expect(
      page.getByText(/Escape closes this/),
      "…and it tells a keyboard user how to leave."
    ).toBeVisible();

    // The "Add context" picker: real label, real button, and copy stating that pinning
    // stores a reference rather than a name (invariant 5 made visible to the user).
    await page.getByRole("button", { name: "Add context" }).click();
    await expect(page.getByLabel("Find a client or caregiver")).toBeVisible();
    await expect(
      page.getByText(/stores the record reference, never the name/),
      "The bar says out loud what it keeps, because a coordinator on a shared laptop " +
        "deserves to know that closing the tab does not leave a client's name behind."
    ).toBeVisible();

    // Escape closes the picker FIRST, not the whole bar — losing a half-typed question to
    // a stray Escape is the kind of small betrayal that stops people using a tool.
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Find a client or caregiver")).toHaveCount(0);
    await expect(dialog(page), "The bar itself is still open after the picker closes.").toBeVisible();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   The model-dependent half. Split into its own describe so that a deployment with no
   key skips exactly these and still runs everything above.
   ══════════════════════════════════════════════════════════════════════════════ */

test.describe("Front Door · command bar — answers and drafts", () => {
  test.skip(unavailable(MODEL_REQUIREMENT), skipReason(MODEL_REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "coordinator");
    await gotoVerified(page, SURFACE);
  });

  test("a question comes back as an answer with its provenance", async ({ page }) => {
    test.skip(await barIsDark(page), DARK_REASON);

    await trigger(page).click();
    await page
      .getByLabel(/Ask a question about agency policy/)
      .fill("How often are supervisory visits required?");
    // `exact` matters here: role-name matching is substring by default, and "Ask" would
    // otherwise also match the lane button "Ask a question".
    await page.getByRole("button", { name: "Ask", exact: true }).click();

    const answer = page.getByRole("region", { name: "Answer" });
    await expect(answer, "The answer renders in its own labelled region.").toBeVisible({
      timeout: 45_000,
    });
    const text = await answer.innerText();
    expect(
      /Answered from policy|No policy found/.test(text),
      "Every answer carries its verdict in WORDS — answered from policy, or plainly not " +
        "found. A confident-looking paragraph with no provenance is the failure mode this " +
        "whole surface exists to avoid (D-012)."
    ).toBe(true);
  });

  test("a drafted schedule change is inert, evidenced, and disposed of somewhere else", async ({
    page,
  }) => {
    test.skip(await barIsDark(page), DARK_REASON);

    await trigger(page).click();
    const lane = page.getByRole("button", { name: "Draft a schedule change" });
    test.skip(
      (await lane.count()) === 0,
      "NOT RUN — front_door.actions is off for this tenant, so the drafting lane is not " +
        "rendered and nothing about drafting was asserted."
    );

    await lane.click();
    await page
      .getByLabel(/Describe the schedule change/)
      .fill("Assign a caregiver to tomorrow morning's visit");
    await page.getByRole("button", { name: "Draft it" }).click();

    // Either a draft or an honest clarification — both are correct outcomes, and the one
    // thing neither may be is an action. The assertion below is the invariant: whatever
    // came back, the bar offers no way to make it happen.
    const draft = page.getByRole("region", { name: "Draft awaiting a decision" });
    const clarify = page.getByText(/One more thing|Not done/);
    await expect(draft.or(clarify).first()).toBeVisible({ timeout: 60_000 });

    if ((await draft.count()) > 0) {
      await expect(
        draft.getByText("Draft · nothing has changed"),
        "A draft says out loud that nothing has changed yet."
      ).toBeVisible();
      await expect(
        draft.getByText("Pre-flight checks"),
        "…and carries the deterministic checks the platform ran, not just prose."
      ).toBeVisible();
      await expect(
        draft.getByRole("link", { name: "Review in Approvals" }),
        "The only route onward is /inbox: disposition lives under the human-disposer " +
          "trigger, on the surface that owns it (invariant 8)."
      ).toHaveAttribute("href", "/inbox");
    }

    // Substring matching is deliberate here: "Approve" must also catch "Approve draft".
    for (const forbidden of ["Approve", "Assign now", "Book it", "Confirm"]) {
      await expect(
        dialog(page).getByRole("button", { name: forbidden }),
        `The bar must never offer "${forbidden}". It drafts; a licensed human disposes, ` +
          "in their own session, on /inbox."
      ).toHaveCount(0);
    }

    // D-030, asserted rather than assumed: pre-flight evidence reaches the screen as
    // words and buckets. A metre or a coordinate here would mean the minimiser leaked.
    const panelText = await dialog(page).innerText();
    for (const forbidden of [/\d+\s?m\b/, /\bmeters?\b/i, /\bmetres?\b/i, /latitude/i, /longitude/i]) {
      expect(
        forbidden.test(panelText),
        `The draft card must never show a distance or a coordinate (${forbidden}). ` +
          "Location evidence travels as inside/near/far or not at all."
      ).toBe(false);
    }
  });
});
