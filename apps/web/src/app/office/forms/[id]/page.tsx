import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell";
import { PageHeader, StatusChip } from "@/components/ui";
import { FormRuntime, type TemplateField } from "@/components/form-runtime";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: instance } = await supabase
    .from("form_instance")
    .select(
      "id, status, client_id, form_template(title, schema, requires_signature_roles), client(first_name, last_name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!instance) notFound();

  const { data: versions } = await supabase
    .from("form_version")
    .select("id, version_no, kind, authored_at, author_id, note, content, content_hash")
    .eq("instance_id", id)
    .order("version_no", { ascending: false });
  if (!versions?.length) notFound();

  const latest = versions[0];

  const { data: signatures } = await supabase
    .from("signature")
    .select("form_version_id, signer_role, signed_at, method")
    .in("form_version_id", versions.map((v) => v.id))
    .order("signed_at", { ascending: false });

  const authorIds = Array.from(new Set(versions.map((v) => v.author_id)));
  const { data: authors } = await supabase
    .from("app_user")
    .select("id, full_name")
    .in("id", authorIds);
  const authorNames = Object.fromEntries((authors ?? []).map((a) => [a.id, a.full_name]));

  const template = Array.isArray(instance.form_template)
    ? instance.form_template[0]
    : instance.form_template;
  const client = Array.isArray(instance.client) ? instance.client[0] : instance.client;
  const clientName = client ? `${client.first_name} ${client.last_name}` : null;
  const fields = ((template?.schema as { fields?: TemplateField[] })?.fields ?? []) as TemplateField[];

  return (
    <AppShell active="/office/forms">
      <div className="rise">
        <nav className="mb-4 text-[13px]" aria-label="Breadcrumb" style={{ color: "var(--text-muted)" }}>
          <Link href="/office/forms" className="hover:underline">Forms</Link>
          {clientName && instance.client_id && (
            <>
              <span className="mx-1.5">/</span>
              <Link href={`/office/clients/${instance.client_id}`} className="hover:underline">
                {clientName}
              </Link>
            </>
          )}
        </nav>

        <PageHeader
          title={template?.title ?? "Form"}
          sub={clientName ? `For ${clientName}` : undefined}
          actions={<StatusChip status={instance.status} />}
        />

        <FormRuntime
          instanceId={instance.id}
          status={instance.status}
          templateTitle={template?.title ?? "Form"}
          clientName={clientName}
          fields={fields}
          requiredRoles={template?.requires_signature_roles ?? []}
          latest={{
            id: latest.id,
            version_no: latest.version_no,
            content: (latest.content ?? {}) as Record<string, unknown>,
          }}
          versions={versions.map((v) => ({
            id: v.id,
            version_no: v.version_no,
            kind: v.kind,
            authored_at: v.authored_at,
            author_id: v.author_id,
            note: v.note,
            content_hash: String(v.content_hash),
          }))}
          signatures={signatures ?? []}
          authorNames={authorNames}
        />
      </div>
    </AppShell>
  );
}
