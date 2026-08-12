/** CareOS component set — Apple 2026 language. Locked variants; extend here, never inline.
 *  Server-safe (no "use client"): imported by server components. Interactive controls use the
 *  `.switch` / `.segmented` CSS primitives from globals.css inside client files. */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import {
  IconAlert, IconArrowDownRight, IconArrowUpRight, IconCheck, IconClock, IconLock, IconSparkle,
} from "./icons";

/* Interactive primitives live in the client sibling; re-exported so callers keep
 * a single import surface (`import { Sheet, Drawer } from "@/components/ui"`). */
export { Sheet, Drawer } from "./ui.client";

type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

/** Normalize a glyph to a fixed optical size (shared by chips/badges/timelines). */
function sizeGlyph(icon: ReactNode, px: number): ReactNode {
  return isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ width?: number; height?: number }>, { width: px, height: px })
    : icon;
}

/* ── StatusChip: color + icon + label, never color alone ── */
const CHIP_STYLES: Record<string, { cls: string; icon?: ReactNode }> = {
  draft: { cls: "chip-neutral", icon: <Dot /> },
  in_review: { cls: "chip-info", icon: <Dot /> },
  final: { cls: "chip-success", icon: <IconCheck width={12} height={12} /> },
  superseded: { cls: "chip-neutral", icon: <Dot /> },
  void: { cls: "chip-neutral", icon: <Dot /> },
  active: { cls: "chip-success", icon: <IconCheck width={12} height={12} /> },
  inquiry: { cls: "chip-info", icon: <Dot /> },
  pending_admission: { cls: "chip-warning", icon: <Dot /> },
  on_hold: { cls: "chip-warning", icon: <IconAlert width={12} height={12} /> },
  discharged: { cls: "chip-neutral", icon: <Dot /> },
  aal2: { cls: "chip-accent", icon: <IconLock width={12} height={12} /> },
  ai: { cls: "chip-accent", icon: <IconSparkle width={12} height={12} /> },
};

function Dot() {
  return <span aria-hidden className="inline-block size-1.5 rounded-full bg-current" />;
}

const LABELS: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  final: "Final",
  superseded: "Superseded",
  void: "Void",
  active: "Active",
  inquiry: "Inquiry",
  pending_admission: "Pending admission",
  on_hold: "On hold",
  discharged: "Discharged",
  aal2: "Verified session",
  ai: "AI-assisted",
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const s = CHIP_STYLES[status] ?? { cls: "chip-neutral", icon: <Dot /> };
  return (
    <span className={`chip ${s.cls}`}>
      {s.icon}
      {label ?? LABELS[status] ?? status}
    </span>
  );
}

/* ── TintTile: rounded "app-icon" glyph on a soft accent field ── */
export function TintTile({
  icon,
  size = 40,
  tone = "accent",
}: {
  icon: ReactNode;
  size?: number;
  tone?: "accent" | "success" | "warning" | "danger" | "neutral";
}) {
  const bg =
    tone === "success" ? "var(--color-success-50)"
    : tone === "warning" ? "var(--color-warning-50)"
    : tone === "danger" ? "var(--color-danger-50)"
    : tone === "neutral" ? "var(--color-surface-100)"
    : "var(--accent-soft)";
  const fg =
    tone === "success" ? "var(--color-success-700)"
    : tone === "warning" ? "var(--color-warning-700)"
    : tone === "danger" ? "var(--color-danger-700)"
    : tone === "neutral" ? "var(--text-secondary)"
    : "var(--accent)";
  // Normalize glyph to 50% of the tile so every TintTile reads at the same optical weight.
  const g = Math.round(size * 0.5);
  const glyph = isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ width?: number; height?: number }>, { width: g, height: g })
    : icon;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: size * 0.3, background: bg, color: fg }}
    >
      {glyph}
    </span>
  );
}

/* ── EmptyState: friendly explanation + primary action (docs/10 §8) ── */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-3 px-8 py-16 text-center">
      {icon && <TintTile icon={icon} size={52} />}
      <h3 className="mt-1 text-[17px] font-semibold tracking-[-0.01em]">{title}</h3>
      <p className="max-w-sm text-[15px] leading-relaxed" style={{ color: "var(--text-muted)" }}>{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ── ErrorState: what happened + what's preserved + what to do ── */
export function ErrorState({ title, body, retry }: { title: string; body: string; retry?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-8 py-14 text-center" role="alert">
      <TintTile icon={<IconAlert />} size={52} tone="danger" />
      <h3 className="mt-1 text-[17px] font-semibold tracking-[-0.01em]">{title}</h3>
      <p className="max-w-sm text-[15px] leading-relaxed" style={{ color: "var(--text-muted)" }}>{body}</p>
      {retry && <div className="mt-2">{retry}</div>}
    </div>
  );
}

/* ── Avatar (initials, soft gradient) ── */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: "linear-gradient(160deg, var(--color-accent-100), var(--accent-soft))",
        color: "var(--accent-text)",
        border: "1px solid var(--accent-soft-border)",
        letterSpacing: "-0.02em",
      }}
    >
      {initials}
    </span>
  );
}

