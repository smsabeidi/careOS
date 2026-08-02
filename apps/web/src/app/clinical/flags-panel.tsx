"use client";

/**
 * Clinical early-warning flags (docs/16 §2.4 R3) — the RN's disposition surface.
 *
 * Everything on this panel renders from database rows: severity, the deterministic
 * evidence series, and the summary text. A flag whose summary the model wrote is
 * labelled as such; a flag the platform wrote carries no AI label at all, because it
 * had no AI in it. With the model unreachable the panel is unchanged except for one
 * honest line under the scan button.
 *
 * The only two verbs are Acknowledge and Dismiss. Nothing here escalates, notifies a
 * family, or changes a plan — a flag is a finding, and the nurse decides what it means.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  acknowledgeFlag,
  detectClinicalFlags,
  dismissFlag,
  type FlagKind,
  type FlagSeverity,
} from "./clinical-actions";
import { Avatar, Badge, EmptyState } from "@/components/ui";
import { IconAlert, IconCheck, IconChevronRight, IconEye, IconSparkle, IconX } from "@/components/icons";

export type FlagView = {
  id: string;
  clientId: string;
  clientName: string;
  kind: FlagKind;
  severity: FlagSeverity;
  summary: string;
  evidence: Record<string, unknown> | null;
  status: "open" | "acknowledged" | "dismissed";
  aiWritten: boolean;
  createdAt: string;
  disposedAt: string | null;
};

const KIND_LABEL: Record<FlagKind, string> = {
  condition_trend: "Condition trend",
  mood_trend: "Mood trend",
  exception_spike: "Schedule exceptions",
  visit_shortfall: "Delivered hours",
};

const SEVERITY_LABEL: Record<FlagSeverity, string> = {
  high: "High",
  medium: "Medium",
  info: "Information",
};

const SEVERITY_TONE: Record<FlagSeverity, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  info: "neutral",
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The deterministic series in one line, exactly as stored. This is what makes the flag
 * checkable: the nurse reads the numbers the rule fired on, not a claim about them.
 */
