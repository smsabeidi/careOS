/**
 * The Daily Huddle Brief (docs/16 §2.1 X5, Wave 1) — the morning page that runs itself.
 *
 * The whole design rests on one separation (invariant 13): **the platform computes, the
 * model narrates.** Every number, date, name, deadline, and COMAR reference in a brief is
 * produced here by SQL under the requesting user's client. The model is handed those facts
 * as ground truth and asked only to rank them and write one line of "why this matters
 * today" per item. It cannot add an item, move a date, or invent a person, because the
 * renderer only ever draws from `facts` — a narration line that references an unknown key
 * is discarded (see `parseNarration`).
 *
 * Invariants honored here:
 *   - 9 (retrieval as the user): every query below runs on the caller's RLS-scoped client.
 *     There is no privileged fact-gathering path; a coordinator's brief contains exactly
 *     what a coordinator may already read on /schedule and /office/compliance.
 *   - 3 (AAL2 for PHI): huddle_brief select AND insert both require app.is_aal2(); an
 *     AAL1 session simply gets no brief instead of a partial one.
 *   - 1 (append-only): briefs are inserted, never updated. One role-wide edition per
 *     (tenant, role, day) plus one per-user edition — the re-run. Latest row wins on read.
 *   - 10 (one chokepoint): narration goes through runCapability('huddle.brief'), so the
 *     registry model pin, kill switch, budget cap, prompt version, and ai_interaction
 *     ledger row all apply.
 *   - 5 (PHI minimizer): `toPromptFacts` is the declared allowlist for this capability.
 *     The model receives structured fields only — item key, composed headline (client or
 *     staff display name, visit time, rule name), due date, COMAR ref, rank. Free-text
 *     notes (`schedule_exception.note`) are kept OUT of the model payload and rendered
 *     only to the human on the AAL2 surface.
 *
 * Degradation contract: a 429, a kill switch, a budget stop, or a malformed completion
 * all end in the same place — `narration = null`, `provider = 'none'`, and a brief that
 * still renders every deterministic fact. AI is an accelerant here, never a dependency.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { digest, runCapability } from "./client";

/* ── Vocabulary ─────────────────────────────────────────────────────────────── */

/** Mirrors the huddle_brief.role_key CHECK constraint (migration 0015). */
export type HuddleRoleKey = "owner" | "coordinator" | "rn" | "caregiver";

export type HuddleGroupKey =
  | "exceptions"
  | "coverage"
  | "obligations"
  | "credentials"
  | "signatures"
  | "drafts"
  | "supervisory"
  | "careplans"
  | "visits";

export const GROUP_LABEL: Record<HuddleGroupKey, string> = {
  exceptions: "Overnight schedule changes",
  coverage: "Today's coverage",
  obligations: "Compliance obligations",
  credentials: "Credentials",
  signatures: "Waiting for a signature",
  drafts: "Unfinished notes",
  supervisory: "Supervisory visits",
  careplans: "Care-plan reviews",
  visits: "Your visits today",
};

export type HuddleTone = "danger" | "warning" | "accent" | "neutral" | "success";

/** One deterministic fact. `key` is what a narration line may reference — nothing else. */
export type HuddleItem = {
  key: string;
  group: HuddleGroupKey;
  /** Composed from structured columns only. Never contains free-text notes. */
  headline: string;
  /** Human-only supporting text (may include operational free text). Not sent to a model. */
  detail: string | null;
  href: string;
  tone: HuddleTone;
  /** Deterministic urgency score: higher sorts first. Computed in code, never by a model. */
  rank: number;
  due_on: string | null;
  source_ref: string | null;
};

export type HuddleCountKey =
  | "exceptions_24h"
  | "visits_today"
  | "visits_unassigned"
  | "obligations_overdue"
  | "obligations_at_risk"
  | "credentials_lapsed"
  | "credentials_expiring"
  | "unsigned_queue"
  | "stale_drafts"
  | "supervisory_open"
  | "care_plan_reviews"
  | "my_visits_today";

export type HuddleFacts = {
  version: 1;
  role: HuddleRoleKey;
  /** Agency-local calendar day (America/New_York) — matches huddle_brief.brief_date. */
  date: string;
  generated_at: string;
  /** Only the counts this role's scope actually computed; absent ≠ zero. */
  counts: Partial<Record<HuddleCountKey, number>>;
  items: HuddleItem[];
};

/** Parsed narration. `items` is the model's ranked selection; `prose` is a plain fallback. */
export type HuddleNarration =
  | { kind: "ranked"; items: { key: string; line: string }[]; closing: string | null }
  | { kind: "prose"; text: string };

export type HuddleBrief = {
  id: string | null;
  role: HuddleRoleKey;
  date: string;
  facts: HuddleFacts;
  narration: HuddleNarration | null;
  provider: string;
  model: string | null;
  createdAt: string;
  /** false when the row could not be written (AAL1 session, grant, race) — facts still render. */
  persisted: boolean;
  /** true when this request generated the brief rather than reading today's row. */
  generated: boolean;
  /** true when this user has not yet recorded their own re-run for today. */
  canRegenerate: boolean;
  /** Honest, human-facing note about a degrade path. null when everything worked. */
  note: string | null;
};

