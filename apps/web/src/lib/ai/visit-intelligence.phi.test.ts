/**
 * THE PHI CANARY for the four Verified Visit AI capabilities —
 * `src/lib/ai/visit-intelligence.ts`.
 *
 * WHAT IS BEING DEFENDED. Invariant 5 says PHI never leaves sideways, and names AI
 * prompts explicitly: a capability may send only what its declared allowlist permits.
 * D-030 goes further for this layer — no coordinate and no distance in metres reaches a
 * prompt or a screen, because a model transcript is a copy of the data that outlives the
 * request and lands in a vendor's logs. The `to*PromptFacts()` functions ARE those
 * allowlists. This file is what makes them true rather than intended.
 *
 * HOW IT TESTS. Not by reimplementing the minimizers — a copy of an allowlist can only
 * prove the copy. Instead the REAL read paths run end to end against a fake Supabase
 * whose rows are SALTED with everything that must never travel: client and caregiver
 * names, a street address, latitude and longitude, `distance_m`, a clinical note, a date
 * of birth, a phone number, raw UUIDs. `runCapability` — the one chokepoint every model
 * call goes through (invariant 10) — is mocked, and the exact payload it was handed is
 * captured and searched for every grain of that salt.
 *
 * The salt is placed the way a real leak happens: in extra columns a future `select` might
 * pick up, and inside the `visit_exception.evidence` jsonb, which is written by detectors
 * and is the one genuinely open-shaped field in the layer. `distance_m` is in there
 * because the impossible-travel detector legitimately records it for an RLS-gated admin
 * screen — it exists, it is real, and it must not travel.
 *
 * FOUR PROPERTIES
 *   1. The prompt payload contains no salt — not in a key, not in a value, not nested.
 *   2. The payload's key set is exactly the allowlist, at every level. A new field added
 *      to a facts type does not silently become a new field in a prompt.
 *   3. Identifiers are per-request handles (`exc-1`, `cg-3`), never UUIDs. A UUID would
 *      travel further than the guardrail needs and is durably re-identifying.
 *   4. The deterministic facts the SCREEN renders still carry what the screen needs. A
 *      minimizer that emptied everything would pass a leak test and fail the product;
 *      the split — full facts to the RLS-gated surface, minimum to the model — is the
 *      actual design and both halves are asserted.
 *
 * Serves: docs/17 §10 §11, D-021, D-030, invariants 5, 9, 10 and 13.
 * Runs anywhere Node runs — no server, no database, no network, no model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ── The one chokepoint, mocked so nothing can reach a network ─────────────── */

type CapturedCall = { key: string; system: string; user: string };
const calls: CapturedCall[] = [];

vi.mock("@/lib/ai/client", () => ({
  digest: (s: string, max = 220) => s.replace(/\s+/g, " ").trim().slice(0, max),
  runCapability: vi.fn(
    async (_supabase: unknown, key: string, opts: { system: string; user: string }) => {
      calls.push({ key, system: opts.system, user: opts.user });
      return {
        status: "abstained" as const,
        text: "",
        provider: "mock" as const,
        model: "test",
        toolCalls: 0,
        interactionId: null,
        reason: null,
      };
    }
  ),
}));

const {
  CAPABILITY_EXCEPTION_TRIAGE,
  CAPABILITY_OPERATIONAL_PROFILE,
  CAPABILITY_WEEKLY_REPORT,
  CAPABILITY_PAYROLL_READINESS,
  collectTriageFacts,
  draftOperationalProfile,
  getExceptionTriage,
  getPayrollReadinessBrief,
  getWeeklyWorkforceReport,
} = await import("./visit-intelligence");

/* ── The salt: every string that must never reach a prompt ─────────────────── */

const SALT = {
  clientName: "Rosalind Alvarez",
  clientFirst: "Rosalind",
  caregiverName: "Marcus Okonkwo",
  address: "412 Maple Grove Terrace, Catonsville MD",
  street: "Maple Grove Terrace",
  note: "client refused the transfer, hip pain worse since Tuesday",
  diagnosis: "post-op hip fracture",
  dob: "1941-03-09",
  phone: "410-555-0142",
  visitUuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  caregiverUuid: "9c858901-8a57-4791-81fe-4c455b099bc9",
  exceptionUuid: "7d793037-a076-4d1b-84e5-4b2f1cd10bb2",
  clientUuid: "b1e0f0aa-2f6f-4a17-9f28-1a2b3c4d5e6f",
} as const;

