// ST-151 · The automation-runtime worker — the Edge half of the 0034 runtime plane.
//
// One POST-only function, invoked every minute by pg_cron → pg_net ('careos_queue_pump').
// It drains q_events (real consumers below) and q_notify (Phase-3 stub), then heartbeats.
// Security posture:
//   * The gate is a shared secret in the x-careos-worker-secret header, compared in
//     constant time. The function deploys with --no-verify-jwt because pg_net cannot
//     mint Supabase JWTs — the secret header IS the auth layer (see README.md).
//   * service_role lives only here, in Edge Function secrets (invariant 6). Everything
//     the worker can touch in the DB is bounded by the 0034 service_role RPC contract —
//     the function is a thin REST client; Postgres remains the authority.
//   * Queue messages are IDs-only (invariant 5). Logs and responses carry msg ids,
//     event types, and error CLASSES — never payload contents, names, or free text.
//     CAREOS_* error codes are PHI-free by definition (docs/08 §2), so they may travel.
// Poison semantics (S8-2): a message that fails five deliveries is archived (quarantined
// in pgmq's archive table) with a false heartbeat so it pages instead of wedging the queue.
// @trace: ST-151, invariants 5/6/7, S8-2, docs/11 §7

import { createClient } from "jsr:@supabase/supabase-js@2";

// ── Environment ───────────────────────────────────────────────────────────────────────
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are platform-injected into every Edge
// Function; CAREOS_WORKER_SECRET is set explicitly (`supabase secrets set`).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WORKER_SECRET = Deno.env.get("CAREOS_WORKER_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Every DB call goes through the service_role contract in schema "app" (0034).
const app = supabase.schema("app");

// ── Contract types (0027 message shape, 0034 RPC returns) ─────────────────────────────
type QueueName = "q_events" | "q_notify";

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  message: { type?: string; event_id?: string; tenant_id?: string };
}

interface DomainEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

interface DocumentLocation {
  bucket: string;
  storage_path: string;
}

interface DrainResult {
  processed: number;
  archived: number;
  failed: number;
  classes: string[];
}

// ── PHI-safe errors ───────────────────────────────────────────────────────────────────
// Every throw site constructs a SafeError whose klass is built from vetted tokens only
// (RPC name, CAREOS_* code, SQLSTATE, HTTP status). Unexpected runtime errors surface
// as their constructor name alone — a raw .message never reaches a log or response.
class SafeError extends Error {
  constructor(public readonly klass: string) {
    super(klass);
    this.name = "SafeError";
  }
}

function classOf(e: unknown): string {
  if (e instanceof SafeError) return e.klass;
  if (e instanceof Error) return e.name || "Error";
  return "UnknownError";
}

function safeToken(error: { message?: string | null; code?: string | null }): string {
  const careos = (error.message ?? "").match(/CAREOS_[A-Z_]+/);
  return careos ? careos[0] : error.code ?? "error";
}

// ── RPC + heartbeat helpers ───────────────────────────────────────────────────────────
async function appRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await app.rpc(fn, args);
  if (error) throw new SafeError(`rpc.${fn}:${safeToken(error)}`);
  return data as T;
}

async function heartbeat(jobKey: string, ok: boolean, error?: string): Promise<void> {
  try {
    await appRpc<void>("worker_heartbeat", {
      p_job_key: jobKey,
      p_ok: ok,
      p_error: error ?? null,
    });
  } catch (e) {
    // A failed heartbeat write must never fail the pass — staleness is itself the
    // alarm the deadman layers watch for.
    console.error(`worker: heartbeat write for ${jobKey} failed: ${classOf(e)}`);
  }
}

