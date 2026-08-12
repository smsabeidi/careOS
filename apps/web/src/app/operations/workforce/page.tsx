import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  MetricTile,
  PageHeader,
  ProgressMeter,
  Tabs,
} from "@/components/ui";
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconClock,
  IconLock,
  IconShield,
  IconSparkle,
  IconUsers,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import {
  REPORT_TOPICS,
  getWeeklyWorkforceReport,
  trailingWindow,
  type RosterEntry,
  type WeeklyReport,
  type WeekdayLateness,
} from "@/lib/ai/visit-intelligence";
import { ProfileDraftPanel } from "./profile-draft";

export const metadata = { title: "Workforce" };
export const dynamic = "force-dynamic";

/**
 * /operations/workforce — the intelligence surface (docs/17 §7.2, §10, §11).
 *
 * The contract this page keeps, in order of importance:
 *
 *  1. **The numbers always render.** Every figure comes from app.workforce_features,
 *     computed in SQL under the caller's own AAL2 session and workforce.read permission
 *     (migration 0051). When the written summary is missing — kill switch, budget stop,
 *     provider error, or a guardrail that rejected what came back — the page says so in
 *     one plain sentence and shows the same complete figures. AI is additive here.
 *  2. **No coordinates, no distances, no addresses.** D-030 closes the coordinate list
 *     and this surface does not reopen it: nothing on this screen is geographic, and
 *     nothing geographic was sent to a model.
 *  3. **IDs travel, names are refetched.** The report is built from caregiver IDs. Names
 *     come from a second query under the reader's own RLS, and a row RLS hides renders as
 *     "(restricted)" rather than disappearing — an absent person would silently change
 *     what the totals appear to describe.
 *  4. **Patterns, not verdicts.** The agency-wide report is T1 narration over aggregates.
 *     Characterising one person is a separate T2 capability with a required human
 *     disposer, it is only ever reached by an explicit click, and the copy around it says
 *     plainly that it is evidence for a manager rather than a decision (D-028, D-021).
 *
 * Server component throughout; the only client island is the T2 draft request.
 */

const RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "28", label: "28 days", days: 28 },
  { key: "90", label: "90 days", days: 90 },
] as const;

/** One agency, one calendar: a Maryland RSA (docs/17). Stated in words a reader uses. */
const AGENCY_TZ_LABEL = "Eastern time";

function rangeHref(key: string, caregiver?: string | null): string {
  const params = new URLSearchParams();
  if (key !== "28") params.set("days", key);
  if (caregiver) params.set("caregiver", caregiver);
  const q = params.toString();
  return q ? `/operations/workforce?${q}` : "/operations/workforce";
}

