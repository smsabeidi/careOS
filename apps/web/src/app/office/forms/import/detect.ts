/**
 * The deterministic half of PDF form import (ST-237, Front Door W4).
 *
 * Everything in this file is a pure function over data the browser or the model already
 * produced, and every one of them decides something a model must never decide
 * (invariant 13):
 *
 *   · WHETHER A FILE IS A SCAN. Measured, not guessed: a digital-text PDF yields text
 *     when its content streams are decoded; a scan yields almost nothing because the
 *     page is a picture. The threshold is a count of non-whitespace characters per page,
 *     so an image-only page scores zero however large the file is. R3/3A in the program
 *     plan draws the v1 boundary here — digital text only, OCR deferred — and this
 *     function is that boundary, expressed once.
 *
 *   · WHICH FIELDS A REVIEWER MUST CHECK. The model reports a confidence per label; the
 *     threshold that turns a number into the words "Check this" belongs to the platform,
 *     not to the model's prose. Below 0.7 is marked, and marked IN WORDS — D-012 forbids
 *     a status carried by colour alone.
 *
 *   · WHAT COUNTS AS A STRUCTURE AT ALL. `parseImportedStructure` is the defensive parse
 *     between a completion and a screen: unknown field types, missing labels, options on
 *     types that cannot carry them, and absurd sizes are dropped rather than rendered.
 *     A malformed completion produces null, never a half-built form.
 *
 * Nothing here touches the network, the database, or the DOM, which is why it is the file
 * the unit gate exercises (detect.test.ts).
 *
 * @trace ST-237, docs/designs/intelligent-front-door.md W4/R3, migration 0057
 *        (form.import_pdf), invariant 13, D-012
 */

/* ══ Scan detection ═══════════════════════════════════════════════════════════ */

/**
 * Below this many non-whitespace characters per page, the file is treated as a scan.
 *
 * Why non-whitespace: a decoded content stream for an image-only page still emits
 * positioning operators and the odd stray separator, so counting raw length would let a
 * blank scan look like a page with two words on it. Why ~40: a real form page carries
 * hundreds of characters of printed labels; a page under forty is either a picture or a
 * near-empty divider, and in both cases there is nothing to convert.
 */
export const SCAN_CHARS_PER_PAGE = 40;

/** One page's extracted text, exactly as the browser-side extractor produced it. */
export type PageText = { page: number; text: string };

function nonWhitespaceLength(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n += 1;
  return n;
}

export type ScanVerdict = {
  /** true ⇒ show the honest scan fallback and stop. Nothing is sent anywhere. */
  scanned: boolean;
  pages: number;
  /** Non-whitespace characters per page, rounded to one decimal for display. */
  averageCharsPerPage: number;
};

/**
 * Average extracted characters per page, and the verdict that follows from it.
 *
 * A file with no pages returns `scanned: true`: the safe direction is the one that keeps
 * nothing and sends nothing. The surface distinguishes the two cases in its copy — no
 * pages is "we couldn't read it", not "this is a scan".
 */
export function detectScanned(pages: PageText[]): ScanVerdict {
  if (pages.length === 0) return { scanned: true, pages: 0, averageCharsPerPage: 0 };
  const total = pages.reduce((sum, p) => sum + nonWhitespaceLength(p.text), 0);
  const average = total / pages.length;
  return {
    scanned: average < SCAN_CHARS_PER_PAGE,
    pages: pages.length,
    averageCharsPerPage: Math.round(average * 10) / 10,
  };
}

/* ══ Confidence marking ═══════════════════════════════════════════════════════ */

/**
 * Below this, a detected field is marked for a human to check. The registered prompt
 * (0057) is told a garbled or ambiguous label scores below 0.6; the review threshold sits
 * deliberately above that, so a field the model was merely lukewarm about still gets a
 * second pair of eyes.
 */
export const CONFIDENCE_CHECK_THRESHOLD = 0.7;

/**
 * A field with no confidence reported is marked too. Silence about a number is not the
 * same as a good number, and the reviewer is the one who should decide which it was.
 */
export function needsCheck(confidence: number | null): boolean {
  if (confidence === null || !Number.isFinite(confidence)) return true;
  return confidence < CONFIDENCE_CHECK_THRESHOLD;
}

/* ══ The draft structure a reviewer edits ═════════════════════════════════════ */

