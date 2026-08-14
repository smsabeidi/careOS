/**
 * The unified attention queue's read layer (ST-238, Front Door W5).
 *
 * ONE QUEUE, SIX SOURCES, THE CALLER'S OWN EYES. Every query below runs on the
 * user-scoped server client, so each lane is filtered by the same RLS policies that
 * guard its owning surface (invariant 2/9 — there is no privileged read path into this
 * queue, and a coordinator's queue is genuinely narrower than an owner's). Nothing here
 * is materialised, cached or fanned out: the queue is a read, assembled per request.
 *
 * WHAT IS NOT HERE. No model, no scoring, no prediction. Severity comes from
 * `attention-severity.ts` — a table over values Postgres already computed — and ordering
 * is severity then age. A queue that ranked a caregiver's missing clock-out by an LLM's
 * sense of urgency would be exactly the drift invariant 13 forbids.
 *
 * PHI POSTURE (invariant 5, D-030). IDs travel; content is refetched under RLS. Staff and
 * client names are looked up through their own policies and read "(restricted)" when RLS
 * declines rather than falling back to an id. No coordinate, no distance and no free-text
 * clinical evidence is selected. Deep links carry ids only — never a name, never a
 * diagnosis, never a filter that encodes one.
 *
 * DEGRADED LANES ARE NAMED, NEVER SILENT. The design plan's error registry requires a
 * per-source fallback state ("Credential alerts temporarily unavailable"), because a lane
 * that fails quietly turns "nothing is waiting" into a lie. Each source returns its own
 * sentence on failure and the surface renders every one of them.
 *
 * @trace ST-238, docs/designs/intelligent-front-door.md W5, invariants 2, 5, 9, 13
 */

import type { supabaseServer } from "@/lib/supabase/server";
import { kindLabel } from "@/app/operations/components";
import {
  SEVERITY_RANK,
  credentialRung,
  severityFor,
  type AttentionSeverity,
  type AttentionSource,
} from "./attention-severity";
import type { ProposalView } from "./inbox-client";

const AGENCY_TZ = "America/New_York";

/** Per-lane caps. A queue is a working list; a thousand rows is a report. */
const LANE_LIMIT = 40;
/** The ladder's outer rung — nothing further out belongs in an attention queue. */
const CREDENTIAL_LADDER_DAYS = 60;

/* ═══════════════════════════════════════════════════════════════════════════
 * The row a coordinator sees
 * ═══════════════════════════════════════════════════════════════════════════ */

export type AttentionRow = {
  /** Stable list key and the ack identity: lane + the row the lane is about. */
  key: string;
  source: AttentionSource;
  /** The uuid `app.ack_alert` is called with. Never rendered. */
  sourceId: string;
  severity: AttentionSeverity;
  /** One plain line: what happened, in the words a person would use. */
  title: string;
  /** The consequence or the context. Optional; never a restatement of the title. */
  detail: string | null;
  /** Internal deep link to the surface that owns this row. Ids only. */
  href: string | null;
  /** Words for the link, so a screen reader hears where it goes. */
  hrefLabel: string | null;
  /** ISO instant used for ordering only — never rendered raw. */
  at: string;
  /** The same moment in words, formatted on the server so hydration cannot disagree. */
  when: string;
  /** Set on `proposal` rows: the proposal that expands in place below the row. */
  proposalId: string | null;
};

export type LaneFailure = { source: AttentionSource; message: string };

