/**
 * Deterministic urgency ranking for the exception inbox — `ranking.ts`.
 *
 * INVARIANT 13, TESTED AS A PROPERTY RATHER THAN ASSERTED IN A COMMENT. docs/17 §11 is
 * explicit that this queue is ordered by arithmetic — severity × recency × payroll
 * impact × openness — and that "the model only writes the *why*". A ranking that drifted
 * into a model call would be an LLM deciding which caregiver's missing clock-out a
 * coordinator sees first, which is a payroll decision and a judgement about a person.
 *
 * WHAT THIS PROVES
 *   1. PURE. Same inputs, same output, twice, with no clock of its own — `now` is a
 *      parameter, so the function cannot read wall time and cannot vary between a server
 *      render and a client one.
 *   2. NO MODEL, STRUCTURALLY. The module's source is checked for any AI import, any
 *      `fetch`, and any async surface. `rank` returns an object, not a promise: there is
 *      nowhere for a network call to hide.
 *   3. ORDERING IS TOTAL AND PERMUTATION-INVARIANT for findings that differ at all —
 *      shuffle the input a hundred ways and the queue comes out the same.
 *   4. EACH FACTOR MOVES THE SCORE IN THE DIRECTION DOCUMENTED, and only that factor:
 *      severity outranks age, unapproved hours outweigh approved ones, an undecided
 *      finding outranks a disposed one.
 *   5. THE SCORE IS THE SUM OF ITS PUBLISHED FACTORS, so `explain()` cannot say one thing
 *      while the sort does another — the reason shown to the coordinator is the reason.
 *   6. NO PHI, AND NO PERSON. The input type carries enums, timestamps and booleans;
 *      neither the caregiver nor the client can influence the order (D-021, invariant 8).
 *      The explanation is assembled from fixed phrases and is asserted to leak nothing it
 *      was handed.
 *
 * Serves: docs/17 §7.2 §11, D-021, invariants 5, 8 and 13.
 * Runs anywhere Node runs — no server, no database, no network, no model.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BAND_LABEL, rank, rankAll, type RankInput } from "./ranking";

const SOURCE = readFileSync(fileURLToPath(new URL("./ranking.ts", import.meta.url)), "utf8");

const NOW = new Date("2026-08-11T18:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function input(over: Partial<RankInput> = {}): RankInput {
  return {
    exceptionId: "exc-0",
    kind: "documentation_missing",
    severity: "info",
    detectedAt: minutesAgo(30),
    open: true,
    latestDisposition: null,
    approvalStatus: "pending",
    ...over,
  };
}

/* ── 1 · Pure ──────────────────────────────────────────────────────────────── */

describe("purity", () => {
  it("returns an identical result for identical inputs", () => {
    const item = input({ kind: "missing_clock_out", severity: "critical" });
    expect(rank(item, NOW)).toEqual(rank(item, NOW));
  });

  it("returns a value, not a promise — there is nowhere for a network call to hide", () => {
    const result = rank(input(), NOW);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.score).toBe("number");
  });

  it("reads no clock of its own: the same finding scores differently only as `now` moves", () => {
    const item = input({ detectedAt: minutesAgo(30) });
    const early = rank(item, NOW);
    const later = rank(item, new Date(NOW.getTime() + 96 * 3_600_000));
    expect(later.factors.recency).toBeLessThan(early.factors.recency);
    // Everything the clock does not touch is untouched.
    expect(later.factors.severity).toBe(early.factors.severity);
    expect(later.factors.payroll).toBe(early.factors.payroll);
    expect(later.factors.openness).toBe(early.factors.openness);
  });

  it("does not mutate the objects it is handed", () => {
    const item = input();
    const snapshot = structuredClone(item);
    rankAll([item], NOW);
    expect(item).toEqual(snapshot);
  });
});

/* ── 2 · No model, structurally ────────────────────────────────────────────── */