/* ── Agency calendar (Maryland RSA — one timezone, deterministic) ───────────── */

const AGENCY_TZ = "America/New_York";
const pad = (n: number) => String(n).padStart(2, "0");

/** Today's agency-local calendar day as YYYY-MM-DD. */
export function agencyToday(now: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENCY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = f.format(now).split("-").map(Number);
  return `${y}-${pad(m)}-${pad(d)}`;
}

function tzOffsetMs(d: Date): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENCY_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - d.getTime();
}

/** UTC instants bounding an agency-local calendar day (DST-safe: two-pass offset). */
function dayWindow(date: string): { startISO: string; endISO: string } {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ts = naive - tzOffsetMs(new Date(naive));
  ts = naive - tzOffsetMs(new Date(ts));
  return { startISO: new Date(ts).toISOString(), endISO: new Date(ts + 864e5).toISOString() };
}

/** "9:00 am" in agency time. */
function timeOfDay(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

/** Whole days from the agency's today to a YYYY-MM-DD date (negative = past). */
function daysFromToday(date: string | null, today: string): number | null {
  if (!date) return null;
  const [ay, am, ad] = today.split("-").map(Number);
  const [by, bm, bd] = date.slice(0, 10).split("-").map(Number);
  if ([ay, am, ad, by, bm, bd].some((n) => !Number.isFinite(n))) return null;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
}

/* ── Small shared helpers ───────────────────────────────────────────────────── */

type NamePair = { first_name: string; last_name: string };
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}
function personName(v: NamePair | NamePair[] | null | undefined): string | null {
  const p = one(v);
  return p ? `${p.first_name} ${p.last_name}` : null;
}
const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, info: 1 };
const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  info: "Informational",
};

/* ── Fact collectors — each one is SQL under the caller's RLS ───────────────── */

const EXCEPTION_LABEL: Record<string, string> = {
  reschedule: "Reschedule",
  cancellation: "Cancellation",
  no_show: "No-show",
  late_start: "Late start",
  early_end: "Early end",
  reassignment: "Reassignment",
  other: "Schedule exception",
};
const EXCEPTION_RANK: Record<string, number> = {
  no_show: 88,
  cancellation: 84,
  reassignment: 66,
  reschedule: 60,
  late_start: 58,
  early_end: 52,
  other: 50,
};

/** Schedule exceptions logged in the last 24 hours — the "what happened overnight" rail. */
async function collectExceptions(
  supabase: SupabaseClient,
  sinceISO: string
): Promise<{ items: HuddleItem[]; count: number }> {
  const { data, error } = await supabase
    .from("schedule_exception")
    .select("id, kind, note, created_at, visit_id")
    .gte("created_at", sinceISO)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data || data.length === 0) return { items: [], count: 0 };

  const rows = data as { id: string; kind: string; note: string | null; created_at: string; visit_id: string | null }[];
  const visitIds = [...new Set(rows.map((r) => r.visit_id).filter((x): x is string => Boolean(x)))];
  const visitById = new Map<string, { scheduled_start: string; client: string | null }>();
  if (visitIds.length > 0) {
    const { data: visits } = await supabase
      .from("visit")
      .select("id, scheduled_start, client(first_name, last_name)")
      .in("id", visitIds);
    for (const v of (visits ?? []) as { id: string; scheduled_start: string; client: NamePair | NamePair[] | null }[]) {
      visitById.set(v.id, { scheduled_start: v.scheduled_start, client: personName(v.client) });
    }
  }

  const items: HuddleItem[] = rows.slice(0, 5).map((r, i) => {
    const v = r.visit_id ? visitById.get(r.visit_id) : undefined;
    const label = EXCEPTION_LABEL[r.kind] ?? EXCEPTION_LABEL.other;
    const where = v
      ? `${v.client ?? "a client"}, ${timeOfDay(v.scheduled_start)} visit`
      : "an unlinked visit";
    return {
      key: `exc-${i + 1}`,
      group: "exceptions",
      headline: `${label} on ${where}`,
      detail: r.note ? digest(r.note, 160) : null,
      href: "/schedule?filter=exceptions",
      tone: r.kind === "no_show" || r.kind === "cancellation" ? "danger" : "warning",
      rank: (EXCEPTION_RANK[r.kind] ?? 50) - i,
      due_on: null,
      source_ref: null,
    };
  });
  return { items, count: rows.length };
}

