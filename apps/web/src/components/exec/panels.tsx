/** Exec command-center panels — presentational, server-safe. Render the real ExecMetrics.
 *  "One next action" first (AttentionPanel), then census/BI, workforce, integrity, activity.
 *  Anything not yet built is an honest not-yet state, never faked. */
import Link from "next/link";
import type { ReactNode } from "react";
import { SectionTitle, StatusChip, TintTile } from "@/components/ui";
import {
  IconActivity, IconAlert, IconArrowRight, IconCalendar, IconCheck, IconChevronRight,
  IconClipboard, IconClock, IconInbox, IconLock, IconMapPin, IconPen, IconShield, IconSparkle, IconUsers,
} from "@/components/icons";
import { BarRow, DataPoint, MiniColumns, RingStat } from "./viz";
import type { ExecMetrics } from "@/lib/exec/metrics";
import { getT } from "@/lib/i18n/server";

/* ── Command hero — greeting + agency + date ── */
export async function CommandHero({
  name,
  agencyName,
}: {
  name: string;
  agencyName: string;
}) {
  const t = await getT();
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name.split(/\s+/)[0] || name;
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="title-lg text-[30px] sm:text-[34px]">{part}, {first}</h1>
        <p className="mt-1.5 text-[15px]" style={{ color: "var(--text-muted)" }}>
          {agencyName} · {today}
        </p>
      </div>
      <span className="chip chip-neutral" title="All records are versioned and hash-chained by design">
        <IconLock width={12} height={12} />
        {t("common.appendOnlyRecords")}
      </span>
    </div>
  );
}

