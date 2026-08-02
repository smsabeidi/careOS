import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Badge, EmptyState, ErrorState, MetricTile, PageHeader, SectionTitle } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClipboard,
  IconClipboardCheck,
  IconInbox,
  IconSparkle,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { IntakeWorkbench } from "./intake-client";
import { refreshJob } from "./actions";

/**
 * /office/intake — the intake desk (docs/16 Wave 3, C6 + C7).
 *
 * The server half owns three things: who may be here, what has come through the desk
 * recently, and which job is open for review. The workbench below is a client component
 * because reading pages from a device is a browser job — but every decision it can make
 * is a server action, and every one of those is gated by RLS a second time.
 *
 * Permissions note: the role check here is routing UX. Postgres is the perimeter —
 * `extraction_job`/`extraction_field` policies require AAL2 plus `client.write` or
 * `ai.manage` to write, so a coordinator sees the review and gets an honest message
 * instead of a silent failure if they try to accept a field.
 */

export const metadata = { title: "Intake" };
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "coordinator", "hr"];
/** Roles the seeded RBAC grants client.write / ai.manage to (supabase/seed.sql, zz_ai.sql). */
const REVIEW_ROLES = ["owner", "admin"];
const RECENT_LIMIT = 12;

type JobRow = {
  id: string;
  kind: string;
  source_name: string | null;
  page_count: number | null;
  status: string;
  client_id: string | null;
  created_at: string;
};

const KIND_LABEL: Record<string, string> = {
  intake_packet: "Intake packet",
  credential_doc: "Credential document",
  referral: "Referral",
};

function statusBadge(status: string) {
  if (status === "committed")
    return (
      <Badge tone="success" icon={<IconCheck />}>
        Committed
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge tone="warning" icon={<IconAlert />}>
        Not read
      </Badge>
    );
  if (status === "reviewed") return <Badge tone="info">Reviewed</Badge>;
  if (status === "extracted") return <Badge tone="accent">Awaiting review</Badge>;
  return <Badge tone="neutral">Opened</Badge>;
}

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  const profile = await requireRole(ROLES);
  const supabase = await supabaseServer();

  const { data: jobRows, error } = await supabase
    .from("extraction_job")
    .select("id, kind, source_name, page_count, status, client_id, created_at")
    .order("created_at", { ascending: false })
    .limit(RECENT_LIMIT);

  if (error) {
    return (
      <AppShell active="/office/intake">
        <div className="rise">
          <PageHeader title="Intake" sub="Documents into charts, one human decision at a time" />
          <ErrorState
            title="Couldn't load the intake desk"
            body="Nothing was changed. Refresh to try again. If your verified session expired, sign in again with your authenticator."
          />
        </div>
      </AppShell>
    );
  }

  const jobs = (jobRows ?? []) as JobRow[];

  // Per-job review progress, read as the user (RLS follows the parent job).
  const jobIds = jobs.map((j) => j.id);
  const { data: fieldRows } = jobIds.length
    ? await supabase.from("extraction_field").select("job_id, accepted").in("job_id", jobIds)
    : { data: [] as { job_id: string; accepted: boolean | null }[] };
  const progress = new Map<string, { total: number; decided: number }>();
  for (const f of (fieldRows ?? []) as { job_id: string; accepted: boolean | null }[]) {
    const p = progress.get(f.job_id) ?? { total: 0, decided: 0 };
    p.total += 1;
    if (f.accepted !== null) p.decided += 1;
    progress.set(f.job_id, p);
  }

  // A job id in the URL is resolved under RLS, whether or not it is in the recent list.
  const selectedId = (params.job ?? "").trim();
  const initialJob = selectedId ? await refreshJob(selectedId) : null;

  const awaiting = jobs.filter((j) => j.status === "extracted" || j.status === "reviewed").length;
  const committed = jobs.filter((j) => j.status === "committed").length;
  const unread = jobs.filter((j) => j.status === "failed").length;
  const canReview = profile.roles.some((r) => REVIEW_ROLES.includes(r));

  return (
    <AppShell active="/office/intake">
      <div className="rise">
        <PageHeader
          title="Intake"
          sub="Read a referral packet or a credential document, check every field, then open the chart"
          actions={
            <Link href="/office/clients" className="btn btn-white btn-sm">
              Client list
            </Link>
          }
        />

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricTile
            label="Awaiting review"
            value={awaiting}
            tone="accent"
            icon={<IconClipboardCheck />}
            hint="Fields read, no chart yet"
          />
          <MetricTile label="Committed" value={committed} tone="success" icon={<IconCheck />} hint="Recent" />
          <MetricTile
            label="Not read"
            value={unread}
            tone="warning"
            icon={<IconAlert />}
            hint="Enter these by hand"
          />
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <IntakeWorkbench initialJob={initialJob} canReview={canReview} />
          </div>

          <aside className="min-w-0">
            <SectionTitle icon={<IconInbox />}>Recent documents</SectionTitle>
            {jobs.length === 0 ? (
              <EmptyState
                icon={<IconClipboard />}
                title="No documents yet"
                body="Everything read at this desk is listed here with what happened to it — read, reviewed, committed, or entered by hand."
              />
            ) : (
              <ul className="card divide-y hairline overflow-hidden">
                {jobs.map((j) => {
                  const p = progress.get(j.id);
                  const active = initialJob?.id === j.id;
                  return (
                    <li key={j.id}>
                      <Link
                        href={`/office/intake?job=${j.id}`}
                        className="row-link flex flex-col gap-1.5 px-5 py-3.5"
                        style={active ? { background: "var(--accent-soft)" } : undefined}
                        aria-current={active ? "true" : undefined}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="min-w-0 truncate text-[14px] font-medium">
                            {j.source_name ?? "Uploaded document"}
                          </span>
                          {statusBadge(j.status)}
                        </div>
                        <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {KIND_LABEL[j.kind] ?? j.kind} · {j.page_count ?? 0} page
                          {j.page_count === 1 ? "" : "s"}
                          {p ? ` · ${p.decided}/${p.total} fields decided` : ""} ·{" "}
                          {new Date(j.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="card mt-5 px-5 py-4">
              <p className="flex items-center gap-2 text-[14px] font-semibold">
                <IconSparkle width={15} height={15} style={{ color: "var(--accent)" }} />
                How this desk behaves
              </p>
              <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                <li>The reading is a draft. A person accepts every field that reaches a chart.</li>
                <li>What the reader saw and what the person kept are both stored, permanently.</li>
                <li>Dates, eligibility, and expiry are the platform&rsquo;s engines — never the reader&rsquo;s.</li>
                <li>With no model access, the desk still files the job and you enter it by hand.</li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
