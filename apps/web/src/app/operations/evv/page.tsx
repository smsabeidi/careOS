import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Badge, EmptyState, ErrorState, MetricTile, PageHeader, SectionTitle, Tabs } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClipboardCheck,
  IconClock,
  IconHistory,
  IconLock,
  IconShield,
  IconX,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";

export const metadata = { title: "EVV records" };
export const dynamic = "force-dynamic";

/**
 * The EVV console — docs/17 §3.12, §3.13, §7.2 and decision D-026.
 *
 * Two facts this screen exists to make unmistakable:
 *
 *  1. **The canonical record is captured whatever the state decides.** `evv_record` is a
 *     state-agnostic object holding six elements about one visit. It is appended by
 *     `app.build_evv_record` from the visit's own ledger, hashed, and never edited — a
 *     correction appends a new record that supersedes the old one (invariant 1). Nothing
 *     about that depends on a payer connection existing.
 *  2. **Maryland's adapter ships disabled (D-026).** `('isas','MD', mode='reconcile',
 *     enabled=false)` is the ratified configuration, not a gap: the state has not yet
 *     answered whether agencies submit their own visit data or reconcile against ISAS.
 *     `app.submit_evv` returns `skipped: adapter_disabled` and the record stands. When the
 *     answer arrives the adapter flips mode and these same records go out.
 *
 * Reading discipline: every query below runs under the viewer's own JWT (invariant 6/9).
 * `evv_record` and `evv_submission` are AAL2-gated in RLS while `evv_adapter` is not, so an
 * unverified session sees adapters and an empty record list — which is why the empty state
 * probes the assurance level before it claims there is nothing to see.
 *
 * PHI: this surface carries names and dates, so it stays server-rendered. It holds no
 * coordinate, no distance and no accuracy radius — none of those are columns on any table
 * read here, which is D-030 made structural rather than remembered.
 */

const AGENCY_TZ = "America/New_York";

