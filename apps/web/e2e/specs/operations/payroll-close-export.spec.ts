/**
 * JOURNEY — pay period: open → close → export → the file's fingerprint is shown, and
 * re-running reproduces it.
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/12 §4, docs/17 §4.7 §7.2 §12, D-024):
 *   1. A period cannot be closed while a completed visit inside it is still owed a human
 *      decision — and the refusal SAYS HOW MANY and offers the way to them. A payroll
 *      boundary that refuses without saying why is how a deadline turns into a shortcut.
 *   2. Closing puts a name on the boundary. Exporting produces a file and records a
 *      SHA-256 of it, which the screen then shows.
 *   3. RE-RUNNING THE EXPORT OVER UNCHANGED HOURS REPRODUCES THE SAME FINGERPRINT. The
 *      screen makes that claim in so many words — "is this the file we sent?" is only an
 *      answerable question if it is true. This spec is the only place that claim is
 *      checked end-to-end through the product, and it is the reason the journey does not
 *      stop at the first export.
 *   4. The download is named for the period it covers, so a bookkeeper with four files in
 *      a folder can tell them apart without opening one.
 *
 * The journey is IDEMPOTENT by design: opening a period that already exists comes back
 * "nothing was created twice", and closing one already closed comes back "nothing was
 * recorded twice". Both are asserted as acceptable outcomes rather than treated as
 * failures, because a release gate that only passes on a pristine database is a gate that
 * gets disabled.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["payroll" as const] };

/** A SHA-256 as the screen renders it: 64 lowercase hex characters, nothing else. */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Mirrors `dateOnly` in the timesheets page — an ISO date read at noon UTC so no timezone
 * can shift the day, formatted "Jun 9, 2026". Duplicated deliberately: the test must be
 * able to say what it expects to see without importing the page's private helper.
 */
function dayLabel(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function periodRow(page: Page, startsOn: string, endsOn: string): Locator {
  return page
    .getByRole("row")
    .filter({ hasText: `${dayLabel(startsOn)} – ${dayLabel(endsOn)}` })
    .first();
}

test.describe("Operations · payroll period close and export", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test("closes a period, exports it, and reproduces the fingerprint on a re-run", async ({ page }) => {
    await signIn(page, "payroll");
    await gotoVerified(page, "/operations/timesheets");
    await expect(page.getByRole("heading", { name: "Timesheets", level: 1 })).toBeVisible();

    /* ── 1. Open the period the form already proposes ────────────────────────── */
    // The prefilled window is the last fourteen days — what a payroll clerk would actually
    // run. Reading the values back means the row can be found by name rather than by
    // position, so a second open period elsewhere in the table cannot confuse the journey.
    const startInput = page.getByLabel("Period start date");
    const endInput = page.getByLabel("Period end date");
    const startsOn = await startInput.inputValue();
    const endsOn = await endInput.inputValue();
    expect(startsOn, "The open-period form must prefill a window.").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(endsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await page.getByRole("button", { name: "Open period", exact: true }).click();
    await expect(
      page.getByText(/(Period opened\.|A period already covers those dates\.)/),
      "Opening is idempotent: a second attempt says nothing was created twice."
    ).toBeVisible();

    const row = periodRow(page, startsOn, endsOn);
    await expect(row, "The period just opened must appear in the periods table.").toBeVisible();

    /* ── 2. Close it — or read the refusal, which must name a count ──────────── */
    const closeButton = row.getByRole("button", { name: "Close period", exact: true });
    if (await closeButton.count()) {
      await closeButton.click();

      const notReady = row.getByText(/still waiting on approval/);
      if (await notReady.count()) {
        await expect(
          notReady,
          "D-024: the refusal must say how many visits are still owed a decision, and that " +
            "the period stayed open."
        ).toContainText("The period stays open and nothing was changed");
        await expect(
          row.getByRole("link", { name: "See what is waiting" }),
          "A refusal that names a count must also lead to the queue holding it."
        ).toBeVisible();
        test.skip(
          true,
          "The seeded window still holds completed visits awaiting approval, so the close " +
            "leg cannot proceed. The refusal itself was asserted. Approve the outstanding " +
            "hours in the seed, or seed a window whose visits are all decided."
        );
      }

      await expect(
        row.getByText(/(Period closed with your name against it\.|This period was already closed\.)/),
        "Closing records who did it, and is idempotent."
      ).toBeVisible();
    }

    /* ── 3. Export, and show the fingerprint ─────────────────────────────────── */
    const exportButton = row.getByRole("button", { name: /^Export (to CSV|again)$/ });
    await expect(
      exportButton,
      "A closed period must offer an export. If this is missing the close leg did not land."
    ).toBeVisible();

    const firstDownload = page.waitForEvent("download");
    await exportButton.click();
    const download = await firstDownload;
    expect(
      download.suggestedFilename(),
      "The file is named for the period it covers — a folder of payroll files has to be readable."
    ).toBe(`careos-payroll-${startsOn}-to-${endsOn}.csv`);

    await expect(row.getByText("File fingerprint (SHA-256)")).toBeVisible();
    const fingerprint = (await row.locator("code").first().innerText()).trim();
    expect(
      fingerprint,
      "The export's fingerprint is shown as a plain SHA-256, not summarised or truncated."
    ).toMatch(SHA256);

    await expect(
      row.getByText(/(Period exported\.|Nothing has changed since the last export)/)
    ).toBeVisible();

    /* ── 4. The same hours produce the same file ─────────────────────────────── */
    const again = row.getByRole("button", { name: "Export again", exact: true });
    await expect(
      again,
      "An exported period offers `Export again` — re-running is the whole point of the hash."
    ).toBeVisible();

    const secondDownload = page.waitForEvent("download");
    await again.click();
    await secondDownload;

    await expect
      .poll(
        async () => (await row.locator("code").first().innerText()).trim(),
        {
          message:
            "The screen claims unchanged hours reproduce the same fingerprint. If this " +
            "differs, that claim — and the answer to 'is this the file we sent?' — is false.",
        }
      )
      .toBe(fingerprint);

    /* ── 5. The export is on the record, not just in the browser ─────────────── */
    const onRecord = page
      .locator("div.card")
      .filter({ hasText: `${dayLabel(startsOn)} – ${dayLabel(endsOn)}` })
      .filter({ hasText: "File fingerprint (SHA-256)" })
      .first();
    await expect(
      onRecord,
      "Every export is recorded with its line count, its minutes and its fingerprint."
    ).toBeVisible();
    await expect(onRecord.locator("code")).toContainText(fingerprint);
  });
});
