"use client";

/**
 * Intake workbench — the coordinator-facing half of "paper becomes chart" (docs/16 C6/C7).
 *
 * Three things happen on this surface, and the order matters:
 *   1. Pages are added from the device. They are read with FileReader, downscaled in the
 *      browser, and sent once. They are never uploaded to storage and never written to
 *      disk on the server — CareOS records the values a person accepted and which page
 *      each came from, not the image. That is stated on screen, because a coordinator
 *      scanning a stack of paper deserves to know where it goes.
 *   2. The extraction comes back as a SIDE-BY-SIDE review: the pages on the left, every
 *      extracted field on the right with its confidence, its page reference, and an
 *      editable value. Nothing is committed by reading it.
 *   3. A person accepts fields — one at a time, or every high-confidence one at once —
 *      and then presses Commit. Commit is the only thing that creates a chart.
 *
 * The four-state doctrine is applied per region, not per page: the review has its own
 * loading, empty, error and content states, and so do the upload tray and the triage box.
 * Every degraded path says what happened, what is preserved, and what to do next — with
 * the model unavailable this surface still opens jobs, still shows the deterministic
 * checklist, and still lets a person work.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, EmptyState, SectionTitle } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClipboard,
  IconClipboardCheck,
  IconPlus,
  IconSparkle,
  IconX,
} from "@/components/icons";
import {
  acceptField,
  acceptHighConfidence,
  commitIntake,
  refreshJob,
  runIntakeExtraction,
  triageReferral,
  type ExtractedField,
  type ExtractionJobView,
  type IntakeKind,
  type TriageResult,
  type UploadedPage,
} from "./actions";

const MAX_PAGES = 6;
/** Long-edge cap for the downscale. Enough for small print, small enough to send. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;
/** Keep the whole action body inside Next's ~1MB default. */
const MAX_TOTAL_CHARS = 900_000;

const KINDS: { key: IntakeKind; label: string; blurb: string }[] = [
  {
    key: "intake_packet",
    label: "Intake packet",
    blurb: "A referral or admission packet for a person the agency may serve.",
  },
  {
    key: "credential_doc",
    label: "Credential document",
    blurb: "A certificate, licence, or screening result belonging to a staff member.",
  },
];

