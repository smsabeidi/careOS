/**
 * Signing in, including the AAL2 step-up — because PHI does not open without it.
 *
 * THE STEP-UP IS REAL. Invariant 3 says any surface exposing PHI requires an MFA-verified
 * session, and `app.is_aal2()` enforces it in Postgres where no browser can argue with it.
 * So this helper does not stub, mock or bypass anything: it completes the genuine TOTP
 * challenge with the seeded synthetic factor, exactly as `elevateDemoSession` does for the
 * persona switcher. It imports the app's own `totp` implementation rather than carrying a
 * second copy — one RFC 6238 in the repo, and the journey exercises the same code the
 * product ships.
 *
 * A tenant running with CAREOS_DEMO_MODE elevates at sign-in on its own and never shows
 * /mfa; this helper handles both paths and asserts the outcome either way, so a silent
 * failure to reach AAL2 surfaces here as a named error rather than as an empty PHI list
 * three assertions later.
 *
 * @trace docs/09 §2, docs/12 §4, invariant 3
 */

import { expect, type Page } from "@playwright/test";
import { totp } from "../../src/lib/demo-totp";
import { credentialsFor, TOTP_SECRET, type Persona } from "./env";

/** Paths that are not a signed-in, verified surface. Landing on one means sign-in failed. */
const NOT_SIGNED_IN = ["/login", "/mfa"];

function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

/**
 * Sign the persona in and leave the browser on a verified session.
 *
 * Selectors here are the login page's real labels and button text (`Work email`,
 * `Password`, `Continue`, `6-digit code`, `Verify and continue`). If the copy changes,
 * this breaks loudly — which is correct: sign-in copy is part of the contract with a
 * caregiver at 6 am, and a test that shrugs it off is not testing the product.
 */
export async function signIn(page: Page, persona: Persona): Promise<void> {
  const { email, password } = credentialsFor(persona);

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();

  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();

  // Either the credentials were refused (the page says so in a live region and stays put)
  // or we leave /login. Waiting on the URL alone would time out on a bad password with a
  // message that hides the real one.
  const refusal = page.getByRole("alert");
  await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 }),
    refusal.waitFor({ state: "visible", timeout: 45_000 }).then(async () => {
      throw new Error(
        `Sign-in was refused for the ${persona} persona: "${(await refusal.innerText()).trim()}"`
      );
    }),
  ]);

  if (pathOf(page).startsWith("/mfa")) {
    if (!TOTP_SECRET) {
      throw new Error(
        "The session landed on /mfa and no CAREOS_E2E_TOTP_SECRET is set, so the step-up " +
          "cannot be completed. Seed a known TOTP factor for the E2E personas, or run the " +
          "tenant with CAREOS_DEMO_MODE. AAL2 is never bypassed."
      );
    }
    await page.getByLabel("6-digit code").fill(await totp(TOTP_SECRET));
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/mfa"), { timeout: 45_000 });
  }

  expect(
    NOT_SIGNED_IN.some((p) => pathOf(page).startsWith(p)),
    `The ${persona} persona did not reach a verified session; it stopped at ${pathOf(page)}.`
  ).toBe(false);
}

/**
 * Navigate to a gated surface and prove we are still verified when we arrive.
 *
 * Middleware bounces an AAL1 session to /mfa and an anonymous one to /login. Without this
 * check a journey would go on to assert against the login page and report a confusing
 * "expected heading Findings" instead of "the session was not verified".
 */
export async function gotoVerified(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");
  expect(
    NOT_SIGNED_IN.some((p) => pathOf(page).startsWith(p)),
    `Navigating to ${path} was redirected to ${pathOf(page)} — the session is not verified.`
  ).toBe(false);
}
