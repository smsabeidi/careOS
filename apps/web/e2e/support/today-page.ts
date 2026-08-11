/**
 * Handles on the caregiver's Today screen (apps/web/src/app/today/**).
 *
 * ON SELECTORS. The rule is role- and label-first, and every control here is reached that
 * way: `Clock in`, `Complete visit`, `Try again`, `Request exception`, `Reason`, `Send and
 * carry on` are all real accessible names, taken from the English dictionary
 * (src/lib/i18n/dictionaries.ts) rather than guessed. The one structural CSS hook is
 * `.card`, used to scope assertions to a single visit — a caregiver with four visits
 * renders four `Clock in` buttons, and an unscoped click would be a coin flip. No
 * `data-testid` was added to the source: a test hook is not an improvement to a caregiver
 * screen, and the instruction to leave shipped code alone outranks the convenience.
 *
 * ON THE VOCABULARY BEING ASSERTED. docs/17 §7.1 makes the caregiver's words a contract:
 * EVV, GPS, geofence, accuracy, radius, metres and coordinates appear nowhere they can see
 * them. `expectFieldVocabulary` enforces that, because a regression there is a D-030
 * violation that no other layer would catch.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/** Words a caregiver must never be shown on this screen (docs/17 §7.1, D-030). */
const FORBIDDEN_FIELD_WORDS = [
  /\bEVV\b/,
  /\bGPS\b/,
  /\bgeofence\b/i,
  /\bgeo-fence\b/i,
  /\bcoordinates?\b/i,
  /\blatitude\b/i,
  /\blongitude\b/i,
  /\baccuracy\b/i,
  /\bradius\b/i,
  /\b\d+\s?(m|metres|meters)\b/,
];

export class TodayPage {
  constructor(readonly page: Page) {}

  async open(): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  }

  /** The "Your visits" section — scopes every card lookup away from Upcoming and My clients. */
  get visitsSection(): Locator {
    return this.page
      .locator("section")
      .filter({ has: this.page.getByRole("heading", { name: "Your visits" }) });
  }

  /** Every visit card scheduled for today, in the order the page renders them. */
  get visitCards(): Locator {
    return this.visitsSection.locator("div.card");
  }

  /**
   * The first card that still offers a clock-in. Skipping the already-clocked cards keeps
   * the journey deterministic when the seeded day has a mixture of states.
   */
  firstClockableCard(): Locator {
    return this.visitCards
      .filter({ has: this.page.getByRole("button", { name: "Clock in", exact: true }) })
      .first();
  }

  /** The connectivity chip in the page header: Live · Syncing (n) · Offline. */
  get connectionChip(): Locator {
    return this.page.locator("span.chip").filter({ hasText: /^(Live|Offline|Syncing \(\d+\))$/ });
  }

  /**
   * Assert the caregiver's screen never speaks in surveillance vocabulary.
   *
   * Scoped to the visits section rather than the whole document: the shell's nav can
   * legitimately link to an admin surface whose own name contains one of these words, and
   * a false positive on that would teach people to delete the assertion.
   */
  async expectFieldVocabulary(): Promise<void> {
    const text = await this.visitsSection.innerText();
    for (const pattern of FORBIDDEN_FIELD_WORDS) {
      expect(
        text,
        `docs/17 §7.1: the caregiver's screen must not use ${pattern} — the words EVV, GPS, ` +
          `geofence, accuracy, radius, metres and coordinates are barred from the field UI (D-030).`
      ).not.toMatch(pattern);
    }
  }
}