/** Today's visits: how many, and how many still have nobody assigned. */
async function collectCoverage(
  supabase: SupabaseClient,
  date: string
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { startISO, endISO } = dayWindow(date);
  const { data, error } = await supabase
    .from("visit")
    .select("id, scheduled_start, status, caregiver_id")
    .gte("scheduled_start", startISO)
    .lt("scheduled_start", endISO)
    .limit(500);
  if (error || !data) return { items: [], counts: {} };

  const rows = data as { id: string; scheduled_start: string; status: string; caregiver_id: string | null }[];
  const live = rows.filter((r) => r.status !== "cancelled");
  const unassigned = live.filter((r) => !r.caregiver_id);
  const counts = { visits_today: live.length, visits_unassigned: unassigned.length };
  if (unassigned.length === 0) return { items: [], counts };

  const first = [...unassigned].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))[0];
  return {
    counts,
    items: [
      {
        key: "cov-open",
        group: "coverage",
        headline: `${unassigned.length} of ${live.length} visits today have no caregiver assigned`,
        detail: `The earliest starts at ${timeOfDay(first.scheduled_start)}.`,
        href: "/schedule?filter=open",
        tone: "danger",
        rank: 74 + Math.min(unassigned.length, 10),
        due_on: null,
        source_ref: null,
      },
    ],
  };
}

type ObligationRow = {
  id: string;
  client_id: string | null;
  staff_id: string | null;
  due_on: string;
  rule_name: string;
  severity: string;
  comar_source_ref: string | null;
  days_until_due: number | null;
  computed_status: string;
};

/** Overdue and at-risk COMAR obligations, ranked by severity × days past due. */
async function collectObligations(
  supabase: SupabaseClient,
  date: string
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { data, error } = await supabase
    .from("cadence_obligation_status")
    .select(
      "id, client_id, staff_id, due_on, rule_name, severity, comar_source_ref, days_until_due, computed_status"
    )
    .in("computed_status", ["overdue", "at_risk"])
    .order("due_on", { ascending: true })
    .limit(500);
  if (error || !data) return { items: [], counts: {} };

  const rows = data as ObligationRow[];
  const counts = {
    obligations_overdue: rows.filter((r) => r.computed_status === "overdue").length,
    obligations_at_risk: rows.filter((r) => r.computed_status === "at_risk").length,
  };

  // Subject names, resolved under the same RLS the compliance page uses.
  const clientIds = [...new Set(rows.map((r) => r.client_id).filter((x): x is string => Boolean(x)))];
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => Boolean(x)))];
  const [{ data: clients }, { data: staff }] = await Promise.all([
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as ({ id: string } & NamePair)[] }),
    staffIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
  ]);
  const nameById = new Map<string, string>();
  for (const c of (clients ?? []) as ({ id: string } & NamePair)[]) {
    nameById.set(c.id, `${c.first_name} ${c.last_name}`);
  }
  for (const s of (staff ?? []) as { id: string; full_name: string }[]) nameById.set(s.id, s.full_name);

  const scored = rows.map((r) => {
    const overdue = r.computed_status === "overdue";
    const days = daysFromToday(r.due_on, date) ?? 0;
    const daysLate = Math.max(0, -days);
    const weight = SEVERITY_WEIGHT[r.severity] ?? 1;
    return {
      row: r,
      overdue,
      daysLate,
      // severity × days late is the ratified ordering; the base keeps overdue above at-risk.
      rank: (overdue ? 92 : 56) + weight * 3 + Math.min(daysLate, 30),
    };
  });
  scored.sort((a, b) => b.rank - a.rank || a.row.due_on.localeCompare(b.row.due_on));

  const items: HuddleItem[] = scored.slice(0, 5).map((s, i) => {
    const subjectId = s.row.client_id ?? s.row.staff_id;
    const subject = (subjectId && nameById.get(subjectId)) || "a restricted record";
    return {
      key: `obl-${i + 1}`,
      group: "obligations",
      headline: `${s.row.rule_name} for ${subject} is ${s.overdue ? "overdue" : "at risk"}`,
      detail: `${SEVERITY_LABEL[s.row.severity] ?? s.row.severity} severity.`,
      href: `/office/compliance?filter=${s.overdue ? "overdue" : "at_risk"}`,
      tone: s.overdue ? "danger" : "warning",
      rank: s.rank - i,
      due_on: s.row.due_on,
      source_ref: s.row.comar_source_ref,
    };
  });
  return { items, counts };
}

type CredentialRow = {
  credential_id: string;
  app_user_id: string;
  credential_type_name: string;
  status: string;
  expires_on: string | null;
  days_to_expiry: number | null;
  expiry_bucket: string;
  blocks_scheduling: boolean;
};

