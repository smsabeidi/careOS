/** Exec dashboard viz atoms — dependency-free, server-safe, Apple-clean.
 *  Single-hue magnitude (one accent), direct value labels, text-token labels
 *  (identity never color-alone), rounded data-ends, recessive tracks. */
import type { ReactNode } from "react";

/* ── Horizontal magnitude bar: label + value, thin pill track ── */
export function BarRow({
  label,
  value,
  max,
  suffix,
  accent,
}: {
  label: ReactNode;
  value: number;
  max: number;
  suffix?: string;
  accent?: boolean; // emphasize this row's fill (default true = single accent hue)
}) {
  // A true zero shows an empty track (no misleading sliver); non-zero floors to 2% so it's visible.
  const pct = value > 0 && max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[14px]" style={{ color: "var(--text-secondary)" }}>{label}</span>
        <span className="tabular shrink-0 text-[14px] font-semibold">
          {value.toLocaleString()}
          {suffix && <span className="font-normal" style={{ color: "var(--text-muted)" }}> {suffix}</span>}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--color-surface-150)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: accent === false ? "var(--color-accent-300)" : "var(--accent)" }}
        />
      </div>
    </div>
  );
}

/* ── Mini column trend (single series, current bar emphasized) ── */
export function MiniColumns({
  points,
  height = 68,
}: {
  points: { label: string; count: number }[];
  height?: number;
}) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const n = points.length;
  const total = points.reduce((s, p) => s + p.count, 0);
  const current = points[n - 1]?.count ?? 0;
  return (
    <div>
      <div className="flex items-end gap-[3px]" style={{ height }}
           role="img"
           aria-label={`New admissions by month: ${total} over the last ${n} months, ${current} in the most recent month.`}>
        {points.map((p, i) => (
          <div key={i} className="flex flex-1 items-end justify-center" style={{ height: "100%" }} title={`${p.label}: ${p.count}`}>
            <div
              className="w-full rounded-t-[4px]"
              style={{
                height: `${Math.max(4, (p.count / max) * 100)}%`,
                background: i === n - 1 ? "var(--accent)" : "var(--color-accent-300)",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-[3px]">
        {points.map((p, i) => (
          <span key={i} className="flex-1 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>
            {n <= 12 && i % 2 === 0 ? p.label : " "}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Big figure with a serif numeral (for a panel's headline metric) ── */
export function BigMetric({
  value,
  label,
  sub,
}: {
  value: string | number;
  label: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="title-lg tabular text-[40px] leading-none">{value}</p>
      <p className="mt-2 text-[14px] font-medium">{label}</p>
      {sub && <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>{sub}</p>}
    </div>
  );
}

/* ── Assurance ring — a single proportion (Apple-ring style), value in the center ── */
export function RingStat({
  pct,
  size = 76,
  tone = "success",
}: {
  pct: number;
  size?: number;
  tone?: "success" | "accent";
}) {
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct / 100)) * c;
  const color = tone === "success" ? "var(--color-success-700)" : "var(--accent)";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--color-surface-150)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="title-lg tabular absolute inset-0 flex items-center justify-center text-[19px]">
        {pct}%
      </span>
    </div>
  );
}

/* ── Definition pair (compact stat inside a panel) ── */
export function DataPoint({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <p className="tabular text-[22px] font-semibold leading-tight tracking-[-0.01em]">{value}</p>
      <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>{label}</p>
    </div>
  );
}
