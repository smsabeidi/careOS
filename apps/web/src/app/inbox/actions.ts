"use server";

/**
 * Approvals-inbox server actions (docs/16 Wave 2 — the chase engine).
 *
 * Two things happen here, and the split between them is the point:
 *
 *  1. `generateChaseDrafts` — the DETERMINISTIC engines pick what deserves a chase
 *     (credential expiry buckets, the cadence engine's overdue/at-risk verdicts, draft
 *     age, logged schedule exceptions). Those facts are computed in SQL and INJECTED
 *     into the prompt as ground truth; the model is never asked when something is due,
 *     whether it blocks scheduling, or whether anyone is eligible (invariant 13). The
 *     model only writes the sentences — and when it is unavailable, the deterministic
 *     draft it would have rewritten is what lands. Nothing about this surface requires
 *     a working model.
 *
 *  2. `disposeProposal` — the human's decision, written twice on purpose:
 *     an append-only `ai_proposal_event` (the operational fact: who approved what, in
 *     their words, with their edited text preserved beside the original) and an
 *     `ai_disposition` row through `recordDisposition` (the flywheel — the training
 *     label keyed to the exact model + prompt version that produced the draft, docs/16
 *     §3.2). A proposal is never UPDATEd to say "approved": the row is immutable and
 *     `public.ai_proposal_status` derives the state from the event ledger (invariant 1).
 *
 * Invariant 8 lives in the database: the event insert is self-pinned to auth.uid() under
 * AAL2, so there is no path that disposes on someone else's behalf, and no path that
 * executes a T2 capability without a human. These actions are the convenience layer over
 * that gate, never a substitute for it.
 */

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import {
  digest,
  recordDisposition,
  runCapability,
  type DispositionAction,
  type DispositionReason,
} from "@/lib/ai/client";

/** Registry key for every draft this surface writes (docs/16 §3.2 keying rule). */
const CAPABILITY_KEY = "chase.draft";

/** Who may dispose a proposal. RLS is the real perimeter; this is the honest error. */
const DISPOSE_ROLES = ["owner", "admin", "coordinator", "hr", "rn"];
/** Who may ask the drafter to run. */
const GENERATE_ROLES = ["owner", "admin", "coordinator"];

const MAX_DRAFTS_PER_RUN = 5;
const DEDUPE_WINDOW_DAYS = 30;
const STALE_DRAFT_HOURS = 48;
const EXCEPTION_WINDOW_HOURS = 48;
const MAX_BODY_CHARS = 8000;
const AGENCY_TZ = "America/New_York";

/* ═══════════════════════════════════════════════════════════════════════════
 * Small shared helpers
 * ═══════════════════════════════════════════════════════════════════════════ */

type NamePair = { first_name: string; last_name: string };

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

function fullName(p: NamePair | NamePair[] | null | undefined): string | null {
  const n = one(p);
  return n ? `${n.first_name} ${n.last_name}` : null;
}

function firstName(name: string | null | undefined): string | null {
  const n = name?.trim();
  return n ? n.split(/\s+/)[0] : null;
}

/** Calendar date in the agency's timezone — display only; the engines own the math. */
function fmtDate(value: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string | null {
  if (!value) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    timeZone: AGENCY_TZ,
    month: "long",
    day: "numeric",
    ...opts,
  });
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

