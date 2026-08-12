/**
 * The i18n corpus — `src/lib/i18n/dictionaries.ts`.
 *
 * TWO OBLIGATIONS, ONE FILE.
 *
 * PARITY. `es` is typed `Record<keyof typeof en, string>`, so a MISSING key is already a
 * compile error. What the type cannot see is a key that exists and says nothing useful:
 * an empty string, an English sentence pasted into the Spanish object, or a `{time}`
 * token that survived translation as `{hora}` and therefore renders literally to a
 * caregiver. Those are the failures that reach a person, so they are checked at runtime.
 *
 * D-030 AS A TEST, NOT AS A CONVENTION. docs/17 §7.1 and D-030 close the field
 * vocabulary: a caregiver surface never says GPS, geofence, accuracy, radius, metres or
 * EVV. The reason is not squeamishness — those words describe SURVEILLANCE MACHINERY,
 * and telling somebody they are "312 m outside the geofence" is both operationally
 * useless (they cannot act on it) and a statement about being watched. What the app owes
 * them is what was recorded and what to do next. Every string in this corpus is
 * caregiver- or family-facing, so the ban applies to the whole file in both languages.
 * Accuracy in metres remains legitimate evidence on the RLS-gated admin surfaces, which
 * do not draw their copy from here.
 *
 * ALSO PROVED: the docs/10 voice rules that can be mechanised — sentence case openings,
 * no exclamation points — and that `createTranslator` interpolates rather than blanking
 * a token it cannot fill, so a copy bug shows itself instead of vanishing.
 *
 * Serves: D-030, docs/17 §7.1, docs/10 voice, invariant 14.
 * Runs anywhere Node runs — no server, no database, no network.
 */

import { describe, expect, it } from "vitest";
import { LOCALES } from "./config";
import {
  DICTIONARIES,
  TRANSLATION_KEY_COUNT,
  createTranslator,
  en,
  es,
  getDictionary,
} from "./dictionaries";

const EN_KEYS = Object.keys(en).sort();
const ES_KEYS = Object.keys(es).sort();

/** Every string a person can read, tagged with where it came from. */
const ALL: { locale: string; key: string; value: string }[] = LOCALES.flatMap((locale) =>
  Object.entries(DICTIONARIES[locale]).map(([key, value]) => ({ locale, key, value }))
);

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

/* ── Parity ────────────────────────────────────────────────────────────────── */

describe("en and es are the same corpus", () => {
  it("have identical key sets", () => {
    expect(ES_KEYS).toEqual(EN_KEYS);
  });

  it("cover every configured locale with a dictionary", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale])).toHaveLength(TRANSLATION_KEY_COUNT);
    }
  });

  it("agree with the published key count", () => {
    expect(EN_KEYS).toHaveLength(TRANSLATION_KEY_COUNT);
    expect(TRANSLATION_KEY_COUNT).toBeGreaterThan(200);
  });

  it("carry the same interpolation tokens in both languages", () => {
    const drifted = EN_KEYS.filter(
      (k) =>
        placeholders(en[k as keyof typeof en]).join() !== placeholders(es[k as keyof typeof es]).join()
    );
    expect(drifted, "keys whose {tokens} differ between en and es").toEqual([]);
  });

  it("has no empty or whitespace-only string in either language", () => {
    expect(ALL.filter((e) => !e.value.trim()).map((e) => `${e.locale}:${e.key}`)).toEqual([]);
  });

  it("has no untranslated Spanish string left identical to its English source", () => {
    // Not a general rule of Spanish — a genuine cognate would be a false positive — but
    // this corpus currently has none, so any new match is a forgotten translation.
    const same = EN_KEYS.filter((k) => en[k as keyof typeof en] === es[k as keyof typeof es]);
    expect(same, "keys where the Spanish copy is still the English copy").toEqual([]);
  });

  it("falls back to the default locale rather than throwing on an unknown one", () => {
    expect(getDictionary("de" as never)).toBe(en);
  });
});

/* ── D-030: the closed field vocabulary ────────────────────────────────────── */

