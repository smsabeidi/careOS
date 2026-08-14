import Link from "next/link";
import { AppShell } from "@/components/shell";
import { EmptyState, ErrorState, MetricTile, PageHeader, Tabs } from "@/components/ui";
import { IconCheck, IconInbox, IconLock, IconSparkle, IconX } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { getCapability } from "@/lib/ai/registry";
import { GenerateDraftsButton, InboxBoard, type ProposalOrigin, type ProposalView } from "./inbox-client";

export const metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

/**
 * The approvals inbox — the Wave-2 centerpiece (docs/16 §4).
 *
 * Everything a capability wants a human to do arrives here as a proposal, and nothing
 * leaves this screen without a person deciding. That is invariant 8 made visible: the
 * DB will not execute a T2 capability without a disposition row, and this page is where
 * the disposition is written.
 *
 * Reading discipline: the proposal row is immutable, so the live state comes from
 * `public.ai_proposal_status` (derived from the append-only event ledger) and the words
 * of the decision come from `ai_proposal_event`. Every query runs under the viewer's RLS
 * on an AAL2 session — there is no privileged read path behind this page.
 */

const ROLES = ["owner", "admin", "coordinator", "hr", "rn"];
const GENERATE_ROLES = ["owner", "admin", "coordinator"];
const AGENCY_TZ = "America/New_York";

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const APPROVED_STATES = new Set(["approved", "edited", "executed"]);
const REJECTED_STATES = new Set(["rejected", "expired"]);

/** Short display names for seeded registry keys; anything else is humanized from its key. */
const CAPABILITY_TITLE: Record<string, string> = {
  "chase.draft": "Chase drafting",
  "family.update": "Family update",
  // ST-241: the on-demand family draft. Named here so the row a coordinator was promised
  // ("Draft sent for approval — Approvals inbox") is recognisable when they arrive.
  "family.weekly_draft": "Family update",
  "shift.fill": "Shift outreach",
  "careplan.review": "Care-plan review",
  "clinical.flag": "Clinical flag",
  "incident.draft": "Incident drafting",
  "intake.extract": "Intake extraction",
  "referral.triage": "Referral triage",
};

/* ── Row shapes (explicit columns only; never select(*)) ───────────────────── */

type NamePair = { first_name: string; last_name: string };

type ProposalRow = {
  id: string;
  capability_key: string;
  kind: string;
  subject_type: string;
  subject_id: string | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  rationale: string | null;
  confidence: number | string | null;
  status: string;
  ai_interaction_id: string | null;
  proposed_at: string;
  created_by: string;
};

type StatusRow = {
  proposal_id: string;
  status: string;
  last_action: string | null;
  last_actor: string | null;
  last_action_at: string | null;
  event_count: number | null;
};

type EventRow = {
  proposal_id: string;
  action: string;
  note: string | null;
  edited_body: string | null;
  actor: string;
  created_at: string;
};

type InteractionRow = { id: string; provider: string; model: string | null; status: string };

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

function fullName(p: NamePair | NamePair[] | null | undefined): string | null {
  const n = one(p);
  return n ? `${n.first_name} ${n.last_name}` : null;
}

/** Calendar day in the agency's timezone — used only to bucket "today" on the tiles. */
function agencyDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: AGENCY_TZ });
}

