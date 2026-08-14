/**
 * THE GATES on the NL scheduling pipeline — `src/lib/ai/schedule-command.ts` (ST-233).
 *
 * WHAT IS BEING DEFENDED. This pipeline turns a sentence into a parameter set for a
 * Lane-B RPC. Three properties stand between "a coordinator typed something" and "a real
 * visit was drafted against real people", and all three are decisions made in code that a
 * model cannot argue with:
 *
 *   1. THE ALLOWLIST IS THE DATABASE'S, NOT THE CODE'S. `actionAllowlist` reads
 *      `ai_capability.config` (migration 0055) and returns nothing when the column, the
 *      row, the object or the keys are absent. An empty allowlist drafts nothing — the
 *      structural close on the "tier laundering" finding: a capability cannot acquire the
 *      right to act by falling back to a default, because there is no default to fall to.
 *   2. EVERY ID CAME FROM THIS REQUEST'S OWN RLS-SCOPED READS. The parser accepts an id
 *      only if it is in the context assembled moments earlier. That is what makes a
 *      hallucinated uuid, a uuid pasted into the utterance, and a uuid planted by a prompt
 *      injection in a stored name all fail the same way — as a clarification, never as a
 *      parameter.
 *   3. NOTHING IS INVENTED, INCLUDING TIME. A duration nobody stated is a question, not a
 *      default (invariant 13). And "8am" means 8am in Maryland — a naive timestamp read in
 *      the serverless region's UTC would move every visit in the agency by an hour or
 *      four, on both sides of a DST boundary.
 *
 * HOW IT TESTS. Against the REAL exported functions, with the model's output as the only
 * input — exactly the position the pipeline is in when a completion comes back. No
 * database, no network, no model, no server.
 *
 * Serves: docs/designs/intelligent-front-door.md W2, D-021, invariants 5, 8, 13.
 */

import { describe, expect, it } from "vitest";
import {
  isEntityRef,
  parseAgencyDateTime,
  parseScheduleDraft,
  type DraftContext,
} from "./schedule-command";
import { actionAllowlist, type CapabilityEntry } from "./registry";

/* ── Fixtures ─────────────────────────────────────────────────────────────────
 * Real-shaped uuids, because the parser's id check is the thing under test and a
 * fixture using "cl-101" would let a broken check pass by accident.
 * ────────────────────────────────────────────────────────────────────────── */

const CLIENT_DORIS = "11111111-1111-4111-8111-111111111111";
const CLIENT_HAROLD = "22222222-2222-4222-8222-222222222222";
const CAREGIVER_SAM = "33333333-3333-4333-8333-333333333333";
/** A well-formed uuid that is NOT in the context — the shape a leak actually takes. */
const OFF_CONTEXT = "99999999-9999-4999-8999-999999999999";

const CONTEXT: DraftContext = {
  clients: [
    { type: "client", id: CLIENT_DORIS, label: "Doris Fenwick" },
    { type: "client", id: CLIENT_HAROLD, label: "Harold Bramble" },
  ],
  caregivers: [{ type: "caregiver", id: CAREGIVER_SAM, label: "Sam Okafor" }],
};

const ALLOWLIST = ["app.schedule_visit", "app.assign_visit"];

function completion(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "app.assign_visit",
    params: {
      client_id: CLIENT_DORIS,
      caregiver_id: CAREGIVER_SAM,
      visit_start: "2026-08-14T08:00:00",
      ...(overrides.params as Record<string, unknown> | undefined),
    },
    clarification: "",
    ...overrides,
  };
}

/** The registry entry shape, with only the field under test varied. */
function entry(config: Record<string, unknown> | null): CapabilityEntry {
  return {
    key: "command.schedule_draft",
    model: "gpt-5.6-luna",
    enabled: true,
    tier: "T2",
    requires_human: true,
    monthly_budget_usd: 10,
    system_prompt: null,
    prompt_version: "command.schedule_draft.v1",
    config,
  };
}

/* ══ 1 · The allowlist belongs to the database ════════════════════════════════ */

