/**
 * Every surface that turns a CAREOS_* refusal into a sentence — repo-wide.
 *
 * ONE CHARACTER CLASS, EIGHT SURFACES. The web app reads a refusal code out of a raw
 * Postgres message with a regex, then switches on it. A regex whose character class
 * cannot express a digit truncates `CAREOS_AAL2_REQUIRED` to `CAREOS_AAL`: the switch
 * case for it becomes unreachable dead code, the default branch fires, and a person who
 * needs to be told "unlock with your authenticator" is told "something went wrong" and
 * retries into the same wall. The failure is invisible in review — the case is right
 * there in the file — and invisible in typecheck, because a string literal that never
 * matches is not a type error. Only a test that runs the real regex against the real
 * message text finds it.
 *
 * So this file is deliberately global rather than per-surface: it discovers every
 * extraction regex in `src/**`, and drives each one against every `CAREOS_*` code that
 * appears anywhere in `supabase/migrations/**`. A new surface written by copying an old
 * one inherits the check for free, and a new database code with a digit in it is caught
 * the day it lands.
 *
 * ALSO PROVED: no mapping's default branch echoes the raw database message back to a
 * screen. A raw message can name a table, a constraint or a row value (invariant 5), and
 * "no PHI in error messages" is a property of the code path, not of good intentions.
 *
 * Serves: docs/08 §2 (CAREOS_* error contract), docs/10 voice, invariants 5 and 14.
 * Runs anywhere Node runs — reads files off disk; no server, no database, no network.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = join(REPO, "apps/web/src");
const MIGRATIONS = join(REPO, "supabase/migrations");

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every code name the database ever writes into a message, from every migration. */
const DB_CODES = (() => {
  const codes = new Set<string>();
  for (const file of walk(MIGRATIONS, /\.sql$/)) {
    for (const m of readFileSync(file, "utf8").matchAll(/'(CAREOS_[A-Z0-9_]+)/g)) codes.add(m[1]);
  }
  return [...codes].sort();
})();

type Surface = {
  /** Repo-relative, so a failure names the file a human has to open. */
  path: string;
  source: string;
  regexes: {
    literal: string;
    regex: RegExp;
    /** The `[…]` the code name is matched with, or null if the shape is unrecognised. */
    charClass: string | null;
    /** True when the regex extracts the code alone, false when it also reads a payload. */
    bare: boolean;
  }[];
  cases: string[];
};

const SURFACES: Surface[] = walk(SRC, /\.tsx?$/)
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .map((file) => {
    const source = readFileSync(file, "utf8");
    const regexes = [...source.matchAll(/\.match\((\/CAREOS_[^/]*\/[gimsuy]*)\)/g)].map((m) => {
      const literal = m[1];
      const lastSlash = literal.lastIndexOf("/");
      const body = literal.slice(1, lastSlash);
      const flags = literal.slice(lastSlash + 1);
      // Two kinds exist. A BARE extractor (`/CAREOS_[A-Z0-9_]+/`) returns the code itself.
      // A PAYLOAD extractor (`/CAREOS_[A-Z0-9_]+:\s*(\d+)/`) reads an argument out of the
      // message and returns something else entirely. Both hang off the same character
      // class, and both break the same way when that class cannot express a code — so the
      // class is checked for every regex and the round-trip only for the bare ones.
      const charClass = body.match(/^CAREOS_\[([^\]]*)\]\+/)?.[1] ?? null;
      return {
        literal,
        regex: new RegExp(body, flags),
        charClass,
        bare: /^CAREOS_\[[^\]]*\]\+$/.test(body),
      };
    });
    return {
      path: file.slice(REPO.length),
      source,
      regexes,
      cases: [...new Set([...source.matchAll(/case\s+"(CAREOS_[A-Z0-9_]+)":/g)].map((m) => m[1]))],
    };
  })
  .filter((s) => s.regexes.length > 0);

