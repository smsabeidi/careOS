"use server";

/**
 * Timesheet + payroll actions — thin wrappers over the 0050 payroll-boundary RPCs.
 *
 * Four rules hold for every function below:
 *
 *  1. **The database is the authority.** AAL2, `visit.approve` / `payroll.manage`, the
 *     human-actor check (D-020), self-approval (D-027), the critical-exception block and
 *     the period readiness gate are all enforced inside the RPC — and, for self-approval,
 *     again by a CHECK constraint. Everything here does is translate a `CAREOS_*` refusal
 *     into plain language: what happened, what is preserved, what to do next (docs/10).
 *
 *  2. **No minute and no dollar is computed in JavaScript** (invariant 13). When the
 *     approver accepts the figure as shown, `p_approved_minutes` is sent as NULL and the
 *     database applies the agency's own rounding policy; only a deliberate manual
 *     override sends a number, and the database records that it was manual. Nothing in
 *     this file adds, averages, prorates or rounds anyone's time.
 *
 *  3. **Writes run under the caller's own client** — RLS and the RPC EXECUTE grants
 *     decide, never app code (invariant 6). The permission re-checks below are honesty,
 *     not security: they let the surface say "your role does not include this" instead of
 *     showing a button that will always fail.
 *
 *  4. **Nothing throws.** A refusal is a return value, so a failed approval never costs
 *     the approver the queue they were working through. Refusals that a person can act on
 *     — a blocking exception, a period that is not ready — come back structured, with a
 *     count and an internal path, so the UI can offer the next step instead of a dead end.
 *
 * PHI: no client identity is read, written, exported or logged here. A payroll file
 * carries caregiver_id, work_date, minutes and pay_code and nothing else — the export RPC
 * guarantees that shape and the CSV writer below preserves it (invariant 5, D-030).
 *
 * @trace ST-208, docs/17 §4.7 §7.2, D-020, D-024, D-027, D-030
 */

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

const SURFACE = "/operations/timesheets";

export type ActionResult = {
  ok: boolean;
  /** Plain-language failure. Never a raw database string, never a PHI fragment. */
  error?: string;
  /** Plain-language success. */
  message?: string;
  /** The CAREOS_* code behind a refusal, so the UI can render it as a first-class state. */
  code?: string;
  /** How many things are in the way (blocking exceptions, unapproved visits). */
  blocking?: number;
  /** Internal path that clears the refusal. Always app-relative — never an external URL. */
  href?: string;
};

export type ExportResult = ActionResult & {
  /** The CSV text, built on the server from the rows the database returned. */
  csv?: string;
  filename?: string;
  /** The database's hash of the canonical serialisation — the file's provenance. */
  contentSha256?: string;
  rowCount?: number;
  totalMinutes?: number;
  /** True when nothing had changed and the export already on record was returned. */
  unchanged?: boolean;
};

