/* ─────────────────────────────────────────────────────────────────────────────
   Offline · identity for a field action (docs/17 §7.6, D-022)
   ───────────────────────────────────────────────────────────────────────────
   Two opaque identifiers, both generated on the device, neither carrying a
   fact about anybody (invariant 5 — nothing here can be traced to a client or
   a diagnosis; they are random bytes with a lifetime).

     · client_event_id — the idempotency key for ONE clock attempt. The database
       holds a partial unique index on (tenant_id, visit_id, client_event_id), so
       app.clock_visit answers a repeat with `replayed: true` instead of a second
       ledger row. This is what makes "tap, lose signal, tap again, come back
       online and flush the queue" safe BY CONSTRUCTION rather than by luck.

       One id per user-initiated ATTEMPT — reused across that attempt's retries
       and its offline queueing, never across a fresh tap. Reusing it after a
       refusal would replay the refusal forever; minting a new one mid-attempt
       would let a lost response become a double clock-in.

     · device_session_id — a per-tab, per-session opaque handle the clock engine
       stores beside the event for the §4.5 fraud rules (two devices, one badge).
       sessionStorage, so it dies with the tab and never becomes a durable
       tracker. Storage is wrapped: hardened profiles and private-mode Safari
       throw on access, and chrome must never be the reason a caregiver cannot
       clock in.
──────────────────────────────────────────────────────────────────────────── */

const DEVICE_SESSION_KEY = "careos-device-session";

/** RFC 4122 v4. `crypto.randomUUID` where it exists (secure contexts), else built by hand
 *  from CSPRNG bytes — an insecure-context fallback must not silently become Math.random. */
export function newUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // No CSPRNG at all: return a value the database will still treat as one attempt.
  // Collision risk is the caller's own tab, and the visit_id scopes the unique index.
  return `nocrypto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The opaque handle for this browser tab's session. Stable across taps, gone on close. */
export function deviceSessionId(): string {
  try {
    const existing = sessionStorage.getItem(DEVICE_SESSION_KEY);
    if (existing) return existing;
    const fresh = newUuid();
    sessionStorage.setItem(DEVICE_SESSION_KEY, fresh);
    return fresh;
  } catch {
    // Storage unavailable (private mode, locked-down profile). A per-call id is still
    // a truthful "one device session" for this action; it just isn't reused.
    return newUuid();
  }
}