async function tenantOf(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.from("app_user").select("tenant_id").eq("id", userId).maybeSingle();
  return (data as { tenant_id: string } | null)?.tenant_id ?? null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * disposeProposal — approve / approve with edits / reject
 * ═══════════════════════════════════════════════════════════════════════════ */

type DisposeDecision = "approve" | "approve_edited" | "reject";

/** Mirrors ai_proposal_event.action; the derived status follows from the last event. */
const EVENT_FOR: Record<DisposeDecision, "approve" | "edit" | "reject"> = {
  approve: "approve",
  approve_edited: "edit",
  reject: "reject",
};

/** Mirrors ai_disposition.action — the flywheel label for the same human decision. */
const LABEL_FOR: Record<DisposeDecision, DispositionAction> = {
  approve: "accepted",
  approve_edited: "edited",
  reject: "rejected",
};

const REASON_LABEL: Record<DispositionReason, string> = {
  wrong: "Wrong",
  tone: "Tone",
  unsafe: "Unsafe",
  incomplete: "Incomplete",
  other: "Other",
};

const ALREADY: Record<string, string> = {
  approved: "already approved",
  edited: "already approved with edits",
  rejected: "already rejected",
  executed: "already approved and sent",
  expired: "expired",
};

/**
 * Record a human disposition over one proposal.
 *
 * Returns rather than throws: a failed label must never cost the coordinator the draft
 * they are looking at. `flywheel` reports honestly whether the training pair landed —
 * a deterministic draft has no model output to label, and saying so is better than
 * implying a label was captured.
 */
export async function disposeProposal(
  proposalId: string,
  decision: DisposeDecision,
  editedBody?: string,
  reasonCode?: DispositionReason,
  note?: string
): Promise<{
  ok: boolean;
  error?: string;
  /** The state the proposal is in after this call (derived from the event ledger). */
  status?: string;
  flywheel?: "recorded" | "no_model_output" | "not_recorded";
}> {
  const id = proposalId?.trim();
  if (!id) return { ok: false, error: "That proposal could not be identified." };

  const profile = await getProfile();
  if (!profile) return { ok: false, error: "Your session has ended. Sign in again to continue." };
  if (!profile.roles.some((r) => DISPOSE_ROLES.includes(r))) {
    return { ok: false, error: "Your role cannot dispose proposals in this inbox." };
  }

  const supabase = await supabaseServer();

  // The proposal itself (RLS-scoped, AAL2-gated). Explicit columns, never select(*).
  const { data: proposalRow, error: loadErr } = await supabase
    .from("ai_proposal")
    .select("id, tenant_id, capability_key, body, ai_interaction_id")
    .eq("id", id)
    .maybeSingle();

  if (loadErr || !proposalRow) {
    return {
      ok: false,
      error:
        "That proposal is not available on this session. It may need a verified (MFA) session, or it may not be yours to see.",
    };
  }
  const proposal = proposalRow as {
    id: string;
    tenant_id: string;
    capability_key: string;
    body: string | null;
    ai_interaction_id: string | null;
  };

  // Derived current state — the view is the ratified reader of the event ledger.
  const { data: statusRow } = await supabase
    .from("ai_proposal_status")
    .select("status")
    .eq("proposal_id", id)
    .maybeSingle();
  const current = (statusRow as { status: string } | null)?.status ?? "pending";
  if (current !== "pending") {
    return {
      ok: false,
      status: current,
      error: `This proposal was ${ALREADY[current] ?? current}. Nothing was changed — the earlier decision stands on the record.`,
    };
  }

  const trimmedEdit = editedBody?.trim().slice(0, MAX_BODY_CHARS) ?? "";
  if (decision === "approve_edited") {
    if (!trimmedEdit) return { ok: false, error: "Add your edited message before approving with edits." };
    if (trimmedEdit === (proposal.body ?? "").trim()) {
      return { ok: false, error: "The message is unchanged. Use approve if the draft is right as written." };
    }
  }
  if (decision === "reject" && !reasonCode) {
    return { ok: false, error: "Choose a reason so the rejection can be used as evaluation data." };
  }

  const humanNote = note?.trim().slice(0, 1000) || "";
  const composedNote =
    decision === "reject"
      ? [REASON_LABEL[reasonCode as DispositionReason] ?? "Other", humanNote].filter(Boolean).join(" — ")
      : humanNote || null;

  // The operational fact: an append-only event, self-pinned to this human (invariant 8).
  const { error: eventErr } = await supabase.from("ai_proposal_event").insert({
    tenant_id: proposal.tenant_id,
    proposal_id: proposal.id,
    action: EVENT_FOR[decision],
    note: composedNote,
    edited_body: decision === "approve_edited" ? trimmedEdit : null,
    actor: profile.userId,
  });
  if (eventErr) {
    return {
      ok: false,
      error:
        "The decision could not be saved. Nothing was changed or sent. A verified (MFA) session is required to dispose proposals.",
    };
  }

  // The training label. A draft with no model output behind it has nothing to label —
  // linking a disposition to a call that never produced the text would poison the pair.
  let flywheel: "recorded" | "no_model_output" | "not_recorded" = "no_model_output";
  if (proposal.ai_interaction_id) {
    const res = await recordDisposition(
      supabase,
      proposal.ai_interaction_id,
      proposal.capability_key || CAPABILITY_KEY,
      LABEL_FOR[decision],
      reasonCode,
      decision === "approve_edited" ? trimmedEdit : undefined
    );
    flywheel = res.ok ? "recorded" : "not_recorded";
  }

  revalidatePath("/inbox");
  const nextStatus =
    decision === "reject" ? "rejected" : decision === "approve_edited" ? "edited" : "approved";
  return { ok: true, status: nextStatus, flywheel };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * generateChaseDrafts — deterministic candidates, model-written sentences
 * ═══════════════════════════════════════════════════════════════════════════ */

type Candidate = {
  /** Bucket used to interleave categories so one noisy source can't fill the run. */
  source: "credential" | "obligation" | "draft" | "exception";
  subjectType: string;
  subjectId: string;
  title: string;
  /** What ships when no model answers. This is the acceptance bar, not the fallback. */
  body: string;
  /** Why the engine proposed it — deterministic, never model-authored. */
  rationale: string;
  /** SQL-computed ground truth handed to the model as facts (invariant 13). */
  facts: Record<string, unknown>;
  /** PHI-safe ledger digest: buckets, counts and enums; no names. */
  factsDigest: string;
  payload: Record<string, unknown>;
};

/** Built-in prompt; an ACTIVE registry template (chase.draft.v1) overrides it. */
const CHASE_SYSTEM =
  "You write the short message a home-care coordinator would otherwise phone or text.\n" +
  "You receive deterministic facts computed by the platform. Those facts are ground truth: never " +
  "recompute, adjust, or invent a date, a deadline, or a consequence that is not in them.\n" +
  "Write to one person in plain language: what the item is, the date that matters, what to do next, " +
  "and who to reply to. Two to five sentences. Include the least identifying detail that still makes " +
  "the message clear — a first name is enough. Never include a diagnosis, an address, a date of birth, " +
  "or anything about a third party.\n" +
  "Neutral and specific: no blame, no pressure, no invented deadlines, no incentives. Sentence case, " +
  "no exclamation points, no emoji, no signature block.\n" +
  "This is a draft. A coordinator reads it, edits it if needed, and decides whether it is sent.";

const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
  additionalProperties: false,
};

function parseDraftBody(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { body?: unknown };
    return typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : null;
  } catch {
    return null;
  }
}

