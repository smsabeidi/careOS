/**
 * The offline clock queue — `src/lib/offline/queue.ts`.
 *
 * THIS IS THE DOUBLE-CLOCK TEST. A caregiver taps "Clock in" in a basement, sees
 * nothing happen, and taps again. Everything downstream of that moment is a payroll
 * record and, in Maryland, an EVV submission. Two properties keep it honest and both
 * are proved here:
 *
 *   1. ONE IDEMPOTENCY KEY PER USER-INITIATED ATTEMPT (D-022). The key is minted by the
 *      caller and carried unchanged through queueing, retry and replay — the database's
 *      partial unique index on (tenant_id, visit_id, client_event_id) then answers a
 *      repeat delivery with `replayed: true` instead of appending a second ledger row.
 *      `noteAttempt` must therefore increment the evidence counter WITHOUT rotating the
 *      key; a rotation here would convert a lost response into a real double clock-in.
 *
 *   2. ENQUEUE REPLACES, IT DOES NOT APPEND (§7.6). A second tap on the same
 *      (visit, event) while the first is still held is a caregiver asking "did that
 *      take?", not asking to arrive twice. The newer capture supersedes the older, so
 *      exactly one delivery is attempted and nobody is told CAREOS_ALREADY_CLOCKED_IN
 *      for something they never did. Replacement is scoped: a different event on the
 *      same visit, or the same event on a different visit, is a separate intent and
 *      must survive.
 *
 * ALSO PROVED
 *   · Nothing that identifies a person is written to device storage — invariant 5. The
 *     stored record is asserted key-for-key against the allowed shape, so a future
 *     field carrying a client name, address or note fails here rather than in a
 *     forensic review of a stolen phone.
 *   · `dequeueClock` removes exactly the delivered entry and leaves the rest queued: a
 *     queue that drops a sibling entry on success is a lost shift.
 *   · Ordering is oldest-first — the order the day actually happened in.
 *   · Every mutation broadcasts QUEUE_CHANGED so the connection indicator recounts.
 *   · A blocked IndexedDB (private-mode Safari, hardened profile) degrades to
 *     `false`/empty rather than throwing, because the caller owes the caregiver the
 *     words "could not save on this device", never a white screen.
 *
 * Serves: docs/17 §7.6, D-022, invariants 1 and 5.
 * Runs anywhere Node runs — `fake-indexeddb` supplies the storage engine; no server,
 * no database, no network.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUEUE_CHANGED,
  dequeueClock,
  enqueueClock,
  listQueue,
  noteAttempt,
  queueSize,
  type QueuedClock,
} from "./queue";

/** The complete set of keys allowed to reach device storage. Adding one is a decision. */
const ALLOWED_KEYS = [
  "clientEventId",
  "visitId",
  "event",
  "capturedAt",
  "latitude",
  "longitude",
  "accuracyM",
  "deviceSessionId",
  "queuedAt",
  "attempts",
].sort();

const VISIT_A = "11111111-1111-4111-8111-111111111111";
const VISIT_B = "22222222-2222-4222-8222-222222222222";

function capture(overrides: Partial<Omit<QueuedClock, "queuedAt" | "attempts">> = {}) {
  return {
    clientEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    visitId: VISIT_A,
    event: "clock_in" as const,
    capturedAt: "2026-08-11T13:00:00.000Z",
    latitude: 39.2904,
    longitude: -76.6122,
    accuracyM: 18,
    deviceSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ...overrides,
  };
}

beforeEach(() => {
  // A brand-new IndexedDB per test. Shared storage between tests is how an offline
  // suite starts passing because of an entry the previous test happened to leave.
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  // Belt and braces: a fake clock that escapes a failing test deadlocks every IndexedDB
  // await in the file after it, which reads as five unrelated failures.
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one intent, one delivery", () => {
  it("holds a single capture and hands it back intact", async () => {
    const item = capture();
    expect(await enqueueClock(item)).toBe(true);

    const held = await listQueue();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject(item);
    expect(held[0].attempts).toBe(0);
    expect(await queueSize()).toBe(1);
  });

  it("REPLACES a held capture for the same (visit, event) instead of appending", async () => {
    // Tap one: parked, never delivered.
    await enqueueClock(capture({ clientEventId: "first-attempt", accuracyM: 240 }));
    // Tap two, seconds later, tighter fix: the caregiver asking whether tap one took.
    await enqueueClock(
      capture({
        clientEventId: "second-attempt",
        accuracyM: 12,
        capturedAt: "2026-08-11T13:00:20.000Z",
      })
    );

    const held = await listQueue();
    expect(held).toHaveLength(1);
    // The SURVIVOR is the newer capture — the caregiver's latest position and latest
    // intent — and the superseded draft, which reached no server, is gone.
    expect(held[0].clientEventId).toBe("second-attempt");
    expect(held[0].accuracyM).toBe(12);
    expect(await queueSize()).toBe(1);
  });

  it("does not treat a different event on the same visit as the same intent", async () => {
    await enqueueClock(capture({ clientEventId: "in", event: "clock_in" }));
    await enqueueClock(capture({ clientEventId: "out", event: "clock_out" }));

    const held = await listQueue();
    expect(held.map((r) => r.clientEventId).sort()).toEqual(["in", "out"]);
  });

  it("does not treat the same event on a different visit as the same intent", async () => {
    await enqueueClock(capture({ clientEventId: "visit-a", visitId: VISIT_A }));
    await enqueueClock(capture({ clientEventId: "visit-b", visitId: VISIT_B }));

    const held = await listQueue();
    expect(held.map((r) => r.clientEventId).sort()).toEqual(["visit-a", "visit-b"]);
  });

  it("collapses a rapid burst of taps to exactly one pending delivery", async () => {
    for (let i = 0; i < 6; i++) {
      await enqueueClock(capture({ clientEventId: `tap-${i}` }));
    }
    expect(await queueSize()).toBe(1);
    expect((await listQueue())[0].clientEventId).toBe("tap-5");
  });
});

