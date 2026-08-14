/**
 * The note coach's guardrail, tested where it can actually be proven (ST-235, W3).
 *
 * WHAT THIS PROVES, AND WHY IT MATTERS MORE THAN THE PROMPT DOES. Migration 0057 tells
 * `note.quality_coach` to quote the caregiver's note verbatim, to use one of three kinds,
 * to stop at three suggestions, and never to characterise the writer. A prompt is an
 * instruction; this parser is the enforcement, and these cases are the difference between
 * the two. Every property below is a thing a model can get wrong on a real shift:
 *
 *   1. A PARAPHRASED OR INVENTED QUOTE IS DROPPED. The single most damaging failure mode
 *      is a coaching card that shows a caregiver "their words" that they never wrote — on
 *      the doorstep of a clinical record, on a screen they trust. Verbatim or nothing.
 *   2. A MALFORMED ANSWER IS NOT A CRASH AND NOT A LIE. Prose, fences, an array, an empty
 *      body: every one yields `parsed: false`, which the surface renders as "coaching is
 *      unavailable", never as "your note reads well".
 *   3. THE CONTRACT IS ENFORCED, NOT ASSUMED — unknown kinds, empty prompts, duplicates
 *      and a fourth suggestion are dropped and COUNTED, because a suggestion silently
 *      discarded is a guardrail nobody can audit.
 *   4. COACH THE NOTE, NOT THE WRITER (registered prompt rule 5). Praise and character
 *      judgements about the person are dropped even when they quote the note correctly.
 *
 * Runs anywhere Node runs: a pure function, no server, no database, no network.
 */

import { describe, expect, it } from "vitest";
import { COACH_KIND_LABEL, COACH_KINDS, parseCoachSuggestions } from "./coach-parse";

const NOTE =
  "Arrived at 9am. Helped with a shower and got her dressed. She seemed fine. " +
  "Walked to the kitchen with the walker and made oatmeal. Left at 11am.";

function completion(suggestions: unknown[]): string {
  return JSON.stringify({ suggestions });
}

describe("parseCoachSuggestions · the verbatim guarantee", () => {
  it("keeps a suggestion whose quote is a literal fragment of the note", () => {
    const out = parseCoachSuggestions(
      completion([
        {
          kind: "vague_language",
          quote: "She seemed fine.",
          prompt: "What did you see that told you she was doing well?",
        },
      ]),
      NOTE
    );

    expect(out.parsed).toBe(true);
    expect(out.dropped).toBe(0);
    expect(out.suggestions).toEqual([
      {
        kind: "vague_language",
        quote: "She seemed fine.",
        prompt: "What did you see that told you she was doing well?",
      },
    ]);
  });

  it("drops a paraphrased quote — the caregiver never wrote those words", () => {
    const out = parseCoachSuggestions(
      completion([
        {
          kind: "vague_language",
          // Close enough to look right on screen, and not in the note.
          quote: "she appeared fine",
          prompt: "What did you observe?",
        },
      ]),
      NOTE
    );

    expect(out.parsed).toBe(true);
    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it("drops an invented quote about an event the note does not contain", () => {
    const out = parseCoachSuggestions(
      completion([
        {
          kind: "insufficient_detail",
          quote: "Blood pressure was 150/90",
          prompt: "Was this reported?",
        },
      ]),
      NOTE
    );

    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });
});

describe("parseCoachSuggestions · malformed answers never become claims", () => {
  it.each([
    ["prose instead of JSON", "Here are some thoughts about the note."],
    ["a fenced blob", '```json\n{"suggestions": []}\n```'],
    ["an array at the top level", '[{"kind":"vague_language"}]'],
    ["an empty body", ""],
    ["null", null],
    ["truncated JSON", '{"suggestions": [{"kind": "vague_lan'],
    ["the right shape with the wrong key", '{"items": []}'],
  ])("reports %s as unparsed rather than as an empty critique", (_label, raw) => {
    const out = parseCoachSuggestions(raw as string | null, NOTE);
    expect(out.parsed).toBe(false);
    expect(out.suggestions).toHaveLength(0);
  });

  it("distinguishes an honest empty answer from an unreadable one", () => {
    const out = parseCoachSuggestions(completion([]), NOTE);
    expect(out.parsed).toBe(true);
    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toBe(0);
  });
});

describe("parseCoachSuggestions · the contract is enforced, not assumed", () => {
  it("drops an unknown kind", () => {
    const out = parseCoachSuggestions(
      completion([
        { kind: "tone_problem", quote: "She seemed fine.", prompt: "Reword this?" },
        { kind: "vague_language", quote: "She seemed fine.", prompt: "What did you see?" },
      ]),
      NOTE
    );

    expect(out.suggestions.map((s) => s.kind)).toEqual(["vague_language"]);
    expect(out.dropped).toBe(1);
  });

  it("drops entries missing a quote or a prompt", () => {
    const out = parseCoachSuggestions(
      completion([
        { kind: "vague_language", quote: "", prompt: "What did you see?" },
        { kind: "vague_language", quote: "She seemed fine.", prompt: "   " },
        { kind: "goal_linkage", quote: "made oatmeal" },
      ]),
      NOTE
    );

    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toBe(3);
  });

  it("keeps at most three suggestions and counts the rest", () => {
    const out = parseCoachSuggestions(
      completion([
        { kind: "vague_language", quote: "She seemed fine.", prompt: "What did you see?" },
        { kind: "goal_linkage", quote: "made oatmeal", prompt: "Which goal does this meet?" },
        { kind: "insufficient_detail", quote: "Helped with a shower", prompt: "How much help?" },
        { kind: "insufficient_detail", quote: "Left at 11am.", prompt: "Anything at the end?" },
      ]),
      NOTE
    );

    expect(out.suggestions).toHaveLength(3);
    expect(out.dropped).toBe(1);
  });

  it("drops a repeat of the same critique on the same fragment", () => {
    const out = parseCoachSuggestions(
      completion([
        { kind: "vague_language", quote: "She seemed fine.", prompt: "What did you see?" },
        { kind: "vague_language", quote: "She seemed fine.", prompt: "Say more here." },
      ]),
      NOTE
    );

    expect(out.suggestions).toHaveLength(1);
    expect(out.dropped).toBe(1);
  });

  it("drops a quote long enough to be the note handed back rather than a fragment", () => {
    const long = "x".repeat(500);
    const out = parseCoachSuggestions(
      completion([{ kind: "insufficient_detail", quote: long, prompt: "Add detail." }]),
      `${NOTE} ${long}`
    );

    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });
});

describe("parseCoachSuggestions · coach the note, not the writer", () => {
  it.each([
    "Good job on this note, but what did you see?",
    "This is a sloppy entry — what did you observe?",
  ])("drops a prompt that judges the person: %s", (prompt) => {
    const out = parseCoachSuggestions(
      completion([{ kind: "vague_language", quote: "She seemed fine.", prompt }]),
      NOTE
    );

    expect(out.suggestions).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });
});

describe("the vocabulary the surface renders", () => {
  it("gives every kind a plain-language label — no enum ever reaches a caregiver", () => {
    for (const kind of COACH_KINDS) {
      const label = COACH_KIND_LABEL[kind];
      expect(label, `${kind} needs words a caregiver can read`).toBeTruthy();
      expect(label).not.toMatch(/_/);
    }
  });
});