describe("no model participates in ordering (invariant 13)", () => {
  it("imports nothing from the AI layer", () => {
    expect(SOURCE).not.toMatch(/from\s+["'][^"']*\/ai\//);
    expect(SOURCE).not.toMatch(/runCapability|ai_interaction|anthropic|openai/i);
  });

  it("has no network call and no async surface at all", () => {
    expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
    expect(SOURCE).not.toMatch(/\basync\b/);
    expect(SOURCE).not.toMatch(/\bawait\b/);
  });

  it("imports nothing whatsoever — it is arithmetic over four database facts", () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
  });
});

/* ── 3 · Ordering is total and permutation-invariant ───────────────────────── */

describe("queue order", () => {
  const population: RankInput[] = [
    input({ exceptionId: "a", kind: "missing_clock_out", severity: "critical", detectedAt: minutesAgo(20) }),
    input({ exceptionId: "b", kind: "documentation_missing", severity: "info", detectedAt: minutesAgo(5) }),
    input({ exceptionId: "c", kind: "impossible_travel", severity: "warning", detectedAt: minutesAgo(200) }),
    input({ exceptionId: "d", kind: "missed_visit", severity: "critical", detectedAt: minutesAgo(4_000), open: false, latestDisposition: "escalated" }),
    input({ exceptionId: "e", kind: "payroll_mismatch", severity: "warning", detectedAt: minutesAgo(90), approvalStatus: "approved" }),
    input({ exceptionId: "f", kind: "low_accuracy", severity: "info", detectedAt: minutesAgo(600), open: false, latestDisposition: "acknowledged" }),
    input({ exceptionId: "g", kind: "overlapping_visits", severity: "critical", detectedAt: minutesAgo(45) }),
  ];

  const expected = rankAll(population, NOW).map((r) => r.exceptionId);

  it("produces the same order from any input permutation", () => {
    // 120 deterministic shuffles: if the comparator were partial, one of them would
    // disagree. A queue whose order depends on how Postgres happened to return the rows
    // is a queue a coordinator stops trusting.
    let seed = 7;
    const nextInt = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let trial = 0; trial < 120; trial++) {
      const shuffled = [...population];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = nextInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(rankAll(shuffled, NOW).map((r) => r.exceptionId)).toEqual(expected);
    }
  });

  it("is sorted by score descending, then newest first", () => {
    const ranked = rankAll(population, NOW);
    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1];
      const cur = ranked[i];
      expect(prev.rank.score).toBeGreaterThanOrEqual(cur.rank.score);
      if (prev.rank.score === cur.rank.score) {
        expect(Date.parse(prev.detectedAt)).toBeGreaterThanOrEqual(Date.parse(cur.detectedAt));
      }
    }
  });

  it("returns every finding it was given, exactly once", () => {
    const ranked = rankAll(population, NOW);
    expect(ranked).toHaveLength(population.length);
    expect(new Set(ranked.map((r) => r.exceptionId)).size).toBe(population.length);
  });

  it("orders findings that tie on BOTH score and time deterministically, whatever order they arrive in", () => {
    // Score+time ties are COMMON, not exotic: app.sweep_visit_exceptions inserts every
    // finding of a run in one transaction, so they share an instant, and the page's
    // `.order("detected_at", …)` carries no unique secondary key — Postgres may return
    // tied rows in any order it likes. The comparator therefore breaks the tie on
    // exceptionId, so the SAME data always renders in the SAME order. Feeding it both
    // permutations and demanding one answer is what proves the order is total rather
    // than merely consistent-with-its-input.
    const twins = [
      input({ exceptionId: "aaaa-1111", detectedAt: minutesAgo(10) }),
      input({ exceptionId: "bbbb-2222", detectedAt: minutesAgo(10) }),
    ];
    const forward = rankAll(twins, NOW).map((r) => r.exceptionId);
    const reversed = rankAll([...twins].reverse(), NOW).map((r) => r.exceptionId);
    expect(forward).toEqual(["aaaa-1111", "bbbb-2222"]);
    expect(reversed).toEqual(forward);
  });

  it("handles an empty queue without inventing a row", () => {
    expect(rankAll([], NOW)).toEqual([]);
  });
});