/** Lapsed and expiring-soon credentials; scheduling-blockers outrank the rest. */
async function collectCredentials(
  supabase: SupabaseClient
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { data, error } = await supabase
    .from("credential_expiry")
    .select(
      "credential_id, app_user_id, credential_type_name, status, expires_on, days_to_expiry, expiry_bucket, blocks_scheduling"
    )
    .in("expiry_bucket", ["lapsed", "expiring_soon"])
    .order("expires_on", { ascending: true, nullsFirst: false })
    .limit(200);
  if (error || !data) return { items: [], counts: {} };

  const rows = data as CredentialRow[];
  const counts = {
    credentials_lapsed: rows.filter((r) => r.expiry_bucket === "lapsed").length,
    credentials_expiring: rows.filter((r) => r.expiry_bucket === "expiring_soon").length,
  };

  const staffIds = [...new Set(rows.map((r) => r.app_user_id))];
  const nameById = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: staff } = await supabase.from("app_user").select("id, full_name").in("id", staffIds);
    for (const s of (staff ?? []) as { id: string; full_name: string }[]) nameById.set(s.id, s.full_name);
  }

  const scored = rows.map((r) => {
    const lapsed = r.expiry_bucket === "lapsed";
    const days = r.days_to_expiry ?? 0;
    return {
      row: r,
      lapsed,
      rank: (lapsed ? 90 : 54) + (r.blocks_scheduling ? 8 : 0) + Math.max(0, 14 - Math.max(days, -14)),
    };
  });
  scored.sort((a, b) => b.rank - a.rank);

  const items: HuddleItem[] = scored.slice(0, 5).map((s, i) => {
    const who = nameById.get(s.row.app_user_id) ?? "a team member";
    return {
      key: `cred-${i + 1}`,
      group: "credentials",
      headline: `${who}'s ${s.row.credential_type_name} ${s.lapsed ? "has lapsed" : "expires soon"}`,
      detail: s.row.blocks_scheduling
        ? "This credential blocks scheduling until it is renewed and verified."
        : null,
      href: `/office/credentials?filter=${s.lapsed ? "lapsed" : "expiring"}`,
      tone: s.lapsed ? "danger" : "warning",
      rank: s.rank - i,
      due_on: s.row.expires_on,
      source_ref: null,
    };
  });
  return { items, counts };
}

type QueueRow = {
  id: string;
  status: string;
  updated_at: string;
  client: NamePair | NamePair[] | null;
  form_template: { title: string } | { title: string }[] | null;
};

/**
 * Records that still need a nurse's signature. Mirrors /clinical exactly — same filter,
 * same already-signed exclusion — so the brief and the queue can never disagree.
 */
async function collectSignatureQueue(
  supabase: SupabaseClient,
  detailed: boolean
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { data, error } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, client(first_name, last_name), form_template!inner(title, requires_signature_roles)")
    .in("status", ["draft", "in_review"])
    .filter("form_template.requires_signature_roles", "cs", "{rn}")
    .order("updated_at", { ascending: true })
    .limit(200);
  if (error || !data) return { items: [], counts: {} };

  let queue = data as QueueRow[];
  if (queue.length > 0) {
    const ids = queue.map((q) => q.id);
    const { data: versions } = await supabase.from("form_version").select("id, instance_id").in("instance_id", ids);
    const versionIds = ((versions ?? []) as { id: string; instance_id: string }[]).map((v) => v.id);
    const { data: sigs } = versionIds.length
      ? await supabase.from("signature").select("form_version_id").in("form_version_id", versionIds)
      : { data: [] as { form_version_id: string }[] };
    const signed = new Set(((sigs ?? []) as { form_version_id: string }[]).map((s) => s.form_version_id));
    const signedInstances = new Set(
      ((versions ?? []) as { id: string; instance_id: string }[])
        .filter((v) => signed.has(v.id))
        .map((v) => v.instance_id)
    );
    queue = queue.filter((q) => !signedInstances.has(q.id));
  }

  const counts = { unsigned_queue: queue.length };
  if (queue.length === 0) return { items: [], counts };

  if (!detailed) {
    return {
      counts,
      items: [
        {
          key: "sig-queue",
          group: "signatures",
          headline: `${queue.length} ${queue.length === 1 ? "record is" : "records are"} waiting for a nurse's signature`,
          detail: "Drafted and in review — signing finalizes them on the record.",
          href: "/clinical",
          tone: "accent",
          rank: 44 + Math.min(queue.length, 10),
          due_on: null,
          source_ref: null,
        },
      ],
    };
  }

  const items: HuddleItem[] = queue.slice(0, 4).map((q, i) => {
    const template = one(q.form_template);
    const client = personName(q.client);
    return {
      key: `sig-${i + 1}`,
      group: "signatures",
      headline: `${template?.title ?? "Record"}${client ? ` for ${client}` : ""} is waiting for your signature`,
      detail: `Last updated ${new Date(q.updated_at).toLocaleDateString("en-US", {
        timeZone: AGENCY_TZ,
        month: "short",
        day: "numeric",
      })}.`,
      href: `/office/forms/${q.id}`,
      tone: "accent",
      rank: 58 - i,
      due_on: null,
      source_ref: null,
    };
  });
  return { items, counts };
}

