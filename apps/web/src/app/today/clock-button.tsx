"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Today · the clock control (docs/17 §7.1, §7.6 · D-022, D-030 · invariant 14)
   ───────────────────────────────────────────────────────────────────────────
   TWO ACTIONS. EVER. `Clock in` → `Clocked in · 9:02 AM · Visit in progress` →
   `Complete visit`. Everything else this component can render is a consequence
   of one of those two taps, and every one of those consequences is a sentence a
   tired person in a stairwell can act on.

   THE VOCABULARY IS A CONTRACT (docs/17 §7.1). The words EVV, GPS, geofence,
   accuracy, radius, metres and coordinates appear nowhere a caregiver can see
   them — not in a label, not in an error, not in a tooltip. The database hands
   this component `distance_bucket` ('inside' | 'near' | 'far') precisely so the
   UI has something honest to say without saying "you are 312 m away" (D-030).

   THE FOUR OUTCOMES, and why each behaves the way it does:

     accepted     The visit advances. The card says when, in words.
     needs_reason A SOFT refusal. The attempt is on the ledger, the visit did
                  not move, and the caregiver is offered `Try again` and
                  `Request exception`. It never blocks care, and it never
                  accuses: the address on file may simply be wrong.
     queued       No network. The tap is committed to this device and replays
                  through the same RPC later; the client_event_id makes that
                  safe by construction, so "tap, lose signal, tap again" cannot
                  produce two clock-ins.
     refused      A CAREOS_* code, already translated into plain language by the
                  server action. Rendered as-is — never a raw database message.

   `Request exception` is offered exactly when the database says `needs_reason`,
   and that is the same thing as "policy allows it": app.clock_visit raises
   CAREOS_GEOFENCE_UNVERIFIED (a hard refusal, no soft path) when
   visit_policy.allow_location_exception is false, so the soft outcome can only
   occur under a policy that permits an exception. If the policy changes between
   the refusal and the request, app.request_location_exception refuses with
   CAREOS_EXCEPTION_NOT_ALLOWED and the caregiver reads that sentence instead.
──────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useT } from "@/lib/i18n/client";
import { IconAlert, IconCheck, IconClock } from "@/components/icons";
import { enqueueClock, listQueue, QUEUE_CHANGED } from "@/lib/offline/queue";
import { deviceSessionId, newUuid } from "@/lib/offline/ids";
import { acquireFix } from "./locate";
import { clockVisit, requestLocationException } from "./actions";
import {
  REASON_CODES,
  type ClockKind,
  type ClockResult,
  type DistanceBucket,
  type ReasonCode,
} from "./contract";

type Mode = ClockKind | "done";

type Phase =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "saving" }
  | { kind: "unverified"; bucket: DistanceBucket | null; form: boolean }
  | { kind: "queued" }
  | { kind: "accepted"; at: string | null; flagged: boolean; replayed: boolean }
  | { kind: "error"; message: string };

/** The reason picker's labels are plain sentences, not enum names: the caregiver is
 *  choosing what happened, not classifying an incident. Keys live in both dictionaries. */
const REASON_KEYS = {
  gps_unavailable: "clock.reasonNoFix",
  alternate_location: "clock.reasonAlternate",
  address_incorrect: "clock.reasonAddressWrong",
  emergency_visit: "clock.reasonEmergency",
  device_issue: "clock.reasonDevice",
  network_failure: "clock.reasonNetwork",
  other: "clock.reasonOther",
} as const;

