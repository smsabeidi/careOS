/**
 * Verified Visit & Workforce Intelligence — the probabilistic half (docs/17 §10, §11).
 *
 * Four capabilities live here, and all four obey the same shape as lib/ai/huddle.ts:
 * **the platform computes, the model narrates** (invariant 13). Every count, minute,
 * percentage, rank and status below is produced by SQL or by pure TypeScript over SQL
 * output. The model is handed those finished numbers and asked only to write the *why*.
 * It cannot add an item, move a number, or introduce a person, because every renderer
 * draws from `facts` and every narration line is validated back against `facts` before
 * it is returned (see the `parse*` guardrails).
 *
 * The capabilities (registered in the database by migration 0052 — keys, tiers, model
 * pins and kill switches are matched exactly in lib/ai/registry.ts BUILT_IN):
 *   1. `visit.exception_triage`   T1 — ranks the open exception queue in TypeScript and
 *                                      narrates the top of it.
 *   2. `workforce.weekly_report`  T1 — reads app.workforce_features and nothing else.
 *   3. `payroll.readiness_brief`  T1 — aggregate hours + blocking exception counts.
 *   4. `visit.operational_profile` T2, human disposer REQUIRED — one caregiver, draft only.
 *
 * Invariants honored here:
 *   - 5 (PHI minimizer): each `to*PromptFacts()` IS the declared allowlist for its
 *     capability. The model receives enum labels, counts, minutes, percentages and
 *     per-request opaque handles (`exc-3`, `cg-7`). It never receives a name, an address,
 *     a client identity, a free-text note, a clinical detail, a coordinate, or a distance
 *     in metres (D-030). The handles are strictly narrower than the registered prompts'
 *     "the record identifiers involved": a UUID would travel further than it needs to, and
 *     a per-request handle is all the guardrail needs to key a line back to a real row.
 *   - 9 (retrieval as the user): every read below runs on the caller's RLS-scoped client.
 *     app.workforce_features is a definer aggregate, but it is gated on an AAL2 session
 *     holding workforce.read and returns only IDs, enums and counts (see migration 0051's
 *     header for why that exception is earned) — there is no privileged row retrieval.
 *   - 10 (one chokepoint): every model call goes through runCapability(), so the registry
 *     model pin, kill switch, budget cap, prompt version and ai_interaction ledger row all
 *     apply. No raw fetches.
 *   - 13 (deterministic vs probabilistic): ranking, minutes, money, eligibility and
 *     thresholds are computed here in code or in SQL. The model writes prose.
 *
 * Two guardrails run over EVERY completion before it is shown to anyone:
 *   - `inventsNumber()` — a sentence carrying a numeric token that does not appear in the
 *     facts the model was given is dropped. This is what makes "never compute a number"
 *     enforceable rather than merely instructed.
 *   - `readsAsEmploymentAction()` — a sentence that proposes or implies discipline,
 *     separation, probation or a character judgement is dropped, and for the T2 profile
 *     the WHOLE draft is discarded. D-021: the system never proposes termination.
 *
 * Degradation contract (identical in all four): a kill switch, a budget stop, a 429, a
 * missing key or a malformed completion all end in the same place — `narration = null`,
 * an honest human-facing `note`, and deterministic facts that still render in full. AI is
 * an accelerant on these surfaces, never a dependency.
 *
 * @trace ST-210, D-021, D-024, D-028, D-030, docs/17 §10 §11, docs/16 §3.2
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { digest, runCapability, type RunCapabilityResult } from "./client";
import { agencyToday } from "./huddle";

/* ══ Vocabulary ═══════════════════════════════════════════════════════════════ */

export const CAPABILITY_EXCEPTION_TRIAGE = "visit.exception_triage";
export const CAPABILITY_WEEKLY_REPORT = "workforce.weekly_report";
export const CAPABILITY_PAYROLL_READINESS = "payroll.readiness_brief";
export const CAPABILITY_OPERATIONAL_PROFILE = "visit.operational_profile";

/** An inclusive agency-local calendar window, the unit both §10 functions take. */
export type WindowSpec = { from: string; to: string };

/** Mirrors the visit_exception.severity CHECK (migration 0047). */
export type ExceptionSeverity = "info" | "warning" | "critical";

/** Mirrors the visit_exception.kind CHECK (migration 0047), in queue-display language. */
export const EXCEPTION_LABEL: Record<string, string> = {
  location_unverified: "Location not confirmed",
  low_accuracy: "Location signal too weak to confirm",
  outside_geofence: "Clocked in away from the care address",
  location_unavailable: "No location available at clock-in",
  late_start: "Late start",
  early_end: "Ended early",
  long_visit: "Longer than the scheduled window",
  short_visit: "Shorter than the scheduled window",
  missing_clock_out: "Clock-out missing",
  missed_visit: "Visit missed",
  overlapping_visits: "Overlapping visits",
  impossible_travel: "Travel between visits was not possible",
  manual_correction: "Clock record corrected by a person",
  duplicate_visit: "Possible duplicate visit",
  evv_rejected: "State submission rejected",
  payroll_mismatch: "Approved hours do not match the clock record",
  documentation_missing: "Visit note missing",
};

/** 0 = Sunday … 6 = Saturday — the index order migration 0051 pins for the §10 array. */
export const WEEKDAY_LABEL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Every narrated surface reports its own degrade path in these words. */
export type Degradation = {
  provider: string;
  model: string | null;
  interactionId: string | null;
  /** Honest, human-facing sentence about why narration is missing. null when it worked. */
  note: string | null;
  /** How many model sentences a guardrail discarded. Reported, never hidden. */
  dropped: number;
};

/* ══ Windows and small shared helpers ═════════════════════════════════════════ */

const MS_DAY = 86_400_000;

