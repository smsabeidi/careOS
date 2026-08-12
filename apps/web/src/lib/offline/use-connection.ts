"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Offline · the three honest states (docs/10 §6, docs/17 §7.6)
   ───────────────────────────────────────────────────────────────────────────
   Live · Syncing (n) · Offline. Three states, no fourth, and none of them lies:
   "Live" means the queue is empty AND the browser believes it has a network;
   "Syncing (n)" names the exact number of taps still owed to the server; and
   "Offline" is stated plainly rather than hidden behind an optimistic spinner.
   Failures surface for retry — a queued write is never silently dropped.

   The hook owns the FLUSH, and it is the only thing that does. The clock button
   enqueues and walks away; a single owner means two components can never race
   the same entry (idempotency would make that harmless, but "harmless" is not
   the same as "correct", and one owner is easier to reason about at 6am in a
   basement).

   Flush triggers, in the order they matter: the browser's `online` event, the
   tab becoming visible again (Android throttles background tabs, so `online`
   may have fired while nothing was listening), a mount, and a slow poll as the
   backstop for the several mobile browsers whose `online` event is a rumour.
──────────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dequeueClock,
  listQueue,
  noteAttempt,
  QUEUE_CHANGED,
  type QueuedClock,
} from "./queue";

/** What the replayer must answer. `delivered` means the server owns it now — accepted,
 *  replayed, or refused on its merits. Anything else leaves the entry queued. */
export type ReplayResult = { delivered: boolean };
export type Replay = (item: QueuedClock) => Promise<ReplayResult>;

export type ConnectionState = {
  /** The browser's own belief. Never presented as a promise that a request will succeed. */
  online: boolean;
  /** Entries still owed to the server. */
  pending: number;
  /** A flush is in flight right now. */
  syncing: boolean;
  /** Force a flush — the manual "Try now" affordance. */
  flush: () => void;
};

const POLL_MS = 20_000;

export function useConnection(replay: Replay): ConnectionState {
  // Optimistic default: assume connected until the browser says otherwise, so the first
  // paint on a healthy phone is not a flash of "Offline".
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Refs, not state: the flush loop must see the current replayer and must not be able
  // to start a second pass while the first is still walking the queue.
  const replayRef = useRef(replay);
  replayRef.current = replay;
  const busy = useRef(false);

  const recount = useCallback(async () => {
    const rows = await listQueue();
    setPending(rows.length);
  }, []);

  const flush = useCallback(async () => {
    if (busy.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await recount();
      return;
    }
    busy.current = true;
    setSyncing(true);
    try {
      const rows = await listQueue();
      for (const row of rows) {
        let result: ReplayResult = { delivered: false };
        try {
          result = await replayRef.current(row);
        } catch {
          // A thrown server action is a transport failure: the entry stays put.
          result = { delivered: false };
        }
        if (result.delivered) await dequeueClock(row.clientEventId);
        else await noteAttempt(row.clientEventId);
      }
    } finally {
      busy.current = false;
      setSyncing(false);
      await recount();
    }
  }, [recount]);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    void recount();
    void flush();

    const goOnline = () => {
      setOnline(true);
      void flush();
    };
    const goOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setOnline(navigator.onLine);
      void flush();
    };
    const onQueueChanged = () => {
      void recount();
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(QUEUE_CHANGED, onQueueChanged);
    const timer = window.setInterval(() => {
      setOnline(navigator.onLine);
      void flush();
    }, POLL_MS);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(QUEUE_CHANGED, onQueueChanged);
      window.clearInterval(timer);
    };
  }, [flush, recount]);

  return { online, pending, syncing, flush: () => void flush() };
}
