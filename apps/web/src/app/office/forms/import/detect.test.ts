/**
 * The two decisions PDF form import must never get wrong, proven (ST-237, W4).
 *
 * 1. SCAN DETECTION IS THE PRODUCT BOUNDARY. R3/3A says v1 converts digital text and
 *    tells the truth about scans. If this threshold drifts, a scanned COMAR form either
 *    reaches a model as forty characters of noise (and comes back as an invented form) or
 *    a perfectly readable form is refused. Both are worse than the honest fallback, so the
 *    boundary is pinned here rather than left to a comment.
 *
 * 2. "CHECK THIS" IS A PLATFORM DECISION, NOT A MODEL ONE. The model reports a number; the
 *    platform decides which numbers a human must look at, and says so in words (D-012).
 *    These cases pin the threshold, the treatment of a missing confidence, and the
 *    treatment of a type the model made up.
 *
 * Everything under test is pure: no network, no database, no DOM.
 */

import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_CHECK_THRESHOLD,
  SCAN_CHARS_PER_PAGE,
  detectScanned,
  draftOutline,
  needsCheck,
  parseImportedStructure,
  summarizeDraft,
  type PageText,
} from "./detect";

const page = (n: number, text: string): PageText => ({ page: n, text });

/** A page of a real printed form: labels, plenty of them. */
const FORM_PAGE =
  "Client name ____________  Date of birth ____/____/____  Address ______________________\n" +
  "Emergency contact _______________  Relationship __________  Phone ____________________";

describe("detectScanned — the digital-text boundary (R3/3A)", () => {
  it("treats a page of printed labels as digital text", () => {
    const verdict = detectScanned([page(1, FORM_PAGE), page(2, FORM_PAGE)]);
    expect(verdict.scanned).toBe(false);
    expect(verdict.pages).toBe(2);
    expect(verdict.averageCharsPerPage).toBeGreaterThan(SCAN_CHARS_PER_PAGE);
  });

  it("treats an image-only page — whitespace and stray marks only — as a scan", () => {
    // What a decoded content stream for a scanned page actually yields: positioning
    // whitespace and the odd separator. Nothing to convert.
    const verdict = detectScanned([page(1, "\n \n  \n"), page(2, "  -  \n")]);
    expect(verdict.scanned).toBe(true);
    expect(verdict.averageCharsPerPage).toBeLessThan(SCAN_CHARS_PER_PAGE);
  });

  it("counts non-whitespace only, so padding cannot fake a text layer", () => {
    // 20 real characters buried in 4000 spaces is still 20 characters of form.
    const padded = " ".repeat(2000) + "Name Date Signature" + " ".repeat(2000);
    const verdict = detectScanned([page(1, padded)]);
    expect(verdict.scanned).toBe(true);
    expect(verdict.averageCharsPerPage).toBeLessThan(SCAN_CHARS_PER_PAGE);
  });

  it("averages across pages rather than judging each one", () => {
    // A cover sheet with almost nothing on it must not condemn a readable packet.
    const verdict = detectScanned([page(1, "Form 1041"), page(2, FORM_PAGE), page(3, FORM_PAGE)]);
    expect(verdict.scanned).toBe(false);
  });

  it("sits exactly on the stated threshold, in both directions", () => {
    const justUnder = "x".repeat(SCAN_CHARS_PER_PAGE - 1);
    const exactly = "x".repeat(SCAN_CHARS_PER_PAGE);
    expect(detectScanned([page(1, justUnder)]).scanned).toBe(true);
    expect(detectScanned([page(1, exactly)]).scanned).toBe(false);
  });

  it("calls a file with no readable pages a stop, not a conversion", () => {
    const verdict = detectScanned([]);
    expect(verdict.scanned).toBe(true);
    expect(verdict.pages).toBe(0);
    expect(verdict.averageCharsPerPage).toBe(0);
  });
});

describe("needsCheck — which fields a reviewer is told to check", () => {
  it("marks anything below the threshold and clears anything at or above it", () => {
    expect(needsCheck(CONFIDENCE_CHECK_THRESHOLD - 0.01)).toBe(true);
    expect(needsCheck(CONFIDENCE_CHECK_THRESHOLD)).toBe(false);
    expect(needsCheck(0.99)).toBe(false);
    expect(needsCheck(0)).toBe(true);
  });

  it("marks a field the model said nothing about — silence is not a good score", () => {
    expect(needsCheck(null)).toBe(true);
    expect(needsCheck(Number.NaN)).toBe(true);
  });
});