describe("the discovery itself", () => {
  it("found the migrations' code vocabulary", () => {
    expect(DB_CODES.length).toBeGreaterThan(10);
    // The code that breaks a naive character class. If it ever leaves the schema this
    // whole file loses its teeth, so its absence should be loud.
    expect(DB_CODES).toContain("CAREOS_AAL2_REQUIRED");
  });

  it("found the surfaces that translate refusals", () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the character class can express every code the database raises", () => {
  it.each(SURFACES.map((s) => [s.path, s] as const))("%s", (_path, surface) => {
    const broken: string[] = [];
    for (const { literal, charClass } of surface.regexes) {
      expect(charClass, `${surface.path}: unreadable regex shape ${literal}`).not.toBeNull();
      const accepts = new RegExp(`^[${charClass}]+$`);
      for (const code of DB_CODES) {
        if (!accepts.test(code.slice("CAREOS_".length))) {
          broken.push(`${literal} cannot express ${code}`);
        }
      }
    }
    expect(broken, `character class is too narrow in ${surface.path}`).toEqual([]);
  });
});

describe("a bare extractor returns the whole code, not a prefix", () => {
  it.each(SURFACES.filter((s) => s.regexes.some((r) => r.bare)).map((s) => [s.path, s] as const))(
    "%s",
    (_path, surface) => {
      const broken: string[] = [];
      for (const { literal, regex, bare } of surface.regexes) {
        if (!bare) continue;
        for (const code of DB_CODES) {
          // The shape a caller actually receives: `CODE: human detail`.
          const extracted = `${code}: a detail the database added`.match(regex)?.[0];
          if (extracted !== code) broken.push(`${literal} turns ${code} into ${extracted}`);
        }
      }
      expect(broken, `truncating extraction in ${surface.path}`).toEqual([]);
    }
  );
});

describe("every switch case is reachable", () => {
  it.each(SURFACES.filter((s) => s.cases.length > 0).map((s) => [s.path, s] as const))(
    "%s",
    (_path, surface) => {
      const unreachable: string[] = [];
      for (const code of surface.cases) {
        const reachable = surface.regexes.some(
          ({ regex }) => `${code}: a detail`.match(regex)?.[0] === code
        );
        if (!reachable) unreachable.push(code);
      }
      expect(
        unreachable,
        `dead switch cases in ${surface.path} — the copy exists but no failure can reach it`
      ).toEqual([]);
    }
  );
});

describe("a raw database message is never echoed to a screen", () => {
  /**
   * KNOWN-VIOLATION LEDGER — now EMPTY, and it must stay that way.
   *
   * It was opened with one entry: `accept-client.tsx`, the unauthenticated
   * invitation-acceptance surface, whose default branch returned `raw ?? "…"` and so
   * could render a Postgres message naming a table, a constraint or a row value into a
   * browser BEFORE the visitor is authenticated (invariant 5). That was struck off by
   * replacing the echo with a written sentence, which is why this list is now empty.
   *
   * A ledger that empties is the goal; a ledger that grows is a regression. Adding an
   * entry here is a deliberate act that a reviewer will see in the diff — which is the
   * point. It is not an exemption mechanism.
   */
  const KNOWN: string[] = [];

  const ECHOES = /default:\s*(?:\r?\n\s*)?return\s+raw\b/;

  it("no new surface starts echoing, and a fixed one is struck off the ledger", () => {
    const echoing = SURFACES.filter((s) => ECHOES.test(s.source))
      .map((s) => s.path)
      .sort();
    expect(echoing).toEqual([...KNOWN].sort());
  });

  it("every other surface answers an unknown failure with a written sentence", () => {
    for (const surface of SURFACES) {
      if (KNOWN.includes(surface.path)) continue;
      if (!/default:/.test(surface.source)) continue;
      // The default arm returns either a literal sentence or a TranslationKey — in both
      // cases a quoted string authored by a person, never a value from the wire.
      const defaults = [...surface.source.matchAll(/default:\s*(?:\r?\n\s*)?return\s+([^;]+);/g)];
      for (const [, expression] of defaults) {
        expect(
          expression.trim().startsWith('"') || expression.trim().startsWith("{"),
          `${surface.path} returns a non-literal from a default branch: ${expression.trim().slice(0, 60)}`
        ).toBe(true);
      }
    }
  });
});