/* ── Page handling: FileReader → downscale → data URL ─────────────────────────── */

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Shrink in the browser so the page fits in one server-action body. Never upscales. */
function downscale(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longest = Math.max(img.width, img.height);
      const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* ── Small presentational helpers ─────────────────────────────────────────────── */

function confidenceBand(c: number | null): { tone: "success" | "warning" | "danger" | "neutral"; label: string } {
  if (c === null || Number.isNaN(c)) return { tone: "neutral", label: "No confidence recorded" };
  if (c >= 0.9) return { tone: "success", label: `High · ${Math.round(c * 100)}%` };
  if (c >= 0.7) return { tone: "warning", label: `Medium · ${Math.round(c * 100)}%` };
  return { tone: "danger", label: `Low · ${Math.round(c * 100)}%` };
}

function PagePanel({ pages, job }: { pages: UploadedPage[]; job: ExtractionJobView }) {
  if (pages.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        {pages.map((p, i) => (
          <figure key={`${p.name}-${i}`} className="card overflow-hidden">
            <div
              role="img"
              aria-label={`Page ${i + 1} of the uploaded document`}
              className="h-64 w-full"
              style={{
                background: `var(--color-surface-100) url(${p.dataUrl}) center / contain no-repeat`,
              }}
            />
            <figcaption
              className="border-t px-4 py-2 text-[12px] hairline"
              style={{ color: "var(--text-muted)" }}
            >
              Page {i + 1} · {p.name}
            </figcaption>
          </figure>
        ))}
        <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          These pages are held in this browser tab only. CareOS stores the values a person accepts and
          the page each one came from — not the image.
        </p>
      </div>
    );
  }

  return (
    <div className="card px-5 py-5">
      <p className="text-[14px] font-medium">{job.source_name ?? "Uploaded document"}</p>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {job.page_count ?? 0} page{job.page_count === 1 ? "" : "s"} · opened{" "}
        {new Date(job.created_at).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </p>
      <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        The page images are not kept. Each field below carries the page it was read from, so a reviewer
        can check it against the paper in front of them.
      </p>
    </div>
  );
}

/* ── The workbench ────────────────────────────────────────────────────────────── */

export function IntakeWorkbench({
  initialJob,
  canReview,
}: {
  initialJob: ExtractionJobView | null;
  /** false ⇒ this account can read the review but not accept or commit (RLS decides too). */
  canReview: boolean;
}) {
  const router = useRouter();

  const [kind, setKind] = useState<IntakeKind>("intake_packet");
  const [pages, setPages] = useState<UploadedPage[]>([]);
  const [pagesForJobId, setPagesForJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ExtractionJobView | null>(initialJob);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<{ clientId?: string; message?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Follow the server when the URL selects a different job; never clobber a job this tab
  // just produced (the page re-renders on revalidate and the prop identity changes).
  const serverJobId = useRef(initialJob?.id ?? null);
  useEffect(() => {
    const id = initialJob?.id ?? null;
    if (id !== serverJobId.current) {
      serverJobId.current = id;
      setJob(initialJob);
      setDrafts({});
      setCommitResult(null);
      setReviewError(null);
    }
  }, [initialJob]);

  const addFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploadError(null);
      setBusy("files");
      try {
        const room = MAX_PAGES - pages.length;
        if (room <= 0) {
          setUploadError(`That's the limit — ${MAX_PAGES} pages at a time. Read these, then add the rest.`);
          return;
        }
        const picked = Array.from(files).slice(0, room);
        const next: UploadedPage[] = [];
        for (const file of picked) {
          if (!file.type.startsWith("image/")) {
            setUploadError("Add page images. For a PDF, export or photograph each page first.");
            continue;
          }
          const raw = await readAsDataUrl(file);
          const shrunk = await downscale(raw);
          next.push({ name: file.name.slice(0, 120), mime: "image/jpeg", dataUrl: shrunk });
        }
        const combined = [...pages, ...next];
        const total = combined.reduce((n, p) => n + p.dataUrl.length, 0);
        if (total > MAX_TOTAL_CHARS) {
          setUploadError("Those pages are too large together. Try fewer pages in one go.");
          return;
        }
        setPages(combined);
      } catch {
        setUploadError("We couldn't open that file. Nothing was added — try another image.");
      } finally {
        setBusy(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [pages]
  );

  async function extract() {
    if (pages.length === 0) return;
    setBusy("extract");
    setUploadError(null);
    setReviewError(null);
    setCommitResult(null);
    try {
      const res = await runIntakeExtraction({
        kind,
        sourceName: pages[0]?.name ?? "Uploaded document",
        pages,
      });
      if (!res.ok || !res.job) {
        setUploadError(res.error ?? "That didn't go through. Nothing was saved — try again.");
        return;
      }
      setJob(res.job);
      setPagesForJobId(res.job.id);
      setDrafts({});
      serverJobId.current = res.job.id;
      router.refresh(); // the recent-jobs list on the server half
    } catch {
      setUploadError("That didn't go through. Nothing was saved — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function resync(jobId: string) {
    const fresh = await refreshJob(jobId);
    if (fresh) setJob(fresh);
  }

  async function onAccept(field: ExtractedField, accepted: boolean) {
    if (!job) return;
    setBusy(field.id);
    setReviewError(null);
    const value = drafts[field.id] ?? field.accepted_value ?? field.extracted_value ?? "";
    const res = await acceptField(field.id, value, accepted);
    if (!res.ok) setReviewError(res.error ?? "That decision couldn't be saved.");
    else await resync(job.id);
    setBusy(null);
  }

  async function onSweep() {
    if (!job) return;
    setBusy("sweep");
    setReviewError(null);
    const res = await acceptHighConfidence(job.id);
    if (!res.ok) setReviewError(res.error ?? "Those fields couldn't be accepted.");
    else await resync(job.id);
    setBusy(null);
  }

  async function onCommit() {
    if (!job) return;
    setBusy("commit");
    setReviewError(null);
    const res = await commitIntake(job.id);
    if (!res.ok) {
      setReviewError(res.error ?? "That couldn't be committed.");
    } else {
      setCommitResult({ clientId: res.clientId, message: res.message });
      await resync(job.id);
      router.refresh();
    }
    setBusy(null);
  }

  const fields = job?.fields ?? [];
  const decided = fields.filter((f) => f.accepted !== null).length;
  const acceptedCount = fields.filter((f) => f.accepted === true).length;
  const sweepable = fields.filter((f) => f.accepted === null && (f.confidence ?? 0) >= 0.9).length;
  const committed = job?.status === "committed";

  return (
    <div className="flex flex-col gap-8">
      {/* ── 1. Upload tray ─────────────────────────────────────────────────── */}
      <section aria-labelledby="intake-upload">
        <SectionTitle icon={<IconClipboard />}>
          <span id="intake-upload">Read a document</span>
        </SectionTitle>

        <div className="card px-5 py-5">
          <fieldset className="mb-4">
            <legend className="label mb-2">Document type</legend>
            <div className="segmented" role="group" aria-label="Document type">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  data-active={kind === k.key}
                  aria-pressed={kind === k.key}
                  onClick={() => setKind(k.key)}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
              {KINDS.find((k) => k.key === kind)?.blurb}
            </p>
          </fieldset>

          <div className="mb-4">
            <label htmlFor="intake-pages" className="label mb-1.5 block">
              Pages
            </label>
            <input
              ref={fileInput}
              id="intake-pages"
              type="file"
              accept="image/*"
              multiple
              className="input file:mr-3 file:rounded-full file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-[var(--accent-text)]"
              style={{ paddingTop: "0.5rem", height: "auto" }}
              onChange={(e) => void addFiles(e.target.files)}
              disabled={busy !== null}
            />
            <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
              Up to {MAX_PAGES} page images at a time. For a PDF, export or photograph each page. Pages are
              shrunk in this browser before they are sent and are never stored.
            </p>
          </div>

          {pages.length > 0 && (
            <ul className="mb-4 flex flex-wrap gap-2" aria-label="Pages ready to read">
              {pages.map((p, i) => (
                <li key={`${p.name}-${i}`} className="card-inset flex items-center gap-2 px-3 py-1.5">
                  <span className="tabular text-[12px] font-semibold" style={{ color: "var(--accent-text)" }}>
                    {i + 1}
                  </span>
                  <span className="max-w-40 truncate text-[13px]">{p.name}</span>
                  <button
                    type="button"
                    className="btn btn-plain btn-sm px-1.5"
                    aria-label={`Remove page ${i + 1}`}
                    onClick={() => setPages((prev) => prev.filter((_, idx) => idx !== i))}
                    disabled={busy !== null}
                  >
                    <IconX width={14} height={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {uploadError && (
            <p className="mb-4 flex items-start gap-2 text-[13px]" role="alert" style={{ color: "var(--color-danger-700)" }}>
              <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
              {uploadError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void extract()}
              disabled={pages.length === 0 || busy !== null}
            >
              {busy === "extract" ? "Reading pages…" : busy === "files" ? "Preparing pages…" : "Read document"}
            </button>
            {pages.length > 0 && busy === null && (
              <button type="button" className="btn btn-white" onClick={() => setPages([])}>
                Clear pages
              </button>
            )}
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              Nothing is written to a chart until a person accepts the fields and commits.
            </span>
          </div>

          <p className="mt-4 border-t pt-3 text-[12px] leading-relaxed hairline" style={{ color: "var(--text-muted)" }}>
            Synthetic documents only. Real client or staff paper waits for the signed vendor agreement to be
            registered — see the AI plan, section 3.5.
          </p>
        </div>
      </section>

      {/* ── 2. Side-by-side review ─────────────────────────────────────────── */}
      <section aria-labelledby="intake-review">
        <SectionTitle icon={<IconClipboardCheck />}>
          <span id="intake-review">Review</span>
        </SectionTitle>

        {!job ? (
          <EmptyState
            icon={<IconClipboard />}
            title="Nothing under review"
            body="Read a document above, or open one of the recent jobs to review what it found. Every field waits for a person before it becomes a chart."
          />
        ) : job.status === "failed" || (job.notice && fields.length === 0) ? (
          <div className="card px-6 py-6" role="status">
            <div className="flex items-start gap-3">
              <IconAlert width={18} height={18} className="mt-0.5 shrink-0" style={{ color: "var(--color-warning-700)" }} />
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold">This document wasn&rsquo;t read</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {job.notice ??
                    "Reading pages needs model access, and it wasn't available. The job is on file with its page count and who opened it — nothing was guessed and nothing reached a chart."}
                </p>
                <p className="mt-3 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  Enter this one by hand. The record ends up identical: the same chart, the same audit trail,
                  the same signatures — this step only saves typing.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href="/office/clients" className="btn btn-secondary btn-sm">
                    Open the client list
                  </Link>
                  <Link href="/office/credentials" className="btn btn-white btn-sm">
                    Credentials desk
                  </Link>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            {/* Left: the paper */}
            <div className="lg:sticky lg:top-6 lg:self-start">
              <p className="label mb-2">Source</p>
              <PagePanel pages={pagesForJobId === job.id ? pages : []} job={job} />
            </div>

            {/* Right: what was read, and what a person decided */}
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  <span className="tabular font-semibold">{decided}</span> of{" "}
                  <span className="tabular">{fields.length}</span> fields decided ·{" "}
                  <span className="tabular">{acceptedCount}</span> accepted
                </p>
                {canReview && !committed && (
                  <button
                    type="button"
                    className="btn btn-tinted btn-sm"
                    onClick={() => void onSweep()}
                    disabled={sweepable === 0 || busy !== null}
                  >
                    {busy === "sweep"
                      ? "Accepting…"
                      : sweepable === 0
                        ? "No high-confidence fields left"
                        : `Accept all high-confidence (${sweepable})`}
                  </button>
                )}
              </div>

              {!canReview && (
                <p className="card-inset mb-3 px-4 py-3 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  You can read this review. Accepting fields and opening a chart needs the client-records
                  permission — an owner or administrator can finish it.
                </p>
              )}

              {reviewError && (
                <p
                  className="mb-3 flex items-start gap-2 text-[13px]"
                  role="alert"
                  style={{ color: "var(--color-danger-700)" }}
                >
                  <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
                  {reviewError}
                </p>
              )}

              <ul className="card divide-y hairline overflow-hidden">
                {fields.map((f) => {
                  const band = confidenceBand(f.confidence);
                  const value = drafts[f.id] ?? f.accepted_value ?? f.extracted_value ?? "";
                  const edited = value.trim() !== (f.extracted_value ?? "").trim();
                  const working = busy === f.id;
                  return (
                    <li key={f.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[14px] font-semibold">{f.label}</p>
                        <div className="flex items-center gap-1.5">
                          <Badge tone={band.tone}>{band.label}</Badge>
                          {f.page_ref !== null && <Badge tone="neutral">Page {f.page_ref}</Badge>}
                          {f.accepted === true && (
                            <Badge tone="success" icon={<IconCheck />}>
                              Accepted
                            </Badge>
                          )}
                          {f.accepted === false && <Badge tone="neutral">Not used</Badge>}
                        </div>
                      </div>

                      <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Read from the document
                      </p>
                      <p className="tabular mt-0.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                        {f.extracted_value ?? "—"}
                      </p>

                      <label htmlFor={`accepted-${f.id}`} className="label mt-3 block">
                        Value to keep
                      </label>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <input
                          id={`accepted-${f.id}`}
                          className="input min-w-48 flex-1"
                          value={value}
                          disabled={!canReview || committed || working}
                          onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                        />
                        {canReview && !committed && (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void onAccept(f, true)}
                              disabled={busy !== null}
                            >
                              {working ? "Saving…" : f.accepted === true ? "Update" : "Accept"}
                            </button>
                            {f.accepted !== false && (
                              <button
                                type="button"
                                className="btn btn-plain btn-sm"
                                onClick={() => void onAccept(f, false)}
                                disabled={busy !== null}
                              >
                                Not used
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {edited && f.accepted !== true && (
                        <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          Edited. Both the reading and your value are kept on the record.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Commit */}
              <div className="card mt-4 px-5 py-4">
                {committed || commitResult ? (
                  <div>
                    <p className="flex items-center gap-2 text-[14px] font-semibold">
                      <IconCheck width={16} height={16} style={{ color: "var(--color-success-700)" }} />
                      Committed
                    </p>
                    <p className="mt-1.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                      {commitResult?.message ??
                        "This document has been committed. The job, every reading, and every acceptance stay on the record."}
                    </p>
                    {commitResult?.clientId && (
                      <Link href={`/office/clients/${commitResult.clientId}`} className="btn btn-primary btn-sm mt-3">
                        Open the chart
                      </Link>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {job.kind === "credential_doc"
                        ? "Committing records the accepted values and hands them to the credentials desk."
                        : "Committing opens a chart in inquiry status from the accepted fields only."}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void onCommit()}
                      disabled={!canReview || acceptedCount === 0 || busy !== null}
                    >
                      {busy === "commit" ? "Committing…" : "Commit"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── 3. Referral triage ─────────────────────────────────────────────── */}
      <ReferralTriage />
    </div>
  );
}

/* ── Referral triage box (C7) ─────────────────────────────────────────────────── */

function urgencyTone(u: TriageResult["urgency"]): "danger" | "warning" | "neutral" {
  if (u === "urgent") return "danger";
  if (u === "soon") return "warning";
  return "neutral";
}

function ReferralTriage() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<TriageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await triageReferral(text);
      if (!res.ok) {
        setError(res.error ?? "That couldn't be triaged. Nothing was saved.");
        setResult(null);
      } else {
        setResult(res);
      }
    } catch {
      setError("That couldn't be triaged. Nothing was saved — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="referral-triage">
      <SectionTitle icon={<IconSparkle />}>
        <span id="referral-triage">Referral triage</span>
      </SectionTitle>

      <div className="card px-5 py-5">
        <label htmlFor="referral-text" className="label mb-1.5 block">
          Paste the referral or inquiry
        </label>
        <textarea
          id="referral-text"
          className="textarea w-full"
          rows={5}
          value={text}
          placeholder="Paste the email, fax cover note, or phone message here."
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void run()}
            disabled={busy || text.trim().length < 20}
          >
            {busy ? "Triaging…" : "Triage referral"}
          </button>
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            A proposal for a coordinator. It never decides eligibility, authorization, or admission.
          </span>
        </div>

        {error && (
          <p className="mt-3 flex items-start gap-2 text-[13px]" role="alert" style={{ color: "var(--color-danger-700)" }}>
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        {result && (
          <div className="card-inset mt-4 px-4 py-4" role="status">
            <div className="flex flex-wrap items-center gap-2">
              {result.urgency ? (
                <Badge tone={urgencyTone(result.urgency)} icon={<IconAlert />}>
                  {result.urgency === "urgent" ? "Urgent" : result.urgency === "soon" ? "Respond soon" : "Routine"}
                </Badge>
              ) : (
                <Badge tone="neutral">Not ranked</Badge>
              )}
              <Badge tone="accent" icon={<IconSparkle />}>
                Proposal
              </Badge>
              {result.proposalId && <Badge tone="neutral">Filed to approvals</Badge>}
            </div>

            {result.notice && (
              <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {result.notice}
              </p>
            )}

            {result.summary && (
              <p className="mt-3 text-[14px] leading-relaxed">{result.summary}</p>
            )}
            {result.serviceFit && (
              <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                Service fit: {result.serviceFit}
              </p>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="label mb-1.5">Still needed before a chart can open</p>
                {result.missing.length === 0 ? (
                  <p className="text-[13px]" style={{ color: "var(--color-success-700)" }}>
                    Everything the platform checks for is present.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {result.missing.map((m) => (
                      <li key={m} className="flex items-start gap-1.5 text-[13px]">
                        <IconPlus width={13} height={13} className="mt-1 shrink-0" style={{ color: "var(--color-warning-700)" }} />
                        {m}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="label mb-1.5">Already in the referral</p>
                {result.present.length === 0 ? (
                  <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    None of the expected items were found.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {result.present.map((m) => (
                      <li key={m} className="flex items-start gap-1.5 text-[13px]">
                        <IconCheck width={13} height={13} className="mt-1 shrink-0" style={{ color: "var(--color-success-700)" }} />
                        {m}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {result.nextStep && (
              <p className="mt-4 border-t pt-3 text-[14px] hairline">
                <span className="font-semibold">Next step: </span>
                {result.nextStep}
              </p>
            )}
            <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              The completeness check is the platform&rsquo;s own rules, not a model judgment. Synthetic referrals
              only until the vendor agreement is registered.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
