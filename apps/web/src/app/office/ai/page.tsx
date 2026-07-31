import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, Badge, DataTable, EmptyState, MetricTile, PageHeader } from "@/components/ui";
import { IconSparkle, IconCheck, IconAlert } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";

export const metadata = { title: "AI activity" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  capability_key: string;
  provider: string;
  model: string | null;
  tier: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  created_by: string;
  created_at: string;
};

function statusBadge(s: string) {
  if (s === "ok") return <Badge tone="success" icon={<IconCheck />}>Answered</Badge>;
  if (s === "abstained") return <Badge tone="warning">Abstained</Badge>;
  if (s === "blocked") return <Badge tone="danger" icon={<IconAlert />}>Blocked</Badge>;
  return <Badge tone="danger" icon={<IconAlert />}>Error</Badge>;
}

export default async function AiActivityPage() {
  await requireRole(["owner", "admin"]);
  const supabase = await supabaseServer();

  const { data: rows } = await supabase
    .from("ai_interaction")
    .select("id, capability_key, provider, model, tier, status, tokens_in, tokens_out, cost_usd, created_by, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  const list = (rows ?? []) as Row[];

  const userIds = [...new Set(list.map((r) => r.created_by))];
  const { data: staff } = userIds.length
    ? await supabase.from("app_user").select("id, full_name").in("id", userIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const nameOf = new Map((staff ?? []).map((s) => [s.id, s.full_name ?? "Staff"]));

  const totals = list.reduce(
    (a, r) => ({ calls: a.calls + 1, tokens: a.tokens + r.tokens_in + r.tokens_out, cost: a.cost + Number(r.cost_usd) }),
    { calls: 0, tokens: 0, cost: 0 }
  );

  return (
    <AppShell active="/office/ai">
      <div className="rise">
        <PageHeader
          title="AI activity"
          sub="All model calls, logged with cost and attribution"
          actions={<Link href="/brain" className="btn btn-secondary btn-sm"><IconSparkle width={15} height={15} />Open Brain</Link>}
        />

        <div className="mb-6 grid grid-cols-3 gap-3">
          <MetricTile label="Calls" value={totals.calls} icon={<IconSparkle />} />
          <MetricTile label="Tokens" value={totals.tokens.toLocaleString()} tone="neutral" />
          <MetricTile label="Cost" value={`$${totals.cost.toFixed(2)}`} tone="neutral" />
        </div>

        {!list.length ? (
          <EmptyState
            icon={<IconSparkle />}
            title="No AI activity yet"
            body="Brain questions and extraction runs appear here, with model, tokens, cost, and user."
          />
        ) : (
          <DataTable
            columns={[
              { header: "When" },
              { header: "Who" },
              { header: "Capability" },
              { header: "Model" },
              { header: "Status" },
              { header: "Tokens", align: "right" },
              { header: "Cost", align: "right" },
            ]}
            rows={list.map((r) => ({
              key: r.id,
              cells: [
                <span key="t" className="tabular text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>,
                <span key="w" className="flex items-center gap-2">
                  <Avatar name={nameOf.get(r.created_by) ?? "Staff"} size={24} />
                  {nameOf.get(r.created_by) ?? "Staff"}
                </span>,
                <span key="c" className="flex items-center gap-2">
                  <span className="tabular text-[13px]">{r.capability_key}</span>
                  <Badge tone="neutral">{r.tier}</Badge>
                </span>,
                <span key="m" className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  {r.provider === "openai" ? "OpenAI" : r.provider === "mock" ? "Mock" : r.provider}
                  {r.model ? ` · ${r.model}` : ""}
                </span>,
                statusBadge(r.status),
                <span key="tok" className="tabular text-[13px]">{(r.tokens_in + r.tokens_out).toLocaleString()}</span>,
                <span key="cost" className="tabular text-[13px]">${Number(r.cost_usd).toFixed(4)}</span>,
              ],
            }))}
          />
        )}

        <p className="mt-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Records hold PHI-safe digests only, never raw client content. High-autonomy capabilities (T2/T3)
          require disposition by a licensed human; the database rejects registration of any capability without one.
        </p>
      </div>
    </AppShell>
  );
}