const TABS = [
  { key: "all", label: "Current" },
  { key: "incomplete", label: "Missing an element" },
  { key: "superseded", label: "Superseded" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/**
 * The six elements a canonical record asserts, in the order docs/17 §3.12 names them.
 * Keys are exactly the keys `app.build_evv_record` writes into `element_completeness`;
 * the CHECK constraint on the table guarantees all six are present on every stored row.
 */
const ELEMENTS: { key: string; label: string; missing: string }[] = [
  { key: "service_type", label: "Type of service", missing: "No service type is set on the visit." },
  { key: "individual_receiving", label: "Person receiving care", missing: "The visit names no client." },
  { key: "service_date", label: "Date of service", missing: "The visit has no date of service." },
  {
    key: "service_location",
    label: "Place of care",
    missing: "The visit was not bound to a service location when it was clocked.",
  },
  { key: "individual_providing", label: "Person providing care", missing: "The visit names no caregiver." },
  { key: "service_times", label: "Start and end times", missing: "The visit has no clock-in and clock-out pair." },
];

/** How the times on the record came to be there. Plain words, no field-app jargon. */
const CAPTURE_LABEL: Record<string, string> = {
  web_gps: "Captured in the field app",
  manual: "Entered by the office",
  offline_sync: "Captured offline, synced later",
  telephony: "Captured by phone",
  corrected: "Corrected by a person",
};

const PAYER_LABEL: Record<string, string> = {
  medicaid: "Medicaid",
  medicare: "Medicare",
  private: "Private pay",
  waiver: "Waiver",
  other: "Other payer",
};

const TARGET_LABEL: Record<string, string> = {
  isas: "ISAS (Maryland)",
  sandata: "Sandata",
  hhax: "HHAeXchange",
  none: "No aggregator",
};

const MODE_LABEL: Record<string, string> = {
  capture: "Submits our records",
  reconcile: "Reconciles against the payer's records",
  dual: "Submits and reconciles",
  disabled: "Off",
};

/** Submission state → colour + icon + words. Never colour alone (D-012). */
const SUBMISSION_TONE: Record<
  string,
  { tone: "neutral" | "accent" | "success" | "warning" | "danger" | "info"; label: string }
> = {
  pending: { tone: "warning", label: "Queued" },
  submitted: { tone: "info", label: "Sent" },
  accepted: { tone: "success", label: "Accepted" },
  rejected: { tone: "danger", label: "Rejected" },
  superseded: { tone: "neutral", label: "Superseded" },
  reconciled: { tone: "success", label: "Reconciled" },
};

/* ── Row shapes (explicit columns only; never select(*)) ───────────────────── */

type AdapterRow = {
  id: string;
  target: string;
  state_code: string | null;
  mode: string;
  enabled: boolean;
  adapter_version: string | null;
  updated_at: string;
};

type RecordRow = {
  id: string;
  source_visit_id: string;
  service_type_id: string | null;
  client_id: string;
  caregiver_id: string;
  service_date: string;
  service_location_version_id: string | null;
  start_at: string;
  end_at: string;
  capture_method: string;
  exception_code: string | null;
  payer_kind: string;
  element_completeness: Record<string, boolean> | null;
  is_complete: boolean;
  record_sha256: string;
  supersedes_id: string | null;
  created_at: string;
};

type SubmissionRow = {
  id: string;
  evv_record_id: string;
  adapter_id: string;
  attempt_no: number;
  status: string;
  external_reference: string | null;
  response_code: string | null;
  response_message: string | null;
  submitted_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

type ServiceTypeRow = { id: string; code: string; name: string; evv_required: boolean };

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** Calendar day in the agency's timezone. Display only — the engines own the maths. */
function fmtDay(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: AGENCY_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    timeZone: AGENCY_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${fmtDay(value)} · ${d.toLocaleTimeString("en-US", {
    timeZone: AGENCY_TZ,
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/** Minutes between two instants, for the operator's sanity check on the pair. */
function spanMinutes(start: string, end: string): number | null {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 60_000);
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function EvvPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === params.tab)?.key ?? "all") as TabKey;
  await requirePerm("evv.read");
  const supabase = await supabaseServer();

  const [adapterRes, recordRes] = await Promise.all([
    supabase
      .from("evv_adapter")
      .select("id, target, state_code, mode, enabled, adapter_version, updated_at")
      .order("state_code", { ascending: true })
      .order("target", { ascending: true }),
    supabase
      .from("evv_record")
      .select(
        "id, source_visit_id, service_type_id, client_id, caregiver_id, service_date, " +
          "service_location_version_id, start_at, end_at, capture_method, exception_code, " +
          "payer_kind, element_completeness, is_complete, record_sha256, supersedes_id, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(150),
  ]);

  const header = (
    <PageHeader
      title="EVV records"
      sub="What CareOS asserts about each visit, and what has been sent"
    />
  );

  if (recordRes.error) {
    return (
      <AppShell active="/operations/evv">
        <div className="rise">
          {header}
          <ErrorState
            title="Couldn't load the EVV records"
            body="Nothing was built, sent, or changed — every record on file stands exactly as it was. Refresh to try again."
            retry={
              <Link href="/operations/evv" className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const adapters = (adapterRes.data ?? []) as AdapterRow[];
  // `as unknown as` because the column list is assembled from string fragments, which
  // defeats supabase-js's literal-type inference; the shape is asserted by RecordRow above.
  const records = (recordRes.data ?? []) as unknown as RecordRow[];

  // Degraded read: evv_record is AAL2-gated in RLS while evv_adapter is not, so an
  // unverified session sees an empty list rather than an error. Say which one it is.
  if (records.length === 0) {
    let aal2 = true;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = !data || data.currentLevel === "aal2";
    } catch {
      aal2 = true; // never block the page on an assurance-level probe
    }
    if (!aal2) {
      return (
        <AppShell active="/operations/evv">
          <div className="rise">
            {header}
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to read EVV records"
              body="Each record names a client, a caregiver and a place of care, so it appears only on a verified (MFA) session. Records are still being captured — you just cannot read them from here yet."
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

  // Head of chain: a record nothing else supersedes. Superseded rows stay readable —
  // they are the history of what we asserted before a correction landed.
  const supersededIds = new Set(
    records.map((r) => r.supersedes_id).filter((x): x is string => Boolean(x))
  );
  const current = records.filter((r) => !supersededIds.has(r.id));
  const superseded = records.filter((r) => supersededIds.has(r.id));
  const incomplete = current.filter((r) => !r.is_complete);

  // Second round: labels for the ids the records carry. IDs travel; names are refetched
  // under RLS and render "(restricted)" wherever a policy hides the row (invariant 5).
  const recordIds = records.map((r) => r.id);
  const clientIds = [...new Set(records.map((r) => r.client_id))];
  const caregiverIds = [...new Set(records.map((r) => r.caregiver_id))];
  const serviceTypeIds = [
    ...new Set(records.map((r) => r.service_type_id).filter((x): x is string => Boolean(x))),
  ];

  const [submissionRes, clientRes, staffRes, serviceTypeRes] = await Promise.all([
    recordIds.length
      ? supabase
          .from("evv_submission")
          .select(
            "id, evv_record_id, adapter_id, attempt_no, status, external_reference, " +
              "response_code, response_message, submitted_at, resolved_at, created_at"
          )
          .in("evv_record_id", recordIds)
          .order("created_at", { ascending: true })
          .limit(600)
      : Promise.resolve({ data: [] as SubmissionRow[], error: null }),
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string; last_name: string }[], error: null }),
    caregiverIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", caregiverIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[], error: null }),
    serviceTypeIds.length
      ? supabase
          .from("service_type")
          .select("id, code, name, evv_required")
          .in("id", serviceTypeIds)
      : Promise.resolve({ data: [] as ServiceTypeRow[], error: null }),
  ]);

  const submissions = (submissionRes.data ?? []) as SubmissionRow[];
  const submissionsByRecord = new Map<string, SubmissionRow[]>();
  for (const s of submissions) {
    const list = submissionsByRecord.get(s.evv_record_id) ?? [];
    list.push(s);
    submissionsByRecord.set(s.evv_record_id, list);
  }

  const clientName = new Map(
    ((clientRes.data ?? []) as { id: string; first_name: string; last_name: string }[]).map((c) => [
      c.id,
      `${c.first_name} ${c.last_name}`,
    ])
  );
  const staffName = new Map(
    ((staffRes.data ?? []) as { id: string; full_name: string | null }[]).map((s) => [
      s.id,
      s.full_name ?? "A team member",
    ])
  );
  const serviceTypeById = new Map(
    ((serviceTypeRes.data ?? []) as ServiceTypeRow[]).map((s) => [s.id, s])
  );
  const adapterById = new Map(adapters.map((a) => [a.id, a]));

  const liveAdapters = adapters.filter((a) => a.enabled && a.mode !== "disabled");
  const shown = tab === "incomplete" ? incomplete : tab === "superseded" ? superseded : current;
  const href = (key: TabKey) => (key === "all" ? "/operations/evv" : `/operations/evv?tab=${key}`);

  return (
    <AppShell active="/operations/evv">
      <div className="rise">
        {header}

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile
            label="Records on file"
            value={current.length}
            tone="accent"
            icon={<IconClipboardCheck />}
            hint={superseded.length ? `${superseded.length} superseded, kept` : "Append-only"}
          />
          <MetricTile
            label="All six elements"
            value={current.filter((r) => r.is_complete).length}
            tone="success"
            icon={<IconCheck />}
          />
          <MetricTile
            label="Missing an element"
            value={incomplete.length}
            tone={incomplete.length ? "warning" : "neutral"}
            icon={<IconAlert />}
            hint={incomplete.length ? "Each needs a correction, not a resend" : "Nothing outstanding"}
          />
          <MetricTile
            label="Submission attempts"
            value={submissions.length}
            tone="neutral"
            icon={<IconHistory />}
            hint={liveAdapters.length ? undefined : "No adapter is live"}
          />
        </div>

        {/* ── D-026, stated where an operator will actually read it ── */}
        <div
          className="card-inset mb-6 px-5 py-4"
          style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)" }}
        >
          <SectionTitle icon={<IconShield />}>Nothing is being sent, and nothing is being lost</SectionTitle>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Maryland&rsquo;s adapter ships switched off on purpose. The state has not yet said whether agencies
            submit their own visit data or reconcile against the state&rsquo;s system, and CareOS is not guessing
            at the answer. Every visit is still recorded here against the same six elements, hashed, and kept —
            so when the answer arrives, the adapter changes mode and these records go out unchanged. A record
            with no submission attempt below is the expected state today, not a backlog.
          </p>
        </div>

        {/* ── Adapters ── */}
        <div className="mb-6">
          <SectionTitle icon={<IconShield />}>Adapters</SectionTitle>
          {adapterRes.error ? (
            <div className="card px-5 py-4">
              <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                The adapter configuration could not be read on this session. Records below are unaffected —
                capture does not depend on an adapter.
              </p>
            </div>
          ) : adapters.length === 0 ? (
            <div className="card px-5 py-4">
              <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                No adapter is configured for this agency. Visits are still recorded against the six elements;
                there is simply nowhere to send them yet.
              </p>
            </div>
          ) : (
            <div className="card divide-y hairline overflow-hidden">
              {adapters.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium">
                      {TARGET_LABEL[a.target] ?? a.target}
                      {a.state_code ? ` · ${a.state_code}` : ""}
                    </p>
                    <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {MODE_LABEL[a.mode] ?? a.mode}
                      {a.adapter_version ? ` · version ${a.adapter_version}` : ""}
                    </p>
                  </div>
                  {a.enabled ? (
                    <Badge tone="success" icon={<IconCheck />}>
                      Live
                    </Badge>
                  ) : (
                    <Badge tone="neutral" icon={<IconX />}>
                      Disabled pending the state&rsquo;s answer
                    </Badge>
                  )}
                  <span className="tabular text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {fmtStamp(a.updated_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mb-4">
          <Tabs
            label="Record state"
            active={href(tab)}
            items={TABS.map((t) => ({
              href: href(t.key),
              label: t.label,
              count:
                t.key === "all" ? current.length : t.key === "incomplete" ? incomplete.length : superseded.length,
            }))}
          />
        </div>

        {shown.length === 0 ? (
          tab === "incomplete" ? (
            <EmptyState
              icon={<IconCheck />}
              title="Every record carries all six elements"
              body="Nothing here needs a correction. A record lands in this tab when the visit it came from is missing a service type, a place of care, a caregiver, or a clock-in and clock-out pair."
            />
          ) : tab === "superseded" ? (
            <EmptyState
              icon={<IconHistory />}
              title="No record has been superseded yet"
              body="Records are never edited. When a visit is corrected, a new record is appended and the earlier one moves here with its original hash intact — so the history of what was asserted, and when, stays readable."
            />
          ) : (
            <EmptyState
              icon={<IconClipboardCheck />}
              title="No EVV records yet"
              body="A record is built once a visit has both a clock-in and a clock-out. It holds six elements — the type of service, who received it, the date, the place, who provided it, and the start and end times — hashed so a resubmission can point at exactly what was asserted."
            />
          )
        ) : (
          <div className="flex flex-col gap-4">
            {shown.map((r) => {
              const completeness = r.element_completeness ?? {};
              const attempts = submissionsByRecord.get(r.id) ?? [];
              const serviceType = r.service_type_id ? serviceTypeById.get(r.service_type_id) : undefined;
              const minutes = spanMinutes(r.start_at, r.end_at);
              const isSuperseded = supersededIds.has(r.id);
              const missing = ELEMENTS.filter((e) => completeness[e.key] !== true);

              return (
                <article key={r.id} className="card px-5 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[16px] font-semibold tracking-[-0.01em]">
                        {clientName.get(r.client_id) ?? "(restricted)"} · {fmtDay(r.service_date)}
                      </h3>
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        <span className="tabular">
                          {fmtTime(r.start_at)} – {fmtTime(r.end_at)}
                        </span>
                        {minutes !== null && <span className="tabular"> · {minutes} min</span>}
                        {" · "}
                        {staffName.get(r.caregiver_id) ?? "(restricted)"}
                        {serviceType ? ` · ${serviceType.name}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.is_complete ? (
                        <Badge tone="success" icon={<IconCheck />}>
                          All six elements
                        </Badge>
                      ) : (
                        <Badge tone="warning" icon={<IconAlert />}>
                          {missing.length} missing
                        </Badge>
                      )}
                      <Badge tone="neutral">{PAYER_LABEL[r.payer_kind] ?? r.payer_kind}</Badge>
                      {serviceType?.evv_required === false && <Badge tone="neutral">EVV not required</Badge>}
                      {isSuperseded && (
                        <Badge tone="neutral" icon={<IconHistory />}>
                          Superseded
                        </Badge>
                      )}
                      {r.supersedes_id && !isSuperseded && (
                        <Badge tone="info" icon={<IconHistory />}>
                          Replaces an earlier record
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* ── The six elements, as a checklist ── */}
                  <div className="mt-4">
                    <p
                      className="mb-2 text-[11px] font-semibold uppercase"
                      style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
                    >
                      Elements on this record
                    </p>
                    <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                      {ELEMENTS.map((e) => {
                        const present = completeness[e.key] === true;
                        return (
                          <li key={e.key} className="flex items-start gap-2 text-[13px]">
                            <span
                              className="mt-0.5 flex shrink-0"
                              style={{
                                color: present ? "var(--color-success-700)" : "var(--color-warning-700)",
                              }}
                            >
                              {present ? (
                                <IconCheck width={14} height={14} />
                              ) : (
                                <IconAlert width={14} height={14} />
                              )}
                            </span>
                            <span className="min-w-0">
                              <span style={{ color: present ? "var(--text)" : "var(--text-secondary)" }}>
                                {e.label}
                              </span>
                              <span className="sr-only">{present ? " — present" : " — missing"}</span>
                              {!present && (
                                <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                                  {e.missing}
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {CAPTURE_LABEL[r.capture_method] ?? r.capture_method}
                    {r.exception_code ? ` · exception ${r.exception_code}` : ""} · built {fmtStamp(r.created_at)} ·
                    hash <span className="tabular">{r.record_sha256.slice(0, 12)}</span>
                  </p>

                  {/* ── Submission attempts ── */}
                  <div className="mt-4 border-t pt-4 hairline">
                    <p
                      className="mb-2 text-[11px] font-semibold uppercase"
                      style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
                    >
                      Submission attempts
                    </p>
                    {attempts.length === 0 ? (
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {liveAdapters.length === 0
                          ? "None — no adapter is live, so there is nothing to send this to yet. The record above is kept and is ready to go the moment one is."
                          : r.is_complete
                            ? "None yet. This record is complete and can be handed to the live adapter."
                            : "None. A record missing an element is a work item, not something to send: correct the visit and a new record is appended."}
                      </p>
                    ) : (
                      <ol className="flex flex-col gap-2">
                        {attempts.map((s) => {
                          const tone = SUBMISSION_TONE[s.status] ?? { tone: "neutral" as const, label: s.status };
                          const adapter = adapterById.get(s.adapter_id);
                          return (
                            <li
                              key={s.id}
                              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]"
                            >
                              <span className="tabular shrink-0 font-medium">Attempt {s.attempt_no}</span>
                              <Badge tone={tone.tone}>{tone.label}</Badge>
                              {adapter && (
                                <span style={{ color: "var(--text-muted)" }}>
                                  {TARGET_LABEL[adapter.target] ?? adapter.target}
                                </span>
                              )}
                              {s.response_code && (
                                <span className="tabular" style={{ color: "var(--text-secondary)" }}>
                                  code {s.response_code}
                                </span>
                              )}
                              {s.external_reference && (
                                <span className="tabular" style={{ color: "var(--text-muted)" }}>
                                  ref {s.external_reference}
                                </span>
                              )}
                              <span className="tabular" style={{ color: "var(--text-muted)" }}>
                                {fmtStamp(s.resolved_at ?? s.submitted_at ?? s.created_at)}
                              </span>
                              {s.response_message && (
                                <span className="w-full text-[12px]" style={{ color: "var(--text-muted)" }}>
                                  The payer&rsquo;s own words: {s.response_message}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <p className="mt-6 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          <IconClock width={12} height={12} className="mr-1 inline align-[-1px]" />
          Records and attempts are append-only. A correction never rewrites what was asserted — it appends a new
          record, and any attempt still in flight for the old one is closed as superseded in the same transaction.
        </p>
      </div>
    </AppShell>
  );
}