/** Numbers that are places, not measurements of work. */
const FORBIDDEN_NUMBERS = ["39.2904", "-76.6122", "312.5", "39.29", "76.61"];

/* ── A Supabase test double: chainable, thenable, per-table results ────────── */

type Result = { data: unknown; error: unknown };

function query(result: Result): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        // select / eq / in / gte / lte / order / limit / maybeSingle / … all chain.
        return () => proxy;
      },
    }
  );
  return proxy;
}

function fakeSupabase(opts: {
  tables?: Record<string, Result>;
  rpc?: Record<string, Result>;
}): never {
  const client = {
    from: (table: string) => query(opts.tables?.[table] ?? { data: [], error: null }),
    schema: () => ({
      rpc: async (name: string) => opts.rpc?.[name] ?? { data: null, error: null },
    }),
    rpc: async (name: string) => opts.rpc?.[name] ?? { data: null, error: null },
  };
  return client as never;
}

/* ── Salted fixtures ───────────────────────────────────────────────────────── */

/** An exception row as the detectors write it, plus every column a future select might add. */
function saltedExceptionRow(over: Record<string, unknown> = {}) {
  return {
    exception_id: SALT.exceptionUuid,
    visit_id: SALT.visitUuid,
    caregiver_id: SALT.caregiverUuid,
    kind: "impossible_travel",
    severity: "critical",
    detected_by: "rules",
    rule_key: "impossible_travel_v1",
    detected_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    latest_disposition: null,
    open: true,
    evidence: {
      // Legitimate, allowlisted:
      threshold_kmh: 120,
      speed_kmh: 431.7,
      gap_seconds: 240,
      requires_note: true,
      // Legitimate on an RLS-gated admin screen, forbidden in a prompt (D-030):
      distance_m: 312.5,
      latitude: 39.2904,
      longitude: -76.6122,
      // Never legitimate anywhere outside the row:
      client_name: SALT.clientName,
      client_address: SALT.address,
      caregiver_name: SALT.caregiverName,
      note: SALT.note,
      diagnosis: SALT.diagnosis,
    },
    // Columns the module does not select — here in case it ever spreads a row.
    client_name: SALT.clientName,
    client_id: SALT.clientUuid,
    home_address: SALT.address,
    ...over,
  };
}

function saltedVisitRow(over: Record<string, unknown> = {}) {
  return {
    visit_id: SALT.visitUuid,
    caregiver_id: SALT.caregiverUuid,
    status: "completed",
    approval_status: "pending",
    payroll_status: "not_ready",
    verification_status: "unverified",
    scheduled_start: "2026-08-11T13:00:00.000Z",
    scheduled_end: "2026-08-11T15:00:00.000Z",
    // Real columns on verified_visit that must never travel:
    client_id: SALT.clientUuid,
    clock_in_distance_m: 312.5,
    clock_out_distance_m: 88.25,
    client_name: SALT.clientName,
    client_address: SALT.address,
    client_dob: SALT.dob,
    client_phone: SALT.phone,
    ...over,
  };
}

/** One `app.workforce_features` caregiver row, salted with an identity it never carries. */
function saltedFeatureRow(over: Record<string, unknown> = {}) {
  return {
    caregiver_id: SALT.caregiverUuid,
    visits_scheduled: 46,
    visits_completed: 44,
    visits_missed: 2,
    late_count: 9,
    avg_late_minutes: 11.4,
    early_count: 3,
    overrun_minutes: 210,
    undertime_minutes: 45,
    overtime_minutes: 320,
    schedule_adherence_pct: 92.1,
    verified_rate: 0.87,
    client_continuity_pct: 78.5,
    manual_override_count: 2,
    location_exception_count: 4,
    missing_clock_out_count: 3,
    overlap_count: 1,
    impossible_travel_count: 1,
    documentation_missing_count: 2,
    day_of_week_lateness: [4.2, 12.9, 3.1, 0, 2.4, null, null],
    trust_band_histogram: { verified: 38, unverified: 4, exception: 4 },
    // Salt — app.workforce_features returns IDs, enums and counts only (migration 0051).
    full_name: SALT.caregiverName,
    home_address: SALT.address,
    date_of_birth: SALT.dob,
    phone: SALT.phone,
    ...over,
  };
}

/* ── The assertion every capability shares ─────────────────────────────────── */

