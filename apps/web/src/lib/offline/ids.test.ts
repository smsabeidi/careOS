/**
 * Device identity for a field action — `src/lib/offline/ids.ts`.
 *
 * WHAT THIS PROVES
 *   1. `newUuid()` returns an RFC 4122 v4 string on every code path it has, including
 *      the hand-rolled CSPRNG path taken in an insecure context, and never silently
 *      degrades to `Math.random` while `crypto.getRandomValues` exists. The value is the
 *      idempotency key the database's partial unique index keys off (D-022): if two
 *      attempts can collide, one caregiver gets one clock event for two shifts, or two
 *      for one.
 *   2. Ids are unique across a large batch — the property that actually matters, since
 *      "one id per attempt" is worthless if attempts share ids.
 *   3. `deviceSessionId()` is stable within a tab and survives a hostile storage layer.
 *      Private-mode Safari and hardened enterprise profiles THROW on sessionStorage
 *      access; chrome must never be the reason a caregiver cannot clock in
 *      (docs/17 §7.6). A throw must degrade to a fresh id, not an exception.
 *   4. Nothing generated here encodes a fact about a person — invariant 5. A v4 UUID is
 *      random bytes; the test pins the version and variant nibbles so a future
 *      "helpful" change to a time- or MAC-derived UUID (v1) fails here.
 *
 * Serves: docs/17 §7.6, D-022, invariant 5.
 * Runs anywhere Node runs — no server, no database, no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceSessionId, newUuid } from "./ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A stand-in for a storage object that behaves; `map` is inspectable by the test. */
function workingSessionStorage() {
  const map = new Map<string, string>();
  return {
    map,
    api: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newUuid", () => {
  it("returns a v4 UUID via crypto.randomUUID when the platform offers it", () => {
    const id = newUuid();
    expect(id).toMatch(UUID_V4);
  });

  it("builds a correct v4 by hand when randomUUID is missing (insecure context)", () => {
    // http:// origins expose getRandomValues but not randomUUID. This is the path a
    // caregiver on a captive-portal Wi-Fi can genuinely land on.
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff;
        return arr;
      },
    });

    const id = newUuid();
    expect(id).toMatch(UUID_V4);
    // Version and variant are stamped by the code, not by the byte source: the fake
    // above never produces a 4 or an 8..b in those positions on its own.
    expect(id[14]).toBe("4");
    expect("89ab").toContain(id[19]);
  });

  it("does not reach for Math.random while a CSPRNG is available", () => {
    const spy = vi.spyOn(Math, "random");
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = 0xa5;
        return arr;
      },
    });

    expect(newUuid()).toMatch(UUID_V4);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still returns a usable per-attempt id when there is no crypto at all", () => {
    // Documented last resort. It is NOT a UUID and must not pretend to be one — the
    // database scopes uniqueness by (tenant, visit, client_event_id), so a same-tab
    // collision is the only exposure and the prefix makes the degradation legible in
    // an audit trail.
    vi.stubGlobal("crypto", undefined);
    const id = newUuid();
    expect(id).not.toMatch(UUID_V4);
    expect(id.startsWith("nocrypto-")).toBe(true);
  });

  it("never repeats across a large batch of attempts", () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => newUuid()));
    expect(ids.size).toBe(5_000);
  });
});

describe("deviceSessionId", () => {
  it("mints once per tab and returns the same handle thereafter", () => {
    const { map, api } = workingSessionStorage();
    vi.stubGlobal("sessionStorage", api);

    const first = deviceSessionId();
    const second = deviceSessionId();

    expect(first).toMatch(UUID_V4);
    expect(second).toBe(first);
    expect(map.size).toBe(1);
    // The stored value is the handle itself and nothing else — no user id, no visit,
    // no timestamp riding along (invariant 5).
    expect([...map.values()]).toEqual([first]);
  });

  it("degrades to a fresh id rather than throwing when storage is blocked", () => {
    // Private-mode Safari and locked-down profiles throw on ACCESS, not on write.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    const a = deviceSessionId();
    const b = deviceSessionId();

    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    // Not reused — that is the honest cost of unavailable storage, and it is a
    // fraud-signal fidelity loss, never a clock-in blocker.
    expect(b).not.toBe(a);
  });

  it("degrades the same way when sessionStorage is absent entirely", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(deviceSessionId()).toMatch(UUID_V4);
  });
});
