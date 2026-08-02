"use server";

/**
 * Natural-language analytics (docs/16 §2 X4, Wave 5).
 *
 * The whole design in one sentence: the model chooses WHICH governed report to run and
 * nothing else — it never writes SQL, never sees a row, and never narrates a number.
 *
 *   question ─▶ router (model, optional) ─▶ report id + window ─▶ report runs under the
 *                                                                asker's own RLS
 *
 * Consequences that make this safe to ship:
 *   * There is no free-text query path. A report id that is not in this catalog is
 *     refused before any database call (invariant 2 in spirit: the perimeter is not
 *     app-side, but neither is there an app-side hole to walk through).
 *   * Every report reads with explicit columns through the caller's client, so a
 *     coordinator, an owner and an RN asking the same question get the answer their
 *     permissions allow — and the surface says so out loud.
 *   * The counts and the narration are computed here from the returned rows, never by
 *     the model (invariant 13). With the model unavailable the eight suggested questions
 *     still work end to end, because a button maps straight to a report id, and a typed
 *     question falls back to a deterministic keyword router.
 *
 * PHI: rows are rendered to an authenticated, AAL2-gated surface. Nothing but the
 * question's PHI-safe digest and the chosen report id reaches the ledger, and the only
 * thing that ever reaches the model is the question text plus this catalog — never a row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import {
  digest,
  recordDisposition,
  runCapability,
  type DispositionAction,
  type DispositionReason,
} from "@/lib/ai/client";

const CAPABILITY_KEY = "analytics.query";
const AGENCY_TZ = "America/New_York";
const MAX_QUESTION = 300;
const ROW_CAP = 200;

/* ─────────────────────────── Shapes ─────────────────────────── */

export type ColumnSpec = { header: string; align?: "left" | "right" };

export type AnalyticsAnswer = {
  ok: boolean;
  reportId: string | null;
  /** Human name of the report that answered, e.g. "visits without notes". */
  reportName: string | null;
  question: string;
  narration: string;
  columns: ColumnSpec[];
  rows: string[][];
  total: number;
  /** "the last 30 days", "the next 7 days" — the window the report actually used. */
  windowLabel: string | null;
  scopeNote: string | null;
  /** How the question found its report: the assistant, a keyword match, or a button. */
  routedBy: "assistant" | "keywords" | "button";
  /** Honest note when the assistant was unavailable or declined. */
  aiNote: string | null;
  interactionId: string | null;
  model: string | null;
  error: string | null;
};

export type ReportSummary = {
  id: string;
  name: string;
  question: string;
  description: string;
};

/* ─────────────────────────── Formatting ─────────────────────────── */

