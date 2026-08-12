/**
 * A11Y — axe on every screen this layer added. Zero serious, zero critical.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real route list; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4 "axe-clean on gated flows", docs/17 §12, docs/10 §7):
 *   Every new surface passes WCAG 2.0/2.1 A and AA at serious and critical impact. The
 *   route list lives in ../../support/routes.ts, so a screen added tomorrow is swept the
 *   day it lands rather than the day somebody remembers.
 *
 * WHY SERIOUS AND CRITICAL, AND NOT EVERYTHING. Axe's `minor` and `moderate` findings are
 * worth reading and worth fixing, but gating on them makes the gate a lottery — a colour
 * token nudged by two hex points flips a `moderate` contrast advisory and a release stops
 * for a reason nobody can act on. Serious and critical are the impacts that mean a person
 * cannot use the screen. Those get a hard zero. The full result set is attached to the
 * test on failure, so the quieter findings are still in front of whoever is looking.
 *
 * WHAT AXE CANNOT DO. It cannot tell you whether the words make sense, whether the focus
 * order matches the reading order, or whether a screen-reader user can complete the visit.
 * docs/12 §4 requires a manual screen-reader pass on the caregiver loop and the approvals
 * inbox each release, and this suite does not discharge it. Automated a11y catches roughly
 * a third of what is wrong; saying so here is more useful than a green tick that implies
 * otherwise.
 *
 * PHI: failures report rule ids and CSS selectors only. Axe's `html` snippets are stripped
 * before anything is written to a report, because a violation on a visit card would
 * otherwise carry a client's name into CI output forever (invariant 5).
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";
import { landingHint, NEW_SURFACES, SWEEP_PERSONAS, surfacesByPersona } from "../../support/routes";

const REQUIREMENT = { personas: SWEEP_PERSONAS };

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

test.describe("Accessibility · axe sweep of the Verified Visit surfaces", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  for (const [persona, surfaces] of surfacesByPersona()) {
    test.describe(`as ${persona}`, () => {
      test.beforeEach(async ({ page }) => {
        await signIn(page, persona);
      });

      for (const surface of surfaces) {
        test(`${surface.path} has no serious or critical violations`, async ({ page }, testInfo) => {
          await gotoVerified(page, surface.path);

          // The heading is the proof we are scanning the surface itself and not the page a
          // permission redirect sent us to. Without it, axe would cheerfully report a clean
          // scan of somebody's home screen.
          await expect(
            page.getByRole("heading", { name: surface.heading, level: 1 }),
            landingHint(surface)
          ).toBeVisible();

          // Loading skeletons carry aria-busy and can legitimately be mid-swap while axe
          // walks the tree. Settling first keeps the result about the finished screen.
          await page.waitForLoadState("networkidle");

          const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

          const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""));

          // Selectors and rule ids only — never axe's `html` snippet, which on these
          // screens would be a client's name or a caregiver's shift (invariant 5).
          const readable = blocking.map((v) => ({
            rule: v.id,
            impact: v.impact,
            help: v.help,
            reference: v.helpUrl,
            elements: v.nodes.map((n) => n.target.join(" ")),
          }));

          if (readable.length > 0) {
            await testInfo.attach(`axe-${surface.path.replace(/[^a-z0-9]+/gi, "-")}.json`, {
              body: JSON.stringify(readable, null, 2),
              contentType: "application/json",
            });
          }

          expect(
            readable,
            `${surface.path} — ${surface.note}\n` +
              `docs/17 §12 requires an axe pass on every new screen. ` +
              `${readable.length} serious/critical violation(s): ` +
              `${readable.map((v) => v.rule).join(", ")}`
          ).toEqual([]);
        });
      }
    });
  }
});

test.describe("Accessibility · the sweep covers what this layer shipped", () => {
  /**
   * A route list that silently loses an entry is a sweep that silently stops covering a
   * screen. This is the cheapest possible guard: it runs with no platform at all, so it is
   * the one a11y assertion that is genuinely proven on any machine.
   */
  test("every surface in the list declares a heading and an owner", () => {
    expect(NEW_SURFACES.length, "The sweep must cover every screen this layer added.").toBeGreaterThanOrEqual(11);
    for (const surface of NEW_SURFACES) {
      expect(surface.heading.trim(), `${surface.path} needs the h1 the sweep waits for.`).not.toBe("");
      expect(surface.note.trim(), `${surface.path} needs a one-line reason it is swept.`).not.toBe("");
    }
  });
});
