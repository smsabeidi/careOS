import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Avatar, Badge, DataTable, DueChip, EmptyState, ErrorState, MetricTile, PageHeader, Tabs,
} from "@/components/ui";
import { IconClipboardCheck, IconAlert, IconCheck, IconClock, IconUsers, IconShield } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { getT } from "@/lib/i18n/server";

export const metadata = { title: "Compliance" };
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "coordinator", "rn"];
const FILTERS = [
  { key: "attention", label: "Needs attention" },
  { key: "overdue", label: "Overdue" },
  { key: "at_risk", label: "At risk" },
  { key: "all", label: "All" },
];

type Row = {
  id: string;
  client_id: string | null;
  staff_id: string | null;
  due_on: string;
  applies_to: string;
  rule_name: string;
  severity: string;
  comar_source_ref: string | null;
  days_until_due: number | null;
  computed_status: string;
};

function statusBadge(s: string) {
  if (s === "overdue") return <Badge tone="danger" icon={<IconAlert />}>Overdue</Badge>;
  if (s === "at_risk") return <Badge tone="warning" icon={<IconClock />}>At risk</Badge>;
  if (s === "satisfied") return <Badge tone="success" icon={<IconCheck />}>Satisfied</Badge>;
  if (s === "waived") return <Badge tone="neutral">Waived</Badge>;
  return <Badge tone="info">Open</Badge>;
}
function severityBadge(s: string) {
  const tone = s === "critical" ? "danger" : s === "high" ? "warning" : s === "medium" ? "info" : "neutral";
  return <Badge tone={tone as "danger" | "warning" | "info" | "neutral"}>{s[0].toUpperCase() + s.slice(1)}</Badge>;
}

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const params = await searchParams;
  const filter = FILTERS.some((f) => f.key === params.filter) ? params.filter! : "attention";
  await requireRole(ROLES);
  const t = await getT();
  const supabase = await supabaseServer();

  const { data: rows, error } = await supabase
    .from("cadence_obligation_status")
    .select("id, client_id, staff_id, due_on, applies_to, rule_name, severity, comar_source_ref, days_until_due, computed_status")
    .order("due_on", { ascending: true })
    .limit(1000);

  if (error) {
    return (
      <AppShell active="/office/compliance">
        <div className="rise">
          <PageHeader title={t("page.compliance")} sub="All COMAR obligations, tracked by software" />
          <ErrorState
            title={t("states.errorTitle")}
            body={t("states.errorBody")}
          />
        </div>
      </AppShell>
    );
  }

  const all = (rows ?? []) as Row[];

  // Subject names (RLS-scoped).
  const clientIds = [...new Set(all.map((r) => r.client_id).filter(Boolean))] as string[];
  const staffIds = [...new Set(all.map((r) => r.staff_id).filter(Boolean))] as string[];
  const [{ data: clients }, { data: staff }] = await Promise.all([
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string; last_name: string }[] }),
    staffIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);
  const clientName = new Map((clients ?? []).map((c) => [c.id, `${c.first_name} ${c.last_name}`]));
  const staffName = new Map((staff ?? []).map((s) => [s.id, s.full_name ?? "Staff member"]));

  const counts = {
    overdue: all.filter((r) => r.computed_status === "overdue").length,
    at_risk: all.filter((r) => r.computed_status === "at_risk").length,
    open: all.filter((r) => r.computed_status === "open").length,
    satisfied: all.filter((r) => r.computed_status === "satisfied").length,
  };

  const shown = all.filter((r) => {
    if (filter === "overdue") return r.computed_status === "overdue";
    if (filter === "at_risk") return r.computed_status === "at_risk";
    if (filter === "attention") return r.computed_status === "overdue" || r.computed_status === "at_risk";
    return true;
  });

  const sub = all.length
    ? `${counts.overdue} overdue · ${counts.at_risk} at risk · ${counts.open} upcoming`
    : undefined;

  return (
    <AppShell active="/office/compliance">
      <div className="rise">
        <PageHeader
          title={t("page.compliance")}
          sub={sub}
          actions={
            <Link href="/office/evidence" className="btn btn-secondary btn-sm">
              <IconShield width={15} height={15} />
              Evidence packet
            </Link>
          }
        />

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricTile label="Overdue" value={counts.overdue} tone="danger" icon={<IconAlert />} />
          <MetricTile label="At risk" value={counts.at_risk} tone="warning" icon={<IconClock />} />
          <MetricTile label="Upcoming" value={counts.open} tone="accent" icon={<IconClipboardCheck />} />
          <MetricTile label="Satisfied" value={counts.satisfied} tone="success" icon={<IconCheck />} />
        </div>

        <div className="mb-4">
          <Tabs
            active={`/office/compliance${filter === "attention" ? "" : `?filter=${filter}`}`}
            items={FILTERS.map((f) => ({
              href: `/office/compliance${f.key === "attention" ? "" : `?filter=${f.key}`}`,
              label: f.label,
            }))}
          />
        </div>

        {!shown.length ? (
          <EmptyState
            icon={<IconCheck />}
            title={filter === "all" ? "No obligations tracked yet" : t("states.noResults")}
            body={
              filter === "all"
                ? "Admitting a client generates their COMAR obligations — assessments, reassessments, and supervisory visits, each with its regulation reference."
                : "Obligations appear here when their status matches this filter."
            }
            action={
              filter === "all" ? undefined : (
                <Link href="/office/compliance?filter=all" className="btn btn-secondary btn-sm">{t("common.showAll")}</Link>
              )
            }
          />
        ) : (
          <DataTable
            columns={[
              { header: "Obligation" },
              { header: "Subject" },
              { header: "Regulation" },
              { header: "Severity" },
              { header: "Due", align: "right" },
              { header: "Status", align: "right" },
            ]}
            rows={shown.map((r) => {
              const subject =
                r.applies_to === "client" && r.client_id
                  ? clientName.get(r.client_id) ?? "Client"
                  : r.staff_id
                    ? staffName.get(r.staff_id) ?? "Staff"
                    : "—";
              return {
                key: r.id,
                cells: [
                  <span key="r" className="font-medium">{r.rule_name}</span>,
                  <span key="s" className="flex items-center gap-2">
                    {r.applies_to === "client" ? (
                      <Avatar name={subject} size={26} />
                    ) : (
                      <IconUsers width={15} height={15} style={{ color: "var(--text-muted)" }} />
                    )}
                    {subject}
                  </span>,
                  r.comar_source_ref ? (
                    <span key="c" className="tabular inline-flex items-center gap-1.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      <IconShield width={13} height={13} />
                      {r.comar_source_ref}
                    </span>
                  ) : (
                    <span key="c" style={{ color: "var(--text-muted)" }}>—</span>
                  ),
                  severityBadge(r.severity),
                  <DueChip key="d" due={r.due_on} />,
                  statusBadge(r.computed_status),
                ],
              };
            })}
          />
        )}

        <p className="mt-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Due dates and statuses are derived by the compliance engine (Engine 1) from each rule&apos;s COMAR
          cadence; they are not tracked by hand. Every row traces to its regulation, so a surveyor can be shown
          exactly how the software enforces it.
        </p>
      </div>
    </AppShell>
  );
}
