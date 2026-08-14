import type { ReactNode } from "react";
import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  MetricTile,
  PageHeader,
  SectionTitle,
  Tabs,
} from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconInbox,
  IconLock,
  IconShield,
  IconX,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import { featureEnabled } from "@/lib/flags";
import { HoursDecision, OpenPeriodForm, PeriodActions } from "./timesheet-client";
import { TrustEvidence, type TrustAssessment } from "./trust-evidence";

export const metadata = { title: "Timesheets" };
export const dynamic = "force-dynamic";

/** The Front Door W5 flag. Off ⇒ this page is exactly what it was before ST-239. */
const REVIEW_QUEUE_FLAG = "front_door.inbox";

/**
 * Timesheets — the approval surface and the payroll boundary (docs/17 §7.2, §4.7).
 *
 * This is where the chain that starts with a caregiver tapping a button on a porch ends
 * in a human decision about somebody's pay, and then in a file with a fingerprint on it.
 * Three things are true of every number on this page:
 *
 *  1. **The database computed it.** `app.compute_visit_minutes` measures the shift from
 *     the append-only clock ledger with corrections folded in, and applies the agency's
 *     own rounding policy; `app.compute_overtime` compares a week against the agency's
 *     ceiling; `app.export_payroll_period` sums and hashes the file. This screen adds,
 *     averages and rounds NOTHING (invariant 13). A caregiver disputing an hour is owed a
 *     subtraction they can reproduce on paper, not a number a browser produced.
 *  2. **The decision is append-only.** Approving does not update a visit — it appends an
 *     `approved_work_segment`, and a correction appends another one carrying
 *     `supersedes_id`. What was approved and what was later decided instead both survive
 *     (invariant 1). The rows below read the head of each chain: the segment nothing
 *     supersedes.
 *  3. **A person decides.** Self-approval is refused by the RPC and again by a CHECK
 *     constraint; an agent principal holding `visit.approve` is refused outright
 *     (D-020, D-027). The buttons here are convenience over that gate, never a substitute.
 *
 * PHI (invariant 5, D-030): no client name, no address, no service type and no coordinate
 * is read or rendered. A timesheet is a question about a caregiver's shift; the export is
 * four columns — caregiver, date, minutes, pay code — for the same reason. Caregiver names
 * travel as ids and are refetched under RLS, reading "(restricted)" when RLS hides them.
 *
 * ST-239 (Front Door W5) adds REVIEW-QUEUE FRAMING behind `front_door.inbox`: each row
 * carries the four figures a reviewer actually compares — booked (SCHED), measured
 * (ACTUAL), the difference between them (VAR) and the verification verdict (STATUS) — and
 * expands to the visit's latest `visit_trust_assessment` as evidence. The trust panel is
 * evidence and nothing else (D-028): no threshold, no recommendation, no action. VAR is
 * the only subtraction this screen performs and it is a subtraction of the two figures
 * printed either side of it, reproducible on paper; it is never what anybody is paid, and
 * the approve control still sends the database's own number. Flag off and none of it
 * renders — approve, adjust, send back, close and export are untouched in both states.
 *
 * @trace ST-208, ST-239, docs/17 §4.7 §7.2 §8, D-020, D-024, D-027, D-028, D-030
 */

const AGENCY_TZ = "America/New_York";