describe("parseImportedStructure — the defensive parse between a completion and a screen", () => {
  const completion = JSON.stringify({
    sections: [
      {
        title: "Client details",
        fields: [
          { label: "Client name", type: "text" },
          { label: "Date of birth", type: "date" },
          { label: "Preferred contact", type: "radio", options: ["Phone", "Email"] },
        ],
      },
      {
        title: "Signatures",
        fields: [{ label: "Nurse signature", type: "signature" }],
      },
    ],
    confidence: {
      "Client name": 0.95,
      "Date of birth": 0.62,
      "Preferred contact": 0.71,
      "Nurse signature": 0.4,
    },
  });

  it("keeps the structure and marks exactly the fields under the threshold", () => {
    const draft = parseImportedStructure(completion);
    expect(draft).not.toBeNull();
    expect(draft?.sections).toHaveLength(2);
    expect(draft?.fieldCount).toBe(4);
    // 0.62 and 0.4 are under 0.7; 0.95 and 0.71 are not.
    expect(draft?.checkCount).toBe(2);

    const marked = draft!.sections.flatMap((s) => s.fields).filter((f) => f.needsCheck);
    expect(marked.map((f) => f.label).sort()).toEqual(["Date of birth", "Nurse signature"]);
  });

  it("marks a field whose confidence was never reported", () => {
    const draft = parseImportedStructure(
      JSON.stringify({
        sections: [{ title: "S", fields: [{ label: "Unscored field", type: "text" }] }],
        confidence: {},
      })
    );
    expect(draft?.sections[0].fields[0].confidence).toBeNull();
    expect(draft?.sections[0].fields[0].needsCheck).toBe(true);
    expect(draft?.checkCount).toBe(1);
  });

  it("keeps a field whose type it does not recognise, as text, and marks it", () => {
    // Dropping it would hide a real field from the reviewer; trusting it would put a
    // type the forms engine has never heard of into a saved design.
    const draft = parseImportedStructure(
      JSON.stringify({
        sections: [{ title: "S", fields: [{ label: "Weight in kg", type: "number" }] }],
        confidence: { "Weight in kg": 0.98 },
      })
    );
    const field = draft?.sections[0].fields[0];
    expect(field?.type).toBe("text");
    expect(field?.needsCheck).toBe(true);
  });

  it("drops options from types that cannot carry printed choices", () => {
    const draft = parseImportedStructure(
      JSON.stringify({
        sections: [
          {
            title: "S",
            fields: [
              { label: "Notes", type: "text", options: ["a", "b"] },
              { label: "Consent given", type: "checkbox", options: ["Yes", "No"] },
            ],
          },
        ],
        confidence: { Notes: 0.9, "Consent given": 0.9 },
      })
    );
    expect(draft?.sections[0].fields[0].options).toEqual([]);
    expect(draft?.sections[0].fields[1].options).toEqual(["Yes", "No"]);
  });

  it("drops fields with no label and sections left empty by that", () => {
    const draft = parseImportedStructure(
      JSON.stringify({
        sections: [
          { title: "Nothing usable", fields: [{ type: "text" }, { label: "   " }] },
          { title: "Real", fields: [{ label: "Client name", type: "text" }] },
        ],
        confidence: { "Client name": 0.9 },
      })
    );
    expect(draft?.sections).toHaveLength(1);
    expect(draft?.sections[0].title).toBe("Real");
  });

  it("returns an empty draft — not null — for the prompt's honest 'nothing here' answer", () => {
    const draft = parseImportedStructure(JSON.stringify({ sections: [], confidence: {} }));
    expect(draft).not.toBeNull();
    expect(draft?.fieldCount).toBe(0);
  });

  it("returns null for anything that is not a structure at all", () => {
    expect(parseImportedStructure(null)).toBeNull();
    expect(parseImportedStructure("")).toBeNull();
    expect(parseImportedStructure("I could not read that form.")).toBeNull();
    expect(parseImportedStructure("{ not json")).toBeNull();
    expect(parseImportedStructure(JSON.stringify({ fields: [] }))).toBeNull();
    expect(parseImportedStructure(JSON.stringify([{ title: "x" }]))).toBeNull();
  });
});

describe("summarizeDraft + draftOutline — the counts a reviewer is shown", () => {
  it("recounts after an edit rather than trusting the first count", () => {
    const draft = parseImportedStructure(
      JSON.stringify({
        sections: [
          {
            title: "S",
            fields: [
              { label: "A", type: "text" },
              { label: "B", type: "text" },
            ],
          },
        ],
        confidence: { A: 0.9, B: 0.2 },
      })
    );
    const edited = draft!.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => (f.label === "B" ? { ...f, needsCheck: false } : f)),
    }));
    expect(summarizeDraft(edited).checkCount).toBe(0);
    expect(summarizeDraft(edited).fieldCount).toBe(2);
  });

  it("says plainly how much of the draft wants a second look", () => {
    const draft = summarizeDraft(
      parseImportedStructure(
        JSON.stringify({
          sections: [{ title: "Client details", fields: [{ label: "Client name", type: "text" }] }],
          confidence: { "Client name": 0.2 },
        })
      )!.sections
    );
    const outline = draftOutline(draft, "admission-form.pdf");
    expect(outline).toContain("admission-form.pdf");
    expect(outline).toContain("1 of them are marked for someone to check");
    expect(outline).toContain("Client details: 1 field");
  });

  it("says nothing was created when nothing was recognised", () => {
    expect(draftOutline({ sections: [], fieldCount: 0, checkCount: 0 }, "blank.pdf")).toContain(
      "Nothing was created"
    );
  });
});
