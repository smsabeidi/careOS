/**
 * CAREOS_* → plain language on the caregiver clock path.
 *
 * WHAT THIS PROVES, AND WHY IT IS A SOURCE-LEVEL TEST. `messageKeyFor` and `codeOf` live
 * inside `src/app/today/actions.ts`, which carries the `"use server"` directive — a
 * module that may export only async functions, so neither helper can be exported and
 * neither can be imported here. Restructuring the app to suit a test is worse than
 * reading the app: this file therefore parses the real regex, the real switch table and
 * the real TERMINAL_CODES set out of the source, and drives them against the real
 * `raise exception` statements parsed out of migrations 0046 and 0047. Nothing is
 * reimplemented — a copy of the mapping in a test would only prove the copy.
 *
 * The four properties:
 *
 *   1. PARITY. Every `CAREOS_*` code `app.clock_visit` or `app.request_location_exception`
 *      can raise has a case in the UI mapping. Add a `raise exception` to either function
 *      without writing the sentence that goes with it and this test fails — which is the
 *      whole point, because the alternative is a caregiver at a door reading "Something
 *      went wrong" about a refusal the database explained perfectly well.
 *
 *   2. THE CODE SURVIVES EXTRACTION. The mapping matches a code out of a raw Postgres
 *      message with a regex. That regex is applied here to the ACTUAL message text of
 *      every raise statement in the migrations, and the extracted code must equal the
 *      code that was raised. A character class that cannot express a digit silently
 *      truncates `CAREOS_AAL2_REQUIRED` to `CAREOS_AAL`, matches no case, and turns
 *      "unlock with your authenticator" into "something went wrong" — a caregiver
 *      retrying forever against a session that needs verifying.
 *
 *   3. DISTINCT SENTENCES. No code the database can raise falls through to the generic
 *      fallback, and two codes share a sentence only when both are malformed-request
 *      codes (one honest sentence for "that request was not well formed").
 *
 *   4. NOTHING IS ECHOED. An unrecognised failure yields the generic translated sentence
 *      and carries no fragment of the raw Postgres message — no table name, no
 *      constraint name, no row value (invariant 5).
 *
 * Serves: docs/17 §7.1, docs/10 voice, D-030, invariants 5 and 14.
 * Runs anywhere Node runs — reads files off disk; no server, no database, no network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en, es } from "@/lib/i18n/dictionaries";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ACTIONS = readFileSync(`${REPO}apps/web/src/app/today/actions.ts`, "utf8");
const MIG_CLOCK = readFileSync(`${REPO}supabase/migrations/0046_clock_engine.sql`, "utf8");
const MIG_EXCEPTION = readFileSync(`${REPO}supabase/migrations/0047_exception_engine.sql`, "utf8");

/* ── Reading the database's side of the contract ───────────────────────────── */

/** The text of one `create or replace function app.<name>(…)` through to the next one. */
function plpgsqlFunction(sql: string, name: string): string {
  const marker = `create or replace function app.${name}(`;
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`migration no longer defines app.${name}`);
  const rest = sql.slice(start + marker.length);
  const next = rest.indexOf("\ncreate or replace function ");
  return next < 0 ? sql.slice(start) : sql.slice(start, start + marker.length + next);
}

/**
 * Every code raised inside one function, with the message text as the client will see it.
 * `\s` spans newlines on purpose: several raises put the string on its own line.
 *
 * `CAREOS_POLICY_MISSING` is deliberately absent from the result: `app.clock_visit`
 * catches it from the policy resolver and degrades to the documented §3.4 floor
 * (DN-0046f), so it never reaches a caller. The pattern below only matches a real
 * `raise exception`, never the `sqlerrm not like 'CAREOS_POLICY_MISSING%'` guard.
 */
function raisedBy(sql: string, name: string): { code: string; message: string }[] {
  const body = plpgsqlFunction(sql, name);
  return [...body.matchAll(/raise\s+exception\s+'(CAREOS_[A-Z0-9_]+)((?:[^']|'')*)'/g)].map((m) => ({
    code: m[1],
    // Postgres collapses '' to a single quote in the emitted message.
    message: `${m[1]}${m[2].replace(/''/g, "'")}`,
  }));
}

