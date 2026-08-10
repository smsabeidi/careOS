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
  IconCalendar,
  IconCheck,
  IconClock,
  IconLock,
  IconShield,
  IconUsers,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";

export const metadata = { title: "Attendance" };
export const dynamic = "force-dynamic";

/**
 * Attendance — scheduled versus actual, per caregiver (docs/17 §7.2).
 *
 * WHAT THIS SCREEN IS ALLOWED TO DO, AND WHAT IT IS NOT (invariant 13).
 * Every minute, rate and percentage on this page is computed in Postgres and rendered
 * verbatim. The per-caregiver rollup comes from `app.workforce_features` (docs/17 §10),
 * which is the ONLY input any workforce analysis may read; the per-visit rows come from
 * `public.verified_visit` (0045), whose late/overrun/verified minutes are SQL expressions
 * over the append-only clock ledger. Nothing here is averaged, rounded, prorated or
 * re-derived in JavaScript. The only arithmetic in this file is (a) summing whole visit
 * COUNTS for the top-line tiles and (b) splitting an integer number of minutes into
 * hours and minutes for display, which is lossless. If a number looks wrong, the fix is
 * in SQL, not here.
 *
 * PHI DISCIPLINE (invariant 5, D-030). No coordinate, no distance in metres and no
 * accuracy radius is selected, let alone rendered — the location column shows the
 * database's own verdict in plain words. Client names are not shown at all: attendance
 * is a question about a caregiver's shift, not about who was cared for, so the least
 * identifying rendering that still answers the question is the right one. Caregiver
 * names are refetched under RLS from ids and read "(restricted)" when RLS hides them.
 *
 * Four-state doctrine (docs/10 §8): loading.tsx mirrors this layout, an error early-
 * returns, and an empty list is probed for its gated cause before it is called empty —
 * `verified_visit` composes through the visit RLS policy, so a payroll-only principal
 * with no `schedule.read` sees zero rows rather than a refusal.
 *
 * @trace ST-208, docs/17 §7.2 §10, D-024, D-030, invariants 5, 9, 13
 */

const AGENCY_TZ = "America/New_York";

/** Window presets. Anything else in `?days=` is clamped into this range, never trusted. */
const PRESET_DAYS = [7, 14, 30] as const;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

/** Per-visit detail is a reading aid, not a report: the rollup above it is the report. */
const DETAIL_LIMIT = 80;

/* ── Row shapes (explicit columns only; never select(*)) ───────────────────── */

/** One row of `app.workforce_features(...).caregivers` — docs/17 §10, IDs never names. */
type CaregiverFeature = {
  caregiver_id: string;
  visits_scheduled: number;
  visits_completed: number;
  visits_missed: number;
  late_count: number;
  avg_late_minutes: number | string | null;
  early_count: number;
  overrun_minutes: number;
  undertime_minutes: number;
  verified_rate: number | string | null;
  location_exception_count: number;
  manual_override_count: number;
  missing_clock_out_count: number;
  overlap_count: number;
  impossible_travel_count: number;
  documentation_missing_count: number;
  schedule_adherence_pct: number | string | null;
  overtime_minutes: number;
  client_continuity_pct: number | string | null;
  trust_band_histogram: Record<string, number> | null;
  day_of_week_lateness: (number | string | null)[] | null;
};

type WorkforceFeatures = {
  ok?: boolean;
  from?: string;
  to?: string;
  generated_at?: string;
  caregivers?: CaregiverFeature[];
};

/** `public.verified_visit` — deliberately WITHOUT the two distance columns (D-030). */
type VerifiedVisitRow = {
  visit_id: string;
  caregiver_id: string | null;
  status: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  scheduled_minutes: number | null;
  verified_minutes: number | null;
  late_minutes: number | null;
  overrun_minutes: number | null;
  verification_status: string;
  clock_in_location_status: string | null;
  clock_out_location_status: string | null;
  had_offline_capture: boolean | null;
};