function ymd(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * A trailing window of `days` calendar days ending today (agency-local). Deterministic —
 * the same request on the same day always asks the database the same question, which is
 * what makes two people reading this screen see the same report.
 */
export function trailingWindow(days: number, today: string = agencyToday()): WindowSpec {
  const span = Math.max(1, Math.min(366, Math.round(days)));
  const [y, m, d] = today.split("-").map(Number);
  const end = Date.UTC(y, m - 1, d);
  return { from: ymd(end - (span - 1) * MS_DAY), to: today };
}

/** Whole days covered by a window, inclusive of both ends. */
export function windowDays(w: WindowSpec): number {
  const [ay, am, ad] = w.from.split("-").map(Number);
  const [by, bm, bd] = w.to.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_DAY) + 1;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
function int(v: unknown): number {
  return Math.round(num(v) ?? 0);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
/** Minutes → hours at one decimal. Computed HERE so the model never converts a unit. */
function hours(minutes: number): number {
  return round1(minutes / 60);
}

/* ══ Guardrails — applied to every completion, in every capability ════════════ */

const NUMBER_TOKEN = /-?\d+(?:\.\d+)?/g;

function normalizeNumber(token: string): string {
  const n = Number(token);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : token;
}

/**
 * Record a token and its absolute value. The sign is dropped deliberately: `-14` only
 * ever reaches this set because a date (`2026-07-14`) or a handle (`cg-14`) was tokenized
 * by the regex, and refusing the model the positive form of a number it was given would
 * make the guardrail fire on the honest sentence rather than the invented one.
 */
function addNumber(into: Set<string>, token: string): void {
  const norm = normalizeNumber(token);
  into.add(norm);
  const n = Number(norm);
  if (Number.isFinite(n)) into.add(normalizeNumber(String(Math.abs(n))));
}

/** Walk the exact payload the model was given and collect every numeric token in it. */
function collectNumbers(value: unknown, into: Set<string>): void {
  if (typeof value === "number") {
    addNumber(into, String(value));
    return;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(NUMBER_TOKEN)) addNumber(into, m[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectNumbers(k, into);
      collectNumbers(v, into);
    }
  }
}

/**
 * The numbers a completion is allowed to contain: every token in the facts (and its
 * absolute value), plus 0, 1 and -1, which carry linguistic rather than statistical weight
 * ("one caregiver", "no missed visits") and fall out of the opaque handles the model is
 * given (`cg-1`). Anything else in a sentence means the model did arithmetic, and
 * arithmetic is not its job (invariant 13) — that sentence is dropped and counted.
 */
function allowedNumbers(promptFacts: unknown): Set<string> {
  const set = new Set<string>(["0", "1", "-1"]);
  collectNumbers(promptFacts, set);
  return set;
}

function inventsNumber(text: string, allowed: Set<string>): boolean {
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    if (!allowed.has(normalizeNumber(m[0]))) return true;
  }
  return false;
}

/**
 * D-021, made mechanical. The registered prompts forbid proposing an employment
 * consequence; this is the check that runs when a prompt is ignored. It is deliberately
 * broad — a false positive costs one sentence of narration, a false negative puts an
 * accusation about a real employee on a manager's screen with a machine's authority
 * behind it.
 */
const EMPLOYMENT_ACTION =
  /\b(terminat\w*|fire[ds]?\b|firing|dismiss\w*|discipl\w*|write[- ]?up|written warning|final warning|probation\w*|suspend\w*|suspension|performance improvement plan|\bPIP\b|separat(?:e|ion|ed)|let (?:him|her|them) go|reassign\w*|demot\w*|coach(?:ing)? out|unreliable|untrustworthy|dishonest|lazy|negligent|falsif\w*|fraud\w*|abus\w*)\b/i;

function readsAsEmploymentAction(text: string): boolean {
  return EMPLOYMENT_ACTION.test(text);
}

/** Turn a runCapability outcome into the sentence a human should read. */
function degradeNote(res: RunCapabilityResult, subject: string): string | null {
  if (res.status === "ok") return null;
  if (res.status === "blocked") {
    return res.reason === "budget"
      ? `The ${subject} is paused for this month's AI budget — the figures below are complete.`
      : `The ${subject} is switched off for this agency — the figures below are complete.`;
  }
  if (res.status === "error") {
    return `The ${subject} isn't available right now — the figures below are complete.`;
  }
  return `The ${subject} isn't available right now — the figures below are complete.`;
}

function safeJson(raw: string | null): Record<string, unknown> | null {
  const text = (raw ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   1 · visit.exception_triage (T1)
   ══════════════════════════════════════════════════════════════════════════════
   Ranking is arithmetic, not judgement. docs/17 §11 pins the shape — severity ×
   recency × payroll impact × client risk — but names rather than defines the terms,
   so each one is defined ONCE, here, the way migration 0051 defined its metrics:

     severity   critical 40 · warning 22 · info 8. The rules engine already decided
                how bad a finding is; triage does not re-litigate it.
     recency    16 for a finding under six hours old, decaying linearly to 0 at seven
                days. Fresh findings are still correctable at the source — a caregiver
                can still close a visit they forgot this morning.
     payroll    20 when the visit is still awaiting approval AND the finding is one of
                the kinds that blocks it (0050 blocks approval on any OPEN CRITICAL
                finding); 10 when the visit is approved but not yet ready for payroll.
     care       24 missed visit · 16 clock-out missing · 12 overlapping / impossible
                travel / duplicate — the findings that mean care may not have been
                delivered as planned — plus 6 when nobody was assigned to the visit.

   The model receives `platform_rank` as ground truth and is told not to reorder. The
   renderer reads the deterministic order regardless of what comes back.
   ═══════════════════════════════════════════════════════════════════════════════ */

/** Kinds where an open finding is about care delivery, not paperwork. */
const CARE_WEIGHT: Record<string, number> = {
  missed_visit: 24,
  missing_clock_out: 16,
  overlapping_visits: 12,
  impossible_travel: 12,
  duplicate_visit: 12,
};

/** Kinds that stand between a completed visit and approved hours (docs/17 §4.7). */
const PAY_BLOCKING = new Set([
  "missing_clock_out",
  "missed_visit",
  "overlapping_visits",
  "impossible_travel",
  "duplicate_visit",
  "payroll_mismatch",
  "documentation_missing",
  "manual_correction",
  "outside_geofence",
  "location_unverified",
  "location_unavailable",
  "low_accuracy",
]);

const SEVERITY_WEIGHT: Record<string, number> = { critical: 40, warning: 22, info: 8 };
export const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  warning: "Needs attention",
  info: "For information",
};

/**
 * Evidence keys a model may see. Everything else in `visit_exception.evidence` is
 * dropped — including `distance_m`, which the impossible-travel detector legitimately
 * records for an administrator on an RLS-gated surface and which must never reach a
 * prompt or a screen (D-030, invariant 5). An allowlist rather than a denylist, because
 * a future detector's new key must be reviewed before it travels, not after.
 */
const EVIDENCE_ALLOW = new Set([
  "threshold_minutes",
  "threshold_kmh",
  "speed_kmh",
  "gap_seconds",
  "requires_note",
  "minutes",
]);

export type TriageItem = {
  /** The ONLY handle the model gets, and the only thing a narration line may reference. */
  key: string;
  exceptionId: string;
  visitId: string;
  caregiverId: string | null;
  kind: string;
  kindLabel: string;
  severity: ExceptionSeverity;
  detectedAt: string;
  ageHours: number;
  blocksPay: boolean;
  careAffecting: boolean;
  unassigned: boolean;
  approvalStatus: string | null;
  payrollStatus: string | null;
  rank: number;
  components: { severity: number; recency: number; payroll: number; care: number };
  /** Allowlisted scalar evidence — numbers and booleans only, never a place. */
  evidence: Record<string, number | boolean>;
  href: string;
};

export type TriageFacts = {
  version: 1;
  generated_at: string;
  open_total: number;
  by_severity: Record<ExceptionSeverity, number>;
  by_kind: Record<string, number>;
  /** The ranked head of the queue — the only items narration may speak about. */
  items: TriageItem[];
};

export type TriageNarration = { items: { key: string; line: string }[]; closing: string | null };

export type TriageResult = Degradation & {
  facts: TriageFacts;
  narration: TriageNarration | null;
  /** Set when the queue itself could not be read; facts are empty and the UI says so. */
  error: string | null;
};

type ExceptionStateRow = {
  exception_id: string;
  visit_id: string;
  caregiver_id: string | null;
  kind: string;
  severity: string;
  detected_by: string;
  rule_key: string | null;
  evidence: Record<string, unknown> | null;
  detected_at: string;
  latest_disposition: string | null;
  open: boolean;
};

type VisitContextRow = {
  visit_id: string;
  caregiver_id: string | null;
  status: string;
  approval_status: string | null;
  payroll_status: string | null;
  verification_status: string | null;
  scheduled_start: string;
};

function allowedEvidence(raw: Record<string, unknown> | null): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!EVIDENCE_ALLOW.has(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else {
      const n = num(v);
      if (n !== null) out[k] = n;
    }
  }
  return out;
}

/**
 * Read the open exception queue under the caller's own RLS and rank it deterministically.
 * `visit_exception_state` is the security_invoker view migration 0047 defines as the one
 * place "open" means what 0047 says it means; nothing here re-derives that rule.
 */
export async function collectTriageFacts(
  supabase: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<{ facts: TriageFacts; error: string | null }> {
  const empty: TriageFacts = {
    version: 1,
    generated_at: new Date().toISOString(),
    open_total: 0,
    by_severity: { critical: 0, warning: 0, info: 0 },
    by_kind: {},
    items: [],
  };

  const { data, error } = await supabase
    .from("visit_exception_state")
    .select(
      "exception_id, visit_id, caregiver_id, kind, severity, detected_by, rule_key, evidence, detected_at, latest_disposition, open"
    )
    .eq("open", true)
    .order("detected_at", { ascending: false })
    .limit(300);

  if (error) return { facts: empty, error: error.message };

  const rows = (data ?? []) as ExceptionStateRow[];
  if (rows.length === 0) return { facts: empty, error: null };

  // The visit's money state, refetched under the same RLS. clock_in_distance_m and
  // clock_out_distance_m exist on this view and are deliberately NOT selected: a raw
  // distance in metres is exactly what D-030 keeps off screens and out of prompts.
  const visitIds = [...new Set(rows.map((r) => r.visit_id))];
  const { data: visitData } = await supabase
    .from("verified_visit")
    .select(
      "visit_id, caregiver_id, status, approval_status, payroll_status, verification_status, scheduled_start"
    )
    .in("visit_id", visitIds.slice(0, 400));
  const visitById = new Map(
    ((visitData ?? []) as VisitContextRow[]).map((v) => [v.visit_id, v])
  );

  const now = Date.now();
  const scored = rows.map((r) => {
    const visit = visitById.get(r.visit_id);
    const severity: ExceptionSeverity =
      r.severity === "critical" || r.severity === "warning" ? r.severity : "info";
    const ageHours = Math.max(
      0,
      Math.round(((now - new Date(r.detected_at).getTime()) / 3_600_000) * 10) / 10
    );

    const sevPoints = SEVERITY_WEIGHT[severity] ?? SEVERITY_WEIGHT.info;
    const recency = Math.max(0, Math.round(16 * (1 - Math.max(0, ageHours - 6) / 162)));
    const awaitingApproval = (visit?.approval_status ?? "pending") === "pending";
    const blocksPay = PAY_BLOCKING.has(r.kind) && awaitingApproval;
    const payroll = blocksPay
      ? 20
      : visit?.approval_status === "approved" && visit?.payroll_status === "not_ready"
        ? 10
        : 0;
    const unassigned = !(r.caregiver_id ?? visit?.caregiver_id);
    const care = (CARE_WEIGHT[r.kind] ?? 0) + (unassigned ? 6 : 0);

    return {
      row: r,
      visit,
      severity,
      ageHours,
      blocksPay,
      unassigned,
      components: { severity: sevPoints, recency, payroll, care },
      rank: sevPoints + recency + payroll + care,
    };
  });

  scored.sort(
    (a, b) => b.rank - a.rank || b.row.detected_at.localeCompare(a.row.detected_at)
  );

  const bySeverity: Record<ExceptionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const byKind: Record<string, number> = {};
  for (const s of scored) {
    bySeverity[s.severity] += 1;
    byKind[s.row.kind] = (byKind[s.row.kind] ?? 0) + 1;
  }

  const items: TriageItem[] = scored.slice(0, opts.limit ?? 10).map((s, i) => ({
    key: `exc-${i + 1}`,
    exceptionId: s.row.exception_id,
    visitId: s.row.visit_id,
    caregiverId: s.row.caregiver_id ?? s.visit?.caregiver_id ?? null,
    kind: s.row.kind,
    kindLabel: EXCEPTION_LABEL[s.row.kind] ?? "Visit exception",
    severity: s.severity,
    detectedAt: s.row.detected_at,
    ageHours: s.ageHours,
    blocksPay: s.blocksPay,
    careAffecting: (CARE_WEIGHT[s.row.kind] ?? 0) > 0,
    unassigned: s.unassigned,
    approvalStatus: s.visit?.approval_status ?? null,
    payrollStatus: s.visit?.payroll_status ?? null,
    rank: s.rank,
    components: s.components,
    evidence: allowedEvidence(s.row.evidence),
    href: "/operations/exceptions",
  }));

  return {
    facts: {
      version: 1,
      generated_at: new Date().toISOString(),
      open_total: scored.length,
      by_severity: bySeverity,
      by_kind: byKind,
      items,
    },
    error: null,
  };
}

/** The PHI minimizer for visit.exception_triage — this object IS the allowlist. */
function toTriagePromptFacts(facts: TriageFacts): Record<string, unknown> {
  return {
    open_total: facts.open_total,
    by_severity: facts.by_severity,
    items: facts.items.map((i) => ({
      key: i.key,
      finding: i.kindLabel,
      severity: i.severity,
      age_hours: i.ageHours,
      blocks_pay: i.blocksPay,
      care_affecting: i.careAffecting,
      nobody_assigned: i.unassigned,
      platform_rank: i.rank,
      evidence: i.evidence,
    })),
  };
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "One of the provided item keys, copied exactly." },
          line: {
            type: "string",
            description: "One or two sentences: what the engine found, what it blocks, the next step.",
          },
        },
        required: ["key", "line"],
        additionalProperties: false,
      },
    },
    closing: { type: ["string", "null"], description: "Optional one-sentence close, or null." },
  },
  required: ["items", "closing"],
  additionalProperties: false,
} as const;

