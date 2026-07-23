import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/shell";
import { PageHeader, EmptyState, TintTile } from "@/components/ui";
import { IconChevronRight, IconClipboard } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function startForm(formData: FormData) {
  "use server";
  const templateId = String(formData.get("template_id"));
  const clientId = String(formData.get("client_id"));
  const supabase = await supabaseServer();
  const { data, error } = await supabase.schema("app").rpc("create_form", {
    p_template: templateId,
    p_client: clientId,
    p_content: {},
  });
  if (error || !data) {
    redirect(`/office/clients/${clientId}?error=create`);
  }
  redirect(`/office/forms/${data}`);
}

export default async function NewFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: client } = await supabase
    .from("client")
    .select("id, first_name, last_name")
    .eq("id", id)
    .maybeSingle();
  if (!client) notFound();

  const { data: templates } = await supabase
    .from("form_template")
    .select("id, key, title, requires_signature_roles")
    .eq("status", "active")
    .order("title");

  return (
    <AppShell active="/office/clients">
      <div className="rise mx-auto max-w-2xl">
        <nav className="mb-4 text-[13px]" aria-label="Breadcrumb" style={{ color: "var(--text-muted)" }}>
          <Link href="/office/clients" className="hover:underline">Clients</Link>
          <span className="mx-1.5">/</span>
          <Link href={`/office/clients/${id}`} className="hover:underline">
            {client.first_name} {client.last_name}
          </Link>
          <span className="mx-1.5">/</span>
          <span style={{ color: "var(--text-secondary)" }}>New record</span>
        </nav>

        <PageHeader
          title="Start a new record"
          sub={`For ${client.first_name} ${client.last_name}. Every save keeps its own version — nothing gets overwritten.`}
        />

        {templates && templates.length > 0 ? (
          <div className="stagger flex flex-col gap-3">
            {templates.map((t) => (
              <form key={t.id} action={startForm}>
                <input type="hidden" name="template_id" value={t.id} />
                <input type="hidden" name="client_id" value={client.id} />
                <button
                  type="submit"
                  className="card card-interactive row-link group w-full text-left"
                >
                  <TintTile icon={<IconClipboard />} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">{t.title}</p>
                    <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {t.requires_signature_roles?.length
                        ? `Needs a signature from: ${t.requires_signature_roles.join(", ").toUpperCase()}`
                        : "No signature required to finalize"}
                    </p>
                  </div>
                  <IconChevronRight
                    className="shrink-0 opacity-40 transition-opacity duration-150 group-hover:opacity-70"
                    style={{ color: "var(--text-muted)" }}
                  />
                </button>
              </form>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconClipboard />}
            title="No record types to start yet"
            body={`Once your agency publishes active form templates, they'll show up here for ${client.first_name}.`}
            action={
              <Link href={`/office/clients/${id}`} className="btn btn-secondary">
                Back to profile
              </Link>
            }
          />
        )}
      </div>
    </AppShell>
  );
}