/** Drafts idle for more than 48 hours — saved and safe, but stalled. */
async function collectStaleDrafts(
  supabase: SupabaseClient
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { count, error } = await supabase
    .from("form_instance")
    .select("id", { count: "exact", head: true })
    .eq("status", "draft")
    .lt("updated_at", cutoff);
  const n = error ? 0 : count ?? 0;
  if (n === 0) return { items: [], counts: { stale_drafts: 0 } };
  return {
    counts: { stale_drafts: n },
    items: [
      {
        key: "draft-stale",
        group: "drafts",
        headline: `${n} visit ${n === 1 ? "note has" : "notes have"} sat unfinished for more than 48 hours`,
        detail: "Nothing is lost — they are saved as drafts until someone finishes them.",
        href: "/office/forms",
        tone: "warning",
        rank: 36,
        due_on: null,
        source_ref: null,
      },
    ],
  };
}

/** The signed-in RN's own supervisory visits: overdue first, then the next two weeks. */
async function collectSupervisory(
  supabase: SupabaseClient,
  rnId: string,
  date: string
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { data, error } = await supabase
    .from("supervisory_visit")
    .select("id, kind, status, due_on, completed_on, client(first_name, last_name)")
    .eq("rn_id", rnId)
    .is("completed_on", null)
    .order("due_on", { ascending: true })
    .limit(100);
  if (error || !data) return { items: [], counts: {} };

  const rows = data as {
    id: string;
    kind: string;
    status: string;
    due_on: string;
    completed_on: string | null;
    client: NamePair | NamePair[] | null;
  }[];
  const counts = { supervisory_open: rows.length };

  const near = rows
    .map((r) => ({ row: r, days: daysFromToday(r.due_on, date) ?? 999 }))
    .filter((r) => r.days <= 14)
    .slice(0, 5);

  const items: HuddleItem[] = near.map((s, i) => ({
    key: `sup-${i + 1}`,
    group: "supervisory",
    headline: `${s.row.kind.replace(/_/g, "-")} supervisory visit for ${personName(s.row.client) ?? "a client"} is ${
      s.days < 0 ? "overdue" : s.days === 0 ? "due today" : "coming due"
    }`,
    detail: null,
    href: "/clinical?tab=supervisory",
    tone: s.days < 0 ? "danger" : "warning",
    rank: (s.days < 0 ? 96 : 64) + Math.min(Math.max(-s.days, 0), 30) - i,
    due_on: s.row.due_on,
    source_ref: null,
  }));
  return { items, counts };
}

/** Care plans on the RN's caseload whose review date is inside the next 30 days. */
async function collectCarePlanReviews(
  supabase: SupabaseClient,
  rnId: string,
  date: string
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { data: assignments } = await supabase
    .from("care_team_assignment")
    .select("client_id")
    .eq("user_id", rnId)
    .eq("role_on_case", "rn_case_manager")
    .is("ends_on", null)
    .limit(300);
  const clientIds = [...new Set(((assignments ?? []) as { client_id: string }[]).map((a) => a.client_id))];
  if (clientIds.length === 0) return { items: [], counts: { care_plan_reviews: 0 } };

  const { data, error } = await supabase
    .from("care_plan")
    .select("id, client_id, version, status, title, review_due_on, client(first_name, last_name)")
    .in("client_id", clientIds)
    .order("version", { ascending: false })
    .limit(500);
  if (error || !data) return { items: [], counts: {} };

  type PlanRow = {
    id: string;
    client_id: string;
    version: number;
    status: string;
    title: string | null;
    review_due_on: string | null;
    client: NamePair | NamePair[] | null;
  };
  const latest = new Map<string, PlanRow>();
  for (const p of data as PlanRow[]) if (!latest.has(p.client_id)) latest.set(p.client_id, p);

  const due = [...latest.values()]
    .map((p) => ({ plan: p, days: daysFromToday(p.review_due_on, date) }))
    .filter((p): p is { plan: PlanRow; days: number } => p.days !== null && p.days <= 30)
    .sort((a, b) => a.days - b.days)
    .slice(0, 5);

  const items: HuddleItem[] = due.map((d, i) => ({
    key: `plan-${i + 1}`,
    group: "careplans",
    headline: `Care plan for ${personName(d.plan.client) ?? "a client"} is ${
      d.days < 0 ? "past its review date" : "due for review"
    }`,
    detail: `Version ${d.plan.version} — a review adds a new version and never overwrites the current one.`,
    href: "/clinical?tab=careplans",
    tone: d.days < 0 ? "danger" : "warning",
    rank: (d.days < 0 ? 80 : 50) + Math.min(Math.max(-d.days, 0), 20) - i,
    due_on: d.plan.review_due_on,
    source_ref: null,
  }));
  return { items, counts: { care_plan_reviews: due.length } };
}

