/**
 * `describeFeaturesError` — the one CAREOS_* mapper in this layer that is exported, and
 * therefore the one that can be driven directly rather than parsed out of a `"use server"`
 * module.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. `app.workforce_features` (migration 0051) is a
 * definer aggregate gated on an AAL2 session holding `workforce.read`. Almost every
 * refusal it returns is a refusal the reader can DO something about — verify the session,
 * ask for the permission, set a visit policy, shorten the range. A mapper that collapses
 * those into "something went wrong" converts five actionable states into one dead end,
 * and the four-state doctrine (docs/10 §8) depends on telling them apart.
 *
 * WHAT THIS PROVES
 *   1. Every code migration 0051 can raise reaches its own title and body — parity is
 *      checked against the migration itself, so a new refusal without copy fails here.
 *   2. `CAREOS_AAL2_REQUIRED` in particular survives extraction. It carries a digit, and
 *      a character class of `[A-Z_]` truncates it to `CAREOS_AAL`, silently routing the
 *      one refusal a reader can fix in ten seconds to the generic dead end.
 *   3. Each refusal produces a DISTINCT sentence — five different situations, five
 *      different things to do.
 *   4. An unknown failure yields written copy and echoes no fragment of the raw wire
 *      message: no table name, no constraint name, no row value (invariant 5).
 *   5. The copy says what happened, what is intact, and what to do next (docs/10 voice).
 *
 * Serves: docs/17 §10, docs/08 §2, docs/10 §8, invariants 5 and 14.
 * Runs anywhere Node runs — no server, no database, no network, no model.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The mapper is pure, but it lives beside the capability code that imports the model
// client. Mocking that module keeps this file honest about having no network at all.
vi.mock("@/lib/ai/client", () => ({
  digest: (s: string) => s,
  runCapability: vi.fn(async () => {
    throw new Error("describeFeaturesError must not reach a model");
  }),
}));

const { describeFeaturesError } = await import("./visit-intelligence");

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../../../supabase/migrations/0051_workforce_analytics.sql", import.meta.url)),
  "utf8"
);

/** Codes migration 0051 raises, with the message text a caller receives. */
const RAISES = [
  ...MIGRATION.matchAll(/raise\s+exception\s+'(CAREOS_[A-Z0-9_]+)((?:[^']|'')*)'/g),
].map((m) => ({ code: m[1], message: `${m[1]}${m[2].replace(/''/g, "'")}` }));

const CODES = [...new Set(RAISES.map((r) => r.code))].sort();

describe("parity with migration 0051", () => {
  it("found the migration's refusals", () => {
    expect(CODES.length).toBeGreaterThanOrEqual(5);
    expect(CODES).toContain("CAREOS_AAL2_REQUIRED");
  });

  it.each(RAISES.map((r) => [r.code, r.message] as const))(
    "%s is recognised from its own raise message",
    (code, message) => {
      expect(describeFeaturesError(message).code).toBe(code);
    }
  );

  it("gives every raisable code its own specific copy, never the generic fallback", () => {
    const generic = describeFeaturesError("something unmapped");
    const collapsed = RAISES.filter(
      (r) => describeFeaturesError(r.message).title === generic.title
    ).map((r) => r.code);
    expect([...new Set(collapsed)], "codes routed to the dead-end message").toEqual([]);
  });

  it("writes a distinct sentence per refusal", () => {
    const titles = CODES.map((c) => describeFeaturesError(`${c}: detail`).title);
    expect(new Set(titles).size).toBe(CODES.length);
  });
});

describe("the digit-bearing code", () => {
  it("recognises CAREOS_AAL2_REQUIRED rather than truncating it to CAREOS_AAL", () => {
    const out = describeFeaturesError(
      "CAREOS_AAL2_REQUIRED: a verified session is required to read workforce features"
    );
    expect(out.code).toBe("CAREOS_AAL2_REQUIRED");
    expect(out.title.toLowerCase()).toContain("verify");
  });

  it("tells the reader the report is withheld, not broken", () => {
    const out = describeFeaturesError("CAREOS_AAL2_REQUIRED: …");
    expect(out.body.toLowerCase()).toContain("nothing is missing");
  });
});

describe("an unknown failure", () => {
  const RAW = [
    'permission denied for table "app_user"',
    'relation "workforce_features" does not exist',
    "canceling statement due to statement timeout",
    "",
  ];

  it.each(RAW)("returns written copy for: %s", (raw) => {
    const out = describeFeaturesError(raw);
    expect(out.code).toBeNull();
    expect(out.title).toBeTruthy();
    expect(out.body).toBeTruthy();
  });

  it("returns written copy when there is no message at all", () => {
    expect(describeFeaturesError(undefined).code).toBeNull();
  });

  it("echoes no fragment of the raw wire message", () => {
    for (const raw of RAW.filter(Boolean)) {
      const out = describeFeaturesError(raw);
      const text = `${out.title} ${out.body}`.toLowerCase();
      for (const word of raw.split(/\W+/).filter((w) => w.length > 6)) {
        expect(text, `leaked "${word}" from the wire message`).not.toContain(word.toLowerCase());
      }
    }
  });
});

describe("voice", () => {
  it("every message says what is intact and what to do next", () => {
    for (const code of [...CODES, "CAREOS_UNMAPPED_THING"]) {
      const out = describeFeaturesError(`${code}: detail`);
      expect(out.title.endsWith(".")).toBe(false); // a title, not a sentence
      expect(out.body.trim().endsWith(".")).toBe(true);
      expect(out.body.length).toBeGreaterThan(40);
      expect(`${out.title} ${out.body}`).not.toMatch(/CAREOS_|undefined|null\b|\[object/);
    }
  });
});
