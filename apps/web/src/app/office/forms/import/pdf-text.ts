/**
 * Per-page text extraction from a PDF, in the browser, with no dependency (ST-237, W4).
 *
 * WHY THIS FILE EXISTS RATHER THAN AN IMPORT. The v1 boundary (program plan R3/3A) is
 * that the raw file NEVER leaves the coordinator's computer: only the text a page already
 * carries is sent to the server, and a scan is refused with honest copy. That requires
 * decoding a PDF client-side. CareOS ships no PDF library — apps/web depends on Next,
 * React and Supabase and nothing else — and adding a vendor to a HIPAA product is a
 * docs/09 §6 register decision, not a convenience an implementation story may take. So
 * the extraction is done here, in ~250 lines of pure string and byte work, using
 * `DecompressionStream` which the browser already has. Nothing here reaches the network.
 *
 * WHAT IT HANDLES, STATED HONESTLY BECAUSE THE PRODUCT DEPENDS ON THE LIMITS:
 *   · Uncompressed and FlateDecode content streams — between them, essentially every PDF
 *     an agency exports from Word, Google Docs, a state website or a scanner's text layer.
 *   · Literal `(…)` and hex `<…>` strings inside BT/ET text objects, with the standard
 *     kerning-implies-a-space heuristic for TJ arrays.
 *   · Page objects found directly, and — for PDF 1.5+ files that hide their page tree in a
 *     compressed object stream — a fallback that treats each decoded content stream as a
 *     page. The fallback exists because page COUNT only has to be good enough to average
 *     characters over; a form's text is the same either way.
 *
 * WHAT IT DOES NOT HANDLE, and what happens instead:
 *   · Encrypted PDFs → refused by name, nothing sent.
 *   · Image-only pages (DCTDecode, CCITTFaxDecode, JPX) → they yield no text, so the
 *     scan detector in detect.ts catches them and the surface shows the scan fallback.
 *     That is the designed behaviour, not a failure.
 *   · Subset fonts with a custom CMap can decode to nonsense. Nonsense reaches the model
 *     as low-confidence labels and the reviewer sees "Check this" on them — which is
 *     exactly what the human-review step is for. It is never silently published.
 *
 * @trace ST-237, docs/designs/intelligent-front-door.md W4/R3, invariant 5
 */

import type { PageText } from "./detect";

export type PdfExtraction =
  | { ok: true; pages: PageText[] }
  | { ok: false; reason: "not_a_pdf" | "encrypted" | "unreadable" };

/* ══ Bytes → a byte-faithful string ═══════════════════════════════════════════
   PDF structure is ASCII markers around arbitrary binary. Decoding as latin1 maps every
   byte to exactly one code unit, so string offsets and byte offsets agree — which is what
   makes `/Length` and `endstream` positions usable at all. Never UTF-8: one multi-byte
   sequence would shift every offset after it.
   ═══════════════════════════════════════════════════════════════════════════ */

function toLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/* ══ Inflate, via the platform ════════════════════════════════════════════════ */

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  // FlateDecode is zlib-wrapped in a conforming file, but real-world producers emit raw
  // deflate often enough that trying both is the difference between reading a form and
  // refusing it. Both attempts are local; neither can fail loudly.
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      // BufferSource, not Uint8Array: that is the chunk type DecompressionStream's
      // writable side declares, and matching it keeps the pipe typed rather than cast.
      const source = new ReadableStream<BufferSource>({
        start(controller) {
          // Re-wrap so the chunk is backed by a plain ArrayBuffer, which is what
          // BufferSource means. One copy of at most 2 MB, once per stream.
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
      const decompressed = source.pipeThrough(new DecompressionStream(format));
      const buffer = await new Response(decompressed).arrayBuffer();
      const out = new Uint8Array(buffer);
      if (out.length > 0) return out;
    } catch {
      // try the next format
    }
  }
  return null;
}

/* ══ Object scan ══════════════════════════════════════════════════════════════ */

type PdfObject = {
  num: number;
  /** The object's body, from after `obj` to before `endobj`. */
  body: string;
  /** Raw (still encoded) stream payload, or null when the object carries no stream. */
  stream: string | null;
};

const OBJ_HEADER = /(\d+)\s+\d+\s+obj\b/g;