/* ── Candidate collectors — each one is SQL under the caller's RLS ─────────── */

/** C4 — credential renewal chase. Buckets come from the expiry engine, not from here. */
async function collectCredentialCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from("credential_expiry")
    .select(
      "credential_id, app_user_id, credential_type_name, expires_on, days_to_expiry, expiry_bucket, blocks_scheduling"
    )
    .in("expiry_bucket", ["lapsed", "expiring_soon"])
    .order("expires_on", { ascending: true, nullsFirst: false })
    .limit(25);
  if (error || !data?.length) return [];

  const rows = data as {
    credential_id: string;
    app_user_id: string;
    credential_type_name: string;
    expires_on: string | null;
    days_to_expiry: number | null;
    expiry_bucket: string;
    blocks_scheduling: boolean;
  }[];

  const staffIds = [...new Set(rows.map((r) => r.app_user_id))];
  const { data: staff } = await supabase.from("app_user").select("id, full_name").in("id", staffIds);
  const nameById = new Map(
    ((staff ?? []) as { id: string; full_name: string | null }[]).map((s) => [s.id, s.full_name ?? ""])
  );

  return rows.map((r) => {
    const who = nameById.get(r.app_user_id) || "This team member";
    const first = firstName(who) ?? "there";
    const lapsed = r.expiry_bucket === "lapsed";
    const when = fmtDate(r.expires_on) ?? "the date on file";
    const blocks = r.blocks_scheduling
      ? lapsed
        ? " Until it is verified, the scheduler cannot assign you new visits."
        : " If it lapses, the scheduler pauses new assignments until it is back on file."
      : "";
    return {
      source: "credential" as const,
      subjectType: "credential",
      subjectId: r.credential_id,
      title: `Credential renewal — ${who}, ${lapsed ? "lapsed" : "expires"} ${fmtDate(r.expires_on, { month: "short" }) ?? "soon"}`,
      body:
        `Hi ${first} — your ${r.credential_type_name} ${lapsed ? `lapsed on ${when}` : `expires on ${when}`}. ` +
        `Send a photo of the renewal document and the office will verify it and update your file.${blocks} ` +
        `Reply to the office if anything about the renewal is unclear.`,
      rationale: `The credential engine places this in the ${lapsed ? "lapsed" : "expiring-soon"} bucket (expires ${when})${
        r.blocks_scheduling ? " and this credential blocks scheduling" : ""
      }.`,
      facts: {
        item: "credential_renewal",
        recipient_first_name: first,
        credential_type: r.credential_type_name,
        expires_on: r.expires_on,
        days_to_expiry: r.days_to_expiry,
        expiry_bucket: r.expiry_bucket,
        blocks_scheduling: r.blocks_scheduling,
        channel: "sms",
        reply_to: "the office",
      },
      factsDigest: `credential renewal: bucket=${r.expiry_bucket}, days=${r.days_to_expiry ?? "n/a"}, blocks_scheduling=${r.blocks_scheduling}`,
      payload: {
        channel: "sms",
        href: `/office/credentials?filter=${lapsed ? "lapsed" : "expiring"}`,
        credential_id: r.credential_id,
        blocks_scheduling: r.blocks_scheduling,
      },
    };
  });
}

