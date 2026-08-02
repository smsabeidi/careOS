/**
 * Scheduling board — presentational primitives (server-rendered).
 *
 * All server components: the entire board, including the fill drawer, renders to HTML on
 * the server. No "use client", so no PHI (client/caregiver names) ever reaches the JS
 * bundle, and the field-surface JS budget stays at zero for this route. Interaction is
 * URL-driven (week / filter / assign params) — fully keyboard-operable and works without JS.
 *
 * These are local to the scheduling surface by design: shared `ui.tsx` is not edited.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { Avatar, Badge, StatusChip } from "@/components/ui";
import {
  IconAlert,
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconLock,
  IconMapPin,
  IconPlus,
  IconShield,
  IconSparkle,
  IconUsers,
  IconX,
} from "@/components/icons";
import {
  type Candidate,
  type Visit,
  type WeekModel,
  durationLabel,
  timeLabel,
  weekRangeLabel,
} from "./schedule-data";
// Type-only imports (erased at compile time) from the fill-agent action module.
import type {
  CoveragePanel as CoveragePanelData,
  FillCandidate,
  OpenVisit,
} from "./agent-actions";

/* ─────────────────────────── URL helpers ─────────────────────────── */

export function href(params: {
  week?: number;
  filter?: string;
  assign?: string;
  /** Open the coverage panel for a real, unassigned visit (the fill agent). */
  fill?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.week && params.week !== 0) sp.set("week", String(params.week));
  if (params.filter && params.filter !== "all") sp.set("filter", params.filter);
  if (params.assign) sp.set("assign", params.assign);
  if (params.fill) sp.set("fill", params.fill);
  const s = sp.toString();
  return s ? `/schedule?${s}` : "/schedule";
}

type Ctx = { offset: number; filter: string };

/* ─────────────────────────── Honesty + flash banners ─────────────────────────── */

export function PreviewBanner() {
  return (
    <div
      className="card-inset mb-6 flex items-start gap-3 px-4 py-3.5"
      style={{ background: "var(--accent-soft)", borderColor: "var(--accent-soft-border)" }}
    >
      <span style={{ color: "var(--accent)" }} className="mt-0.5 shrink-0">
        <IconShield width={18} height={18} />
      </span>
      <div className="min-w-0">
        <p className="text-[14px] font-semibold" style={{ color: "var(--accent-text)" }}>
          Preview schedule. Scheduling engine not connected in this environment
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          This week is generated from Meadowbrook&apos;s real care-team assignments. Nothing is
          saved. When scheduling is live, each fill runs the database&apos;s{" "}
          <code className="tabular text-[12px]" style={{ color: "var(--accent-text)" }}>
            assert_schedulable
          </code>{" "}
          check and is recorded with an audit event.
        </p>
      </div>
    </div>
  );
}

export function FlashBanner({ text }: { text: string }) {
  return (
    <div
      className="card mb-6 flex items-start gap-3 px-4 py-3.5"
      role="status"
      style={{ borderColor: "var(--accent-soft-border)" }}
    >
      <span style={{ color: "var(--accent)" }} className="mt-0.5 shrink-0">
        <IconAlert width={18} height={18} />
      </span>
      <p className="text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {text}
      </p>
    </div>
  );
}

/* ─────────────────────────── Metrics ─────────────────────────── */

type Tone = "neutral" | "accent" | "warning" | "danger" | "success";