describe("actionAllowlist — the registry is the only source of draftable actions", () => {
  it("reads the two RPCs migration 0057 registers", () => {
    const config = {
      actions: {
        "app.schedule_visit": { params: { type: "object" } },
        "app.assign_visit": { params: { type: "object" } },
      },
    };
    expect(actionAllowlist(entry(config))).toEqual(["app.schedule_visit", "app.assign_visit"]);
  });

  it("returns nothing when the row carries no config — an unprovisioned tenant drafts nothing", () => {
    expect(actionAllowlist(entry(null))).toEqual([]);
  });

  it("returns nothing when config exists but declares no actions", () => {
    expect(actionAllowlist(entry({ budget_note: "see docs/16" }))).toEqual([]);
  });

  it("returns nothing when `actions` is not an object", () => {
    // A list of names would be a plausible-looking shape that the pipeline must not
    // silently accept: the contract is a keyed object, and anything else is malformed.
    expect(actionAllowlist(entry({ actions: ["app.assign_visit"] }))).toEqual([]);
    expect(actionAllowlist(entry({ actions: "app.assign_visit" }))).toEqual([]);
    expect(actionAllowlist(entry({ actions: null }))).toEqual([]);
  });

  it("an empty allowlist means the parser refuses every action", () => {
    const parsed = parseScheduleDraft(completion(assignBody()), CONTEXT, []);
    expect(parsed.kind).toBe("refused");
  });
});

/* ══ 2 · Only registered actions, whoever asks ════════════════════════════════ */