/** C5 — COMAR obligation cure. The cadence engine decides overdue/at-risk; we chase it. */
async function collectObligationCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from("cadence_obligation_status")
    .select("id, client_id, staff_id, due_on, rule_name, severity, comar_source_ref, days_until_due, computed_status")
    .in("computed_status", ["overdue", "at_risk"])
    .order("due_on", { ascending: true })
    .limit(25);
  if (error || !data?.length) return [];

  const rows = data as {
    id: string;
    client_id: string | null;
    staff_id: string | null;
    due_on: string;
    rule_name: string;
    severity: string;
    comar_source_ref: string | null;
    days_until_due: number | null;
    computed_status: string;
  }[];

  const clientIds = [...new Set(rows.map((r) => r.client_id).filter((x): x is string => Boolean(x)))];
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => Boolean(x)))];
  const [{ data: clients }, { data: staff }] = await Promise.all([
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as ({ id: string } & NamePair)[] }),
    staffIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);
  const nameById = new Map<string, string>();
  for (const c of (clients ?? []) as ({ id: string } & NamePair)[]) {
    nameById.set(c.id, `${c.first_name} ${c.last_name}`);
  }
  for (const s of (staff ?? []) as { id: string; full_name: string | null }[]) {
    nameById.set(s.id, s.full_name ?? "a team member");
  }

  return rows.map((r) => {
    const subjectId = r.client_id ?? r.staff_id;
    const subject = (subjectId && nameById.get(subjectId)) || "a restricted record";
    const first = firstName(subject) ?? "this record";
    const overdue = r.computed_status === "overdue";
    const daysLate = r.days_until_due !== null ? Math.max(0, -r.days_until_due) : null;
    const when = fmtDate(r.due_on) ?? r.due_on;
    return {
      source: "obligation" as const,
      subjectType: "obligation",
      subjectId: r.id,
      title: `${r.rule_name} — ${subject}, ${overdue ? "overdue" : "at risk"}`,
      body:
        `The ${r.rule_name.toLowerCase()} for ${first} is ${
          overdue
            ? `overdue${daysLate ? ` by ${daysLate} ${daysLate === 1 ? "day" : "days"}` : ""}`
            : `due on ${when}`
        }. ` +
        `Reply with a day that works this week and the office will book it and open the form.` +
        (r.comar_source_ref ? ` This cadence comes from ${r.comar_source_ref}.` : ""),
      rationale: `The cadence engine computed this obligation as ${overdue ? "overdue" : "at risk"} against its due date of ${when}${
        r.comar_source_ref ? ` (${r.comar_source_ref})` : ""
      }.`,
      facts: {
        item: "obligation_cure",
        rule_name: r.rule_name,
        subject_first_name: first,
        due_on: r.due_on,
        days_until_due: r.days_until_due,
        computed_status: r.computed_status,
        severity: r.severity,
        comar_source_ref: r.comar_source_ref,
        channel: "in_app",
        reply_to: "the office",
      },
      factsDigest: `obligation cure: status=${r.computed_status}, severity=${r.severity}, days_until_due=${r.days_until_due ?? "n/a"}`,
      payload: {
        channel: "in_app",
        href: `/office/compliance?filter=${overdue ? "overdue" : "at_risk"}`,
        obligation_id: r.id,
        comar_source_ref: r.comar_source_ref,
      },
    };
  });
}