function MetricTile({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: ReactNode;
  tone?: Tone;
}) {
  const fg =
    tone === "warning"
      ? "var(--color-warning-700)"
      : tone === "danger"
      ? "var(--color-danger-700)"
      : tone === "accent"
      ? "var(--accent-text)"
      : tone === "success"
      ? "var(--color-success-700)"
      : "var(--text-muted)";
  return (
    <div className="card px-5 py-4">
      <div className="flex items-center gap-2" style={{ color: fg }}>
        {icon}
        <p className="text-[13px] font-medium">{label}</p>
      </div>
      <p className="title-lg tabular mt-1.5 text-[32px]" style={{ color: tone === "neutral" ? undefined : fg }}>
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function ScheduleMetrics({ week }: { week: WeekModel }) {
  const s = week.stats;
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      <MetricTile
        label="Coverage"
        value={`${s.coverage}%`}
        hint={`${s.scheduled} visits filled`}
        icon={<IconShield width={15} height={15} />}
        tone={s.coverage >= 95 ? "success" : s.coverage >= 85 ? "warning" : "danger"}
      />
      <MetricTile
        label="Open shifts"
        value={s.open}
        hint={s.open ? "Need a caregiver" : "All covered"}
        icon={<IconPlus width={15} height={15} />}
        tone={s.open ? "accent" : "success"}
      />
      <MetricTile
        label="Exceptions"
        value={s.exceptions}
        hint={s.exceptions ? "Need attention" : "None this week"}
        icon={<IconAlert width={15} height={15} />}
        tone={s.exceptions ? "warning" : "success"}
      />
      <MetricTile
        label="Caregivers scheduled"
        value={s.caregivers}
        hint={`${s.clients} clients`}
        icon={<IconUsers width={15} height={15} />}
      />
    </div>
  );
}

/* ─────────────────────────── Week navigation + filters ─────────────────────────── */

export function WeekNav({ week, ctx }: { week: WeekModel; ctx: Ctx }) {
  return (
    <div className="flex items-center gap-1.5">
      <Link
        href={href({ week: ctx.offset - 1, filter: ctx.filter })}
        className="btn btn-secondary btn-sm"
        aria-label="Previous week"
        style={{ paddingInline: "0.625rem" }}
      >
        <IconChevronRight width={16} height={16} style={{ transform: "rotate(180deg)" }} />
      </Link>
      <Link
        href={href({ week: 0, filter: ctx.filter })}
        className="btn btn-secondary btn-sm tabular"
        aria-current={ctx.offset === 0 ? "date" : undefined}
        style={ctx.offset === 0 ? { color: "var(--accent-text)" } : undefined}
      >
        <IconCalendar width={15} height={15} />
        {weekRangeLabel(week.monday)}
      </Link>
      <Link
        href={href({ week: ctx.offset + 1, filter: ctx.filter })}
        className="btn btn-secondary btn-sm"
        aria-label="Next week"
        style={{ paddingInline: "0.625rem" }}
      >
        <IconChevronRight width={16} height={16} />
      </Link>
    </div>
  );
}

export function FilterTabs({ week, ctx }: { week: WeekModel; ctx: Ctx }) {
  const tabs: { key: string; label: string; count?: number }[] = [
    { key: "all", label: "All caregivers", count: week.stats.caregivers },
    { key: "open", label: "Open shifts", count: week.stats.open },
    { key: "exceptions", label: "Exceptions", count: week.stats.exceptions },
  ];
  return (
    <div className="segmented" role="tablist" aria-label="Filter the schedule">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={href({ week: ctx.offset, filter: t.key })}
          role="tab"
          aria-selected={ctx.filter === t.key}
          data-active={ctx.filter === t.key}
        >
          {t.label}
          {typeof t.count === "number" && (
            <span className="tabular ml-1.5 opacity-60">{t.count}</span>
          )}
        </Link>
      ))}
    </div>
  );
}

export function Legend() {
  const Item = ({ swatch, label }: { swatch: ReactNode; label: string }) => (
    <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
      {swatch}
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <Item
        swatch={<span className="size-3 rounded-[4px]" style={{ background: "var(--panel)", border: "1px solid var(--border-strong)" }} />}
        label="Scheduled visit"
      />
      <Item
        swatch={
          <span
            className="size-3 rounded-[4px]"
            style={{ background: "var(--accent-soft)", border: "1.5px dashed var(--accent)" }}
          />
        }
        label="Open shift"
      />
      <Item
        swatch={<span className="size-3 rounded-[4px]" style={{ background: "var(--color-warning-50)", borderLeft: "3px solid var(--color-warning-600)" }} />}
        label="Exception"
      />
    </div>
  );
}