/** Built-in prompt. An ACTIVE ai_prompt_template row (migration 0052 v1) overrides it. */
const TRIAGE_SYSTEM =
  "You are the CareOS visit-exception narrator for a Maryland home-care agency. " +
  "You receive a JSON list of open visit exceptions already ranked by the platform, each with its " +
  "finding, severity, age, whether it blocks pay, and the deterministic evidence the rules engine recorded.\n" +
  "1. Use only the facts given. Never reorder the list, never recompute a rank, and never invent an exception, a time, a duration, or a cause.\n" +
  "2. For each item write one or two sentences for the coordinator: what the engine found, what it blocks, and the next step available in the app.\n" +
  "3. You receive no coordinates, no addresses, no names and no clinical detail, and you never ask for them.\n" +
  "4. Never attribute intent. An exception is a record state, not an accusation: write \"the clock-out is missing\", never \"the caregiver skipped the visit\".\n" +
  "5. Plain language, sentence case, no exclamation points, no blame, no consequences you were not given.\n" +
  "6. If the list is empty, say in one sentence that the queue is clear, and stop.";

/**
 * Validate narration against the facts. A line may only reference a key that exists, may
 * not carry a number the facts do not, and may not read as an employment action. Anything
 * else is dropped and counted — this is what makes it structurally impossible for the
 * model to introduce a finding, a figure, or an accusation of its own.
 */