/* ── 4 · Each factor moves the score as documented ─────────────────────────── */

describe("severity", () => {
  it("orders critical above warning above info, all else equal", () => {
    const c = rank(input({ severity: "critical" }), NOW).factors.severity;
    const w = rank(input({ severity: "warning" }), NOW).factors.severity;
    const i = rank(input({ severity: "info" }), NOW).factors.severity;
    expect(c).toBeGreaterThan(w);
    expect(w).toBeGreaterThan(i);
  });

  it("treats an unrecognised severity as informational rather than throwing", () => {
    // A future detector's new enum value must degrade, not crash the coordinator's queue.
    const unknown = rank(input({ severity: "catastrophic" }), NOW);
    expect(unknown.factors.severity).toBe(rank(input({ severity: "info" }), NOW).factors.severity);
    expect(Number.isFinite(unknown.score)).toBe(true);
  });

  it("outweighs age: a critical finding from last week beats a fresh informational one", () => {
    const oldCritical = rank(input({ severity: "critical", detectedAt: minutesAgo(10_000) }), NOW);
    const freshInfo = rank(input({ severity: "info", detectedAt: minutesAgo(1) }), NOW);
    expect(oldCritical.score).toBeGreaterThan(freshInfo.score);
  });
});

describe("recency", () => {
  it("decreases monotonically as a finding ages", () => {
    const ages = [10, 120, 600, 1_200, 4_000, 20_000];
    const weights = ages.map((m) => rank(input({ detectedAt: minutesAgo(m) }), NOW).factors.recency);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
    }
    expect(weights[0]).toBeGreaterThan(weights[weights.length - 1]);
  });

  it("does not reward a finding stamped in the future", () => {
    const future = rank(input({ detectedAt: new Date(NOW.getTime() + 3_600_000).toISOString() }), NOW);
    const fresh = rank(input({ detectedAt: minutesAgo(1) }), NOW);
    expect(future.factors.recency).toBeLessThanOrEqual(fresh.factors.recency);
    expect(Number.isFinite(future.score)).toBe(true);
  });

  it("falls to the floor — never NaN — for an unparseable timestamp", () => {
    const broken = rank(input({ detectedAt: "not a timestamp" }), NOW);
    expect(Number.isFinite(broken.score)).toBe(true);
    expect(broken.factors.recency).toBeGreaterThanOrEqual(0);
    expect(broken.explanation).toContain("older than a few days");
  });
});

describe("payroll impact", () => {
  it("weights a pay-blocking finding above the same finding once hours are approved", () => {
    const blocking = rank(input({ kind: "missing_clock_out", approvalStatus: "pending" }), NOW);
    const settled = rank(input({ kind: "missing_clock_out", approvalStatus: "approved" }), NOW);
    expect(blocking.factors.payroll).toBeGreaterThan(settled.factors.payroll);
    expect(settled.factors.payroll).toBeGreaterThan(0); // still a correction, not nothing
  });

  it("adds nothing for a kind that cannot move money", () => {
    expect(rank(input({ kind: "documentation_missing" }), NOW).factors.payroll).toBe(0);
  });

  it("treats an invisible visit as unknown pay, not as settled pay", () => {
    // approvalStatus is null when the visit row is outside this reader's RLS scope.
    // Assuming "already approved" there would quietly demote real blockers.
    const unknown = rank(input({ kind: "missing_clock_out", approvalStatus: null }), NOW);
    const approved = rank(input({ kind: "missing_clock_out", approvalStatus: "approved" }), NOW);
    expect(unknown.factors.payroll).toBeGreaterThan(approved.factors.payroll);
  });

  it("says so in words whenever it added weight", () => {
    const blocking = rank(input({ kind: "missing_clock_out" }), NOW);
    expect(blocking.explanation).toContain("hours for this visit cannot be approved");
  });
});