function scanObjects(raw: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  OBJ_HEADER.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OBJ_HEADER.exec(raw)) !== null) {
    const num = Number(match[1]);
    const start = match.index + match[0].length;
    const end = raw.indexOf("endobj", start);
    const body = raw.slice(start, end === -1 ? Math.min(raw.length, start + 200_000) : end);

    let stream: string | null = null;
    const streamMark = body.search(/\bstream\r?\n/);
    if (streamMark !== -1) {
      const dict = body.slice(0, streamMark);
      const payloadStart = body.indexOf("\n", streamMark) + 1;
      // `/Length` is authoritative when it is a direct integer; when it is an indirect
      // reference (`/Length 12 0 R`) the `endstream` marker is what we have, and it is
      // reliable because a producer that writes one must write the other.
      const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const marker = body.indexOf("endstream", payloadStart);
      const byLength = declared ? payloadStart + Number(declared[1]) : -1;
      const payloadEnd =
        byLength > payloadStart && (marker === -1 || byLength <= marker)
          ? byLength
          : marker === -1
            ? body.length
            : marker;
      stream = body.slice(payloadStart, payloadEnd);
    }

    // Later definitions win: an incrementally-updated PDF re-declares an object, and the
    // last one in the file is the live one.
    objects.set(num, { num, body, stream });
  }
  return objects;
}

/** Filters we can undo. Anything else means the stream is a picture or unsupported. */
function decodableFilter(dict: string): "flate" | "none" | null {
  if (!/\/Filter/.test(dict)) return "none";
  if (/\/FlateDecode/.test(dict)) return "flate";
  return null;
}

async function decodeStream(object: PdfObject): Promise<string | null> {
  if (object.stream === null) return null;
  const dict = object.body.slice(0, Math.max(0, object.body.search(/\bstream\r?\n/)));
  const filter = decodableFilter(dict);
  if (filter === null) return null;
  if (filter === "none") return object.stream;
  const out = await inflate(fromLatin1(object.stream));
  return out === null ? null : toLatin1(out);
}

/* ══ Content stream → text ════════════════════════════════════════════════════ */

/** More than a tenth of an em of kerning is a word gap, not letter spacing. */
const KERN_IS_SPACE = 100;

function decodeLiteral(source: string, from: number): { text: string; next: number } {
  let depth = 1;
  let i = from;
  let out = "";
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "\\") {
      const esc = source[i + 1] ?? "";
      i += 2;
      if (esc === "n") out += "\n";
      else if (esc === "r") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "b" || esc === "f") out += " ";
      else if (esc === "\n") continue;
      else if (esc >= "0" && esc <= "7") {
        let oct = esc;
        while (oct.length < 3 && source[i] >= "0" && source[i] <= "7") oct += source[i++];
        out += String.fromCharCode(Number.parseInt(oct, 8));
      } else out += esc;
      continue;
    }
    i += 1;
    if (ch === "(") {
      depth += 1;
      out += ch;
    } else if (ch === ")") {
      depth -= 1;
      if (depth > 0) out += ch;
    } else out += ch;
  }
  return { text: out, next: i };
}

function decodeHex(source: string, from: number): { text: string; next: number } {
  const end = source.indexOf(">", from);
  const stop = end === -1 ? source.length : end;
  const digits = source.slice(from, stop).replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 1 < digits.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 16));
  }
  return { text: out, next: stop + 1 };
}

/** A run of decoded bytes that is mostly unprintable came from a font we cannot map. */
function printableEnough(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || (code >= 32 && code <= 126) || code >= 160) printable += 1;
  }
  return printable / s.length >= 0.6;
}

/**
 * Pull the shown text out of one decoded content stream.
 *
 * Exported because it is pure and worth reading on its own: it is the only place that
 * decides what "the text on this page" means, and it decides it with the PDF operators
 * rather than with a heuristic over bytes.
 */