function evidenceLine(evidence: Record<string, unknown> | null): string | null {
  if (!evidence) return null;
  const metric = typeof evidence.metric === "string" ? evidence.metric : null;
  const windowDays = num(evidence.window_days);
  const suffix = windowDays ? ` · last ${windowDays} days` : "";

  if (metric === "general_condition" || metric === "client_mood") {
    const series = strings(evidence.series);
    const dates = strings(evidence.dates);
    if (series.length === 0) return null;
    const paired = series.map((s, i) => (dates[i] ? `${s} (${dates[i]})` : s)).join(" → ");
    const label = metric === "general_condition" ? "General condition" : "Mood";
    return `${label}: ${paired}${suffix}`;
  }
  if (metric === "schedule_exception_count") {
    const count = num(evidence.count);
    const kinds = strings(evidence.kinds).map((k) => k.replace(/_/g, " "));
    return `Exceptions: ${count ?? kinds.length}${kinds.length ? ` (${kinds.join(", ")})` : ""}${suffix}`;
  }
  if (metric === "delivered_vs_planned_hours") {
    const planned = num(evidence.planned_hours);
    const delivered = num(evidence.delivered_hours);
    const coverage = num(evidence.evv_coverage_pct);
    if (planned === null || delivered === null) return null;
    return (
      `Hours: ${delivered} clocked of ${planned} scheduled${suffix}` +
      (coverage !== null ? ` · EVV pairs on ${coverage}% of visits` : "")
    );
  }

  // Unknown shape (a future rule): show it rather than hide it.
  const pairs = Object.entries(evidence)
    .filter(([k]) => k !== "source")
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  return pairs.length ? pairs.join(" · ") : null;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function FlagsPanel({
  flags,
  canScan,
  canDispose,
}: {
  flags: FlagView[];
  canScan: boolean;
  canDispose: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFlag, setBusyFlag] = useState<string | null>(null);

  const open = flags.filter((f) => f.status === "open");
  const disposed = flags.filter((f) => f.status !== "open");

  function scan() {
    setError(null);
    setScanMessage(null);
    setScanNote(null);
    startTransition(async () => {
      const res = await detectClinicalFlags();
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setScanMessage(res.message);
      setScanNote(res.note);
      router.refresh();
    });
  }

  function dispose(flagId: string, action: "acknowledge" | "dismiss") {
    setError(null);
    setBusyFlag(flagId);
    startTransition(async () => {
      const res = action === "acknowledge" ? await acknowledgeFlag(flagId) : await dismissFlag(flagId);
      setBusyFlag(null);
      if (!res.ok) {
        setError(res.error ?? "We couldn't record that. The flag is unchanged.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
          <span className="flex" style={{ color: "var(--accent)" }}>
            <IconAlert width={16} height={16} />
          </span>
          Early-warning flags
        </h2>
        {canScan && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={scan} disabled={pending}>
            <IconEye width={14} height={14} />
            {pending ? "Scanning…" : "Scan for flags"}
          </button>
        )}
      </div>

      <p className="mb-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
        Patterns the platform found across assessments, visit notes, schedule exceptions and clocked
        hours. Each one waits here until you acknowledge or dismiss it, and nothing escalates on its
        own. Scanning looks at your caseload; the list shows every flag your account can see.
      </p>

      {(scanMessage || scanNote || error) && (
        <div className="card mb-4 px-5 py-3.5" role="status" aria-live="polite">
          {error ? (
            <p className="flex items-start gap-2 text-[13.5px]" style={{ color: "var(--color-danger-700)" }}>
              <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : (
            <p className="text-[13.5px]">{scanMessage}</p>
          )}
          {scanNote && !error && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
              <IconAlert width={13} height={13} className="mt-0.5 shrink-0" />
              <span>{scanNote}</span>
            </p>
          )}
        </div>
      )}

      {open.length === 0 && disposed.length === 0 ? (
        <EmptyState
          icon={<IconAlert />}
          title="No flags to review"
          body="When condition or mood entries trend down, schedule exceptions cluster, or clocked hours fall short of the plan, the pattern is raised here for you to review."
        />
      ) : (
        <>
          {open.length > 0 && (
            <div className="card stagger divide-y hairline overflow-hidden">
              {open.map((f) => (
                <FlagRow
                  key={f.id}
                  flag={f}
                  canDispose={canDispose}
                  busy={busyFlag === f.id && pending}
                  onDispose={dispose}
                />
              ))}
            </div>
          )}

          {open.length === 0 && disposed.length > 0 && (
            <div className="card flex items-center gap-3.5 px-5 py-4">
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-[12px]"
                style={{ background: "var(--color-success-50)", color: "var(--color-success-700)" }}
              >
                <IconCheck width={20} height={20} />
              </span>
              <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
                Every flag you can see has been disposed.
              </p>
            </div>
          )}

          {disposed.length > 0 && (
            <div className="mt-6">
              <p
                className="mb-2 text-[11px] font-semibold uppercase"
                style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
              >
                Disposed
              </p>
              <div className="card divide-y hairline overflow-hidden">
                {disposed.slice(0, 12).map((f) => (
                  <div key={f.id} className="flex items-start gap-3.5 px-5 py-3.5">
                    <Avatar name={f.clientName} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium">
                        {f.clientName}
                        <span style={{ color: "var(--text-muted)" }}> · {KIND_LABEL[f.kind]}</span>
                      </p>
                      <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {f.summary}
                      </p>
                    </div>
                    <Badge tone={f.status === "acknowledged" ? "success" : "neutral"}>
                      {f.status === "acknowledged" ? "Acknowledged" : "Dismissed"}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FlagRow({
  flag,
  canDispose,
  busy,
  onDispose,
}: {
  flag: FlagView;
  canDispose: boolean;
  busy: boolean;
  onDispose: (flagId: string, action: "acknowledge" | "dismiss") => void;
}) {
  const evidence = evidenceLine(flag.evidence);
  return (
    <article className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
      <Avatar name={flag.clientName} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/office/clients/${flag.clientId}`}
            className="text-[15px] font-medium hover:underline"
          >
            {flag.clientName}
          </Link>
          <Badge tone={SEVERITY_TONE[flag.severity]} icon={flag.severity === "high" ? <IconAlert /> : undefined}>
            {SEVERITY_LABEL[flag.severity]}
          </Badge>
          <Badge tone="neutral">{KIND_LABEL[flag.kind]}</Badge>
          {flag.aiWritten && (
            <Badge tone="accent" icon={<IconSparkle />}>
              Summary drafted with AI
            </Badge>
          )}
        </div>

        <p className="mt-1.5 text-[14px] leading-relaxed">{flag.summary}</p>

        {evidence && (
          <p className="tabular mt-1.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            {evidence}
          </p>
        )}
        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Raised {timeAgo(flag.createdAt)}
          {flag.aiWritten
            ? " · the figures above are computed by the platform; the wording is AI-written"
            : " · written by the platform from the figures above"}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canDispose ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => onDispose(flag.id, "acknowledge")}
            >
              <IconCheck width={14} height={14} />
              {busy ? "Saving…" : "Acknowledge"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => onDispose(flag.id, "dismiss")}
            >
              <IconX width={14} height={14} />
              Dismiss
            </button>
          </>
        ) : (
          <Link href={`/office/clients/${flag.clientId}`} className="btn btn-ghost btn-sm">
            Open chart
            <IconChevronRight width={14} height={14} />
          </Link>
        )}
      </div>
    </article>
  );
}
