/**
 * Shared, server-safe presentation for the /operations surfaces
 * (docs/17 §7.2 — the live board and the exception inbox).
 *
 * Everything here is a pure function of already-computed database values. Nothing in
 * this file decides whether a visit was late, missed, overlapping or unverifiable —
 * those verdicts are produced by the SQL engines in migrations 0045–0047 and arrive as
 * columns and enums (invariant 13: deterministic verdicts are rules-engine work).
 * This module only chooses the words, the colour and the glyph.
 *
 * PHI posture (invariant 5, D-030):
 *   - No coordinate is ever accepted or rendered here. `verified_visit` exposes
 *     clock_in_distance_m / clock_out_distance_m; the /operations pages do not select
 *     them and this module has no code path that would print a metre value.
 *   - `visit_exception.evidence` carries IDs and numbers only. `describeException`
 *     reads a closed allowlist of numeric keys per kind and ignores everything else, so
 *     a future detector that adds a field cannot leak it onto the screen by accident.
 *   - Names are refetched under RLS by the caller; when RLS hides one, the caller passes
 *     RESTRICTED rather than an id.
 *
 * Voice (invariant 14, docs/10): status is colour + icon + label, never colour alone.
 * Labels say what happened in plain language. Raw enum values never reach a user.
 */

import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconHistory,
  IconMapPin,
  IconPen,
  IconX,
} from "@/components/icons";

export const AGENCY_TZ = "America/New_York";

/** What a name becomes when RLS declines to show it. Never an id, never a blank. */
export const RESTRICTED = "(restricted)";

/* ═══════════════════════════════════════════════════════════════════════════
 * Time — one zone, stated explicitly, so the server and the browser agree
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The agency's calendar day for an instant, as YYYY-MM-DD. Comparison is exact and
 *  DST-proof, which is why the board buckets "today" by string rather than by offset. */
export function agencyDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: AGENCY_TZ });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    timeZone: AGENCY_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: AGENCY_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "9:00 AM – 11:00 AM" — an en dash, because it is a range and not a subtraction. */
export function fmtWindow(startIso: string | null, endIso: string | null): string {
  return `${fmtTime(startIso)} – ${fmtTime(endIso)}`;
}

/** Whole minutes between two instants, floored — the same direction the view rounds. */
export function minutesBetween(fromIso: string, toIso: string | Date): number | null {
  const from = new Date(fromIso).getTime();
  const to = toIso instanceof Date ? toIso.getTime() : new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 60_000);
}

/** "4 minutes ago" · "3 hours ago" · "2 days ago". Coarse on purpose: an operations
 *  queue needs the age, not a stopwatch. */