const DB_RAISES = [
  ...raisedBy(MIG_CLOCK, "clock_visit"),
  ...raisedBy(MIG_EXCEPTION, "request_location_exception"),
];
const DB_CODES = [...new Set(DB_RAISES.map((r) => r.code))].sort();

/* ── Reading the UI's side of the contract ─────────────────────────────────── */

function functionBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`today/actions.ts no longer declares ${signature}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

const MAP_BLOCK = functionBlock(ACTIONS, "function messageKeyFor");
const CODE_OF_BLOCK = functionBlock(ACTIONS, "function codeOf");

/** The literal regex the shipped code uses to pull a code out of a Postgres message. */
function extractionRegex(block: string): RegExp {
  const found = block.match(/\.match\((\/[^/]+\/[gimsuy]*)\)/);
  if (!found) throw new Error("no code-extraction regex found — has the mapping changed shape?");
  const [, literal] = found;
  const lastSlash = literal.lastIndexOf("/");
  return new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
}

const MESSAGE_REGEX = extractionRegex(MAP_BLOCK);
const CODE_OF_REGEX = extractionRegex(CODE_OF_BLOCK);

/**
 * code → TranslationKey, read out of the switch. Cases accumulate until a return, so a
 * deliberate fall-through (two codes, one sentence) is preserved rather than flattened.
 */
function switchTable(block: string): { table: Map<string, string>; fallback: string } {
  const table = new Map<string, string>();
  let fallback: string | null = null;
  let pending: string[] = [];
  let inDefault = false;

  for (const line of block.split("\n")) {
    const caseMatch = line.match(/case\s+"(CAREOS_[A-Z0-9_]+)":/);
    if (caseMatch) {
      pending.push(caseMatch[1]);
      continue;
    }
    if (/^\s*default:/.test(line)) {
      inDefault = true;
      continue;
    }
    const returnMatch = line.match(/return\s+"([a-zA-Z0-9._]+)";/);
    if (!returnMatch) continue;
    if (inDefault) {
      fallback = returnMatch[1];
      inDefault = false;
    } else {
      for (const code of pending) table.set(code, returnMatch[1]);
      pending = [];
    }
  }

  if (!fallback) throw new Error("the mapping has no default branch");
  return { table, fallback };
}

const { table: UI_TABLE, fallback: UI_FALLBACK } = switchTable(MAP_BLOCK);

/** The shipped behaviour, assembled from the shipped parts. */
function messageKeyFor(raw: string | undefined): string {
  const code = raw?.match(MESSAGE_REGEX)?.[0];
  return (code && UI_TABLE.get(code)) || UI_FALLBACK;
}

/* ── 1 · Parity with the database ──────────────────────────────────────────── */

describe("every refusal the clock RPCs can raise has words to go with it", () => {
  it("found the raises it expects to find (the parser still understands the migration)", () => {
    // A guard on the guard: if a migration is reformatted past recognition this test
    // would quietly assert nothing at all.
    expect(DB_CODES.length).toBeGreaterThanOrEqual(8);
    expect(DB_CODES).toContain("CAREOS_AAL2_REQUIRED");
    expect(DB_CODES).toContain("CAREOS_GEOFENCE_UNVERIFIED");
  });

  it("maps every code app.clock_visit / app.request_location_exception can raise", () => {
    const unmapped = DB_CODES.filter((c) => !UI_TABLE.has(c));
    expect(unmapped, "database codes with no caregiver sentence in today/actions.ts").toEqual([]);
  });

  it("maps nothing the clock path cannot actually raise", () => {
    // Drift the other way: a case for a code no longer raised is dead copy that will be
    // maintained forever by people who assume it is live.
    const orphaned = [...UI_TABLE.keys()].filter((c) => !DB_CODES.includes(c)).sort();
    expect(orphaned, "cases in today/actions.ts for codes the clock RPCs never raise").toEqual([]);
  });

  it("treats as terminal only codes the database actually raises", () => {
    // TERMINAL_CODES decides whether a queued offline capture may be forgotten. A code in
    // that set that the database never emits is harmless; a code that can never be
    // MATCHED because extraction truncates it is a shift that replays forever.
    const terminalBlock = ACTIONS.slice(ACTIONS.indexOf("const TERMINAL_CODES"));
    const terminal = [...terminalBlock.slice(0, terminalBlock.indexOf("]")).matchAll(/"(CAREOS_[A-Z0-9_]+)"/g)].map(
      (m) => m[1]
    );
    expect(terminal.length).toBeGreaterThan(0);
    expect(terminal.filter((c) => !DB_CODES.includes(c))).toEqual([]);
  });
});

/* ── 2 · The code must survive extraction ──────────────────────────────────── */

describe("code extraction round-trips the real message text", () => {
  it.each(DB_RAISES.map((r) => [r.code, r.message] as const))(
    "%s is extracted whole from its own raise message",
    (code, message) => {
      expect(message.match(MESSAGE_REGEX)?.[0]).toBe(code);
      expect(message.match(CODE_OF_REGEX)?.[0]).toBe(code);
    }
  );

  it("reaches a specific sentence — never the generic one — for every raisable code", () => {
    const generic = DB_RAISES.filter((r) => messageKeyFor(r.message) === UI_FALLBACK).map(
      (r) => r.code
    );
    expect(
      [...new Set(generic)],
      "codes the database explains but the caregiver is told nothing specific about"
    ).toEqual([]);
  });
});

/* ── 3 · Distinct, translated, human sentences ─────────────────────────────── */

describe("the sentences themselves", () => {
  it("every mapped key exists in both dictionaries", () => {
    const keys = [...new Set([...UI_TABLE.values(), UI_FALLBACK])];
    for (const key of keys) {
      expect(en, `en is missing ${key}`).toHaveProperty(key);
      expect(es, `es is missing ${key}`).toHaveProperty(key);
    }
  });

  it("shares one sentence between two codes only for malformed-request codes", () => {
    const byKey = new Map<string, string[]>();
    for (const [code, key] of UI_TABLE) {
      byKey.set(key, [...(byKey.get(key) ?? []), code]);
    }
    for (const [key, codes] of byKey) {
      if (codes.length === 1) continue;
      // "That request was not well formed" is one honest sentence; "you are not assigned
      // to this visit" and "you are already clocked in" are not interchangeable.
      expect(
        codes.every((c) => c.startsWith("CAREOS_BAD_")),
        `${key} is shared by codes that do not describe the same situation: ${codes.join(", ")}`
      ).toBe(true);
    }
  });

  it("never routes a known code to the generic fallback key", () => {
    expect([...UI_TABLE.values()]).not.toContain(UI_FALLBACK);
  });

  it("speaks plain language — no CAREOS code, no SQL, no jargon reaches a caregiver", () => {
    const forbidden = /CAREOS_|postgres|sqlstate|constraint|rpc\b|null\b|undefined/i;
    for (const key of [...UI_TABLE.values(), UI_FALLBACK]) {
      expect(en[key as keyof typeof en]).not.toMatch(forbidden);
      expect(es[key as keyof typeof es]).not.toMatch(forbidden);
    }
  });
});

/* ── 4 · An unknown failure leaks nothing ──────────────────────────────────── */

describe("an unrecognised failure", () => {
  const RAW_POSTGRES = [
    'duplicate key value violates unique constraint "visit_event_client_event_uk"',
    'new row for relation "visit" violates check constraint "visit_status_ck"',
    "canceling statement due to statement timeout",
    'permission denied for table "client"',
    "",
  ];

  it.each(RAW_POSTGRES)("falls back to the generic sentence for: %s", (raw) => {
    expect(messageKeyFor(raw)).toBe(UI_FALLBACK);
  });

  it("falls back when the failure has no message at all", () => {
    expect(messageKeyFor(undefined)).toBe(UI_FALLBACK);
  });

  it("does not echo any fragment of the raw message back to the caregiver", () => {
    const sentence = en[UI_FALLBACK as keyof typeof en];
    for (const raw of RAW_POSTGRES.filter(Boolean)) {
      for (const word of raw.split(/\W+/).filter((w) => w.length > 6)) {
        expect(sentence.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it("still tells the caregiver that nothing was recorded", () => {
    // docs/10 voice: what happened · what is kept · what to do next. "Something went
    // wrong" alone leaves a person wondering whether they are clocked in.
    expect(en[UI_FALLBACK as keyof typeof en].toLowerCase()).toContain("nothing was recorded");
    expect(es[UI_FALLBACK as keyof typeof es].toLowerCase()).toContain("no se registró nada");
  });
});
