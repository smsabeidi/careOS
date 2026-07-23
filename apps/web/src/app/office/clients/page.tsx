import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, StatusChip } from "@/components/ui";
import { IconChevronRight, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const supabase = await supabaseServer();
  const { data: clients, error } = await supabase
    .from("client")
    .select("id, first_name, last_name, status, city, state, primary_language, admitted_on")
    .order("last_name");

  return (
    <AppShell active="/office/clients">
      <div className="rise">
        <PageHeader
          title="Clients"
          sub={
            clients?.length
              ? `${clients.length} ${clients.length === 1 ? "person" : "people"} in your care`
              : undefined
          }
        />

        {error ? (
          <EmptyState
            icon={<IconUsers />}
            title="Couldn't load clients"
            body="Nothing was changed or lost. Check your connection and refresh — if this keeps happening, your coordinator can help."
          />
        ) : !clients?.length ? (
          <EmptyState
            icon={<IconUsers />}
            title="No clients yet"
            body="Clients you're assigned to care for will appear here. If you're expecting someone, your coordinator can confirm the assignment."
          />
        ) : (
          <div className="card divide-y hairline overflow-hidden">
            {clients.map((c) => (
              <Link key={c.id} href={`/office/clients/${c.id}`} className="row-link group">
                <Avatar name={`${c.first_name} ${c.last_name}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">
                    {c.first_name} {c.last_name}
                  </p>
                  <p className="mt-0.5 truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {[c.city, c.state].filter(Boolean).join(", ") || "Address on file"}
                    {c.admitted_on ? ` · admitted ${new Date(c.admitted_on + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}
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
        )}
      </div>
    </AppShell>
  );
}
