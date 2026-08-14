"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Is there a signal? — the read-only half of the offline story
   ───────────────────────────────────────────────────────────────────────────
   `useConnection` answers the same question, but it also OWNS THE FLUSH of the
   clock queue, and that ownership is deliberately singular: one owner means two
   components can never walk the same queued entry. So a component that merely
   wants to know whether the phone has a signal must not reach for it — four
   visit cards mounting useConnection would be four flush owners.

   This hook holds nothing, drains nothing, and writes nothing. It reads the
   browser's own belief and re-reads it on `online`, `offline` and on the tab
   becoming visible again (Android throttles background tabs, so the event may
   have fired while nothing was listening).

   The default is `true` — optimistic, matching useConnection, so a healthy phone
   never paints a flash of "no connection" before hydration settles.
──────────────────────────────────────────────────────────────────────────── */

import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const read = () => setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    read();

    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };

    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", read);
      window.removeEventListener("offline", read);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return online;
}