function fmtDate(iso: string | null): string {
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

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${fmtDate(iso)} · ${d.toLocaleTimeString("en-US", {
    timeZone: AGENCY_TZ,
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function fmtDay(dateOnly: string | null): string {
  if (!dateOnly) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  if (!m) return fmtDate(dateOnly);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function hoursBetween(startISO: string, endISO: string): number {
  return Math.max(0, (Date.parse(endISO) - Date.parse(startISO)) / 3_600_000);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function daysAheadISO(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/* ─────────────────────────── Name resolution (ids travel, content refetched) ─────────────────────────── */

async function clientNames(
  supabase: SupabaseClient,
  ids: string[]
): Promise<Map<string, { name: string; city: string | null }>> {
  const map = new Map<string, { name: string; city: string | null }>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;
  const { data } = await supabase
    .from("client")
    .select("id, first_name, last_name, city")
    .in("id", unique);
  for (const c of (data ?? []) as {
    id: string;
    first_name: string;
    last_name: string;
    city: string | null;
  }[]) {
    map.set(c.id, { name: `${c.first_name} ${c.last_name}`, city: c.city });
  }
  return map;
}

async function staffNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;
  const { data } = await supabase.from("app_user").select("id, full_name").in("id", unique);
  for (const u of (data ?? []) as { id: string; full_name: string | null }[]) {
    map.set(u.id, u.full_name ?? "Staff member");
  }
  return map;
}

/* ─────────────────────────── The governed catalog ─────────────────────────── */

type ReportRun = {
  columns: ColumnSpec[];
  rows: string[][];
  total: number;
  scopeNote?: string;
};

type ReportDef = {
  id: string;
  /** Used in "answered with the '…' report". */
  name: string;
  /** The suggested-question button label — also the plain-English intent. */
  question: string;
  description: string;
  keywords: string[];
  window: { defaultDays: number; minDays: number; maxDays: number; label: (d: number) => string } | null;
  run: (supabase: SupabaseClient, days: number) => Promise<ReportRun>;
  narrate: (total: number, days: number) => string;
};

const BACK = (d: number) => `the last ${d} days`;
const AHEAD = (d: number) => `the next ${d} days`;

type VisitRow = {
  id: string;
  client_id: string;
  caregiver_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
};

const REPORTS: ReportDef[] = [
  {
    id: "visits_without_notes",
    name: "visits without notes",
    question: "Which completed visits have no finalized note?",
    description:
      "Completed visits in a trailing window with no finalized visit note attached. Window in days.",
    keywords: ["note", "notes", "documentation", "undocumented", "missing", "unfinished", "visit"],
    window: { defaultDays: 30, minDays: 1, maxDays: 180, label: BACK },
    async run(supabase, days) {
      const { data } = await supabase
        .from("visit")
        .select("id, client_id, caregiver_id, scheduled_start, scheduled_end, status")
        .eq("status", "completed")
        .gte("scheduled_start", daysAgoISO(days))
        .order("scheduled_start", { ascending: false })
        .limit(500);
      const visits = (data ?? []) as VisitRow[];
      if (visits.length === 0) {
        return { columns: [], rows: [], total: 0 };
      }

      const { data: notes } = await supabase
        .from("form_instance")
        .select("visit_id, status")
        .eq("status", "final")
        .in("visit_id", visits.map((v) => v.id));
      const documented = new Set(
        ((notes ?? []) as { visit_id: string | null }[])
          .map((n) => n.visit_id)
          .filter((id): id is string => Boolean(id))
      );

      const missing = visits.filter((v) => !documented.has(v.id));
      const clients = await clientNames(supabase, missing.map((v) => v.client_id));
      const staff = await staffNames(
        supabase,
        missing.map((v) => v.caregiver_id).filter((id): id is string => Boolean(id))
      );

      return {
        columns: [
          { header: "Client" },
          { header: "Visit" },
          { header: "Caregiver" },
          { header: "Note" },
        ],
        rows: missing.slice(0, ROW_CAP).map((v) => [
          clients.get(v.client_id)?.name ?? "Client",
          fmtDateTime(v.scheduled_start),
          v.caregiver_id ? (staff.get(v.caregiver_id) ?? "Caregiver") : "Unassigned",
          "No finalized note",
        ]),
        total: missing.length,
        scopeNote:
          "A note you are not permitted to read counts as missing here — this answer is scoped to your access.",
      };
    },
    narrate: (total, days) =>
      total === 0
        ? `Every completed visit in ${BACK(days)} has a finalized note.`
        : `${total} completed ${plural(total, "visit", "visits")} in ${BACK(days)} ${plural(total, "has", "have")} no finalized note.`,
  },

  {
    id: "open_shifts",
    name: "open shifts",
    question: "Which shifts still need a caregiver?",
    description: "Scheduled visits with no caregiver assigned, in a forward window of days.",
    keywords: [
      "open", "shift", "shifts", "unassigned", "uncovered", "coverage", "gap", "fill", "needs",
      "cover", "vacant",
    ],
    window: { defaultDays: 14, minDays: 1, maxDays: 90, label: AHEAD },
    async run(supabase, days) {
      const { data } = await supabase
        .from("visit")
        .select("id, client_id, caregiver_id, scheduled_start, scheduled_end, status")
        .is("caregiver_id", null)
        .eq("status", "scheduled")
        .gte("scheduled_start", new Date().toISOString())
        .lte("scheduled_start", daysAheadISO(days))
        .order("scheduled_start", { ascending: true })
        .limit(ROW_CAP);
      const visits = (data ?? []) as VisitRow[];
      const clients = await clientNames(supabase, visits.map((v) => v.client_id));
      return {
        columns: [
          { header: "Client" },
          { header: "When" },
          { header: "Length", align: "right" },
          { header: "City" },
        ],
        rows: visits.map((v) => [
          clients.get(v.client_id)?.name ?? "Client",
          fmtDateTime(v.scheduled_start),
          `${hoursBetween(v.scheduled_start, v.scheduled_end).toFixed(1)}h`,
          clients.get(v.client_id)?.city ?? "—",
        ]),
        total: visits.length,
      };
    },
    narrate: (total, days) =>
      total === 0
        ? `Every visit in ${AHEAD(days)} has a caregiver assigned.`
        : `${total} ${plural(total, "visit", "visits")} in ${AHEAD(days)} still ${plural(total, "needs", "need")} a caregiver.`,
  },

  {
    id: "credentials_expiring",
    name: "credentials expiring",
    question: "Whose credentials expire soon?",
    description:
      "Staff credentials that have lapsed or expire within a forward window of days, from the credential expiry engine.",
    keywords: ["credential", "credentials", "license", "expire", "expiring", "expiry", "lapsed", "renewal", "cpr", "tb"],
    window: { defaultDays: 60, minDays: 1, maxDays: 365, label: AHEAD },
    async run(supabase, days) {
      const { data } = await supabase
        .from("credential_expiry")
        .select(
          "credential_id, app_user_id, credential_type_name, blocks_scheduling, expires_on, days_to_expiry, expiry_bucket"
        )
        .lte("days_to_expiry", days)
        .order("days_to_expiry", { ascending: true })
        .limit(ROW_CAP);
      const rows = (data ?? []) as {
        credential_id: string;
        app_user_id: string;
        credential_type_name: string;
        blocks_scheduling: boolean;
        expires_on: string | null;
        days_to_expiry: number | null;
        expiry_bucket: string;
      }[];
      const staff = await staffNames(supabase, rows.map((r) => r.app_user_id));
      return {
        columns: [
          { header: "Staff member" },
          { header: "Credential" },
          { header: "Expires" },
          { header: "Blocks scheduling" },
        ],
        rows: rows.map((r) => [
          staff.get(r.app_user_id) ?? "Staff member",
          r.credential_type_name,
          r.days_to_expiry !== null && r.days_to_expiry < 0
            ? `${fmtDay(r.expires_on)} · lapsed ${Math.abs(r.days_to_expiry)}d ago`
            : `${fmtDay(r.expires_on)} · in ${r.days_to_expiry ?? 0}d`,
          r.blocks_scheduling ? "Yes" : "No",
        ]),
        total: rows.length,
        scopeNote:
          "Expiry dates and buckets come from the credential engine in the database, not from the assistant.",
      };
    },
    narrate: (total, days) =>
      total === 0
        ? `No credential has lapsed or expires within ${AHEAD(days)}.`
        : `${total} ${plural(total, "credential has", "credentials have")} lapsed or expire within ${AHEAD(days)}.`,
  },

  {
    id: "obligations_overdue",
    name: "overdue obligations",
    question: "Which compliance obligations are overdue or at risk?",
    description:
      "Cadence obligations whose computed status is overdue or at risk, from the compliance engine. No window argument.",
    keywords: ["obligation", "obligations", "compliance", "overdue", "due", "risk", "comar", "supervisory", "cadence", "assessment"],
    window: null,
    async run(supabase) {
      const { data } = await supabase
        .from("cadence_obligation_status")
        .select(
          "id, client_id, staff_id, rule_name, severity, effective_due_on, days_until_due, computed_status, comar_source_ref"
        )
        .in("computed_status", ["overdue", "at_risk"])
        .order("effective_due_on", { ascending: true })
        .limit(ROW_CAP);
      const rows = (data ?? []) as {
        id: string;
        client_id: string | null;
        staff_id: string | null;
        rule_name: string;
        severity: string;
        effective_due_on: string | null;
        days_until_due: number | null;
        computed_status: string;
        comar_source_ref: string | null;
      }[];
      const clients = await clientNames(
        supabase,
        rows.map((r) => r.client_id).filter((id): id is string => Boolean(id))
      );
      const staff = await staffNames(
        supabase,
        rows.map((r) => r.staff_id).filter((id): id is string => Boolean(id))
      );
      return {
        columns: [
          { header: "Who" },
          { header: "Requirement" },
          { header: "Due" },
          { header: "Status" },
        ],
        rows: rows.map((r) => [
          r.client_id
            ? (clients.get(r.client_id)?.name ?? "Client")
            : r.staff_id
              ? (staff.get(r.staff_id) ?? "Staff member")
              : "Agency-wide",
          r.comar_source_ref ? `${r.rule_name} · ${r.comar_source_ref}` : r.rule_name,
          r.days_until_due !== null && r.days_until_due < 0
            ? `${fmtDay(r.effective_due_on)} · ${Math.abs(r.days_until_due)}d late`
            : `${fmtDay(r.effective_due_on)} · in ${r.days_until_due ?? 0}d`,
          r.computed_status === "overdue" ? "Overdue" : "At risk",
        ]),
        total: rows.length,
        scopeNote:
          "Due dates and status come from the cadence engine in the database. The assistant never computes a deadline.",
      };
    },
    narrate: (total) =>
      total === 0
        ? "No compliance obligation is overdue or at risk right now."
        : `${total} compliance ${plural(total, "obligation is", "obligations are")} overdue or at risk.`,
  },

  {
    id: "missed_visits_by_client",
    name: "clients with repeat missed visits",
    question: "Which clients have two or more missed visits?",
    description:
      "Clients with two or more visits marked missed inside a trailing window. Window in days.",
    keywords: ["missed", "no-show", "noshow", "cancel", "cancelled", "repeat", "client", "disruption"],
    window: { defaultDays: 30, minDays: 7, maxDays: 180, label: BACK },
    async run(supabase, days) {
      const { data } = await supabase
        .from("visit")
        .select("id, client_id, caregiver_id, scheduled_start, scheduled_end, status")
        .eq("status", "missed")
        .gte("scheduled_start", daysAgoISO(days))
        .order("scheduled_start", { ascending: false })
        .limit(1000);
      const visits = (data ?? []) as VisitRow[];

      const byClient = new Map<string, { count: number; last: string }>();
      for (const v of visits) {
        const cur = byClient.get(v.client_id);
        if (!cur) byClient.set(v.client_id, { count: 1, last: v.scheduled_start });
        else {
          cur.count += 1;
          if (Date.parse(v.scheduled_start) > Date.parse(cur.last)) cur.last = v.scheduled_start;
        }
      }
      const repeat = [...byClient.entries()]
        .filter(([, v]) => v.count >= 2)
        .sort((a, b) => b[1].count - a[1].count);
      const clients = await clientNames(supabase, repeat.map(([id]) => id));

      return {
        columns: [
          { header: "Client" },
          { header: "Missed visits", align: "right" },
          { header: "Most recent" },
        ],
        rows: repeat
          .slice(0, ROW_CAP)
          .map(([id, v]) => [clients.get(id)?.name ?? "Client", String(v.count), fmtDate(v.last)]),
        total: repeat.length,
      };
    },
    narrate: (total, days) =>
      total === 0
        ? `No client has two or more missed visits in ${BACK(days)}.`
        : `${total} ${plural(total, "client has", "clients have")} two or more missed visits in ${BACK(days)}.`,
  },

  {
    id: "caregiver_hours",
    name: "caregiver hours",
    question: "How many hours is each caregiver scheduled?",
    description:
      "Scheduled hours, visit count and client count per caregiver over a forward window of days.",
    keywords: ["hours", "workload", "caregiver", "overtime", "capacity", "scheduled", "load", "week"],
    window: { defaultDays: 7, minDays: 1, maxDays: 60, label: AHEAD },
    async run(supabase, days) {
      const { data } = await supabase
        .from("visit")
        .select("id, client_id, caregiver_id, scheduled_start, scheduled_end, status")
        .not("caregiver_id", "is", null)
        .in("status", ["scheduled", "in_progress", "completed"])
        .gte("scheduled_start", new Date().toISOString())
        .lte("scheduled_start", daysAheadISO(days))
        .limit(1000);
      const visits = (data ?? []) as VisitRow[];

      const byCg = new Map<string, { visits: number; hours: number; clients: Set<string> }>();
      for (const v of visits) {
        if (!v.caregiver_id) continue;
        const cur = byCg.get(v.caregiver_id) ?? { visits: 0, hours: 0, clients: new Set<string>() };
        cur.visits += 1;
        cur.hours += hoursBetween(v.scheduled_start, v.scheduled_end);
        cur.clients.add(v.client_id);
        byCg.set(v.caregiver_id, cur);
      }
      const ranked = [...byCg.entries()].sort((a, b) => b[1].hours - a[1].hours);
      const staff = await staffNames(supabase, ranked.map(([id]) => id));

      return {
        columns: [
          { header: "Caregiver" },
          { header: "Visits", align: "right" },
          { header: "Hours", align: "right" },
          { header: "Clients", align: "right" },
        ],
        rows: ranked
          .slice(0, ROW_CAP)
          .map(([id, v]) => [
            staff.get(id) ?? "Caregiver",
            String(v.visits),
            v.hours.toFixed(1),
            String(v.clients.size),
          ]),
        total: ranked.length,
        scopeNote:
          "Hours are the scheduled window of each visit. Delivered time comes from clock events, not from this report.",
      };
    },
    narrate: (total, days) =>
      total === 0
        ? `No caregiver has a scheduled visit in ${AHEAD(days)}.`
        : `${total} ${plural(total, "caregiver has", "caregivers have")} scheduled visits in ${AHEAD(days)}.`,
  },

  {
    id: "visits_by_client",
    name: "visits by client",
    question: "How many visits has each client had recently?",
    description:
      "Visit counts per client over a trailing window, split into completed and missed. Window in days.",
    keywords: ["visits", "how many", "per client", "count", "delivered", "utilization", "service"],
    window: { defaultDays: 30, minDays: 7, maxDays: 180, label: BACK },
    async run(supabase, days) {
      const { data } = await supabase
        .from("visit")
        .select("id, client_id, caregiver_id, scheduled_start, scheduled_end, status")
        .gte("scheduled_start", daysAgoISO(days))
        .limit(1000);
      const visits = (data ?? []) as VisitRow[];

      const byClient = new Map<string, { total: number; completed: number; missed: number }>();
      for (const v of visits) {
        const cur = byClient.get(v.client_id) ?? { total: 0, completed: 0, missed: 0 };
        cur.total += 1;
        if (v.status === "completed") cur.completed += 1;
        if (v.status === "missed") cur.missed += 1;
        byClient.set(v.client_id, cur);
      }
      const ranked = [...byClient.entries()].sort((a, b) => b[1].total - a[1].total);
      const clients = await clientNames(supabase, ranked.map(([id]) => id));

      return {
        columns: [
          { header: "Client" },
          { header: "Visits", align: "right" },
          { header: "Completed", align: "right" },
          { header: "Missed", align: "right" },
        ],
        rows: ranked
          .slice(0, ROW_CAP)
          .map(([id, v]) => [
            clients.get(id)?.name ?? "Client",
            String(v.total),
            String(v.completed),
            String(v.missed),
          ]),
        total: ranked.length,
      };
    },
    narrate: (total, days) =>
      total === 0
        ? `No visits are on the schedule for ${BACK(days)}.`
        : `${total} ${plural(total, "client has", "clients have")} visits on the schedule in ${BACK(days)}.`,
  },

  {
    id: "client_census",
    name: "client census",
    question: "How many clients are active, on hold or in intake?",
    description: "Client counts grouped by status across the agency. No window argument.",
    keywords: ["census", "how many clients", "active", "hold", "intake", "inquiry", "discharged", "status", "roster"],
    window: null,
    async run(supabase) {
      const { data } = await supabase.from("client").select("id, status").limit(1000);
      const rows = (data ?? []) as { id: string; status: string }[];
      const byStatus = new Map<string, number>();
      for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

      const LABEL: Record<string, string> = {
        active: "Active",
        inquiry: "Inquiry",
        pending_admission: "Pending admission",
        on_hold: "On hold",
        discharged: "Discharged",
      };
      const ordered = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
      return {
        columns: [{ header: "Status" }, { header: "Clients", align: "right" }],
        rows: ordered.map(([status, n]) => [LABEL[status] ?? status, String(n)]),
        total: rows.length,
      };
    },
    narrate: (total) =>
      total === 0
        ? "No client records are visible to you."
        : `${total} client ${plural(total, "record is", "records are")} on the roster.`,
  },
];

function reportById(id: string | null | undefined): ReportDef | null {
  if (!id) return null;
  return REPORTS.find((r) => r.id === id) ?? null;
}

function clampDays(report: ReportDef, requested: number | null): number {
  if (!report.window) return 0;
  const { defaultDays, minDays, maxDays } = report.window;
  if (requested === null || !Number.isFinite(requested)) return defaultDays;
  return Math.max(minDays, Math.min(maxDays, Math.round(requested)));
}

/** The eight buttons — and the catalog the router chooses from. */
export async function listReports(): Promise<ReportSummary[]> {
  return REPORTS.map((r) => ({
    id: r.id,
    name: r.name,
    question: r.question,
    description: r.description,
  }));
}

/* ─────────────────────────── Deterministic keyword router (the offline path) ─────────────────────────── */

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "what",
  "how", "when", "who", "why", "do", "does", "can", "we", "our", "my", "me", "show", "list",
  "many", "much", "any", "this", "that", "have", "has", "had", "all", "get", "give",
]);

function routeByKeywords(question: string): ReportDef | null {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
  if (tokens.length === 0) return null;

  let best: { report: ReportDef; score: number } | null = null;
  for (const report of REPORTS) {
    const hay = `${report.question} ${report.description} ${report.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (report.keywords.includes(t)) score += 2;
      else if (hay.includes(t)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { report, score };
  }
  return best ? best.report : null;
}

/** "in the last 45 days", "next 10 days" — a window the asker stated explicitly. */
function daysFromQuestion(question: string): number | null {
  const m = /(\d{1,3})\s*(day|days|d)\b/i.exec(question);
  if (m) return Number(m[1]);
  if (/\bthis (week|coming week)\b/i.test(question)) return 7;
  if (/\b(this month|past month|last month|monthly)\b/i.test(question)) return 30;
  if (/\b(quarter|90 days|3 months)\b/i.test(question)) return 90;
  return null;
}

/* ─────────────────────────── Router (the model's only job) ─────────────────────────── */

const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    report_id: {
      type: ["string", "null"],
      description: "The id of exactly one report from the catalog, copied exactly, or null.",
    },
    days: {
      type: ["integer", "null"],
      description: "The window in days when the report takes one and the question implies it.",
    },
    refusal: {
      type: ["string", "null"],
      description: "One plain sentence saying what the platform can answer instead, or null.",
    },
  },
  required: ["report_id", "days", "refusal"],
  additionalProperties: false,
} as const;

/** Built-in prompt; the ACTIVE analytics.query registry template overrides it. */
const ROUTER_SYSTEM =
  "You are the CareOS analytics router for a Maryland home-care agency.\n" +
  "You do not answer questions and you never write SQL. You map the question onto exactly " +
  "one governed, read-only report from the catalog and fill its window argument.\n" +
  "- Choose one report id from the catalog, copied exactly, or none.\n" +
  "- If no report answers the question, set report_id to null and use refusal to say in one " +
  "sentence what the platform can answer instead. Never approximate with a report that " +
  "answers a different question.\n" +
  "- Resolve relative time only against the current date supplied in the facts. Never guess a date.\n" +
  "- You do not see the result. The report runs under the asker's own permissions.\n" +
  "- Refuse a question that asks for a clinical judgment, an eligibility decision, or a dollar " +
  "figure that is not a stored fact.";

type RouteResult = {
  report: ReportDef | null;
  days: number | null;
  routedBy: "assistant" | "keywords";
  aiNote: string | null;
  refusal: string | null;
  interactionId: string | null;
  model: string | null;
};

async function route(supabase: SupabaseClient, question: string): Promise<RouteResult> {
  const catalog = REPORTS.map((r) => ({
    id: r.id,
    answers: r.question,
    description: r.description,
    window: r.window
      ? { unit: "days", default: r.window.defaultDays, min: r.window.minDays, max: r.window.maxDays }
      : null,
  }));

  const res = await runCapability(supabase, CAPABILITY_KEY, {
    system: ROUTER_SYSTEM,
    user:
      `Today is ${new Date().toLocaleDateString("en-US", { timeZone: AGENCY_TZ, dateStyle: "full" })}.\n` +
      `Report catalog:\n${JSON.stringify(catalog)}\n\n` +
      `Question: ${question}\n\n` +
      "Return JSON with report_id, days and refusal.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "analytics_route",
      schema: ROUTER_SCHEMA as unknown as Record<string, unknown>,
    },
    // PHI-safe: the ledger keeps the question digest, exactly as the Brain does — never a row.
    inputDigest: digest(question, 200),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  // Tracks whether the model answered at all, so the degrade note tells the truth about
  // WHICH thing went wrong: an unreachable assistant, or one that picked nothing.
  let assistantResponded = false;

  if (res.status === "ok" && res.text.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(res.text) as {
        report_id?: unknown;
        days?: unknown;
        refusal?: unknown;
      };
      assistantResponded = true;
      const report = reportById(typeof obj.report_id === "string" ? obj.report_id : null);
      const refusal =
        typeof obj.refusal === "string" && obj.refusal.trim() ? obj.refusal.trim() : null;
      if (report) {
        return {
          report,
          days: typeof obj.days === "number" ? obj.days : null,
          routedBy: "assistant",
          aiNote: null,
          refusal: null,
          interactionId: res.interactionId,
          model: res.model,
        };
      }
      if (refusal) {
        return {
          report: null,
          days: null,
          routedBy: "assistant",
          aiNote: null,
          refusal: refusal.slice(0, 300),
          interactionId: res.interactionId,
          model: res.model,
        };
      }
    } catch {
      // Fall through to the deterministic router.
    }
  }

  const note = assistantResponded
    ? "The assistant did not pick a report, so the closest matching report was chosen from your words."
    : res.status === "blocked"
      ? res.reason === "budget"
        ? "Question routing is paused for this month's budget, so the closest matching report was chosen from your words."
        : "Question routing is switched off, so the closest matching report was chosen from your words."
      : "The assistant was unavailable, so the closest matching report was chosen from your words.";

  return {
    report: routeByKeywords(question),
    days: daysFromQuestion(question),
    routedBy: "keywords",
    aiNote: note,
    refusal: null,
    interactionId: res.interactionId,
    model: res.model,
  };
}

/* ─────────────────────────── Running a report ─────────────────────────── */

function emptyAnswer(question: string, overrides: Partial<AnalyticsAnswer>): AnalyticsAnswer {
  return {
    ok: false,
    reportId: null,
    reportName: null,
    question,
    narration: "",
    columns: [],
    rows: [],
    total: 0,
    windowLabel: null,
    scopeNote: null,
    routedBy: "button",
    aiNote: null,
    interactionId: null,
    model: null,
    error: null,
    ...overrides,
  };
}

async function execute(
  supabase: SupabaseClient,
  report: ReportDef,
  requestedDays: number | null,
  question: string,
  meta: Pick<AnalyticsAnswer, "routedBy" | "aiNote" | "interactionId" | "model">
): Promise<AnalyticsAnswer> {
  const days = clampDays(report, requestedDays);
  try {
    const result = await report.run(supabase, days);
    return {
      ok: true,
      reportId: report.id,
      reportName: report.name,
      question,
      narration: report.narrate(result.total, days),
      columns: result.columns,
      rows: result.rows,
      total: result.total,
      windowLabel: report.window ? report.window.label(days) : null,
      scopeNote: result.scopeNote ?? null,
      error: null,
      ...meta,
    };
  } catch {
    return emptyAnswer(question, {
      reportId: report.id,
      reportName: report.name,
      error:
        "The report could not be run. Nothing was changed, and no data was written. Try again, or verify your session if it has expired.",
      ...meta,
    });
  }
}

/**
 * A suggested question: the button maps straight to a report id, so this path never
 * calls a model and works identically when the assistant is unavailable.
 */
export async function runReport(reportId: string, days?: number): Promise<AnalyticsAnswer> {
  const report = reportById(reportId);
  if (!report) {
    return emptyAnswer("", {
      error: "That report is not in the catalog. Pick one of the suggested questions.",
    });
  }
  const supabase = await supabaseServer();
  return execute(supabase, report, days ?? null, report.question, {
    routedBy: "button",
    aiNote: null,
    interactionId: null,
    model: null,
  });
}

/** A typed question: routed by the assistant when it is available, by keywords when not. */
export async function askAnalytics(question: string): Promise<AnalyticsAnswer> {
  const q = question.trim().slice(0, MAX_QUESTION);
  if (!q) {
    return emptyAnswer("", { error: "Type a question, or pick one of the suggested questions." });
  }

  const supabase = await supabaseServer();
  const routed = await route(supabase, q);

  if (!routed.report) {
    return emptyAnswer(q, {
      routedBy: routed.routedBy,
      aiNote: routed.aiNote,
      interactionId: routed.interactionId,
      model: routed.model,
      error:
        routed.refusal ??
        "No governed report answers that question. The suggested questions below are what this surface can answer today.",
    });
  }

  return execute(supabase, routed.report, routed.days, q, {
    routedBy: routed.routedBy,
    aiNote: routed.aiNote,
    interactionId: routed.interactionId,
    model: routed.model,
  });
}

/**
 * The flywheel for routing quality (docs/16 §3.2): "did this answer the question?" is a
 * label on the exact model + prompt version that chose the report. Append-only, self-pinned
 * by RLS, and never fatal — losing a label must not cost the reader the answer on screen.
 */
export async function disposeAnalytics(
  interactionId: string,
  action: DispositionAction,
  reason?: DispositionReason
): Promise<{ ok: boolean; error?: string }> {
  const id = interactionId?.trim();
  if (!id) return { ok: false, error: "This answer has no ledger record to attach feedback to." };
  const supabase = await supabaseServer();
  const res = await recordDisposition(supabase, id, CAPABILITY_KEY, action, reason);
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "Feedback could not be saved." };
}