/* ─────────────────────────── Visit chips ─────────────────────────── */

function ExceptionDot() {
  return (
    <span style={{ color: "var(--color-warning-700)" }} className="shrink-0">
      <IconAlert width={12} height={12} />
    </span>
  );
}

function VisitChip({ v }: { v: Visit }) {
  const isException = Boolean(v.exception);
  return (
    <div
      className="rounded-[8px] px-2 py-1.5"
      title={v.exception ? v.exception.detail : `${v.clientName} · ${timeLabel(v.start)} · ${durationLabel(v.durationMin)}`}
      style={
        isException
          ? { background: "var(--color-warning-50)", borderLeft: "3px solid var(--color-warning-600)" }
          : { background: "var(--color-surface-50)", border: "1px solid var(--border)" }
      }
    >
      <div className="flex items-center gap-1">
        {isException && <ExceptionDot />}
        <p className="truncate text-[12.5px] font-medium leading-tight">{v.clientName}</p>
      </div>
      <p className="tabular mt-0.5 text-[11px] leading-tight" style={{ color: "var(--text-muted)" }}>
        {timeLabel(v.start)} · {durationLabel(v.durationMin)}
      </p>
    </div>
  );
}

function OpenShiftChip({ v, ctx }: { v: Visit; ctx: Ctx }) {
  return (
    <Link
      href={href({ week: ctx.offset, filter: ctx.filter, assign: v.id })}
      className="block rounded-[8px] px-2 py-1.5 transition-colors"
      style={{ background: "var(--accent-soft)", border: "1.5px dashed var(--accent)" }}
      title={`Fill open shift · ${v.clientName} · ${timeLabel(v.start)}`}
    >
      <div className="flex items-center gap-1" style={{ color: "var(--accent-text)" }}>
        <IconPlus width={12} height={12} />
        <p className="truncate text-[12.5px] font-semibold leading-tight">Open</p>
      </div>
      <p className="truncate text-[11px] leading-tight" style={{ color: "var(--accent-text)" }}>
        {v.clientName}
      </p>
      <p className="tabular text-[11px] leading-tight" style={{ color: "var(--accent-text)", opacity: 0.75 }}>
        {timeLabel(v.start)}
      </p>
    </Link>
  );
}

/* ─────────────────────────── The week grid ─────────────────────────── */

const COLS = "180px repeat(7, minmax(112px, 1fr))";

function DayHeader({ week }: { week: WeekModel }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: COLS }}>
      <div className="sticky left-0 z-10 px-3 py-2.5" style={{ background: "var(--panel)" }} />
      {week.days.map((d, i) => (
        <div
          key={i}
          className="px-2 py-2.5 text-center"
          style={{
            background: d.isToday ? "var(--accent-soft)" : d.isWeekend ? "var(--color-surface-50)" : "var(--panel)",
            borderLeft: "1px solid var(--border)",
          }}
        >
          <p
            className="text-[12px] font-semibold uppercase tracking-wide"
            style={{ color: d.isToday ? "var(--accent-text)" : "var(--text-muted)" }}
          >
            {d.weekday}
          </p>
          <p className="tabular text-[13px] font-medium" style={{ color: d.isToday ? "var(--accent-text)" : "var(--text)" }}>
            {d.date.getDate()}
          </p>
        </div>
      ))}
    </div>
  );
}

function GridCell({
  day,
  children,
}: {
  day: { isToday: boolean; isWeekend: boolean };
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-1 px-1.5 py-1.5"
      style={{
        borderLeft: "1px solid var(--border)",
        background: day.isToday ? "color-mix(in srgb, var(--accent-soft) 45%, transparent)" : day.isWeekend ? "var(--color-surface-25)" : "transparent",
      }}
    >
      {children}
    </div>
  );
}

