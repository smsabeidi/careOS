import Link from "next/link";
import { AppShell } from "@/components/shell";
import { EmptyState, PageHeader, StatusChip, TintTile } from "@/components/ui";
import { IconChevronRight, IconClipboard } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { PdfImportPanel } from "./import/import-panel";

export const metadata = { title: "Forms" };
export const dynamic = "force-dynamic";

/**
 * PDF form import is gated in Postgres, not in the browser (ST-237, Front Door W4).
 *
 * `app.feature_enabled` reads this tenant's `feature_flag` row under the caller's own RLS,
 * and the flag ships dark with a stated reason (migration 0057). The default is FALSE, so
 * an environment that has never seen 0057 gets the dark behaviour rather than an accidental
 * flip. When the answer is anything but `true`, the panel is not rendered at all — no
 * teaser, no disabled button, nothing in the DOM to inspect.
 */
const FLAG = "front_door.form_import";

export default async function FormsPage() {
  const supabase = await supabaseServer();
  const [{ data: forms }, { data: importEnabled }] = await Promise.all([
    supabase
      .from("form_instance")
      .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase.schema("app").rpc("feature_enabled", { p_key: FLAG, p_default: false }),
  ]);

  return (
    <AppShell active="/office/forms">
      <div className="rise">
        <PageHeader
          title="Forms"
          sub="All records, newest first. Versions are permanent; edits create corrections."
        />
        {!forms?.length ? (
          <EmptyState
            icon={<IconClipboard />}
            title="No forms yet"
            body="Forms you create or are assigned to review appear here. Start one from a client's chart."
          />
        ) : (
          <div className="card divide-y hairline overflow-hidden stagger">
            {forms.map((f) => {
              const template = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
              const client = Array.isArray(f.client) ? f.client[0] : f.client;
              return (
                <Link key={f.id} href={`/office/forms/${f.id}`} className="row-link group">
                  <TintTile icon={<IconClipboard />} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{template?.title ?? "Form"}</p>
                    <p className="mt-0.5 truncate text-[13px] tabular" style={{ color: "var(--text-muted)" }}>
                      {client ? `${client.first_name} ${client.last_name} · ` : ""}
                      updated {new Date(f.updated_at).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <StatusChip status={f.status} />
                  <IconChevronRight
                    className="shrink-0 opacity-40 transition-opacity duration-150 group-hover:opacity-70"
                    style={{ color: "var(--text-muted)" }}
                  />
                </Link>
              );
            })}
          </div>
        )}
        {importEnabled === true && <PdfImportPanel />}
      </div>
    </AppShell>
  );
}
