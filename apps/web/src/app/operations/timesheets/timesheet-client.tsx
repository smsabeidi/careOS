"use client";

/**
 * Timesheet interaction islands — the only client code on this surface.
 *
 * These shells hold NO PHI and no client identity: a visit id, a period id, whole
 * minutes and enum labels. Names, addresses and anything about who was cared for are
 * rendered by the server component around them (invariant 5 — PHI stays out of the
 * bundle unless a genuine interaction needs it, and none of these do).
 *
 * NO ARITHMETIC HAPPENS HERE. The figure on the approve button is the one
 * `app.compute_visit_minutes` returned; pressing approve sends no number at all, so the
 * database applies the agency's rounding policy and records which rule it applied. Only
 * a deliberate override sends minutes, and the database marks it as manual (invariant 13).
 *
 * Every refusal the database can give is a first-class state here rather than a raw
 * error: a blocking exception offers the link that clears it, a self-approval says so
 * plainly, and a period that is not ready says how many visits are still owed a decision.
 *
 * @trace ST-208, docs/17 §4.7 §7.2, D-027, D-030
 */

import { useActionState, useState } from "react";
import Link from "next/link";
import { IconAlert, IconCheck, IconLock, IconX } from "@/components/icons";
import {
  approveVisitHours,
  closePayrollPeriod,
  exportPayrollPeriod,
  openPayrollPeriod,
  rejectVisitHours,
  type ActionResult,
  type ExportResult,
} from "./actions";

const idle: ActionResult = { ok: true };
const idleExport: ExportResult = { ok: true };

const PAY_CODES: { value: string; label: string }[] = [
  { value: "regular", label: "Regular" },
  { value: "overtime", label: "Overtime" },
  { value: "holiday", label: "Holiday" },
  { value: "training", label: "Training" },
  { value: "travel", label: "Travel" },
  { value: "adjustment", label: "Adjustment" },
];

/**
 * Lossless decomposition of a whole number of minutes for reading: h * 60 + m is exactly
 * the value the database returned. Not rounding, not conversion — formatting.
 */
function minutesLabel(total: number | null | undefined): string {
  if (total === null || total === undefined) return "—";
  const abs = Math.abs(total);
  const h = (abs - (abs % 60)) / 60;
  const m = abs % 60;
  const sign = total < 0 ? "−" : "";
  if (h === 0) return `${sign}${m} min`;
  return m === 0 ? `${sign}${h} h` : `${sign}${h} h ${m} m`;
}

/* ── Shared result line ────────────────────────────────────────────────────── */

function ResultLine({ state }: { state: ActionResult }) {
  const text = state.ok ? state.message : state.error;
  if (!text) return null;
  return (
    <div className="mt-2" role="status" aria-live="polite">
      <p
        className="text-[13px] leading-relaxed"
        style={{ color: state.ok ? "var(--text-secondary)" : "var(--color-danger-700)" }}
      >
        {text}
      </p>
      {!state.ok && state.href && (
        <Link href={state.href} className="btn btn-secondary btn-sm mt-2">
          {state.code === "CAREOS_APPROVAL_BLOCKED" ? "Open the exception" : "See what is waiting"}
        </Link>
      )}
    </div>
  );
}

/* ── One visit's hours: approve as measured, adjust, or send back ──────────── */

