import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, StatusChip } from "@/components/ui";
import { IconChevronRight, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "inquiry", label: "Inquiry" },
  { key: "pending_admission", label: "Pending" },
  { key: "on_hold", label: "On hold" },
  { key: "discharged", label: "Discharged" },
];

function pageHref(q: string, status: string, page: number) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status) p.set("status", status);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return `/office/clients${s ? `?${s}` : ""}`;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").replace(/[%,()]/g, "").trim();
  const status = STATUS_FILTERS.some((f) => f.key === params.status) ? (params.status ?? "") : "";
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  const supabase = await supabaseServer();
  let query = supabase
    .from("client")
    .select("id, first_name, last_name, status, city, state, admitted_on", { count: "exact" });
  if (q) query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
  if (status) query = query.eq("status", status);
  const { data: clients, count, error } = await query
    .order("last_name")
    .order("id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  const total = count ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppShell active="/office/clients">
      <div className="rise">
        <PageHeader
          title="Clients"
          sub={total ? `${total} ${total === 1 ? "person" : "people"}${status ? ` · ${STATUS_FILTERS.find((f) => f.key === status)?.label.toLowerCase()}` : ""}${q ? ` · matching "${q}"` : ""}` : undefined}
        />

        {/* Toolbar: search + status filter */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <form method="get" action="/office/clients" className="min-w-56 flex-1">
            {status && <input type="hidden" name="status" value={status} />}
            <label htmlFor="client-search" className="sr-only">Search clients by name</label>
            <input
              id="client-search"
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search by name…"
              className="input"
            />
          </form>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((f) => (
              <Link
                key={f.key}
                href={pageHref(q, f.key, 1)}
                aria-current={status === f.key ? "true" : undefined}
                className="chip"
                style={
                  status === f.key
                    ? { background: "var(--accent-soft)", color: "var(--accent)", borderColor: "var(--accent-soft-border)" }
                    : { background: "var(--panel)", color: "var(--text-muted)", borderColor: "var(--border)" }
                }
              >
                {f.label}
              </Link>
            ))}
          </div>
        </div>

        {error ? (
          <EmptyState
            icon={<IconUsers />}
            title="Couldn't load clients"
            body="Nothing was changed or lost. Refresh to try again — if this keeps happening, your coordinator can help."
          />
        ) : !clients?.length ? (
          <EmptyState
            icon={<IconUsers />}
            title={q || status ? "No one matches" : "No clients yet"}
            body={
              q || status
                ? "Try a shorter name, or clear the filters to see everyone you have access to."
                : "Clients you're assigned to care for will appear here."
            }
            action={
              q || status ? (
                <Link href="/office/clients" className="btn btn-secondary">Clear filters</Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="card divide-y hairline overflow-hidden">
              {clients.map((c) => (
                <Link key={c.id} href={`/office/clients/${c.id}`} className="row-link group">
                  <Avatar name={`${c.first_name} ${c.last_name}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">
                      {c.first_name} {c.last_name}
                    </p>
                    <p className="mt-0.5 truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {[c.city, c.state].filter(Boolean).join(", ")}
                      {c.admitted_on
                        ? ` · admitted ${new Date(c.admitted_on + "T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
                        : ""}
                    </p>
                  </div>
                  <StatusChip status={c.status} />
                  <IconChevronRight
                    className="opacity-0 transition-opacity duration-150 group-hover:opacity-60"
                    style={{ color: "var(--text-muted)" }}
                  />
                </Link>
              ))}
            </div>

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="mt-4 flex items-center justify-between text-[13px]"
                   style={{ color: "var(--text-muted)" }}>
                <span className="tabular">Showing {from}–{to} of {total}</span>
                <div className="flex gap-2">
                  {page > 1 ? (
                    <Link href={pageHref(q, status, page - 1)} className="btn btn-secondary btn-sm">
                      Previous
                    </Link>
                  ) : (
                    <span className="btn btn-secondary btn-sm opacity-40" aria-disabled>Previous</span>
                  )}
                  <span className="tabular self-center">Page {page} of {lastPage}</span>
                  {page < lastPage ? (
                    <Link href={pageHref(q, status, page + 1)} className="btn btn-secondary btn-sm">
                      Next
                    </Link>
                  ) : (
                    <span className="btn btn-secondary btn-sm opacity-40" aria-disabled>Next</span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
