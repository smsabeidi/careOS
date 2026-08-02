import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Avatar, Badge, DataTable, DueChip, EmptyState, ErrorState, MetricTile, PageHeader, Tabs,
} from "@/components/ui";
import { IconBadge, IconShield, IconAlert, IconCheck, IconClock } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { getT } from "@/lib/i18n/server";

export const metadata = { title: "Credentials" };
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "hr", "coordinator"];
const FILTERS = [
  { key: "all", label: "All" },
  { key: "expiring", label: "Expiring soon" },
  { key: "lapsed", label: "Lapsed" },
  { key: "unverified", label: "Unverified" },
];

type Row = {
  credential_id: string;
  app_user_id: string;
  credential_type_name: string;
  category: string;
  status: string;
  issued_on: string | null;
  expires_on: string | null;
  days_to_expiry: number | null;
  expiry_bucket: string;
  blocks_scheduling: boolean;
};

const CATEGORY_LABEL: Record<string, string> = {
  license: "License",
  certification: "Certification",
  health_screening: "Health screening",
  background_check: "Background check",
  training: "Training",
};

function bucketBadge(bucket: string, status: string) {
  if (status === "rejected") return <Badge tone="danger" icon={<IconAlert />}>Rejected</Badge>;
  if (status === "pending") return <Badge tone="warning" icon={<IconClock />}>Unverified</Badge>;
  if (bucket === "lapsed") return <Badge tone="danger" icon={<IconAlert />}>Lapsed</Badge>;
  if (bucket === "expiring_soon") return <Badge tone="warning" icon={<IconClock />}>Expiring soon</Badge>;
  return <Badge tone="success" icon={<IconCheck />}>Valid</Badge>;
}

export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const params = await searchParams;
  const filter = FILTERS.some((f) => f.key === params.filter) ? params.filter! : "all";
  await requireRole(ROLES);
  const t = await getT();
  const supabase = await supabaseServer();

  const { data: rows, error } = await supabase
    .from("credential_expiry")
    .select(
      "credential_id, app_user_id, credential_type_name, category, status, issued_on, expires_on, days_to_expiry, expiry_bucket, blocks_scheduling"
    )
    .order("expires_on", { ascending: true, nullsFirst: false })
    .limit(1000);

  if (error) {
    return (
      <AppShell active="/office/credentials">
        <div className="rise">
          <PageHeader title={t("page.credentials")} sub="All licenses, certifications, and screenings" />
          <ErrorState
            title={t("states.errorTitle")}
            body={t("states.errorBody")}
          />
        </div>
      </AppShell>
    );
  }

  const all = (rows ?? []) as Row[];

  // Staff names (RLS-scoped) for the rows we can see.
  const userIds = [...new Set(all.map((r) => r.app_user_id))];
  const { data: staff } = userIds.length
    ? await supabase.from("app_user").select("id, full_name").in("id", userIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const nameOf = new Map((staff ?? []).map((s) => [s.id, s.full_name ?? "Staff member"]));

  // Deterministic counts come from the expiry engine's buckets (SQL, invariant 13).
  const counts = {
    valid: all.filter((r) => r.status === "verified" && r.expiry_bucket === "valid").length,
    expiring: all.filter((r) => r.expiry_bucket === "expiring_soon" && r.status === "verified").length,
    lapsed: all.filter((r) => r.expiry_bucket === "lapsed").length,
    unverified: all.filter((r) => r.status === "pending").length,
  };

  const shown = all.filter((r) => {
    if (filter === "expiring") return r.expiry_bucket === "expiring_soon" && r.status === "verified";
    if (filter === "lapsed") return r.expiry_bucket === "lapsed";
    if (filter === "unverified") return r.status === "pending";
    return true;
  });

  const sub = all.length
    ? `${all.length} on file · ${counts.lapsed} lapsed · ${counts.expiring} expiring soon`
    : undefined;

  return (
    <AppShell active="/office/credentials">
      <div className="rise">
        <PageHeader title={t("page.credentials")} sub={sub} />

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricTile label="Valid" value={counts.valid} tone="success" icon={<IconCheck />} />
          <MetricTile label="Expiring soon" value={counts.expiring} tone="warning" icon={<IconClock />} />
          <MetricTile label="Lapsed" value={counts.lapsed} tone="danger" icon={<IconAlert />} />
          <MetricTile label="Unverified" value={counts.unverified} tone="neutral" icon={<IconShield />} />
        </div>

        <div className="mb-4">
          <Tabs
            active={`/office/credentials${filter === "all" ? "" : `?filter=${filter}`}`}
            items={FILTERS.map((f) => ({
              href: `/office/credentials${f.key === "all" ? "" : `?filter=${f.key}`}`,
              label: f.label,
            }))}
          />
        </div>

        {!shown.length ? (
          <EmptyState
            icon={<IconBadge />}
            title={filter === "all" ? "No credentials on file yet" : t("states.noResults")
            }
            body={
              filter === "all"
                ? "Licenses, certifications, and screenings appear here as they are added, each with an expiry status."
                : "Switch to All to see all credentials."
            }
            action={
              filter === "all" ? undefined : (
                <Link href="/office/credentials" className="btn btn-secondary btn-sm">{t("common.showAll")}</Link>
              )
            }
          />
        ) : (
          <DataTable
            columns={[
              { header: "Staff" },
              { header: "Credential" },
              { header: "Category" },
              { header: "Status" },
              { header: "Expires", align: "right" },
            ]}
            rows={shown.map((r) => {
              const name = nameOf.get(r.app_user_id) ?? "Staff member";
              return {
                key: r.credential_id,
                cells: [
                  <span key="s" className="flex items-center gap-2.5">
                    <Avatar name={name} size={30} />
                    <span className="font-medium">{name}</span>
                  </span>,
                  <span key="c" className="flex items-center gap-2">
                    {r.credential_type_name}
                    {r.blocks_scheduling && (
                      <span title="Blocks scheduling when lapsed">
                        <IconShield width={13} height={13} style={{ color: "var(--text-muted)" }} />
                      </span>
                    )}
                  </span>,
                  <span key="cat" style={{ color: "var(--text-secondary)" }}>
                    {CATEGORY_LABEL[r.category] ?? r.category}
                  </span>,
                  bucketBadge(r.expiry_bucket, r.status),
                  r.expires_on ? (
                    <DueChip key="e" due={r.expires_on} prefix="Expires" />
                  ) : (
                    <span key="e" style={{ color: "var(--text-muted)" }}>No expiry</span>
                  ),
                ],
              };
            })}
          />
        )}

        <p className="mt-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Expiry status is computed by the database (Engine 1), not estimated in the browser. A lapsed
          credential that blocks scheduling prevents assignment automatically.
        </p>
      </div>
    </AppShell>
  );
}
