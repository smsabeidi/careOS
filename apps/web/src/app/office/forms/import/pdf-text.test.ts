/**
 * The extractor is the riskiest code in PDF form import, so it is the code with the most
 * proof (ST-237, W4).
 *
 * It is hand-written rather than imported — CareOS ships no PDF library and adding a
 * vendor is a docs/09 §6 decision, not an implementation detail — which means the usual
 * "the dependency is tested upstream" argument does not apply here. Every claim the panel
 * makes rests on this file: that a digital-text form yields its printed labels, that an
 * image-only page yields nothing and is therefore caught by the scan detector, and that a
 * protected file is refused by name instead of quietly looking like a scan.
 *
 * The fixtures are built byte by byte in this file on purpose. A binary fixture would hide
 * the one thing each case turns on — whether the page carries text operators at all.
 */

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { detectScanned } from "./detect";
import { extractPdfPages, textFromContentStream } from "./pdf-text";

function pdf(objects: string[]): Uint8Array {
  const body = `%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

const CATALOG = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
const PAGES = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
const PAGE = "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n";

function plainStream(content: string): string {
  return `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
}

function flateStream(content: string): string {
  const compressed = deflateSync(Buffer.from(content, "latin1"));
  let payload = "";
  for (const byte of compressed) payload += String.fromCharCode(byte);
  return `4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${payload}\nendstream\nendobj\n`;
}

/**
 * A page's worth of printed labels — deliberately as many as a real admission form carries,
 * because the scan detector measures characters per page and a three-label toy page really
 * IS indistinguishable from a scan. The threshold is right; a fixture thin enough to trip it
 * would be testing the fixture.
 */
const FORM_CONTENT =
  "BT /F1 12 Tf 72 720 Td (Client name) Tj 0 -20 Td (Date of birth) Tj " +
  "0 -20 Td (Emergency contact) Tj 0 -20 Td (Relationship to client) Tj " +
  "0 -20 Td (Primary telephone number) Tj 0 -20 Td (Referring physician) Tj " +
  "0 -20 Td (Services requested) Tj 0 -20 Td (Nurse signature and date) Tj ET";

describe("textFromContentStream — what 'the text on this page' means", () => {
  it("reads literal strings shown with Tj", () => {
    expect(textFromContentStream("BT (Client name) Tj ET")).toContain("Client name");
  });

  it("joins a TJ array and turns a wide kern into the space it represents", () => {
    // [(Name) -500 (Date)] is two words with a gap, not one word "NameDate".
    const text = textFromContentStream("BT [(Name) -500 (Date)] TJ ET");
    expect(text).toContain("Name Date");
    // Letter-level kerning inside one word must NOT become a space.
    expect(textFromContentStream("BT [(Cli) -20 (ent)] TJ ET")).toContain("Client");
  });

  it("reads hex strings", () => {
    // "Signature" in hex.
    expect(textFromContentStream("BT <5369676E6174757265> Tj ET")).toContain("Signature");
  });

  it("honours escapes inside literal strings, including balanced parens", () => {
    expect(textFromContentStream("BT (Phone \\(home\\)) Tj ET")).toContain("Phone (home)");
    expect(textFromContentStream("BT (Line one\\nLine two) Tj ET")).toContain("Line one");
  });

  it("emits nothing for a content stream that draws no text", () => {
    expect(textFromContentStream("0 0 0 RG 1 w 10 10 m 200 200 l S")).toBe("");
  });

  it("does not mistake an inline dictionary's names for text", () => {
    const text = textFromContentStream("BT /F1 12 Tf << /Type /XObject /Subtype /Image >> (Real label) Tj ET");
    expect(text).toContain("Real label");
    expect(text).not.toContain("XObject");
  });
});

describe("extractPdfPages — a whole file, end to end", () => {
  it("reads an uncompressed digital-text page and does not call it a scan", async () => {
    const result = await extractPdfPages(pdf([CATALOG, PAGES, PAGE, plainStream(FORM_CONTENT)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain("Client name");
    expect(result.pages[0].text).toContain("Emergency contact");
    expect(detectScanned(result.pages).scanned).toBe(false);
  });

  it("inflates a FlateDecode content stream — the case almost every real PDF is", async () => {
    const result = await extractPdfPages(pdf([CATALOG, PAGES, PAGE, flateStream(FORM_CONTENT)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages[0].text).toContain("Date of birth");
    expect(detectScanned(result.pages).scanned).toBe(false);
  });

  it("yields an empty page for an image-only page, so the scan detector catches it", async () => {
    // This is the whole v1 boundary (R3/3A): a scanned page has structure and no text.
    const result = await extractPdfPages(
      pdf([CATALOG, PAGES, PAGE, plainStream("0 0 0 RG 1 w 10 10 m 200 200 l S")])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages[0].text).toBe("");
    expect(detectScanned(result.pages).scanned).toBe(true);
  });

  it("refuses a protected file by name rather than letting it look like a scan", async () => {
    const encrypted = pdf([
      CATALOG,
      PAGES,
      PAGE,
      plainStream(FORM_CONTENT),
      "9 0 obj\n<< /Filter /Standard /V 2 >>\nendobj\n",
    ]);
    // The trailer reference is what a real encrypted file carries.
    const withRef = new TextEncoder().encode(
      new TextDecoder("latin1").decode(encrypted).replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 9 0 R")
    );
    const result = await extractPdfPages(withRef);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("encrypted");
  });

  it("refuses something that is not a PDF at all", async () => {
    const result = await extractPdfPages(new TextEncoder().encode("Dear team, please find attached…"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_a_pdf");
  });

  it("falls back to content streams when the page tree is hidden in an object stream", async () => {
    // A PDF 1.5+ file whose /Type /Page objects live inside a compressed object stream:
    // no page object is visible to a direct scan, but the text still is.
    const result = await extractPdfPages(pdf([CATALOG, plainStream(FORM_CONTENT)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain("Client name");
  });
});
