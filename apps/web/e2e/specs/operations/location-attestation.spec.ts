/**
 * JOURNEY — a pin arrives only by human attestation, and the record names the human.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (D-025, docs/17 §7.2 §12, invariant 1):
 *   1. NO GEOCODER PUTS A COORDINATE ON A CLIENT'S HOME. Every pin is something a person
 *      signed for, and the screen says so before it asks for one. D-025 exists because a
 *      geocoded pin is an unattributed guess that later gets used to judge whether a
 *      caregiver was really there — and nobody can be asked to account for a guess.
 *   2. CONFIRMING IS AN ACT, NOT A SIDE EFFECT. The attestation checkbox is `required` in
 *      the browser AND re-checked inside the Server Action, because a Server Action is a
 *      public endpoint that a direct POST reaches without ever meeting the form. Both
 *      halves are asserted: the form refuses to submit unticked, and the copy states what
 *      is being claimed.
 *   3. THE CONFIRMATION APPENDS A VERSION AND NAMES ITS AUTHOR. Afterwards the pin block
 *      reads "confirmed by <a person> on <a date>" — a named human and a moment. The
 *      version it replaced is kept, so a visit already measured against the old pin still
 *      means what it meant (invariant 1).
 *
 * ON COORDINATES ON THIS SCREEN. D-030 keeps latitude and longitude out of the caregiver's
 * world; this is the one surface where they are the subject rather than a leak — you
 * cannot ask somebody to confirm a pin you refuse to show them. That asymmetry is
 * deliberate, and this spec is where it is written down.
 */

import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["admin" as const] };

test.describe("Operations · places of care", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "admin");
    await gotoVerified(page, "/operations/locations");
    await expect(page.getByRole("heading", { name: "Places of care", level: 1 })).toBeVisible();
    /* ./loading.tsx mirrors the real layout down to the <h1>, so the heading is not proof
     * the page arrived; wait on the skeleton's own `aria-busy` region instead. */
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  });

  test("says a pin is signed for, refuses an unticked confirmation, and records the person", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: "A pin is something a person signs for" }),
      "D-025 is stated on the screen, not just in the migration."
    ).toBeVisible();

    /* ── Open the attestation for the first place on file ─────────────────────── */
    /* Every place on the page carries its own copy of this wording, so a page-wide locator
     * matches all of them and says nothing about the one being signed for. Scope to the
     * place whose disclosure is opened, and stay inside it for the rest of the journey. */
    const place = page
      .locator("article")
      .filter({ has: page.getByText(/^Confirm this pin( again)?$/) })
      .first();
    await expect(
      place,
      "No place of care is on file for this tenant, so there is nothing to attest to. " +
        "Seed a client with a service location before running this journey."
    ).toBeVisible();
    await place.getByText(/^Confirm this pin( again)?$/).click();

    await expect(
      place.getByText("You are saying: this pin is where that address is."),
      "The screen states what is being claimed before it asks for the claim."
    ).toBeVisible();
    await expect(
      place.getByText(/Confirming appends a new version — the one on file now is kept/),
      "invariant 1: the attestation appends; it never overwrites the pin in use."
    ).toBeVisible();

    const form = place.locator("form").filter({ hasText: "I have checked this against the address" }).first();
    const latitude = form.getByLabel("Latitude");
    const longitude = form.getByLabel("Longitude");
    const attest = form.getByRole("checkbox");
    const submit = form.getByRole("button", { name: "Confirm — this pin is correct" });

    /* ── 1. The tick is required by the browser itself ───────────────────────── */
    // Coordinates chosen to be unmistakably synthetic and stable across runs: this is the
    // Meadowbrook universe, never production (invariant 4).
    await latitude.fill("39.290400");
    await longitude.fill("-76.612200");
    await form.getByLabel("How exact is it?").selectOption({ index: 0 });

    await expect(attest, "The attestation starts unticked — it is never a default.").not.toBeChecked();
    await submit.click();
    await expect(
      form.locator("input[name='attest']:invalid"),
      "D-025: the checkbox is `required`, so the browser's own constraint validation stops " +
        "an unticked confirmation before anything is sent. If this element is valid, a " +
        "signature just went through without the signature."
    ).toHaveCount(1);
    await expect(
      place.getByText(/Confirmed as version/),
      "Nothing may be confirmed while the attestation is unticked."
    ).toHaveCount(0);

    /* ── 2. Tick it, and the record takes a name ─────────────────────────────── */
    await attest.check();
    await submit.click();

    const outcome = form.getByRole("status");
    await expect(outcome).toBeVisible();
    await expect(
      outcome,
      "The confirmation is recorded as a new version in the confirmer's name — or, if the " +
        "pin was already exactly this, as nothing at all, which is equally honest."
    ).toContainText(
      /(Confirmed as version .*, in your name and with today's date\.|That is the pin already confirmed for this address)/
    );

    /* ── 3. The record names the human, on the page ──────────────────────────── */
    await page.reload();
    await expect(page.getByRole("heading", { name: "Places of care", level: 1 })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    /* The same place, read back from the server: the confirmation has to be on the record,
     * not merely in the reply the browser was handed. */
    await expect(
      page.locator("article").first().getByText(/· confirmed by .+ on /),
      "D-025: the pin block must name who confirmed it and when. `a coordinator` is the " +
        "fallback only when RLS hides the name — never the normal case."
    ).toBeVisible();
  });
});