function OpenLane({ week, ctx }: { week: WeekModel; ctx: Ctx }) {
  if (week.openShifts.length === 0) return null;
  const byDay = (day: number) => week.openShifts.filter((v) => v.day === day);
  return (
    <div className="grid border-t hairline" style={{ gridTemplateColumns: COLS, background: "color-mix(in srgb, var(--accent-soft) 30%, transparent)" }}>
      <div className="sticky left-0 z-10 flex items-center gap-2 px-3 py-2.5" style={{ background: "var(--accent-soft)" }}>
        <span style={{ color: "var(--accent)" }}>
          <IconPlus width={16} height={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold" style={{ color: "var(--accent-text)" }}>
            Open shifts
          </p>
          <p className="text-[11px]" style={{ color: "var(--accent-text)", opacity: 0.7 }}>
            {week.openShifts.length} to fill
          </p>
        </div>
      </div>
      {week.days.map((d, i) => (
        <GridCell key={i} day={d}>
          {byDay(i).map((v) => (
            <OpenShiftChip key={v.id} v={v} ctx={ctx} />
          ))}
        </GridCell>
      ))}
    </div>
  );
}

function CaregiverRow({
  row,
  week,
}: {
  row: WeekModel["rows"][number];
  week: WeekModel;
}) {
  const byDay = (day: number) => row.visits.filter((v) => v.day === day);
  const over = row.weekHours > 40;
  return (
    <div className="grid border-t hairline" style={{ gridTemplateColumns: COLS }}>
      <div className="sticky left-0 z-10 flex items-center gap-2.5 px-3 py-2.5" style={{ background: "var(--panel)" }}>
        <Avatar name={row.caregiver.name} size={32} />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium leading-tight">{row.caregiver.name}</p>
          <p className="tabular mt-0.5 text-[11px] leading-tight" style={{ color: over ? "var(--color-warning-700)" : "var(--text-muted)" }}>
            {row.weekHours.toFixed(0)}h
            {row.credential && (
              <span style={{ color: "var(--color-warning-700)" }} className="ml-1.5 inline-flex items-center gap-0.5">
                <IconAlert width={11} height={11} />
                {row.credential.type} lapsed
              </span>
            )}
          </p>
        </div>
      </div>
      {week.days.map((d, i) => (
        <GridCell key={i} day={d}>
          {byDay(i).map((v) => (
            <VisitChip key={v.id} v={v} />
          ))}
        </GridCell>
      ))}
    </div>
  );
}

export function WeekGrid({ week, ctx }: { week: WeekModel; ctx: Ctx }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <div style={{ minWidth: 900 }}>
          <DayHeader week={week} />
          <OpenLane week={week} ctx={ctx} />
          {week.rows.map((row) => (
            <CaregiverRow key={row.caregiver.id} row={row} week={week} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Attention panel (leads the page) ─────────────────────────── */

export function AttentionPanel({ week, ctx }: { week: WeekModel; ctx: Ctx }) {
  const openTop = week.openShifts.slice(0, 6);
  const excTop = week.exceptions.slice(0, 6);
  const weekday = (d: number) => week.days[d]?.weekday ?? "";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Open shifts */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <span style={{ color: "var(--accent)" }}>
              <IconPlus width={16} height={16} />
            </span>
            Open shifts
          </p>
          <span className="tabular text-[13px]" style={{ color: "var(--text-muted)" }}>
            {week.openShifts.length}
          </span>
        </div>
        {openTop.length === 0 ? (
          <p className="px-5 py-6 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
            No open shifts this week
          </p>
        ) : (
          <div className="divide-y hairline">
            {openTop.map((v) => (
              <Link key={v.id} href={href({ week: ctx.offset, filter: ctx.filter, assign: v.id })} className="row-link group py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                  <IconClock width={17} height={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{v.clientName}</p>
                  <p className="tabular text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                    {weekday(v.day)} · {timeLabel(v.start)} · {durationLabel(v.durationMin)}
                    {v.clientCity ? ` · ${v.clientCity}` : ""}
                  </p>
                </div>
                <span className="btn btn-tinted btn-sm shrink-0">
                  Fill
                  <IconArrowRight width={14} height={14} />
                </span>
              </Link>
            ))}
            {week.openShifts.length > openTop.length && (
              <Link href={href({ week: ctx.offset, filter: "open" })} className="row-link py-3 text-[13px]" style={{ color: "var(--accent-text)" }}>
                View all {week.openShifts.length} open shifts
                <IconChevronRight width={14} height={14} />
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Exceptions */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <span style={{ color: "var(--color-warning-700)" }}>
              <IconAlert width={16} height={16} />
            </span>
            Needs attention
          </p>
          <span className="tabular text-[13px]" style={{ color: "var(--text-muted)" }}>
            {week.exceptions.length}
          </span>
        </div>
        {excTop.length === 0 ? (
          <p className="px-5 py-6 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
            No exceptions this week
          </p>
        ) : (
          <div className="divide-y hairline">
            {excTop.map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}>
                  {v.exception?.kind === "credential" ? <IconLock width={16} height={16} /> : <IconAlert width={16} height={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{v.exception?.detail}</p>
                  <p className="tabular text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                    {v.clientName} · {weekday(v.day)} {timeLabel(v.start)}
                  </p>
                </div>
                <StatusChip status={v.exception?.kind === "credential" ? "on_hold" : "in_review"} label={v.exception?.kind === "credential" ? "Credential" : "Late note"} />
              </div>
            ))}
            {week.exceptions.length > excTop.length && (
              <Link href={href({ week: ctx.offset, filter: "exceptions" })} className="row-link py-3 text-[13px]" style={{ color: "var(--accent-text)" }}>
                View all {week.exceptions.length} exceptions
                <IconChevronRight width={14} height={14} />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Fill agent: coverage requests + coverage panel ───────────────────────────
 * These two are the ONLY surfaces on this page backed by real `visit` rows. The board
 * above is an illustration (see schedule-data.ts); everything below runs the live
 * scheduling engine — `app.rank_fill_candidates` → `app.assert_schedulable` — and is
 * therefore the only place a fill can be started. The separation is deliberate and
 * stated in the copy, so nobody mistakes the preview for the record.
 */

/** Live, unassigned visits: the fill agent's entry point. */
export function CoverageRequests({
  visits,
  ctx,
  fillAction,
}: {
  visits: OpenVisit[];
  ctx: Ctx;
  fillAction: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="card overflow-hidden">
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <span style={{ color: "var(--accent)" }}>
              <IconUsers width={16} height={16} />
            </span>
            Coverage requests
          </p>
          <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            Unassigned visits from the live schedule. Finding coverage ranks caregivers in the
            database and drafts a plan for you to approve. Nothing is assigned and nothing is sent.
          </p>
        </div>
        <span className="tabular text-[13px] shrink-0" style={{ color: "var(--text-muted)" }}>
          {visits.length}
        </span>
      </div>

      {visits.length === 0 ? (
        <p className="px-5 py-6 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
          No unassigned visits right now. Coverage requests appear here as soon as a visit loses its
          caregiver.
        </p>
      ) : (
        <div className="divide-y hairline">
          {visits.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                <IconClock width={17} height={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{v.clientName}</p>
                <p className="tabular text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                  {v.dayLabel} · {v.timeLabel} · {v.durationLabel}
                  {v.city ? ` · ${v.city}` : ""}
                </p>
              </div>
              {v.hasPendingPlan ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone="warning" icon={<IconClock />}>
                    Plan waiting in approvals
                  </Badge>
                  <Link
                    href={href({ week: ctx.offset, filter: ctx.filter, fill: v.id })}
                    className="btn btn-secondary btn-sm"
                  >
                    View plan
                    <IconArrowRight width={14} height={14} />
                  </Link>
                </div>
              ) : (
                <form action={fillAction} className="shrink-0">
                  <input type="hidden" name="visitId" value={v.id} />
                  <input type="hidden" name="week" value={String(ctx.offset)} />
                  <input type="hidden" name="filter" value={ctx.filter} />
                  <button type="submit" className="btn btn-primary btn-sm">
                    <IconSparkle width={15} height={15} />
                    Find coverage
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One ranked candidate. Blocked candidates are shown, explained, and never selectable. */
function CandidateRow({ c }: { c: FillCandidate }) {
  return (
    <div
      className="rounded-[12px] px-3.5 py-3"
      aria-disabled={c.blocked || undefined}
      style={{
        background: c.blocked ? "var(--color-surface-50)" : "var(--panel)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="flex items-center gap-3">
        <Avatar name={c.name} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium">{c.name}</p>
          <p className="tabular text-[12px]" style={{ color: "var(--text-muted)" }}>
            Score {c.score}
          </p>
        </div>
        {c.blocked ? (
          <span className="chip chip-danger shrink-0">
            <IconLock width={12} height={12} />
            Not selectable
          </span>
        ) : (
          <span className="chip chip-success shrink-0">
            <IconCheck width={12} height={12} />
            Can be offered
          </span>
        )}
      </div>

      {c.blocked && c.blockers.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {c.blockers.map((b, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[12.5px]"
              style={{ color: "var(--color-danger-700)" }}
            >
              <span className="mt-0.5 shrink-0">
                <IconAlert width={12} height={12} />
              </span>
              <span>
                {b.name} is {b.reason}. The scheduling engine blocks the assignment until it is back
                on file.
              </span>
            </li>
          ))}
        </ul>
      )}

      {c.reasons.length > 0 && (
        <p className="mt-2 text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
          {c.reasons.join(" · ")}
        </p>
      )}

      {!c.blocked && c.offer && (
        <p
          className="mt-2 rounded-[10px] px-3 py-2 text-[12.5px] leading-relaxed"
          style={{ background: "var(--color-surface-50)", color: "var(--text-secondary)" }}
        >
          {c.offer}
        </p>
      )}
    </div>
  );
}

const ELIGIBLE_SHOWN = 8;
const BLOCKED_SHOWN = 6;

/**
 * The coverage panel. Renders in full with the model unavailable: the ranking, the
 * scores, the reasons and the blockers are the database's answer, not the assistant's.
 */
export function CoveragePanel({ panel, ctx }: { panel: CoveragePanelData; ctx: Ctx }) {
  const eligible = panel.candidates.filter((c) => !c.blocked);
  const blocked = panel.candidates.filter((c) => c.blocked);
  const closeHref = href({ week: ctx.offset, filter: ctx.filter });

  return (
    <section className="card mb-8 overflow-hidden" aria-label={`Coverage for ${panel.clientName}`}>
      <header
        className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="min-w-0">
          <p
            className="text-[12px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--accent-text)" }}
          >
            Coverage for an open visit
          </p>
          <h2 className="mt-0.5 truncate text-[19px] font-semibold tracking-[-0.01em]">
            {panel.clientName}
          </h2>
          <p
            className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="inline-flex items-center gap-1">
              <IconCalendar width={13} height={13} />
              {panel.dayLabel}
            </span>
            <span className="inline-flex items-center gap-1">
              <IconClock width={13} height={13} />
              {panel.timeLabel} · {panel.durationLabel}
            </span>
            {panel.city && (
              <span className="inline-flex items-center gap-1">
                <IconMapPin width={13} height={13} />
                {panel.city}
              </span>
            )}
          </p>
        </div>
        <Link href={closeHref} className="btn btn-secondary btn-sm shrink-0">
          <IconX width={15} height={15} />
          Close
        </Link>
      </header>

      <div className="px-5 py-4">
        {panel.engineNote ? (
          <div
            className="card-inset mb-4 flex items-start gap-3 px-4 py-3"
            role="alert"
            style={{ background: "var(--color-danger-50)" }}
          >
            <span style={{ color: "var(--color-danger-700)" }} className="mt-0.5 shrink-0">
              <IconAlert width={16} height={16} />
            </span>
            <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {panel.engineNote}
            </p>
          </div>
        ) : null}

        {/* The plan the coordinator disposes. */}
        {panel.plan ? (
          <div className="card-inset mb-5 px-4 py-3.5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-semibold">Outreach plan</p>
              {panel.plan.status === "pending" ? (
                <Badge tone="warning" icon={<IconClock />}>
                  Waiting for approval
                </Badge>
              ) : (
                <StatusChip status="active" label={`Plan ${panel.plan.status}`} />
              )}
              <Badge
                tone={panel.plan.source === "assistant" ? "accent" : "neutral"}
                icon={panel.plan.source === "assistant" ? <IconSparkle /> : <IconShield />}
              >
                {panel.plan.source === "assistant" ? "Drafted with AI" : "Written by the platform"}
              </Badge>
              <span className="tabular text-[12px]" style={{ color: "var(--text-muted)" }}>
                {panel.plan.proposedAtLabel}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{panel.plan.body}</p>
            {panel.plan.note && (
              <p
                className="mt-2 flex items-start gap-1.5 text-[12.5px]"
                style={{ color: "var(--text-muted)" }}
              >
                <span className="mt-0.5 shrink-0">
                  <IconAlert width={12} height={12} />
                </span>
                {panel.plan.note}
              </p>
            )}
            <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
              Nothing has been sent. A coordinator approves, edits or rejects this plan before any
              offer goes out, and the first caregiver to accept takes the shift.
            </p>
            {panel.plan.status === "pending" && (
              <Link href="/inbox?tab=pending" className="btn btn-secondary btn-sm mt-3">
                Review in approvals
                <IconArrowRight width={14} height={14} />
              </Link>
            )}
          </div>
        ) : (
          <p className="mb-5 text-[13px]" style={{ color: "var(--text-muted)" }}>
            No outreach plan has been drafted for this visit yet. The ranking below is live from the
            scheduling engine.
          </p>
        )}

        <p
          className="mb-3 flex items-start gap-1.5 text-[12px]"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="mt-0.5 shrink-0">
            <IconShield width={13} height={13} />
          </span>
          Ranked by the database, not by the assistant. Score starts at 100: minus 40 when the
          engine finds a blocker, plus 25 for an active assignment with this client, plus 10 for the
          same service area, minus the hours already scheduled that week.
        </p>

        {panel.candidates.length === 0 && !panel.engineNote && (
          <p className="py-6 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
            No caregivers were returned for this visit. Widening the window or clearing a credential
            blocker is the next step.
          </p>
        )}

        {eligible.length > 0 && (
          <>
            <p className="mb-2 text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
              Can be offered · {panel.eligibleCount}
            </p>
            <div className="space-y-1.5">
              {eligible.slice(0, ELIGIBLE_SHOWN).map((c) => (
                <CandidateRow key={c.caregiverId} c={c} />
              ))}
            </div>
            {eligible.length > ELIGIBLE_SHOWN && (
              <p className="mt-2 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                Showing the {ELIGIBLE_SHOWN} highest-ranked of {eligible.length} schedulable
                caregivers.
              </p>
            )}
          </>
        )}

        {blocked.length > 0 && (
          <>
            <p
              className="mb-2 mt-5 text-[13px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              Blocked by the scheduling engine · {panel.blockedCount}
            </p>
            <div className="space-y-1.5">
              {blocked.slice(0, BLOCKED_SHOWN).map((c) => (
                <CandidateRow key={c.caregiverId} c={c} />
              ))}
            </div>
            {blocked.length > BLOCKED_SHOWN && (
              <p className="mt-2 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                Showing {BLOCKED_SHOWN} of {blocked.length} blocked caregivers.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────── Assign drawer (URL-driven, assert_schedulable feedback) ─────────────────────────── */

function VerdictRow({
  candidate,
  shift,
  ctx,
  assignAction,
}: {
  candidate: Candidate;
  shift: Visit;
  ctx: Ctx;
  assignAction: (formData: FormData) => void | Promise<void>;
}) {
  const v = candidate.verdict;
  const blocked = v.status === "blocked";
  return (
    <div
      className="flex items-center gap-3 rounded-[12px] px-3 py-2.5"
      style={{
        background: blocked ? "var(--color-surface-50)" : "var(--panel)",
        border: "1px solid var(--border)",
        opacity: blocked ? 0.92 : 1,
      }}
    >
      <Avatar name={candidate.caregiver.name} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[14px] font-medium">{candidate.caregiver.name}</p>
          {v.status === "preferred" && <StatusChip status="active" label="On care team" />}
        </div>
        {v.status === "blocked" ? (
          <p className="mt-0.5 flex items-center gap-1 text-[12.5px]" style={{ color: "var(--color-danger-700)" }}>
            <IconLock width={12} height={12} />
            {v.detail}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            {v.notes.join(" · ")}
          </p>
        )}
      </div>
      {v.status === "blocked" ? (
        <span className="chip chip-danger shrink-0">
          <IconX width={12} height={12} />
          {v.reason}
        </span>
      ) : (
        <form action={assignAction}>
          <input type="hidden" name="shiftId" value={shift.id} />
          <input type="hidden" name="caregiverId" value={candidate.caregiver.id} />
          <input type="hidden" name="caregiverName" value={candidate.caregiver.name} />
          <input type="hidden" name="clientName" value={shift.clientName} />
          <input type="hidden" name="week" value={String(ctx.offset)} />
          <input type="hidden" name="filter" value={ctx.filter} />
          <button type="submit" className="btn btn-primary btn-sm shrink-0">
            Assign
          </button>
        </form>
      )}
    </div>
  );
}

export function AssignDrawer({
  shift,
  candidates,
  week,
  ctx,
  assignAction,
}: {
  shift: Visit;
  candidates: Candidate[];
  week: WeekModel;
  ctx: Ctx;
  assignAction: (formData: FormData) => void | Promise<void>;
}) {
  const closeHref = href({ week: ctx.offset, filter: ctx.filter });
  const eligible = candidates.filter((c) => c.verdict.status !== "blocked");
  const blocked = candidates.filter((c) => c.verdict.status === "blocked");
  const day = week.days[shift.day];

  return (
    <>
      {/* Scrim — clicking it closes the drawer (a real link, so it works without JS). */}
      <Link href={closeHref} aria-label="Close" className="scrim fixed inset-0 z-40" />
      <aside
        className="sheet fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={`Fill open shift for ${shift.clientName}`}
        style={{ borderRadius: 0 }}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--accent-text)" }}>
              Fill open shift
            </p>
            <h2 className="mt-0.5 truncate text-[19px] font-semibold tracking-[-0.01em]">{shift.clientName}</h2>
            <p className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
              <span className="inline-flex items-center gap-1">
                <IconCalendar width={13} height={13} />
                {day?.weekday} {day?.label}
              </span>
              <span className="inline-flex items-center gap-1">
                <IconClock width={13} height={13} />
                {timeLabel(shift.start)} · {durationLabel(shift.durationMin)}
              </span>
              {shift.clientCity && (
                <span className="inline-flex items-center gap-1">
                  <IconMapPin width={13} height={13} />
                  {shift.clientCity}
                </span>
              )}
            </p>
            {shift.vacatedBy && (
              <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                Previously assigned to {shift.vacatedBy}.
              </p>
            )}
          </div>
          <Link href={closeHref} className="btn btn-secondary btn-sm shrink-0" aria-label="Close" style={{ paddingInline: "0.5rem" }}>
            <IconX width={16} height={16} />
          </Link>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
            <IconShield width={13} height={13} />
            Checked against credentials, double-booking, and the 40h overtime cap. The database
            enforces the same checks.
          </p>

          {eligible.length > 0 && (
            <>
              <p className="mb-2 mt-1 text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                Eligible · {eligible.length}
              </p>
              <div className="space-y-1.5">
                {eligible.map((c) => (
                  <VerdictRow key={c.caregiver.id} candidate={c} shift={shift} ctx={ctx} assignAction={assignAction} />
                ))}
              </div>
            </>
          )}

          {blocked.length > 0 && (
            <>
              <p className="mb-2 mt-5 text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                Not eligible · {blocked.length}
              </p>
              <div className="space-y-1.5">
                {blocked.slice(0, 8).map((c) => (
                  <VerdictRow key={c.caregiver.id} candidate={c} shift={shift} ctx={ctx} assignAction={assignAction} />
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