export function parseTriageNarration(
  raw: string | null,
  facts: TriageFacts,
  allowed: Set<string>
): { narration: TriageNarration | null; dropped: number } {
  const obj = safeJson(raw);
  if (!obj) return { narration: null, dropped: 0 };

  const known = new Set(facts.items.map((i) => i.key));
  const seen = new Set<string>();
  let dropped = 0;
  const items: { key: string; line: string }[] = [];

  for (const entry of Array.isArray(obj.items) ? obj.items : []) {
    const e = entry as { key?: unknown; line?: unknown };
    const key = str(e.key);
    const line = str(e.line);
    if (!key || !line) {
      dropped += 1;
      continue;
    }
    if (!known.has(key) || seen.has(key) || inventsNumber(line, allowed) || readsAsEmploymentAction(line)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    items.push({ key, line });
    if (items.length >= 10) break;
  }

  if (items.length === 0) return { narration: null, dropped };
  const closingRaw = str(obj.closing);
  const closing =
    closingRaw && !inventsNumber(closingRaw, allowed) && !readsAsEmploymentAction(closingRaw)
      ? closingRaw
      : null;
  return { narration: { items, closing }, dropped };
}

/** The read path an exception surface calls. Never throws. */
export async function getExceptionTriage(
  supabase: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<TriageResult> {
  const { facts, error } = await collectTriageFacts(supabase, opts);
  const base: TriageResult = {
    facts,
    narration: null,
    provider: "none",
    model: null,
    interactionId: null,
    note: null,
    dropped: 0,
    error,
  };
  if (error || facts.items.length === 0) return base;

  const promptFacts = toTriagePromptFacts(facts);
  const allowed = allowedNumbers(promptFacts);
  const res = await runCapability(supabase, CAPABILITY_EXCEPTION_TRIAGE, {
    system: TRIAGE_SYSTEM,
    user:
      `Open visit exceptions, ranked by the platform:\n${JSON.stringify(promptFacts)}\n\n` +
      "Return JSON. Write one entry per item in the order given, keeping \"key\" exactly as provided. " +
      "Do not restate a figure the reader can already see; say what it blocks and what to do next.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "visit_exception_triage",
      schema: TRIAGE_SCHEMA as unknown as Record<string, unknown>,
    },
    inputDigest: digest(
      `triage · ${facts.open_total} open · ${facts.items.length} ranked · critical ${facts.by_severity.critical}`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const { narration, dropped } = parseTriageNarration(res.text, facts, allowed);
  return {
    ...base,
    narration,
    provider: narration ? res.provider : "none",
    model: narration ? res.model : null,
    interactionId: res.interactionId,
    dropped,
    note: narration ? null : degradeNote(res, "written summary"),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   2 · workforce.weekly_report (T1) — app.workforce_features and nothing else
   ══════════════════════════════════════════════════════════════════════════════ */

/** One caregiver's §10 feature row. Names are never in it — that is the point. */
export type CaregiverFeature = {
  caregiver_id: string;
  visits_scheduled: number;
  visits_completed: number;
  visits_missed: number;
  late_count: number;
  avg_late_minutes: number | null;
  early_count: number;
  overrun_minutes: number;
  undertime_minutes: number;
  verified_rate: number | null;
  location_exception_count: number;
  manual_override_count: number;
  missing_clock_out_count: number;
  overlap_count: number;
  impossible_travel_count: number;
  documentation_missing_count: number;
  schedule_adherence_pct: number | null;
  overtime_minutes: number;
  client_continuity_pct: number | null;
  trust_band_histogram: Record<string, number>;
  day_of_week_lateness: (number | null)[];
};

export type WorkforceFeatures = {
  org_id: string;
  from: string;
  to: string;
  generated_at: string;
  caregivers: CaregiverFeature[];
};

/**
 * CAREOS_* refusals from app.workforce_features → plain language (docs/10 voice: what
 * happened, what to do next). Exported so the lib and the surface translate once, in one
 * place, and can never disagree about what a refusal means.
 */
export function describeFeaturesError(raw: string | undefined): {
  code: string | null;
  title: string;
  body: string;
} {
  // [A-Z0-9_], not [A-Z_]: CAREOS_AAL2_REQUIRED carries a digit, and a class without one
  // silently truncates it to CAREOS_AAL — which matches no case, falls to the generic
  // default, and turns "verify your session" into "something went wrong". The four-state
  // doctrine depends on telling those two apart.
  const code = raw?.match(/CAREOS_[A-Z0-9_]+/)?.[0] ?? null;
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return {
        code,
        title: "Verify your session to see workforce figures",
        body: "These figures are built from visit records, so they appear only on a verified (MFA) session. Nothing is missing from the report — it simply isn't shown until you verify.",
      };
    case "CAREOS_FORBIDDEN":
      return {
        code,
        title: "Workforce analytics aren't part of your access",
        body: "Reading agency-wide visit performance needs the workforce analytics permission. Ask an owner or administrator to add it, and this page will fill in.",
      };
    case "CAREOS_POLICY_MISSING":
      return {
        code,
        title: "Set your visit rules first",
        body: "Lateness and overtime are measured against this agency's visit policy, and no policy defaults are set yet. Once they are, every figure here is computed from them.",
      };
    case "CAREOS_BAD_WINDOW":
      return {
        code,
        title: "That date range can't be reported on",
        body: "The range must end on or after it starts and cover no more than 366 days. Pick a shorter range and the figures return.",
      };
    case "CAREOS_NO_TENANT_CONTEXT":
      return {
        code,
        title: "Your session has no agency attached",
        body: "Sign out and back in. Nothing was changed, and no report was produced.",
      };
    case "CAREOS_NOT_FOUND":
      return {
        code,
        title: "That team member isn't available to you",
        body: "The record either doesn't exist or isn't one your access covers. The agency-wide figures are unaffected.",
      };
    default:
      return {
        code,
        title: "Couldn't build the workforce report",
        body: "Nothing was changed and nothing was written. The visit records are intact — try again in a moment.",
      };
  }
}

function toFeature(raw: Record<string, unknown>): CaregiverFeature {
  const dow = Array.isArray(raw.day_of_week_lateness) ? raw.day_of_week_lateness : [];
  const bands = (raw.trust_band_histogram ?? {}) as Record<string, unknown>;
  return {
    caregiver_id: String(raw.caregiver_id ?? ""),
    visits_scheduled: int(raw.visits_scheduled),
    visits_completed: int(raw.visits_completed),
    visits_missed: int(raw.visits_missed),
    late_count: int(raw.late_count),
    avg_late_minutes: num(raw.avg_late_minutes),
    early_count: int(raw.early_count),
    overrun_minutes: int(raw.overrun_minutes),
    undertime_minutes: int(raw.undertime_minutes),
    verified_rate: num(raw.verified_rate),
    location_exception_count: int(raw.location_exception_count),
    manual_override_count: int(raw.manual_override_count),
    missing_clock_out_count: int(raw.missing_clock_out_count),
    overlap_count: int(raw.overlap_count),
    impossible_travel_count: int(raw.impossible_travel_count),
    documentation_missing_count: int(raw.documentation_missing_count),
    schedule_adherence_pct: num(raw.schedule_adherence_pct),
    overtime_minutes: int(raw.overtime_minutes),
    client_continuity_pct: num(raw.client_continuity_pct),
    trust_band_histogram: Object.fromEntries(
      Object.entries(bands).map(([k, v]) => [k, int(v)])
    ),
    day_of_week_lateness: Array.from({ length: 7 }, (_, i) => num(dow[i])),
  };
}

/**
 * The one door (docs/17 §10). Every workforce capability reads this and nothing else —
 * so a capability that could invent a pattern would first have to invent a column.
 */
export async function readWorkforceFeatures(
  supabase: SupabaseClient,
  window: WindowSpec,
  caregiverId?: string | null
): Promise<{ features: WorkforceFeatures | null; error: string | undefined }> {
  const { data, error } = await supabase.schema("app").rpc("workforce_features", {
    p_from: window.from,
    p_to: window.to,
    p_caregiver: caregiverId ?? null,
  });
  if (error) return { features: null, error: error.message };

  const obj = (data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(obj.caregivers) ? obj.caregivers : [];
  return {
    features: {
      org_id: String(obj.org_id ?? ""),
      from: String(obj.from ?? window.from),
      to: String(obj.to ?? window.to),
      generated_at: String(obj.generated_at ?? new Date().toISOString()),
      caregivers: list.map((r) => toFeature(r as Record<string, unknown>)),
    },
    error: undefined,
  };
}

export type WorkforceTotals = {
  caregivers: number;
  visits_scheduled: number;
  visits_completed: number;
  visits_missed: number;
  late_count: number;
  early_count: number;
  overrun_minutes: number;
  undertime_minutes: number;
  overtime_minutes: number;
  overtime_hours: number;
  location_exception_count: number;
  manual_override_count: number;
  missing_clock_out_count: number;
  overlap_count: number;
  impossible_travel_count: number;
  documentation_missing_count: number;
  exceptions_total: number;
  /** Weighted, never a mean of means — see summarizeWorkforce. null when undefined. */
  adherence_pct: number | null;
  verified_pct: number | null;
  continuity_pct: number | null;
  avg_late_minutes: number | null;
  trust_bands: Record<string, number>;
};

const TRUST_BANDS = ["verified", "verified_with_exception", "requires_review", "high_risk"] as const;

/**
 * Agency totals, computed in TypeScript over the SQL output (invariant 13 — still the
 * deterministic side of the line; no model touches these).
 *
 * The three percentages are RE-WEIGHTED, not averaged. `schedule_adherence_pct` is
 * 100 × on-time ÷ scheduled for one caregiver, so pct × scheduled recovers the on-time
 * count exactly, and Σ(pct × scheduled) ÷ Σ scheduled is the true agency percentage to
 * within SQL's one-decimal rounding. A plain mean of caregiver percentages would let one
 * caregiver with two visits weigh as much as one with sixty — the kind of number that
 * reads authoritative and is quietly wrong.
 */
export function summarizeWorkforce(features: WorkforceFeatures): WorkforceTotals {
  const cg = features.caregivers;
  const sum = (pick: (c: CaregiverFeature) => number) => cg.reduce((s, c) => s + pick(c), 0);

  const scheduled = sum((c) => c.visits_scheduled);
  const completed = sum((c) => c.visits_completed);

  let adherenceNumerator = 0;
  let continuityNumerator = 0;
  let verifiedNumerator = 0;
  let lateMinutesTotal = 0;
  for (const c of cg) {
    if (c.schedule_adherence_pct !== null) adherenceNumerator += c.schedule_adherence_pct * c.visits_scheduled;
    if (c.client_continuity_pct !== null) continuityNumerator += c.client_continuity_pct * c.visits_scheduled;
    if (c.verified_rate !== null) verifiedNumerator += c.verified_rate * 100 * c.visits_completed;
    if (c.avg_late_minutes !== null) lateMinutesTotal += c.avg_late_minutes * c.late_count;
  }

  const trust: Record<string, number> = Object.fromEntries(TRUST_BANDS.map((b) => [b, 0]));
  for (const c of cg) {
    for (const [band, n] of Object.entries(c.trust_band_histogram)) {
      trust[band] = (trust[band] ?? 0) + n;
    }
  }

  const lateCount = sum((c) => c.late_count);
  const overtimeMinutes = sum((c) => c.overtime_minutes);
  const location = sum((c) => c.location_exception_count);
  const missingOut = sum((c) => c.missing_clock_out_count);
  const overlap = sum((c) => c.overlap_count);
  const travel = sum((c) => c.impossible_travel_count);
  const docs = sum((c) => c.documentation_missing_count);

  return {
    caregivers: cg.length,
    visits_scheduled: scheduled,
    visits_completed: completed,
    visits_missed: sum((c) => c.visits_missed),
    late_count: lateCount,
    early_count: sum((c) => c.early_count),
    overrun_minutes: sum((c) => c.overrun_minutes),
    undertime_minutes: sum((c) => c.undertime_minutes),
    overtime_minutes: overtimeMinutes,
    overtime_hours: hours(overtimeMinutes),
    location_exception_count: location,
    manual_override_count: sum((c) => c.manual_override_count),
    missing_clock_out_count: missingOut,
    overlap_count: overlap,
    impossible_travel_count: travel,
    documentation_missing_count: docs,
    exceptions_total: location + missingOut + overlap + travel + docs,
    adherence_pct: scheduled > 0 ? round1(adherenceNumerator / scheduled) : null,
    verified_pct: completed > 0 ? round1(verifiedNumerator / completed) : null,
    continuity_pct: scheduled > 0 ? round1(continuityNumerator / scheduled) : null,
    avg_late_minutes: lateCount > 0 ? round1(lateMinutesTotal / lateCount) : null,
    trust_bands: trust,
  };
}

/**
 * Agency weekday lateness. §10 gives a per-caregiver mean per weekday and no counts, so a
 * true weighted agency mean is not recoverable from it — this is the MEAN OF CAREGIVER
 * MEANS, each caregiver counting once, and `caregivers_reporting` is published beside it
 * so the surface can say exactly that rather than implying a weighted figure.
 */
export type WeekdayLateness = {
  index: number;
  label: string;
  mean_late_minutes: number | null;
  caregivers_reporting: number;
};

export function weekdayLateness(features: WorkforceFeatures): WeekdayLateness[] {
  return WEEKDAY_LABEL.map((label, index) => {
    const values = features.caregivers
      .map((c) => c.day_of_week_lateness[index])
      .filter((v): v is number => v !== null);
    return {
      index,
      label,
      mean_late_minutes: values.length
        ? round1(values.reduce((s, v) => s + v, 0) / values.length)
        : null,
      caregivers_reporting: values.length,
    };
  });
}

/** A roster row: the deterministic per-caregiver line the surface renders and ranks. */
export type RosterEntry = {
  /** Per-report opaque handle. The model sees this; the UUID never leaves the server. */
  key: string;
  caregiverId: string;
  feature: CaregiverFeature;
  /** Open findings attributable to this caregiver in the window. Deterministic sum. */
  exceptions: number;
  /** Deterministic operational-impact score used to order the roster. Never a model's. */
  impact: number;
};

export function buildRoster(features: WorkforceFeatures): RosterEntry[] {
  return features.caregivers
    .map((c) => {
      const exceptions =
        c.location_exception_count +
        c.missing_clock_out_count +
        c.overlap_count +
        c.impossible_travel_count +
        c.documentation_missing_count;
      // Impact = what an operations lead would look at first: missed care, then
      // exceptions, then lateness, then overtime. Pure arithmetic, stated once.
      const impact =
        c.visits_missed * 10 +
        exceptions * 4 +
        c.late_count * 2 +
        Math.min(c.overtime_minutes, 600) / 60;
      return { caregiverId: c.caregiver_id, feature: c, exceptions, impact: round1(impact) };
    })
    .sort((a, b) => b.impact - a.impact || b.feature.visits_scheduled - a.feature.visits_scheduled)
    .map((r, i) => ({ key: `cg-${i + 1}`, ...r }));
}

export type WeeklyReportFacts = {
  version: 1;
  window: WindowSpec;
  days: number;
  generated_at: string;
  totals: WorkforceTotals;
  roster: RosterEntry[];
  weekday: WeekdayLateness[];
};

export type WeeklyReportNarration = {
  headline: string | null;
  sections: { topic: string; text: string }[];
  closing: string | null;
};

export type WeeklyReport = Degradation & {
  facts: WeeklyReportFacts | null;
  narration: WeeklyReportNarration | null;
  /** Present when the deterministic read itself refused; the surface renders its copy. */
  error: { code: string | null; title: string; body: string } | null;
};

/** The topics a section may be filed under. A section under any other topic is dropped. */
export const REPORT_TOPICS: Record<string, string> = {
  adherence: "Schedule adherence",
  lateness: "Lateness",
  exceptions: "Exceptions",
  verification: "Verification",
  overtime: "Overtime",
  continuity: "Client continuity",
};

/** The PHI minimizer for workforce.weekly_report — this object IS the allowlist. */
function toWeeklyPromptFacts(facts: WeeklyReportFacts): Record<string, unknown> {
  return {
    window: { from: facts.window.from, to: facts.window.to, days: facts.days },
    topics: Object.keys(REPORT_TOPICS),
    totals: facts.totals,
    weekday_lateness: facts.weekday.map((w) => ({
      weekday: w.label,
      mean_late_minutes: w.mean_late_minutes,
      caregivers_reporting: w.caregivers_reporting,
      note: "mean of caregiver averages; each caregiver counts once",
    })),
    // Ranked by deterministic operational impact and capped: the report is about
    // patterns, and a roster of hundreds is neither readable nor cheaper for being long.
    caregivers: facts.roster.slice(0, 25).map((r) => ({
      key: r.key,
      visits_scheduled: r.feature.visits_scheduled,
      visits_completed: r.feature.visits_completed,
      visits_missed: r.feature.visits_missed,
      late_count: r.feature.late_count,
      avg_late_minutes: r.feature.avg_late_minutes,
      early_count: r.feature.early_count,
      schedule_adherence_pct: r.feature.schedule_adherence_pct,
      verified_pct: r.feature.verified_rate === null ? null : round1(r.feature.verified_rate * 100),
      client_continuity_pct: r.feature.client_continuity_pct,
      overtime_minutes: r.feature.overtime_minutes,
      overtime_hours: hours(r.feature.overtime_minutes),
      overrun_minutes: r.feature.overrun_minutes,
      undertime_minutes: r.feature.undertime_minutes,
      manual_override_count: r.feature.manual_override_count,
      exceptions: r.exceptions,
      trust_bands: r.feature.trust_band_histogram,
      weekday_late_minutes: WEEKDAY_LABEL.map((label, i) => ({
        weekday: label,
        mean_late_minutes: r.feature.day_of_week_lateness[i],
      })),
    })),
  };
}

const WEEKLY_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One sentence naming the week's dominant pattern." },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", description: "One of the provided topic keys, copied exactly." },
          text: { type: "string", description: "A short paragraph about that topic." },
        },
        required: ["topic", "text"],
        additionalProperties: false,
      },
    },
    closing: { type: ["string", "null"], description: "Optional one-sentence close, or null." },
  },
  required: ["headline", "sections", "closing"],
  additionalProperties: false,
} as const;

/** Built-in prompt. An ACTIVE ai_prompt_template row (migration 0052 v1) overrides it. */
const WEEKLY_SYSTEM =
  "You are the CareOS workforce reporter. You receive one JSON object of deterministic aggregates for a " +
  "stated date range: per-caregiver counts, rates and minute aggregates, identified by an opaque key. " +
  "Every number in it was computed in SQL and is ground truth.\n" +
  "1. Never compute, adjust, project, annualise or estimate a number. Report and compare only what the object contains; " +
  "if a measure is absent, say the report does not cover it rather than filling the gap.\n" +
  "2. Refer to people only by the key you were given. You have no names, no coordinates, no addresses and no client details, and you never ask for them.\n" +
  "3. Describe patterns, not people. \"Six late starts, five of them Mondays\" is a pattern; \"unreliable\" is a characterisation of a person, which is a different capability with a required human disposer.\n" +
  "4. Never propose or imply an employment consequence — no discipline, no termination, no reassignment, and no ranking of staff best to worst.\n" +
  "5. Correlation is not cause. You may note that two series move together; you may not say why.\n" +
  "6. Plain language, sentence case, no exclamation points, short paragraphs in ranked order of operational impact.";

export function parseWeeklyNarration(
  raw: string | null,
  facts: WeeklyReportFacts,
  allowed: Set<string>
): { narration: WeeklyReportNarration | null; dropped: number } {
  const obj = safeJson(raw);
  if (!obj) return { narration: null, dropped: 0 };

  const knownKeys = new Set(facts.roster.map((r) => r.key));
  const seen = new Set<string>();
  let dropped = 0;

  /** A sentence may name a caregiver handle only if that handle is on this roster. */
  const inventsCaregiver = (text: string) => {
    for (const m of text.matchAll(/\bcg-\d+\b/gi)) {
      if (!knownKeys.has(m[0].toLowerCase())) return true;
    }
    return false;
  };
  const clean = (text: string | null) =>
    text &&
    !inventsNumber(text, allowed) &&
    !readsAsEmploymentAction(text) &&
    !inventsCaregiver(text)
      ? text
      : null;

  const sections: { topic: string; text: string }[] = [];
  for (const entry of Array.isArray(obj.sections) ? obj.sections : []) {
    const e = entry as { topic?: unknown; text?: unknown };
    const topic = str(e.topic)?.toLowerCase() ?? null;
    const text = clean(str(e.text));
    if (!topic || !text || !REPORT_TOPICS[topic] || seen.has(topic)) {
      dropped += 1;
      continue;
    }
    seen.add(topic);
    sections.push({ topic, text });
  }

  const headline = clean(str(obj.headline));
  if (!headline && sections.length === 0) return { narration: null, dropped };
  return { narration: { headline, sections, closing: clean(str(obj.closing)) }, dropped };
}

/**
 * The read path /operations/workforce calls. Deterministic figures are produced first and
 * survive every AI failure; narration is strictly additive.
 */
export async function getWeeklyWorkforceReport(
  supabase: SupabaseClient,
  window: WindowSpec
): Promise<WeeklyReport> {
  const empty: WeeklyReport = {
    facts: null,
    narration: null,
    provider: "none",
    model: null,
    interactionId: null,
    note: null,
    dropped: 0,
    error: null,
  };

  const { features, error } = await readWorkforceFeatures(supabase, window);
  if (!features) return { ...empty, error: describeFeaturesError(error) };

  const facts: WeeklyReportFacts = {
    version: 1,
    window,
    days: windowDays(window),
    generated_at: features.generated_at,
    totals: summarizeWorkforce(features),
    roster: buildRoster(features),
    weekday: weekdayLateness(features),
  };
  if (facts.roster.length === 0) return { ...empty, facts };

  const promptFacts = toWeeklyPromptFacts(facts);
  const allowed = allowedNumbers(promptFacts);
  const res = await runCapability(supabase, CAPABILITY_WEEKLY_REPORT, {
    system: WEEKLY_SYSTEM,
    user:
      `Workforce aggregates for ${window.from} to ${window.to}:\n${JSON.stringify(promptFacts)}\n\n` +
      "Return JSON. Write a one-sentence headline and between two and five sections, each filed under one of " +
      "the provided topic keys, ordered by operational impact. Quote only figures that appear above.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "workforce_weekly_report",
      schema: WEEKLY_SCHEMA as unknown as Record<string, unknown>,
    },
    inputDigest: digest(
      `weekly ${window.from}..${window.to} · ${facts.roster.length} caregivers · ${facts.totals.visits_scheduled} visits`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const { narration, dropped } = parseWeeklyNarration(res.text, facts, allowed);
  return {
    facts,
    narration,
    provider: narration ? res.provider : "none",
    model: narration ? res.model : null,
    interactionId: res.interactionId,
    dropped,
    note: narration ? null : degradeNote(res, "written summary"),
    error: null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   3 · payroll.readiness_brief (T1) — aggregate hours + blocking exception counts
   ══════════════════════════════════════════════════════════════════════════════
   Every figure comes from the approved-hours ledger and the exception ledger. The two
   deterministic rules restated here are the ones migration 0050 enforces, so the brief
   and the button can never disagree:
     · a visit's hours cannot be approved while an OPEN CRITICAL finding sits on it;
     · a period cannot close while any completed visit in it is still awaiting approval.
   ═══════════════════════════════════════════════════════════════════════════════ */

export type PayrollBlocker = {
  key: string;
  kind: string;
  label: string;
  count: number;
};

export type PayrollReadinessFacts = {
  version: 1;
  generated_at: string;
  window: WindowSpec;
  period: { id: string; starts_on: string; ends_on: string; status: string } | null;
  visits: {
    total: number;
    completed: number;
    approved: number;
    rejected: number;
    awaiting_approval: number;
    never_clocked: number;
    ready_for_payroll: number;
    exported: number;
  };
  approved_minutes: number;
  approved_hours: number;
  awaiting_minutes: number;
  awaiting_hours: number;
  blockers: PayrollBlocker[];
  blocking_total: number;
  /** True only when nothing stands between this period and a human closing it. */
  can_close: boolean;
};

export type PayrollNarration = {
  summary: string | null;
  blockers: { key: string; line: string }[];
  closing: string | null;
};

export type PayrollReadiness = Degradation & {
  facts: PayrollReadinessFacts | null;
  narration: PayrollNarration | null;
  error: string | null;
};

type PeriodRow = { id: string; starts_on: string; ends_on: string; status: string };
type PayVisitRow = {
  visit_id: string;
  caregiver_id: string | null;
  status: string;
  approval_status: string | null;
  payroll_status: string | null;
  verification_status: string | null;
  verified_minutes: number | null;
  actual_start: string | null;
};
type SegmentRow = {
  visit_id: string;
  approved_minutes: number | null;
  decision: string;
  seq: number;
};

/**
 * Deterministic payroll readiness for one period (or, with no open period, the trailing
 * window). Reads run under the caller's RLS — a reader without payroll access sees the
 * refusal, not a partial number.
 */
export async function collectPayrollReadiness(
  supabase: SupabaseClient,
  opts: { window?: WindowSpec; periodId?: string } = {}
): Promise<{ facts: PayrollReadinessFacts | null; error: string | null }> {
  const { data: periodData, error: periodError } = await supabase
    .from("payroll_period")
    .select("id, starts_on, ends_on, status")
    .order("starts_on", { ascending: false })
    .limit(12);
  if (periodError) return { facts: null, error: periodError.message };

  const periods = (periodData ?? []) as PeriodRow[];
  const period =
    (opts.periodId ? periods.find((p) => p.id === opts.periodId) : undefined) ??
    periods.find((p) => p.status === "open") ??
    periods[0] ??
    null;

  const window: WindowSpec = period
    ? { from: period.starts_on, to: period.ends_on }
    : opts.window ?? trailingWindow(14);

  // Half-open on scheduled_start, matching the membership rule 0050 uses for a close.
  // Boundaries are UTC midnight. CareOS still has no per-tenant time-zone column (0049
  // and 0051 both flag it), so a visit scheduled in the small hours of the first or last
  // day can fall either side of a boundary the database would place differently. It is
  // named here rather than papered over, and it moves when that column lands.
  const startISO = `${window.from}T00:00:00.000Z`;
  const endISO = `${ymd(Date.parse(`${window.to}T00:00:00.000Z`) + MS_DAY)}T00:00:00.000Z`;

  const [visitRes, segmentRes] = await Promise.all([
    supabase
      .from("verified_visit")
      .select(
        "visit_id, caregiver_id, status, approval_status, payroll_status, verification_status, verified_minutes, actual_start"
      )
      .gte("scheduled_start", startISO)
      .lt("scheduled_start", endISO)
      .neq("status", "cancelled")
      .limit(2000),
    supabase
      .from("approved_work_segment")
      .select("visit_id, approved_minutes, decision, seq")
      .gte("work_date", window.from)
      .lte("work_date", window.to)
      .order("seq", { ascending: false })
      .limit(2000),
  ]);

  if (visitRes.error) return { facts: null, error: visitRes.error.message };

  const visits = (visitRes.data ?? []) as PayVisitRow[];
  // Append-only ledger: the LATEST segment per visit is the live one (0050 supersedes).
  const latestSegment = new Map<string, SegmentRow>();
  for (const s of (segmentRes.data ?? []) as SegmentRow[]) {
    if (!latestSegment.has(s.visit_id)) latestSegment.set(s.visit_id, s);
  }

  let approvedMinutes = 0;
  for (const s of latestSegment.values()) {
    if (s.decision === "approved") approvedMinutes += int(s.approved_minutes);
  }

  const completed = visits.filter((v) => v.status === "completed");
  const awaiting = completed.filter((v) => (v.approval_status ?? "pending") === "pending");
  const awaitingMinutes = awaiting.reduce((s, v) => s + Math.max(0, int(v.verified_minutes)), 0);

  // Open findings on visits in this window, counted by kind. Only CRITICAL findings block
  // an approval (0050 §7) — the rest are reported as context, never as a blocker.
  const visitIds = visits.map((v) => v.visit_id);
  const blockerCounts = new Map<string, number>();
  if (visitIds.length > 0) {
    const { data: exceptions } = await supabase
      .from("visit_exception_state")
      .select("exception_id, visit_id, kind, severity, open")
      .eq("open", true)
      .eq("severity", "critical")
      .in("visit_id", visitIds.slice(0, 400))
      .limit(1000);
    for (const e of (exceptions ?? []) as { kind: string }[]) {
      blockerCounts.set(e.kind, (blockerCounts.get(e.kind) ?? 0) + 1);
    }
  }

  const blockers: PayrollBlocker[] = [...blockerCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count], i) => ({
      key: `blk-${i + 1}`,
      kind,
      label: EXCEPTION_LABEL[kind] ?? "Visit exception",
      count,
    }));
  const blockingTotal = blockers.reduce((s, b) => s + b.count, 0);

  const facts: PayrollReadinessFacts = {
    version: 1,
    generated_at: new Date().toISOString(),
    window,
    period,
    visits: {
      total: visits.length,
      completed: completed.length,
      approved: visits.filter((v) => v.approval_status === "approved").length,
      rejected: visits.filter((v) => v.approval_status === "rejected").length,
      awaiting_approval: awaiting.length,
      never_clocked: visits.filter((v) => !v.actual_start).length,
      ready_for_payroll: visits.filter((v) => v.payroll_status === "ready").length,
      exported: visits.filter((v) => v.payroll_status === "exported").length,
    },
    approved_minutes: approvedMinutes,
    approved_hours: hours(approvedMinutes),
    awaiting_minutes: awaitingMinutes,
    awaiting_hours: hours(awaitingMinutes),
    blockers,
    blocking_total: blockingTotal,
    can_close: awaiting.length === 0 && blockingTotal === 0,
  };
  return { facts, error: null };
}

/** The PHI minimizer for payroll.readiness_brief — this object IS the allowlist. */
function toPayrollPromptFacts(facts: PayrollReadinessFacts): Record<string, unknown> {
  return {
    period: facts.period
      ? { starts_on: facts.period.starts_on, ends_on: facts.period.ends_on, status: facts.period.status }
      : null,
    window: facts.window,
    visits: facts.visits,
    approved_minutes: facts.approved_minutes,
    approved_hours: facts.approved_hours,
    awaiting_minutes: facts.awaiting_minutes,
    awaiting_hours: facts.awaiting_hours,
    blockers: facts.blockers.map((b) => ({ key: b.key, finding: b.label, count: b.count })),
    blocking_total: facts.blocking_total,
    can_close: facts.can_close,
  };
}

const PAYROLL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences on what stands between this period and a close." },
    blockers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "One of the provided blocker keys, copied exactly." },
          line: { type: "string", description: "One sentence: what it holds up and what a human does next." },
        },
        required: ["key", "line"],
        additionalProperties: false,
      },
    },
    closing: { type: ["string", "null"], description: "Optional one-sentence close, or null." },
  },
  required: ["summary", "blockers", "closing"],
  additionalProperties: false,
} as const;

