/**
 * Multi-pass position acquisition — `src/app/today/locate.ts`.
 *
 * WHY THIS LOGIC EXISTS, AND THEREFORE WHAT MUST BE TRUE. A phone's first fix is
 * usually a cell-tower or coarse-Wi-Fi guess hundreds of metres wide; the real GPS fix
 * arrives seconds later. `app.evaluate_location` judges ACCURACY BEFORE DISTANCE
 * (migration 0046), so submitting the first fix turns a hardware warm-up into a
 * location exception with a caregiver's name on it. Four properties keep that from
 * happening, and all four are proved here:
 *
 *   1. THE TIGHTEST FIX WINS. Every sample is considered; the narrowest one is what
 *      travels, regardless of arrival order.
 *   2. EARLY EXIT. Once a fix is comfortably inside the tightest policy accuracy floor,
 *      sampling stops — the radio is released and the caregiver is not kept waiting for
 *      a better answer than "good enough".
 *   3. THE HARD CAP HOLDS. Whatever we have at the deadline is what we send. A
 *      caregiver at a door does not stand there while a phone thinks.
 *   4. IT NEVER REJECTS. Denied permission, no receiver, airplane mode, a geolocation
 *      API that throws on call — every one of them resolves to `null`. A missing
 *      position is a location STATUS, not an error (DN-0046b), and care must never be
 *      blocked by a sensor.
 *
 * ALSO PROVED: the returned object carries exactly four fields. `GeolocationCoordinates`
 * also offers altitude, heading, speed and altitudeAccuracy; none of them has a purpose
 * in a clock event, and a fix that quietly grew a `speed` would be movement telemetry on
 * an employee (D-030, invariant 5).
 *
 * Serves: docs/17 §7.1, DN-0046b, D-030, invariant 5.
 * Runs anywhere Node runs — geolocation and the clock are both faked; no server, no
 * device, no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFix } from "./locate";

/** The module's own constants, restated so a drift in either is visible here. */
const GOOD_ENOUGH_M = 60;
const DEADLINE_MS = 8_000;

type SuccessCb = (p: GeolocationPosition) => void;
type ErrorCb = (e: GeolocationPositionError) => void;

/** A geolocation the test drives by hand: nothing arrives until the test says so. */
function fakeGeolocation() {
  const state = {
    success: null as SuccessCb | null,
    error: null as ErrorCb | null,
    options: null as PositionOptions | null,
    cleared: [] as number[],
    watchId: 42,
  };

  const geolocation = {
    watchPosition(success: SuccessCb, error: ErrorCb, options: PositionOptions) {
      state.success = success;
      state.error = error;
      state.options = options;
      return state.watchId;
    },
    clearWatch(id: number) {
      state.cleared.push(id);
    },
    getCurrentPosition() {
      throw new Error("acquireFix must watch, not take a single fix");
    },
  };

  return {
    state,
    install() {
      vi.stubGlobal("navigator", { geolocation });
    },
    /** Deliver one sample, as a real device would. */
    emit(accuracy: number, extra: { latitude?: number; longitude?: number; at?: number } = {}) {
      state.success?.({
        coords: {
          latitude: extra.latitude ?? 39.2904,
          longitude: extra.longitude ?? -76.6122,
          accuracy,
          altitude: 12,
          altitudeAccuracy: 3,
          heading: 90,
          speed: 1.4,
          toJSON: () => ({}),
        },
        timestamp: extra.at ?? Date.parse("2026-08-11T13:00:00.000Z"),
        toJSON: () => ({}),
      } as unknown as GeolocationPosition);
    },
    /** Deliver a refusal, as a device does when the user says no. */
    fail(code = 1) {
      state.error?.({
        code,
        message: "",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // `locate.ts` schedules its deadline through `window.setTimeout`. Delegating rather
  // than copying means the faked global is looked up at call time.
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: unknown) => globalThis.clearTimeout(id as never),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the tightest fix wins", () => {
  it("keeps the narrowest sample, not the first and not the last", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(800); // cell-tower guess, arrives first
    geo.emit(120); // fused fix, the real one
    geo.emit(300); // a later, worse sample must not overwrite it

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const fix = await pending;

    expect(fix).not.toBeNull();
    expect(fix?.accuracyM).toBe(120);
  });

  it("keeps the narrowest even when the best sample arrives first", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(100);
    geo.emit(650);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect((await pending)?.accuracyM).toBe(100);
  });

  it("carries the coordinates of the winning sample, not of another one", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(700, { latitude: 1, longitude: 2 });
    geo.emit(90, { latitude: 39.3, longitude: -76.5 });

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const fix = await pending;
    expect(fix?.latitude).toBe(39.3);
    expect(fix?.longitude).toBe(-76.5);
  });

  it("treats a sample with unreadable accuracy as infinitely wide, and prefers any real one", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(Number.NaN);
    geo.emit(140);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect((await pending)?.accuracyM).toBe(140);
  });

  it("still returns an unreadable-accuracy fix when it is all the device produced", async () => {
    // Lawful: the coordinate travels and the server decides. `evaluate_location` fails it
    // on the accuracy floor and records `location_unverified` — an honest status the
    // caregiver can clear with a reason, not a silent drop.
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(Number.NaN);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const fix = await pending;
    expect(fix).not.toBeNull();
    expect(fix?.accuracyM).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("early exit", () => {
  it("stops sampling the moment a fix is good enough", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(900);
    geo.emit(GOOD_ENOUGH_M - 20);

    // No timer advance at all: the promise is already settled.
    const fix = await pending;
    expect(fix?.accuracyM).toBe(GOOD_ENOUGH_M - 20);
    expect(geo.state.cleared).toEqual([geo.state.watchId]);
  });

  it("exits exactly at the threshold, not one metre past it", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(GOOD_ENOUGH_M);

    expect((await pending)?.accuracyM).toBe(GOOD_ENOUGH_M);
  });

  it("keeps sampling for a fix that is merely acceptable, not good enough", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(GOOD_ENOUGH_M + 1);
    // Nothing has settled: the watch is still open and the deadline still pending.
    expect(geo.state.cleared).toEqual([]);

    geo.emit(GOOD_ENOUGH_M - 1);
    expect((await pending)?.accuracyM).toBe(GOOD_ENOUGH_M - 1);
  });

  it("ignores samples that arrive after it has settled", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(20);
    const fix = await pending;

    geo.emit(5); // a straggler from a watch the caller already stopped
    geo.fail(2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS * 2);

    expect(fix?.accuracyM).toBe(20);
    expect(geo.state.cleared).toEqual([geo.state.watchId]); // cleared exactly once
  });
});

