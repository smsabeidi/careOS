/**
 * JOURNEY — /install opens for somebody who is not signed in, and tells them how to put
 * CareOS on their phone (ST-240a, Front Door W6a).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W6a, docs/10 §7):
 *   1. IT IS GENUINELY PUBLIC. The journey never signs in. If `/install` ever slips out of
 *      the middleware's PUBLIC_PATHS it redirects to /login, and this spec fails on the URL
 *      before it reads a word — which is the whole point of the page. A coordinator texts
 *      this link to somebody who cannot get in; a login wall on it is the one failure that
 *      makes it useless.
 *   2. BOTH PHONES ARE SERVED. The iOS path and the Android path each render, with the
 *      platform-specific words a caregiver is looking for on their screen ("Add to Home
 *      Screen" on Safari, "Install app" in Chrome). An install guide that covers one
 *      handset is an install guide for half a workforce.
 *   3. THE NOTIFICATION RECOVERY IS VERSIONED. iOS 18 moved app settings under "Apps"; on
 *      iOS 17 they sit at the bottom of the main Settings list. Both paths render, because
 *      the agency's phones are a mix and a single wrong path reads as "the app is broken".
 *   4. ONE H1. The document has exactly one top-level heading, so the page announces
 *      itself once to a screen reader rather than presenting four competing titles.
 *   5. IT IS AXE-CLEAN at serious and critical impact, on the same WCAG tag set and the
 *      same PHI-stripped reporting as the sweep in specs/a11y/axe-sweep.spec.ts. This page
 *      is not in support/routes.ts because that list is the *authenticated* Verified Visit
 *      surfaces and its sweep signs a persona in; /install must be scanned unauthenticated
 *      or the scan proves the wrong thing.
 *
 * THE REQUIREMENT IS PLATFORM ONLY — no persona, no geo, no flag. There is deliberately no
 * feature flag on this surface (a public instruction sheet is not a gated capability). The
 * platform vars are still needed because the middleware constructs a Supabase client on
 * every request, so without them the app cannot serve any route at all.
 *
 * PHI: this page has none to leak — it names no client, no caregiver and no agency record —
 * and this spec asserts only on its static instructional copy.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";

/** No personas: signing in here would disprove the thing under test. */
const REQUIREMENT = {};

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