describe("the idempotency key survives retries", () => {
  it("noteAttempt increments the counter and leaves the key untouched", async () => {
    const item = capture({ clientEventId: "stable-key" });
    await enqueueClock(item);

    await noteAttempt("stable-key");
    await noteAttempt("stable-key");
    await noteAttempt("stable-key");

    const held = await listQueue();
    expect(held).toHaveLength(1);
    expect(held[0].clientEventId).toBe("stable-key");
    expect(held[0].attempts).toBe(3);
    // Everything else about the capture is preserved: a retry re-delivers the SAME
    // facts under the SAME key, which is the whole basis of `replayed: true`.
    expect(held[0]).toMatchObject({
      visitId: item.visitId,
      event: item.event,
      capturedAt: item.capturedAt,
      latitude: item.latitude,
      longitude: item.longitude,
      accuracyM: item.accuracyM,
    });
  });

  it("the attempt counter is evidence, not a limit — the entry never self-destructs", async () => {
    await enqueueClock(capture({ clientEventId: "persistent" }));
    for (let i = 0; i < 25; i++) await noteAttempt("persistent");

    const held = await listQueue();
    expect(held).toHaveLength(1);
    expect(held[0].attempts).toBe(25);
  });

  it("noteAttempt on an unknown key is a no-op, not a resurrection", async () => {
    await noteAttempt("never-existed");
    expect(await queueSize()).toBe(0);
  });
});

describe("delivery and ordering", () => {
  it("dequeue removes exactly the delivered entry", async () => {
    await enqueueClock(capture({ clientEventId: "a", visitId: VISIT_A }));
    await enqueueClock(capture({ clientEventId: "b", visitId: VISIT_B }));

    await dequeueClock("a");

    const held = await listQueue();
    expect(held.map((r) => r.clientEventId)).toEqual(["b"]);
  });

  it("returns entries oldest-first, the order the day happened in", async () => {
    // `toFake: ["Date"]` and nothing else. IndexedDB completes its requests on the real
    // task queue, so faking setTimeout/queueMicrotask here would deadlock every await in
    // this file — the queue only needs a controllable wall clock for `queuedAt`.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-11T09:00:00.000Z"));
    await enqueueClock(capture({ clientEventId: "morning", visitId: VISIT_A }));
    vi.setSystemTime(new Date("2026-08-11T14:00:00.000Z"));
    await enqueueClock(capture({ clientEventId: "afternoon", visitId: VISIT_B }));
    vi.useRealTimers();

    expect((await listQueue()).map((r) => r.clientEventId)).toEqual(["morning", "afternoon"]);
  });
});

describe("what may be written to a device", () => {
  it("stores only the allowlisted keys — no name, address, note or schedule", async () => {
    await enqueueClock(capture());
    const stored = (await listQueue())[0];
    expect(Object.keys(stored).sort()).toEqual(ALLOWED_KEYS);
  });

  it("accepts a capture with no position at all (DN-0046b: missing is a status)", async () => {
    await enqueueClock(
      capture({ clientEventId: "no-fix", latitude: null, longitude: null, accuracyM: null })
    );
    const stored = (await listQueue())[0];
    expect(stored.latitude).toBeNull();
    expect(stored.longitude).toBeNull();
    expect(stored.accuracyM).toBeNull();
  });
});

describe("broadcast", () => {
  it("announces every mutation so the connection indicator recounts without polling", async () => {
    const bus = new EventTarget();
    const seen: string[] = [];
    bus.addEventListener(QUEUE_CHANGED, () => seen.push(QUEUE_CHANGED));
    // The module guards on `typeof window`; a bare EventTarget is all it uses.
    vi.stubGlobal("window", bus);

    await enqueueClock(capture({ clientEventId: "x" }));
    await noteAttempt("x");
    await dequeueClock("x");

    expect(seen).toHaveLength(3);
  });

  it("is silent — not broken — with no window at all (server-side import)", async () => {
    vi.stubGlobal("window", undefined);
    await expect(enqueueClock(capture())).resolves.toBe(true);
  });
});

describe("hostile storage", () => {
  it("reports failure instead of throwing when IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB", undefined);

    await expect(enqueueClock(capture())).resolves.toBe(false);
    await expect(listQueue()).resolves.toEqual([]);
    await expect(queueSize()).resolves.toBe(0);
    // The caller turns `false` into "we couldn't save this on your phone" — a sentence,
    // never a silent drop (docs/10 §6).
  });

  it("reports failure instead of throwing when opening the database throws", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });

    await expect(enqueueClock(capture())).resolves.toBe(false);
    await expect(listQueue()).resolves.toEqual([]);
  });

  it("does not throw when a delivered entry is dequeued against dead storage", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(dequeueClock("anything")).resolves.toBeUndefined();
    await expect(noteAttempt("anything")).resolves.toBeUndefined();
  });
});
