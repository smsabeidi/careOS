"use server";

/**
 * Clinical depth — the RN's two T2 loops (docs/16 §2.4 R2 and R3).
 *
 * R3 · Clinical early-warning flags
 *   The rules in RULES below are the detector. They read the same records the nurse
 *   reads — assessment `general_condition`, visit-note `client_mood`, schedule
 *   exceptions, delivered-vs-scheduled hours — under the caller's RLS, and decide
 *   kind + severity deterministically (invariant 13). The model's ONLY job is to turn
 *   an already-decided finding into the sentence a nurse reads first; when it is
 *   unreachable the platform's own sentence is stored instead and the flag still
 *   lands. A flag never escalates itself: it sits at `open` until an RN acknowledges
 *   or dismisses it (invariant 8, DB-enforced by clinical_flag's column guard).
 *
 * R2 · Care-plan review drafts
 *   The plan, its items, and the records since it was authored are read under RLS and
 *   injected as ground truth. Proposals come back anchored to a supplied record ref;
 *   anything anchored to a record we did not supply is dropped before the nurse ever
 *   sees it. Accepting them writes a NEW care_plan version (append-only, invariant 1)
 *   whose prev_version_id points at the version it revises — v1 is never touched.
 *
 * PHI discipline (invariant 5): prompts carry clinical fields and dates only — no
 * names, no addresses, no identifiers — and every ledger digest is a shape, not a
 * record ("careplan review · v2 · 7 records"). Client names live in the surface the
 * nurse is already looking at, never in a prompt or a digest.
 *
 * Nothing here uses service_role (invariant 6); every read and write rides the
 * caller's session, so AAL2 + care-team scoping are enforced by Postgres.
 */

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { digest, recordDisposition, runCapability } from "@/lib/ai/client";
import { getProfile } from "@/lib/profile";

const FLAG_CAPABILITY = "clinical.flag";
const REVIEW_CAPABILITY = "careplan.review";
const ASSESSMENT_TEMPLATE = "rn_assessment";
const VISIT_NOTE_TEMPLATE = "visit_note";
const CLINICAL_ROLES = ["rn", "owner", "admin"];

/**
 * The detector. Every threshold that decides whether a flag exists, and how severe it
 * is, lives here and nowhere else — not in a prompt, not in a component.
 *
 * Known gap, deliberately surfaced rather than hidden: docs/16 wants this series math
 * in SQL (an `app.detect_clinical_flags` rules function) so pgTAP can pin it. It runs
 * here for now, over RLS-scoped reads, with the thresholds named once. Moving it into
 * a migration is a schema task, proposed in the story result.
 */
const RULES = {
  conditionWindowDays: 120,
  conditionSeriesLen: 4,
  moodWindowDays: 30,
  moodSeriesLen: 4,
  lowMoods: ["Tired", "Anxious"] as readonly string[],
  moodMediumCount: 3,
  exceptionWindowDays: 14,
  exceptionMedium: 3,
  exceptionHigh: 5,
  shortfallWindowDays: 30,
  shortfallMediumRatio: 0.85,
  shortfallHighRatio: 0.7,
  /** Below this EVV pairing rate the hours series is a documentation gap, not a care gap. */
  shortfallMinEvvCoverage: 0.7,
  /** Do not re-raise the same (client, kind) while a recent flag is still on the board. */
  resuppressDays: 14,
  maxClientsPerScan: 60,
  maxFindingsPerScan: 12,
  /** A plan is "in review window" this many days before its review_due_on. */
  reviewWindowDays: 14,
  maxRecordsInPrompt: 10,
  maxProposals: 8,
  /** How far back the review draft reads the chart when the version is newer than that. */
  recordLookbackDays: 120,
  /** Below this, "since this version" is too thin a window to review against. */
  minRecordsSinceVersion: 3,
} as const;

// ── Shared types (client components import these) ────────────────────────────
export type FlagKind = "condition_trend" | "mood_trend" | "exception_spike" | "visit_shortfall";
export type FlagSeverity = "info" | "medium" | "high";

export type ScanResult = {
  ok: boolean;
  raised: number;
  clientsScanned: number;
  /** Honest one-liner when the model did not write the summaries; null when it did. */
  note: string | null;
  message: string;
};

export type DisposeResult = { ok: boolean; error?: string };

export type PlanItemView = {
  id: string;
  kind: "goal" | "intervention";
  text: string;
  target: string | null;
};
export type PlanRecordView = { ref: string; label: string; date: string; detail: string };
/** Which slice of the chart the draft stands on — the nurse is told which one. */
export type PlanRecordWindow = "since_version" | "recent";
export type PlanProposal = {
  ref: string;
  kind: "goal" | "intervention";
  text: string;
  target: string | null;
  anchorRef: string;
  anchorLabel: string;
  rationale: string;
};
export type CarePlanDraft = {
  planId: string;
  clientName: string;
  version: number;
  title: string;
  currentSummary: string | null;
  reviewDueOn: string | null;
  currentItems: PlanItemView[];
  records: PlanRecordView[];
  recordsWindow: PlanRecordWindow;
  proposals: PlanProposal[];
  proposedSummary: string | null;
  /** The model looked and found nothing to change — a legitimate clinical finding. */
  noChange: boolean;
  ai: {
    provider: string;
    model: string | null;
    degraded: boolean;
    note: string | null;
    interactionId: string | null;
  };
};
export type DraftResult = { ok: true; draft: CarePlanDraft } | { ok: false; error: string };