export function ClockButton({
  visitId,
  mode,
  clockedInLabel = null,
}: {
  visitId: string;
  mode: Mode;
  /** Server-formatted arrival time, so the first paint carries no timezone guess. */
  clockedInLabel?: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [reason, setReason] = useState<ReasonCode | "">("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  // Re-sync server data AFTER the transition has settled, never inside it. The action
  // deliberately does not revalidatePath (see actions.ts): doing so from an action that
  // just wrote to a table this route renders wedges the response stream and the button
  // stays on "Saving…" for ~18 s. refresh() streams over its own request, so the card
  // updates from the returned result immediately and the server view catches up behind it.
  function resync() {
    router.refresh();
  }

  // One idempotency key per user-initiated ATTEMPT, held across that attempt's fallback
  // into the offline queue. A fresh tap mints a fresh key; reusing one would replay an
  // old decision, and minting one mid-attempt would let a lost response double-clock.
  const attemptKey = useRef<string>("");

  // "Saved on this device" must stop being true the moment it stops being true. When the
  // queue drains, either the visit moved (the page revalidates and this control remounts)
  // or the server refused the capture — and in that second case nothing else would clear
  // the held state, leaving a caregiver reading a reassurance that no longer holds. So the
  // control watches the queue it wrote to and returns to idle when its entry is gone,
  // which is also what makes the "clock it again" instruction actionable.
  useEffect(() => {
    if (phase.kind !== "queued") return;
    let alive = true;
    const check = () => {
      void listQueue().then((rows) => {
        if (!alive) return;
        if (!rows.some((r) => r.visitId === visitId && r.event === mode)) setPhase({ kind: "idle" });
      });
    };
    window.addEventListener(QUEUE_CHANGED, check);
    return () => {
      alive = false;
      window.removeEventListener(QUEUE_CHANGED, check);
    };
  }, [phase.kind, visitId, mode]);

  if (mode === "done") {
    return (
      <div className="flex-1">
        <button type="button" disabled className="btn btn-secondary btn-sm min-h-11 w-full">
          <IconCheck width={15} height={15} />
          {t("clock.visitCompleted")}
        </button>
      </div>
    );
  }

  const event: ClockKind = mode;

  function apply(result: ClockResult) {
    if (result.needsReason) {
      setPhase({ kind: "unverified", bucket: result.distanceBucket, form: false });
      return;
    }
    if (!result.ok) {
      setPhase({ kind: "error", message: result.error ?? t("clock.errGeneric") });
      return;
    }
    setPhase({
      kind: "accepted",
      at: result.occurredAt,
      flagged: result.verificationStatus === "exception",
      replayed: result.replayed,
    });
  }

  /** Park the attempt on the device and tell the caregiver plainly that it is held. */
  async function queueOffline(fix: Awaited<ReturnType<typeof acquireFix>>) {
    const stored = await enqueueClock({
      clientEventId: attemptKey.current,
      visitId,
      event,
      capturedAt: fix?.capturedAt ?? new Date().toISOString(),
      latitude: fix?.latitude ?? null,
      longitude: fix?.longitude ?? null,
      accuracyM: fix?.accuracyM ?? null,
      deviceSessionId: deviceSessionId(),
    });
    // A refusal from device storage is surfaced, never swallowed (docs/10 §6: failures
    // surface for retry, never a silent drop).
    setPhase(stored ? { kind: "queued" } : { kind: "error", message: t("clock.errQueueFailed") });
  }

  async function submit() {
    attemptKey.current = newUuid();
    setPhase({ kind: "locating" });

    // Only "Checking location…" is ever shown while this runs. No metres, no accuracy,
    // no coordinates — the multi-pass sampling is invisible by design (D-030).
    const fix = await acquireFix();

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await queueOffline(fix);
      return;
    }

    setPhase({ kind: "saving" });
    startTransition(async () => {
      try {
        const result = await clockVisit({
          visitId,
          event,
          latitude: fix?.latitude ?? null,
          longitude: fix?.longitude ?? null,
          accuracyM: fix?.accuracyM ?? null,
          clientEventId: attemptKey.current,
          capturedAt: fix?.capturedAt ?? new Date().toISOString(),
          offline: false,
          deviceSessionId: deviceSessionId(),
        });
        apply(result);
        if (result.ok) resync();
      } catch {
        // The request never reached the server (signal died mid-tap). Same attempt key,
        // so if it DID reach the server the replay comes back as `replayed: true`.
        await queueOffline(fix);
      }
    });
  }

  function sendReason() {
    if (!reason) return;
    setPhase({ kind: "saving" });
    startTransition(async () => {
      try {
        const result = await requestLocationException(visitId, event, reason, note || null);
        apply(result);
        if (result.ok) resync();
      } catch {
        setPhase({ kind: "error", message: t("clock.errGeneric") });
      }
    });
  }

  const busy = pending || phase.kind === "locating" || phase.kind === "saving";
  const cta =
    phase.kind === "locating"
      ? t("clock.checking")
      : phase.kind === "saving" || pending
        ? t("clock.saving")
        : event === "clock_in"
          ? t("clock.in")
          : t("clock.completeVisit");

  return (
    <div className="min-w-0 flex-1">
      {/* The arrival line: `Clocked in · 9:02 AM`, from the server on first paint and
          from the accepted result after a tap. */}
      {(clockedInLabel || (phase.kind === "accepted" && phase.at)) && (
        <p className="tabular mb-2 flex items-center gap-1.5 text-[13px] font-medium">
          <IconCheck width={14} height={14} style={{ color: "var(--color-success-700)" }} />
          {phase.kind === "accepted" && phase.at
            ? t(event === "clock_in" ? "clock.clockedInAt" : "clock.clockedOutAt", {
                time: new Date(phase.at).toLocaleTimeString(locale, {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })
            : t("clock.clockedInAt", { time: clockedInLabel ?? "" })}
        </p>
      )}

      {/* Still tappable while an attempt is HELD on the device: a caregiver who taps
          again is asking "did that take?", and enqueueClock replaces the held capture
          rather than adding a second one. Disabled only once the server has accepted —
          tapping then would just earn a CAREOS_ALREADY_CLOCKED_IN. */}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || phase.kind === "accepted"}
        className="btn btn-primary btn-sm min-h-11 w-full"
      >
        <IconClock width={15} height={15} />
        {cta}
      </button>

      {/* Each outcome speaks through its own polite live region, so a screen-reader user
          hears the result of their tap without hunting for it. The live regions wrap TEXT
          only — the reason form below sits outside them, because a live region containing
          a select and a textarea re-announces itself as the caregiver fills it in. */}
      {phase.kind === "accepted" && (
        <p className="mt-1.5 text-[12px]" role="status" aria-live="polite" style={{ color: "var(--text-muted)" }}>
          {phase.replayed
            ? t("clock.alreadyRecorded")
            : phase.flagged
              ? t("clock.flaggedForReview")
              : t("clock.visitInProgress")}
        </p>
      )}

      {phase.kind === "queued" && (
        <div
          className="mt-2 rounded-[var(--radius-md)] px-3 py-2.5"
          role="status"
          aria-live="polite"
          style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}
        >
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <IconClock width={14} height={14} />
            {t("clock.queuedTitle")}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed">{t("clock.queuedBody")}</p>
        </div>
      )}

      {phase.kind === "error" && (
        <p
          className="mt-1.5 text-[12px] leading-relaxed"
          role="alert"
          style={{ color: "var(--color-danger-700)" }}
        >
          {phase.message}
        </p>
      )}

      {phase.kind === "unverified" && (
        <div
          className="mt-2 rounded-[var(--radius-md)] px-3 py-3"
          style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}
        >
          <div role="status" aria-live="polite">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">
              <IconAlert width={14} height={14} />
              {t("clock.unverifiedTitle")}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed">
              {phase.bucket === "far"
                ? t("clock.hintFar")
                : phase.bucket === "near"
                  ? t("clock.hintNear")
                  : t("clock.unverifiedBody")}
            </p>
          </div>

          {!phase.form ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-white btn-sm min-h-11"
                onClick={() => void submit()}
                disabled={busy}
              >
                {t("common.tryAgain")}
              </button>
              <button
                type="button"
                className="btn btn-white btn-sm min-h-11"
                onClick={() => setPhase({ kind: "unverified", bucket: phase.bucket, form: true })}
                disabled={busy}
              >
                {t("clock.requestException")}
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <label className="label" htmlFor={`reason-${visitId}`}>
                {t("clock.reasonLabel")}
              </label>
              <select
                id={`reason-${visitId}`}
                className="select w-full"
                value={reason}
                onChange={(e) => setReason(e.target.value as ReasonCode)}
              >
                <option value="">{t("clock.reasonPlaceholder")}</option>
                {REASON_CODES.map((code) => (
                  <option key={code} value={code}>
                    {t(REASON_KEYS[code])}
                  </option>
                ))}
              </select>

              <label className="label mt-2.5" htmlFor={`note-${visitId}`}>
                {t("clock.noteLabel")}
              </label>
              <textarea
                id={`note-${visitId}`}
                className="textarea w-full"
                rows={2}
                maxLength={500}
                value={note}
                placeholder={t("clock.notePlaceholder")}
                onChange={(e) => setNote(e.target.value)}
              />

              <p className="mt-1.5 text-[12px] leading-relaxed">{t("clock.reasonHelp")}</p>

              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm min-h-11"
                  onClick={sendReason}
                  disabled={busy || !reason}
                >
                  {t("clock.reasonSubmit")}
                </button>
                <button
                  type="button"
                  className="btn btn-white btn-sm min-h-11"
                  onClick={() => setPhase({ kind: "unverified", bucket: phase.bucket, form: false })}
                  disabled={busy}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
