import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, SectionTitle, SkeletonRows, StatusChip, TintTile } from "@/components/ui";
import { IconChevronRight, IconClipboard, IconMapPin, IconPlus } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { featureEnabled } from "@/lib/flags";
import { FAMILY_WEEKLY_FLAG } from "@/lib/ai/family-update";
import { FamilyUpdateCard } from "./family-update";

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

  // Server-side gate (ST-241). Postgres owns the answer, and a dark flag renders NOTHING —
  // not a teaser, not a disabled button. `featureEnabled` fails closed on every error path.
  const familyWeekly = await featureEnabled(FAMILY_WEEKLY_FLAG, false);

  const name = `${client.first_name} ${client.last_name}`;
  const address = [client.address_line1, client.city, client.state].filter(Boolean).join(", ");

  return (
    <AppShell active="/office/clients">
      <div className="rise">
        <nav className="mb-4 text-[13px]" aria-label="Breadcrumb" style={{ color: "var(--text-muted)" }}>
          <Link href="/office/clients" className="hover:underline">Clients</Link>
          <span className="mx-1.5">/</span>
          <span style={{ color: "var(--text-secondary)" }}>{name}</span>
        </nav>

        {/* Hero identity — Apple Health chart header */}
        <div className="card mb-6 p-6 sm:p-7"
             style={{ background: "linear-gradient(180deg, var(--accent-soft) 0%, var(--panel) 116px)" }}>
          <div className="flex flex-wrap items-center gap-5">
            <Avatar name={name} size={64} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="title-lg text-[28px] sm:text-[32px]">{name}</h1>
                <StatusChip status={client.status} />
              </div>
              <p className="mt-1.5 flex items-center gap-1.5 text-[15px]" style={{ color: "var(--text-muted)" }}>
                <IconMapPin width={15} height={15} />
                {address || "No address on file"}
              </p>
            </div>
            <Link href={`/office/clients/${id}/new`} className="btn btn-primary">
              <IconPlus width={16} height={16} />
              New record
            </Link>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-5 border-t pt-6 hairline sm:grid-cols-4">
            <div>
              <dt className="label mb-1">Date of birth</dt>
              <dd className="tabular text-[15px] font-medium">{fmtDate(client.dob)}</dd>
            </div>
            <div>
              <dt className="label mb-1">Admitted</dt>
              <dd className="tabular text-[15px] font-medium">{fmtDate(client.admitted_on)}</dd>
            </div>
            <div>
              <dt className="label mb-1">Language</dt>
              <dd className="text-[15px] font-medium">{client.primary_language === "es" ? "Spanish" : "English"}</dd>
            </div>
            <div>
              <dt className="label mb-1">Payer</dt>
              <dd className="text-[15px] font-medium capitalize">{client.payer_type?.replace("_", " ") ?? "—"}</dd>
            </div>
          </dl>
        </div>

        {familyWeekly && (
          <Suspense fallback={<SkeletonRows rows={2} />}>
            <FamilyUpdateCard clientId={id} />
          </Suspense>
        )}

        <SectionTitle icon={<IconClipboard width={16} height={16} />}>
          Records
          {forms?.length ? (
            <span className="ml-auto tabular text-[13px] font-normal" style={{ color: "var(--text-muted)" }}>
              {forms.length} on file
            </span>
          ) : null}
        </SectionTitle>
        {!forms?.length ? (
          <EmptyState
            icon={<IconClipboard />}
            title="No records yet"
            body="Assessments, care plans, and visit notes appear here. Versions are permanent; edits create corrections."
            action={
              <Link href={`/office/clients/${id}/new`} className="btn btn-primary">
                <IconPlus width={16} height={16} />
                Start a record
              </Link>
            }
          />
        ) : (
          <div className="card stagger divide-y hairline overflow-hidden">
            {forms.map((f) => {
              const template = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
              return (
                <Link key={f.id} href={`/office/forms/${f.id}`} className="row-link group">
                  <TintTile icon={<IconClipboard />} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{template?.title ?? "Record"}</p>
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