// ── Auth: constant-time shared-secret check ───────────────────────────────────────────
// Hash both sides first: the byte compare then runs over fixed-length digests, so its
// timing leaks nothing about where the secrets diverge — no extra dependency needed.
async function authorized(req: Request): Promise<boolean> {
  const given = req.headers.get("x-careos-worker-secret");
  if (!WORKER_SECRET || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(WORKER_SECRET)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

// ── Handler: identity.separated (0032 saga, Phase 2 — the external steps) ─────────────
// The DB already closed every policy at commit (0022 active-principal closure: every
// tenant-pinned policy fails closed mid-token) — this lane closes the auth layer too.
//
// Contract deviation, deliberate and verified against supabase/auth (master): the task
// sheet calls for auth.admin.signOut(entity_id, 'global') as a second call, but that
// primitive does not exist — supabase-js's admin.signOut() takes a logged-in session
// JWT (it proxies POST /logout), which the worker never holds, and the Auth server
// exposes NO admin logout-by-user-id route. What DOES exist: the ban itself is enforced
// on every token grant including refresh ("Invalid Refresh Token: User Banned",
// internal/tokens/service.go), so one admin call both bans and renders every refresh
// token unusable immediately. The residual access-token tail (≤1 h) carries zero
// authority in CareOS because of 0022. A hard session delete (auth.sessions) would need
// a 0035 definer RPC — flagged to the main session, not improvised here.
//
// Each step is idempotent: the ban re-applies harmlessly and
// complete_revocation_step_system replays as already_done.
async function handleIdentitySeparated(ev: DomainEvent): Promise<void> {
  const userId = ev.entity_id;
  if (!userId) throw new SafeError("event.missing_entity");

  // Ban: no new sessions, no refresh grants. GoTrue has no 'permanent', so 87600h
  // (~10 years); rehire is a fresh account by design (0032 header), never an unban.
  const { error: banErr } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: "87600h",
  });
  if (banErr) {
    throw new SafeError(`auth.ban:${(banErr as { status?: number }).status ?? "error"}`);
  }

  // Write the machine steps back to the checklist — each an audited row (0034).
  await appRpc("complete_revocation_step_system", {
    p_tenant: ev.tenant_id,
    p_user: userId,
    p_step: "auth_ban",
    p_note: "worker: supabase admin api",
  });
  await appRpc("complete_revocation_step_system", {
    p_tenant: ev.tenant_id,
    p_user: userId,
    p_step: "refresh_revoke",
    p_note:
      "worker: supabase admin api (ban blocks all refresh grants; no session-delete admin endpoint exists)",
  });
  // Honest no-op: there is no mobile app yet, so no push tokens can exist. Completing
  // the step with a truthful note beats leaving the checklist eternally pending.
  await appRpc("complete_revocation_step_system", {
    p_tenant: ev.tenant_id,
    p_user: userId,
    p_step: "push_invalidate",
    p_note: "worker: no push tokens exist yet (no mobile app)",
  });
}

// ── Handler: document.destroy (0029 saga, phase 2 — blob GC then row removal) ─────────
async function handleDocumentDestroy(ev: DomainEvent): Promise<void> {
  const docId = ev.entity_id;
  if (!docId) throw new SafeError("event.missing_entity");

  // Null means either the row is already gone (crash-replay after the blob delete) or
  // destruction was never stamped. complete_document_destruction distinguishes them:
  // already_gone for the former, CAREOS_BAD_STATE (→ retry/poison, pages) for the
  // latter — an unstamped destroy event is an anomaly worth a human's eyes.
  const loc = await appRpc<DocumentLocation | null>("read_document_for_destruction", {
    p_document: docId,
  });
  if (loc?.bucket && loc?.storage_path) {
    // Storage removal is idempotent: removing an already-deleted key does not error.
    const { error } = await supabase.storage.from(loc.bucket).remove([loc.storage_path]);
    if (error) throw new SafeError("storage.remove");
  }
  await appRpc("complete_document_destruction", { p_document: docId });
}