/** The field types the registered prompt may emit (0057 · form.import_pdf rule 1). */
export const FIELD_TYPES = ["text", "date", "time", "checkbox", "radio", "signature"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Only these two carry printed choices; options on anything else are dropped. */
const TYPES_WITH_OPTIONS: ReadonlySet<FieldType> = new Set<FieldType>(["checkbox", "radio"]);

export function isFieldType(v: unknown): v is FieldType {
  return typeof v === "string" && (FIELD_TYPES as readonly string[]).includes(v);
}

export type DraftField = {
  /** Stable per-draft handle so React keys and edits survive a reorder. Never an id. */
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  /** As reported for this label, or null when the completion said nothing about it. */
  confidence: number | null;
  /** Derived from `confidence` by the platform — the reviewer sees words, not a number alone. */
  needsCheck: boolean;
};

export type DraftSection = {
  key: string;
  title: string;
  fields: DraftField[];
};

export type FormDraft = {
  sections: DraftSection[];
  fieldCount: number;
  /** How many fields carry the "Check this" mark. Reported on screen, never hidden. */
  checkCount: number;
};

/* Sizes that keep one completion from producing an unreadable screen or an oversized
 * proposal row. Chosen to be far above any real agency form and far below anything that
 * would take a browser down. */
const MAX_SECTIONS = 40;
const MAX_FIELDS_PER_SECTION = 60;
const MAX_FIELDS_TOTAL = 300;
const MAX_OPTIONS = 20;
const MAX_LABEL_CHARS = 160;
const MAX_TITLE_CHARS = 120;

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function confidenceOf(map: unknown, label: string): number | null {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const raw = (map as Record<string, unknown>)[label];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

/**
 * The defensive parse: a completion in, a renderable draft or null out. Never throws.
 *
 * The contract it enforces is 0057's, not a superset of it — sections carry a title and
 * fields; a field carries a label and one of six types; options exist only on checkbox and
 * radio. Anything else in the JSON is discarded silently HERE, and the count of what
 * survived is what the surface reports, so a reviewer is never told a form has more
 * structure than they can see.
 *
 * An empty-but-valid answer (`{"sections": []}`, the prompt's rule 7) parses to a draft
 * with zero fields rather than to null: "nothing recognisable in this file" is an honest
 * outcome the surface states in those words, and it is not the same as a broken answer.
 */
export function parseImportedStructure(raw: string | null): FormDraft | null {
  const body = (raw ?? "").trim();
  if (!body.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.sections)) return null;
  const confidence = obj.confidence;

  const sections: DraftSection[] = [];
  let fieldCount = 0;
  let checkCount = 0;

  for (const rawSection of obj.sections.slice(0, MAX_SECTIONS)) {
    if (!rawSection || typeof rawSection !== "object" || Array.isArray(rawSection)) continue;
    const s = rawSection as Record<string, unknown>;
    const title = text(s.title, MAX_TITLE_CHARS) ?? "Untitled section";
    const rawFields = Array.isArray(s.fields) ? s.fields.slice(0, MAX_FIELDS_PER_SECTION) : [];

    const fields: DraftField[] = [];
    for (const rawField of rawFields) {
      if (fieldCount >= MAX_FIELDS_TOTAL) break;
      if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) continue;
      const f = rawField as Record<string, unknown>;
      const label = text(f.label, MAX_LABEL_CHARS);
      if (!label) continue;

      // An unrecognised type is not a reason to drop a field a reviewer can fix — it
      // becomes a plain text field and inherits the "check this" mark below, because the
      // model told us something we could not use.
      const known = isFieldType(f.type);
      const type: FieldType = known ? (f.type as FieldType) : "text";

      const options = TYPES_WITH_OPTIONS.has(type) && Array.isArray(f.options)
        ? f.options
            .slice(0, MAX_OPTIONS)
            .map((o) => text(o, MAX_LABEL_CHARS))
            .filter((o): o is string => o !== null)
        : [];

      const reported = confidenceOf(confidence, label);
      const check = needsCheck(reported) || !known;

      fields.push({
        key: `f${sections.length + 1}-${fields.length + 1}`,
        label,
        type,
        options,
        confidence: reported,
        needsCheck: check,
      });
      fieldCount += 1;
      if (check) checkCount += 1;
    }

    if (fields.length === 0) continue;
    sections.push({ key: `s${sections.length + 1}`, title, fields });
  }

  return { sections, fieldCount, checkCount };
}

/**
 * Recount after a reviewer's edits. The reviewer can change a label or a type, and both
 * change what the screen should say — a field they retyped by hand is still one they
 * looked at, so its mark stays until they clear it by editing the confidence-bearing
 * label. Keeping this in one function is what stops the header count and the row marks
 * from drifting apart.
 */
export function summarizeDraft(sections: DraftSection[]): FormDraft {
  let fieldCount = 0;
  let checkCount = 0;
  for (const s of sections) {
    for (const f of s.fields) {
      fieldCount += 1;
      if (f.needsCheck) checkCount += 1;
    }
  }
  return { sections, fieldCount, checkCount };
}

/**
 * The plain-language outline filed with the draft proposal. It is what a reviewer reads
 * in the approvals inbox before opening anything, so it names the structure and, plainly,
 * how much of it wants a second look.
 */
export function draftOutline(draft: FormDraft, sourceName: string): string {
  if (draft.sections.length === 0) {
    return `No form structure was recognised in ${sourceName}. Nothing was created.`;
  }
  const lines = draft.sections.map(
    (s) => `${s.title}: ${s.fields.length} field${s.fields.length === 1 ? "" : "s"}`
  );
  const head =
    `${draft.sections.length} section${draft.sections.length === 1 ? "" : "s"} and ` +
    `${draft.fieldCount} field${draft.fieldCount === 1 ? "" : "s"} were read from ${sourceName}. ` +
    (draft.checkCount === 0
      ? "Every field was recognised clearly."
      : `${draft.checkCount} of them are marked for someone to check.`);
  return `${head}\n\n${lines.join("\n")}`;
}