function assertNoSalt(payload: string, label: string) {
  for (const [name, value] of Object.entries(SALT)) {
    // UUIDs are checked separately below so the failure message names the reason.
    if (name.endsWith("Uuid")) continue;
    expect(payload, `${label} leaked ${name}`).not.toContain(value);
  }
  for (const n of FORBIDDEN_NUMBERS) {
    expect(payload, `${label} leaked a coordinate or distance (${n})`).not.toContain(n);
  }
  // No raw record identifier travels: handles are per-request and opaque.
  expect(payload, `${label} leaked a UUID`).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  // Nothing that looks like a street address or a person's full name.
  expect(payload, `${label} leaked a street address`).not.toMatch(/\d+\s+\w+\s+(Street|St|Road|Rd|Avenue|Ave|Terrace|Lane|Drive)\b/i);
}

/** The JSON blob a capability actually embedded in its user turn. */
function promptPayload(call: CapturedCall): Record<string, unknown> {
  const start = call.user.indexOf("{");
  const end = call.user.lastIndexOf("}");
  expect(start, "no JSON payload found in the user turn").toBeGreaterThanOrEqual(0);
  return JSON.parse(call.user.slice(start, end + 1)) as Record<string, unknown>;
}

beforeEach(() => {
  calls.length = 0;
});

/* ══ 1 · visit.exception_triage ═══════════════════════════════════════════════ */

describe("visit.exception_triage", () => {
  const supabase = () =>
    fakeSupabase({
      tables: {
        visit_exception_state: { data: [saltedExceptionRow()], error: null },
        verified_visit: { data: [saltedVisitRow()], error: null },
      },
    });

  it("sends no name, address, coordinate, distance, note or UUID to the model", async () => {
    await getExceptionTriage(supabase());
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(CAPABILITY_EXCEPTION_TRIAGE);
    assertNoSalt(calls[0].user, "triage user turn");
    assertNoSalt(calls[0].system, "triage system prompt");
  });

  it("emits exactly the allowlisted top-level keys", async () => {
    await getExceptionTriage(supabase());
    expect(Object.keys(promptPayload(calls[0])).sort()).toEqual([
      "by_severity",
      "items",
      "open_total",
    ]);
  });

  it("emits exactly the allowlisted per-item keys", async () => {
    await getExceptionTriage(supabase());
    const items = promptPayload(calls[0]).items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual([
      "age_hours",
      "blocks_pay",
      "care_affecting",
      "evidence",
      // The human-readable KIND label ("Impossible travel"), not the visit or the person.
      "finding",
      "key",
      "nobody_assigned",
      "platform_rank",
      "severity",
    ]);
  });

  it("strips every non-allowlisted evidence key, INCLUDING distance_m", async () => {
    await getExceptionTriage(supabase());
    const items = promptPayload(calls[0]).items as { evidence: Record<string, unknown> }[];
    // Kept: scalars the narrator needs to say what the rule found.
    expect(Object.keys(items[0].evidence).sort()).toEqual([
      "gap_seconds",
      "requires_note",
      "speed_kmh",
      "threshold_kmh",
    ]);
    // Dropped: the whole place-and-person half of the same blob.
    for (const banned of ["distance_m", "latitude", "longitude", "client_name", "client_address", "caregiver_name", "note", "diagnosis"]) {
      expect(items[0].evidence).not.toHaveProperty(banned);
    }
  });

  it("identifies a finding by a per-request handle, never by its row id", async () => {
    await getExceptionTriage(supabase());
    const items = promptPayload(calls[0]).items as { key: string }[];
    expect(items[0].key).toBe("exc-1");
  });

  it("still gives the RLS-gated screen the ids and detail the screen needs", async () => {
    // The other half of the design: minimizing the PROMPT must not minimize the PAGE.
    const { facts } = await collectTriageFacts(supabase());
    expect(facts.items[0].exceptionId).toBe(SALT.exceptionUuid);
    expect(facts.items[0].visitId).toBe(SALT.visitUuid);
    expect(facts.items[0].caregiverId).toBe(SALT.caregiverUuid);
    expect(facts.items[0].kindLabel).toBeTruthy();
  });

  it("never even reaches the model when the queue is empty — no payload, no spend", async () => {
    const empty = fakeSupabase({ tables: { visit_exception_state: { data: [], error: null } } });
    const result = await getExceptionTriage(empty);
    expect(calls).toHaveLength(0);
    expect(result.narration).toBeNull();
  });

  it("does not put the read error into a prompt when the queue cannot be read", async () => {
    const broken = fakeSupabase({
      tables: {
        visit_exception_state: {
          data: null,
          error: { message: `permission denied for table "client" (${SALT.clientName})` },
        },
      },
    });
    const result = await getExceptionTriage(broken);
    expect(calls).toHaveLength(0);
    expect(result.facts.items).toEqual([]);
  });
});