const TABS = [
  { key: "pending", label: "Awaiting approval" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Sent back" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/**
 * The pending page is capped because each row asks the database for its own authoritative
 * figure (`app.compute_visit_minutes` — the same function the approval RPC will run), and
 * that is one round trip per visit. Twenty-five is a working queue; a thousand is a
 * report, and a report is what /operations/attendance is for.
 */
const PENDING_LIMIT = 25;
const HISTORY_LIMIT = 100;
const PERIOD_LIMIT = 12;
const EXPORT_LIMIT = 12;

/* ── Row shapes (explicit columns only; never select(*)) ───────────────────── */

type VisitRow = {
  visit_id: string;
  caregiver_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  /** Booked minutes, computed by the view from the schedule window (0045 §3). */
  scheduled_minutes: number | null;
  actual_start: string | null;
  actual_end: string | null;
  verified_minutes: number | null;
  late_minutes: number | null;
  overrun_minutes: number | null;
  verification_status: string;
  approval_status: string;
  payroll_status: string;
  had_offline_capture: boolean | null;
};

type SegmentRow = {
  id: string;
  visit_id: string;
  caregiver_id: string;
  work_date: string;
  verified_minutes: number;
  approved_minutes: number;
  rounding_applied: string;
  pay_code: string;
  decision: string;
  approval_note: string | null;
  approved_by: string;
  supersedes_id: string | null;
  created_at: string;
};

type PeriodRow = {
  id: string;
  starts_on: string;
  ends_on: string;
  status: string;
  locked_by: string | null;
  locked_at: string | null;
};

type ExportRow = {
  id: string;
  period_id: string;
  format: string;
  row_count: number;
  total_minutes: number;
  content_sha256: string;
  exported_by: string;
  exported_at: string;
};

type ExceptionRow = { exception_id: string; visit_id: string; severity: string; open: boolean };

type PersonRow = { id: string; full_name: string | null };

/** `app.compute_visit_minutes` — the authoritative per-visit arithmetic (0050 §7). */
type ComputedMinutes = {
  verified_minutes: number | null;
  rounded_minutes: number | null;
  rounding_policy: string | null;
  late_minutes: number | null;
  overrun_minutes: number | null;
};

/* ── Formatting — presentation only ────────────────────────────────────────── */

/**
 * Lossless decomposition of a whole number of minutes: h * 60 + m is exactly the value
 * the database returned. Formatting, not rounding — no minute is created or dropped here.
 */
function minutesLabel(total: number | null | undefined): string {
  if (total === null || total === undefined) return "—";
  const abs = Math.abs(total);
  const h = (abs - (abs % 60)) / 60;
  const m = abs % 60;
  const sign = total < 0 ? "−" : "";
  if (h === 0) return `${sign}${m} min`;
  return m === 0 ? `${sign}${h} h` : `${sign}${h} h ${m} m`;
}

/**
 * The review queue's VAR cell (ST-239): measured minus booked, signed.
 *
 * The ONE subtraction this screen performs, and a deliberately narrow one: both operands
 * are printed either side of it, so a caregiver can reproduce it on paper — which is the
 * whole test invariant 13 sets. It is a reading aid and never a payroll figure: nothing
 * downstream consumes it, the approve control still sends the database's own number, and
 * a null on either side yields an em dash rather than a guess.
 */
function varianceLabel(
  scheduled: number | null | undefined,
  actual: number | null | undefined
): string {
  if (scheduled === null || scheduled === undefined) return "—";
  if (actual === null || actual === undefined) return "—";
  const delta = actual - scheduled;
  if (delta === 0) return "0 min";
  return `${delta > 0 ? "+" : "−"}${minutesLabel(Math.abs(delta))}`;
}

/** A review-queue column heading. Same type treatment as the DataTable headers. */
function ColHead({ children }: { children: ReactNode }) {
  return (
    <p
      className="text-[11px] font-semibold uppercase"
      style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
    >
      {children}
    </p>
  );
}

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" });
}

function dayOf(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", {
        timeZone: AGENCY_TZ,
        weekday: "short",
        month: "short",
        day: "numeric",
      });
}

function dateOnly(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The policy's rule, in the policy's own terms. Words only — the maths stays in SQL. */
const ROUNDING_WORDS: Record<string, string> = {
  none: "This agency does not round: the measured time is the approved time.",
  nearest_1: "Approved to the whole minute, as measured.",
  nearest_5: "Rounded to the nearest 5 minutes by agency policy.",
  nearest_6: "Rounded to the nearest tenth of an hour (6 minutes) by agency policy.",
  nearest_15: "Rounded to the nearest quarter hour by agency policy.",
  manual: "A person supplied this figure directly; no rounding rule was applied.",
};

const PAY_CODE_WORDS: Record<string, string> = {
  regular: "Regular",
  overtime: "Overtime",
  holiday: "Holiday",
  training: "Training",
  travel: "Travel",
  adjustment: "Adjustment",
};

const VERIFICATION: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "info" }> = {
  pending: { label: "Not verified yet", tone: "neutral" },
  verified: { label: "Verified", tone: "success" },
  exception: { label: "Needs review", tone: "warning" },
  manual_review: { label: "Manual review", tone: "warning" },
};