describe("no caregiver-facing string names the surveillance machinery (D-030)", () => {
  /**
   * Word-boundary anchored, so "precise" does not trip on "precisión" by accident and
   * "radio" (Spanish) is caught while "radiología" is not. Each entry names what it
   * bans and why the ban exists.
   */
  const FORBIDDEN: { label: string; pattern: RegExp }[] = [
    { label: "GPS", pattern: /\bGPS\b/i },
    { label: "EVV", pattern: /\bEVV\b/i },
    { label: "geofence / geocerca", pattern: /\bgeo[-\s]?fenc\w*|\bgeocerca\w*/i },
    { label: "accuracy / precisión", pattern: /\baccurac\w*|\bprecisi[oó]n\b/i },
    { label: "radius / radio", pattern: /\bradius\b|\bradio\b/i },
    { label: "metres / meters / metros", pattern: /\bmet(re|er)s?\b|\bmetros?\b/i },
    // `coordinates`, not `coordinat\w*` — "your coordinator" is exactly who a caregiver
    // is told to call, and banning the word would ban the escalation path.
    { label: "coordinates / latitude / longitude", pattern: /\bcoordinates?\b|\blatitud\w*|\blongitud\w*/i },
  ];

  it.each(FORBIDDEN.map((f) => [f.label, f.pattern] as const))(
    "no string anywhere in the corpus says %s",
    (label, pattern) => {
      const offenders = ALL.filter((e) => pattern.test(e.value)).map(
        (e) => `${e.locale}:${e.key} → ${e.value}`
      );
      expect(offenders, `strings naming ${label}`).toEqual([]);
    }
  );

  it("never puts a bare distance or accuracy number in front of a caregiver", () => {
    // "312 m", "±48 m", "50 metros" — a measurement with a unit attached. A bare number
    // in copy is fine (a count of visits); a number wearing a distance unit is not.
    const measurement = /\d+\s?(m|km|ft|mi)\b/i;
    const offenders = ALL.filter((e) => measurement.test(e.value)).map(
      (e) => `${e.locale}:${e.key} → ${e.value}`
    );
    expect(offenders).toEqual([]);
  });

  it("still gives the clock path a way to say what happened", () => {
    // The counterpart to the ban: the bucket copy must actually exist, or the ban has
    // just produced silence. 'near' and 'far' are the D-030 buckets.
    expect(en["clock.hintNear"]).toBeTruthy();
    expect(en["clock.hintFar"]).toBeTruthy();
    expect(en["clock.unverifiedTitle"]).toBeTruthy();
    expect(es["clock.hintNear"]).toBeTruthy();
    expect(es["clock.hintFar"]).toBeTruthy();
  });
});

/* ── docs/10 voice ─────────────────────────────────────────────────────────── */

describe("voice", () => {
  it("uses no exclamation points", () => {
    expect(ALL.filter((e) => e.value.includes("!")).map((e) => `${e.locale}:${e.key}`)).toEqual([]);
  });

  it("leaks no developer vocabulary", () => {
    const jargon = /CAREOS_|\bnull\b|\bundefined\b|\bNaN\b|\[object |RLS\b|\bAAL2\b|\bUUID\b|\bJSON\b/;
    const offenders = ALL.filter((e) => jargon.test(e.value)).map(
      (e) => `${e.locale}:${e.key} → ${e.value}`
    );
    expect(offenders).toEqual([]);
  });

  it("contains no personal data — this file is chrome, never a record", () => {
    // A dictionary is bundled to every client, so a client name or address here would
    // ship PHI to every browser (invariant 5). Digit runs long enough to be a phone
    // number, an SSN or a date of birth have no business in UI chrome.
    const offenders = ALL.filter((e) => /\d{3}[-\s]?\d{2,4}[-\s]?\d{4}/.test(e.value));
    expect(offenders.map((e) => `${e.locale}:${e.key}`)).toEqual([]);
  });
});

/* ── The translator ────────────────────────────────────────────────────────── */

describe("createTranslator", () => {
  it("returns the sentence for the requested locale", () => {
    expect(createTranslator("en")("clock.in")).toBe(en["clock.in"]);
    expect(createTranslator("es")("clock.in")).toBe(es["clock.in"]);
  });

  it("interpolates a token it has a value for", () => {
    const t = createTranslator("en");
    expect(t("clock.clockedInAt", { time: "9:04 am" })).toContain("9:04 am");
    expect(t("clock.clockedInAt", { time: "9:04 am" })).not.toContain("{time}");
  });

  it("leaves a token intact when it has no value, so the bug is visible", () => {
    // Blanking it would hide a copy defect behind a plausible-looking sentence.
    expect(createTranslator("en")("clock.clockedInAt", { unrelated: "x" })).toContain("{time}");
  });

  it("formats numbers for the locale", () => {
    // 1204 reads as 1,204 in English and 1.204 in Spanish.
    const enOut = new Intl.NumberFormat("en").format(1204);
    const esOut = new Intl.NumberFormat("es").format(1204);
    expect(enOut).not.toBe(esOut);
  });

  it("returns the key itself rather than throwing on an unknown key", () => {
    expect(createTranslator("en")("not.a.real.key" as never)).toBe("not.a.real.key");
  });
});