/** Pay codes, mirroring the CHECK on approved_work_segment.pay_code (0050 §3). */
const PAY_CODES = ["regular", "overtime", "holiday", "training", "travel", "adjustment"] as const;
export type PayCode = (typeof PAY_CODES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTE = 1000;
/** A shift longer than a day is a ledger problem, not an approval; the DB refuses anyway. */
const MAX_MANUAL_MINUTES = 1440;

/* ── Refusal translation ───────────────────────────────────────────────────── */

type Ctx = "approve" | "reject" | "period" | "export";

function codeOf(raw: string | undefined): string | null {
  return raw?.match(/CAREOS_[A-Z_]+/)?.[0] ?? null;
}

/** The count the database put in its own message. Counts only — never PHI. */
function countIn(raw: string | undefined): number | undefined {
  const m = raw?.match(/CAREOS_[A-Z_]+:\s*(\d+)/);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

function friendly(raw: string | undefined, ctx: Ctx): string {
  const n = countIn(raw);
  switch (codeOf(raw)) {
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs a fresh verification. Nothing was changed — unlock with your authenticator and try again.";
    case "CAREOS_FORBIDDEN":
      return ctx === "period" || ctx === "export"
        ? "Your role does not include closing or exporting payroll. Nothing was changed."
        : "Your role does not include approving hours. Nothing was changed.";
    case "CAREOS_HUMAN_REQUIRED":
      return "Hours are approved by people, not by automations. Nothing was changed — sign in as yourself to decide this one.";
    case "CAREOS_SELF_APPROVAL":
      return "You cannot approve or reject your own hours. Nothing was changed — ask a supervisor or the payroll desk to review this shift.";
    case "CAREOS_APPROVAL_BLOCKED":
      return n === 1
        ? "One unresolved critical exception is on this visit, so the hours cannot be approved yet. Nothing was changed — resolve the exception first and the approval will go through."
        : `${n ?? "Some"} unresolved critical exceptions are on this visit, so the hours cannot be approved yet. Nothing was changed — resolve them first and the approval will go through.`;
    case "CAREOS_PERIOD_NOT_READY":
      return n === 1
        ? "One completed visit in this period is still waiting on approval. The period stays open and nothing was changed — approve that visit, then close again."
        : `${n ?? "Some"} completed visits in this period are still waiting on approval. The period stays open and nothing was changed — approve them, then close again.`;
    case "CAREOS_NO_HOURS":
      return "This visit has no clock-in and clock-out pair, so there are no hours to approve. Nothing was changed — the clock record needs a correction first.";
    case "CAREOS_INCOHERENT_LEDGER":
      return "The clock-out on this visit is earlier than the clock-in, so the hours cannot be read. Nothing was changed — correct the clock record first.";
    case "CAREOS_REASON_REQUIRED":
      return "A rejection needs a reason. Nothing was changed — the reason goes on the record beside the hours.";
    case "CAREOS_BAD_PAY_CODE":
      return "That is not a pay code this agency uses. Nothing was changed.";
    case "CAREOS_BAD_MINUTES":
      return "Approved minutes cannot be negative. Nothing was changed.";
    case "CAREOS_BAD_WINDOW":
      return "A payroll period has to end on or after it starts. Nothing was changed.";
    case "CAREOS_BAD_STATE":
      if (ctx === "export") {
        return "This period has to be closed before it can be exported. Nothing was changed — close it, then export.";
      }
      if (ctx === "period") {
        return "This period has already been exported, so it cannot be closed again. Nothing was changed — a later correction appears in the next export.";
      }
      return "Only a completed visit has hours to rule on. Nothing was changed — this visit has not been finished yet.";
    case "CAREOS_POLICY_MISSING":
      return "This agency has no visit policy to read its overtime ceiling from. Nothing was changed — an administrator sets the policy defaults first.";
    case "CAREOS_NOT_FOUND":
      return ctx === "period" || ctx === "export"
        ? "That payroll period is not available on your account. Nothing was changed."
        : "That visit is not available on your account. Nothing was changed.";
    case "CAREOS_NO_TENANT_CONTEXT":
      return "Your workspace could not be resolved on this session. Nothing was changed — sign in again.";
    default:
      return "Something went wrong and nothing was saved. The hours and the clock record are exactly as they were — try again.";
  }
}

/**
 * Honest surface guard. The database refuses regardless — this only lets the screen say
 * "your role does not include this" instead of a generic failure.
 *
 * Permissive when the probe itself fails: a transient error is not a permission verdict,
 * and telling somebody their role is wrong when the network hiccuped is a lie. The RPC
 * runs, and its own refusal (which is authoritative) is what reaches the person.
 */
async function holds(supabase: SupabaseClient, perm: string): Promise<boolean> {
  const { data, error } = await supabase.schema("app").rpc("has_perm", { p: perm });
  if (error) return true;
  return data === true;
}

function field(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

/* ── Approve / reject one visit's hours ────────────────────────────────────── */

/**
 * Approve the hours on one completed visit.
 *
 * `p_approved_minutes` is NULL unless the approver deliberately overrode the figure. That
 * is the whole discipline: the database rounds by the agency's policy and records which
 * rule it applied, so an override is visible as an override rather than hidden inside a
 * number the browser produced (invariant 13, docs/17 §4.7).
 */
export async function approveVisitHours(fd: FormData): Promise<ActionResult> {
  const visitId = field(fd, "visit_id");
  if (!UUID_RE.test(visitId)) {
    return { ok: false, error: "That visit could not be identified. Nothing was changed." };
  }

  const payCode = field(fd, "pay_code") || "regular";
  if (!(PAY_CODES as readonly string[]).includes(payCode)) {
    return { ok: false, error: "That is not a pay code this agency uses. Nothing was changed." };
  }

  const rawMinutes = field(fd, "approved_minutes");
  let approvedMinutes: number | null = null;
  if (rawMinutes !== "") {
    const n = Number.parseInt(rawMinutes, 10);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MANUAL_MINUTES) {
      return {
        ok: false,
        error: `An adjusted figure has to be a whole number of minutes between 0 and ${MAX_MANUAL_MINUTES}. Nothing was changed.`,
      };
    }
    approvedMinutes = n;
  }

  const note = field(fd, "note").slice(0, MAX_NOTE) || null;

  const supabase = await supabaseServer();
  if (!(await holds(supabase, "visit.approve"))) {
    return { ok: false, code: "CAREOS_FORBIDDEN", error: friendly("CAREOS_FORBIDDEN", "approve") };
  }

  const { data, error } = await supabase.schema("app").rpc("approve_visit_hours", {
    p_visit: visitId,
    p_approved_minutes: approvedMinutes,
    p_pay_code: payCode,
    p_note: note,
  });

  if (error) {
    const code = codeOf(error.message);
    return {
      ok: false,
      code: code ?? undefined,
      blocking: countIn(error.message),
      // The one refusal a person can clear themselves gets the path that clears it. An
      // id in a query string is an id, never PHI — the exception inbox refetches under RLS.
      href: code === "CAREOS_APPROVAL_BLOCKED" ? `/operations/exceptions?visit=${visitId}` : undefined,
      error: friendly(error.message, "approve"),
    };
  }

  const result = (data ?? {}) as {
    unchanged?: boolean;
    approved_minutes?: number;
    rounding_applied?: string;
    pay_code?: string;
  };

  revalidatePath(SURFACE);

  if (result.unchanged) {
    return {
      ok: true,
      message: "These hours were already approved with the same figure. Nothing was recorded twice.",
    };
  }
  return {
    ok: true,
    message:
      "Hours approved. The decision is on the record with your name against it, and the visit is ready for the next payroll export." +
      (result.rounding_applied === "manual"
        ? " Your adjusted figure was recorded as a manual override beside the measured time."
        : ""),
  };
}

/**
 * Reject the hours on one completed visit. The reason is mandatory and durable: it lands
 * on the append-only segment beside the measured minutes, never in an audit payload
 * (0050 §9 — free text about a person's work does not travel in payloads).
 */
export async function rejectVisitHours(fd: FormData): Promise<ActionResult> {
  const visitId = field(fd, "visit_id");
  if (!UUID_RE.test(visitId)) {
    return { ok: false, error: "That visit could not be identified. Nothing was changed." };
  }
  const reason = field(fd, "reason").slice(0, MAX_NOTE);
  if (!reason) {
    return {
      ok: false,
      code: "CAREOS_REASON_REQUIRED",
      error: friendly("CAREOS_REASON_REQUIRED", "reject"),
    };
  }

  const supabase = await supabaseServer();
  if (!(await holds(supabase, "visit.approve"))) {
    return { ok: false, code: "CAREOS_FORBIDDEN", error: friendly("CAREOS_FORBIDDEN", "reject") };
  }

  const { data, error } = await supabase.schema("app").rpc("reject_visit_hours", {
    p_visit: visitId,
    p_reason: reason,
  });
  if (error) {
    return {
      ok: false,
      code: codeOf(error.message) ?? undefined,
      blocking: countIn(error.message),
      error: friendly(error.message, "reject"),
    };
  }

  const result = (data ?? {}) as { unchanged?: boolean };
  revalidatePath(SURFACE);

  return {
    ok: true,
    message: result.unchanged
      ? "These hours were already sent back. Nothing was recorded twice."
      : "Hours sent back with your reason on the record. They stay out of payroll until the clock record is corrected and the hours are approved.",
  };
}

/* ── Payroll periods ───────────────────────────────────────────────────────── */

/**
 * Open a pay period. docs/17 §4.7 pins close and export but no opener; 0050 §11 adds one
 * (DN-0050b) because the table carries no write grants and a period has to come from
 * somewhere. Idempotent by window — re-opening the same fortnight returns the period that
 * already covers it.
 */
export async function openPayrollPeriod(fd: FormData): Promise<ActionResult> {
  const startsOn = field(fd, "starts_on");
  const endsOn = field(fd, "ends_on");
  if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn)) {
    return { ok: false, error: "A period needs a start date and an end date. Nothing was changed." };
  }

  const supabase = await supabaseServer();
  if (!(await holds(supabase, "payroll.manage"))) {
    return { ok: false, code: "CAREOS_FORBIDDEN", error: friendly("CAREOS_FORBIDDEN", "period") };
  }

  const { data, error } = await supabase.schema("app").rpc("open_payroll_period", {
    p_starts_on: startsOn,
    p_ends_on: endsOn,
  });
  if (error) {
    return { ok: false, code: codeOf(error.message) ?? undefined, error: friendly(error.message, "period") };
  }

  const result = (data ?? {}) as { unchanged?: boolean };
  revalidatePath(SURFACE);
  return {
    ok: true,
    message: result.unchanged
      ? "A period already covers those dates. It is shown below — nothing was created twice."
      : "Period opened. Approve the hours inside it, then close it when everything has been decided.",
  };
}

