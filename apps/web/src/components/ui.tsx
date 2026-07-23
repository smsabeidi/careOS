/** CareOS component set — Apple 2026 language. Locked variants; extend here, never inline.
 *  Server-safe (no "use client"): imported by server components. Interactive controls use the
 *  `.switch` / `.segmented` CSS primitives from globals.css inside client files. */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { IconAlert, IconCheck, IconLock, IconSparkle } from "./icons";

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

/* ── Stat tile — big value in Instrument Serif, tabular ── */
export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-[13px] font-medium" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="title-lg tabular mt-1 text-[34px]">{value}</p>
      {hint && <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
    </div>
  );
}