/** C8 — stale-draft nudge. Idle drafts are safe; they are just not finished. */
async function collectStaleDraftCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from("form_instance")
    .select("id, updated_at, created_by, client(first_name, last_name), form_template(title)")
    .eq("status", "draft")
    .lt("updated_at", isoHoursAgo(STALE_DRAFT_HOURS))
    .order("updated_at", { ascending: true })
    .limit(15);
  if (error || !data?.length) return [];

  const rows = data as {
    id: string;
    updated_at: string;
    created_by: string;
    client: NamePair | NamePair[] | null;
    form_template: { title: string } | { title: string }[] | null;
  }[];

  const authorIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
  const { data: authors } = authorIds.length
    ? await supabase.from("app_user").select("id, full_name").in("id", authorIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const authorById = new Map(
    ((authors ?? []) as { id: string; full_name: string | null }[]).map((a) => [a.id, a.full_name ?? ""])
  );

  return rows.map((r) => {
    const template = one(r.form_template)?.title ?? "Record";
    const client = fullName(r.client);
    const clientFirst = firstName(client);
    const author = firstName(authorById.get(r.created_by) ?? "") ?? "there";
    const when = fmtDate(r.updated_at) ?? "earlier this week";
    return {
      source: "draft" as const,
      subjectType: "form_instance",
      subjectId: r.id,
      title: `Unfinished ${template.toLowerCase()}${client ? ` — ${client}` : ""}`,
      body:
        `Hi ${author} — your ${template.toLowerCase()}${clientFirst ? ` for ${clientFirst}` : ""} from ${when} is still a draft. ` +
        `Nothing is lost: it stays saved exactly as you left it until it is finished. ` +
        `Open it, check the last sections and finalize it when you have a moment.`,
      rationale: `The record has been in draft with no edit since ${when}, past the ${STALE_DRAFT_HOURS}-hour mark used by the exception board.`,
      facts: {
        item: "stale_draft",
        recipient_first_name: author,
        template_title: template,
        client_first_name: clientFirst,
        last_updated_on: r.updated_at,
        idle_hours_threshold: STALE_DRAFT_HOURS,
        channel: "in_app",
        reply_to: "the office",
      },
      factsDigest: `stale draft: template=${template}, idle>${STALE_DRAFT_HOURS}h`,
      payload: { channel: "in_app", href: `/office/forms/${r.id}`, form_instance_id: r.id },
    };
  });
}

const EXCEPTION_LABEL: Record<string, string> = {
  reschedule: "reschedule",
  cancellation: "cancellation",
  no_show: "no-show",
  late_start: "late start",
  early_end: "early end",
  reassignment: "reassignment",
  other: "schedule exception",
};

