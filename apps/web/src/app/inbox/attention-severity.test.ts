/**
 * The attention queue's severity mapping — `attention-severity.ts` (ST-238, W5).
 *
 * The design plan makes the per-source severity mapping an ACCEPTANCE CRITERION, not an
 * implementation detail (docs/designs/intelligent-front-door.md W5). An acceptance
 * criterion that lives only in a rendered chip can drift a lane at a time — one file
 * decides a credential warning is Critical this month, another decides an offer is
 * Warning next month, and the queue's ordering stops meaning anything. So the table is
 * data, and this file is the gate on it.
 *
 * WHAT THIS PROVES
 *   1. TOTAL. Every one of the six `alert_ack` lanes has a rule; a seventh cannot exist.
 *   2. DETERMINISTIC AND PURE (invariant 13). No clock, no network, no model: the module
 *      is read as text and asserted to contain no AI import, no `fetch`, and no `async`.
 *   3. THE LADDER IS THE LADDER. 60/30/0 buckets exactly as the credential engine's
 *      `days_to_expiry` says, including the boundary days and the 0-day rung.
 *   4. THE RATIFIED EXAMPLES HOLD — clinical = Critical, the 30-day rung = Warning,
 *      offers = information — so a change to any of them fails here and has to be argued
 *      for rather than merged.
 *   5. EVERY SEVERITY HAS A WORD (D-012), because a colour alone is not a status.
 *
 * Runs anywhere Node runs — no server, no database, no network, no model.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SEVERITY_RANK,
  SEVERITY_TONE,
  SEVERITY_WORD,
  SOURCE_LABEL,
  SOURCE_SEVERITY,
  credentialRung,
  severityFor,
  type AttentionSeverity,
  type AttentionSource,
} from "./attention-severity";

/** The closed lane list, copied from migration 0054's CHECK constraint by hand. */
const LANES: AttentionSource[] = [
  "proposal",
  "credential",
  "exception",
  "clinical",
  "notification",
  "offer",
];

const SEVERITIES: AttentionSeverity[] = ["critical", "warning", "info"];

describe("the mapping is total over the queue's six lanes", () => {
  it("gives every lane a rule and every rule a valid severity", () => {
    expect(Object.keys(SOURCE_SEVERITY).sort()).toEqual([...LANES].sort());
    for (const lane of LANES) {
      const rule = SOURCE_SEVERITY[lane];
      const values = "fixed" in rule ? [rule.fixed] : [...Object.values(rule.graded), rule.otherwise];
      for (const v of values) expect(SEVERITIES).toContain(v);
    }
  });

  it("resolves every lane with and without a grade", () => {
    for (const lane of LANES) {
      expect(SEVERITIES).toContain(severityFor(lane));
      expect(SEVERITIES).toContain(severityFor(lane, "a-grade-nobody-defined"));
      expect(SEVERITIES).toContain(severityFor(lane, null));
    }
  });

  it("never drops an unknown grade to the quietest lane", () => {
    // A future enum value must not arrive silently at the bottom of the queue.
    for (const lane of LANES) {
      const rule = SOURCE_SEVERITY[lane];
      if ("fixed" in rule) continue;
      const quietest = Math.max(...Object.values(rule.graded).map((s) => SEVERITY_RANK[s]));
      expect(SEVERITY_RANK[rule.otherwise]).toBeLessThanOrEqual(quietest);
    }
  });

  it("labels every lane and every severity in words (D-012)", () => {
    for (const lane of LANES) expect(SOURCE_LABEL[lane].length).toBeGreaterThan(0);
    for (const s of SEVERITIES) {
      expect(SEVERITY_WORD[s].length).toBeGreaterThan(0);
      expect(SEVERITY_TONE[s].length).toBeGreaterThan(0);
    }
    // The words are distinct — three chips reading the same thing is a colour-only status
    // wearing a label.
    expect(new Set(SEVERITIES.map((s) => SEVERITY_WORD[s])).size).toBe(3);
  });
});

describe("the ratified per-source criterion", () => {
  it("holds the examples the plan names", () => {
    // docs/designs/intelligent-front-door.md W5: "clinical flag=Critical; geofence
    // exception=Warning; 30-day credential rung=Warning; offer/info=Info".
    expect(severityFor("clinical")).toBe("critical");
    expect(severityFor("exception", "warning")).toBe("warning");
    expect(severityFor("credential", "due_30")).toBe("warning");
    expect(severityFor("offer")).toBe("info");
    expect(severityFor("notification")).toBe("info");
  });

  it("keeps a critical visit finding critical and everything else a warning", () => {
    expect(severityFor("exception", "critical")).toBe("critical");
    expect(severityFor("exception", "info")).toBe("warning");
    expect(severityFor("exception", null)).toBe("warning");
  });

  it("puts a waiting proposal above information and below a critical", () => {
    expect(SEVERITY_RANK[severityFor("proposal")]).toBeGreaterThan(SEVERITY_RANK.critical);
    expect(SEVERITY_RANK[severityFor("proposal")]).toBeLessThan(SEVERITY_RANK.info);
  });
});

describe("the 60/30/0 credential ladder", () => {
  it("buckets on the engine's own days_to_expiry, boundaries included", () => {
    expect(credentialRung(-1)).toBe("lapsed"); // already past
    expect(credentialRung(0)).toBe("lapsed"); // the 0-day rung: expires today
    expect(credentialRung(1)).toBe("due_30");
    expect(credentialRung(30)).toBe("due_30");
    expect(credentialRung(31)).toBe("due_60");
    expect(credentialRung(60)).toBe("due_60");
    expect(credentialRung(61)).toBeNull(); // off the ladder — not this queue's business
  });

  it("declines to guess when the engine had no date to work from", () => {
    expect(credentialRung(null)).toBeNull();
    expect(credentialRung(undefined)).toBeNull();
    expect(credentialRung(Number.NaN)).toBeNull();
  });

  it("escalates monotonically as the deadline approaches", () => {
    const ranks = [90, 60, 45, 30, 15, 1, 0, -10].map((d) => {
      const rung = credentialRung(d);
      return rung === null ? SEVERITY_RANK.info : SEVERITY_RANK[severityFor("credential", rung)];
    });
    for (let i = 1; i < ranks.length; i += 1) expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
  });
});

describe("no model, structurally", () => {
  it("has no AI import, no fetch and no async surface", () => {
    const source = fs.readFileSync(path.join(__dirname, "attention-severity.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']@\/lib\/ai/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\basync\b/);
    expect(source).not.toMatch(/\bawait\b/);
  });

  it("is pure — same answer twice, with no clock of its own", () => {
    const once = LANES.map((l) => severityFor(l, "due_30"));
    const twice = LANES.map((l) => severityFor(l, "due_30"));
    expect(once).toEqual(twice);
  });
});
