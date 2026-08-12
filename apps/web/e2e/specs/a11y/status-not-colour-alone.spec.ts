/**
 * A11Y — status is never conveyed by colour alone (D-012's ratification condition).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real component source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHY THIS IS A SEPARATE TEST FROM THE AXE SWEEP. Axe cannot check this. WCAG 1.4.1
 * "Use of Color" is one of the criteria that no automated engine evaluates, because
 * deciding whether a colour is *the only* carrier of meaning requires knowing what the
 * colour means. So an axe-clean screen can still be a screen where an amber capsule is
 * the only difference between "verified" and "needs a person" — and the coordinator with
 * deuteranopia, or the caregiver reading a phone in direct sunlight, sees nothing.
 *
 * D-012 ratified the Apple-2026 rebrand with an explicit, non-negotiable condition:
 * compliance and status are **colour + icon + label, never colour alone**. This walks
 * every new surface and enforces the label half of that, which is the half a machine can
 * judge: a status capsule with no text is a violation, whatever colour it is.
 *
 * WHAT IT CANNOT ENFORCE. That the label is the *right* word, and that the icon is
 * distinguishable. Those need eyes; docs/12 §4's manual screen-reader and design pass
 * still owes them.
 *
 * PHI: offenders are reported as tag name plus class list. Never the text, never the
 * markup — a chip on a visit card sits next to a client's name (invariant 5).
 */

import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";
import { landingHint, SWEEP_PERSONAS, surfacesByPersona } from "../../support/routes";

const REQUIREMENT = { personas: SWEEP_PERSONAS };

/**
 * Everything on these screens that carries state through a tone. `.chip` is the shared
 * capsule behind Badge, StatusChip, SeverityChip and DispositionChip; the tone classes are
 * matched separately so a future component that reaches for a tone without the capsule is
 * caught too.
 */
const STATUS_SELECTOR = [
  ".chip",
  "[class*='chip-success']",
  "[class*='chip-warning']",
  "[class*='chip-danger']",
  "[class*='chip-info']",
  "[class*='chip-accent']",
  "[class*='chip-neutral']",
].join(", ");

type Offender = { tag: string; classes: string };
type Survey = { examined: number; offenders: Offender[] };

test.describe("Accessibility · status is never colour alone (D-012)", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  for (const [persona, surfaces] of surfacesByPersona()) {
    test.describe(`as ${persona}`, () => {
      test.beforeEach(async ({ page }) => {
        await signIn(page, persona);
      });

      for (const surface of surfaces) {
        test(`${surface.path} labels every status indicator`, async ({ page }, testInfo) => {
          await gotoVerified(page, surface.path);
          await expect(
            page.getByRole("heading", { name: surface.heading, level: 1 }),
            landingHint(surface)
          ).toBeVisible();
          await page.waitForLoadState("networkidle");

          const survey = await page.evaluate<Survey, string>((selector) => {
            const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
            /* Rendered, not merely styled-visible. The node's OWN display says nothing
             * about whether an ancestor is hiding it: a chip inside a collapsed <details>
             * ("Earlier versions" on /operations/locations) still computes as flex and
             * still reports a box, yet the browser renders none of it — which is why
             * `innerText` comes back empty for a chip whose markup plainly reads "Was
             * confirmed". Counting that as an unlabelled indicator is a false alarm: a
             * reader is shown neither the word nor the colour.
             *
             * `checkVisibility` is the browser's own answer to "is this being rendered",
             * and it accounts for the skipped subtree that `display` and client rects both
             * miss. It only ever narrows the set to indicators a person can actually see —
             * which is the set D-012 is about. */
            const visible = nodes.filter((node) => {
              const check = (node as HTMLElement & {
                checkVisibility?: (o?: Record<string, boolean>) => boolean;
              }).checkVisibility;
              if (check && !check.call(node, {
                contentVisibilityAuto: true,
                opacityProperty: true,
                visibilityProperty: true,
              })) {
                return false;
              }
              const style = window.getComputedStyle(node);
              return style.display !== "none" && style.visibility !== "hidden";
            });
            return {
              examined: visible.length,
              // A capsule whose entire content is an icon says its meaning in colour and
              // shape only. `innerText` deliberately ignores <svg> content, which is what
              // makes it the right probe here.
              offenders: visible
                .filter((node) => node.innerText.trim().length === 0)
                .map((node) => ({ tag: node.tagName.toLowerCase(), classes: node.className })),
            };
          }, STATUS_SELECTOR);

          // Recorded on the test so a reader can tell a genuinely clean screen from one
          // that had nothing to examine — a pass over zero elements proves nothing, and
          // pretending otherwise is how a11y coverage rots.
          testInfo.annotations.push({
            type: "status-indicators-examined",
            description: `${survey.examined} on ${surface.path}`,
          });

          expect(
            survey.offenders,
            `${surface.path} — ${surface.note}\n` +
              `D-012 condition: status is colour + icon + label, never colour alone. ` +
              `${survey.offenders.length} indicator(s) carry no text label.`
          ).toEqual([]);
        });
      }
    });
  }
});

test.describe("Accessibility · the caregiver's status lines say what happened", () => {
  const CAREGIVER = { personas: ["caregiver" as const] };
  test.skip(unavailable(CAREGIVER), skipReason(CAREGIVER));

  /**
   * The Today screen's amber flag is the sharpest case of the D-012 condition in the whole
   * product: a visit the checks want a person to look at. If that ever becomes a coloured
   * band with no sentence, the caregiver has been told something is wrong and given no way
   * to know what — which is worse than not telling them.
   */
  test("a flagged visit is announced in words, not in amber", async ({ page }) => {
    await signIn(page, "caregiver");
    await gotoVerified(page, "/today");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

    const flagged = page.getByText("Your coordinator will take a look at this visit.");
    test.skip(
      (await flagged.count()) === 0,
      "No visit on the seeded day is flagged for review, so the flag's wording cannot be " +
        "checked. Seed a visit with an open exception to exercise it."
    );

    await expect(
      flagged.first(),
      "The flag is a sentence a caregiver can act on — not a colour, and not an accusation."
    ).toBeVisible();

    // Live regions are the other half of the same principle: a status a sighted user reads
    // from a colour change must reach a screen-reader user as an announcement.
    const chip = page.locator("span.chip").filter({ hasText: /^(Live|Offline|Syncing \(\d+\))$/ });
    await expect(
      chip,
      "The connectivity indicator names its state in words. Three honest states, all labelled."
    ).toHaveCount(1);
  });
});