/** C3 — schedule-exception follow-up. Detection is deterministic; the note is drafted. */
async function collectExceptionCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from("schedule_exception")
    .select("id, kind, note, created_at, visit_id")
    .gte("created_at", isoHoursAgo(EXCEPTION_WINDOW_HOURS))
    .in("kind", ["no_show", "cancellation", "reassignment"])
    .order("created_at", { ascending: false })
    .limit(15);
  if (error || !data?.length) return [];

  const rows = data as {
    id: string;
    kind: string;
    note: string | null;
    created_at: string;
    visit_id: string | null;
  }[];

  const visitIds = [...new Set(rows.map((r) => r.visit_id).filter((x): x is string => Boolean(x)))];
  const { data: visits } = visitIds.length
    ? await supabase
        .from("visit")
        .select("id, scheduled_start, client(first_name, last_name)")
        .in("id", visitIds)
    : { data: [] as { id: string; scheduled_start: string; client: NamePair | NamePair[] | null }[] };
  const visitById = new Map(
    ((visits ?? []) as { id: string; scheduled_start: string; client: NamePair | NamePair[] | null }[]).map((v) => [
      v.id,
      { start: v.scheduled_start, client: fullName(v.client) },
    ])
  );

  return rows
    .filter((r) => r.visit_id && visitById.has(r.visit_id))
    .map((r) => {
      const visit = visitById.get(r.visit_id as string);
      const client = visit?.client ?? null;
      const clientFirst = firstName(client) ?? "your family member";
      const label = EXCEPTION_LABEL[r.kind] ?? EXCEPTION_LABEL.other;
      const day = fmtDate(visit?.start, { weekday: "long", month: "long", day: "numeric" }) ?? "the scheduled day";
      return {
        source: "exception" as const,
        subjectType: "visit",
        subjectId: r.visit_id as string,
        title: `Follow-up — ${label}${client ? ` on ${client}'s visit` : ""}`,
        body:
          `We are following up on the ${day} visit for ${clientFirst}, which was recorded as a ${label}. ` +
          `The office is arranging cover and will confirm a new time. ` +
          `Call the office if a different day this week would work better.`,
        rationale: `A ${label} exception was logged on this visit within the last ${EXCEPTION_WINDOW_HOURS} hours and no follow-up contact is on record.`,
        facts: {
          item: "exception_followup",
          exception_kind: r.kind,
          visit_day: visit?.start ?? null,
          client_first_name: clientFirst,
          channel: "sms",
          reply_to: "the office",
        },
        factsDigest: `exception follow-up: kind=${r.kind}, window=${EXCEPTION_WINDOW_HOURS}h`,
        payload: { channel: "sms", href: "/schedule?filter=exceptions", visit_id: r.visit_id, exception_kind: r.kind },
      };
    });
}

/** Round-robin across sources so one busy category cannot fill the whole run. */
function interleave(groups: Candidate[][], max: number): Candidate[] {
  const out: Candidate[] = [];
  const depth = Math.max(...groups.map((g) => g.length), 0);
  for (let i = 0; i < depth && out.length < max; i++) {
    for (const g of groups) {
      if (out.length >= max) break;
      if (g[i]) out.push(g[i]);
    }
  }
  return out;
}

/**
 * Draft the outreach for every deterministic candidate the engines produced.
 *
 * Degradation is the acceptance bar, not an edge case: if the model is disabled by its
 * kill switch, over budget, unreachable, or rate-limited, `runCapability` returns the
 * deterministic fallback and the proposal is written WITHOUT an `ai_interaction_id`
 * (migration 0016: null means "no model call produced this"). The inbox then says so on
 * the card, and the coordinator still has something to approve.
 */
