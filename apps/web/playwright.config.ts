/**
 * Playwright — the E2E release gate for the Verified Visit surfaces (docs/12 §2, §4, §9).
 *
 * WHAT THIS CONFIG IS FOR. docs/12 §4 release-gates a set of critical journeys and an
 * axe-clean sweep on every gated flow; docs/17 §12 names the specific ones this layer
 * owes: in-fence clock-in, out-of-fence → reason → exception, the offline capture and its
 * replay, exception disposition, approval, period close/export, and a11y with D-012's
 * "status is never colour alone". Those specs live under ./e2e/specs.
 *
 * ⚠ THESE JOURNEYS HAVE NEVER BEEN EXECUTED. They are specified and wired, not proven.
 * The machine they were authored on has Postgres but no Supabase Auth and no PostgREST,
 * so the web app cannot authenticate or read a row. Read ./e2e/README.md before believing
 * anything about them. Every spec therefore SKIPS with a stated reason when its
 * environment is absent — never a silent pass, never a hard failure.
 *
 * THE SERVER IS ONLY STARTED WHEN IT COULD POSSIBLY WORK. `webServer` is declared only
 * when the Supabase env vars are present and no external base URL was supplied. Without
 * them `next start` would boot into a crash loop and every run would end in a timeout
 * that says nothing about the product — a skip that names the missing variable is the
 * honest outcome, and that is what you get instead.
 *
 * @trace docs/12 §2 §4 §9, docs/17 §12, D-012, D-022, D-025, D-027, D-030
 */

import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, HAS_PLATFORM, OWNS_WEB_SERVER, WEB_SERVER_COMMAND } from "./e2e/support/env";

export default defineConfig({
  testDir: "./e2e/specs",
  // The journeys touch shared agency state (a payroll period, a policy chain, a visit's
  // clock ledger). Two workers racing the same seeded tenant would produce failures that
  // are about the harness rather than the product, so files run one at a time by default.
  // Raise it only alongside per-worker tenant isolation.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },

  outputDir: "./e2e/.artifacts/test-results",
  // The HTML report is always written and never auto-opened. A skipped run is the case
  // where the report matters most — it is where each journey's "NOT RUN, and here is what
  // is missing" reason is readable in full, rather than truncated in a terminal.
  reporter: [["list"], ["html", { open: "never", outputFolder: "./e2e/.artifacts/html-report" }]],

  globalSetup: "./e2e/support/global-setup.ts",

  use: {
    baseURL: BASE_URL,
    // The agency is in Maryland and every timestamp on these screens is formatted for it
    // (America/New_York is hard-coded in the operations surfaces). A browser in another
    // zone would read a different day boundary than the page renders.
    timezoneId: "America/New_York",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [
    {
      /* The caregiver loop is a phone in a stairwell (docs/10 §2, docs/12 §4). A mid-tier
         Android viewport is the honest place to prove it, and geolocation permission is
         pre-granted because the OS prompt is not the thing under test. */
      name: "caregiver-mobile",
      testDir: "./e2e/specs/caregiver",
      use: {
        ...devices["Pixel 5"],
        permissions: ["geolocation"],
        // Overridden per test. Accuracy is deliberately tight: locate.ts stops sampling
        // at 60 m, so a tight synthetic fix keeps the acquisition from burning its full
        // 8-second deadline on every tap.
        geolocation: { latitude: 39.2904, longitude: -76.6122, accuracy: 12 },
      },
    },
    {
      name: "operations-desktop",
      testDir: "./e2e/specs/operations",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "settings-desktop",
      testDir: "./e2e/specs/settings",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      /* The Front Door wave's surfaces (docs/designs/intelligent-front-door.md). Projects
         here are an explicit allowlist of directories, so `e2e/specs/front-door` had no
         project and every spec in it was silently undiscovered — a spec that cannot be
         selected is not a gate. Desk work on a desktop; the field surfaces this wave adds
         keep their own viewport in the caregiver project. */
      name: "front-door-desktop",
      testDir: "./e2e/specs/front-door",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "a11y",
      testDir: "./e2e/specs/a11y",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer:
    OWNS_WEB_SERVER && HAS_PLATFORM
      ? {
          command: WEB_SERVER_COMMAND,
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: "pipe",
          stderr: "pipe",
        }
      : undefined,
});
