import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, StatusChip } from "@/components/ui";
import { IconChevronRight, IconClipboard, IconPlus } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

export default async function ClientChart({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();

  const { data: client } = await supabase
    .from("client")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!client) notFound();

  const { data: forms } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, form_template(title)")
    .eq("client_id", id)
    .order("updated_at", { ascending: false });

  const name = `${client.first_name} ${client.last_name}`;

  return (
    <AppShell active="/office/clients">
      <div className="rise">
        <nav className="mb-4 text-[13px]" aria-label="Breadcrumb" style={{ color: "var(--text-muted)" }}>
          <Link href="/office/clients" className="hover:underline">Clients</Link>
          <span className="mx-1.5">/</span>
          <span style={{ color: "var(--text-secondary)" }}>{name}</span>
        </nav>

        <div className="card mb-6 p-6">
          <div className="flex flex-wrap items-center gap-5">
            <Avatar name={name} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-semibold tracking-[-0.01em]">{name}</h1>
                <StatusChip status={client.status} />
              </div>
              <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
                {[client.address_line1, client.city, client.state].filter(Boolean).join(", ") || "Address on file"}
              </p>
            </div>
            <Link href={`/office/clients/${id}/new`} className="btn btn-primary">
              <IconPlus width={16} height={16} />
              New form
            </Link>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-t pt-5 text-sm hairline sm:grid-cols-4">
            <div>
              <dt className="label mb-0.5">Date of birth</dt>
              <dd className="tabular">{fmtDate(client.dob)}</dd>
            </div>
            <div>
              <dt className="label mb-0.5">Admitted</dt>
              <dd className="tabular">{fmtDate(client.admitted_on)}</dd>
            </div>
            <div>
              <dt className="label mb-0.5">Language</dt>
              <dd>{client.primary_language === "es" ? "Spanish" : "English"}</dd>
            </div>
            <div>
              <dt className="label mb-0.5">Payer</dt>
              <dd className="capitalize">{client.payer_type?.replace("_", " ") ?? "—"}</dd>
            </div>
          </dl>
        </div>

        <h2 className="mb-3 text-[15px] font-semibold">Records</h2>
        {!forms?.length ? (
          <EmptyState
            icon={<IconClipboard />}
            title={`No records for ${client.first_name} yet`}
            body="Assessments, care plans, and visit notes will live here — every version kept, nothing ever overwritten."
            action={
              <Link href={`/office/clients/${id}/new`} className="btn btn-primary">
                <IconPlus width={16} height={16} />
                Start the first record
              </Link>
            }
          />
        ) : (
          <div className="card divide-y hairline overflow-hidden">
            {forms.map((f) => {
              const template = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
              return (
                <Link key={f.id} href={`/office/forms/${f.id}`} className="row-link group">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg"
                       style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                    <IconClipboard />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{template?.title ?? "Form"}</p>
                    <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      Updated {new Date(f.updated_at).toLocaleString(undefined, {
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
