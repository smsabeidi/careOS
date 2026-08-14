"use client";

/**
 * "Import from PDF" — the reviewer's surface (ST-237, Front Door W4).
 *
 * The shape of this panel is the promise it makes: THE FILE NEVER LEAVES THIS COMPUTER.
 * The picker hands the bytes to a dynamically-imported extractor that runs in this tab;
 * only the text those pages already carried is sent to the server, and only after the
 * scan check has passed. The copy says so above the picker, because a coordinator holding
 * a client's admission packet deserves to know where it goes before they choose it.
 *
 * FOUR STATES, EACH WITH ITS OWN HONEST SENTENCE (docs/10):
 *   · empty      — nothing chosen; what this does and what it will not do.
 *   · loading    — reading in the browser, then converting on the server; both named.
 *   · error      — too large, not a PDF, encrypted, unreadable, or the model unavailable.
 *                  Every one says what was kept (nothing) and what to do next.
 *   · success    — the draft, editable, with every uncertain field marked in WORDS.
 *
 * The scan path is a state of its own and it is a full stop, not a lesser success: v1
 * converts digital text (program plan R3/3A), so a scan is refused in plain language
 * rather than sent to a model that would invent a form out of forty characters of noise.
 *
 * ACCESSIBILITY. Real `<button>`, a real `<label>` on every input and select, status
 * announced through a polite live region, and every mark carried by words as well as a
 * glyph — a field is "Check this", never merely amber (D-012).
 */

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Badge, SectionTitle } from "@/components/ui";
import { IconAlert, IconCheck, IconSparkle } from "@/components/icons";
import {
  FIELD_TYPES,
  detectScanned,
  summarizeDraft,
  type DraftField,
  type DraftSection,
  type FieldType,
} from "./detect";
import { importFormStructure, saveDraftTemplate } from "./actions";

/** Client-enforced. The server never sees the file, so this is where the limit lives. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Keeps one server-action body small; the action slices again for the prompt itself. */
const MAX_TEXT_CHARS = 40_000;

const TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  date: "Date",
  time: "Time",
  checkbox: "Tick box",
  radio: "Choose one",
  signature: "Signature",
};

const SCAN_COPY =
  "This looks like a scanned document — we can't convert scans yet. We've kept nothing; the original stays on your computer.";

type Phase = "empty" | "reading" | "converting" | "saving" | "scanned" | "review" | "saved";