export function HoursDecision({
  visitId,
  canApprove,
  suggestedMinutes,
  roundingNote,
  blockingExceptions,
  blockingHref,
}: {
  visitId: string;
  canApprove: boolean;
  /** What the database says this visit is worth, already rounded by agency policy. */
  suggestedMinutes: number | null;
  /** e.g. "rounded to the nearest 6 minutes" — the policy's own words, from the server. */
  roundingNote: string | null;
  /** Unresolved critical findings on this visit, counted by the database before render. */
  blockingExceptions: number;
  blockingHref: string;
}) {
  const [mode, setMode] = useState<"idle" | "adjust" | "reject">("idle");
  const [approveState, approve, approving] = useActionState(
    async (_prev: ActionResult, fd: FormData) => approveVisitHours(fd),
    idle
  );
  const [rejectState, reject, rejecting] = useActionState(
    async (_prev: ActionResult, fd: FormData) => rejectVisitHours(fd),
    idle
  );

  if (!canApprove) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        Your role can read these hours but not decide them.
      </p>
    );
  }

  const blocked = blockingExceptions > 0;
  // A decided visit shows only its outcome: the row is stale until the page revalidates,
  // and offering the same buttons again would invite a second decision on a settled fact.
  const settled =
    approveState.ok && approveState.message
      ? approveState
      : rejectState.ok && rejectState.message
        ? rejectState
        : null;
  if (settled) return <ResultLine state={settled} />;

  return (
    <div className="min-w-[16rem]">
      {blocked && (
        <div className="card-inset mb-2 px-3 py-2.5">
          <p className="flex items-start gap-1.5 text-[13px] leading-relaxed">
            <span style={{ color: "var(--color-warning-700)" }}>
              <IconAlert width={14} height={14} />
            </span>
            <span>
              {blockingExceptions === 1
                ? "One critical exception on this visit is still unresolved, so the hours cannot be approved yet."
                : `${blockingExceptions} critical exceptions on this visit are still unresolved, so the hours cannot be approved yet.`}{" "}
              Nothing is lost — the clock record stands and the hours wait here.
            </span>
          </p>
          <Link href={blockingHref} className="btn btn-secondary btn-sm mt-2">
            Open the exception
          </Link>
        </div>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <form action={approve}>
            <input type="hidden" name="visit_id" value={visitId} />
            <button type="submit" disabled={approving || blocked} className="btn btn-primary btn-sm">
              <IconCheck width={15} height={15} />
              {approving
                ? "Approving…"
                : suggestedMinutes === null
                  ? "Approve hours"
                  : `Approve ${minutesLabel(suggestedMinutes)}`}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setMode("adjust")}
            disabled={blocked}
            className="btn btn-secondary btn-sm"
          >
            Adjust…
          </button>
          <button type="button" onClick={() => setMode("reject")} className="btn btn-secondary btn-sm">
            Send back
          </button>
        </div>
      )}

      {mode === "adjust" && (
        <form action={approve} className="flex flex-col gap-2">
          <input type="hidden" name="visit_id" value={visitId} />
          {/* The minutes field starts EMPTY on purpose. An empty field sends no number at
              all, so the database applies the agency's rounding policy and records which
              rule it used; a pre-filled field resubmitted untouched would be stored as a
              manual override and quietly destroy that distinction. */}
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Leave the minutes blank to approve{" "}
            {suggestedMinutes === null ? "the measured time" : minutesLabel(suggestedMinutes)} as
            CareOS measured it. Fill it in only to record a deliberate override — the measured figure
            stays on the record beside yours.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="label text-[12px]">Approved minutes</span>
              <input
                name="approved_minutes"
                type="number"
                min={0}
                max={1440}
                step={1}
                inputMode="numeric"
                placeholder={suggestedMinutes === null ? "As measured" : String(suggestedMinutes)}
                className="input tabular w-32"
                aria-label="Approved minutes — leave blank to accept the measured figure"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="label text-[12px]">Pay code</span>
              <select name="pay_code" defaultValue="regular" className="select w-40" aria-label="Pay code">
                {PAY_CODES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="label text-[12px]">Note (optional)</span>
            <input
              name="note"
              maxLength={1000}
              className="input"
              placeholder="Why this figure"
              aria-label="Approval note"
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={approving} className="btn btn-primary btn-sm">
              {approving ? "Approving…" : "Approve these hours"}
            </button>
            <button type="button" onClick={() => setMode("idle")} className="btn btn-plain btn-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "reject" && (
        <form action={reject} className="flex flex-col gap-2">
          <input type="hidden" name="visit_id" value={visitId} />
          <label className="flex flex-col gap-1">
            <span className="label text-[12px]">Reason</span>
            <textarea
              name="reason"
              required
              maxLength={1000}
              className="textarea"
              placeholder="What needs to change before these hours can be approved"
              aria-label="Reason for sending these hours back"
            />
          </label>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            The reason is kept beside the measured minutes and stays on the record. The hours stay
            out of payroll until they are corrected and approved.
          </p>
          <div className="flex gap-2">
            <button type="submit" disabled={rejecting} className="btn btn-secondary btn-sm">
              <IconX width={15} height={15} />
              {rejecting ? "Sending back…" : "Send back"}
            </button>
            <button type="button" onClick={() => setMode("idle")} className="btn btn-plain btn-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {roundingNote && mode === "idle" && !blocked && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {roundingNote}
        </p>
      )}

      {!approveState.ok && <ResultLine state={approveState} />}
      {!rejectState.ok && <ResultLine state={rejectState} />}
    </div>
  );
}

/* ── Open a period ─────────────────────────────────────────────────────────── */

