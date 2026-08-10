/* ─────────────────────────────────────────────────────────────────────────────
   Offline · the clock queue (docs/17 §7.6, D-022 · invariant 5)
   ───────────────────────────────────────────────────────────────────────────
   A caregiver works in basements, stairwells and rural dead zones. The clock
   must therefore be a LOCAL commit that syncs, not a network call that fails:
   the tap lands in IndexedDB, the caregiver walks away, and the queue replays
   through the SAME RPC on reconnect. app.clock_visit makes replay safe by
   construction — the client_event_id is unique per (tenant, visit, attempt), so
   a duplicate delivery returns `replayed: true` instead of a second event.

   WHAT MAY BE QUEUED — and the reasoning, because this file is the one place in
   the web app that writes to durable device storage:
     · Queued: visit_id (an ID, invariant 5's "IDs travel"), the event kind, the
       device's own position for that attempt, the device capture time, and two
       opaque ids. Nothing identifies a client: no name, no address, no note, no
       diagnosis, no schedule.
     · NOT queued: anything a person typed. A location-exception REASON is never
       queued — it needs the rejected event to already exist server-side, so it is
       an online-only action by construction (see today/actions.ts). That keeps
       every free-text field out of device storage entirely.
     · Deleted on success. An entry lives exactly as long as it is undelivered.

   The whole module degrades to `null`/no-op when IndexedDB is missing or blocked
   (private-mode Safari, hardened enterprise profiles). Callers treat that as
   "could not queue" and say so in plain language — never a silent drop, which is
   the docs/10 §6 rule for offline writes.
──────────────────────────────────────────────────────────────────────────── */

const DB_NAME = "careos-offline";
const DB_VERSION = 1;
const STORE = "clock_queue";

/** Broadcast on every queue mutation so the connection indicator recounts without polling. */
export const QUEUE_CHANGED = "careos:offline-queue-changed";

export type ClockKind = "clock_in" | "clock_out";

export type QueuedClock = {
  /** Idempotency key — the reason replay is safe (D-022). Also the IndexedDB key. */
  clientEventId: string;
  visitId: string;
  event: ClockKind;
  /** Device clock at capture. Diagnostics only: the server's time is authoritative (§3.6). */
  capturedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  deviceSessionId: string;
  queuedAt: string;
  attempts: number;
};

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clientEventId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const transaction = db.transaction(STORE, mode);
          const request = run(transaction.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          transaction.oncomplete = () => db.close();
          transaction.onabort = () => {
            db.close();
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      })
  );
}

function announce(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGED));
}

/**
 * Park a clock attempt on the device. Returns false when storage refused it.
 *
 * ONE PENDING INTENT PER (visit, event). A caregiver who taps "Clock in" again while an
 * earlier attempt is still held has not asked to arrive twice — they have asked whether
 * the first one took. So the newer capture REPLACES the older rather than joining it in
 * the queue: two entries would both deliver, the second would come back
 * CAREOS_ALREADY_CLOCKED_IN, and the caregiver would be told something went wrong when
 * nothing did. (Correctness never depended on this — the database's idempotency key means
 * neither entry could produce a second clock-in — but a queue that mirrors intent is the
 * one a person can reason about.) The superseded capture is a device-local draft that was
 * never delivered anywhere, so dropping it destroys no record of consequence.
 */
export async function enqueueClock(
  item: Omit<QueuedClock, "queuedAt" | "attempts">
): Promise<boolean> {
  const held = await listQueue();
  for (const row of held) {
    if (row.visitId === item.visitId && row.event === item.event) {
      await tx<undefined>("readwrite", (store) => store.delete(row.clientEventId));
    }
  }
  const row: QueuedClock = { ...item, queuedAt: new Date().toISOString(), attempts: 0 };
  const key = await tx<IDBValidKey>("readwrite", (store) => store.put(row));
  announce();
  return key !== null;
}

/** Everything still undelivered, oldest first — the order the day actually happened in. */
export async function listQueue(): Promise<QueuedClock[]> {
  const rows = await tx<QueuedClock[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedClock[]>);
  return (rows ?? []).slice().sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function queueSize(): Promise<number> {
  const n = await tx<number>("readonly", (store) => store.count());
  return n ?? 0;
}

/** Delivered (or provably replayed) — the entry has done its job and goes away. */
export async function dequeueClock(clientEventId: string): Promise<void> {
  await tx<undefined>("readwrite", (store) => store.delete(clientEventId));
  announce();
}

/** A delivery attempt that did not land. The entry stays; the count is evidence, not a limit. */
export async function noteAttempt(clientEventId: string): Promise<void> {
  const existing = await tx<QueuedClock | undefined>(
    "readonly",
    (store) => store.get(clientEventId) as IDBRequest<QueuedClock | undefined>
  );
  if (!existing) return;
  await tx<IDBValidKey>("readwrite", (store) =>
    store.put({ ...existing, attempts: existing.attempts + 1 })
  );
  announce();
}