export function PdfImportPanel() {
  const [phase, setPhase] = useState<Phase>("empty");
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>("");
  const [pageCount, setPageCount] = useState(0);
  const [sections, setSections] = useState<DraftSection[]>([]);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setPhase("empty");
    setError(null);
    setSourceName("");
    setPageCount(0);
    setSections([]);
    setInteractionId(null);
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  const onPick = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    setError(null);
    setSections([]);
    setSourceName(file.name.slice(0, 120));
    setPhase("reading");

    try {
      if (file.size > MAX_BYTES) {
        setPhase("empty");
        setError(
          "That file is larger than 2 MB, which is the most this can read in a browser. Nothing was read and nothing was sent — try exporting just the form's pages."
        );
        return;
      }
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setPhase("empty");
        setError("That isn't a PDF. Nothing was read and nothing was sent — choose a PDF of the blank form.");
        return;
      }

      // The extractor is code-split: a coordinator who never imports a form never
      // downloads a PDF parser.
      const { extractPdfPages } = await import("./pdf-text");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extraction = await extractPdfPages(bytes);

      if (!extraction.ok) {
        setPhase("empty");
        setError(
          extraction.reason === "encrypted"
            ? "That PDF is password-protected, so its text can't be read here. Nothing was read and nothing was sent — save an unprotected copy and try again."
            : extraction.reason === "not_a_pdf"
              ? "That file isn't a PDF we can read. Nothing was read and nothing was sent."
              : "We couldn't read the pages of that PDF. Nothing was read and nothing was sent — the original is untouched on your computer."
        );
        return;
      }

      const verdict = detectScanned(extraction.pages);
      setPageCount(verdict.pages);
      if (verdict.scanned) {
        setPhase("scanned");
        return;
      }

      setPhase("converting");
      const text = extraction.pages
        .map((p) => p.text)
        .join("\n\n")
        .slice(0, MAX_TEXT_CHARS);

      const result = await importFormStructure({
        sourceName: file.name.slice(0, 120),
        pageCount: verdict.pages,
        text,
      });
      setInteractionId(result.interactionId);

      if (!result.ok || !result.draft) {
        setPhase("empty");
        setError(result.notice ?? "That didn't go through. Nothing was saved — try again.");
        return;
      }

      setSections(result.draft.sections);
      setPhase("review");
    } catch {
      setPhase("empty");
      setError(
        "Something went wrong reading that file. Nothing was read, nothing was sent and nothing was saved — the original is untouched on your computer."
      );
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }, []);

  function editField(sectionKey: string, fieldKey: string, patch: Partial<DraftField>) {
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sectionKey
          ? s
          : {
              ...s,
              fields: s.fields.map((f) => (f.key === fieldKey ? { ...f, ...patch } : f)),
            }
      )
    );
  }

  function editTitle(sectionKey: string, title: string) {
    setSections((prev) => prev.map((s) => (s.key === sectionKey ? { ...s, title } : s)));
  }

  async function onSave() {
    setError(null);
    setPhase("saving");
    const res = await saveDraftTemplate({ sourceName, pageCount, sections, interactionId });
    if (!res.ok) {
      setPhase("review");
      setError(res.error ?? "That draft couldn't be filed. Nothing was saved — your edits are still here.");
      return;
    }
    setPhase("saved");
  }

  const draft = summarizeDraft(sections);
  const busy = phase === "reading" || phase === "converting" || phase === "saving";

  return (
    <section aria-labelledby="form-import-heading" className="mt-8">
      <SectionTitle icon={<IconSparkle />}>
        <span id="form-import-heading">Import from PDF</span>
      </SectionTitle>

      <div className="card px-5 py-5">
        {/* ── The promise, before the picker ─────────────────────────────────── */}
        <p className="text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Choose a PDF of a <strong>blank</strong> form. Your browser reads the words already printed on
          its pages and sends only those words — the file itself never leaves this computer, and nothing
          is stored until you save the draft.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Use blank forms. The text of a filled-in form is somebody&rsquo;s details, and this reads the
          whole page. Scans and photographs can&rsquo;t be converted yet.
        </p>

        {/* ── Picker ─────────────────────────────────────────────────────────── */}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="label mb-1.5 block" htmlFor="form-import-file">
              PDF of a blank form (up to 2 MB)
            </label>
            <input
              ref={fileInput}
              id="form-import-file"
              className="input"
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(e) => void onPick(e.target.files)}
            />
          </div>
          {(phase === "review" || phase === "scanned" || phase === "saved") && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
              Start again
            </button>
          )}
        </div>

        {/* ── Live status (loading) ──────────────────────────────────────────── */}
        <p className="mt-3 min-h-5 text-[13px]" aria-live="polite" style={{ color: "var(--text-muted)" }}>
          {phase === "reading"
            ? "Reading the pages in your browser…"
            : phase === "converting"
              ? "Turning those words into a form structure…"
              : phase === "saving"
                ? "Filing the draft for review…"
                : ""}
        </p>

        {/* ── Error ──────────────────────────────────────────────────────────── */}
        {error && (
          <div
            role="alert"
            className="card-inset mt-3 flex items-start gap-2 px-4 py-3 text-[13px] leading-relaxed"
          >
            <span className="mt-0.5 shrink-0" style={{ color: "var(--color-danger-600)" }}>
              <IconAlert width={16} height={16} />
            </span>
            <span>{error}</span>
          </div>
        )}

        {/* ── Scan: a full stop, in the plainest words we have ────────────────── */}
        {phase === "scanned" && (
          <div role="status" className="card-inset mt-3 px-4 py-4">
            <p className="text-[14px] font-medium">Scanned document</p>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {SCAN_COPY}
            </p>
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              If the form exists as a Word or Google document, export that to PDF and try again — a PDF
              made from a document carries its words; a scan carries a picture of them.
            </p>
          </div>
        )}

        {/* ── Empty ──────────────────────────────────────────────────────────── */}
        {phase === "empty" && !error && (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
            No file chosen yet.
          </p>
        )}
      </div>

      {/* ── Review (success) ─────────────────────────────────────────────────── */}
      {(phase === "review" || phase === "saving") && (
        <div className="mt-4">
          <div className="card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="text-[14px] font-medium">
                {draft.sections.length} section{draft.sections.length === 1 ? "" : "s"} ·{" "}
                {draft.fieldCount} field{draft.fieldCount === 1 ? "" : "s"} read from{" "}
                {sourceName || "your PDF"}
              </p>
              <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {draft.checkCount === 0
                  ? "Every field was read clearly. Check the labels anyway — you know the form."
                  : `${draft.checkCount} field${draft.checkCount === 1 ? " is" : "s are"} marked \u201cCheck this\u201d. Edit a label or tick \u201cI\u2019ve checked this\u201d to clear the mark.`}
              </p>
            </div>
            {draft.checkCount === 0 ? (
              <Badge tone="success" icon={<IconCheck />}>
                Nothing left to check
              </Badge>
            ) : (
              <Badge tone="warning" icon={<IconAlert />}>
                {draft.checkCount} to check
              </Badge>
            )}
          </div>

          {sections.map((section) => (
            <div key={section.key} className="card mt-3 px-5 py-5">
              <label className="label mb-1.5 block" htmlFor={`section-${section.key}`}>
                Section name
              </label>
              <input
                id={`section-${section.key}`}
                className="input"
                value={section.title}
                onChange={(e) => editTitle(section.key, e.target.value)}
              />

              <ul className="mt-4 flex flex-col gap-4">
                {section.fields.map((field) => (
                  <li key={field.key} className="card-inset px-4 py-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-[16rem] flex-1">
                        <label className="label mb-1.5 block" htmlFor={`label-${section.key}-${field.key}`}>
                          Field label
                        </label>
                        <input
                          id={`label-${section.key}-${field.key}`}
                          className="input"
                          value={field.label}
                          onChange={(e) =>
                            editField(section.key, field.key, {
                              label: e.target.value,
                              // A label the reviewer retyped is a label somebody looked at.
                              needsCheck: false,
                            })
                          }
                        />
                      </div>
                      <div>
                        <label className="label mb-1.5 block" htmlFor={`type-${section.key}-${field.key}`}>
                          Answer type
                        </label>
                        <select
                          id={`type-${section.key}-${field.key}`}
                          className="select"
                          value={field.type}
                          onChange={(e) =>
                            editField(section.key, field.key, {
                              type: e.target.value as FieldType,
                              needsCheck: false,
                            })
                          }
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {TYPE_LABEL[t]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {field.options.length > 0 && (
                      <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Choices read from the form: {field.options.join(", ")}
                      </p>
                    )}

                    {field.needsCheck && (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Badge tone="warning" icon={<IconAlert />}>
                          Check this
                        </Badge>
                        <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                          {field.confidence === null
                            ? "This field came back without a confidence score."
                            : `Read with ${Math.round(field.confidence * 100)}% confidence.`}
                        </span>
                        <label
                          className="flex items-center gap-2 text-[12px]"
                          htmlFor={`checked-${section.key}-${field.key}`}
                        >
                          <input
                            id={`checked-${section.key}-${field.key}`}
                            type="checkbox"
                            checked={false}
                            onChange={() => editField(section.key, field.key, { needsCheck: false })}
                          />
                          I&rsquo;ve checked this
                        </label>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="card mt-3 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Saving files this as a <strong>draft design</strong> for review. It creates no form, no
              template and no version — publishing a design as a form people can fill in is still done
              by an administrator.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => void onSave()} disabled={busy}>
              Save as draft template
            </button>
          </div>
        </div>
      )}

      {/* ── Saved ────────────────────────────────────────────────────────────── */}
      {phase === "saved" && (
        <div role="status" className="card mt-4 px-5 py-5">
          <p className="text-[15px] font-medium">Draft saved for review</p>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            The design read from {sourceName || "your PDF"} is filed in the approvals inbox. Nothing is a
            live form yet, no existing form or version changed, and your PDF never left this computer.
          </p>
          <p className="mt-3 text-[13px]">
            {/* The id travels nowhere: /inbox takes a tab, not a row, and a proposal id in a
                URL is an identifier in a browser history for no gain (invariant 5). */}
            <Link className="btn btn-secondary btn-sm" href="/inbox">
              Open the approvals inbox
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}
