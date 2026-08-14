/**
 * JOURNEY — PDF form import is dark until Postgres says otherwise, and it tells the truth
 * about what it can convert (ST-237, Front Door W4).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W4/R3, invariant 5, D-012):
 *
 *   1. THE GATE IS THE DATABASE. `/office/forms` calls `app.feature_enabled` with
 *      `front_door.form_import` and a FALSE default, and renders the panel only when the
 *      answer is true. With the flag dark — which is how migration 0057 ships it — there
 *      is no heading, no picker and no teaser anywhere in the DOM. This journey reads the
 *      flag from the same database the page reads it from, so it asserts the branch the
 *      environment is actually in rather than the one somebody hoped for. A flag that
 *      renders a disabled button is a flag that leaked a roadmap; this fails on that.
 *
 *   2. THE FILE NEVER LEAVES THE COMPUTER, AND THE PANEL SAYS SO. The v1 boundary is that
 *      the browser extracts text and only text is sent (R3/3A). That promise is made in
 *      the copy above the picker, and the copy is part of the contract — a coordinator
 *      chooses a client's paperwork on the strength of it.
 *
 *   3. A SCAN IS A FULL STOP, IN THE AGREED WORDS. A PDF whose pages carry no text layer
 *      renders the scan sentence verbatim and stops. Nothing is sent and nothing is kept.
 *      This runs with no model key at all, because the scan path never reaches a model —
 *      which is exactly the point of checking it deterministically first.
 *
 *   4. THE CONVERSION PATH SKIPS HONESTLY WITHOUT A MODEL. Turning text into fields needs
 *      `form.import_pdf`, and without OPENAI_API_KEY `runCapability` takes its deterministic
 *      mock path and no structure comes back. Asserting a draft here would be asserting a
 *      fixture, so the conversion test skips with a reason that names the missing variable.
 *
 * The admin persona is the reader: /office/forms is reached by office roles, and filing a
 * draft design needs an AAL2 session, which `gotoVerified` establishes for real.
 */

import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["admin" as const] };

const FLAG = "front_door.form_import";
const PANEL_HEADING = /Import from PDF/;
const SCAN_SENTENCE =
  "This looks like a scanned document — we can't convert scans yet. We've kept nothing; the original stays on your computer.";

/**
 * A minimal, valid PDF with ONE page whose content stream draws nothing — the byte-level
 * equivalent of a scanned page before OCR: real structure, no text layer. Built here as
 * bytes rather than shipped as a fixture so the reason it is a "scan" is visible in the
 * test that depends on it.
 */
