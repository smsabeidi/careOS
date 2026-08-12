"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Today · acquiring a position for a clock event (docs/17 §7.1, board §10)
   ───────────────────────────────────────────────────────────────────────────
   WHY THIS IS NOT `getCurrentPosition`. The first fix a phone produces is very
   often a cell-tower or coarse-Wi-Fi estimate — hundreds of metres wide — and
   it arrives in under a second because it is essentially a guess. The GPS or
   fused fix that follows a few seconds later is the real one. Submitting the
   first fix therefore fails legitimate caregivers who are standing in the right
   doorway, and turns a hardware warm-up into an exception with somebody's name
   on it. app.evaluate_location judges accuracy BEFORE distance precisely
   because a wide fix has verified nothing.

   So: watch, keep the best fix seen, stop early once it is good enough, and
   give up after a hard cap. The cap matters as much as the sampling — a
   caregiver at a door is not going to stand there while a phone thinks, and a
   visit must always be clockable. Whatever we have at the deadline is what we
   send; nothing at all is also a lawful answer (DN-0046b: a missing position is
   a location status, not an error).

   THIS FUNCTION NEVER SHOWS A NUMBER. The caller renders "Checking location…"
   and nothing else. Accuracy in metres is diagnostic evidence for the RLS-gated
   admin surfaces (D-030); a caregiver is never told they are "312 m away" or
   that their fix is "±48 m", because that is surveillance-grade precision
   serving no operational purpose in the field.
──────────────────────────────────────────────────────────────────────────── */

export type Fix = {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** Device clock at capture. Diagnostics only — the server timestamps the event. */
  capturedAt: string;
};

/** Good enough to stop sampling: comfortably inside the tightest policy accuracy floor
 *  (visit_policy.max_accuracy_m defaults to 250, and a tightened tier is smaller still). */
const GOOD_ENOUGH_M = 60;

/** Hard ceiling on the whole acquisition. A caregiver waits seconds, not a minute. */
const DEADLINE_MS = 8_000;

/**
 * Best-effort position for one clock attempt.
 *
 * Resolves with the tightest fix seen before the deadline, or `null` when the
 * device produced nothing at all (permission denied, no receiver, airplane
 * mode). It NEVER rejects: a clock attempt must proceed either way.
 */
export function acquireFix(): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }

    let best: Fix | null = null;
    let settled = false;
    let watchId: number | null = null;
    let timer: number | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (timer !== null) window.clearTimeout(timer);
      resolve(best);
    };

    const consider = (position: GeolocationPosition) => {
      const candidate: Fix = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: Number.isFinite(position.coords.accuracy)
          ? position.coords.accuracy
          : Number.POSITIVE_INFINITY,
        capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
      };
      if (!best || candidate.accuracyM < best.accuracyM) best = candidate;
      // Good enough — stop draining the radio and let the caregiver get on with the visit.
      if (candidate.accuracyM <= GOOD_ENOUGH_M) finish();
    };

    try {
      watchId = navigator.geolocation.watchPosition(
        consider,
        () => {
          // A permission refusal or a hardware error ends the attempt immediately: there
          // will be no fix, and making the caregiver wait out the deadline for a verdict
          // the device already gave is just a slower "no".
          finish();
        },
        { enableHighAccuracy: true, timeout: DEADLINE_MS, maximumAge: 0 }
      );
    } catch {
      finish();
      return;
    }

    timer = window.setTimeout(finish, DEADLINE_MS);
  });
}
