import Link from "next/link";
import { AppShell } from "@/components/shell";
import { EmptyState, PageHeader, StatusChip } from "@/components/ui";
import { IconChevronRight, IconClipboard } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Forms" };
export const dynamic = "force-dynamic";

export default async function FormsPage() {
  const supabase = await supabaseServer();
  const { data: forms } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
    .order("updated_at", { ascending: false })
    .limit(100);

  return (
    <AppShell active="/office/forms">
      <div className="rise">
        <PageHeader
          title="Forms"
          sub="Every record you can see, newest first. Versions are permanent — corrections, not overwrites."
        />
        {!forms?.length ? (
          <EmptyState
            icon={<IconClipboard />}
            title="Nothing here yet"
            body="Records you create or are assigned to review will appear here. Start one from a client's chart."
          />
        ) : (
          <div className="card divide-y hairline overflow-hidden">
            {forms.map((f) => {
              const template = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
              const client = Array.isArray(f.client) ? f.client[0] : f.client;
              return (
                <Link key={f.id} href={`/office/forms/${f.id}`} className="row-link group">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg"
                       style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                    <IconClipboard />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{template?.title ?? "Form"}</p>
                    <p className="mt-0.5 truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {client ? `${client.first_name} ${client.last_name} · ` : ""}
                      updated {new Date(f.updated_at).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <StatusChip status={f.status} />
                  <IconChevronRight
                    className="opacity-0 transition-opacity duration-150 group-hover:opacity-60"
                    style={{ color: "var(--text-muted)" }}
                  />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