export type CommitItem = {
  kind: "goal" | "intervention";
  text: string;
  target: string | null;
  source: "carried" | "proposed" | "nurse";
};
export type CommitResult =
  | { ok: true; version: number; itemCount: number }
  | { ok: false; error: string };

// ── Small helpers ────────────────────────────────────────────────────────────
type Ctx = { userId: string; tenantId: string };

async function currentContext(supabase: SupabaseClient): Promise<Ctx | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("app_user")
    .select("tenant_id")
    .eq("id", user.id)
    .maybeSingle();
  const tenantId = (data as { tenant_id?: string } | null)?.tenant_id;
  if (!tenantId) return null;
  return { userId: user.id, tenantId };
}

/** PostgREST returns a to-one embed as an object, but types it as a union. */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function hours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ═══════════════════════════════════════════════════════════════════════════
// R3 · Clinical early-warning flags
// ═══════════════════════════════════════════════════════════════════════════
type Finding = {
  ref: string;
  clientId: string;
  kind: FlagKind;
  severity: FlagSeverity;
  evidence: Record<string, unknown>;
  /** The platform's own sentence: ground truth for the model, fallback if it is down. */
  platformSummary: string;
};

type VersionRow = {
  content: Record<string, unknown> | null;
  authored_at: string;
  form_instance:
    | { client_id: string; form_template: { key: string } | { key: string }[] | null }
    | { client_id: string; form_template: { key: string } | { key: string }[] | null }[]
    | null;
};