describe("openness", () => {
  it("ranks undecided above escalated above acknowledged above decided", () => {
    const open = rank(input({ open: true }), NOW).factors.openness;
    const escalated = rank(input({ open: false, latestDisposition: "escalated" }), NOW).factors.openness;
    const acked = rank(input({ open: false, latestDisposition: "acknowledged" }), NOW).factors.openness;
    const done = rank(input({ open: false, latestDisposition: "resolved" }), NOW).factors.openness;
    expect(open).toBeGreaterThan(escalated);
    expect(escalated).toBeGreaterThan(acked);
    expect(acked).toBeGreaterThan(done);
    expect(done).toBe(0);
  });
});

/* ── 5 · The score is the sum of its published factors ─────────────────────── */

describe("explainability", () => {
  const samples: RankInput[] = [
    input(),
    input({ severity: "critical", kind: "missed_visit" }),
    input({ severity: "warning", kind: "payroll_mismatch", approvalStatus: "approved", open: false, latestDisposition: "escalated" }),
    input({ severity: "info", kind: "low_accuracy", detectedAt: minutesAgo(50_000) }),
  ];

  it.each(samples.map((s, i) => [i, s] as const))("sample %i: score equals its four factors", (_i, item) => {
    const { score, factors } = rank(item, NOW);
    expect(score).toBe(factors.severity + factors.recency + factors.payroll + factors.openness);
  });

  it("lands a critical, undecided finding in the top band even once it has aged", () => {
    const aged = rank(input({ severity: "critical", kind: "missed_visit", detectedAt: minutesAgo(50_000) }), NOW);
    expect(aged.band).toBe("now");
    expect(BAND_LABEL[aged.band]).toBe("Needs attention now");
  });

  it("assigns every finding one of the three named bands", () => {
    for (const item of samples) {
      expect(Object.keys(BAND_LABEL)).toContain(rank(item, NOW).band);
    }
  });

  it("bands are monotone in score", () => {
    const order = { queued: 0, today: 1, now: 2 };
    const ranked = rankAll(samples, NOW);
    for (let i = 1; i < ranked.length; i++) {
      expect(order[ranked[i - 1].rank.band]).toBeGreaterThanOrEqual(order[ranked[i].rank.band]);
    }
  });
});

/* ── 6 · No PHI, and no person, reaches the ordering ───────────────────────── */

describe("what may influence the order", () => {
  it("cannot be moved by anything about the caregiver or the client", () => {
    // RankInput has no field for either, by design — this pins the type so a future
    // `caregiverTrustBand` or `clientRiskScore` cannot be slipped in without a decision.
    const allowed = [
      "approvalStatus",
      "detectedAt",
      "exceptionId",
      "kind",
      "latestDisposition",
      "open",
      "severity",
    ];
    expect(Object.keys(input()).sort()).toEqual(allowed);
  });

  it("never repeats an identifier back into the explanation", () => {
    const item = input({ exceptionId: "9f1c8b2e-visit-of-mrs-alvarez", kind: "missing_clock_out" });
    const { explanation } = rank(item, NOW);
    expect(explanation).not.toContain(item.exceptionId);
    expect(explanation.toLowerCase()).not.toContain("alvarez");
  });

  it("writes one sentence, in plain language, with no code or jargon", () => {
    const { explanation } = rank(input({ severity: "critical", kind: "missing_clock_out" }), NOW);
    expect(explanation.endsWith(".")).toBe(true);
    expect(explanation).not.toMatch(/CAREOS_|undefined|NaN|\[object/);
    expect(explanation).not.toMatch(/GPS|geofence|EVV|metres|meters/i);
  });
});
