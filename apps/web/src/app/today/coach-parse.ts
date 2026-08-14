/**
 * The note coach's contract, and the parser that refuses to trust it (ST-235, W3).
 *
 * WHY THIS IS A SEPARATE MODULE. `coach-actions.ts` carries `"use server"`, and such a
 * module may export only async functions — a pure parser cannot live there, and neither
 * can the types the client component needs. Keeping them here also means the guardrail
 * can be tested directly (coach-parse.test.ts) rather than through a network round-trip.
 *
 * THE GUARDRAIL, AND WHY IT IS STRUCTURAL. Migration 0057 registers `note.quality_coach`
 * with a strict contract: {"suggestions":[{kind,quote,prompt}]}, where `quote` is copied
 * verbatim out of the note. A model that paraphrases the note — or invents a fragment
 * that was never written — would be putting words in a caregiver's mouth on a clinical
 * record's doorstep. So a quote that is not a literal substring of the note the model was
 * given is DROPPED here, not flagged, not fixed up. The same is true of an unknown kind,
 * an empty prompt, or a suggestion that characterises the writer instead of the writing
 * (the registered prompt's rule 5; this is what runs when a prompt is ignored).
 *
 * AND WHY IT NEVER THROWS. Coaching is advisory. A malformed completion, an empty body,
 * a fence-wrapped blob — every one of them ends the same way: no suggestions, and a note
 * that is entirely unaffected. The coach failing must never cost a caregiver their note.
 *
 * @trace ST-235, docs/designs/intelligent-front-door.md W3, migration 0057, invariant 8
 */

/** The registry key (migration 0057) and the flag that decides whether any of this renders. */
export const COACH_CAPABILITY = "note.quality_coach";
export const COACH_FLAG = "front_door.note_coach";

/** The three critique kinds the registered prompt may return, and nothing else. */
export type CoachKind = "insufficient_detail" | "goal_linkage" | "vague_language";

export const COACH_KINDS: readonly CoachKind[] = [
  "insufficient_detail",
  "goal_linkage",
  "vague_language",
];

/**
 * The kind, in words. D-012 in its wider sense: a category is never carried by a colour,
 * an icon or a raw enum — a caregiver reads what the coach means, in plain language.
 */
export const COACH_KIND_LABEL: Record<CoachKind, string> = {
  insufficient_detail: "More detail would help",
  goal_linkage: "Could connect to a care-plan goal",
  vague_language: "Reads as an impression, not an observation",
};

export type CoachSuggestion = { kind: CoachKind; quote: string; prompt: string };

/**
 * What the surface renders, one state each (the four-state doctrine, docs/10):
 *   ok          · suggestions rendered, or the "this reads well" empty state when none
 *   no_note     · nothing to coach yet — the caregiver hasn't written enough
 *   unavailable · switched off, over budget, provider down, or an unparseable answer
 *   off         · the feature flag is off for this agency; the surface renders nothing
 */
export type CoachStatus = "ok" | "no_note" | "unavailable" | "off";

export type CoachResult = {
  status: CoachStatus;
  /** Always present, always safe to render. Empty on every failure path. */
  suggestions: CoachSuggestion[];
  /** Suggestions a guardrail discarded. Reported to the reader, never hidden. */
  dropped: number;
};

export type CoachParse = {
  /** false = the completion was not the contracted JSON at all (→ "unavailable"). */
  parsed: boolean;
  suggestions: CoachSuggestion[];
  dropped: number;
};

/** The registered prompt caps this at three; the parser enforces it rather than hoping. */
const MAX_SUGGESTIONS = 3;
/** A "fragment" longer than this is not a fragment — it is the note handed back. */
const MAX_QUOTE_CHARS = 400;
const MAX_PROMPT_CHARS = 400;

/**
 * Rule 5 of the registered prompt, made mechanical: coach the note, never the writer.
 * Deliberately narrow — praise and character words only. A false positive costs one
 * suggestion; a false negative puts a machine's verdict on a person in front of them.
 */
const CHARACTERISES_THE_WRITER =
  /\b(lazy|careless|sloppy|negligent|unprofessional|incompetent|dishonest|rude|great job|good job|nice work|well done|excellent work|poor effort)\b/i;

function cleanString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

function isKind(v: unknown): v is CoachKind {
  return typeof v === "string" && (COACH_KINDS as readonly string[]).includes(v);
}

/**
 * Parse one completion against the note it was given.
 *
 * `note` MUST be the exact string sent to the model — the verbatim check is only
 * meaningful against what the model actually saw.
 */
export function parseCoachSuggestions(raw: string | null, note: string): CoachParse {
  const text = (raw ?? "").trim();
  if (!text.startsWith("{")) return { parsed: false, suggestions: [], dropped: 0 };

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { parsed: false, suggestions: [], dropped: 0 };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { parsed: false, suggestions: [], dropped: 0 };
  }

  const list = (obj as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return { parsed: false, suggestions: [], dropped: 0 };

  const suggestions: CoachSuggestion[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of list) {
    if (suggestions.length >= MAX_SUGGESTIONS) {
      dropped += 1;
      continue;
    }
    const e = entry as { kind?: unknown; quote?: unknown; prompt?: unknown };
    const kind = isKind(e.kind) ? e.kind : null;
    const quote = cleanString(e.quote, MAX_QUOTE_CHARS);
    const prompt = cleanString(e.prompt, MAX_PROMPT_CHARS);

    if (!kind || !quote || !prompt) {
      dropped += 1;
      continue;
    }
    // The whole guardrail in one line: the fragment must be the caregiver's own words.
    if (!note.includes(quote)) {
      dropped += 1;
      continue;
    }
    if (CHARACTERISES_THE_WRITER.test(prompt)) {
      dropped += 1;
      continue;
    }
    const key = `${kind}|${quote}`;
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    suggestions.push({ kind, quote, prompt });
  }

  return { parsed: true, suggestions, dropped };
}