/** Chronological (oldest → newest) values of one structured field, per client. */
function seriesByClient(
  rows: VersionRow[],
  templateKey: string,
  field: string
): Map<string, { value: string; at: string }[]> {
  const out = new Map<string, { value: string; at: string }[]>();
  for (const r of rows) {
    const inst = one(r.form_instance);
    if (!inst) continue;
    const tpl = one(inst.form_template);
    if (tpl?.key !== templateKey) continue;
    const value = str(r.content?.[field]);
    if (!value) continue;
    const list = out.get(inst.client_id) ?? [];
    list.push({ value, at: r.authored_at });
    out.set(inst.client_id, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}

function conditionFinding(
  clientId: string,
  series: { value: string; at: string }[]
): Omit<Finding, "ref"> | null {
  const recent = series.slice(-RULES.conditionSeriesLen);
  if (recent.length < 2) return null;
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const twoDeclining = last.value === "Declining" && prev.value === "Declining";
  if (last.value !== "Declining") return null;

  const severity: FlagSeverity = twoDeclining ? "high" : "medium";
  const dates = recent.map((r) => dayLabel(r.at));
  const platformSummary = twoDeclining
    ? `General condition was recorded as Declining on the last two assessments (${dayLabel(prev.at)} and ${dayLabel(last.at)}), after ${recent.slice(0, -2).map((r) => r.value).join(", ") || "no earlier entry"} before that.`
    : `General condition was recorded as Declining on the ${dayLabel(last.at)} assessment, after ${prev.value} on ${dayLabel(prev.at)}.`;

  return {
    clientId,
    kind: "condition_trend",
    severity,
    evidence: {
      metric: "general_condition",
      series: recent.map((r) => r.value),
      dates,
      window_days: RULES.conditionWindowDays,
      source: "form_version.structured_fields",
    },
    platformSummary,
  };
}

function moodFinding(
  clientId: string,
  series: { value: string; at: string }[]
): Omit<Finding, "ref"> | null {
  const recent = series.slice(-RULES.moodSeriesLen);
  if (recent.length < RULES.moodSeriesLen) return null;
  const low = recent.filter((r) => RULES.lowMoods.includes(r.value));
  if (low.length < RULES.moodMediumCount) return null;

  const severity: FlagSeverity = low.length === recent.length ? "high" : "medium";
  return {
    clientId,
    kind: "mood_trend",
    severity,
    evidence: {
      metric: "client_mood",
      series: recent.map((r) => r.value),
      dates: recent.map((r) => dayLabel(r.at)),
      low_count: low.length,
      window_days: RULES.moodWindowDays,
      source: "form_version.structured_fields",
    },
    platformSummary:
      `${low.length} of the last ${recent.length} visit notes recorded mood as ${RULES.lowMoods.join(" or ")} ` +
      `(${recent.map((r) => `${r.value} on ${dayLabel(r.at)}`).join(", ")}).`,
  };
}

function exceptionFinding(
  clientId: string,
  kinds: string[]
): Omit<Finding, "ref"> | null {
  if (kinds.length < RULES.exceptionMedium) return null;
  const severity: FlagSeverity = kinds.length >= RULES.exceptionHigh ? "high" : "medium";
  const tally = new Map<string, number>();
  for (const k of kinds) tally.set(k, (tally.get(k) ?? 0) + 1);
  const breakdown = [...tally.entries()]
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}${n > 1 ? "s" : ""}`)
    .join(", ");
  return {
    clientId,
    kind: "exception_spike",
    severity,
    evidence: {
      metric: "schedule_exception_count",
      window_days: RULES.exceptionWindowDays,
      count: kinds.length,
      kinds,
    },
    platformSummary: `${kinds.length} schedule exceptions in the last ${RULES.exceptionWindowDays} days: ${breakdown}.`,
  };
}

function shortfallFinding(
  clientId: string,
  planned: number,
  delivered: number,
  coverage: number
): Omit<Finding, "ref"> | null {
  if (planned <= 0 || coverage < RULES.shortfallMinEvvCoverage) return null;
  const ratio = delivered / planned;
  if (ratio >= RULES.shortfallMediumRatio) return null;
  const severity: FlagSeverity = ratio < RULES.shortfallHighRatio ? "high" : "medium";
  const pct = Math.round(ratio * 100);
  return {
    clientId,
    kind: "visit_shortfall",
    severity,
    evidence: {
      metric: "delivered_vs_planned_hours",
      planned_hours: planned,
      delivered_hours: delivered,
      window_days: RULES.shortfallWindowDays,
      evv_coverage_pct: Math.round(coverage * 100),
    },
    platformSummary:
      `Clocked visit hours over the last ${RULES.shortfallWindowDays} days are ${delivered} against ${planned} scheduled — ${pct}% of the scheduled time.`,
  };
}

const FLAG_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summaries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: "One of the supplied finding refs, copied exactly." },
          summary: {
            type: "string",
            description: "One or two sentences describing the supplied series. No diagnosis, no cause, no advice.",
          },
        },
        required: ["ref", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["summaries"],
  additionalProperties: false,
} as const;

const FLAG_SYSTEM =
  "You are the CareOS early-warning summarizer for a Maryland home-care agency.\n" +
  "The platform's rules engine has already detected each pattern and set its severity. You receive the deterministic series behind it.\n" +
  "- Describe only what the series shows, using the values and dates given. Never recompute, extrapolate, or project.\n" +
  "- Never diagnose, never name a condition, never state a cause, never recommend a clinical action.\n" +
  "- Do not add urgency the facts do not support, and do not soften a pattern that is there.\n" +
  "- One or two sentences. Plain language, sentence case, no exclamation points, no reassurance, no alarm.";

/** Ask for the nurse-facing sentence; keep the platform's sentence for anything unusable. */
async function narrateFindings(
  supabase: SupabaseClient,
  findings: Finding[]
): Promise<{ written: Map<string, string>; interactionId: string | null; note: string | null }> {
  const payload = findings.map((f) => ({
    ref: f.ref,
    kind: f.kind,
    severity: f.severity,
    series: f.evidence,
    platform_summary: f.platformSummary,
  }));

  const res = await runCapability(supabase, FLAG_CAPABILITY, {
    system: FLAG_SYSTEM,
    user:
      `Findings JSON (deterministic — every value, date, count and severity is ground truth):\n${JSON.stringify(payload)}\n\n` +
      "Return JSON with one entry per ref. Copy each ref exactly. Write the summary a nurse reads first: what the series shows, in one or two sentences.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "clinical_flag_summaries",
      schema: FLAG_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    },
    inputDigest: digest(`clinical flags · ${findings.length} findings · ${findings.map((f) => f.kind).join(",")}`, 200),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const written = new Map<string, string>();
  if (res.status === "ok" && res.text.trim()) {
    try {
      const parsed = JSON.parse(res.text) as { summaries?: { ref?: unknown; summary?: unknown }[] };
      const byRef = new Map(findings.map((f) => [f.ref, f]));
      for (const s of parsed.summaries ?? []) {
        const ref = str(s.ref);
        const summary = str(s.summary);
        // Validate as hard as the huddle does: known ref, sane length, no invented refs.
        if (!ref || !summary || !byRef.has(ref)) continue;
        if (summary.length < 20 || summary.length > 500) continue;
        written.set(ref, clip(summary, 480));
      }
    } catch {
      // Unparseable output is a degrade, not an error: platform sentences stand.
    }
  }

  const note =
    written.size === findings.length
      ? null
      : res.status === "blocked"
        ? res.reason === "budget"
          ? "AI summaries are paused for this month's budget — these flags are written by the platform from the same figures."
          : "AI summaries are switched off — these flags are written by the platform from the same figures."
        : "AI summaries are unavailable — these flags are written by the platform from the same figures.";

  return { written, interactionId: res.interactionId, note };
}

/**
 * Scan the nurse's caseload for early-warning patterns and raise the ones that are new.
 * Deterministic end to end: with the model down, the same flags are raised with the
 * platform's own wording and the caller is told so plainly.
 */
export async function detectClinicalFlags(): Promise<ScanResult> {
  const fail = (message: string): ScanResult => ({
    ok: false,
    raised: 0,
    clientsScanned: 0,
    note: null,
    message,
  });

  const profile = await getProfile();
  if (!profile) return fail("Sign in again to scan for flags.");
  if (!profile.roles.some((r) => CLINICAL_ROLES.includes(r))) {
    return fail("Raising a clinical flag is a clinical action. Your account isn't set up for it.");
  }

  const supabase = await supabaseServer();
  const ctx = await currentContext(supabase);
  if (!ctx) return fail("Sign in again to scan for flags.");

  // ── Caseload (the scan's scope) ────────────────────────────────────────────
  const { data: caseRows } = await supabase
    .from("care_team_assignment")
    .select("client_id, client(id, first_name, last_name, status)")
    .eq("user_id", ctx.userId)
    .eq("role_on_case", "rn_case_manager")
    .is("ends_on", null)
    .limit(RULES.maxClientsPerScan);

  type CaseClient = { id: string; status: string };
  const clients = ((caseRows ?? []) as unknown as { client: CaseClient | CaseClient[] | null }[])
    .map((r) => one(r.client))
    .filter((c): c is CaseClient => c !== null && c.status === "active");
  const clientIds = [...new Set(clients.map((c) => c.id))];

  if (clientIds.length === 0) {
    return {
      ok: true,
      raised: 0,
      clientsScanned: 0,
      note: null,
      message: "You have no active clients on your caseload, so there was nothing to scan.",
    };
  }

  // ── Deterministic series, all read under the caller's RLS ──────────────────
  const [versionsRes, exceptionsRes, visitsRes] = await Promise.all([
    supabase
      .from("form_version")
      .select("content, authored_at, form_instance!inner(client_id, form_template!inner(key))")
      .in("form_instance.client_id", clientIds)
      .gte("authored_at", sinceIso(RULES.conditionWindowDays))
      .order("authored_at", { ascending: false })
      .limit(800),
    supabase
      .from("schedule_exception")
      .select("kind, created_at, visit!inner(client_id)")
      .in("visit.client_id", clientIds)
      .gte("created_at", sinceIso(RULES.exceptionWindowDays))
      .limit(500),
    supabase
      .from("visit")
      .select("id, client_id, scheduled_start, scheduled_end, status")
      .in("client_id", clientIds)
      .gte("scheduled_start", sinceIso(RULES.shortfallWindowDays))
      .lte("scheduled_start", new Date().toISOString())
      .limit(2000),
  ]);

  const versions = (versionsRes.data ?? []) as VersionRow[];
  const conditionSeries = seriesByClient(versions, ASSESSMENT_TEMPLATE, "general_condition");
  const moodWindowStart = sinceIso(RULES.moodWindowDays);
  const moodSeries = seriesByClient(
    versions.filter((v) => v.authored_at >= moodWindowStart),
    VISIT_NOTE_TEMPLATE,
    "client_mood"
  );

  const exceptionKinds = new Map<string, string[]>();
  for (const row of (exceptionsRes.data ?? []) as {
    kind: string;
    visit: { client_id: string } | { client_id: string }[] | null;
  }[]) {
    const clientId = one(row.visit)?.client_id;
    if (!clientId) continue;
    const list = exceptionKinds.get(clientId) ?? [];
    list.push(row.kind);
    exceptionKinds.set(clientId, list);
  }

  const visits = (visitsRes.data ?? []) as {
    id: string;
    client_id: string;
    scheduled_start: string;
    scheduled_end: string;
    status: string;
  }[];
  const counted = visits.filter((v) => v.status !== "cancelled");

  const { data: eventRows } = counted.length
    ? await supabase
        .from("visit_event")
        .select("visit_id, event_type, occurred_at")
        .in("visit_id", counted.slice(0, 1200).map((v) => v.id))
        .limit(4000)
    : { data: [] as { visit_id: string; event_type: string; occurred_at: string }[] };

  const clockIn = new Map<string, string>();
  const clockOut = new Map<string, string>();
  for (const e of (eventRows ?? []) as { visit_id: string; event_type: string; occurred_at: string }[]) {
    const bucket = e.event_type === "clock_in" ? clockIn : e.event_type === "clock_out" ? clockOut : null;
    if (!bucket) continue;
    const held = bucket.get(e.visit_id);
    // First clock-in, last clock-out — the widest defensible clocked window.
    if (!held || (bucket === clockIn ? e.occurred_at < held : e.occurred_at > held)) {
      bucket.set(e.visit_id, e.occurred_at);
    }
  }

  const hoursByClient = new Map<string, { planned: number; delivered: number; paired: number; total: number }>();
  for (const v of counted) {
    const acc = hoursByClient.get(v.client_id) ?? { planned: 0, delivered: 0, paired: 0, total: 0 };
    acc.planned += new Date(v.scheduled_end).getTime() - new Date(v.scheduled_start).getTime();
    acc.total += 1;
    const start = clockIn.get(v.id);
    const end = clockOut.get(v.id);
    if (start && end) {
      const span = new Date(end).getTime() - new Date(start).getTime();
      if (span > 0) {
        acc.delivered += span;
        acc.paired += 1;
      }
    }
    hoursByClient.set(v.client_id, acc);
  }

  // ── Apply the rules ────────────────────────────────────────────────────────
  const candidates: Omit<Finding, "ref">[] = [];
  for (const clientId of clientIds) {
    const condition = conditionSeries.get(clientId);
    if (condition) {
      const f = conditionFinding(clientId, condition);
      if (f) candidates.push(f);
    }
    const mood = moodSeries.get(clientId);
    if (mood) {
      const f = moodFinding(clientId, mood);
      if (f) candidates.push(f);
    }
    const kinds = exceptionKinds.get(clientId);
    if (kinds) {
      const f = exceptionFinding(clientId, kinds);
      if (f) candidates.push(f);
    }
    const h = hoursByClient.get(clientId);
    if (h) {
      const f = shortfallFinding(
        clientId,
        hours(h.planned),
        hours(h.delivered),
        h.total > 0 ? h.paired / h.total : 0
      );
      if (f) candidates.push(f);
    }
  }

  // ── Suppress anything already on the board (append-only: never a duplicate) ─
  // Two ways a finding is already represented: a flag of that kind is still open for
  // that client (any age — it is literally awaiting this nurse), or one was disposed
  // recently enough that re-raising it would be nagging rather than informing.
  const { data: existing } = await supabase
    .from("clinical_flag")
    .select("client_id, kind, status, created_at")
    .in("client_id", clientIds)
    .or(`status.eq.open,created_at.gte.${sinceIso(RULES.resuppressDays)}`)
    .limit(400);
  const suppressed = new Set(
    ((existing ?? []) as { client_id: string; kind: string }[]).map((r) => `${r.client_id}:${r.kind}`)
  );

  const severityRank: Record<FlagSeverity, number> = { high: 0, medium: 1, info: 2 };
  const findings: Finding[] = candidates
    .filter((c) => !suppressed.has(`${c.clientId}:${c.kind}`))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .slice(0, RULES.maxFindingsPerScan)
    .map((c, i) => ({ ...c, ref: `F${i + 1}` }));

  if (findings.length === 0) {
    return {
      ok: true,
      raised: 0,
      clientsScanned: clientIds.length,
      note: null,
      message:
        `Scanned ${clientIds.length} ${clientIds.length === 1 ? "client" : "clients"}. No new patterns crossed a threshold` +
        `${suppressed.size > 0 ? ", and everything already flagged is still on the board below." : "."}`,
    };
  }

  const { written, interactionId, note } = await narrateFindings(supabase, findings);

  const rows = findings.map((f) => ({
    tenant_id: ctx.tenantId,
    client_id: f.clientId,
    kind: f.kind,
    severity: f.severity,
    summary: written.get(f.ref) ?? f.platformSummary,
    evidence: f.evidence,
    created_by: ctx.userId,
    // Only claim AI authorship when the model actually wrote that flag's sentence.
    ai_interaction_id: written.has(f.ref) ? interactionId : null,
  }));

  const { error } = await supabase.from("clinical_flag").insert(rows);
  if (error) {
    return fail(
      error.message.includes("row-level security")
        ? "These flags couldn't be raised under your account. If your verified session expired, sign in again with your authenticator."
        : "We couldn't raise those flags just now. Nothing was written — try the scan again."
    );
  }

  revalidatePath("/clinical");
  return {
    ok: true,
    raised: rows.length,
    clientsScanned: clientIds.length,
    note,
    message:
      `Scanned ${clientIds.length} ${clientIds.length === 1 ? "client" : "clients"} and raised ` +
      `${rows.length} ${rows.length === 1 ? "flag" : "flags"} for your review. Nothing has been escalated.`,
  };
}

/** Acknowledge or dismiss one flag — the human disposition the T2 tier requires. */
async function disposeFlag(
  flagId: string,
  status: "acknowledged" | "dismissed"
): Promise<DisposeResult> {
  const supabase = await supabaseServer();
  const ctx = await currentContext(supabase);
  if (!ctx) return { ok: false, error: "Sign in again to update this flag." };

  const { data: flag } = await supabase
    .from("clinical_flag")
    .select("id, status, ai_interaction_id")
    .eq("id", flagId)
    .maybeSingle();
  if (!flag) {
    return { ok: false, error: "That flag isn't available for your account." };
  }
  if ((flag as { status: string }).status !== "open") {
    return { ok: false, error: "That flag has already been disposed. Refresh to see who disposed it." };
  }

  const { error } = await supabase
    .from("clinical_flag")
    .update({
      status,
      acknowledged_by: ctx.userId,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", flagId);
  if (error) {
    return {
      ok: false,
      error:
        "We couldn't record that. The flag is unchanged — if your verified session expired, sign in again with your authenticator.",
    };
  }

  // Flywheel label (docs/16 §3.2). Never carries the summary: it is clinical free text.
  const interactionId = (flag as { ai_interaction_id: string | null }).ai_interaction_id;
  if (interactionId) {
    await recordDisposition(
      supabase,
      interactionId,
      FLAG_CAPABILITY,
      status === "acknowledged" ? "accepted" : "rejected",
      status === "dismissed" ? "wrong" : undefined
    );
  }

  revalidatePath("/clinical");
  return { ok: true };
}

export async function acknowledgeFlag(flagId: string): Promise<DisposeResult> {
  return disposeFlag(flagId, "acknowledged");
}

export async function dismissFlag(flagId: string): Promise<DisposeResult> {
  return disposeFlag(flagId, "dismissed");
}

// ═══════════════════════════════════════════════════════════════════════════
// R2 · Care-plan review drafts
// ═══════════════════════════════════════════════════════════════════════════
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    no_change: {
      type: "boolean",
      description: "True when the records show no meaningful change and no revision is warranted.",
    },
    summary: {
      type: ["string", "null"],
      description: "Proposed replacement for the plan's plain-language summary, or null to keep the current one.",
    },
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["goal", "intervention"] },
          text: { type: "string", description: "The proposed goal or intervention, one or two sentences." },
          target: { type: ["string", "null"], description: "Measurable target or frequency, or null." },
          anchor: { type: "string", description: "The record ref this proposal stands on, copied exactly." },
          rationale: { type: "string", description: "One sentence: the observation that prompted this." },
        },
        required: ["kind", "text", "target", "anchor", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["no_change", "summary", "proposals"],
  additionalProperties: false,
} as const;

const REVIEW_SYSTEM =
  "You are the CareOS care-plan review drafter for a Maryland home-care agency.\n" +
  "You receive the current plan with its goals and interventions, recent records from the chart with reference labels, and deterministic facts.\n" +
  "- Every proposal must be anchored to one supplied record ref. A proposal you cannot anchor is not allowed — leave it out.\n" +
  "- Propose only goals, interventions, frequencies described in the plan, and the plan summary. Never medications, dosages, orders, diagnoses, levels of care, or discharge.\n" +
  "- Describe observations in the words the records use. Do not add clinical vocabulary the records do not use.\n" +
  "- If the records show no meaningful change, set no_change true and return no proposals. A quiet period is a legitimate finding.\n" +
  "- Never restate or recompute a date, a version number, or a due date.\n" +
  "- Plain language, sentence case, no exclamation points. One or two sentences per proposal.";

type PlanRow = {
  id: string;
  tenant_id: string;
  client_id: string;
  version: number;
  status: string;
  title: string | null;
  summary: string | null;
  review_due_on: string | null;
  authored_at: string;
  client: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
};

async function loadPlan(supabase: SupabaseClient, planId: string): Promise<PlanRow | null> {
  const { data } = await supabase
    .from("care_plan")
    .select(
      "id, tenant_id, client_id, version, status, title, summary, review_due_on, authored_at, client(first_name, last_name)"
    )
    .eq("id", planId)
    .maybeSingle();
  return (data as PlanRow | null) ?? null;
}

async function latestVersionFor(supabase: SupabaseClient, clientId: string): Promise<PlanRow | null> {
  const { data } = await supabase
    .from("care_plan")
    .select(
      "id, tenant_id, client_id, version, status, title, summary, review_due_on, authored_at, client(first_name, last_name)"
    )
    .eq("client_id", clientId)
    .order("version", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as PlanRow[];
  return rows[0] ?? null;
}

/** Chart excerpts the drafter may see: clinical fields only, never identifiers. */
function recordViews(versions: VersionRow[]): PlanRecordView[] {
  const views: PlanRecordView[] = [];
  for (const v of versions) {
    const inst = one(v.form_instance);
    const key = one(inst?.form_template ?? null)?.key;
    const c = v.content ?? {};
    if (key === ASSESSMENT_TEMPLATE) {
      const bits = [
        str(c.general_condition) && `general condition ${str(c.general_condition)}`,
        str(c.mobility) && `mobility ${str(c.mobility)}`,
        c.follow_up_needed === true && "follow-up needed",
        str(c.narrative) && clip(String(c.narrative), 260),
      ].filter((x): x is string => Boolean(x));
      views.push({
        ref: `R${views.length + 1}`,
        label: "RN assessment",
        date: dayLabel(v.authored_at),
        detail: bits.join(" · ") || "No structured fields recorded.",
      });
    } else if (key === VISIT_NOTE_TEMPLATE) {
      const bits = [
        str(c.client_mood) && `mood ${str(c.client_mood)}`,
        str(c.tasks_completed) && clip(String(c.tasks_completed), 200),
        str(c.notes) && clip(String(c.notes), 200),
      ].filter((x): x is string => Boolean(x));
      views.push({
        ref: `R${views.length + 1}`,
        label: "Visit note",
        date: dayLabel(v.authored_at),
        detail: bits.join(" · ") || "No structured fields recorded.",
      });
    }
    if (views.length >= RULES.maxRecordsInPrompt) break;
  }
  return views;
}

/**
 * Draft a plan review for one care plan. Returns the current plan, the records the
 * draft stands on, and the proposals — all three render whether or not the model
 * answered, because the first two are pure database reads.
 */
export async function draftCarePlanReview(planId: string): Promise<DraftResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Sign in again to draft a review." };
  if (!profile.roles.some((r) => CLINICAL_ROLES.includes(r))) {
    return { ok: false, error: "Revising a plan of care is a clinical action. Your account isn't set up for it." };
  }

  const supabase = await supabaseServer();
  const plan = await loadPlan(supabase, planId);
  if (!plan) {
    return {
      ok: false,
      error:
        "That plan isn't available for your account. If your verified session expired, sign in again with your authenticator.",
    };
  }

  const latest = await latestVersionFor(supabase, plan.client_id);
  if (latest && latest.version > plan.version) {
    return {
      ok: false,
      error: `Version ${latest.version} of this plan was saved after this page loaded. Refresh, then review the current version.`,
    };
  }

  const { data: itemRows } = await supabase
    .from("care_plan_item")
    .select("id, kind, seq, text, target")
    .eq("care_plan_id", plan.id)
    .order("seq", { ascending: true })
    .limit(80);
  const currentItems: PlanItemView[] = ((itemRows ?? []) as {
    id: string;
    kind: string;
    text: string;
    target: string | null;
  }[])
    .filter((i) => i.kind === "goal" || i.kind === "intervention")
    .map((i) => ({
      id: i.id,
      kind: i.kind as "goal" | "intervention",
      text: i.text,
      target: i.target,
    }));

  // A review reacts to what has been filed since the version was authored. A version
  // authored today — or a chart imported in bulk at migration — has nothing on that
  // side of the line, so the window widens to the recent chart and the nurse is told
  // which window they are looking at. One read covers both cases.
  const recentFloor = sinceIso(RULES.recordLookbackDays);
  const floor = plan.authored_at < recentFloor ? plan.authored_at : recentFloor;
  const { data: versionRows } = await supabase
    .from("form_version")
    .select("content, authored_at, form_instance!inner(client_id, form_template!inner(key))")
    .eq("form_instance.client_id", plan.client_id)
    .gte("authored_at", floor)
    .order("authored_at", { ascending: false })
    .limit(40);
  const allRows = (versionRows ?? []) as VersionRow[];
  const sinceVersion = allRows.filter((r) => r.authored_at >= plan.authored_at);
  const useSinceVersion = sinceVersion.length >= RULES.minRecordsSinceVersion;
  const recordsWindow: PlanRecordWindow = useSinceVersion ? "since_version" : "recent";
  const records = recordViews(useSinceVersion ? sinceVersion : allRows);

  const clientRef = one(plan.client);
  const clientName = clientRef ? `${clientRef.first_name} ${clientRef.last_name}` : "This client";

  // Nothing to react to: an honest deterministic answer, no model call, no spend.
  if (records.length === 0) {
    return {
      ok: true,
      draft: {
        planId: plan.id,
        clientName,
        version: plan.version,
        title: plan.title ?? "Plan of care",
        currentSummary: plan.summary,
        reviewDueOn: plan.review_due_on,
        currentItems,
        records,
        recordsWindow,
        proposals: [],
        proposedSummary: null,
        noChange: true,
        ai: {
          provider: "none",
          model: null,
          degraded: false,
          note: "This client's chart has no visit notes or assessments to draft from, so nothing is proposed. You can still revise the plan yourself.",
          interactionId: null,
        },
      },
    };
  }

  const facts = {
    plan_version: plan.version,
    review_due_on: plan.review_due_on,
    plan_summary: plan.summary,
    records_window:
      recordsWindow === "since_version"
        ? "records filed since this plan version was authored"
        : `the most recent records in the chart (last ${RULES.recordLookbackDays} days)`,
    goals: currentItems.filter((i) => i.kind === "goal").map((i) => ({ text: i.text, target: i.target })),
    interventions: currentItems
      .filter((i) => i.kind === "intervention")
      .map((i) => ({ text: i.text, target: i.target })),
    records: records.map((r) => ({ ref: r.ref, kind: r.label, date: r.date, detail: r.detail })),
  };

  const res = await runCapability(supabase, REVIEW_CAPABILITY, {
    system: REVIEW_SYSTEM,
    user:
      `Current plan and recent records (deterministic — the version, the review date and every record date are ground truth):\n${JSON.stringify(facts)}\n\n` +
      "Return JSON. Propose revisions to goals and interventions only, each anchored to one record ref above. If nothing meaningful changed, set no_change true and return an empty proposals array.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "careplan_review_draft",
      schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
    },
    inputDigest: digest(
      `careplan review · v${plan.version} · ${currentItems.length} items · ${records.length} records`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const proposals: PlanProposal[] = [];
  let proposedSummary: string | null = null;
  let noChange = false;

  if (res.status === "ok" && res.text.trim()) {
    try {
      const parsed = JSON.parse(res.text) as {
        no_change?: unknown;
        summary?: unknown;
        proposals?: { kind?: unknown; text?: unknown; target?: unknown; anchor?: unknown; rationale?: unknown }[];
      };
      noChange = parsed.no_change === true;
      proposedSummary = str(parsed.summary);
      const byRef = new Map(records.map((r) => [r.ref, r]));
      for (const p of parsed.proposals ?? []) {
        const kind = str(p.kind);
        const text = str(p.text);
        const anchor = str(p.anchor);
        // Unanchored, or anchored to a record we did not supply → dropped, silently and
        // deliberately: the nurse must never see a proposal we cannot trace.
        if (!text || !anchor || !byRef.has(anchor)) continue;
        if (kind !== "goal" && kind !== "intervention") continue;
        const record = byRef.get(anchor)!;
        proposals.push({
          ref: `P${proposals.length + 1}`,
          kind,
          text: clip(text, 400),
          target: str(p.target) ? clip(String(p.target), 160) : null,
          anchorRef: anchor,
          anchorLabel: `${record.label} · ${record.date}`,
          rationale: str(p.rationale) ? clip(String(p.rationale), 260) : "",
        });
        if (proposals.length >= RULES.maxProposals) break;
      }
    } catch {
      // Unparseable → treated exactly like the model being down.
    }
  }

  const degraded = res.status !== "ok" || (proposals.length === 0 && !noChange);
  const note = !degraded
    ? null
    : res.status === "blocked"
      ? res.reason === "budget"
        ? "AI drafting is paused for this month's budget. The current plan and the records below are live — you can revise the plan yourself."
        : "AI drafting is switched off. The current plan and the records below are live — you can revise the plan yourself."
      : "AI drafting is unavailable. The current plan and the records below are live — you can revise the plan yourself.";

  return {
    ok: true,
    draft: {
      planId: plan.id,
      clientName,
      version: plan.version,
      title: plan.title ?? "Plan of care",
      currentSummary: plan.summary,
      reviewDueOn: plan.review_due_on,
      currentItems,
      records,
      recordsWindow,
      proposals,
      proposedSummary,
      noChange,
      ai: {
        provider: res.provider,
        model: res.model,
        degraded,
        note,
        interactionId: res.interactionId,
      },
    },
  };
}

/**
 * Save the nurse's accepted set as a NEW plan version (invariant 1 — v(n) is never
 * touched; v(n+1) references it through prev_version_id). The version lands as a draft:
 * finalizing a plan of care is the forms engine's RN-signature step (docs/07 §10).
 */
export async function commitCarePlanReview(input: {
  planId: string;
  items: CommitItem[];
  summary: string | null;
  aiInteractionId: string | null;
  edited: boolean;
}): Promise<CommitResult> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Sign in again to save this version." };
  if (!profile.roles.some((r) => CLINICAL_ROLES.includes(r))) {
    return { ok: false, error: "Revising a plan of care is a clinical action. Your account isn't set up for it." };
  }

  const items = (input.items ?? [])
    .filter((i) => (i.kind === "goal" || i.kind === "intervention") && typeof i.text === "string" && i.text.trim())
    .slice(0, 40)
    .map((i) => ({
      kind: i.kind,
      text: clip(i.text, 500),
      target: i.target && i.target.trim() ? clip(i.target, 160) : null,
    }));
  if (items.length === 0) {
    return { ok: false, error: "A plan version needs at least one goal or intervention. Nothing was saved." };
  }

  const supabase = await supabaseServer();
  const ctx = await currentContext(supabase);
  if (!ctx) return { ok: false, error: "Sign in again to save this version." };

  const plan = await loadPlan(supabase, input.planId);
  if (!plan) {
    return {
      ok: false,
      error:
        "That plan isn't available for your account. Nothing was saved — if your verified session expired, sign in again with your authenticator.",
    };
  }

  const latest = await latestVersionFor(supabase, plan.client_id);
  const base = latest ?? plan;
  if (base.version !== plan.version) {
    // Both antecedents survive: their version is saved, yours is still on this screen.
    return {
      ok: false,
      error: `Version ${base.version} was saved by someone else while you were reviewing. Your draft is still on this screen — refresh, reopen the current version, and re-apply anything that still belongs.`,
    };
  }

  const { data: created, error } = await supabase
    .from("care_plan")
    .insert({
      tenant_id: plan.tenant_id,
      client_id: plan.client_id,
      version: base.version + 1,
      prev_version_id: base.id,
      status: "draft",
      title: plan.title,
      summary: input.summary && input.summary.trim() ? clip(input.summary, 1000) : plan.summary,
      authored_by: ctx.userId,
      // The review cadence is the rules engine's to move, never this action's:
      // the date carries forward exactly as the platform set it.
      review_due_on: plan.review_due_on,
    })
    .select("id, version")
    .single();

  if (error || !created) {
    const message = error?.message ?? "";
    if (message.includes("care_plan_client_id_version_key") || message.includes("duplicate key")) {
      return {
        ok: false,
        error:
          "Another nurse saved a new version a moment ago. Your draft is still on this screen — refresh and re-apply it over the current version.",
      };
    }
    return {
      ok: false,
      error: message.includes("row-level security")
        ? "This version couldn't be saved under your account. Nothing was written — if your verified session expired, sign in again with your authenticator."
        : "We couldn't save that version. Nothing was written — your draft is still on this screen.",
    };
  }

  const newPlan = created as { id: string; version: number };
  const { error: itemError } = await supabase.from("care_plan_item").insert(
    items.map((i, idx) => ({
      tenant_id: plan.tenant_id,
      care_plan_id: newPlan.id,
      kind: i.kind,
      seq: idx,
      text: i.text,
      target: i.target,
    }))
  );
  if (itemError) {
    // The version row exists and is append-only, so it stays. Say so plainly rather
    // than pretending the save failed cleanly.
    revalidatePath("/clinical");
    return {
      ok: false,
      error: `Version ${newPlan.version} was created, but its goals and interventions could not be saved. Open the plan and add them before you finalize it.`,
    };
  }

  if (input.aiInteractionId) {
    await recordDisposition(
      supabase,
      input.aiInteractionId,
      REVIEW_CAPABILITY,
      input.edited ? "edited" : "accepted"
    );
  }

  revalidatePath("/clinical");
  return { ok: true, version: newPlan.version, itemCount: items.length };
}

/** The nurse threw the draft away — the label the flywheel most needs. Never throws. */
export async function discardCarePlanReview(aiInteractionId: string | null): Promise<{ ok: boolean }> {
  if (!aiInteractionId) return { ok: true };
  const supabase = await supabaseServer();
  const res = await recordDisposition(supabase, aiInteractionId, REVIEW_CAPABILITY, "rejected");
  return { ok: res.ok };
}