/** A caregiver's own day sheet: today's visits, in order, with times and clients. */
async function collectDaySheet(
  supabase: SupabaseClient,
  caregiverId: string,
  date: string
): Promise<{ items: HuddleItem[]; counts: Partial<Record<HuddleCountKey, number>> }> {
  const { startISO, endISO } = dayWindow(date);
  const { data, error } = await supabase
    .from("visit")
    .select("id, scheduled_start, scheduled_end, status, client(first_name, last_name, city)")
    .eq("caregiver_id", caregiverId)
    .gte("scheduled_start", startISO)
    .lt("scheduled_start", endISO)
    .order("scheduled_start", { ascending: true })
    .limit(20);
  if (error || !data) return { items: [], counts: {} };

  const rows = data as {
    id: string;
    scheduled_start: string;
    scheduled_end: string;
    status: string;
    client: (NamePair & { city: string | null }) | (NamePair & { city: string | null })[] | null;
  }[];
  const live = rows.filter((r) => r.status !== "cancelled");

  const items: HuddleItem[] = live.slice(0, 6).map((v, i) => {
    const c = one(v.client);
    return {
      key: `visit-${i + 1}`,
      group: "visits",
      headline: `${timeOfDay(v.scheduled_start)} — ${c ? `${c.first_name} ${c.last_name}` : "a client"}`,
      detail: c?.city ? `${c.city} · until ${timeOfDay(v.scheduled_end)}` : `Until ${timeOfDay(v.scheduled_end)}`,
      href: "/today",
      tone: "accent",
      rank: 40 - i,
      due_on: null,
      source_ref: null,
    };
  });
  return { items, counts: { my_visits_today: live.length } };
}

/* ── Assembly ───────────────────────────────────────────────────────────────── */

/**
 * Build the deterministic payload for one role and day. Every collector runs on the
 * caller's client, so a role only ever sees what RLS already grants it.
 */
export async function assembleFacts(
  supabase: SupabaseClient,
  role: HuddleRoleKey,
  userId: string,
  date: string = agencyToday()
): Promise<HuddleFacts> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const items: HuddleItem[] = [];
  const counts: Partial<Record<HuddleCountKey, number>> = {};
  const absorb = (r: { items: HuddleItem[]; counts?: Partial<Record<HuddleCountKey, number>> }) => {
    items.push(...r.items);
    Object.assign(counts, r.counts ?? {});
  };

  if (role === "owner") {
    const [exc, cov, obl, cred, sig, drafts] = await Promise.all([
      collectExceptions(supabase, since),
      collectCoverage(supabase, date),
      collectObligations(supabase, date),
      collectCredentials(supabase),
      collectSignatureQueue(supabase, false),
      collectStaleDrafts(supabase),
    ]);
    absorb({ items: exc.items, counts: { exceptions_24h: exc.count } });
    absorb(cov);
    absorb(obl);
    absorb(cred);
    absorb(sig);
    absorb(drafts);
  } else if (role === "coordinator") {
    const [exc, cov, obl, cred] = await Promise.all([
      collectExceptions(supabase, since),
      collectCoverage(supabase, date),
      collectObligations(supabase, date),
      collectCredentials(supabase),
    ]);
    absorb({ items: exc.items, counts: { exceptions_24h: exc.count } });
    absorb(cov);
    absorb(obl);
    absorb(cred);
  } else if (role === "rn") {
    const [sig, sup, plans] = await Promise.all([
      collectSignatureQueue(supabase, true),
      collectSupervisory(supabase, userId, date),
      collectCarePlanReviews(supabase, userId, date),
    ]);
    absorb(sig);
    absorb(sup);
    absorb(plans);
  } else {
    absorb(await collectDaySheet(supabase, userId, date));
  }

  items.sort((a, b) => b.rank - a.rank);
  return {
    version: 1,
    role,
    date,
    generated_at: new Date().toISOString(),
    counts,
    items: items.slice(0, 12),
  };
}

/* ── Narration (the only probabilistic step) ────────────────────────────────── */

/**
 * The PHI minimizer for this capability (invariant 5). The model sees composed headlines,
 * dates, COMAR refs, and ranks — never the free-text `detail` field, never a record id,
 * never a URL parameter carrying an identifier.
 */
function toPromptFacts(facts: HuddleFacts): Record<string, unknown> {
  return {
    role: facts.role,
    date: facts.date,
    counts: facts.counts,
    items: facts.items.map((i) => ({
      key: i.key,
      topic: GROUP_LABEL[i.group],
      fact: i.headline,
      due_on: i.due_on,
      source_ref: i.source_ref,
      platform_rank: i.rank,
    })),
  };
}

const NARRATION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "One of the provided item keys, copied exactly." },
          line: {
            type: "string",
            description: "One sentence: what this means for today and the next step.",
          },
        },
        required: ["key", "line"],
        additionalProperties: false,
      },
    },
    closing: {
      type: ["string", "null"],
      description: "Optional one-sentence close, or null.",
    },
  },
  required: ["items", "closing"],
  additionalProperties: false,
} as const;