describe("the hard cap", () => {
  it("returns the best sample seen when the deadline arrives", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(400);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect((await pending)?.accuracyM).toBe(400);
    expect(geo.state.cleared).toEqual([geo.state.watchId]);
  });

  it("does not settle one millisecond early", async () => {
    const geo = fakeGeolocation();
    geo.install();

    let settled = false;
    const pending = acquireFix().then((f) => {
      settled = true;
      return f;
    });
    geo.emit(400);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("resolves to null when the deadline arrives with nothing at all", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(await pending).toBeNull();
  });

  it("asks the device for a high-accuracy, non-cached fix within the same deadline", async () => {
    const geo = fakeGeolocation();
    geo.install();

    void acquireFix();
    expect(geo.state.options).toMatchObject({
      enableHighAccuracy: true,
      timeout: DEADLINE_MS,
      maximumAge: 0, // a cached fix from the last client's driveway is worse than none
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
  });
});

describe("care is never blocked by a sensor", () => {
  it("resolves to null — never rejects — when permission is denied", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.fail(1); // PERMISSION_DENIED

    await expect(pending).resolves.toBeNull();
    // Immediately, without making the caregiver wait out the deadline for a verdict the
    // device already gave.
    expect(geo.state.cleared).toEqual([geo.state.watchId]);
  });

  it("resolves to null when the position is simply unavailable", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.fail(2); // POSITION_UNAVAILABLE
    await expect(pending).resolves.toBeNull();
  });

  it("returns the best sample seen even if the device later errors", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(250);
    geo.fail(3); // TIMEOUT after one usable sample

    expect((await pending)?.accuracyM).toBe(250);
  });

  it("resolves to null when the platform has no geolocation at all", async () => {
    vi.stubGlobal("navigator", {});
    await expect(acquireFix()).resolves.toBeNull();
  });

  it("resolves to null when there is no navigator at all (server render)", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(acquireFix()).resolves.toBeNull();
  });

  it("resolves to null when watchPosition itself throws", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        watchPosition() {
          throw new DOMException("Only secure origins are allowed.", "SecurityError");
        },
        clearWatch() {},
      },
    });
    await expect(acquireFix()).resolves.toBeNull();
  });
});

describe("what a fix is allowed to carry", () => {
  it("emits exactly four fields — no altitude, heading or speed", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(30);
    const fix = await pending;

    expect(Object.keys(fix ?? {}).sort()).toEqual([
      "accuracyM",
      "capturedAt",
      "latitude",
      "longitude",
    ]);
  });

  it("stamps the device's own capture time as an ISO string", async () => {
    const geo = fakeGeolocation();
    geo.install();

    const pending = acquireFix();
    geo.emit(30, { at: Date.parse("2026-08-11T13:05:00.000Z") });

    expect((await pending)?.capturedAt).toBe("2026-08-11T13:05:00.000Z");
  });
});