/* ── PageHeader — serif large title (the brand voice) ── */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="title-lg text-[30px] sm:text-[34px]">{title}</h1>
        {sub && <p className="mt-1.5 text-[15px]" style={{ color: "var(--text-muted)" }}>{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ── SectionTitle — quiet, consistent section header (glyph normalized to 16px) ── */
export function SectionTitle({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  const glyph = isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ width?: number; height?: number }>, { width: 16, height: 16 })
    : icon;
  return (
    <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
      {icon && <span className="flex" style={{ color: "var(--accent)" }}>{glyph}</span>}
      {children}
    </h2>
  );
}

/* ── Skeleton rows (layout-mirroring) ── */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card divide-y hairline overflow-hidden" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="skeleton size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3.5 w-40" />
            <div className="skeleton h-3 w-24" />
          </div>
          <div className="skeleton h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/* ── Stat tile — big value in display type, tabular ── */
export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-[13px] font-medium" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="title-lg tabular mt-1 text-[34px]">{value}</p>
      {hint && <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
    </div>
  );
}

/* ── Badge — free-form capsule (StatusChip is status-keyed; this is general) ── */
export function Badge({
  children,
  tone = "neutral",
  icon,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  icon?: ReactNode;
}) {
  return (
    <span className={`chip chip-${tone}`}>
      {icon && sizeGlyph(icon, 12)}
      {children}
    </span>
  );
}

