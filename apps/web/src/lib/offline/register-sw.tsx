"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Offline · service-worker registration (docs/17 §7.6)
   ───────────────────────────────────────────────────────────────────────────
   The first service worker in this app. It exists for ONE reason: a caregiver
   who opens CareOS with no signal should meet a page that explains itself
   instead of the browser's dinosaur. It is deliberately not a caching layer for
   the product.

   What it does NOT do, and must never do: cache a PHI response. public/sw.js
   handles only same-origin GETs for build assets and two static files it
   precaches; every navigation and every API/Server-Action request goes straight
   to the network. See the header of public/sw.js — that file is the security
   boundary, this one is just the switch that turns it on.

   Registration is deferred to `load` so it never competes with the first paint
   on a mid-tier Android, and every failure is swallowed: an unavailable service
   worker degrades the app to "online only", which is exactly where it was
   yesterday. It never degrades correctness — the IndexedDB queue and its replay
   are independent of the worker.
──────────────────────────────────────────────────────────────────────────── */

import { useEffect } from "react";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // No worker: the app stays fully functional online. Nothing to tell the user.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