/** Built-in prompt. An ACTIVE ai_prompt_template row (migration 0052 v1) overrides it. */
const PAYROLL_SYSTEM =
  "You are the CareOS payroll-readiness briefer. You receive deterministic aggregates for one payroll period: " +
  "approved and unapproved visit counts, approved minutes and hours, open findings blocking approval by kind, and " +
  "documentation gaps. The approved-hours ledger computed every figure.\n" +
  "1. Never compute, convert, restate or estimate minutes, hours, rates or money of any kind. A figure that is not in the facts does not go in the brief.\n" +
  "2. Say what blocks the close, how many items each blocker holds, and what a human does next.\n" +
  "3. You never decide that a period may close, that a visit may be paid, or that a finding may be waived. Those are human acts on deterministic evidence.\n" +
  "4. Use the keys you were given. You receive no names, no coordinates, no addresses and no client details, and you never ask for them.\n" +
  "5. Plain language, sentence case, no exclamation points. Five sentences or fewer unless the blockers need more.\n" +
  "6. If nothing blocks the close, say so in one sentence, and stop.";

export function parsePayrollNarration(
  raw: string | null,
  facts: PayrollReadinessFacts,
  allowed: Set<string>
): { narration: PayrollNarration | null; dropped: number } {
  const obj = safeJson(raw);
  if (!obj) return { narration: null, dropped: 0 };

  const known = new Set(facts.blockers.map((b) => b.key));
  const seen = new Set<string>();
  let dropped = 0;
  const clean = (text: string | null) =>
    text && !inventsNumber(text, allowed) && !readsAsEmploymentAction(text) ? text : null;

  const blockers: { key: string; line: string }[] = [];
  for (const entry of Array.isArray(obj.blockers) ? obj.blockers : []) {
    const e = entry as { key?: unknown; line?: unknown };
    const key = str(e.key);
    const line = clean(str(e.line));
    if (!key || !line || !known.has(key) || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    blockers.push({ key, line });
  }

  const summary = clean(str(obj.summary));
  if (!summary && blockers.length === 0) return { narration: null, dropped };
  return { narration: { summary, blockers, closing: clean(str(obj.closing)) }, dropped };
}

/** The read path a timesheets / period-close surface calls. Never throws. */
export async function getPayrollReadinessBrief(
  supabase: SupabaseClient,
  opts: { window?: WindowSpec; periodId?: string } = {}
): Promise<PayrollReadiness> {
  const { facts, error } = await collectPayrollReadiness(supabase, opts);
  const base: PayrollReadiness = {
    facts,
    narration: null,
    provider: "none",
    model: null,
    interactionId: null,
    note: null,
    dropped: 0,
    error,
  };
  if (!facts) return base;

  const promptFacts = toPayrollPromptFacts(facts);
  const allowed = allowedNumbers(promptFacts);
  const res = await runCapability(supabase, CAPABILITY_PAYROLL_READINESS, {
    system: PAYROLL_SYSTEM,
    user:
      `Payroll readiness facts:\n${JSON.stringify(promptFacts)}\n\n` +
      "Return JSON. Say what blocks the close and what a human does next. Quote only figures that appear above.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "payroll_readiness_brief",
      schema: PAYROLL_SCHEMA as unknown as Record<string, unknown>,
    },
    inputDigest: digest(
      `payroll ${facts.window.from}..${facts.window.to} · awaiting ${facts.visits.awaiting_approval} · blockers ${facts.blocking_total}`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const { narration, dropped } = parsePayrollNarration(res.text, facts, allowed);
  return {
    ...base,
    narration,
    provider: narration ? res.provider : "none",
    model: narration ? res.model : null,
    interactionId: res.interactionId,
    dropped,
    note: narration ? null : degradeNote(res, "written brief"),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   4 · visit.operational_profile — T2, HUMAN DISPOSER REQUIRED
   ══════════════════════════════════════════════════════════════════════════════
   READ THIS BEFORE CHANGING ANYTHING BELOW.

   This is the only capability in the layer that characterises an INDIVIDUAL EMPLOYEE,
   and it is the one that erodes D-021 — "the system never proposes termination;
   separation is always human-initiated" — if it is allowed to drift. Migration 0052
   registers it T2 with requires_human = true and its kill switch OFF, and the 0014
   CHECK makes T2 ⇒ requires_human structurally true so no later migration, seed or
   admin RPC can register it as auto-execute. D-028 is the decision that put it there.

   What that means for this code, concretely:
     · It writes NOTHING. No employment record, no proposal row, no status, no flag.
       Its entire output is text handed back to the caller for a human to read and edit.
     · It never runs on page load. The surface requires an explicit human request, and
       the result is never auto-delivered, emailed, or notified to anyone.
     · It FAILS CLOSED. Absent registry row, disabled row, or a tier that is not T2 with
       a required human disposer ⇒ no call is made at all. Every other capability in this
       codebase degrades open when the registry is missing; this one must not, because
       "the registry has not been provisioned yet" is not consent to profile an employee.
     · The guardrail is total, not partial: if ANY sentence reads as an employment action
       the WHOLE draft is discarded. A profile with one deleted sentence still reads as a
       recommendation; a profile that never renders cannot.
     · Deterministic abstention comes first. A short window or a small sample is answered
       in code — "the sample is too small to characterise a person" — without spending a
       model call to arrive at the same sentence.
   ═══════════════════════════════════════════════════════════════════════════════ */

/** Below these, a profile is arithmetic noise about a person. Stated once, here. */
const PROFILE_MIN_DAYS = 14;
const PROFILE_MIN_VISITS = 10;

export type OperationalProfileDraft = {
  caregiverId: string;
  window: WindowSpec;
  days: number;
  /** The deterministic feature row the draft must trace to. Always rendered. */
  feature: CaregiverFeature | null;
  exceptions: number;
  weekday: { index: number; label: string; mean_late_minutes: number | null }[];
  /** Model text, or null on every degrade path. Never authoritative, always a draft. */
  draft: { paragraphs: string[]; ambiguities: string[] } | null;
  /** Always true. Carried in the payload so a renderer cannot forget to say it. */
  isDraft: true;
  requiresHumanDisposer: true;
  tier: "T2";
  /** Set when the platform declined to draft at all, in the words a human should read. */
  abstained: string | null;
  interactionId: string | null;
  provider: string;
  model: string | null;
  note: string | null;
  dropped: number;
  error: { code: string | null; title: string; body: string } | null;
};

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    too_small: {
      type: "boolean",
      description: "True when the counts are too small to characterise a person.",
    },
    paragraphs: {
      type: "array",
      items: { type: "string", description: "One paragraph, every sentence tracing to a figure." },
    },
    ambiguities: {
      type: "array",
      items: {
        type: "string",
        description: "A pattern with both a benign and a concerning reading, stating that the facts do not distinguish them.",
      },
    },
  },
  required: ["too_small", "paragraphs", "ambiguities"],
  additionalProperties: false,
} as const;

/** Built-in prompt. An ACTIVE ai_prompt_template row (migration 0052 v1) overrides it. */
const PROFILE_SYSTEM =
  "You are the CareOS operational-profile drafter. You receive deterministic aggregates for ONE caregiver over a " +
  "stated date range: counts, rates and minute aggregates, by key, computed in SQL. You write a draft for a named " +
  "Owner or HR reviewer to read, edit and decide upon. You are not the decision, and this draft is never shown to " +
  "the person it describes.\n" +
  "1. Every sentence must trace to a figure in the facts. Never infer attitude, effort, honesty, health, family circumstances or intent — ever.\n" +
  "2. Never recommend, imply or rank an employment action: no discipline, no termination, no probation, no reassignment, no \"consider whether\". " +
  "The system never proposes separation; a human initiates it, and this draft is not that act.\n" +
  "3. Name what changed and over what window, with the figures. Where a pattern has a benign explanation as well as a concerning one, state both and say plainly that the facts do not distinguish them.\n" +
  "4. You receive no coordinates, no addresses, no client identities and no clinical information, and you never ask for them.\n" +
  "5. If the window is short or the counts are small, set too_small and stop. Silence is a valid output.\n" +
  "6. Plain language, sentence case, no exclamation points, no praise, no judgement words.";

/** The PHI minimizer for visit.operational_profile — this object IS the allowlist. */
function toProfilePromptFacts(
  feature: CaregiverFeature,
  window: WindowSpec,
  exceptions: number
): Record<string, unknown> {
  return {
    subject: "caregiver-under-review",
    window: { from: window.from, to: window.to, days: windowDays(window) },
    visits_scheduled: feature.visits_scheduled,
    visits_completed: feature.visits_completed,
    visits_missed: feature.visits_missed,
    late_count: feature.late_count,
    avg_late_minutes: feature.avg_late_minutes,
    early_count: feature.early_count,
    schedule_adherence_pct: feature.schedule_adherence_pct,
    verified_pct: feature.verified_rate === null ? null : round1(feature.verified_rate * 100),
    client_continuity_pct: feature.client_continuity_pct,
    overtime_minutes: feature.overtime_minutes,
    overtime_hours: hours(feature.overtime_minutes),
    overrun_minutes: feature.overrun_minutes,
    undertime_minutes: feature.undertime_minutes,
    manual_override_count: feature.manual_override_count,
    exceptions_total: exceptions,
    location_exception_count: feature.location_exception_count,
    missing_clock_out_count: feature.missing_clock_out_count,
    overlap_count: feature.overlap_count,
    impossible_travel_count: feature.impossible_travel_count,
    documentation_missing_count: feature.documentation_missing_count,
    trust_bands: feature.trust_band_histogram,
    weekday_late_minutes: WEEKDAY_LABEL.map((label, i) => ({
      weekday: label,
      mean_late_minutes: feature.day_of_week_lateness[i],
    })),
  };
}

/**
 * Fail-closed switch check. Unlike every other capability here, an ABSENT registry row
 * means OFF: provisioning that has not happened is not an owner's decision to profile
 * their own staff (see the block comment above, and migration 0052's header).
 */
async function profileCapabilityOn(
  supabase: SupabaseClient
): Promise<{ on: boolean; reason: string | null }> {
  try {
    const { data, error } = await supabase
      .from("ai_capability")
      .select("key, tier, requires_human, enabled, active")
      .eq("key", CAPABILITY_OPERATIONAL_PROFILE)
      .maybeSingle();
    if (error || !data) {
      return {
        on: false,
        reason:
          "Operational profiles are not switched on for this agency. An owner turns them on deliberately — until then, the figures on this page are the record.",
      };
    }
    const row = data as {
      tier: string | null;
      requires_human: boolean | null;
      enabled: boolean | null;
      active: boolean | null;
    };
    if (row.enabled === false || row.active === false) {
      return {
        on: false,
        reason:
          "Operational profiles are switched off for this agency. The figures on this page are complete without one.",
      };
    }
    if (row.tier !== "T2" || row.requires_human !== true) {
      return {
        on: false,
        reason:
          "Operational profiles are registered in a way this screen will not use. Nothing was drafted; ask an administrator to review the AI settings.",
      };
    }
    return { on: true, reason: null };
  } catch {
    return {
      on: false,
      reason: "Operational profiles could not be confirmed as switched on, so nothing was drafted.",
    };
  }
}

/**
 * Draft ONE caregiver's operational profile for a human reviewer. Explicit request only.
 * Writes nothing, decides nothing, and returns a draft or an honest refusal.
 */
export async function draftOperationalProfile(
  supabase: SupabaseClient,
  caregiverId: string,
  window: WindowSpec
): Promise<OperationalProfileDraft> {
  const days = windowDays(window);
  const base: OperationalProfileDraft = {
    caregiverId,
    window,
    days,
    feature: null,
    exceptions: 0,
    weekday: WEEKDAY_LABEL.map((label, index) => ({ index, label, mean_late_minutes: null })),
    draft: null,
    isDraft: true,
    requiresHumanDisposer: true,
    tier: "T2",
    abstained: null,
    interactionId: null,
    provider: "none",
    model: null,
    note: null,
    dropped: 0,
    error: null,
  };

  const { features, error } = await readWorkforceFeatures(supabase, window, caregiverId);
  if (!features) return { ...base, error: describeFeaturesError(error) };

  const feature = features.caregivers.find((c) => c.caregiver_id === caregiverId) ?? null;
  if (!feature) {
    return {
      ...base,
      abstained:
        "There are no visits for this team member in the selected range, so there is nothing to describe.",
    };
  }

  const exceptions =
    feature.location_exception_count +
    feature.missing_clock_out_count +
    feature.overlap_count +
    feature.impossible_travel_count +
    feature.documentation_missing_count;
  const withFacts: OperationalProfileDraft = {
    ...base,
    feature,
    exceptions,
    weekday: WEEKDAY_LABEL.map((label, index) => ({
      index,
      label,
      mean_late_minutes: feature.day_of_week_lateness[index],
    })),
  };

  // Deterministic abstention, before any spend (invariant 13 — this is a rule, not a
  // judgement, and a rule belongs in code).
  if (days < PROFILE_MIN_DAYS || feature.visits_scheduled < PROFILE_MIN_VISITS) {
    return {
      ...withFacts,
      abstained:
        "This range is too small to describe a person fairly. The figures below stand on their own; widen the range before drafting anything about an individual.",
    };
  }

  const gate = await profileCapabilityOn(supabase);
  if (!gate.on) return { ...withFacts, abstained: gate.reason };

  const promptFacts = toProfilePromptFacts(feature, window, exceptions);
  const allowed = allowedNumbers(promptFacts);
  const res = await runCapability(supabase, CAPABILITY_OPERATIONAL_PROFILE, {
    system: PROFILE_SYSTEM,
    user:
      `Deterministic figures for one caregiver:\n${JSON.stringify(promptFacts)}\n\n` +
      "Return JSON. Write two to four short paragraphs, each sentence tracing to a figure above, and list any " +
      "pattern that has both a benign and a concerning reading. Propose nothing.",
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: {
      name: "visit_operational_profile",
      schema: PROFILE_SCHEMA as unknown as Record<string, unknown>,
    },
    inputDigest: digest(
      `profile ${window.from}..${window.to} · ${feature.visits_scheduled} scheduled · ${exceptions} findings`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const parsed = parseProfileDraft(res.text, allowed);
  if (!parsed.draft) {
    return {
      ...withFacts,
      interactionId: res.interactionId,
      dropped: parsed.dropped,
      abstained: parsed.abstained,
      note: parsed.abstained ? null : degradeNote(res, "written draft"),
    };
  }

  return {
    ...withFacts,
    draft: parsed.draft,
    interactionId: res.interactionId,
    provider: res.provider,
    model: res.model,
    dropped: parsed.dropped,
  };
}

/**
 * The total guardrail. An employment-action sentence anywhere discards the WHOLE draft —
 * a profile missing one paragraph still reads as a recommendation, and there is no version
 * of "mostly did not propose separation" that is acceptable (D-021).
 */
export function parseProfileDraft(
  raw: string | null,
  allowed: Set<string>
): {
  draft: { paragraphs: string[]; ambiguities: string[] } | null;
  dropped: number;
  abstained: string | null;
} {
  const obj = safeJson(raw);
  if (!obj) return { draft: null, dropped: 0, abstained: null };

  if (obj.too_small === true) {
    return {
      draft: null,
      dropped: 0,
      abstained:
        "There isn't enough here to describe a person fairly, so nothing was drafted. The figures below stand on their own.",
    };
  }

  const texts = (v: unknown) =>
    (Array.isArray(v) ? v : []).map((x) => str(x)).filter((x): x is string => x !== null);
  const paragraphs = texts(obj.paragraphs);
  const ambiguities = texts(obj.ambiguities);

  if ([...paragraphs, ...ambiguities].some(readsAsEmploymentAction)) {
    return {
      draft: null,
      dropped: paragraphs.length + ambiguities.length,
      abstained:
        "A draft was produced and then discarded: it read as a recommendation about someone's employment, which this system never makes. Nothing was recorded about this person beyond the figures below.",
    };
  }

  let dropped = 0;
  const keepParagraphs = paragraphs.filter((p) => {
    if (inventsNumber(p, allowed)) {
      dropped += 1;
      return false;
    }
    return true;
  });
  const keepAmbiguities = ambiguities.filter((p) => {
    if (inventsNumber(p, allowed)) {
      dropped += 1;
      return false;
    }
    return true;
  });

  if (keepParagraphs.length === 0) {
    return {
      draft: null,
      dropped,
      abstained:
        dropped > 0
          ? "A draft was produced and then set aside: its figures did not match the record. The figures below are the record."
          : null,
    };
  }
  return {
    draft: { paragraphs: keepParagraphs, ambiguities: keepAmbiguities },
    dropped,
    abstained: null,
  };
}