/** Built-in system prompt. An ACTIVE ai_prompt_template row overrides this (docs/11). */
const HUDDLE_SYSTEM =
  "You are the CareOS huddle narrator for a Maryland home-care agency.\n" +
  "You receive one JSON object of deterministic facts computed by the platform for a single role and date. " +
  "Every count, date, name, and rank in it is ground truth.\n" +
  "Your job is to rank and narrate. Nothing else.\n" +
  "- Use only the provided items. Never add, infer, or recompute a date, count, or deadline, and never mention a person or item that is not in the facts.\n" +
  "- Rank by operational urgency: client safety first, then compliance deadlines, then coverage gaps, then routine work.\n" +
  "- Write for the stated role. One sentence per item: what it means for today and the next step.\n" +
  "- Plain language, sentence case, no exclamation points, no praise, no filler, no headers.\n" +
  "- Do not give clinical advice and do not speculate about causes.";

const ROLE_AUDIENCE: Record<HuddleRoleKey, string> = {
  owner: "the agency owner",
  coordinator: "the scheduling coordinator",
  rn: "the RN case manager",
  caregiver: "the caregiver",
};

type NarrationResult = { narration: HuddleNarration | null; provider: string; model: string | null; note: string | null };

async function narrate(supabase: SupabaseClient, facts: HuddleFacts): Promise<NarrationResult> {
  if (facts.items.length === 0) {
    return { narration: null, provider: "none", model: null, note: null };
  }

  const payload = toPromptFacts(facts);
  const user =
    `Facts JSON for ${ROLE_AUDIENCE[facts.role]} on ${facts.date}:\n` +
    `${JSON.stringify(payload)}\n\n` +
    "Return JSON. Choose the 3 to 6 items that matter most this morning and order them most urgent first. " +
    "Each entry's \"key\" must be copied exactly from an item above, and \"line\" is one sentence for " +
    `${ROLE_AUDIENCE[facts.role]}: what it means for today and the next step. ` +
    "Do not repeat the fact verbatim and do not restate a date the reader can already see.";

  const res = await runCapability(supabase, "huddle.brief", {
    system: HUDDLE_SYSTEM,
    user,
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: { name: "huddle_brief", schema: NARRATION_SCHEMA as unknown as Record<string, unknown> },
    inputDigest: digest(`huddle ${facts.role} ${facts.date} · ${facts.items.length} facts`, 200),
    // Empty fallback text = "no narration"; the deterministic groups carry the brief.
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (text) => text.trim().length === 0,
  });

  const parsed = parseNarration(res.text, facts);
  if (!parsed) {
    return {
      narration: null,
      provider: "none",
      model: null,
      note:
        res.status === "blocked"
          ? res.reason === "budget"
            ? "AI narration is paused for this month's budget — showing live facts."
            : "AI narration is switched off — showing live facts."
          : "AI narration unavailable — showing live facts.",
    };
  }
  return { narration: parsed, provider: res.provider, model: res.model, note: null };
}

/**
 * Validate narration against the facts. A line may only reference a key that exists;
 * anything else is dropped. This is what makes it structurally impossible for the model
 * to introduce a client, date, or deadline of its own.
 */
export function parseNarration(raw: string | null, facts: HuddleFacts): HuddleNarration | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const known = new Set(facts.items.map((i) => i.key));
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text) as { items?: unknown; closing?: unknown };
      const seen = new Set<string>();
      const items = (Array.isArray(obj.items) ? obj.items : [])
        .map((raw) => raw as { key?: unknown; line?: unknown })
        .filter(
          (i): i is { key: string; line: string } =>
            typeof i.key === "string" && typeof i.line === "string" && i.line.trim().length > 0
        )
        .filter((i) => known.has(i.key) && !seen.has(i.key) && (seen.add(i.key), true))
        .slice(0, 6)
        .map((i) => ({ key: i.key, line: i.line.trim() }));
      if (items.length === 0) return null;
      const closing = typeof obj.closing === "string" && obj.closing.trim() ? obj.closing.trim() : null;
      return { kind: "ranked", items, closing };
    } catch {
      return null;
    }
  }
  // A prose narrative (e.g. a nightly batch job that wrote plain text) still renders.
  return { kind: "prose", text };
}

/* ── Persistence ────────────────────────────────────────────────────────────── */

type BriefRow = {
  id: string;
  role_key: string;
  for_user: string | null;
  brief_date: string;
  facts: HuddleFacts;
  narrative: string | null;
  provider: string;
  model: string | null;
  created_at: string;
};

const BRIEF_COLS = "id, role_key, for_user, brief_date, facts, narrative, provider, model, created_at";

/** Per-user editions carry per-user facts; owner and coordinator briefs are role-wide. */
function isPerUserEdition(role: HuddleRoleKey): boolean {
  return role === "rn" || role === "caregiver";
}