export async function generateChaseDrafts(): Promise<{
  ok: boolean;
  error?: string;
  created: number;
  fromModel: number;
  deterministic: number;
  /** 'disabled' | 'budget' | 'openai 429' … — why the model did not write these. */
  degradeReason?: string;
  message: string;
}> {
  const none = { created: 0, fromModel: 0, deterministic: 0 };

  const profile = await getProfile();
  if (!profile) {
    return { ok: false, ...none, message: "", error: "Your session has ended. Sign in again to continue." };
  }
  if (!profile.roles.some((r) => GENERATE_ROLES.includes(r))) {
    return {
      ok: false,
      ...none,
      message: "",
      error: "Drafting is available to owners, administrators and coordinators.",
    };
  }

  const supabase = await supabaseServer();
  const tenantId = await tenantOf(supabase, profile.userId);
  if (!tenantId) {
    return { ok: false, ...none, message: "", error: "Your workspace could not be resolved on this session." };
  }

  // Never propose the same subject twice inside the dedupe window — a second run should
  // find new work, not duplicate the queue a coordinator is already reading.
  const { data: recent } = await supabase
    .from("ai_proposal")
    .select("subject_type, subject_id")
    .gte("proposed_at", isoDaysAgo(DEDUPE_WINDOW_DAYS))
    .limit(500);
  const seen = new Set(
    ((recent ?? []) as { subject_type: string; subject_id: string | null }[])
      .filter((r) => r.subject_id)
      .map((r) => `${r.subject_type}:${r.subject_id}`)
  );

  const [credentials, obligations, drafts, exceptions] = await Promise.all([
    collectCredentialCandidates(supabase),
    collectObligationCandidates(supabase),
    collectStaleDraftCandidates(supabase),
    collectExceptionCandidates(supabase),
  ]);

  const fresh = (list: Candidate[]) => list.filter((c) => !seen.has(`${c.subjectType}:${c.subjectId}`));
  const candidates = interleave(
    [fresh(credentials), fresh(obligations), fresh(drafts), fresh(exceptions)],
    MAX_DRAFTS_PER_RUN
  );

  if (candidates.length === 0) {
    return {
      ok: true,
      ...none,
      message:
        "Nothing new to chase. Every open credential, obligation, draft and exception the engines can see already has a proposal in this inbox.",
    };
  }

  // One governed call per candidate: the registry prompt is written for a single
  // message, and a per-item ledger row keeps cost and degradation attributable.
  const drafted = await Promise.all(
    candidates.map(async (c) => {
      const res = await runCapability(supabase, CAPABILITY_KEY, {
        system: CHASE_SYSTEM,
        user: `Write the message for these facts.\n\n${JSON.stringify(c.facts, null, 2)}`,
        temperature: 0.2,
        responseFormat: { name: "chase_message", schema: DRAFT_SCHEMA },
        inputDigest: digest(c.factsDigest, 200),
        fallback: () => ({ text: c.body }),
      });
      const parsed = res.status === "ok" && res.provider === "openai" ? parseDraftBody(res.text) : null;
      return {
        candidate: c,
        body: parsed ?? c.body,
        usedModel: parsed !== null,
        interactionId: res.interactionId,
        reason: res.reason,
      };
    })
  );

  const rows = drafted.map((d) => ({
    tenant_id: tenantId,
    capability_key: CAPABILITY_KEY,
    kind: "message",
    subject_type: d.candidate.subjectType,
    subject_id: d.candidate.subjectId,
    title: d.candidate.title.slice(0, 300),
    body: d.body.slice(0, MAX_BODY_CHARS),
    payload: {
      ...d.candidate.payload,
      source: d.candidate.source,
      drafted_by: d.usedModel ? "model" : "deterministic",
      ...(d.usedModel ? {} : { degrade_reason: d.reason ?? "model unavailable" }),
    },
    rationale: d.candidate.rationale,
    // Null when no model produced the text: the proposal is a deterministic draft, and
    // the flywheel has nothing to label. The attempt is still a row in ai_interaction.
    ai_interaction_id: d.usedModel ? d.interactionId : null,
    created_by: profile.userId,
  }));

  const { error: insertErr } = await supabase.from("ai_proposal").insert(rows);
  if (insertErr) {
    return {
      ok: false,
      ...none,
      message: "",
      error:
        "The drafts could not be saved. Nothing was written or sent. Proposals need a verified (MFA) session and coordinator access.",
    };
  }

  const fromModel = drafted.filter((d) => d.usedModel).length;
  const deterministic = drafted.length - fromModel;
  const degradeReason = drafted.find((d) => !d.usedModel)?.reason ?? undefined;

  const message =
    deterministic === 0
      ? `Drafted ${fromModel} ${fromModel === 1 ? "item" : "items"} from agency records. Each one is waiting for your decision.`
      : fromModel === 0
        ? `Drafted ${deterministic} ${deterministic === 1 ? "item" : "items"} from agency records without a model. Each one is waiting for your decision.`
        : `Drafted ${drafted.length} items: ${fromModel} written by the model, ${deterministic} assembled from agency records without one.`;

  revalidatePath("/inbox");
  return { ok: true, created: rows.length, fromModel, deterministic, degradeReason, message };
}