/* ══ 2 · workforce.weekly_report ══════════════════════════════════════════════ */

describe("workforce.weekly_report", () => {
  const supabase = () =>
    fakeSupabase({
      rpc: {
        workforce_features: {
          data: {
            org_id: "meadowbrook",
            from: "2026-08-01",
            to: "2026-08-08",
            generated_at: "2026-08-11T12:00:00.000Z",
            caregivers: [
              saltedFeatureRow(),
              saltedFeatureRow({ caregiver_id: "1f2e3d4c-5b6a-4798-8807-16253443526f", late_count: 2 }),
            ],
          },
          error: null,
        },
      },
    });

  it("sends no name, address, date of birth, phone or UUID to the model", async () => {
    await getWeeklyWorkforceReport(supabase(), { from: "2026-08-01", to: "2026-08-08" });
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(CAPABILITY_WEEKLY_REPORT);
    assertNoSalt(calls[0].user, "weekly user turn");
    assertNoSalt(calls[0].system, "weekly system prompt");
  });

  it("emits exactly the allowlisted top-level keys", async () => {
    await getWeeklyWorkforceReport(supabase(), { from: "2026-08-01", to: "2026-08-08" });
    expect(Object.keys(promptPayload(calls[0])).sort()).toEqual([
      "caregivers",
      "topics",
      "totals",
      "weekday_lateness",
      "window",
    ]);
  });

  it("refers to a caregiver only by an opaque per-request key", async () => {
    await getWeeklyWorkforceReport(supabase(), { from: "2026-08-01", to: "2026-08-08" });
    const roster = promptPayload(calls[0]).caregivers as { key: string }[];
    expect(roster.length).toBeGreaterThan(0);
    for (const entry of roster) {
      expect(entry.key).toMatch(/^cg-\d+$/);
      expect(entry).not.toHaveProperty("caregiver_id");
      expect(entry).not.toHaveProperty("full_name");
    }
  });

  it("does not put the RPC's error text into a prompt", async () => {
    const broken = fakeSupabase({
      rpc: {
        workforce_features: {
          data: null,
          error: { message: `CAREOS_FORBIDDEN: ${SALT.caregiverName} lacks workforce.read` },
        },
      },
    });
    const report = await getWeeklyWorkforceReport(broken, { from: "2026-08-01", to: "2026-08-08" });
    expect(calls).toHaveLength(0);
    // The human-facing refusal is written copy, not the wire message.
    expect(JSON.stringify(report.error)).not.toContain(SALT.caregiverName);
  });
});

/* ══ 3 · payroll.readiness_brief ══════════════════════════════════════════════ */

describe("payroll.readiness_brief", () => {
  const supabase = () =>
    fakeSupabase({
      tables: {
        payroll_period: {
          data: [
            {
              id: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
              starts_on: "2026-08-01",
              ends_on: "2026-08-15",
              status: "open",
            },
          ],
          error: null,
        },
        verified_visit: { data: [saltedVisitRow()], error: null },
        approved_work_segment: {
          data: [{ visit_id: SALT.visitUuid, approved_minutes: 120, decision: "approved", seq: 1 }],
          error: null,
        },
        visit_exception_state: {
          data: [
            {
              exception_id: SALT.exceptionUuid,
              visit_id: SALT.visitUuid,
              kind: "missing_clock_out",
              severity: "critical",
              open: true,
            },
          ],
          error: null,
        },
      },
    });

  it("sends no name, address, coordinate, distance or UUID to the model", async () => {
    await getPayrollReadinessBrief(supabase());
    // Asserted, not guarded: a `if (calls.length === 0) return` here would let the whole
    // canary pass vacuously the day the fixture stops producing a blocker.
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(CAPABILITY_PAYROLL_READINESS);
    assertNoSalt(calls[0].user, "payroll user turn");
    assertNoSalt(calls[0].system, "payroll system prompt");
  });

  it("emits only aggregate keys — counts, minutes, hours and a status", async () => {
    await getPayrollReadinessBrief(supabase());
    expect(calls).toHaveLength(1);
    const allowed = [
      "approved_hours",
      "approved_minutes",
      "awaiting_hours",
      "awaiting_minutes",
      "blockers",
      "blocking_total",
      "can_close",
      "period",
      "visits",
      "window",
    ];
    expect(Object.keys(promptPayload(calls[0])).sort()).toEqual(allowed);
  });
});

/* ══ 4 · visit.operational_profile (T2 — about one named person) ══════════════ */