// ── Routing ───────────────────────────────────────────────────────────────────────────
async function handleEventMessage(msg: QueueMessage): Promise<void> {
  const type = msg.message?.type;

  if (type === "identity.separated" || type === "document.destroy") {
    if (!msg.message.event_id) throw new SafeError("event.missing_id");
    // IDs travel, content is refetched (invariant 5): the message names the event, the
    // domain_event row is the truth acted on.
    const ev = await appRpc<DomainEvent | null>("read_domain_event", {
      p_event: msg.message.event_id,
    });
    // The outbox row commits in the same transaction as the send — absence is an
    // anomaly, so fail toward retry/poison rather than silently dropping a cue.
    if (!ev) throw new SafeError("event.not_found");
    if (type === "identity.separated") await handleIdentitySeparated(ev);
    else await handleDocumentDestroy(ev);
    return;
  }

  // Consumers for the remaining event families arrive with Phase-4 wiring. Until then,
  // acknowledge and archive so the queue stays level. Type only — never the payload.
  console.log(`worker: q_events no consumer for '${type ?? "untyped"}' — archived`);
}

function handleNotifyMessage(msg: QueueMessage): Promise<void> {
  // Phase-3 lands the real senders (Resend, links-only per D-005). Archiving with an
  // honest log beats letting q_notify back up against a sender that does not exist.
  console.log(`notify: no sender configured — archived type '${msg.message?.type ?? "untyped"}'`);
  return Promise.resolve();
}

// ── Drain: one bounded batch per queue per invocation ─────────────────────────────────
// The pump fires every minute, so throughput comes from cadence, not loops — a bounded
// batch keeps each invocation short and lets the visibility timeout (60 s) do retries.
async function drain(
  queue: QueueName,
  jobKey: string,
  handler: (m: QueueMessage) => Promise<void>,
): Promise<DrainResult> {
  const res: DrainResult = { processed: 0, archived: 0, failed: 0, classes: [] };

  let batch: QueueMessage[];
  try {
    batch = (await appRpc<QueueMessage[]>("queue_read", {
      p_queue: queue,
      p_vt_seconds: 60,
      p_batch: 10,
    })) ?? [];
  } catch (e) {
    const cls = classOf(e);
    console.error(`worker: ${queue} read failed: ${cls}`);
    res.failed = 1;
    res.classes.push(cls);
    await heartbeat(jobKey, false, cls);
    return res;
  }

  let clean = true;
  for (const msg of batch) {
    try {
      await handler(msg);
      await appRpc<boolean>("queue_archive", { p_queue: queue, p_msg_id: msg.msg_id });
      res.processed++;
      res.archived++;
    } catch (e) {
      const cls = classOf(e);
      clean = false;
      res.failed++;
      res.classes.push(cls);
      console.error(
        `worker: ${queue} msg ${msg.msg_id} (read_ct ${msg.read_ct}) failed: ${cls}`,
      );
      if (msg.read_ct >= 5) {
        // Poisoned: five deliveries is enough. Quarantine to the pgmq archive table so
        // the queue cannot wedge (S8-2); the false heartbeat is what pages a human.
        try {
          await appRpc<boolean>("queue_archive", { p_queue: queue, p_msg_id: msg.msg_id });
          res.archived++;
        } catch {
          // Archive failure leaves the message for the next pass — nothing to add here.
        }
        await heartbeat(jobKey, false, `poison:${cls}`);
      }
      // read_ct < 5: leave it un-archived; the visibility timeout redelivers it.
    }
  }

  // Only a clean pass advances the heartbeat — lingering failures let it go stale,
  // which is exactly the signal check_heartbeats/health_check exist to catch.
  if (clean) await heartbeat(jobKey, true);
  return res;
}

// ── Entry ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!(await authorized(req))) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const events = await drain("q_events", "worker.q_events", handleEventMessage);
    const notify = await drain("q_notify", "worker.q_notify", handleNotifyMessage);
    // Counts and error classes only — this body lands in pg_net's response log.
    return Response.json({
      processed: events.processed + notify.processed,
      archived: events.archived + notify.archived,
      failed: events.failed + notify.failed,
      failure_classes: [...new Set([...events.classes, ...notify.classes])],
    });
  } catch (e) {
    const cls = classOf(e);
    console.error(`worker: pass aborted: ${cls}`);
    await heartbeat("worker.q_events", false, cls);
    return Response.json(
      { processed: 0, archived: 0, failed: 1, failure_classes: [cls] },
      { status: 500 },
    );
  }
});