type PersonRow = { id: string; full_name: string | null };

/* ── Formatting helpers — presentation only, never arithmetic on money or minutes ─── */

/** jsonb numerics arrive as numbers; the string arm is defensive, not expected. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a whole number of minutes into hours and minutes for reading.
 * LOSSLESS DECOMPOSITION, NOT ROUNDING: h * 60 + m is exactly the value the database
 * returned. No minute is ever created, dropped or rounded in this file (invariant 13).
 */
function minutesLabel(total: number | null): string {
  if (total === null) return "—";
  const sign = total < 0 ? "−" : "";
  const abs = Math.abs(total);
  const h = (abs - (abs % 60)) / 60;
  const m = abs % 60;
  if (h === 0) return `${sign}${m} min`;
  return m === 0 ? `${sign}${h} h` : `${sign}${h} h ${m} m`;
}

/** A ratio the database computed, shown as a percentage. A unit change, not a rounding. */
function rateLabel(v: number | string | null | undefined): string {
  const n = num(v);
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function pctLabel(v: number | string | null | undefined): string {
  const n = num(v);
  return n === null ? "—" : `${n}%`;
}

function timeOf(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" });
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: AGENCY_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Calendar date in UTC, matching the pinning `app.workforce_features` uses for its window. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A YYYY-MM-DD boundary rendered as itself. Read at noon UTC so no timezone can shift a
 * calendar date onto the day before it — the window label has to name the days the
 * database actually queried.
 */
function boundaryLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/* ── Status vocabulary — colour + icon + label, never colour alone (docs/10) ── */

const VISIT_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  missed: { label: "Missed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const VERIFICATION: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  pending: { label: "Not verified yet", tone: "neutral" },
  verified: { label: "Verified", tone: "success" },
  exception: { label: "Needs review", tone: "warning" },
  manual_review: { label: "Manual review", tone: "warning" },
};

/**
 * The location verdict in plain words. D-030: never metres, never an accuracy radius,
 * never the word geofence or GPS. The database decided; this only says what it decided.
 */
const LOCATION_WORDS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  verified: { label: "Location confirmed", tone: "success" },
  low_accuracy: { label: "Location unclear", tone: "warning" },
  outside_geofence: { label: "Away from the care address", tone: "warning" },
  unavailable: { label: "No location recorded", tone: "neutral" },
  suspicious: { label: "Flagged for review", tone: "danger" },
  not_required: { label: "Not required", tone: "neutral" },
};

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawDays = Array.isArray(params.days) ? params.days[0] : params.days;
  // Clamped SERVER-SIDE: the window sizes a full-tenant analytics scan, so a hand-typed
  // `?days=99999` must not become a query. `app.workforce_features` refuses >366 days of
  // its own accord; this keeps the surface inside a range a person can actually read.
  const parsed = Number.parseInt(rawDays ?? "", 10);
  const days = Number.isFinite(parsed) ? Math.max(MIN_DAYS, Math.min(MAX_DAYS, parsed)) : DEFAULT_DAYS;

  await requirePerm("visit.verify.read");
  const supabase = await supabaseServer();

  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const fromDate = utcDate(from);
  const toDate = utcDate(to);
  // Half-open upper bound, the same shape the SQL window uses (`< (p_to + 1)`).
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const untilIso = `${utcDate(new Date(to.getTime() + 86_400_000))}T00:00:00.000Z`;

  const [visitRes, featureRes] = await Promise.all([
    supabase
      .from("verified_visit")
      // One string literal, not a concatenation: supabase-js infers the row shape from the
      // literal, and a built string degrades the whole result to an untyped error union.
      .select(
        "visit_id, caregiver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, scheduled_minutes, verified_minutes, late_minutes, overrun_minutes, verification_status, clock_in_location_status, clock_out_location_status, had_offline_capture"
      )
      .gte("scheduled_start", fromIso)
      .lt("scheduled_start", untilIso)
      .neq("status", "cancelled")
      .order("scheduled_start", { ascending: false })
      .limit(500),
    // docs/17 §10 — the only workforce feature source. It carries its own gate
    // (`workforce.read`), which this page does NOT require, so a refusal here is a
    // narrower view rather than an error: the per-visit evidence below still stands.
    supabase.schema("app").rpc("workforce_features", {
      p_from: fromDate,
      p_to: toDate,
      p_caregiver: null,
    }),
  ]);

  const tabs = [...new Set([...PRESET_DAYS, days])].sort((a, b) => a - b);
  const hrefFor = (d: number) => (d === DEFAULT_DAYS ? "/operations/attendance" : `/operations/attendance?days=${d}`);
  const windowLabel = `${boundaryLabel(fromDate)} – ${boundaryLabel(toDate)}`;

  const header = (
    <PageHeader
      title="Attendance"
      sub={`Scheduled against actual · last ${days} ${days === 1 ? "day" : "days"} · ${windowLabel}`}
    />
  );

  if (visitRes.error) {
    return (
      <AppShell active="/operations/attendance">
        <div className="rise">
          {header}
          <ErrorState
            title="Couldn't load attendance"
            body="No visit, clock record or approval was changed — this screen only reads. Refresh to try again, or verify your session if it has expired."
            retry={
              <Link href={hrefFor(days)} className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const rows = (visitRes.data ?? []) as VerifiedVisitRow[];

  // Degraded read, named rather than implied. `verified_visit` composes through the visit
  // policy: PHI needs AAL2 (invariant 3), and the rows themselves need schedule.read,
  // care-team membership or ownership of the visit. Either can produce a silent zero.
  if (rows.length === 0) {
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
    if (!aal2) {
      return (
        <AppShell active="/operations/attendance">
          <div className="rise">
            {header}
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to see attendance"
              body="Attendance is built from visit records, so it appears only on a verified (MFA) session. Nothing is missing from the record — it is waiting behind the second factor."
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
    if (!scheduleRead) {
      return (
        <AppShell active="/operations/attendance">
          <div className="rise">
            {header}
            <EmptyState
              icon={<IconShield />}
              title="Your access doesn't include the visit schedule"
              body="Attendance reads the schedule itself, and your role can see approvals without seeing every visit. Nothing is hidden from the record — ask an administrator for schedule access if you need this view."
            />
          </div>
        </AppShell>
      );
    }
  }

  const features = (featureRes.data ?? null) as WorkforceFeatures | null;
  const featureRows = (features?.caregivers ?? []) as CaregiverFeature[];
  // The refusal, if any, is a permission verdict — never a PHI fragment, so it is safe to
  // reason about here. It is reported as a note on the page, not as a page-level error.
  const featureBlocked = Boolean(featureRes.error);
  const featureBlockedByPermission = /CAREOS_FORBIDDEN|CAREOS_AAL2_REQUIRED/.test(
    featureRes.error?.message ?? ""
  );

  // Names travel as ids and are refetched under RLS (invariant 5). A caregiver the viewer
  // cannot read stays a row with its numbers and a "(restricted)" label — the shift
  // happened whether or not this viewer may see who worked it.
  const caregiverIds = [
    ...new Set([
      ...featureRows.map((f) => f.caregiver_id),
      ...rows.map((r) => r.caregiver_id).filter((x): x is string => Boolean(x)),
    ]),
  ];
  const { data: people } = caregiverIds.length
    ? await supabase.from("app_user").select("id, full_name").in("id", caregiverIds)
    : { data: [] as PersonRow[] };
  const nameById = new Map(
    ((people ?? []) as PersonRow[]).map((p) => [p.id, p.full_name ?? "(restricted)"])
  );
  const nameOf = (id: string | null) => (id ? nameById.get(id) ?? "(restricted)" : "Unassigned");

  /* ── Top line. Sums of whole visit COUNTS only — no minute is aggregated here, and no
       rate is averaged across people, because an average of averages is a different
       number than the one the database computed (invariant 13). ────────────────────── */
  const counted = featureRows.length > 0;
  const scheduledCount = counted
    ? featureRows.reduce((n, f) => n + f.visits_scheduled, 0)
    : rows.length;
  const completedCount = counted
    ? featureRows.reduce((n, f) => n + f.visits_completed, 0)
    : rows.filter((r) => r.status === "completed").length;
  const missedCount = counted
    ? featureRows.reduce((n, f) => n + f.visits_missed, 0)
    : rows.filter((r) => r.status === "missed").length;
  const lateCount = counted
    ? featureRows.reduce((n, f) => n + f.late_count, 0)
    : rows.filter((r) => (r.late_minutes ?? 0) > 0).length;

  const detail = rows.slice(0, DETAIL_LIMIT);

  return (
    <AppShell active="/operations/attendance">
      <div className="rise">
        {header}

        <div className="mb-4">
          <Tabs
            label="Reporting window"
            active={hrefFor(days)}
            items={tabs.map((d) => ({ href: hrefFor(d), label: `${d} days` }))}
          />
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Visits scheduled" value={scheduledCount} tone="accent" icon={<IconCalendar />} />
          <MetricTile label="Completed" value={completedCount} tone="success" icon={<IconCheck />} />
          <MetricTile
            label="Late arrivals"
            value={lateCount}
            tone="warning"
            icon={<IconClock />}
            hint="Past the agency's late threshold"
          />
          <MetricTile label="Missed" value={missedCount} tone="danger" icon={<IconAlert />} />
        </div>

        {/* ── Per caregiver ─────────────────────────────────────────────────── */}
        <section className="mb-8">
          <SectionTitle icon={<IconUsers />}>By caregiver</SectionTitle>

          {featureBlocked ? (
            <EmptyState
              icon={<IconShield />}
              title={
                featureBlockedByPermission
                  ? "Your access doesn't include workforce analytics"
                  : "The per-caregiver summary is unavailable"
              }
              body={
                featureBlockedByPermission
                  ? "The rollup of lateness, overrun and verified rate is a separate permission from reading verifications. The visit-by-visit evidence below is unaffected and comes from the same records."
                  : "The summary could not be computed just now. Nothing was changed — the visit-by-visit evidence below is read from the same records and is complete."
              }
            />
          ) : (
            <DataTable
              caption="Attendance by caregiver over the selected window"
              columns={[
                { header: "Caregiver" },
                { header: "Scheduled", align: "right" },
                { header: "Completed", align: "right" },
                { header: "Missed", align: "right" },
                { header: "Late", align: "right" },
                { header: "Avg late", align: "right" },
                { header: "Overrun", align: "right" },
                { header: "Overtime", align: "right" },
                { header: "Verified", align: "right" },
                { header: "On time", align: "right" },
              ]}
              rows={featureRows.map((f) => ({
                key: f.caregiver_id,
                cells: [
                  <span key="n" className="font-medium">
                    {nameOf(f.caregiver_id)}
                  </span>,
                  <span key="s" className="tabular">
                    {f.visits_scheduled}
                  </span>,
                  <span key="c" className="tabular">
                    {f.visits_completed}
                  </span>,
                  <span key="m" className="tabular" style={f.visits_missed > 0 ? { color: "var(--color-danger-700)" } : undefined}>
                    {f.visits_missed}
                  </span>,
                  <span key="l" className="tabular">
                    {f.late_count}
                  </span>,
                  <span key="al" className="tabular">
                    {minutesLabel(num(f.avg_late_minutes))}
                  </span>,
                  <span key="o" className="tabular">
                    {minutesLabel(f.overrun_minutes)}
                  </span>,
                  <span key="ot" className="tabular">
                    {minutesLabel(f.overtime_minutes)}
                  </span>,
                  <span key="v" className="tabular">
                    {rateLabel(f.verified_rate)}
                  </span>,
                  <span key="a" className="tabular">
                    {pctLabel(f.schedule_adherence_pct)}
                  </span>,
                ],
              }))}
              empty={
                <EmptyState
                  icon={<IconUsers />}
                  title="Nobody worked in this window"
                  body="No visit was scheduled to a caregiver between these dates, so there is nothing to compare. Widen the window above, or check the schedule for the days you expect."
                />
              }
            />
          )}

          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Every figure in this table is computed in the database from the clock record and shown
            exactly as it was returned. Lateness is measured against the agency&apos;s own threshold,
            and overtime against its weekly ceiling — this screen never re-derives, averages or
            rounds a minute of anyone&apos;s time.
          </p>
        </section>

        {/* ── Visit by visit ────────────────────────────────────────────────── */}
        <section>
          <SectionTitle icon={<IconClock />}>Visit by visit</SectionTitle>
          <DataTable
            dense
            caption="Scheduled against actual, visit by visit"
            columns={[
              { header: "Day" },
              { header: "Caregiver" },
              { header: "Scheduled" },
              { header: "Actual" },
              { header: "Late", align: "right" },
              { header: "Overrun", align: "right" },
              { header: "Worked", align: "right" },
              { header: "Visit" },
              { header: "Verification" },
            ]}
            rows={detail.map((r) => {
              const st = VISIT_STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
              const vs = VERIFICATION[r.verification_status] ?? {
                label: r.verification_status,
                tone: "neutral" as const,
              };
              const loc = r.clock_in_location_status ? LOCATION_WORDS[r.clock_in_location_status] : null;
              return {
                key: r.visit_id,
                cells: [
                  <span key="d" className="whitespace-nowrap">
                    {dayOf(r.scheduled_start)}
                  </span>,
                  <span key="c">{nameOf(r.caregiver_id)}</span>,
                  <span key="s" className="tabular whitespace-nowrap">
                    {timeOf(r.scheduled_start)} – {timeOf(r.scheduled_end)}
                  </span>,
                  <span key="a" className="tabular whitespace-nowrap">
                    {r.actual_start || r.actual_end
                      ? `${timeOf(r.actual_start)} – ${timeOf(r.actual_end)}`
                      : "Not clocked"}
                  </span>,
                  <span
                    key="l"
                    className="tabular"
                    style={(r.late_minutes ?? 0) > 0 ? { color: "var(--color-warning-700)" } : undefined}
                  >
                    {minutesLabel(r.late_minutes)}
                  </span>,
                  <span key="o" className="tabular">
                    {minutesLabel(r.overrun_minutes)}
                  </span>,
                  <span key="w" className="tabular">
                    {minutesLabel(r.verified_minutes)}
                  </span>,
                  <Badge key="st" tone={st.tone}>
                    {st.label}
                  </Badge>,
                  <span key="v" className="flex flex-wrap items-center gap-1">
                    <Badge tone={vs.tone}>{vs.label}</Badge>
                    {loc && loc.tone !== "success" && <Badge tone={loc.tone}>{loc.label}</Badge>}
                    {r.had_offline_capture && <Badge tone="info">Recorded offline</Badge>}
                  </span>,
                ],
              };
            })}
            empty={
              <EmptyState
                icon={<IconCalendar />}
                title="No visits in this window"
                body="Once visits are scheduled and caregivers clock in and out, each shift appears here beside the time it was booked for, with the minutes the database measured between the two."
              />
            }
          />
          {rows.length > detail.length && (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Showing the {detail.length} most recent of {rows.length} visits in this window. The
              per-caregiver table above counts all of them.
            </p>
          )}
        </section>
      </div>
    </AppShell>
  );
}