/* ── Attention panel — exceptions first ("what should I do right now?") ── */
const TONE_ICON: Record<string, ReactNode> = {
  rn_queue: <IconPen />,
  pending: <IconUsers />,
  on_hold: <IconAlert />,
  stale_drafts: <IconClock />,
  inquiry: <IconInbox />,
};
export function AttentionPanel({ m }: { m: ExecMetrics }) {
  if (!m.attention.length) {
    return (
      <section className="card flex items-center gap-4 p-5">
        <TintTile icon={<IconCheck />} size={44} tone="success" />
        <div>
          <p className="text-[16px] font-semibold">No items waiting</p>
          <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
            No admissions, signatures, or reviews pending.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-5">
        <SectionTitle icon={<IconActivity />}>Needs your attention</SectionTitle>
        <span className="tabular text-[13px]" style={{ color: "var(--text-muted)" }}>
          {m.attention.length} {m.attention.length === 1 ? "item" : "items"}
        </span>
      </div>
      <ul className="divide-y hairline border-t">
        {m.attention.map((a) => (
          <li key={a.key}>
            <Link href={a.href} className="row-link group">
              <TintTile icon={TONE_ICON[a.key] ?? <IconAlert />} size={40} tone={a.tone} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium">{a.headline}</p>
                <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>{a.detail}</p>
              </div>
              <span className="chip chip-neutral tabular shrink-0">{a.count}</span>
              <IconChevronRight className="shrink-0 opacity-40 transition-opacity group-hover:opacity-70"
                style={{ color: "var(--text-muted)" }} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 border-t px-5 py-3 text-[12px] leading-relaxed hairline"
         style={{ color: "var(--text-muted)" }}>
        <IconCalendar width={14} height={14} className="mt-0.5 shrink-0" />
        Live work: pending items and unsigned records. COMAR due-date tracking (annual
        assessments, supervisory visits, credential renewals) becomes available with the cadence engine.
      </p>
    </section>
  );
}

/* ── Census — composition + admissions trend ── */
export function CensusPanel({ m }: { m: ExecMetrics }) {
  const max = Math.max(1, ...m.census.buckets.map((b) => b.count));
  const thisMonth = m.admissions[m.admissions.length - 1]?.count ?? 0;
  const yearAdmits = m.admissions.reduce((s, p) => s + p.count, 0);
  return (
    <section className="card p-5">
      <SectionTitle icon={<IconUsers />}>Census</SectionTitle>
      <div className="flex items-end gap-3">
        <p className="title-lg tabular text-[40px] leading-none">{m.census.inService.toLocaleString()}</p>
        <p className="pb-1 text-[14px]" style={{ color: "var(--text-secondary)" }}>
          clients in active service
        </p>
      </div>
      <div className="mt-5 flex flex-col gap-3">
        {m.census.buckets.map((b) => (
          <BarRow key={b.key} label={b.label} value={b.count} max={max} />
        ))}
      </div>
      <div className="mt-6 border-t pt-4 hairline">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
            New admissions
          </span>
          <span className="tabular text-[13px]" style={{ color: "var(--text-muted)" }}>
            {yearAdmits} in 12 months · {thisMonth} this month
          </span>
        </div>
        <MiniColumns points={m.admissions} />
      </div>
    </section>
  );
}

/* ── Payer mix + language ── */
export function PayerPanel({ m }: { m: ExecMetrics }) {
  const max = Math.max(1, ...m.payerMix.map((p) => p.count));
  return (
    <section className="card p-5">
      <SectionTitle icon={<IconClipboard />}>Payer mix</SectionTitle>
      <p className="mb-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
        Across {m.census.inService.toLocaleString()} clients in service
      </p>
      <div className="flex flex-col gap-3">
        {m.payerMix.map((p) => (
          <BarRow key={p.key} label={p.label} value={p.count} max={max}
            suffix={`· ${Math.round((p.count / m.census.inService) * 100)}%`} />
        ))}
      </div>
      <div className="mt-5 flex items-start gap-2.5 border-t pt-4 hairline">
        <IconUsers width={16} height={16} className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {m.language.esPct}% of clients speak Spanish. Family updates and care summaries are sent in
          each family's language.
        </p>
      </div>
    </section>
  );
}

/* ── Workforce & coverage ── */
export function WorkforcePanel({ m }: { m: ExecMetrics }) {
  const max = Math.max(1, ...m.workforce.byRole.map((r) => r.count));
  return (
    <section className="card p-5">
      <SectionTitle icon={<IconShield />}>Workforce</SectionTitle>
      <div className="flex items-end gap-3">
        <p className="title-lg tabular text-[40px] leading-none">{m.workforce.total}</p>
        <p className="pb-1 text-[14px]" style={{ color: "var(--text-secondary)" }}>
          active team {m.workforce.total === 1 ? "member" : "members"}
        </p>
      </div>
      <div className="mt-5 flex flex-col gap-3">
        {m.workforce.byRole.map((r) => (
          <BarRow key={r.key} label={r.label} value={r.count} max={max} />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-4 border-t pt-4 hairline">
        <DataPoint value={m.coverage.avgCaregiverLoad} label="Avg clients / caregiver" />
        <DataPoint value={m.coverage.avgRnLoad} label="Avg clients / nurse" />
      </div>
      <div className="mt-4 flex items-start gap-2.5">
        {m.coverage.withoutCaregiver === 0 && m.coverage.withoutRn === 0 ? (
          <>
            <IconCheck width={16} height={16} className="mt-0.5 shrink-0" style={{ color: "var(--color-success-700)" }} />
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              All clients in service have an assigned caregiver and RN case manager.
            </p>
          </>
        ) : (
          <>
            <IconAlert width={16} height={16} className="mt-0.5 shrink-0" style={{ color: "var(--color-warning-700)" }} />
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {Math.max(m.coverage.withoutCaregiver, m.coverage.withoutRn)} client
              {Math.max(m.coverage.withoutCaregiver, m.coverage.withoutRn) === 1 ? "" : "s"} in service
              {m.coverage.withoutCaregiver > 0 && m.coverage.withoutRn > 0 ? " without an assigned caregiver or RN case manager. Assign to close the gap." : m.coverage.withoutCaregiver > 0 ? " without an assigned caregiver. Assign to close the gap." : " without an assigned RN case manager. Assign to close the gap."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/* ── Documentation & integrity — the provable-integrity differentiator ── */
export function IntegrityPanel({ m }: { m: ExecMetrics }) {
  const hasSignatures = m.docs.signatures > 0;
  const assurance = hasSignatures ? Math.round((m.docs.aal2Signatures / m.docs.signatures) * 100) : 0;
  const allVerified = hasSignatures && assurance === 100;
  return (
    <section className="card p-5">
      <SectionTitle icon={<IconLock />}>Records &amp; integrity</SectionTitle>

      {/* Signature assurance — the seal (reflects the real ratio) */}
      <div className="flex items-center gap-4">
        <RingStat pct={assurance} tone="success" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">
            {allVerified ? "All signatures verified" : hasSignatures ? `${assurance}% verified` : "No signatures recorded"}
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {hasSignatures
              ? `${m.docs.aal2Signatures.toLocaleString()} of ${m.docs.signatures.toLocaleString()} clinical signatures were captured in a multi-factor–verified (AAL2) session, each bound to the exact record it signed.`
              : "Clinical signatures appear here as nurses finalize assessments, each captured in a verified session."}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-x-4 gap-y-4 border-t pt-4 hairline">
        <DataPoint value={m.docs.final.toLocaleString()} label="Records on file" />
        <DataPoint value={m.docs.draft.toLocaleString()} label="Drafts in progress" />
        <DataPoint value={m.docs.inReview.toLocaleString()} label="Awaiting signature" />
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-[var(--radius-md)] p-3.5"
           style={{ background: "var(--color-success-50)" }}>
        <IconShield width={18} height={18} className="mt-0.5 shrink-0" style={{ color: "var(--color-success-700)" }} />
        <div>
          <p className="text-[14px] font-semibold" style={{ color: "var(--color-success-700)" }}>
            Append-only &amp; hash-chained
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            All records are versioned and cryptographically linked. Nothing can be lost or silently
            changed. {m.docs.corrections === 0 ? "No corrections recorded" : `All ${m.docs.corrections} corrections remain on the record with a reason`}.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── Recent activity — trust through visibility ── */
export function ActivityPanel({ m }: { m: ExecMetrics }) {
  return (
    <section className="card overflow-hidden">
      <div className="px-5 pt-5">
        <SectionTitle icon={<IconActivity />}>Recent activity</SectionTitle>
      </div>
      {!m.recent.length ? (
        <p className="px-5 pb-8 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
          No recent activity. Entries appear as your team documents care.
        </p>
      ) : (
        <ul className="divide-y hairline border-t">
          {m.recent.map((r) => (
            <li key={r.id}>
              <Link href={`/office/forms/${r.id}`} className="row-link group">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">
                    {r.title}
                    {r.clientName && <span style={{ color: "var(--text-muted)" }}> · {r.clientName}</span>}
                  </p>
                  <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {new Date(r.updatedAt).toLocaleString(undefined, {
                      weekday: "short", hour: "numeric", minute: "2-digit",
                    })}
                  </p>
                </div>
                <StatusChip status={r.status} />
                <IconChevronRight className="shrink-0 opacity-40 transition-opacity group-hover:opacity-70"
                  style={{ color: "var(--text-muted)" }} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Horizon — honest "what's coming", deliberately not faked ── */
const HORIZON = [
  { icon: <IconCalendar />, title: "COMAR deadline tracking",
    detail: "Assessment, supervisory-visit, and credential cadences, tracked automatically." },
  { icon: <IconMapPin />, title: "Live visit board & EVV",
    detail: "Geofenced clock-in/out and a real-time map of visit locations." },
  { icon: <IconShield />, title: "Credential tracking & expirations",
    detail: "All caregiver credentials, with renewals flagged before expiration." },
  { icon: <IconSparkle />, title: "Ask CareOS",
    detail: "Plain-language questions about the agency, answered under your permissions." },
];
export function HorizonPanel() {
  return (
    <section className="card overflow-hidden">
      <div className="px-5 pt-5">
        <SectionTitle icon={<IconClock />}>Planned features</SectionTitle>
        <p className="-mt-1 mb-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Shown only when live. No placeholder data.
        </p>
      </div>
      <ul className="divide-y hairline border-t">
        {HORIZON.map((h) => (
          <li key={h.title} className="flex items-center gap-3.5 px-5 py-3.5">
            <TintTile icon={h.icon} size={38} tone="neutral" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">{h.title}</p>
              <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>{h.detail}</p>
            </div>
            <span className="chip chip-neutral shrink-0">Planned</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Jump-to nav ── */
export async function QuickNav() {
  const t = await getT();
  const links = [
    { href: "/office/clients", label: t("nav.clients"), icon: <IconUsers width={16} height={16} /> },
    { href: "/office/staff", label: t("nav.staff"), icon: <IconShield width={16} height={16} /> },
    { href: "/clinical", label: t("nav.clinical"), icon: <IconPen width={16} height={16} /> },
    { href: "/office/forms", label: t("nav.forms"), icon: <IconClipboard width={16} height={16} /> },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="btn btn-white btn-sm">
          {l.icon}
          {l.label}
          <IconArrowRight width={14} height={14} style={{ color: "var(--text-muted)" }} />
        </Link>
      ))}
    </div>
  );
}
