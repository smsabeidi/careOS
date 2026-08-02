import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Avatar, Badge, DataTable, DueChip, EmptyState, PageHeader, SectionTitle, StatusChip, Tabs, TintTile,
} from "@/components/ui";
import {
  IconCheck, IconChevronRight, IconClipboard, IconClipboardCheck, IconHeart, IconPen, IconUsers,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { getOrGenerateBrief } from "@/lib/ai/huddle";
import { HuddleBriefCard } from "@/components/huddle-brief";

export const metadata = { title: "Clinical" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "signatures", label: "Needs signature" },
  { key: "careplans", label: "Care plans" },
  { key: "supervisory", label: "Supervisory" },
  { key: "caseload", label: "Caseload" },
];

function nameOf<T extends { first_name: string; last_name: string }>(c: T | T[] | null): string {
  const x = Array.isArray(c) ? c[0] : c;
  return x ? `${x.first_name} ${x.last_name}` : "Client";
}

export default async function ClinicalPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab = TABS.some((t) => t.key === params.tab) ? params.tab! : "signatures";
  const profile = await requireRole(["rn", "owner", "admin"]);
  const supabase = await supabaseServer();

  // ── Signature queue: RN-signature-required assessments still unsigned ──
  const { data: pending } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, client(first_name, last_name), form_template!inner(title, requires_signature_roles)")
    .in("status", ["draft", "in_review"])
    .filter("form_template.requires_signature_roles", "cs", "{rn}")
    .order("updated_at", { ascending: true })
    .limit(100);

  let queue = pending ?? [];
  if (queue.length) {
    const ids = queue.map((q) => q.id);
    const { data: versions } = await supabase.from("form_version").select("id, instance_id").in("instance_id", ids);
    const versionIds = (versions ?? []).map((v) => v.id);
    const { data: sigs } = versionIds.length
      ? await supabase.from("signature").select("form_version_id").in("form_version_id", versionIds)
      : { data: [] as { form_version_id: string }[] };
    const signed = new Set((sigs ?? []).map((s) => s.form_version_id));
    const signedInstances = new Set((versions ?? []).filter((v) => signed.has(v.id)).map((v) => v.instance_id));
    queue = queue.filter((q) => !signedInstances.has(q.id));
  }

  // ── Caseload (RN case-managed clients) ──
  const { data: caseload } = await supabase
    .from("care_team_assignment")
    .select("client_id, client(id, first_name, last_name, city, status)")
    .eq("user_id", profile.userId)
    .eq("role_on_case", "rn_case_manager")
    .is("ends_on", null)
    .limit(300);
  const caseClients = (caseload ?? [])
    .map((a) => (Array.isArray(a.client) ? a.client[0] : a.client))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  // ── Supervisory visits I own (45/90/120-day cadence) ──
  const { data: supRows } = await supabase
    .from("supervisory_visit")
    .select("id, client_id, kind, status, due_on, completed_on, client(first_name, last_name)")
    .eq("rn_id", profile.userId)
    .order("due_on", { ascending: true })
    .limit(200);
  const supervisory = supRows ?? [];
  const supOpen = supervisory.filter((s) => !s.completed_on);

  // ── Care plans across my caseload (latest version per client) ──
  const caseIds = caseClients.map((c) => c.id);
  const { data: planRows } = caseIds.length
    ? await supabase
        .from("care_plan")
        .select("id, client_id, version, status, title, review_due_on, authored_at, client(first_name, last_name)")
        .in("client_id", caseIds)
        .order("version", { ascending: false })
        .limit(500)
    : { data: [] as {
        id: string; client_id: string; version: number; status: string; title: string | null;
        review_due_on: string | null; authored_at: string;
        client: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
      }[] };
  const latestPlan = new Map<string, NonNullable<typeof planRows>[number]>();
  for (const p of planRows ?? []) if (!latestPlan.has(p.client_id)) latestPlan.set(p.client_id, p);
  const plans = [...latestPlan.values()];

  const counts = {
    signatures: queue.length,
    careplans: plans.length,
    supervisory: supOpen.length,
    caseload: caseClients.length,
  };

  const sub =
    tab === "signatures"
      ? queue.length
        ? `${queue.length} ${queue.length === 1 ? "record needs" : "records need"} your signature`
        : "No records awaiting signature"
      : `${caseClients.length} ${caseClients.length === 1 ? "client" : "clients"} on your caseload`;

  const brief = await getOrGenerateBrief(supabase, "rn", profile.userId);

  return (
    <AppShell active="/clinical">
      <div className="rise">
        <PageHeader title="Clinical" sub={sub} />

        <HuddleBriefCard brief={brief} canRegenerate />

        <div className="mb-6">
          <Tabs
            active={`/clinical${tab === "signatures" ? "" : `?tab=${tab}`}`}
            items={TABS.map((t) => ({
              href: `/clinical${t.key === "signatures" ? "" : `?tab=${t.key}`}`,
              label: t.label,
              count: counts[t.key as keyof typeof counts],
            }))}
          />
        </div>

        {tab === "signatures" && (
          <section>
            <SectionTitle icon={<IconPen width={16} height={16} />}>Needs your signature</SectionTitle>
            {!queue.length ? (
              <div className="card flex items-center gap-3.5 px-5 py-4">
                <TintTile icon={<IconCheck width={20} height={20} />} tone="success" size={40} />
                <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
                  No assessments pending signature.
                </p>
              </div>
            ) : (
              <div className="card stagger divide-y hairline overflow-hidden">
                {queue.slice(0, 40).map((q) => {
                  const t = Array.isArray(q.form_template) ? q.form_template[0] : q.form_template;
                  const c = Array.isArray(q.client) ? q.client[0] : q.client;
                  return (
                    <Link key={q.id} href={`/office/forms/${q.id}`} className="row-link">
                      <TintTile icon={<IconClipboard width={20} height={20} />} size={40} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-medium">
                          {t?.title ?? "Record"}
                          {c && <span style={{ color: "var(--text-muted)" }}> · {c.first_name} {c.last_name}</span>}
                        </p>
                        <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                          Last updated {new Date(q.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </p>
                      </div>
                      <StatusChip status={q.status} />
                      <span className="btn btn-primary btn-sm shrink-0">
                        <IconPen width={14} height={14} />
                        Review &amp; sign
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {tab === "careplans" && (
          <section>
            <SectionTitle icon={<IconHeart width={16} height={16} />}>Care plans on your caseload</SectionTitle>
            {!plans.length ? (
              <EmptyState
                icon={<IconHeart />}
                title="No care plans yet"
                body="A care plan is authored as version 1; revisions add new versions and never overwrite. Plans for your clients appear here."
              />
            ) : (
              <DataTable
                columns={[
                  { header: "Client" },
                  { header: "Plan" },
                  { header: "Version" },
                  { header: "Status" },
                  { header: "Review due", align: "right" },
                ]}
                rows={plans.map((p) => ({
                  key: p.id,
                  cells: [
                    <span key="c" className="flex items-center gap-2.5">
                      <Avatar name={nameOf(p.client)} size={28} />
                      <span className="font-medium">{nameOf(p.client)}</span>
                    </span>,
                    p.title ?? "Care plan",
                    <span key="v" className="tabular">v{p.version}</span>,
                    <StatusChip key="s" status={p.status} />,
                    p.review_due_on ? <DueChip key="d" due={p.review_due_on} prefix="Review" /> : <span key="d" style={{ color: "var(--text-muted)" }}>—</span>,
                  ],
                }))}
              />
            )}
          </section>
        )}

        {tab === "supervisory" && (
          <section>
            <SectionTitle icon={<IconClipboardCheck width={16} height={16} />}>Supervisory visits (45/90/120-day)</SectionTitle>
            {!supervisory.length ? (
              <EmptyState
                icon={<IconClipboardCheck />}
                title="No supervisory visits assigned"
                body="COMAR-mandated 45, 90 and 120-day supervisory visits for your clients appear here with their due dates."
              />
            ) : (
              <DataTable
                columns={[
                  { header: "Client" },
                  { header: "Visit" },
                  { header: "Due", align: "right" },
                  { header: "Status", align: "right" },
                ]}
                rows={supervisory.map((s) => ({
                  key: s.id,
                  cells: [
                    <span key="c" className="flex items-center gap-2.5">
                      <Avatar name={nameOf(s.client)} size={28} />
                      <span className="font-medium">{nameOf(s.client)}</span>
                    </span>,
                    <span key="k">{s.kind.replace("_", "-")} supervisory</span>,
                    s.completed_on ? (
                      <Badge key="d" tone="success" icon={<IconCheck />}>Completed</Badge>
                    ) : (
                      <DueChip key="d" due={s.due_on} />
                    ),
                    s.completed_on ? (
                      <Badge key="s" tone="success">Completed</Badge>
                    ) : s.status === "missed" ? (
                      <Badge key="s" tone="danger">Missed</Badge>
                    ) : (
                      <Badge key="s" tone="info">Scheduled</Badge>
                    ),
                  ],
                }))}
              />
            )}
          </section>
        )}

        {tab === "caseload" && (
          <section>
            <SectionTitle icon={<IconUsers width={16} height={16} />}>Your caseload</SectionTitle>
            {!caseClients.length ? (
              <EmptyState
                icon={<IconUsers />}
                title="No caseload assigned yet"
                body="Clients you case-manage appear here once your coordinator assigns them."
              />
            ) : (
              <div className="card stagger divide-y hairline overflow-hidden">
                {caseClients.map((c) => (
                  <Link key={c.id} href={`/office/clients/${c.id}`} className="row-link group">
                    <Avatar name={`${c.first_name} ${c.last_name}`} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{c.first_name} {c.last_name}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>{c.city ?? "—"}</p>
                    </div>
                    <StatusChip status={c.status} />
                    <IconChevronRight className="opacity-0 transition-opacity duration-150 group-hover:opacity-60" style={{ color: "var(--text-muted)" }} />
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