function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function pct(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

function minutes(v: number | null): string {
  return v === null ? "—" : `${v} min`;
}

/** Adherence health as colour + icon + label — never colour alone (docs/17 §12 a11y). */
function AdherenceBadge({ value }: { value: number | null }) {
  if (value === null) return <Badge tone="neutral">Not measured</Badge>;
  if (value >= 90) {
    return (
      <Badge tone="success" icon={<IconCheck />}>
        {value}% on time
      </Badge>
    );
  }
  if (value >= 75) {
    return (
      <Badge tone="warning" icon={<IconClock />}>
        {value}% on time
      </Badge>
    );
  }
  return (
    <Badge tone="danger" icon={<IconAlert />}>
      {value}% on time
    </Badge>
  );
}

/**
 * Seven cells, Sunday first — the index order migration 0051 pins. A cell carries its own
 * number and its own screen-reader label, so the bar height is decoration and never the
 * only carrier of meaning.
 */
function WeekdayStrip({
  days,
  caption,
}: {
  days: { index: number; label: string; mean_late_minutes: number | null }[];
  caption: string;
}) {
  const peak = Math.max(1, ...days.map((d) => d.mean_late_minutes ?? 0));
  return (
    <div>
      <p className="mb-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
        {caption}
      </p>
      <ul className="flex items-end gap-1.5">
        {days.map((d) => {
          const value = d.mean_late_minutes;
          const height = value === null ? 3 : Math.max(3, Math.round((value / peak) * 44));
          const tone =
            value === null
              ? "var(--color-surface-150)"
              : value >= 15
                ? "var(--color-danger-600)"
                : value >= 7
                  ? "var(--color-warning-600)"
                  : "var(--color-success-600)";
          return (
            <li key={d.index} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span
                className="tabular text-[11px] font-semibold"
                style={{ color: value === null ? "var(--text-muted)" : "var(--text-secondary)" }}
              >
                {value === null ? "—" : value}
              </span>
              <span
                aria-hidden
                className="w-full rounded-[3px]"
                style={{ height, background: tone }}
              />
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                <span aria-hidden>{d.label.slice(0, 3)}</span>
                <span className="sr-only">
                  {d.label}:{" "}
                  {value === null
                    ? "no clocked visits"
                    : `${value} minutes average lateness`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The written summary, or an honest sentence about why it is missing. */
function SummaryCard({
  report,
  resolve,
}: {
  report: WeeklyReport;
  /** Maps the model's opaque caregiver handles back to names, server-side. */
  resolve: (text: string) => string;
}) {
  const { narration, note, dropped, model } = report;

  return (
    <section className="card mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
          <span style={{ color: "var(--accent)" }} className="flex">
            <IconSparkle width={16} height={16} />
          </span>
          Written summary
        </h2>
      </div>

      {narration ? (
        <div className="mt-3 px-5 pb-4">
          {narration.headline && (
            <p className="text-[16px] font-medium leading-snug">{resolve(narration.headline)}</p>
          )}
          <div className="mt-3 flex flex-col gap-3.5">
            {narration.sections.map((s) => (
              <div key={s.topic}>
                <p
                  className="mb-1 text-[11px] font-semibold uppercase"
                  style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
                >
                  {REPORT_TOPICS[s.topic] ?? s.topic}
                </p>
                <p className="text-[14.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {resolve(s.text)}
                </p>
              </div>
            ))}
          </div>
          {narration.closing && (
            <p className="mt-3.5 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {resolve(narration.closing)}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 px-5 pb-4">
          <p className="text-[14.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {note ?? "The written summary isn't available right now — the figures below are complete."}
          </p>
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-5 py-2.5 text-[12px] hairline"
        style={{ color: "var(--text-muted)" }}
      >
        <span>
          Every figure on this page is computed by the platform from visit records
          {narration ? `; the wording above is written by ${model ?? "the pinned model"}.` : "."}
        </span>
        {dropped > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <IconAlert width={12} height={12} />
            {dropped} sentence{dropped === 1 ? "" : "s"} set aside for not matching the figures.
          </span>
        )}
      </div>
    </section>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function WorkforcePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; caregiver?: string }>;
}) {
  const params = await searchParams;
  const range = RANGES.find((r) => r.key === params.days) ?? RANGES[1];
  const selectedId = typeof params.caregiver === "string" ? params.caregiver : null;

  await requirePerm("workforce.read");
  const supabase = await supabaseServer();

  const window = trailingWindow(range.days);
  const report = await getWeeklyWorkforceReport(supabase, window);

  const header = (
    <PageHeader
      title="Workforce"
      sub={`Visit performance across the agency · ${longDate(window.from)} to ${longDate(window.to)}`}
    />
  );

  // ── State 1: the deterministic read itself refused. Say which refusal it was, in the
  // words that tell the reader what to do — an AAL2 gate is not an error and an empty
  // list is not "all clear".
  if (report.error) {
    const { code, title, body } = report.error;
    if (code === "CAREOS_AAL2_REQUIRED") {
      return (
        <AppShell active="/operations/workforce">
          <div className="rise">
            {header}
            <EmptyState
              icon={<IconLock />}
              title={title}
              body={body}
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
    if (code === "CAREOS_FORBIDDEN" || code === "CAREOS_POLICY_MISSING" || code === "CAREOS_BAD_WINDOW") {
      return (
        <AppShell active="/operations/workforce">
          <div className="rise">
            {header}
            <EmptyState icon={<IconShield />} title={title} body={body} />
          </div>
        </AppShell>
      );
    }
    return (
      <AppShell active="/operations/workforce">
        <div className="rise">
          {header}
          <ErrorState
            title={title}
            body={body}
            retry={
              <Link href={rangeHref(range.key)} className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const facts = report.facts;

  // ── State 2: read succeeded, nobody worked in the window.
  if (!facts || facts.roster.length === 0) {
    return (
      <AppShell active="/operations/workforce">
        <div className="rise">
          {header}
          <div className="mb-4">
            <Tabs
              label="Date range"
              active={rangeHref(range.key)}
              items={RANGES.map((r) => ({ href: rangeHref(r.key), label: r.label }))}
            />
          </div>
          <EmptyState
            icon={<IconUsers />}
            title="No visits in this range"
            body="Once visits are scheduled and clocked, this page fills in with adherence, lateness, exceptions, overtime and client continuity for every caregiver — and a written summary of what changed. Try a longer range."
          />
        </div>
      </AppShell>
    );
  }

  // ── Names: IDs travel, the label is refetched under the reader's own RLS. A row RLS
  // hides is shown as "(restricted)" and stays in the table, because dropping it would
  // quietly change what the totals appear to cover.
  const rosterIds = facts.roster.map((r) => r.caregiverId);
  const { data: people } = await supabase
    .from("app_user")
    .select("id, full_name")
    .in("id", rosterIds.slice(0, 400));
  const nameById = new Map(
    ((people ?? []) as { id: string; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name ?? "(restricted)",
    ])
  );
  const nameOf = (id: string) => nameById.get(id) ?? "(restricted)";

  // The model refers to people by an opaque handle (`cg-3`) because it never receives a
  // name. Mapping the handle back to a person happens HERE, after the guardrails, so the
  // reader sees a colleague and the model never saw one.
  const labelByKey = new Map(facts.roster.map((r) => [r.key, nameOf(r.caregiverId)]));
  const resolveHandles = (text: string) =>
    text.replace(/\bcg-\d+\b/gi, (m) => labelByKey.get(m.toLowerCase()) ?? m);

  const totals = facts.totals;
  const selected: RosterEntry | null =
    (selectedId && facts.roster.find((r) => r.caregiverId === selectedId)) || null;

  const rows = facts.roster.map((r) => {
    const f = r.feature;
    const isSelected = selected?.caregiverId === r.caregiverId;
    return {
      key: r.caregiverId,
      cells: [
        <Link
          key="who"
          href={rangeHref(range.key, isSelected ? null : r.caregiverId)}
          className="inline-flex flex-col"
          aria-current={isSelected ? "true" : undefined}
        >
          <span className="text-[14px] font-medium">{nameOf(r.caregiverId)}</span>
          <span className="tabular text-[11px]" style={{ color: "var(--text-muted)" }}>
            {r.key} · {f.visits_completed} of {f.visits_scheduled} completed
          </span>
        </Link>,
        <AdherenceBadge key="adh" value={f.schedule_adherence_pct} />,
        <span key="late" className="tabular">
          {f.late_count}
          {f.avg_late_minutes !== null && (
            <span className="ml-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
              avg {f.avg_late_minutes} min
            </span>
          )}
        </span>,
        <span key="missed" className="tabular">
          {f.visits_missed}
        </span>,
        <span key="exc" className="tabular">
          {r.exceptions}
        </span>,
        <span key="ver" className="tabular">
          {f.verified_rate === null ? "—" : `${Math.round(f.verified_rate * 1000) / 10}%`}
        </span>,
        <span key="ot" className="tabular">
          {f.overtime_minutes === 0 ? "—" : `${Math.round((f.overtime_minutes / 60) * 10) / 10} h`}
        </span>,
        <span key="cont" className="tabular">
          {pct(f.client_continuity_pct)}
        </span>,
      ],
    };
  });

  return (
    <AppShell active="/operations/workforce">
      <div className="rise">
        {header}

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile
            label="Caregivers with visits"
            value={totals.caregivers}
            tone="accent"
            icon={<IconUsers />}
            hint={`${totals.visits_completed} of ${totals.visits_scheduled} visits completed`}
          />
          <MetricTile
            label="On time"
            value={pct(totals.adherence_pct)}
            tone={
              totals.adherence_pct === null
                ? "neutral"
                : totals.adherence_pct >= 90
                  ? "success"
                  : totals.adherence_pct >= 75
                    ? "warning"
                    : "danger"
            }
            icon={<IconClock />}
            hint={`${totals.late_count} late starts · ${totals.visits_missed} missed`}
          />
          <MetricTile
            label="Open findings"
            value={totals.exceptions_total}
            tone={totals.exceptions_total === 0 ? "success" : "warning"}
            icon={<IconAlert />}
            hint={`${totals.missing_clock_out_count} missing clock-out · ${totals.documentation_missing_count} missing note`}
          />
          <MetricTile
            label="Overtime"
            value={`${totals.overtime_hours} h`}
            tone={totals.overtime_minutes === 0 ? "neutral" : "warning"}
            icon={<IconActivity />}
            hint={`Across ${facts.days} days`}
          />
        </div>

        <p className="mb-5 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          These figures are computed in the database from visit records, under your own permissions and
          your verified session. The written summary is produced from those figures alone: it receives
          counts, minutes and percentages identified by a code, never a name, a client, an address, or a
          location of any kind. Codes are matched back to people here, on your screen.
        </p>

        <div className="mb-4">
          <Tabs
            label="Date range"
            active={rangeHref(range.key, selectedId)}
            items={RANGES.map((r) => ({ href: rangeHref(r.key, selectedId), label: r.label }))}
          />
        </div>

        <SummaryCard report={report} resolve={resolveHandles} />

        <section className="card mb-6 px-5 py-4">
          <WeekdayStrip
            days={facts.weekday}
            caption="Average lateness by weekday — the mean of each caregiver's own average, so every caregiver counts once."
          />
          <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
            {facts.weekday.filter((d: WeekdayLateness) => d.caregivers_reporting > 0).length} of 7 weekdays
            have clocked visits in this range. A dash means nobody clocked a visit that day, not a perfect day.
          </p>
        </section>

        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
          <span style={{ color: "var(--accent)" }} className="flex">
            <IconUsers width={16} height={16} />
          </span>
          By caregiver
        </h2>

        <DataTable
          caption={`Workforce figures per caregiver, ${window.from} to ${window.to}`}
          columns={[
            { header: "Caregiver" },
            { header: "Adherence" },
            { header: "Late starts", align: "right" },
            { header: "Missed", align: "right" },
            { header: "Findings", align: "right" },
            { header: "Verified", align: "right" },
            { header: "Overtime", align: "right" },
            { header: "Continuity", align: "right" },
          ]}
          rows={rows}
        />

        {selected && (
          <section className="mt-6">
            <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em]">
              {nameOf(selected.caregiverId)}
              <span className="ml-2 text-[13px] font-normal" style={{ color: "var(--text-muted)" }}>
                {longDate(window.from)} to {longDate(window.to)}
              </span>
            </h2>

            <div className="card px-5 py-4">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="flex flex-col gap-4">
                  <ProgressMeter
                    label="Visits completed"
                    value={selected.feature.visits_completed}
                    max={Math.max(1, selected.feature.visits_scheduled)}
                    tone="accent"
                    valueLabel={`${selected.feature.visits_completed} of ${selected.feature.visits_scheduled}`}
                  />
                  <ProgressMeter
                    label="On time"
                    value={selected.feature.schedule_adherence_pct ?? 0}
                    tone={
                      (selected.feature.schedule_adherence_pct ?? 0) >= 90
                        ? "success"
                        : (selected.feature.schedule_adherence_pct ?? 0) >= 75
                          ? "warning"
                          : "danger"
                    }
                    valueLabel={pct(selected.feature.schedule_adherence_pct)}
                  />
                  <ProgressMeter
                    label="Verified clock records"
                    value={(selected.feature.verified_rate ?? 0) * 100}
                    tone="success"
                    valueLabel={
                      selected.feature.verified_rate === null
                        ? "—"
                        : `${Math.round(selected.feature.verified_rate * 1000) / 10}%`
                    }
                  />
                  <ProgressMeter
                    label="Client continuity"
                    value={selected.feature.client_continuity_pct ?? 0}
                    tone="accent"
                    valueLabel={pct(selected.feature.client_continuity_pct)}
                  />
                </div>

                <div className="flex flex-col gap-4">
                  <WeekdayStrip
                    days={[0, 1, 2, 3, 4, 5, 6].map((i) => ({
                      index: i,
                      label: [
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ][i],
                      mean_late_minutes: selected.feature.day_of_week_lateness[i],
                    }))}
                    caption="Average lateness by weekday, in minutes."
                  />
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                    <dt style={{ color: "var(--text-muted)" }}>Late starts</dt>
                    <dd className="tabular text-right">
                      {selected.feature.late_count} · {minutes(selected.feature.avg_late_minutes)} avg
                    </dd>
                    <dt style={{ color: "var(--text-muted)" }}>Early arrivals</dt>
                    <dd className="tabular text-right">{selected.feature.early_count}</dd>
                    <dt style={{ color: "var(--text-muted)" }}>Missed visits</dt>
                    <dd className="tabular text-right">{selected.feature.visits_missed}</dd>
                    <dt style={{ color: "var(--text-muted)" }}>Open findings</dt>
                    <dd className="tabular text-right">{selected.exceptions}</dd>
                    <dt style={{ color: "var(--text-muted)" }}>Clock records typed by a person</dt>
                    <dd className="tabular text-right">{selected.feature.manual_override_count}</dd>
                    <dt style={{ color: "var(--text-muted)" }}>Overtime</dt>
                    <dd className="tabular text-right">
                      {Math.round((selected.feature.overtime_minutes / 60) * 10) / 10} h
                    </dd>
                    <dt style={{ color: "var(--text-muted)" }}>Time beyond the window</dt>
                    <dd className="tabular text-right">{selected.feature.overrun_minutes} min</dd>
                    <dt style={{ color: "var(--text-muted)" }}>Time short of the window</dt>
                    <dd className="tabular text-right">{selected.feature.undertime_minutes} min</dd>
                  </dl>
                </div>
              </div>
            </div>

            <ProfileDraftPanel
              caregiverId={selected.caregiverId}
              caregiverLabel={nameOf(selected.caregiverId)}
              from={window.from}
              to={window.to}
            />

            <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Dates follow the agency calendar ({AGENCY_TZ_LABEL}). These figures describe visit records,
              not a person&apos;s worth: they are the starting point for a conversation a manager has, and
              this system never proposes an employment decision.
            </p>
          </section>
        )}
      </div>
    </AppShell>
  );
}
