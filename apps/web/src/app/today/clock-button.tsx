"use client";

import { useState, useTransition } from "react";
import { clockVisit } from "./actions";
import { IconCheck, IconClock } from "@/components/icons";

/** Web EVV clock control. Captures the caregiver's location once (permission-gated) and
 *  records a clock in/out event. If location is denied it still clocks in (method 'web'). */
export function ClockButton({
  visitId,
  mode,
}: {
  visitId: string;
  mode: "clock_in" | "clock_out" | "done";
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (mode === "done") {
    return (
      <button type="button" disabled className="btn btn-secondary btn-sm min-h-11 flex-1">
        <IconCheck width={15} height={15} />
        Visit completed
      </button>
    );
  }

  function submit(coords: { lat: number; lng: number; acc: number } | null) {
    startTransition(async () => {
      const res = await clockVisit(visitId, mode as "clock_in" | "clock_out", coords);
      if (!res.ok) setError(res.error ?? "Couldn't record the visit event. Nothing was saved. Try again.");
    });
  }

  function onClick() {
    setError(null);
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => submit({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
        () => submit(null), // location denied — still clock, without coordinates
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    } else {
      submit(null);
    }
  }

  return (
    <div className="flex-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="btn btn-primary btn-sm min-h-11 w-full"
      >
        <IconClock width={15} height={15} />
        {pending ? "Saving…" : mode === "clock_in" ? "Clock in" : "Clock out"}
      </button>
      {error && (
        <p className="mt-1 text-[12px]" style={{ color: "var(--color-danger-700)" }}>{error}</p>
      )}
    </div>
  );
}