/* ── Tabs — URL-driven segmented control (server-safe; the URL is the state) ── */
export function Tabs({
  items,
  active,
  label = "Sections",
}: {
  items: { href: string; label: string; count?: number }[];
  active: string;
  label?: string;
}) {
  return (
    <nav
      aria-label={label}
      className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[var(--radius-md)] border p-0.5 hairline"
      style={{ background: "var(--color-surface-100)" }}
    >
      {items.map((t) => {
        const on = t.href === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            data-active={on}
            aria-current={on ? "page" : undefined}
            className="flex shrink-0 items-center gap-1.5 rounded-[calc(var(--radius-md)-3px)] px-3.5 py-1.5 text-[13px] font-medium transition-colors"
            style={{
              background: on ? "#fff" : "transparent",
              color: on ? "var(--text)" : "var(--text-secondary)",
              boxShadow: on ? "var(--shadow-sm)" : "none",
            }}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="tabular text-[11px]" style={{ color: "var(--text-muted)" }}>
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/* ── MetricTile — KPI card: label · serif value · optional icon, delta, hint ── */
export function MetricTile({
  label,
  value,
  icon,
  tone = "accent",
  hint,
  delta,
}: {
  label: string;
  value: string | number;
  icon?: ReactNode;
  tone?: Tone;
  hint?: string;
  delta?: { label: string; direction?: "up" | "down" | "flat" };
}) {
  const deltaColor =
    delta?.direction === "up" ? "var(--color-success-700)"
    : delta?.direction === "down" ? "var(--color-danger-700)"
    : "var(--text-muted)";
  const DeltaIcon =
    delta?.direction === "up" ? IconArrowUpRight
    : delta?.direction === "down" ? IconArrowDownRight
    : null;
  return (
    <div className="card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium" style={{ color: "var(--text-muted)" }}>{label}</p>
        {icon && <TintTile icon={icon} size={32} tone={tone} />}
      </div>
      <p className="title-lg tabular mt-2 text-[32px] leading-none">{value}</p>
      {(delta || hint) && (
        <div className="mt-2 flex items-center gap-2">
          {delta && (
            <span
              className="inline-flex items-center gap-0.5 text-[12px] font-semibold"
              style={{ color: deltaColor }}
            >
              {DeltaIcon && <DeltaIcon width={13} height={13} />}
              {delta.label}
            </span>
          )}
          {hint && <span className="text-xs" style={{ color: "var(--text-muted)" }}>{hint}</span>}
        </div>
      )}
    </div>
  );
}

/* ── DataTable — semantic header + rows, horizontal-scroll safe, four-state ready ──
 * columns line up with each row's `cells` array by index. Pass `empty` (e.g. an
 * <EmptyState/>) to own the empty state; otherwise a quiet built-in row shows. */
type DataColumn = { header: ReactNode; align?: "left" | "right" | "center"; className?: string };
type DataRow = { key: string; cells: ReactNode[] };
export function DataTable({
  columns,
  rows,
  empty,
  caption,
  dense = false,
}: {
  columns: DataColumn[];
  rows: DataRow[];
  empty?: ReactNode;
  caption?: string;
  dense?: boolean;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  const pad = dense ? "py-2.5" : "py-3.5";
  return (
    <div className="card overflow-hidden">
      {/* A pane that scrolls sideways has to be reachable by keyboard, or the columns past
          the fold exist only for people using a mouse — on this surface that can be the
          column saying whether somebody was paid. `tabindex=0` makes it focusable so the
          arrow keys scroll it, and the region takes the table's own caption as its name so
          a screen-reader user is told which table they have landed in rather than hearing a
          bare "region". (axe: scrollable-region-focusable, serious.) */}
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role={caption ? "region" : undefined}
        aria-label={caption}
      >
        <table className="w-full border-collapse text-[14px]">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b hairline">
              {columns.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`whitespace-nowrap px-5 py-3 text-[11px] font-semibold uppercase ${c.className ?? ""}`}
                  style={{ textAlign: c.align ?? "left", color: "var(--text-muted)", letterSpacing: "0.04em" }}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-5 py-10 text-center text-[14px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  No records yet
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0 hairline hover:bg-[var(--color-surface-50)]">
                  {r.cells.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`px-5 align-middle ${pad} ${columns[ci]?.className ?? ""}`}
                      style={{ textAlign: columns[ci]?.align ?? "left" }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Timeline — vertical event rail (append-only history, credential events…) ── */
export function Timeline({
  items,
}: {
  items: { icon?: ReactNode; title: ReactNode; meta?: ReactNode; time?: string; tone?: Tone }[];
}) {
  return (
    <ol className="relative flex flex-col">
      {items.map((it, i) => (
        <li key={i} className="relative flex gap-4 pb-5 last:pb-0">
          {i < items.length - 1 && (
            <span
              aria-hidden
              className="absolute left-4 top-9 bottom-0 w-px"
              style={{ background: "var(--border)" }}
            />
          )}
          <span className="relative z-10">
            <TintTile icon={it.icon ?? <Dot />} size={32} tone={it.tone ?? "accent"} />
          </span>
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[14px] font-medium">{it.title}</p>
              {it.time && (
                <span className="tabular shrink-0 text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {it.time}
                </span>
              )}
            </div>
            {it.meta && (
              <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>{it.meta}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ── ProgressMeter — labeled progress bar, tone-colored fill ── */
export function ProgressMeter({
  value,
  max = 100,
  label,
  tone = "accent",
  showValue = true,
  valueLabel,
}: {
  value: number;
  max?: number;
  label?: ReactNode;
  tone?: "accent" | "success" | "warning" | "danger";
  showValue?: boolean;
  valueLabel?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  const fill =
    tone === "success" ? "var(--color-success-600)"
    : tone === "warning" ? "var(--color-warning-600)"
    : tone === "danger" ? "var(--color-danger-600)"
    : "var(--accent)";
  return (
    <div>
      {(label || showValue) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && <span className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>{label}</span>}
          {showValue && <span className="tabular text-[13px] font-semibold">{valueLabel ?? `${pct}%`}</span>}
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        style={{ background: "var(--color-surface-150)" }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: fill, transition: "width var(--dur-slow) var(--ease-out)" }}
        />
      </div>
    </div>
  );
}

/* ── DueChip — colors a due date by proximity (due / due-soon / overdue) ──
 * PRESENTATION ONLY. The due date itself is produced by the rules engine
 * (invariant 13: deadlines & cadences are SQL, never computed client-side or by
 * an LLM). This just picks a color + words for an already-decided date. */
export function DueChip({
  due,
  now,
  prefix = "Due",
}: {
  due: string | Date;
  now?: Date;
  prefix?: string;
}) {
  // Parse to a LOCAL calendar day (avoid the UTC-midnight off-by-one on YYYY-MM-DD).
  let dueLocal: Date;
  if (typeof due === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
    dueLocal = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(due);
  } else {
    dueLocal = due;
  }
  if (Number.isNaN(dueLocal.getTime())) {
    return <span className="chip chip-neutral">{prefix} —</span>;
  }
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dueMid = startOfDay(dueLocal).getTime();
  const nowMid = startOfDay(now ?? new Date()).getTime();
  const diff = Math.round((dueMid - nowMid) / 86_400_000);

  let cls: string;
  let icon: ReactNode | null;
  let text: string;
  if (diff < 0) {
    cls = "chip-danger";
    icon = <IconAlert width={12} height={12} />;
    text = `Overdue ${-diff}d`;
  } else if (diff === 0) {
    cls = "chip-warning";
    icon = <IconClock width={12} height={12} />;
    text = `${prefix} today`;
  } else if (diff === 1) {
    cls = "chip-warning";
    icon = <IconClock width={12} height={12} />;
    text = `${prefix} tomorrow`;
  } else if (diff <= 7) {
    cls = "chip-warning";
    icon = <IconClock width={12} height={12} />;
    text = `${prefix} in ${diff}d`;
  } else {
    cls = "chip-neutral";
    icon = null;
    text = `${prefix} ${dueLocal.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  return (
    <span className={`chip ${cls}`}>
      {icon}
      {text}
    </span>
  );
}