/**
 * Close a pay period. Refuses while any completed visit in the window is still waiting on
 * a human, and says how many — that count comes back to the UI as `blocking` so the
 * screen can send the person to the approvals still owed rather than to a riddle.
 */
export async function closePayrollPeriod(fd: FormData): Promise<ActionResult> {
  const periodId = field(fd, "period_id");
  if (!UUID_RE.test(periodId)) {
    return { ok: false, error: "That period could not be identified. Nothing was changed." };
  }

  const supabase = await supabaseServer();
  if (!(await holds(supabase, "payroll.manage"))) {
    return { ok: false, code: "CAREOS_FORBIDDEN", error: friendly("CAREOS_FORBIDDEN", "period") };
  }

  const { data, error } = await supabase.schema("app").rpc("close_payroll_period", {
    p_period: periodId,
  });
  if (error) {
    const code = codeOf(error.message);
    return {
      ok: false,
      code: code ?? undefined,
      blocking: countIn(error.message),
      href: code === "CAREOS_PERIOD_NOT_READY" ? `${SURFACE}?tab=pending` : undefined,
      error: friendly(error.message, "period"),
    };
  }

  const result = (data ?? {}) as { unchanged?: boolean };
  revalidatePath(SURFACE);
  return {
    ok: true,
    message: result.unchanged
      ? "This period was already closed. Nothing was recorded twice — it is ready to export."
      : "Period closed with your name against it. Every completed visit inside it has been decided, so it is ready to export.",
  };
}

