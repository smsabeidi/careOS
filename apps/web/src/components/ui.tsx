/** CareOS component set — docs/10 §3. Locked variants; extend here, never inline. */
import type { ReactNode } from "react";
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
    <div className="card flex flex-col items-center text-center px-8 py-14 gap-3">
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-full"
             style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-sm text-sm" style={{ color: "var(--text-muted)" }}>{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ── ErrorState: what happened + what's preserved + what to do ── */
export function ErrorState({ title, body, retry }: { title: string; body: string; retry?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center text-center px-8 py-12 gap-3" role="alert">
      <div className="flex size-12 items-center justify-center rounded-full"
           style={{ background: "var(--color-danger-50)", color: "var(--color-danger-600)" }}>
        <IconAlert />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-sm text-sm" style={{ color: "var(--text-muted)" }}>{body}</p>
      {retry && <div className="mt-2">{retry}</div>}
    </div>
  );
}

/* ── Avatar (initials) ── */
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
        background: "var(--accent-soft)",
        color: "var(--accent)",
        border: "1px solid var(--accent-soft-border)",
      }}
    >
      {initials}
    </span>
  );
}

/* ── PageHeader ── */
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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{title}</h1>
        {sub && <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
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

/* ── Stat tile ── */
export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-[13px] font-medium" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="tabular mt-1 text-[28px] font-semibold leading-tight tracking-[-0.02em]">{value}</p>
      {hint && <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
    </div>
  );
}
