"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Today · Live / Syncing (n) / Offline (docs/10 §6, docs/17 §7.6)
   ───────────────────────────────────────────────────────────────────────────
   Three honest states and no fourth. The chip is always present, so a caregiver
   learns where to look before they need it; the amber panel appears only when
   something is actually owed, and it names the number rather than implying it.

   This component owns the REPLAY. It is the single place that drains the
   IndexedDB queue through app.clock_visit, and it is the only caller of
   replayQueuedClock — one owner means two components can never walk the same
   entry. (Idempotency would make that harmless; "harmless" is not "correct".)

   THE OUTCOME OF A REPLAY IS NEVER SWALLOWED. A queued clock can come back from
   the server refused — the caregiver really was away from the address on file,
   and app.clock_visit recorded the attempt without starting the visit. Hiding
   that would leave somebody believing they clocked in when the record says they
   did not. So a replay that lands anywhere other than "accepted" is counted and
   said out loud, with the one instruction that actually helps: open the visit
   and clock it again, where the reason picker is waiting.
──────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { IconAlert, IconCheck, IconClock } from "@/components/icons";
import { useConnection } from "@/lib/offline/use-connection";
import type { QueuedClock } from "@/lib/offline/queue";
import { replayQueuedClock } from "./actions";

export function ConnectionStatus() {
  const t = useT();
  const router = useRouter();
  const [needsAttention, setNeedsAttention] = useState(0);
  const changed = useRef(false);

  const replay = useCallback(async (item: QueuedClock) => {
    const { delivered, result } = await replayQueuedClock({
      visitId: item.visitId,
      event: item.event,
      latitude: item.latitude,
      longitude: item.longitude,
      accuracyM: item.accuracyM,
      clientEventId: item.clientEventId,
      capturedAt: item.capturedAt,
      offline: true,
      deviceSessionId: item.deviceSessionId,
    });
    if (delivered && result.ok) changed.current = true;
    if (delivered && !result.ok) setNeedsAttention((n) => n + 1);
    return { delivered };
  }, []);

  const { online, pending, syncing, flush } = useConnection(replay);

  // Refresh once per drain, not once per entry: the visit cards below need to catch up
  // with the events that just landed, and one round-trip is enough to do it.
  useEffect(() => {
    if (syncing || !changed.current) return;
    changed.current = false;
    router.refresh();
  }, [syncing, router]);

  const state = !online ? "offline" : pending > 0 || syncing ? "syncing" : "live";

  return (
    <div>
      <span
        className={`chip ${state === "offline" ? "chip-warning" : state === "syncing" ? "chip-info" : "chip-neutral"}`}
      >
        {state === "offline" ? (
          <IconAlert width={12} height={12} />
        ) : state === "syncing" ? (
          <IconClock width={12} height={12} />
        ) : (
          <IconCheck width={12} height={12} />
        )}
        {state === "offline"
          ? t("offline.offline")
          : state === "syncing"
            ? t("offline.syncing", { count: pending })
            : t("offline.live")}
      </span>

      {(state !== "live" || needsAttention > 0) && (
        <div
          className="mt-3 rounded-[var(--radius-md)] px-4 py-3"
          style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}
          role="status"
          aria-live="polite"
        >
          {state === "offline" && (
            <>
              <p className="text-[14px] font-semibold">{t("offline.offlineTitle")}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed">
                {pending > 0 ? t("offline.offlineHeld", { count: pending }) : t("offline.offlineBody")}
              </p>
            </>
          )}

          {state === "syncing" && (
            <>
              <p className="text-[14px] font-semibold">{t("offline.syncingTitle")}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed">
                {t("offline.syncingBody", { count: pending })}
              </p>
              <button
                type="button"
                className="btn btn-white btn-sm mt-2.5 min-h-11"
                onClick={flush}
                disabled={syncing}
              >
                {t("offline.sendNow")}
              </button>
            </>
          )}

          {needsAttention > 0 && (
            <p className={`text-[13px] leading-relaxed ${state === "live" ? "" : "mt-2"}`}>
              {t("offline.needsAttention", { count: needsAttention })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