/* ── Export ────────────────────────────────────────────────────────────────── */

/** RFC 4180 quoting. The four exported fields never contain a comma today; this is so a
 *  future pay code with one cannot silently shift a column in somebody's payroll file. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type ExportRow = {
  caregiver_id: string;
  work_date: string;
  minutes: number;
  pay_code: string;
};

/**
 * Export a closed period.
 *
 * The database aggregates, orders and hashes; this builds the file from exactly the rows
 * it returned, in exactly the order it returned them, and hands back the hash it computed
 * so an administrator can prove the file that left the building is the file on record.
 * No minute is summed here — `total_minutes` is the database's own figure.
 *
 * FOUR COLUMNS, DELIBERATELY: caregiver, date, minutes, pay code. No client, no address,
 * no service type, no note. A payroll run tells a bookkeeper who worked how long; it has
 * no business telling them who was cared for (invariant 5, D-030, 0050 §13).
 */
export async function exportPayrollPeriod(fd: FormData): Promise<ExportResult> {
  const periodId = field(fd, "period_id");
  if (!UUID_RE.test(periodId)) {
    return { ok: false, error: "That period could not be identified. Nothing was changed." };
  }

  const supabase = await supabaseServer();
  if (!(await holds(supabase, "payroll.manage"))) {
    return { ok: false, code: "CAREOS_FORBIDDEN", error: friendly("CAREOS_FORBIDDEN", "export") };
  }

  // The window, for the filename only — read under RLS like everything else.
  const { data: periodRow } = await supabase
    .from("payroll_period")
    .select("starts_on, ends_on")
    .eq("id", periodId)
    .maybeSingle();
  const period = periodRow as { starts_on: string; ends_on: string } | null;

  const { data, error } = await supabase.schema("app").rpc("export_payroll_period", {
    p_period: periodId,
  });
  if (error) {
    return { ok: false, code: codeOf(error.message) ?? undefined, error: friendly(error.message, "export") };
  }

  const result = (data ?? {}) as {
    unchanged?: boolean;
    rows?: ExportRow[];
    row_count?: number;
    total_minutes?: number;
    content_sha256?: string;
  };
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const csv = [
    ["caregiver_id", "work_date", "minutes", "pay_code"].join(","),
    ...rows.map((r) =>
      [csvCell(r.caregiver_id), csvCell(r.work_date), csvCell(r.minutes), csvCell(r.pay_code)].join(",")
    ),
  ].join("\r\n");

  const filename = period
    ? `careos-payroll-${period.starts_on}-to-${period.ends_on}.csv`
    : `careos-payroll-${periodId}.csv`;

  revalidatePath(SURFACE);

  return {
    ok: true,
    unchanged: result.unchanged,
    csv,
    filename,
    contentSha256: result.content_sha256,
    rowCount: result.row_count,
    totalMinutes: result.total_minutes,
    message: result.unchanged
      ? "Nothing has changed since the last export, so the file already on record was returned — same rows, same fingerprint."
      : "Period exported. The file below carries the fingerprint recorded against this export; anyone can re-run the export and compare it.",
  };
}