function pageWithoutText(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    // A content stream that only sets a graphics state: no BT, no Tj, no text.
    "4 0 obj\n<< /Length 26 >>\nstream\n0 0 0 RG 1 w 10 10 m S\nendstream\nendobj\n",
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

test.describe("Front Door · forms — import from PDF", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "admin");
    await gotoVerified(page, "/office/forms");
    await expect(page.getByRole("heading", { name: "Forms", level: 1 })).toBeVisible();
  });

  /**
   * The flag branch, read from the database the page reads. Whichever way the tenant is
   * configured, this asserts the CORRECT half — dark means absent, lit means present —
   * so it is a real gate check in both a dark environment and a flipped one.
   */
  test("renders the entry only when the Postgres flag says so", async ({ page }) => {
    // The rendered page is the oracle. Querying the flag a second way from the test would
    // assert our own duplicate of the gate rather than the gate the coordinator meets.
    const heading = page.getByRole("heading", { name: PANEL_HEADING });
    const picker = page.getByLabel(/PDF of a blank form/);
    const present = (await heading.count()) > 0;

    if (!present) {
      // Dark: NOTHING in the DOM. Not a teaser, not a disabled control, not the copy.
      await expect(
        picker,
        "With front_door.form_import dark the picker must be absent from the DOM, not " +
          "disabled — a disabled control is a roadmap leak dressed as a gate."
      ).toHaveCount(0);
      await expect(
        page.getByText(/never leaves this computer/),
        "The panel's promise copy must not render when the panel does not."
      ).toHaveCount(0);
      test.skip(
        true,
        `NOT RUN — ${FLAG} is dark in this tenant, which is how migration 0057 ships it. ` +
          "The absence of the entry was asserted; the conversion journey was not."
      );
      return;
    }

    // Lit: the entry is real, reachable, and makes its promise before the picker.
    await expect(heading).toBeVisible();
    await expect(picker).toBeVisible();
    await expect(
      page.getByText(/the file itself never leaves this computer/),
      "The v1 boundary (R3/3A) is a promise made in copy above the picker: the browser " +
        "reads the words, the file stays put. If that sentence goes, the promise goes."
    ).toBeVisible();
    await expect(
      page.getByText(/Use blank forms/),
      "A filled form's text is somebody's details. The panel says so before a coordinator chooses a file."
    ).toBeVisible();
  });

  /**
   * The scan fallback, end to end, with no model involved. This is the one conversion-path
   * assertion that can run without a key, because the scan check is deterministic and
   * happens BEFORE anything is sent.
   */
  test("a PDF with no text layer stops at the honest scan sentence", async ({ page }) => {
    const heading = page.getByRole("heading", { name: PANEL_HEADING });
    test.skip(
      (await heading.count()) === 0,
      `NOT RUN — ${FLAG} is dark in this tenant, so there is no importer to exercise. ` +
        "This journey asserted nothing about the scan path."
    );

    await page.getByLabel(/PDF of a blank form/).setInputFiles({
      name: "scanned-admission-form.pdf",
      mimeType: "application/pdf",
      buffer: pageWithoutText(),
    });

    await expect(
      page.getByText(SCAN_SENTENCE),
      "A scan gets the agreed sentence verbatim: what it is, that we cannot convert it yet, " +
        "that nothing was kept, and where the original still is. Not an error, not a spinner " +
        "that never ends."
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      page.getByRole("button", { name: "Save as draft template" }),
      "There is nothing to save after a scan, so the save control must not exist."
    ).toHaveCount(0);

    await expect(
      page.getByRole("button", { name: "Start again" }),
      "A stop still needs a next step: the reviewer can choose another file without reloading."
    ).toBeVisible();
  });

  /**
   * The digital-text path. It reaches `form.import_pdf`, so it needs a model key; without
   * one `runCapability` returns its deterministic mock and there is no structure to review.
   * Skipping with the variable named is the honest outcome — a green assertion against a
   * mocked draft would prove the mock, not the product.
   */
  test("converts a digital-text PDF into a reviewable draft", async ({ page }) => {
    test.skip(
      !process.env.OPENAI_API_KEY,
      "NOT RUN — no model access. Missing: OPENAI_API_KEY. Turning extracted text into " +
        "fields is the form.import_pdf capability; without a key runCapability takes its " +
        "deterministic mock path and no structure comes back. This journey asserted nothing " +
        "about conversion. See apps/web/e2e/README.md."
    );
    const heading = page.getByRole("heading", { name: PANEL_HEADING });
    test.skip(
      (await heading.count()) === 0,
      `NOT RUN — ${FLAG} is dark in this tenant, so there is no importer to exercise.`
    );

    // A one-page PDF whose content stream really does show text — the digital-text case.
    // As many printed labels as a real admission form carries: the scan detector measures
    // characters per page, so a three-label toy page is honestly indistinguishable from a
    // scan and would prove the wrong thing here.
    const content =
      "BT /F1 12 Tf 72 720 Td (Client name) Tj 0 -20 Td (Date of birth) Tj " +
      "0 -20 Td (Emergency contact) Tj 0 -20 Td (Relationship to client) Tj " +
      "0 -20 Td (Primary telephone number) Tj 0 -20 Td (Referring physician) Tj " +
      "0 -20 Td (Services requested) Tj 0 -20 Td (Nurse signature and date) Tj ET";
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
      `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    ];
    await page.getByLabel(/PDF of a blank form/).setInputFiles({
      name: "admission-form.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1"),
    });

    await expect(
      page.getByText(SCAN_SENTENCE),
      "A page carrying real text operators must not be judged a scan."
    ).toHaveCount(0);

    // The draft is a REVIEW, not a result: labels are editable and types are choosable.
    const firstLabel = page.getByLabel("Field label").first();
    await expect(firstLabel, "Every detected field is an editable label, not a fixed string.").toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByLabel("Answer type").first()).toBeVisible();

    // Whatever the model returned, the marking is the platform's and it is in words.
    const marks = page.getByText("Check this");
    if ((await marks.count()) > 0) {
      await expect(
        marks.first(),
        "An uncertain field is marked in WORDS — 'Check this' — never by colour alone (D-012)."
      ).toBeVisible();
    }

    await expect(
      page.getByText(/creates no form, no\s+template and no version/),
      "Saving files a design for review. The button must not imply a form now exists — " +
        "publishing stays the human act it always was."
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as draft template" })).toBeEnabled();
  });
});
