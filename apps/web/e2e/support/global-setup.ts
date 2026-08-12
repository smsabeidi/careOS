/**
 * One banner at the top of every run, saying whether anything is about to be proven.
 *
 * A suite of fifty skipped tests scrolling past in a CI log is easy to mistake for a
 * suite of fifty passing ones. This prints the readiness verdict once, before the first
 * spec, in the plainest words available: what is missing, and the fact that a run without
 * it proves nothing (docs/12 §1 — "tests are the evidence"; evidence that did not run is
 * not evidence).
 *
 * It prints variable NAMES only. No URL, no key, no email, no password is ever echoed
 * (invariant 5 — CI logs are forever).
 */

import { BASE_URL, HAS_PLATFORM, missingPlatformVars, OWNS_WEB_SERVER } from "./env";

export default function globalSetup(): void {
  const line = "─".repeat(72);
  const say = (text: string) => process.stdout.write(`${text}\n`);

  say(line);
  say("CareOS E2E — Verified Visit & Workforce Intelligence journeys (docs/12 §4, docs/17 §12)");

  if (HAS_PLATFORM) {
    say(`Platform: configured. Target: ${BASE_URL}`);
    say(
      OWNS_WEB_SERVER
        ? "Web server: this run starts it (build first, or set CAREOS_E2E_WEB_SERVER_CMD)."
        : "Web server: external (CAREOS_E2E_BASE_URL was supplied)."
    );
    say("Individual journeys still skip if their persona or geographic anchors are absent.");
  } else {
    say("Platform: NOT configured — nothing will be proven by this run.");
    say(`Missing: ${missingPlatformVars.join(", ")}`);
    say("Every journey below will report as skipped with its own reason. That is the");
    say("designed behaviour, not a defect: see apps/web/e2e/README.md for what to set.");
  }

  say(line);
}