describe("visit.operational_profile", () => {
  const capabilityRow = {
    key: CAPABILITY_OPERATIONAL_PROFILE,
    tier: "T2",
    requires_human: true,
    enabled: true,
    active: true,
  };

  const supabase = () =>
    fakeSupabase({
      tables: { ai_capability: { data: capabilityRow, error: null } },
      rpc: {
        workforce_features: {
          data: {
            org_id: "meadowbrook",
            from: "2026-06-01",
            to: "2026-08-01",
            generated_at: "2026-08-11T12:00:00.000Z",
            caregivers: [saltedFeatureRow()],
          },
          error: null,
        },
      },
    });

  const window = { from: "2026-06-01", to: "2026-08-01" };

  it("sends no name, address, date of birth, phone, coordinate or UUID to the model", async () => {
    await draftOperationalProfile(supabase(), SALT.caregiverUuid, window);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(CAPABILITY_OPERATIONAL_PROFILE);
    assertNoSalt(calls[0].user, "profile user turn");
    assertNoSalt(calls[0].system, "profile system prompt");
  });

  it("names the subject of a profile only as a role, never as a person", async () => {
    await draftOperationalProfile(supabase(), SALT.caregiverUuid, window);
    const payload = promptPayload(calls[0]);
    expect(payload.subject).toBe("caregiver-under-review");
    expect(payload).not.toHaveProperty("caregiver_id");
    expect(payload).not.toHaveProperty("full_name");
  });

  it("emits only counts, minutes, percentages and weekday means", async () => {
    await draftOperationalProfile(supabase(), SALT.caregiverUuid, window);
    const payload = promptPayload(calls[0]);
    const unexpected = Object.keys(payload).filter(
      (k) => !/^(subject|window|visits_|late_|avg_late_|early_|schedule_|verified_|client_continuity_|overtime_|overrun_|undertime_|manual_override_|exceptions_|location_exception_|missing_clock_out_|overlap_|impossible_travel_|documentation_missing_|trust_bands$|weekday_late_minutes$)/.test(k)
    );
    expect(unexpected, "keys outside the operational-profile allowlist").toEqual([]);
  });

  it("does not call the model at all when the capability is not provisioned (fail closed)", async () => {
    const unprovisioned = fakeSupabase({
      tables: { ai_capability: { data: null, error: null } },
      rpc: {
        workforce_features: {
          data: { org_id: "m", from: window.from, to: window.to, generated_at: "", caregivers: [saltedFeatureRow()] },
          error: null,
        },
      },
    });
    const draft = await draftOperationalProfile(unprovisioned, SALT.caregiverUuid, window);
    expect(calls).toHaveLength(0);
    expect(draft.abstained).toBeTruthy();
    expect(draft.requiresHumanDisposer).toBe(true);
  });

  it("does not call the model when the window is too small to describe a person fairly", async () => {
    const draft = await draftOperationalProfile(supabase(), SALT.caregiverUuid, {
      from: "2026-08-01",
      to: "2026-08-03",
    });
    expect(calls).toHaveLength(0);
    expect(draft.abstained).toBeTruthy();
  });

  it("stays a draft with a required human disposer, whatever the model said", async () => {
    const draft = await draftOperationalProfile(supabase(), SALT.caregiverUuid, window);
    expect(draft.isDraft).toBe(true);
    expect(draft.requiresHumanDisposer).toBe(true);
    expect(draft.tier).toBe("T2");
  });
});

/* ══ Cross-cutting ═══════════════════════════════════════════════════════════ */

describe("every capability, one rule", () => {
  it("routes every model call through the single governed chokepoint", async () => {
    // If any capability ever fetched directly, `calls` would not see it — so this also
    // pins invariant 10 by construction: the mock IS the only door, and the tests above
    // only observe anything because every call goes through it.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./visit-intelligence.ts", import.meta.url), "utf8")
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/api\.anthropic\.com|api\.openai\.com/);
  });

  it("hands the model no free-text field written by a human", async () => {
    // Notes, reasons and dispositions are the fields a person types into. None of them
    // has a route into a prompt in this layer; if one appears, it appears here first.
    const supabase = fakeSupabase({
      tables: {
        visit_exception_state: {
          data: [saltedExceptionRow({ evidence: { note: SALT.note, requires_note: true } })],
          error: null,
        },
        verified_visit: { data: [saltedVisitRow()], error: null },
      },
    });
    await getExceptionTriage(supabase);
    expect(calls[0].user).not.toContain(SALT.note);
    expect(calls[0].user).toContain("requires_note");
  });
});