export type AttentionQueue = {
  rows: AttentionRow[];
  /** Lanes that could not be read, each with the sentence the surface renders. */
  failures: LaneFailure[];
  /** How many rows this reader has already acknowledged, so the queue can say so. */
  ackedCount: number;
  /** True when at least one credential row is on the ladder. */
  hasCredentialRows: boolean;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * Row shapes — explicit columns only, never select(*)
 * ═══════════════════════════════════════════════════════════════════════════ */

type CredentialRow = {
  credential_id: string;
  app_user_id: string;
  credential_type_name: string;
  status: string;
  expires_on: string | null;
  days_to_expiry: number | null;
  blocks_scheduling: boolean | null;
};

type ExceptionRow = {
  exception_id: string;
  visit_id: string;
  caregiver_id: string | null;
  kind: string;
  severity: string;
  detected_at: string;
  open: boolean;
};

type ClinicalRow = {
  id: string;
  client_id: string;
  kind: string;
  severity: string;
  summary: string;
  created_at: string;
};

type NotificationRow = {
  id: string;
  template_key: string;
  subject_type: string | null;
  subject_id: string | null;
  title: string;
  created_at: string;
};

type OfferRow = {
  id: string;
  visit_id: string;
  candidate_user_id: string;
  status: string;
  expires_at: string;
  created_at: string;
};

type AckRow = { source: string; source_id: string };

/* ═══════════════════════════════════════════════════════════════════════════
 * Formatting — presentation only, one zone stated explicitly
 * ═══════════════════════════════════════════════════════════════════════════ */

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: AGENCY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dateWords(value: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function humanize(s: string): string {
  const t = s.replace(/[._]/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** What a name becomes when RLS declines to show it. Never an id, never a blank. */
const RESTRICTED = "(restricted)";

/* ═══════════════════════════════════════════════════════════════════════════
 * The one deep-link builder. Internal paths only, ids only (invariant 5).
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Notifications carry a `subject_type` + `subject_id` pair rather than a route. This is a
 * CLOSED allowlist on purpose: a future template that names an unknown subject gets no
 * link at all and says so, rather than assembling a URL out of a string it was handed.
 */
function notificationHref(subjectType: string | null, subjectId: string | null): string | null {
  if (!subjectId) return null;
  switch (subjectType) {
    case "client":
      return `/office/clients/${subjectId}`;
    case "form_instance":
      return `/office/forms/${subjectId}`;
    case "credential":
      return "/office/credentials";
    case "visit":
      return `/operations/exceptions?visit=${subjectId}`;
    case "offer":
      return "/schedule";
    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * The loader
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The user-scoped server client, exactly as `page.tsx` already types it (invariant 6). */
type Client = Awaited<ReturnType<typeof supabaseServer>>;

/**
 * Assemble the queue for the signed-in reader.
 *
 * `pending` is the approvals inbox's OWN pending list, passed in rather than re-queried:
 * `/inbox` remains the only disposition surface (W5), so the queue shows the same rows the
 * board below it disposes, read once.
 */
export async function loadAttentionQueue(
  supabase: Client,
  pending: ProposalView[]
): Promise<AttentionQueue> {
  const nowIso = new Date().toISOString();

  const [ackRes, credentialRes, exceptionRes, clinicalRes, notificationRes, offerRes] =
    await Promise.all([
      // Your own acks. RLS pins this to auth.uid(); there is no "whose" to pass.
      supabase.from("alert_ack").select("source, source_id").limit(1000),
      supabase
        .from("credential_expiry")
        .select(
          "credential_id, app_user_id, credential_type_name, status, expires_on, days_to_expiry, blocks_scheduling"
        )
        .neq("status", "rejected")
        .not("expires_on", "is", null)
        .lte("days_to_expiry", CREDENTIAL_LADDER_DAYS)
        .order("expires_on", { ascending: true })
        .limit(LANE_LIMIT),
      supabase
        .from("visit_exception_state")
        .select("exception_id, visit_id, caregiver_id, kind, severity, detected_at, open")
        .eq("open", true)
        .order("detected_at", { ascending: false })
        .limit(LANE_LIMIT),
      supabase
        .from("clinical_flag")
        .select("id, client_id, kind, severity, summary, created_at")
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(LANE_LIMIT),
      supabase
        .from("notification")
        .select("id, template_key, subject_type, subject_id, title, created_at")
        .is("read_at", null)
        .neq("status", "read")
        .order("created_at", { ascending: false })
        .limit(LANE_LIMIT),
      supabase
        .from("offer")
        .select("id, visit_id, candidate_user_id, status, expires_at, created_at")
        .in("status", ["pending", "notified"])
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(LANE_LIMIT),
    ]);

  const failures: LaneFailure[] = [];
  const fail = (source: AttentionSource, message: string) => failures.push({ source, message });

  const credentials = credentialRes.error ? [] : ((credentialRes.data ?? []) as CredentialRow[]);
  if (credentialRes.error) {
    fail(
      "credential",
      "Credential alerts couldn't be read just now, so this queue is missing that lane. Nothing changed on the credential record — open Credentials to check it directly."
    );
  }

  const exceptions = exceptionRes.error ? [] : ((exceptionRes.data ?? []) as ExceptionRow[]);
  if (exceptionRes.error) {
    fail(
      "exception",
      "Visit findings couldn't be read just now, so this queue is missing that lane. The findings themselves are untouched — open Findings to work them directly."
    );
  }

  // Clinical flags are AAL2 + care-team gated. A reader outside the care team sees an
  // empty lane rather than an error, and that is not a failure worth announcing — an
  // actual read error is.
  const clinical = clinicalRes.error ? [] : ((clinicalRes.data ?? []) as ClinicalRow[]);
  if (clinicalRes.error) {
    fail(
      "clinical",
      "Clinical flags couldn't be read just now, so this queue is missing that lane. No flag was changed or dismissed — open Clinical to review them directly."
    );
  }

  const notifications = notificationRes.error
    ? []
    : ((notificationRes.data ?? []) as NotificationRow[]);
  if (notificationRes.error) {
    fail(
      "notification",
      "Your notifications couldn't be read just now, so this queue is missing that lane. Nothing was marked read."
    );
  }

  const offers = offerRes.error ? [] : ((offerRes.data ?? []) as OfferRow[]);
  if (offerRes.error) {
    fail(
      "offer",
      "Open shift offers couldn't be read just now, so this queue is missing that lane. No offer was accepted, declined or withdrawn — open the schedule to check coverage."
    );
  }

  /* ── Names: ids travel, labels are refetched under the reader's own RLS ──── */

  const staffIds = [
    ...new Set([
      ...credentials.map((c) => c.app_user_id),
      ...exceptions.map((e) => e.caregiver_id).filter((x): x is string => Boolean(x)),
      ...offers.map((o) => o.candidate_user_id),
    ]),
  ];
  const clientIds = [...new Set(clinical.map((f) => f.client_id))];

  const [staffRes, clientRes] = await Promise.all([
    staffIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[], error: null }),
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({
          data: [] as { id: string; first_name: string; last_name: string }[],
          error: null,
        }),
  ]);

  const staffName = new Map(
    ((staffRes.data ?? []) as { id: string; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name ?? RESTRICTED,
    ])
  );
  const clientName = new Map(
    ((clientRes.data ?? []) as { id: string; first_name: string; last_name: string }[]).map((c) => [
      c.id,
      `${c.first_name} ${c.last_name}`,
    ])
  );
  const staffOf = (id: string | null | undefined) => (id ? staffName.get(id) ?? RESTRICTED : "Unassigned");
  const clientOf = (id: string) => clientName.get(id) ?? RESTRICTED;

  /* ── Rows, lane by lane ──────────────────────────────────────────────────── */

  const rows: AttentionRow[] = [];

  // 1 · Proposals — the approvals board's own pending list. No acknowledge button: a
  // proposal is cleared by DECIDING it, and pretending otherwise would let somebody make
  // a draft disappear without approving or rejecting it (invariant 8).
  for (const p of pending) {
    rows.push({
      key: `proposal:${p.id}`,
      source: "proposal",
      sourceId: p.id,
      severity: severityFor("proposal"),
      title: p.title,
      detail: `${p.capabilityName} · ${p.subjectLabel} · nothing is sent until you decide`,
      href: null,
      hrefLabel: null,
      at: p.proposedAt,
      when: stamp(p.proposedAt),
      proposalId: p.id,
    });
  }

  // 2 · Credentials — the 60/30/0 ladder, bucketed on the expiry engine's own number.
  for (const c of credentials) {
    const rung = credentialRung(c.days_to_expiry);
    if (!rung) continue;
    const d = c.days_to_expiry ?? 0;
    const holder = staffOf(c.app_user_id);
    const title =
      d < 0
        ? `${holder}'s ${c.credential_type_name} expired ${days(Math.abs(d))} ago`
        : d === 0
          ? `${holder}'s ${c.credential_type_name} expires today`
          : `${holder}'s ${c.credential_type_name} expires in ${days(d)}`;
    // The consequence, stated once and truthfully per credential type. `blocks_scheduling`
    // is a property of the type, and claiming an enforcement that does not apply to this
    // one would be a compliance claim the platform cannot back up.
    const detail = c.blocks_scheduling
      ? d <= 0
        ? "Expired credentials block scheduling — this is enforced automatically."
        : "When it expires this credential blocks scheduling, and that is enforced automatically."
      : "This credential type does not block scheduling, but it stays on the compliance record.";
    rows.push({
      key: `credential:${c.credential_id}`,
      source: "credential",
      sourceId: c.credential_id,
      severity: severityFor("credential", rung),
      title,
      detail:
        c.status === "verified"
          ? detail
          : `${detail} This credential is recorded as ${humanize(c.status).toLowerCase()}.`,
      href: `/office/credentials?filter=${d <= 0 ? "lapsed" : "expiring"}`,
      hrefLabel: "Open credentials",
      at: c.expires_on ?? nowIso,
      when: c.expires_on ? `Expires ${dateWords(c.expires_on)}` : "No expiry date on file",
      proposalId: null,
    });
  }

  // 3 · Visit findings — severity straight off the exception engine (0047).
  for (const e of exceptions) {
    rows.push({
      key: `exception:${e.exception_id}`,
      source: "exception",
      sourceId: e.exception_id,
      severity: severityFor("exception", e.severity),
      title: `${kindLabel(e.kind)} · ${staffOf(e.caregiver_id)}`,
      detail:
        e.severity === "critical"
          ? "A critical finding holds this visit's hours out of payroll until somebody decides it."
          : "Waiting on a decision. Every decision needs a reason, and the reason stays on the record.",
      href: `/operations/exceptions?visit=${e.visit_id}`,
      hrefLabel: "Open the finding",
      at: e.detected_at,
      when: `Found ${stamp(e.detected_at)}`,
      proposalId: null,
    });
  }

  // 4 · Clinical flags — Critical by the W5 criterion; the flag's own severity is in the
  // words rather than in the chip, so nothing is hidden by the escalation.
  for (const f of clinical) {
    rows.push({
      key: `clinical:${f.id}`,
      source: "clinical",
      sourceId: f.id,
      severity: severityFor("clinical"),
      title: `${clientOf(f.client_id)} · ${humanize(f.kind)}`,
      detail: `${f.summary} Recorded severity: ${humanize(f.severity)}.`,
      href: "/clinical?tab=flags",
      hrefLabel: "Open clinical flags",
      at: f.created_at,
      when: `Flagged ${stamp(f.created_at)}`,
      proposalId: null,
    });
  }

  // 5 · Notifications — titles are template-rendered and PHI-free by construction (0036).
  for (const n of notifications) {
    const href = notificationHref(n.subject_type, n.subject_id);
    rows.push({
      key: `notification:${n.id}`,
      source: "notification",
      sourceId: n.id,
      severity: severityFor("notification"),
      title: n.title,
      detail: href
        ? null
        : "This alert doesn't point at a screen you can open. Acknowledge it once you've read it.",
      href,
      hrefLabel: href ? "Open the record" : null,
      at: n.created_at,
      when: stamp(n.created_at),
      proposalId: null,
    });
  }

  // 6 · Open offers — the shift is still uncovered until somebody replies.
  for (const o of offers) {
    rows.push({
      key: `offer:${o.id}`,
      source: "offer",
      sourceId: o.id,
      severity: severityFor("offer"),
      title: `Shift offer to ${staffOf(o.candidate_user_id)} is waiting on a reply`,
      detail: `Expires ${stamp(o.expires_at)}. The shift stays uncovered until it is accepted.`,
      href: `/schedule?fill=${o.visit_id}`,
      hrefLabel: "Open coverage",
      at: o.created_at,
      when: stamp(o.created_at),
      proposalId: null,
    });
  }

  /* ── Acks: filter out what this reader has already cleared ───────────────── */

  const acked = new Set(
    ((ackRes.data ?? []) as AckRow[]).map((a) => `${a.source}:${a.source_id}`)
  );
  const visible = rows.filter((r) => !acked.has(r.key));
  const ackedCount = rows.length - visible.length;

  // Severity first, then the longest-waiting (or soonest-due) row. Ties break on the key
  // so the order is total and a re-render never shuffles two equal rows.
  visible.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byAge = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (byAge !== 0) return byAge;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return {
    rows: visible,
    failures,
    ackedCount,
    hasCredentialRows: visible.some((r) => r.source === "credential"),
  };
}