export function ageLabel(iso: string, now: Date): string {
  const mins = minutesBetween(iso, now);
  if (mins === null) return "just now";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Minutes as words: "1 h 20 m" reads faster than "80 minutes" on a dense row. */
export function fmtMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return "—";
  if (mins < 0) return `${mins} min`;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Visit status — the four axes, said in words
 * ═══════════════════════════════════════════════════════════════════════════ */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const VISIT_STATUS: Record<string, { label: string; tone: Tone; icon: ReactNode }> = {
  scheduled: { label: "Scheduled", tone: "neutral", icon: <IconClock /> },
  in_progress: { label: "In progress", tone: "info", icon: <IconClock /> },
  completed: { label: "Completed", tone: "success", icon: <IconCheck /> },
  missed: { label: "Not started", tone: "danger", icon: <IconAlert /> },
  cancelled: { label: "Cancelled", tone: "neutral", icon: <IconX /> },
};

/** The visit's lifecycle state. Colour + icon + label, never colour alone (D-012). */
export function VisitStatusChip({ status }: { status: string }) {
  const s = VISIT_STATUS[status] ?? { label: "Unknown", tone: "neutral" as Tone, icon: <IconClock /> };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const VERIFICATION: Record<string, { label: string; tone: Tone; icon: ReactNode } | null> = {
  // 'pending' and 'verified' are the overwhelming majority; a chip on every ordinary
  // row is noise, so only the two states that ask for a human get one.
  pending: null,
  verified: null,
  exception: { label: "Needs review", tone: "warning", icon: <IconAlert /> },
  manual_review: { label: "Manual review", tone: "warning", icon: <IconPen /> },
};

/** Rendered only when the evidence did not hold up — silence is the normal case. */
export function VerificationChip({ status }: { status: string }) {
  const v = VERIFICATION[status];
  if (!v) return null;
  return (
    <Badge tone={v.tone} icon={v.icon}>
      {v.label}
    </Badge>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Exceptions — kinds, severity, dispositions
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Human labels for `visit_exception.kind` (docs/17 §3.7). Every kind the CHECK
 * constraint admits has an entry, so a raw enum can never reach the screen.
 * Wording avoids the jargon docs/17 §7.1 bans — no geofence, no radius, no GPS —
 * because the office reads these aloud to the caregiver they are about.
 */
export const EXCEPTION_KIND: Record<string, { label: string; group: string; icon: ReactNode }> = {
  location_unverified: { label: "Place of care not confirmed", group: "Where the visit happened", icon: <IconMapPin /> },
  low_accuracy: { label: "Location reading too imprecise", group: "Where the visit happened", icon: <IconMapPin /> },
  outside_geofence: { label: "Clocked away from the place of care", group: "Where the visit happened", icon: <IconMapPin /> },
  location_unavailable: { label: "No location came with the clock", group: "Where the visit happened", icon: <IconMapPin /> },
  late_start: { label: "Started late", group: "Timing", icon: <IconClock /> },
  early_end: { label: "Ended early", group: "Timing", icon: <IconClock /> },
  long_visit: { label: "Ran long", group: "Timing", icon: <IconClock /> },
  short_visit: { label: "Ran short", group: "Timing", icon: <IconClock /> },
  missing_clock_out: { label: "Visit never closed", group: "Open visits", icon: <IconAlert /> },
  missed_visit: { label: "Visit never started", group: "Open visits", icon: <IconAlert /> },
  overlapping_visits: { label: "Two visits at once", group: "Impossible schedules", icon: <IconAlert /> },
  impossible_travel: { label: "Travel between visits was not possible", group: "Impossible schedules", icon: <IconAlert /> },
  duplicate_visit: { label: "Looks like a duplicate visit", group: "Impossible schedules", icon: <IconHistory /> },
  manual_correction: { label: "A recorded time was corrected", group: "Corrections", icon: <IconPen /> },
  evv_rejected: { label: "State reporting rejected the record", group: "Payer reporting", icon: <IconX /> },
  payroll_mismatch: { label: "Approved hours do not match the record", group: "Pay and hours", icon: <IconAlert /> },
  documentation_missing: { label: "No note on file", group: "Documentation", icon: <IconPen /> },
};

export function kindLabel(kind: string): string {
  return EXCEPTION_KIND[kind]?.label ?? "Something needs a look";
}

export function kindGroup(kind: string): string {
  return EXCEPTION_KIND[kind]?.group ?? "Other findings";
}

export function kindIcon(kind: string): ReactNode {
  return EXCEPTION_KIND[kind]?.icon ?? <IconAlert />;
}

const SEVERITY: Record<string, { label: string; tone: Tone; icon: ReactNode }> = {
  critical: { label: "Critical", tone: "danger", icon: <IconAlert /> },
  warning: { label: "Warning", tone: "warning", icon: <IconAlert /> },
  info: { label: "For information", tone: "neutral", icon: <IconClock /> },
};

export function SeverityChip({ severity }: { severity: string }) {
  const s = SEVERITY[severity] ?? SEVERITY.info;
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const DISPOSITION: Record<string, { label: string; tone: Tone; icon: ReactNode }> = {
  acknowledged: { label: "Acknowledged", tone: "info", icon: <IconCheck /> },
  resolved: { label: "Resolved", tone: "success", icon: <IconCheck /> },
  dismissed: { label: "Dismissed", tone: "neutral", icon: <IconX /> },
  escalated: { label: "Escalated", tone: "warning", icon: <IconAlert /> },
  reopened: { label: "Reopened", tone: "warning", icon: <IconHistory /> },
};

export function DispositionChip({ disposition }: { disposition: string }) {
  const d = DISPOSITION[disposition];
  if (!d) return null;
  return (
    <Badge tone={d.tone} icon={d.icon}>
      {d.label}
    </Badge>
  );
}

export function dispositionLabel(disposition: string | null): string {
  return (disposition && DISPOSITION[disposition]?.label) || "Waiting for a decision";
}

/** Who found it. The queue says "the nightly sweep", never `rule_key`. */
export function detectorLabel(detectedBy: string): string {
  switch (detectedBy) {
    case "rule":
      return "the automatic check";
    case "human":
      return "a person";
    case "agent":
      return "an assistant";
    default:
      return "the platform";
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * describeException — "what happened", from evidence that is numbers and IDs only
 * ═══════════════════════════════════════════════════════════════════════════ */

export type Evidence = Record<string, unknown> | null | undefined;

function num(evidence: Evidence, key: string): number | null {
  const v = evidence?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function ts(evidence: Evidence, key: string): string | null {
  const v = evidence?.[key];
  return typeof v === "string" && !Number.isNaN(new Date(v).getTime()) ? v : null;
}

/**
 * One or two plain sentences saying what the engine found, built ONLY from the
 * allowlisted numeric/timestamp keys each detector writes (0046/0047).
 *
 * Deliberately absent: `distance_m` on the impossible-travel finding, and every
 * coordinate anywhere. Distance in metres is administrator evidence that stays in the
 * database (D-030); the finding is "this journey was not possible", not a track.
 */
export function describeException(kind: string, evidence: Evidence): string {
  switch (kind) {
    case "missing_clock_out": {
      const end = ts(evidence, "scheduled_end");
      const mins = num(evidence, "threshold_minutes");
      return (
        `The visit was scheduled to end at ${fmtTime(end)} and was never closed` +
        (mins ? `, ${mins} minutes past the point the agency starts asking.` : ".") +
        " The hours cannot be worked out until it is."
      );
    }
    case "missed_visit": {
      const start = ts(evidence, "scheduled_start");
      const mins = num(evidence, "threshold_minutes");
      return (
        `Scheduled to start at ${fmtTime(start)}. Nothing was recorded` +
        (mins ? ` within ${mins} minutes of that time` : "") +
        ", so the visit was marked as never started."
      );
    }
    case "overlapping_visits": {
      const mins = num(evidence, "overlap_minutes");
      return (
        `This visit overlaps another visit for the same caregiver` +
        (mins ? ` by ${mins} ${mins === 1 ? "minute" : "minutes"}` : "") +
        ". One person cannot be in both places, so one of the two records is wrong."
      );
    }
    case "impossible_travel": {
      const speed = num(evidence, "speed_kmh");
      const limit = num(evidence, "threshold_kmh");
      return (
        "The gap between two clock times is too short for the journey between them" +
        (speed && limit ? ` — it works out to ${speed} km/h against a ${limit} km/h limit.` : ".") +
        " Either a time or a place of care on file is wrong."
      );
    }
    case "documentation_missing":
      return "The visit is complete but no note was written anywhere on the record, and this client's policy requires one.";
    case "manual_correction":
      return "A recorded clock time was corrected by hand. The original time stays on the record beside the correction — nothing was overwritten.";
    case "outside_geofence":
      return "The clock was recorded away from the place of care on this client's file. It may be a visit somewhere else, or the address on file may need updating.";
    case "low_accuracy":
      return "The location reading that came with the clock was too imprecise to confirm the place of care.";
    case "location_unavailable":
      return "No location came with the clock. The visit is recorded; the place is not confirmed.";
    case "location_unverified":
      return "The place of care could not be confirmed when the caregiver clocked.";
    case "late_start": {
      const mins = num(evidence, "late_minutes");
      return mins
        ? `The caregiver clocked in ${mins} ${mins === 1 ? "minute" : "minutes"} after the scheduled start.`
        : "The caregiver clocked in after the scheduled start.";
    }
    case "early_end": {
      const mins = num(evidence, "early_minutes");
      return mins
        ? `The visit was closed ${mins} ${mins === 1 ? "minute" : "minutes"} before the scheduled end.`
        : "The visit was closed before its scheduled end.";
    }
    case "long_visit": {
      const mins = num(evidence, "verified_minutes");
      return mins
        ? `The recorded visit ran ${fmtMinutes(mins)} — well past what was scheduled.`
        : "The recorded visit ran well past what was scheduled.";
    }
    case "short_visit": {
      const mins = num(evidence, "verified_minutes");
      return mins
        ? `The recorded visit ran ${fmtMinutes(mins)} — well short of what was scheduled.`
        : "The recorded visit ran well short of what was scheduled.";
    }
    case "duplicate_visit":
      return "Two records look like the same visit. Paying both would be paying twice for one piece of work.";
    case "evv_rejected":
      return "The state's system did not accept this visit record. It has to be corrected and sent again.";
    case "payroll_mismatch":
      return "The hours approved for pay do not match the hours the clock ledger shows.";
    default:
      return "The automatic checks flagged something on this visit that a person should look at.";
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Small shared bits of chrome
 * ═══════════════════════════════════════════════════════════════════════════ */

/** A quiet key/value line for row metadata. Numbers carry `tabular` at the call site. */
export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
      {children}
    </p>
  );
}

/** The separator used between metadata facts, so every row reads the same way. */
export const DOT = " · ";
