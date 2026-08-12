/**
 * Deterministic urgency ranking for the exception inbox (docs/17 §7.2, §11).
 *
 * INVARIANT 13, LITERALLY. docs/17 §11 is explicit: "Ranking for the exception queue is
 * deterministic (severity × recency × payroll impact × client risk); the model only
 * writes the *why*." So the order of this queue is arithmetic — a pure function of four
 * database facts — and no model is consulted, called, or allowed to reorder it. A
 * sibling capability may later narrate a row; it may never rank one.
 *
 * The weights are constants in this file rather than a formula scattered across a
 * component so that "why is this at the top" has exactly one answer, and so the answer
 * can be shown to the person reading the queue (`explain()` below returns it in words).
 *
 * Deliberately NOT an input:
 *   - the caregiver's identity or history. This is a queue of findings about visits, not
 *     a ranking of people; D-021 and invariant 8 keep employee characterisation behind a
 *     T2 capability with a human disposer, and it has no business setting sort order.
 *   - anything about the client's condition. Client risk in docs/17 §11 is scheduled
 *     service risk, which this slice has no column for yet; rather than approximate it
 *     with PHI, it is left out and named here as the known gap.
 *
 * No PHI enters this module: it takes enums, timestamps and booleans only.
 */

/* ── Weights ──────────────────────────────────────────────────────────────── */

/** How bad the finding is, as the detector classified it (visit_exception.severity). */
const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 100,
  warning: 55,
  info: 20,
};

/**
 * How recent it is. A fresh finding is still fixable — a missing clock-out found twenty
 * minutes ago can be closed by the caregiver today; one from last week cannot. Buckets,
 * not a curve, because the queue has to be explainable to the person working it.
 */
const RECENCY_BUCKETS: { withinHours: number; weight: number; label: string }[] = [
  { withinHours: 1, weight: 40, label: "found in the last hour" },
  { withinHours: 4, weight: 32, label: "found in the last few hours" },
  { withinHours: 12, weight: 24, label: "found today" },
  { withinHours: 24, weight: 16, label: "found in the last day" },
  { withinHours: 72, weight: 8, label: "found in the last few days" },
];
const RECENCY_FLOOR = { weight: 2, label: "older than a few days" };

/** Kinds that stand between delivered work and a correct paycheque. */
const PAYROLL_AFFECTING = new Set([
  "missing_clock_out",
  "missed_visit",
  "overlapping_visits",
  "impossible_travel",
  "manual_correction",
  "duplicate_visit",
  "payroll_mismatch",
  "long_visit",
  "short_visit",
]);
const PAYROLL_BLOCKING_WEIGHT = 30; // hours not yet approved: the money is still movable
const PAYROLL_SETTLED_WEIGHT = 12; // already approved: now it is a correction, not a block

/**
 * Openness. `visit_exception_state.open` is the product's single definition of "still
 * needs a decision" (no disposition yet, or the latest one reopened it). Escalated and
 * acknowledged rows are closed for queue purposes but are not finished business, so they
 * keep some weight and stay visible on the disposed tab in a sensible order.
 */
const OPEN_WEIGHT = 45;
const ESCALATED_WEIGHT = 25;
const ACKNOWLEDGED_WEIGHT = 10;

/** Bands. Chosen so that critical+open lands in "Now" even when it has aged. */
const BAND_NOW = 140;
const BAND_TODAY = 85;

export type UrgencyBand = "now" | "today" | "queued";

export const BAND_LABEL: Record<UrgencyBand, string> = {
  now: "Needs attention now",
  today: "Today",
  queued: "When you can",
};

/** The four facts the ranking reads. Enums, timestamps and booleans — nothing else. */
export type RankInput = {
  exceptionId: string;
  kind: string;
  severity: string;
  detectedAt: string;
  open: boolean;
  latestDisposition: string | null;
  /** visit.approval_status: 'pending' | 'approved' | 'rejected'. Null when the visit row
   *  is not visible to this reader — the ranking then treats pay as unknown, not settled. */
  approvalStatus: string | null;
};