describe("parseScheduleDraft — the action gate", () => {
  it("accepts an action that is on the allowlist", () => {
    const parsed = parseScheduleDraft(completion(assignBody()), CONTEXT, ALLOWLIST);
    expect(parsed.kind).toBe("action");
    if (parsed.kind !== "action") return;
    expect(parsed.action).toBe("app.assign_visit");
    expect(parsed.clientId).toBe(CLIENT_DORIS);
    expect(parsed.caregiverId).toBe(CAREGIVER_SAM);
  });

  it("refuses an adverse-class action even when the model names it confidently", () => {
    // D-021: separation is not in any allowlist, so it is not expressible. This is the
    // difference between a system that refuses and a system that cannot be asked.
    const parsed = parseScheduleDraft(
      completion({
        action: "app.terminate_caregiver",
        params: { caregiver_id: CAREGIVER_SAM, client_id: CLIENT_DORIS, start: "2026-08-14T08:00:00" },
        clarification: "",
      }),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("refused");
  });

  it("refuses an unregistered scheduling-shaped action", () => {
    const parsed = parseScheduleDraft(
      completion({ action: "app.cancel_visit", params: {}, clarification: "" }),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("refused");
  });

  it("passes a refusal to clarify through as the model's own question", () => {
    const parsed = parseScheduleDraft(
      completion({
        action: "none",
        params: {},
        clarification: "Did you mean Harold Bramble or Harold Overbrook?",
      }),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed).toEqual({
      kind: "clarify",
      message: "Did you mean Harold Bramble or Harold Overbrook?",
    });
  });

  it("degrades to a clarification when the completion is not JSON at all", () => {
    for (const raw of ["", "I'm sorry, I can't help with that.", "```json\n{oops", null]) {
      const parsed = parseScheduleDraft(raw, CONTEXT, ALLOWLIST);
      expect(parsed.kind).toBe("clarify");
    }
  });
});

/* ══ 3 · Only ids this request already had ════════════════════════════════════ */

describe("parseScheduleDraft — the id gate", () => {
  it("refuses a well-formed client id that is not in the context", () => {
    const parsed = parseScheduleDraft(
      completion(assignBody({ params: { client_id: OFF_CONTEXT } })),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("clarify");
  });

  it("refuses a well-formed caregiver id that is not in the context", () => {
    const parsed = parseScheduleDraft(
      completion(assignBody({ params: { caregiver_id: OFF_CONTEXT } })),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("clarify");
  });

  it("refuses a label where an id belongs", () => {
    const parsed = parseScheduleDraft(
      completion(assignBody({ params: { client_id: "Doris Fenwick" } })),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("clarify");
  });

  it("refuses a missing id rather than drafting against whoever is left", () => {
    for (const params of [{ client_id: null }, { caregiver_id: null }, { client_id: "" }]) {
      const parsed = parseScheduleDraft(completion(assignBody({ params })), CONTEXT, ALLOWLIST);
      expect(parsed.kind).toBe("clarify");
    }
  });

  it("never lets the caregiver id stand in for the client id", () => {
    // The cross-slot swap: both ids are real and both are in the context, but the caregiver
    // is not a client. Checking each slot against its OWN list is what catches it.
    const parsed = parseScheduleDraft(
      completion(assignBody({ params: { client_id: CAREGIVER_SAM, caregiver_id: CLIENT_DORIS } })),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("clarify");
  });
});

/* ══ 4 · Time is read, never invented ═════════════════════════════════════════ */

describe("parseScheduleDraft — the time gate", () => {
  it("leaves the end null when the coordinator never said one", () => {
    const parsed = parseScheduleDraft(
      completion({
        action: "app.schedule_visit",
        params: {
          client_id: CLIENT_DORIS,
          caregiver_id: CAREGIVER_SAM,
          start: "2026-08-14T08:00:00",
          end: null,
        },
        clarification: "",
      }),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("action");
    if (parsed.kind !== "action") return;
    // A default duration would be the platform quietly deciding how long care lasts.
    expect(parsed.endISO).toBeNull();
  });

  it("refuses a window that ends before it starts", () => {
    const parsed = parseScheduleDraft(
      completion({
        action: "app.schedule_visit",
        params: {
          client_id: CLIENT_DORIS,
          caregiver_id: CAREGIVER_SAM,
          start: "2026-08-14T10:00:00",
          end: "2026-08-14T09:00:00",
        },
        clarification: "",
      }),
      CONTEXT,
      ALLOWLIST
    );
    expect(parsed.kind).toBe("clarify");
  });

  it("refuses an unparseable time instead of picking one", () => {
    for (const start of ["tomorrow morning", "2026-08-14", "", "08:00"]) {
      const parsed = parseScheduleDraft(
        completion(assignBody({ params: { visit_start: start } })),
        CONTEXT,
        ALLOWLIST
      );
      expect(parsed.kind).toBe("clarify");
    }
  });
});

describe("parseAgencyDateTime — 8am means 8am in Maryland", () => {
  it("reads a naive summer time as Eastern Daylight Time", () => {
    expect(parseAgencyDateTime("2026-08-14T08:00:00")?.toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });

  it("reads a naive winter time as Eastern Standard Time", () => {
    // The same wall clock is a DIFFERENT instant in January. A fixed offset would put this
    // visit an hour early, every winter, for every visit in the agency.
    expect(parseAgencyDateTime("2026-01-14T08:00:00")?.toISOString()).toBe("2026-01-14T13:00:00.000Z");
  });

  it("settles on the right side of a spring-forward boundary", () => {
    expect(parseAgencyDateTime("2026-03-08T03:00:00")?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("takes an explicit offset at its word", () => {
    expect(parseAgencyDateTime("2026-08-14T08:00:00-04:00")?.toISOString()).toBe(
      "2026-08-14T12:00:00.000Z"
    );
    expect(parseAgencyDateTime("2026-08-14T12:00:00Z")?.toISOString()).toBe(
      "2026-08-14T12:00:00.000Z"
    );
  });

  it("accepts a minute-precision time and rejects a date with no time", () => {
    expect(parseAgencyDateTime("2026-08-14T08:00")?.toISOString()).toBe("2026-08-14T12:00:00.000Z");
    expect(parseAgencyDateTime("2026-08-14")).toBeNull();
    expect(parseAgencyDateTime("next Tuesday")).toBeNull();
  });
});

/* ══ 5 · The browser boundary ═════════════════════════════════════════════════ */

describe("isEntityRef — what the browser is allowed to send back", () => {
  it("accepts a well-formed reference of either type", () => {
    expect(isEntityRef({ type: "client", id: CLIENT_DORIS })).toBe(true);
    expect(isEntityRef({ type: "caregiver", id: CAREGIVER_SAM })).toBe(true);
  });

  it("rejects anything that is not a reference", () => {
    // sessionStorage is writable by anyone at the keyboard, so its contents are input,
    // and each case is stated as a literal expectation rather than recomputed — a test
    // that reimplements the validator can only ever prove the reimplementation.
    expect(isEntityRef(null)).toBe(false);
    expect(isEntityRef(undefined)).toBe(false);
    expect(isEntityRef("client")).toBe(false);
    expect(isEntityRef({ type: "client" })).toBe(false);
    expect(isEntityRef({ type: "client", id: "not-a-uuid" })).toBe(false);
    expect(isEntityRef({ type: "client", id: 42 })).toBe(false);
    expect(isEntityRef({ type: "tenant", id: CLIENT_DORIS })).toBe(false);
    expect(isEntityRef({ id: CLIENT_DORIS })).toBe(false);
  });

  it("tolerates an extra key, because the server never reads one anyway", () => {
    // A browser that also sent a label is still sending a valid reference; the label is
    // simply never looked at — every name on screen is re-read under RLS (invariant 5).
    expect(isEntityRef({ type: "client", id: CLIENT_DORIS, label: "Doris Fenwick" })).toBe(true);
  });
});