function humanize(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Only internal paths from proposal payloads are ever rendered as links. */
function safeHref(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

function toNumber(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** The view's derivation, restated for the case where the view itself is unavailable. */
const STATUS_FOR_ACTION: Record<string, string> = {
  approve: "approved",
  edit: "edited",
  reject: "rejected",
  execute: "executed",
  expire: "expired",
};

/* ── Subject resolution — an id travels, the label is refetched under RLS ──── */

type SubjectInfo = { label: string; href: string | null };

async function resolveSubjects(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  rows: ProposalRow[]
): Promise<{ subjects: Map<string, SubjectInfo>; staffIds: string[] }> {
  const byType = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.subject_id) continue;
    const set = byType.get(r.subject_type) ?? new Set<string>();
    set.add(r.subject_id);
    byType.set(r.subject_type, set);
  }
  const ids = (t: string) => [...(byType.get(t) ?? new Set<string>())];
  const clientIds = ids("client");
  const credentialIds = ids("credential");
  const visitIds = ids("visit");
  const formIds = ids("form_instance");
  const obligationIds = ids("obligation");

  const [clients, credentials, visits, forms, obligations] = await Promise.all([
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as ({ id: string } & NamePair)[] }),
    credentialIds.length
      ? supabase
          .from("credential_expiry")
          .select("credential_id, app_user_id, credential_type_name, expiry_bucket")
          .in("credential_id", credentialIds)
      : Promise.resolve({
          data: [] as {
            credential_id: string;
            app_user_id: string;
            credential_type_name: string;
            expiry_bucket: string;
          }[],
        }),
    visitIds.length
      ? supabase.from("visit").select("id, scheduled_start, client(first_name, last_name)").in("id", visitIds)
      : Promise.resolve({
          data: [] as { id: string; scheduled_start: string; client: NamePair | NamePair[] | null }[],
        }),
    formIds.length
      ? supabase
          .from("form_instance")
          .select("id, client(first_name, last_name), form_template(title)")
          .in("id", formIds)
      : Promise.resolve({
          data: [] as {
            id: string;
            client: NamePair | NamePair[] | null;
            form_template: { title: string } | { title: string }[] | null;
          }[],
        }),
    obligationIds.length
      ? supabase.from("cadence_obligation_status").select("id, rule_name, computed_status").in("id", obligationIds)
      : Promise.resolve({ data: [] as { id: string; rule_name: string; computed_status: string }[] }),
  ]);

  const subjects = new Map<string, SubjectInfo>();
  const credentialHolders = new Map<string, string>(); // credential id → staff id

  for (const c of (clients.data ?? []) as ({ id: string } & NamePair)[]) {
    subjects.set(`client:${c.id}`, {
      label: `Client · ${c.first_name} ${c.last_name}`,
      href: `/office/clients/${c.id}`,
    });
  }
  for (const c of (credentials.data ?? []) as {
    credential_id: string;
    app_user_id: string;
    credential_type_name: string;
    expiry_bucket: string;
  }[]) {
    credentialHolders.set(c.credential_id, c.app_user_id);
    subjects.set(`credential:${c.credential_id}`, {
      label: `Credential · ${c.credential_type_name}`,
      href: `/office/credentials?filter=${c.expiry_bucket === "lapsed" ? "lapsed" : "expiring"}`,
    });
  }
  for (const v of (visits.data ?? []) as {
    id: string;
    scheduled_start: string;
    client: NamePair | NamePair[] | null;
  }[]) {
    const client = fullName(v.client);
    const day = new Date(v.scheduled_start).toLocaleDateString("en-US", {
      timeZone: AGENCY_TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    subjects.set(`visit:${v.id}`, {
      label: `Visit · ${client ?? "client on file"} · ${day}`,
      href: "/schedule?filter=exceptions",
    });
  }
  for (const f of (forms.data ?? []) as {
    id: string;
    client: NamePair | NamePair[] | null;
    form_template: { title: string } | { title: string }[] | null;
  }[]) {
    const client = fullName(f.client);
    subjects.set(`form_instance:${f.id}`, {
      label: `Record · ${one(f.form_template)?.title ?? "Form"}${client ? ` · ${client}` : ""}`,
      href: `/office/forms/${f.id}`,
    });
  }
  for (const o of (obligations.data ?? []) as { id: string; rule_name: string; computed_status: string }[]) {
    subjects.set(`obligation:${o.id}`, {
      label: `Obligation · ${o.rule_name}`,
      href: `/office/compliance?filter=${o.computed_status === "overdue" ? "overdue" : "at_risk"}`,
    });
  }

  return { subjects, staffIds: [...new Set(credentialHolders.values())] };
}

/* ── Provenance: where the words on this card actually came from ───────────── */

function originOf(
  row: ProposalRow,
  interaction: InteractionRow | undefined
): { origin: ProposalOrigin; note: string | null } {
  const degrade = typeof row.payload?.degrade_reason === "string" ? row.payload.degrade_reason : null;

  if (!row.ai_interaction_id) {
    return {
      origin: "fallback",
      note:
        "No model call produced this draft. It was assembled from records in CareOS by the deterministic drafter" +
        (degrade ? `, because the model was unavailable (${degrade}).` : ".") +
        " It is still yours to edit, approve or reject.",
    };
  }
  if (!interaction) {
    return {
      origin: "unknown",
      note:
        "A model call is recorded for this draft on the AI ledger. That ledger row is not visible to your role, so the model and prompt version are not shown here.",
    };
  }
  if (interaction.status === "error" || interaction.status === "blocked") {
    return {
      origin: "fallback",
      note: `The model call was recorded as ${interaction.status}, so the text below came from the deterministic drafter rather than a model.`,
    };
  }
  if (interaction.provider !== "openai") {
    return {
      origin: "fallback",
      note: `Recorded against the ${interaction.provider} provider. This workspace runs the synthetic universe and does not call a live model, so the text was assembled deterministically.`,
    };
  }
  return {
    origin: "model",
    note: `Drafted by ${interaction.model ?? "the pinned model"}. Your decision is recorded against that model and its prompt version.`,
  };
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === params.tab)?.key ?? "pending") as TabKey;
  const profile = await requireRole(ROLES);
  const canGenerate = profile.roles.some((r) => GENERATE_ROLES.includes(r));
  const supabase = await supabaseServer();

  const [proposalRes, statusRes, eventRes] = await Promise.all([
    supabase
      .from("ai_proposal")
      .select(
        "id, capability_key, kind, subject_type, subject_id, title, body, payload, rationale, confidence, status, ai_interaction_id, proposed_at, created_by"
      )
      .order("proposed_at", { ascending: false })
      .limit(200),
    supabase
      .from("ai_proposal_status")
      .select("proposal_id, status, last_action, last_actor, last_action_at, event_count")
      .limit(400),
    supabase
      .from("ai_proposal_event")
      .select("proposal_id, action, note, edited_body, actor, created_at")
      .order("seq", { ascending: false })
      .limit(400),
  ]);

  if (proposalRes.error) {
    return (
      <AppShell active="/inbox">
        <div className="rise">
          <PageHeader title="Approvals" sub="Every AI proposal, decided by a person" />
          <ErrorState
            title="Couldn't load the approvals inbox"
            body="Nothing was changed, approved, or sent. Refresh to try again — proposals stay exactly as they were."
            retry={
              <Link href="/inbox" className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const rows = (proposalRes.data ?? []) as ProposalRow[];

  // Degraded read: PHI-bearing proposals are AAL2-gated, so an unverified session sees an
  // empty list rather than an error. Say which one it is instead of implying "all clear".
  if (rows.length === 0) {
    let aal2 = true;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = !data || data.currentLevel === "aal2";
    } catch {
      aal2 = true; // never block the page on an assurance-level probe
    }
    if (!aal2) {
      return (
        <AppShell active="/inbox">
          <div className="rise">
            <PageHeader title="Approvals" sub="Every AI proposal, decided by a person" />
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to review proposals"
              body="Proposals quote client and staff records, so they appear only on a verified (MFA) session. Nothing is pending on your behalf until you can see it."
              action={
                <Link href="/mfa" className="btn btn-primary btn-sm">
                  Verify session
                </Link>
              }
            />
          </div>
        </AppShell>
      );
    }
  }

  const statusById = new Map(
    ((statusRes.data ?? []) as StatusRow[]).map((s) => [s.proposal_id, s])
  );
  // Ordered seq-desc, so the first row seen for a proposal is its latest event.
  const lastEventById = new Map<string, EventRow>();
  const eventCountById = new Map<string, number>();
  // The human's edited text is a record of its own: it may sit on an earlier event than
  // the latest one (edit → execute), and it never replaces the original draft.
  const editedBodyById = new Map<string, string>();
  for (const e of (eventRes.data ?? []) as EventRow[]) {
    if (!lastEventById.has(e.proposal_id)) lastEventById.set(e.proposal_id, e);
    if (e.edited_body && !editedBodyById.has(e.proposal_id)) {
      editedBodyById.set(e.proposal_id, e.edited_body);
    }
    eventCountById.set(e.proposal_id, (eventCountById.get(e.proposal_id) ?? 0) + 1);
  }

  const { subjects, staffIds } = await resolveSubjects(supabase, rows);

  const capabilityKeys = [...new Set(rows.map((r) => r.capability_key))];
  const interactionIds = [...new Set(rows.map((r) => r.ai_interaction_id).filter((x): x is string => Boolean(x)))];
  const peopleIds = [
    ...new Set([
      ...rows.map((r) => r.created_by),
      ...[...statusById.values()].map((s) => s.last_actor).filter((x): x is string => Boolean(x)),
      ...[...lastEventById.values()].map((e) => e.actor),
      ...staffIds,
    ]),
  ];

  const [capabilityList, interactionRes, peopleRes] = await Promise.all([
    Promise.all(capabilityKeys.map((k) => getCapability(supabase, k))),
    interactionIds.length
      ? supabase.from("ai_interaction").select("id, provider, model, status").in("id", interactionIds)
      : Promise.resolve({ data: [] as InteractionRow[] }),
    peopleIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", peopleIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);

  const capabilityByKey = new Map(capabilityList.map((c) => [c.key, c]));
  const interactionById = new Map(
    ((interactionRes.data ?? []) as InteractionRow[]).map((i) => [i.id, i])
  );
  const nameById = new Map(
    ((peopleRes.data ?? []) as { id: string; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name ?? "A team member",
    ])
  );

  const proposals: ProposalView[] = rows.map((r) => {
    const derived = statusById.get(r.id);
    const lastEvent = lastEventById.get(r.id);
    const status =
      derived?.status ??
      (lastEvent ? STATUS_FOR_ACTION[lastEvent.action] ?? r.status : r.status) ??
      "pending";
    const capability = capabilityByKey.get(r.capability_key);
    const subject = r.subject_id ? subjects.get(`${r.subject_type}:${r.subject_id}`) : undefined;
    const { origin, note } = originOf(r, r.ai_interaction_id ? interactionById.get(r.ai_interaction_id) : undefined);
    const actorId = derived?.last_actor ?? lastEvent?.actor ?? null;

    return {
      id: r.id,
      title: r.title,
      body: r.body ?? "",
      rationale: r.rationale,
      kind: r.kind,
      capabilityKey: r.capability_key,
      capabilityName: CAPABILITY_TITLE[r.capability_key] ?? humanize(r.capability_key.replace(/\./g, " ")),
      tier: capability?.tier ?? "T2",
      requiresHuman: capability?.requires_human ?? true,
      capabilityEnabled: capability?.enabled ?? true,
      subjectLabel: subject?.label ?? humanize(r.subject_type),
      href: safeHref(r.payload?.href) ?? subject?.href ?? null,
      confidence: toNumber(r.confidence),
      proposedAt: r.proposed_at,
      proposedBy: nameById.get(r.created_by) ?? "A team member",
      status,
      origin,
      originNote: note,
      disposition:
        status === "pending" || !lastEvent
          ? null
          : {
              action: lastEvent.action,
              actorName: (actorId && nameById.get(actorId)) || "A team member",
              at: derived?.last_action_at ?? lastEvent.created_at,
              note: lastEvent.note,
              // The human's version persists beside the original — neither overwrites.
              editedBody: lastEvent.edited_body ?? editedBodyById.get(r.id) ?? null,
            },
      eventCount: derived?.event_count ?? eventCountById.get(r.id) ?? 0,
    };
  });

  const pending = proposals.filter((p) => p.status === "pending");
  const approved = proposals.filter((p) => APPROVED_STATES.has(p.status));
  const rejected = proposals.filter((p) => REJECTED_STATES.has(p.status));

  const today = agencyDay(new Date().toISOString());
  const disposedToday = (list: ProposalView[]) =>
    list.filter((p) => p.disposition && agencyDay(p.disposition.at) === today).length;
  const decisionsOnRecord = proposals.reduce((sum, p) => sum + p.eventCount, 0);

  const shown = tab === "approved" ? approved : tab === "rejected" ? rejected : pending;
  const href = (key: TabKey) => (key === "pending" ? "/inbox" : `/inbox?tab=${key}`);

  const sub = pending.length
    ? `${pending.length} waiting for a decision · nothing is sent until you approve it`
    : "Nothing is sent until a person approves it";

  return (
    <AppShell active="/inbox">
      <div className="rise">
        <PageHeader title="Approvals" sub={sub} actions={<GenerateDraftsButton canGenerate={canGenerate} />} />

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Waiting for you" value={pending.length} tone="accent" icon={<IconInbox />} />
          <MetricTile
            label="Approved today"
            value={disposedToday(approved)}
            tone="success"
            icon={<IconCheck />}
            hint={approved.length ? `${approved.length} all time` : undefined}
          />
          <MetricTile
            label="Rejected today"
            value={disposedToday(rejected)}
            tone="danger"
            icon={<IconX />}
            hint={rejected.length ? `${rejected.length} all time` : undefined}
          />
          <MetricTile
            label="Decisions on record"
            value={decisionsOnRecord}
            tone="neutral"
            icon={<IconSparkle />}
            hint="Append-only"
          />
        </div>

        <p className="mb-6 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Every decision here is recorded twice: once on the proposal, so the record shows who approved what
          and in whose words, and once against the model and prompt version that drafted it, where accepted,
          edited and rejected pairs become the evaluation and training data this agency owns.
        </p>

        <div className="mb-4">
          <Tabs
            label="Proposal status"
            active={href(tab)}
            items={TABS.map((t) => ({
              href: href(t.key),
              label: t.label,
              count:
                t.key === "pending" ? pending.length : t.key === "approved" ? approved.length : rejected.length,
            }))}
          />
        </div>

        {shown.length === 0 ? (
          tab === "approved" ? (
            <EmptyState
              icon={<IconCheck />}
              title="No approvals yet"
              body="Approved items stay here with the exact text that was approved, who approved it, and when. If someone edits a draft before approving, both versions are kept."
            />
          ) : tab === "rejected" ? (
            <EmptyState
              icon={<IconX />}
              title="No rejections yet"
              body="Rejecting a draft is a normal outcome and it stays on the record with its reason. Those reasons — wrong, tone, unsafe, incomplete — become the rubric each capability is measured against."
            />
          ) : (
            <EmptyState
              icon={<IconInbox />}
              title="Nothing waiting for a decision"
              body="When a capability drafts something — a credential renewal reminder, an obligation cure, a nudge on an unfinished note, a family update — it lands here with the reason it was proposed. Nothing is sent, saved to a chart, or acted on until a person approves it."
              action={
                canGenerate ? (
                  <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    Use generate drafts above to run the chase drafter over today's open items.
                  </span>
                ) : undefined
              }
            />
          )
        ) : (
          <InboxBoard proposals={shown} />
        )}
      </div>
    </AppShell>
  );
}