export type RankFactors = {
  severity: number;
  recency: number;
  payroll: number;
  openness: number;
};

export type RankResult = {
  score: number;
  band: UrgencyBand;
  factors: RankFactors;
  /** One sentence naming why this sits where it does. Written here, never by a model. */
  explanation: string;
};

function recencyOf(detectedAt: string, now: Date): { weight: number; label: string } {
  const detected = new Date(detectedAt).getTime();
  if (!Number.isFinite(detected)) return RECENCY_FLOOR;
  const hours = (now.getTime() - detected) / 3_600_000;
  for (const bucket of RECENCY_BUCKETS) {
    if (hours < bucket.withinHours) return { weight: bucket.weight, label: bucket.label };
  }
  return RECENCY_FLOOR;
}

function payrollOf(kind: string, approvalStatus: string | null): { weight: number; label: string | null } {
  if (!PAYROLL_AFFECTING.has(kind)) return { weight: 0, label: null };
  if (approvalStatus === "approved") {
    return { weight: PAYROLL_SETTLED_WEIGHT, label: "the hours are already approved, so this is a correction" };
  }
  return { weight: PAYROLL_BLOCKING_WEIGHT, label: "hours for this visit cannot be approved until it is settled" };
}

function opennessOf(input: RankInput): { weight: number; label: string } {
  if (input.open) return { weight: OPEN_WEIGHT, label: "nobody has decided on it yet" };
  if (input.latestDisposition === "escalated") return { weight: ESCALATED_WEIGHT, label: "it was escalated" };
  if (input.latestDisposition === "acknowledged") {
    return { weight: ACKNOWLEDGED_WEIGHT, label: "it is acknowledged but not settled" };
  }
  return { weight: 0, label: "it has been decided" };
}

/** Score one finding. Pure: same inputs, same output, forever. */
export function rank(input: RankInput, now: Date): RankResult {
  const severity = SEVERITY_WEIGHT[input.severity] ?? SEVERITY_WEIGHT.info;
  const recency = recencyOf(input.detectedAt, now);
  const payroll = payrollOf(input.kind, input.approvalStatus);
  const openness = opennessOf(input);

  const score = severity + recency.weight + payroll.weight + openness.weight;
  const band: UrgencyBand = score >= BAND_NOW ? "now" : score >= BAND_TODAY ? "today" : "queued";

  const severityWord =
    input.severity === "critical" ? "critical" : input.severity === "warning" ? "a warning" : "informational";
  const parts = [`Ranked ${severityWord}`, recency.label, openness.label];
  if (payroll.label) parts.push(payroll.label);

  return {
    score,
    band,
    factors: {
      severity,
      recency: recency.weight,
      payroll: payroll.weight,
      openness: openness.weight,
    },
    explanation: `${parts.join(", ")}.`,
  };
}

/**
 * Rank a list and return it in queue order: score descending, then newest first.
 * The tiebreak is explicit so two findings with identical weights never trade places
 * between renders — a queue that reshuffles under a reader is a queue they stop trusting.
 */
export function rankAll<T extends RankInput>(items: T[], now: Date): (T & { rank: RankResult })[] {
  return items
    .map((item) => ({ ...item, rank: rank(item, now) }))
    .sort((a, b) => {
      if (b.rank.score !== a.rank.score) return b.rank.score - a.rank.score;
      const byTime = new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
      if (byTime !== 0) return byTime;
      // Total order, not merely a consistent one. Score+time ties are COMMON, not rare:
      // app.sweep_visit_exceptions inserts every finding of a run in one transaction, so
      // they share an instant, and the page's ORDER BY detected_at has no unique
      // secondary key — Postgres may hand back tied rows in any order. Without this
      // tiebreak the queue can silently reshuffle between two renders of identical data,
      // which is exactly what this module's header promises it will not do. exceptionId
      // is a uuid: arbitrary, but stable, which is the whole point.
      return a.exceptionId < b.exceptionId ? -1 : a.exceptionId > b.exceptionId ? 1 : 0;
    });
}