async function readTodaysRows(
  supabase: SupabaseClient,
  role: HuddleRoleKey,
  userId: string,
  date: string
): Promise<BriefRow[]> {
  const { data, error } = await supabase
    .from("huddle_brief")
    .select(BRIEF_COLS)
    .eq("role_key", role)
    .eq("brief_date", date)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !data) return [];
  // Oversight (ai.read) can see other people's per-user editions; those are not this
  // reader's brief. Keep only the role-wide edition and this user's own.
  return (data as BriefRow[]).filter((r) => r.for_user === null || r.for_user === userId);
}

function toBrief(row: BriefRow, userId: string, rows: BriefRow[], extra: Partial<HuddleBrief> = {}): HuddleBrief {
  const facts = row.facts;
  return {
    id: row.id,
    role: row.role_key as HuddleRoleKey,
    date: row.brief_date,
    facts,
    narration: parseNarration(row.narrative, facts),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    persisted: true,
    generated: false,
    canRegenerate: !rows.some((r) => r.for_user === userId),
    note: null,
    ...extra,
  };
}

async function tenantIdOf(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.from("app_user").select("tenant_id").eq("id", userId).maybeSingle();
  return (data as { tenant_id: string } | null)?.tenant_id ?? null;
}

/**
 * Generate one brief and record it. `forUser` null writes the role-wide edition; a user id
 * writes that person's own edition (the re-run, and the natural shape for RN/caregiver).
 * A failed insert never fails the brief — the facts still render, marked not recorded.
 */
async function generate(
  supabase: SupabaseClient,
  role: HuddleRoleKey,
  userId: string,
  date: string,
  forUser: string | null
): Promise<HuddleBrief> {
  const facts = await assembleFacts(supabase, role, userId, date);
  const narrated = await narrate(supabase, facts);
  const narrative =
    narrated.narration?.kind === "ranked"
      ? JSON.stringify({
          v: 1,
          items: narrated.narration.items,
          closing: narrated.narration.closing,
        })
      : narrated.narration?.kind === "prose"
        ? narrated.narration.text
        : null;

  const base: HuddleBrief = {
    id: null,
    role,
    date,
    facts,
    narration: narrated.narration,
    provider: narrated.provider,
    model: narrated.model,
    createdAt: new Date().toISOString(),
    persisted: false,
    generated: true,
    canRegenerate: forUser === null,
    note: narrated.note,
  };

  const tenantId = await tenantIdOf(supabase, userId);
  if (!tenantId) return { ...base, note: base.note ?? "This brief was not recorded — no tenant on the session." };

  const { data, error } = await supabase
    .from("huddle_brief")
    .insert({
      tenant_id: tenantId,
      role_key: role,
      for_user: forUser,
      brief_date: date,
      facts,
      narrative,
      provider: narrated.provider,
      model: narrated.model,
      generated_by: userId,
    })
    .select(BRIEF_COLS)
    .single();

  if (error || !data) {
    // 23505 = someone (or another tab) recorded today's brief first. Theirs is the record.
    const rows = await readTodaysRows(supabase, role, userId, date);
    if (rows.length > 0) return toBrief(rows[0], userId, rows);
    return {
      ...base,
      note:
        base.note ??
        "This brief was not recorded on the ledger — a verified session is required. The facts below are live.",
    };
  }

  const row = data as BriefRow;
  return {
    ...base,
    id: row.id,
    createdAt: row.created_at,
    persisted: true,
    canRegenerate: forUser === null,
  };
}

/**
 * The read path every surface calls. Idempotent per (tenant, role, agency-local day):
 * today's row is returned as-is; only the first request of the day pays for assembly and
 * narration. Never throws — a failure anywhere degrades to facts, and facts degrade to an
 * honest "clear morning".
 */
export async function getOrGenerateBrief(
  supabase: SupabaseClient,
  role: HuddleRoleKey,
  userId: string,
  date: string = agencyToday()
): Promise<HuddleBrief> {
  const existing = await readTodaysRows(supabase, role, userId, date);
  if (existing.length > 0) return toBrief(existing[0], userId, existing);
  return generate(supabase, role, userId, date, isPerUserEdition(role) ? userId : null);
}

/**
 * Re-run today's brief against current facts. Append-only: this inserts the caller's OWN
 * edition rather than replacing the role-wide one, so both antecedents stay on the record
 * and the newest row wins on read. One re-run per person per day — the second attempt is
 * refused by the unique index, and the caller reports that honestly instead of pretending.
 */
export async function regenerateBrief(
  supabase: SupabaseClient,
  role: HuddleRoleKey,
  userId: string,
  date: string = agencyToday()
): Promise<{ ok: boolean; reason: string | null }> {
  const rows = await readTodaysRows(supabase, role, userId, date);
  if (rows.some((r) => r.for_user === userId)) {
    return { ok: false, reason: "Today's re-run is already on the record." };
  }
  const brief = await generate(supabase, role, userId, date, userId);
  return brief.persisted
    ? { ok: true, reason: null }
    : { ok: false, reason: brief.note ?? "The brief could not be recorded." };
}