test.describe("Front Door · install — the public guide to putting CareOS on a phone", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    // No signIn(). A fresh context has no session cookie, which is exactly the visitor
    // this page is written for.
    await page.goto("/install");
  });

  test("opens without a session and carries exactly one h1", async ({ page }) => {
    expect(
      new URL(page.url()).pathname,
      "An unauthenticated visit must stay on /install. A redirect to /login means the path " +
        "fell out of PUBLIC_PATHS in src/middleware.ts, and the page can no longer do the " +
        "one job it has."
    ).toBe("/install");

    await expect(
      page.getByRole("heading", { name: "Put CareOS on your phone", level: 1 })
    ).toBeVisible();

    expect(
      await page.getByRole("heading", { level: 1 }).count(),
      "One page, one h1. Extra top-level headings make a screen reader announce several " +
        "competing titles for a single document."
    ).toBe(1);
  });

  test("renders the iOS path with the Safari words a caregiver is looking for", async ({
    page,
  }) => {
    const ios = page.getByRole("region", { name: "On an iPhone or iPad" });
    await expect(ios, "The iOS section must render for an unauthenticated reader.").toBeVisible();

    // The literal label on the iOS share sheet. Paraphrasing it ("save to home screen")
    // sends somebody hunting through a menu that does not contain those words.
    // `.first()` throughout: the label is deliberately repeated in the troubleshooting
    // note, and a strict-mode failure over saying the right thing twice would be the test
    // arguing with the copy.
    await expect(
      ios.getByText("Add to Home Screen").first(),
      "The step must quote Apple's own label verbatim — a caregiver matches the words on " +
        "the page against the words on the sheet."
    ).toBeVisible();

    await expect(
      ios.getByText(/Safari/).first(),
      "Chrome and Firefox on iOS cannot add to the home screen. Naming Safari is the " +
        "difference between a one-minute install and a support call."
    ).toBeVisible();
  });

  test("renders the Android path with Chrome's own install label", async ({ page }) => {
    const android = page.getByRole("region", { name: "On an Android phone" });
    await expect(
      android,
      "The Android section must render for an unauthenticated reader."
    ).toBeVisible();

    await expect(
      android.getByText("Install app").first(),
      "Chrome's menu item is 'Install app'. The older 'Add to Home screen' wording is " +
        "covered in the same step, because the agency's phones are not all on one Chrome."
    ).toBeVisible();
    await expect(android.getByText("Add to Home screen").first()).toBeVisible();
  });

  test("gives a notification recovery path for both iOS generations", async ({ page }) => {
    const notifications = page.getByRole("region", { name: "Turn on notifications" });
    await expect(notifications).toBeVisible();

    await expect(
      notifications.getByRole("heading", { name: "iOS 18 or later" }),
      "iOS 18 moved per-app settings under Settings → Apps. Without this path an iOS 18 " +
        "reader hunts the bottom of the Settings list for an entry that is not there."
    ).toBeVisible();
    await expect(
      notifications.getByRole("heading", { name: "iOS 17 or earlier" }),
      "On iOS 17 the app's entry is at the bottom of the main Settings list. Both paths " +
        "ship because the workforce's phones are a mix."
    ).toBeVisible();

    await expect(
      notifications.getByText("Allow Notifications").first(),
      "The toggle's real name, so the reader knows when they have arrived."
    ).toBeVisible();
  });

  test("says plainly that a notification never carries anything about a client", async ({
    page,
  }) => {
    // The promise the product actually keeps (payload = template key + IDs, never PHI).
    // It is on the public page because the person deciding whether to allow notifications
    // deserves to know what they are allowing.
    await expect(
      page.getByText(/Nothing about a client ever appears in a notification/).first(),
      "The zero-PHI-in-payloads rule is stated to the person granting permission, in " +
        "their words, not buried in a privacy page."
    ).toBeVisible();
  });

  test("closes on the no-app-store promise", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "No app store needed" })).toBeVisible();
  });

  test("has no serious or critical accessibility violations", async ({ page }, testInfo) => {
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""));

    // Rule ids and selectors only — never axe's `html` snippet. This page holds no PHI, but
    // the reporting shape is the house one so it stays correct if the page ever grows.
    const readable = blocking.map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      reference: v.helpUrl,
      elements: v.nodes.map((n) => n.target.join(" ")),
    }));

    if (readable.length > 0) {
      await testInfo.attach("axe-install.json", {
        body: JSON.stringify(readable, null, 2),
        contentType: "application/json",
      });
    }

    expect(
      readable,
      `/install — the public install guide, read on a phone by the least-equipped user we ` +
        `have. docs/17 §12 requires an axe pass on every new screen. ` +
        `${readable.length} serious/critical violation(s): ${readable.map((v) => v.rule).join(", ")}`
    ).toEqual([]);
  });
});

test.describe("Front Door · install — the desktop hand-off panel", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test("prints a copyable address on a desktop viewport, and hides it on a phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/install");

    const desktop = page.getByRole("region", { name: "Reading this on a computer?" });
    await expect(
      desktop,
      "On a computer the reader needs the address on their phone; this panel is how it gets " +
        "there. It is a plain copyable string by design — a QR generator would be a new " +
        "dependency, and an address survives being typed, screenshotted or texted."
    ).toBeVisible();

    await expect(
      page.locator("#install-url"),
      "The address is rendered as selectable text by the server, so it is still usable when " +
        "the clipboard is refused or JavaScript never arrives."
    ).toContainText("/install");

    await expect(page.getByRole("button", { name: /Copy this address/ })).toBeVisible();

    /* On a phone the panel is nonsense — the reader is already at this address — so it is
       not rendered to them. The instructions above it are what a phone needs. */
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      desktop,
      "The desktop hand-off must not occupy a phone screen above the steps that phone needs."
    ).toBeHidden();
  });
});