const PERIOD_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "info" | "warning" }> = {
  open: { label: "Open", tone: "info" },
  locked: { label: "Closed", tone: "warning" },
  exported: { label: "Exported", tone: "success" },
};

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab: TabKey = (TABS.find((t) => t.key === rawTab)?.key ?? "pending") as TabKey;

  await requirePerm("payroll.read");
  const supabase = await supabaseServer();

  const countFor = (status: string) =>
    supabase
      .from("verified_visit")
      .select("visit_id", { count: "exact", head: true })
      .eq("status", "completed")
      .eq("approval_status", status);

  const [
    reviewQueueOn,
    pendingCount,
    approvedCount,
    rejectedCount,
    listRes,
    periodRes,
    exportRes,
    approvePerm,
    managePerm,
  ] =
    await Promise.all([
      // Postgres owns the answer (0026 `app.feature_enabled`), asked as the signed-in
      // user and failing closed — an unreachable flag table renders today's page.
      featureEnabled(REVIEW_QUEUE_FLAG, false),
      countFor("pending"),
      countFor("approved"),
      countFor("rejected"),
      supabase
        .from("verified_visit")
        // One string literal, not a concatenation: supabase-js infers the row shape from
        // the literal, and a built string degrades the result to an untyped error union.
        .select(
          "visit_id, caregiver_id, scheduled_start, scheduled_end, scheduled_minutes, actual_start, actual_end, verified_minutes, late_minutes, overrun_minutes, verification_status, approval_status, payroll_status, had_offline_capture"
        )
        .eq("status", "completed")
        .eq("approval_status", tab)
        .order("scheduled_start", { ascending: false })
        .limit(tab === "pending" ? PENDING_LIMIT : HISTORY_LIMIT),
      supabase
        .from("payroll_period")
        .select("id, starts_on, ends_on, status, locked_by, locked_at")
        .order("starts_on", { ascending: false })
        .limit(PERIOD_LIMIT),
      supabase
        .from("payroll_export")
        .select("id, period_id, format, row_count, total_minutes, content_sha256, exported_by, exported_at")
        .order("exported_at", { ascending: false })
        .limit(EXPORT_LIMIT),
      supabase.schema("app").rpc("has_perm", { p: "visit.approve" }),
      supabase.schema("app").rpc("has_perm", { p: "payroll.manage" }),
    ]);

  const canApprove = approvePerm.data === true;
  const canManage = managePerm.data === true;
  const hrefFor = (k: TabKey) => (k === "pending" ? "/operations/timesheets" : `/operations/timesheets?tab=${k}`);

  const header = (
    <PageHeader
      title="Timesheets"
      sub="Hours a person approves, then a file with a fingerprint on it"
    />
  );

  if (listRes.error) {
    return (
      <AppShell active="/operations/timesheets">
        <div className="rise">
          {header}
          <ErrorState
            title="Couldn't load the timesheets"
            body="No hours were approved, sent back or exported — this screen only reads until you press a button. Refresh to try again, or verify your session if it has expired."
            retry={
              <Link href={hrefFor(tab)} className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const visits = (listRes.data ?? []) as VisitRow[];
  const periods = (periodRes.data ?? []) as PeriodRow[];
  const exports = (exportRes.data ?? []) as ExportRow[];

  // Degraded read, named rather than implied. `verified_visit` composes through the visit
  // policy: PHI needs AAL2 (invariant 3), and the rows also need schedule.read, care-team
  // membership or ownership of the visit. A payroll clerk can hold payroll.read and still
  // see no visits at all — that is a visibility fact, not an empty queue, and saying "no
  // hours waiting" to somebody who simply cannot see them would be a lie of omission.
  let queueGated: "schedule" | null = null;
  if (visits.length === 0) {
    let aal2 = true;
    let scheduleRead = true;
    try {
      const [{ data: level }, { data: perm }] = await Promise.all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        supabase.schema("app").rpc("has_perm", { p: "schedule.read" }),
      ]);
      aal2 = !level || level.currentLevel === "aal2";
      scheduleRead = perm !== false;
    } catch {
      aal2 = true; // never block the page on a probe
      scheduleRead = true;
    }
    // Without AAL2 nothing on this surface can be acted on — approving, closing and
    // exporting all require a verified session — so the whole page says so and stops.
    if (!aal2) {
      return (
        <AppShell active="/operations/timesheets">
          <div className="rise">
            {header}
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to review hours"
              body="Approving hours changes what someone is paid, so it happens only on a verified (MFA) session. Nothing is waiting on you unseen — the queue is here once you unlock."
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
    // Missing schedule visibility narrows the queue but leaves period management, the
    // export ledger and their evidence intact — so the page stays and only says less.
    if (!scheduleRead) queueGated = "schedule";
  }

  const visitIds = visits.map((v) => v.visit_id);

  /* ── Per-row detail, in parallel ─────────────────────────────────────────── */

  const [exceptionRes, computedList, segmentRes, trustRes] = await Promise.all([
    // Unresolved CRITICAL findings block approval in the database (0050 §7). Counting them
    // before render turns a refusal into a first-class state with a way out of it.
    tab === "pending" && visitIds.length
      ? supabase
          .from("visit_exception_state")
          .select("exception_id, visit_id, severity, open")
          .in("visit_id", visitIds)
          .eq("severity", "critical")
          .eq("open", true)
      : Promise.resolve({ data: [] as ExceptionRow[], error: null }),
    // The authoritative figure the approver is about to accept — the same function
    // app.approve_visit_hours runs. The view's verified_minutes is the LITERAL ledger and
    // deliberately does not fold corrections in; this one does, and it applies the
    // agency's rounding policy. One round trip per row, which is why the page is capped.
    tab === "pending"
      ? Promise.all(
          visits.map(async (v) => {
            const { data, error } = await supabase
              .schema("app")
              .rpc("compute_visit_minutes", { p_visit: v.visit_id });
            return { visitId: v.visit_id, minutes: error ? null : ((data ?? null) as ComputedMinutes | null) };
          })
        )
      : Promise.resolve([] as { visitId: string; minutes: ComputedMinutes | null }[]),
    tab !== "pending" && visitIds.length
      ? supabase
          .from("approved_work_segment")
          .select(
            "id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes, rounding_applied, pay_code, decision, approval_note, approved_by, supersedes_id, created_at"
          )
          .in("visit_id", visitIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as SegmentRow[], error: null }),
    // ST-239 · the trust snapshots behind the review queue. Append-only, so a visit can
    // carry several — ordered newest first and the newest one is what the row expands to;
    // the older readings stay on the record whether or not this screen shows them.
    reviewQueueOn && visitIds.length
      ? supabase
          .from("visit_trust_assessment")
          .select("id, visit_id, score, band, components, reasons, model_version, computed_at")
          .in("visit_id", visitIds)
          .order("computed_at", { ascending: false })
      : Promise.resolve({ data: [] as TrustAssessment[], error: null }),
  ]);

  const blockingByVisit = new Map<string, number>();
  for (const e of (exceptionRes.data ?? []) as ExceptionRow[]) {
    blockingByVisit.set(e.visit_id, (blockingByVisit.get(e.visit_id) ?? 0) + 1);
  }

  const computedByVisit = new Map(computedList.map((c) => [c.visitId, c.minutes]));

  // Newest snapshot per visit — the rows arrive computed_at desc, so the first one wins.
  const trustByVisit = new Map<string, TrustAssessment>();
  for (const t of (trustRes.data ?? []) as TrustAssessment[]) {
    if (!trustByVisit.has(t.visit_id)) trustByVisit.set(t.visit_id, t);
  }

  // Head of chain: the segment nothing supersedes (0050 §3). Set arithmetic over ids —
  // never a re-derivation of the minutes on them.
  const allSegments = (segmentRes.data ?? []) as SegmentRow[];
  const superseded = new Set(allSegments.map((s) => s.supersedes_id).filter((x): x is string => Boolean(x)));
  const segmentByVisit = new Map<string, SegmentRow>();
  for (const s of allSegments) {
    if (superseded.has(s.id)) continue;
    if (!segmentByVisit.has(s.visit_id)) segmentByVisit.set(s.visit_id, s); // ordered created_at desc
  }

  /* ── Names: ids travel, labels are refetched under RLS ───────────────────── */

  const personIds = [
    ...new Set([
      ...visits.map((v) => v.caregiver_id).filter((x): x is string => Boolean(x)),
      ...[...segmentByVisit.values()].map((s) => s.approved_by),
      ...periods.map((p) => p.locked_by).filter((x): x is string => Boolean(x)),
      ...exports.map((e) => e.exported_by),
    ]),
  ];
  const { data: people } = personIds.length
    ? await supabase.from("app_user").select("id, full_name").in("id", personIds)
    : { data: [] as PersonRow[] };
  const nameById = new Map(
    ((people ?? []) as PersonRow[]).map((p) => [p.id, p.full_name ?? "(restricted)"])
  );
  const nameOf = (id: string | null | undefined) => (id ? nameById.get(id) ?? "(restricted)" : "Unassigned");

  const periodById = new Map(periods.map((p) => [p.id, p]));

  // Default window for a new period: the fortnight ending today, in UTC — the same pinning
  // `close_payroll_period` uses for membership.
  const today = new Date();
  const endDefault = utcDate(today);
  const startDefault = utcDate(new Date(today.getTime() - 13 * 86_400_000));

  const openPeriods = periods.filter((p) => p.status === "open").length;

  return (
    <AppShell active="/operations/timesheets">
      <div className="rise">
        {header}

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile
            label="Awaiting approval"
            value={pendingCount.count ?? 0}
            tone="accent"
            icon={<IconInbox />}
            hint="Completed visits, nobody has decided"
          />
          <MetricTile label="Approved" value={approvedCount.count ?? 0} tone="success" icon={<IconCheck />} />
          <MetricTile label="Sent back" value={rejectedCount.count ?? 0} tone="danger" icon={<IconX />} />
          <MetricTile
            label="Open periods"
            value={openPeriods}
            tone="neutral"
            icon={<IconClock />}
            hint={periods.length ? `${periods.length} on record` : undefined}
          />
        </div>

        <p className="mb-6 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Every figure here is measured by CareOS from the clock record and rounded by this
          agency&apos;s own policy — this screen never calculates anyone&apos;s time. Approving appends a
          decision with your name on it rather than editing the visit, so a later correction sits
          beside the first decision instead of replacing it. Nobody can approve their own hours.
        </p>

        <div className="mb-4">
          <Tabs
            label="Approval state"
            active={hrefFor(tab)}
            items={TABS.map((t) => ({
              href: hrefFor(t.key),
              label: t.label,
              count:
                t.key === "pending"
                  ? pendingCount.count ?? 0
                  : t.key === "approved"
                    ? approvedCount.count ?? 0
                    : rejectedCount.count ?? 0,
            }))}
          />
        </div>

        {/* ── The queue ─────────────────────────────────────────────────────── */}
        <section className="mb-10">
          {queueGated === "schedule" ? (
            <EmptyState
              icon={<IconShield />}
              title="Your access doesn't include the visit schedule"
              body="Timesheets are built from visit records, and your role can read payroll without reading every visit — so this queue is narrower than the agency's, not empty. Nothing is hidden from the record. The periods and exports below are unaffected."
            />
          ) : tab === "pending" ? (
            visits.length === 0 ? (
              <EmptyState
                icon={<IconCheck />}
                title="No hours waiting on a decision"
                body="When a caregiver finishes a visit, the measured time lands here for a person to approve or send back. Nothing reaches payroll until somebody decides — and nobody can decide their own."
              />
            ) : (
              <div className="stagger flex flex-col gap-3">
                {visits.map((v) => {
                  const computed = computedByVisit.get(v.visit_id) ?? null;
                  const measured = computed?.verified_minutes ?? v.verified_minutes;
                  const toApprove = computed?.rounded_minutes ?? null;
                  const policy = computed?.rounding_policy ?? null;
                  const roundingNote = policy ? ROUNDING_WORDS[policy] ?? null : null;
                  const blocking = blockingByVisit.get(v.visit_id) ?? 0;
                  const vs = VERIFICATION[v.verification_status] ?? {
                    label: v.verification_status,
                    tone: "neutral" as const,
                  };
                  return (
                    <div key={v.visit_id} className="card px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[16px] font-semibold">{nameOf(v.caregiver_id)}</p>
                          <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                            {dayOf(v.scheduled_start)} · booked{" "}
                            <span className="tabular">
                              {timeOf(v.scheduled_start)} – {timeOf(v.scheduled_end)}
                            </span>{" "}
                            · worked{" "}
                            <span className="tabular">
                              {v.actual_start || v.actual_end
                                ? `${timeOf(v.actual_start)} – ${timeOf(v.actual_end)}`
                                : "not clocked"}
                            </span>
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {/* With the review queue on, STATUS carries the verdict; one
                                chip saying the same thing twice is noise, not emphasis. */}
                            {!reviewQueueOn && <Badge tone={vs.tone}>{vs.label}</Badge>}
                            {(v.late_minutes ?? 0) > 0 && (
                              <Badge tone="warning" icon={<IconClock />}>
                                {minutesLabel(v.late_minutes)} late
                              </Badge>
                            )}
                            {(v.overrun_minutes ?? 0) > 0 && (
                              <Badge tone="info">{minutesLabel(v.overrun_minutes)} over</Badge>
                            )}
                            {v.had_offline_capture && <Badge tone="neutral">Recorded offline</Badge>}
                            {blocking > 0 && (
                              <Badge tone="danger" icon={<IconAlert />}>
                                {blocking === 1 ? "1 critical exception" : `${blocking} critical exceptions`}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {reviewQueueOn ? (
                          /* ST-239 · the review-queue figures. SCHED and ACTUAL are the
                             view's own columns; VAR is their difference and nothing else;
                             TO APPROVE is what the database will record if this row is
                             approved as measured; STATUS is the verification verdict in
                             words. Colour never carries the status on its own (D-012). */
                          <div
                            className="grid shrink-0 grid-cols-3 gap-x-5 gap-y-3 sm:flex sm:gap-6"
                            role="group"
                            aria-label="Booked, measured, difference, to approve and verification status"
                          >
                            <div>
                              <ColHead>Sched</ColHead>
                              <p className="tabular title-lg text-[18px]">
                                {minutesLabel(v.scheduled_minutes)}
                              </p>
                            </div>
                            <div>
                              <ColHead>Actual</ColHead>
                              <p className="tabular title-lg text-[18px]">{minutesLabel(measured)}</p>
                            </div>
                            <div>
                              <ColHead>Var</ColHead>
                              <p className="tabular title-lg text-[18px]">
                                {varianceLabel(v.scheduled_minutes, measured)}
                              </p>
                            </div>
                            <div>
                              <ColHead>To approve</ColHead>
                              <p className="tabular title-lg text-[18px]">
                                {minutesLabel(toApprove ?? measured)}
                              </p>
                            </div>
                            <div>
                              <ColHead>Status</ColHead>
                              <p className="mt-1">
                                <Badge tone={vs.tone}>{vs.label}</Badge>
                              </p>
                            </div>
                          </div>
                        ) : (
                          <div className="flex shrink-0 gap-6">
                            <div>
                              <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                                Measured
                              </p>
                              <p className="tabular title-lg text-[22px]">{minutesLabel(measured)}</p>
                            </div>
                            <div>
                              <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                                To approve
                              </p>
                              <p className="tabular title-lg text-[22px]">
                                {minutesLabel(toApprove ?? measured)}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>

                      {reviewQueueOn && (
                        <>
                          <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                            Booked is the schedule window; actual is the measured time from the
                            clock record. The difference between them is the two figures above
                            subtracted — it is not what anybody is paid, and approving still
                            records the time CareOS measured under this agency&rsquo;s rounding
                            policy.
                          </p>
                          <TrustEvidence assessment={trustByVisit.get(v.visit_id) ?? null} />
                        </>
                      )}

                      <div className="mt-4 border-t pt-4 hairline">
                        <HoursDecision
                          visitId={v.visit_id}
                          canApprove={canApprove}
                          suggestedMinutes={toApprove ?? measured ?? null}
                          roundingNote={roundingNote}
                          blockingExceptions={blocking}
                          blockingHref={`/operations/exceptions?visit=${v.visit_id}`}
                        />
                      </div>
                    </div>
                  );
                })}
                {(pendingCount.count ?? 0) > visits.length && (
                  <p className="px-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    Showing the {visits.length} most recent of {pendingCount.count} visits waiting on a
                    decision. Work through these and the next ones appear here.
                  </p>
                )}
              </div>
            )
          ) : (
            <DataTable
              caption={tab === "approved" ? "Approved hours" : "Hours sent back"}
              columns={
                tab === "approved"
                  ? [
                      { header: "Work date" },
                      { header: "Caregiver" },
                      { header: "Measured", align: "right" },
                      { header: "Approved", align: "right" },
                      { header: "Pay code" },
                      { header: "Rounding" },
                      { header: "Approved by" },
                      { header: "Payroll" },
                    ]
                  : [
                      { header: "Work date" },
                      { header: "Caregiver" },
                      { header: "Measured", align: "right" },
                      { header: "Reason" },
                      { header: "Sent back by" },
                    ]
              }
              rows={visits.map((v) => {
                const seg = segmentByVisit.get(v.visit_id) ?? null;
                const workDate = seg ? dateOnly(seg.work_date) : dayOf(v.scheduled_start);
                if (tab === "approved") {
                  return {
                    key: v.visit_id,
                    cells: [
                      <span key="d" className="whitespace-nowrap">
                        {workDate}
                      </span>,
                      <span key="c" className="font-medium">
                        {nameOf(v.caregiver_id)}
                      </span>,
                      <span key="m" className="tabular">
                        {minutesLabel(seg?.verified_minutes ?? v.verified_minutes)}
                      </span>,
                      <span key="a" className="tabular font-semibold">
                        {minutesLabel(seg?.approved_minutes ?? null)}
                      </span>,
                      <span key="p">{seg ? PAY_CODE_WORDS[seg.pay_code] ?? seg.pay_code : "—"}</span>,
                      <span key="r" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {seg?.rounding_applied === "manual"
                          ? "Manual override"
                          : seg?.rounding_applied === "none"
                            ? "As measured"
                            : seg?.rounding_applied?.replace("nearest_", "Nearest ") ?? "—"}
                      </span>,
                      <span key="b">{nameOf(seg?.approved_by)}</span>,
                      <Badge key="s" tone={v.payroll_status === "exported" ? "success" : "info"}>
                        {v.payroll_status === "exported" ? "Exported" : "Ready to export"}
                      </Badge>,
                    ],
                  };
                }
                return {
                  key: v.visit_id,
                  cells: [
                    <span key="d" className="whitespace-nowrap">
                      {workDate}
                    </span>,
                    <span key="c" className="font-medium">
                      {nameOf(v.caregiver_id)}
                    </span>,
                    <span key="m" className="tabular">
                      {minutesLabel(seg?.verified_minutes ?? v.verified_minutes)}
                    </span>,
                    <span key="r" className="text-[13px]">
                      {seg?.approval_note ?? "Reason not visible to you"}
                    </span>,
                    <span key="b">{nameOf(seg?.approved_by)}</span>,
                  ],
                };
              })}
              empty={
                tab === "approved" ? (
                  <EmptyState
                    icon={<IconCheck />}
                    title="No approved hours yet"
                    body="Approved hours stay here with the measured time beside the approved figure, the pay code, and who decided. A later correction appends a new decision rather than replacing this one."
                  />
                ) : (
                  <EmptyState
                    icon={<IconX />}
                    title="Nothing has been sent back"
                    body="Sending hours back is a normal outcome — a missing clock-out is the commonest reason. The reason stays on the record beside the measured minutes, and the hours stay out of payroll until they are corrected and approved."
                  />
                )
              }
            />
          )}

          {/* Say what is on screen versus what is on record — a truncated list that does
              not admit it is truncated reads as a complete answer. */}
          {tab !== "pending" &&
            !queueGated &&
            (tab === "approved" ? approvedCount.count ?? 0 : rejectedCount.count ?? 0) > visits.length && (
              <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
                Showing the {visits.length} most recent of{" "}
                {tab === "approved" ? approvedCount.count : rejectedCount.count} on record. Every
                decision stays on the record whether or not it is on this page.
              </p>
            )}
        </section>

        {/* ── Payroll periods ───────────────────────────────────────────────── */}
        <section className="mb-10">
          <SectionTitle icon={<IconLock />}>Pay periods</SectionTitle>

          <div className="card mb-3 px-5 py-4">
            <OpenPeriodForm canManage={canManage} defaultStart={startDefault} defaultEnd={endDefault} />
          </div>

          <DataTable
            caption="Payroll periods and their state"
            columns={[
              { header: "Period" },
              { header: "State" },
              { header: "Closed by" },
              { header: "Exported" },
              { header: "" },
            ]}
            rows={periods.map((p) => {
              const st = PERIOD_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
              const exp = exports.find((e) => e.period_id === p.id) ?? null;
              return {
                key: p.id,
                cells: [
                  <span key="w" className="tabular whitespace-nowrap font-medium">
                    {dateOnly(p.starts_on)} – {dateOnly(p.ends_on)}
                  </span>,
                  <Badge key="s" tone={st.tone}>
                    {st.label}
                  </Badge>,
                  <span key="b" className="text-[13px]">
                    {p.locked_by ? nameOf(p.locked_by) : "—"}
                  </span>,
                  <span key="e" className="tabular text-[13px]">
                    {exp ? `${exp.row_count} lines · ${minutesLabel(exp.total_minutes)}` : "—"}
                  </span>,
                  <PeriodActions
                    key="a"
                    periodId={p.id}
                    status={(p.status as "open" | "locked" | "exported") ?? "open"}
                    canManage={canManage}
                  />,
                ],
              };
            })}
            empty={
              <EmptyState
                icon={<IconClock />}
                title="No pay period yet"
                body="A pay period is the window payroll is run over. Open one above, approve the hours inside it, then close it — closing is refused while any completed visit is still waiting on a decision, and it says how many."
              />
            }
          />
        </section>

        {/* ── Exports on record ─────────────────────────────────────────────── */}
        <section>
          <SectionTitle icon={<IconShield />}>Exports on record</SectionTitle>
          {exports.length === 0 ? (
            <EmptyState
              icon={<IconShield />}
              title="Nothing has been exported yet"
              body="Every export records how many lines left, how many minutes they carried, and a fingerprint of the file itself. Re-running an export over unchanged hours reproduces the same fingerprint, which is what makes “is this the file we sent?” an answerable question."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {exports.map((e) => {
                const p = periodById.get(e.period_id);
                return (
                  <div key={e.id} className="card px-5 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-[15px] font-semibold">
                        {p ? `${dateOnly(p.starts_on)} – ${dateOnly(p.ends_on)}` : "Pay period"}
                      </p>
                      <p className="tabular text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {new Date(e.exported_at).toLocaleString("en-US", {
                          timeZone: AGENCY_TZ,
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}{" "}
                        · {nameOf(e.exported_by)}
                      </p>
                    </div>
                    <p className="tabular mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {e.row_count} {e.row_count === 1 ? "line" : "lines"} ·{" "}
                      {minutesLabel(e.total_minutes)} approved · {e.format.toUpperCase()}
                    </p>
                    <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      File fingerprint (SHA-256)
                    </p>
                    <code className="tabular block break-all text-[11px] leading-relaxed">
                      {e.content_sha256}
                    </code>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            A payroll file carries four columns — caregiver, work date, minutes and pay code. It
            never carries a client, an address or anything clinical: a payroll run tells a bookkeeper
            who worked how long, and nothing about who was cared for.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