export function OpenPeriodForm({
  canManage,
  defaultStart,
  defaultEnd,
}: {
  canManage: boolean;
  defaultStart: string;
  defaultEnd: string;
}) {
  const [state, act, pending] = useActionState(
    async (_prev: ActionResult, fd: FormData) => openPayrollPeriod(fd),
    idle
  );
  /**
   * NOTHING re-renders this surface after the action, deliberately.
   *
   * `revalidatePath` in the action and `router.refresh()` here both do the same thing — ask
   * this route to re-render in place — and an in-place re-render of a route never commits
   * in this app (a tab link on this page or on /operations/exceptions hangs the same way).
   * The transition stays pending, so the button reads "Opening…" for good even though the
   * period was created, and the next thing the person presses is wedged behind it.
   *
   * So the outcome below is the whole answer, and the table it describes is one reload
   * behind. That is worth saying plainly rather than papering over: a message that arrives
   * beats a spinner that never stops. Restore the refresh once a route can re-render.
   */

  if (!canManage) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        Opening, closing and exporting a period is the payroll desk&apos;s to do. You can read
        everything on this page.
      </p>
    );
  }

  return (
    <form action={act} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="label text-[12px]">Starts on</span>
        <input
          name="starts_on"
          type="date"
          required
          defaultValue={defaultStart}
          className="input tabular w-44"
          aria-label="Period start date"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label text-[12px]">Ends on</span>
        <input
          name="ends_on"
          type="date"
          required
          defaultValue={defaultEnd}
          className="input tabular w-44"
          aria-label="Period end date"
        />
      </label>
      <button type="submit" disabled={pending} className="btn btn-secondary btn-sm">
        {pending ? "Opening…" : "Open period"}
      </button>
      <div className="w-full">
        <ResultLine state={state} />
      </div>
    </form>
  );
}

/* ── Close + export one period ─────────────────────────────────────────────── */

export function PeriodActions({
  periodId,
  status,
  canManage,
}: {
  periodId: string;
  status: "open" | "locked" | "exported";
  canManage: boolean;
}) {
  const [closeState, close, closing] = useActionState(
    async (_prev: ActionResult, fd: FormData) => closePayrollPeriod(fd),
    idle
  );
  const [exportState, runExport, exporting] = useActionState(
    async (_prev: ExportResult, fd: FormData) => {
      const res = await exportPayrollPeriod(fd);
      if (res.ok && res.csv) downloadCsv(res.csv, res.filename ?? "careos-payroll.csv");
      return res;
    },
    idleExport
  );
  /* No refresh here either — see OpenPeriodForm above. The row keeps saying "Open" until
   * the page is reloaded; the outcome line is what tells the person the close landed. */

  /**
   * The file is built on the server, from the rows and in the order the database returned
   * them. The browser only saves what it was handed — it never assembles, sorts or totals
   * a payroll file of its own.
   */
  function downloadCsv(csv: string, filename: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Give the browser a beat to start the save before the handle is released.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  if (!canManage) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "open" && (
          <form action={close}>
            <input type="hidden" name="period_id" value={periodId} />
            <button type="submit" disabled={closing} className="btn btn-secondary btn-sm">
              <IconLock width={15} height={15} />
              {closing ? "Closing…" : "Close period"}
            </button>
          </form>
        )}
        {status !== "open" && (
          <form action={runExport}>
            <input type="hidden" name="period_id" value={periodId} />
            <button type="submit" disabled={exporting} className="btn btn-primary btn-sm">
              {exporting ? "Exporting…" : status === "exported" ? "Export again" : "Export to CSV"}
            </button>
          </form>
        )}
      </div>

      <ResultLine state={closeState} />
      <ResultLine state={exportState} />

      {exportState.ok && exportState.contentSha256 && (
        <div className="card-inset px-3 py-2.5">
          <p className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
            {exportState.rowCount ?? 0} payroll {exportState.rowCount === 1 ? "line" : "lines"} ·{" "}
            {minutesLabel(exportState.totalMinutes ?? null)} approved
          </p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            File fingerprint (SHA-256)
          </p>
          <code className="tabular block break-all text-[11px] leading-relaxed">
            {exportState.contentSha256}
          </code>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Re-run the export at any time: unchanged hours produce this same fingerprint, so it
            answers &ldquo;is this the file we sent?&rdquo; without keeping a second copy of anyone&apos;s pay.
          </p>
        </div>
      )}
    </div>
  );
}