export function textFromContentStream(content: string): string {
  let out = "";
  let i = 0;

  const push = (s: string) => {
    if (printableEnough(s)) out += s;
  };

  while (i < content.length) {
    const ch = content[i];

    if (ch === "(") {
      const literal = decodeLiteral(content, i + 1);
      push(literal.text);
      i = literal.next;
      continue;
    }

    if (ch === "<" && content[i + 1] !== "<") {
      const hex = decodeHex(content, i + 1);
      push(hex.text);
      i = hex.next;
      continue;
    }

    if (ch === "<" && content[i + 1] === "<") {
      // An inline dictionary (image or marked-content properties). Skip it whole so its
      // /Name tokens never look like text.
      const close = content.indexOf(">>", i + 2);
      i = close === -1 ? content.length : close + 2;
      continue;
    }

    if (ch === "[") {
      // A TJ array: strings interleaved with kerning numbers.
      let j = i + 1;
      let piece = "";
      while (j < content.length && content[j] !== "]") {
        const c = content[j];
        if (c === "(") {
          const literal = decodeLiteral(content, j + 1);
          if (printableEnough(literal.text)) piece += literal.text;
          j = literal.next;
          continue;
        }
        if (c === "<") {
          const hex = decodeHex(content, j + 1);
          if (printableEnough(hex.text)) piece += hex.text;
          j = hex.next;
          continue;
        }
        const kern = /^-?\d+(\.\d+)?/.exec(content.slice(j, j + 24));
        if (kern) {
          if (Number(kern[0]) <= -KERN_IS_SPACE && !piece.endsWith(" ")) piece += " ";
          j += kern[0].length;
          continue;
        }
        j += 1;
      }
      out += piece;
      i = j + 1;
      continue;
    }

    if (/[A-Za-z'"*]/.test(ch)) {
      const token = /^[A-Za-z'"*\d]+/.exec(content.slice(i, i + 16))?.[0] ?? ch;
      // Operators that end a line of type. Everything else is graphics state we ignore.
      if (
        token === "Td" ||
        token === "TD" ||
        token === "T*" ||
        token === "Tm" ||
        token === "ET" ||
        token === "BT" ||
        token === "'" ||
        token === '"'
      ) {
        if (!out.endsWith("\n")) out += "\n";
      }
      i += token.length;
      continue;
    }

    i += 1;
  }

  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, all) => line.length > 0 || all[index - 1] !== "")
    .join("\n")
    .trim();
}

/* ══ Page assembly ════════════════════════════════════════════════════════════ */

function contentRefs(pageBody: string): number[] {
  const direct = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageBody);
  if (direct) return [Number(direct[1])];
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(pageBody);
  if (!array) return [];
  return [...array[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
}

const MAX_PAGES = 60;

/**
 * Read one PDF's pages as text. Never throws; every failure is a named reason the surface
 * turns into a sentence a coordinator can act on.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<PdfExtraction> {
  let raw: string;
  try {
    raw = toLatin1(bytes);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  if (!raw.slice(0, 1024).includes("%PDF-")) return { ok: false, reason: "not_a_pdf" };
  // A password-protected or rights-managed file. We refuse by name rather than producing
  // an empty extraction that would be misreported as a scan.
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(raw)) return { ok: false, reason: "encrypted" };

  const objects = scanObjects(raw);
  if (objects.size === 0) return { ok: false, reason: "unreadable" };

  // `/Type /Page` but not `/Type /Pages` — the node, not the tree.
  const pageObjects = [...objects.values()].filter((o) => /\/Type\s*\/Page(?![sA-Za-z])/.test(o.body));

  const pages: PageText[] = [];

  if (pageObjects.length > 0) {
    for (const pageObject of pageObjects.slice(0, MAX_PAGES)) {
      const parts: string[] = [];
      for (const ref of contentRefs(pageObject.body)) {
        const target = objects.get(ref);
        if (!target) continue;
        const decoded = await decodeStream(target);
        if (decoded) parts.push(textFromContentStream(decoded));
      }
      pages.push({ page: pages.length + 1, text: parts.join("\n").trim() });
    }
  } else {
    // PDF 1.5+ with its page tree inside an object stream. Each decoded stream that
    // carries text operators is treated as one page — enough to average over, and the
    // text itself is unaffected.
    for (const object of objects.values()) {
      if (pages.length >= MAX_PAGES) break;
      if (object.stream === null) continue;
      const decoded = await decodeStream(object);
      if (!decoded || !/\bBT\b/.test(decoded)) continue;
      const text = textFromContentStream(decoded);
      if (text.length === 0) continue;
      pages.push({ page: pages.length + 1, text });
    }
  }

  if (pages.length === 0) return { ok: false, reason: "unreadable" };
  return { ok: true, pages };
}
