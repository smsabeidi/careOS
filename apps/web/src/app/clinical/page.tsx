import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, SectionTitle, StatusChip, TintTile } from "@/components/ui";
import { IconCheck, IconChevronRight, IconClipboard, IconPen, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";

export const metadata = { title: "Clinical" };
export const dynamic = "force-dynamic";

export default async function ClinicalPage() {
  const profile = await requireRole(["rn", "owner", "admin"]);
  const supabase = await supabaseServer();

  // Assessments whose template demands an RN signature, still unsigned
  const { data: pending } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, client(first_name, last_name), form_template!inner(title, requires_signature_roles)")
    .in("status", ["draft", "in_review"])
    .filter("form_template.requires_signature_roles", "cs", "{rn}")
    .order("updated_at", { ascending: true })
    .limit(100);

  let queue = pending ?? [];
  if (queue.length) {
    const ids = queue.map((q) => q.id);
    const { data: versions } = await supabase
      .from("form_version")
      .select("id, instance_id")
      .in("instance_id", ids);
    const versionIds = (versions ?? []).map((v) => v.id);
    const { data: sigs } = versionIds.length
      ? await supabase.from("signature").select("form_version_id").in("form_version_id", versionIds)
      : { data: [] as { form_version_id: string }[] };
    const signedVersions = new Set((sigs ?? []).map((s) => s.form_version_id));
    const signedInstances = new Set(
      (versions ?? []).filter((v) => signedVersions.has(v.id)).map((v) => v.instance_id)
    );
    queue = queue.filter((q) => !signedInstances.has(q.id));
  }

  // My caseload (clients where I'm the RN case manager)
  const { data: caseload } = await supabase
    .from("care_team_assignment")
    .select("client_id, client(id, first_name, last_name, city, status)")
    .eq("user_id", profile.userId)
    .eq("role_on_case", "rn_case_manager")
    .is("ends_on", null)
    .limit(200);

  const caseClients = (caseload ?? [])
    .map((a) => (Array.isArray(a.client) ? a.client[0] : a.client))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  return (
    <AppShell active="/clinical">
      <div className="rise">
        <PageHeader
          title="Clinical"
          sub={
            queue.length
              ? `${queue.length} ${queue.length === 1 ? "record needs" : "records need"} your signature · ${caseClients.length} people on your caseload`
              : `Nothing waiting for your signature · ${caseClients.length} people on your caseload`
          }
        />

        <section className="mb-8">
          <SectionTitle icon={<IconPen width={16} height={16} />}>
            Needs your signature
          </SectionTitle>
          {!queue.length ? (
            <div className="card flex items-center gap-3.5 px-5 py-4">
              <TintTile icon={<IconCheck width={20} height={20} />} tone="success" size={40} />
              <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
                All caught up — new assessments land here the moment they&apos;re drafted.
              </p>
            </div>
          ) : (
            <div className="card stagger divide-y hairline overflow-hidden">
              {queue.slice(0, 25).map((q) => {
                const t = Array.isArray(q.form_template) ? q.form_template[0] : q.form_template;
                const c = Array.isArray(q.client) ? q.client[0] : q.client;
                return (
                  <Link key={q.id} href={`/office/forms/${q.id}`} className="row-link">
                    <TintTile icon={<IconClipboard width={20} height={20} />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">
                        {t?.title ?? "Record"}
                        {c && <span style={{ color: "var(--text-muted)" }}> · {c.first_name} {c.last_name}</span>}
                      </p>
                      <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        Waiting since {new Date(q.updated_at).toLocaleDateString(undefined, {
                          month: "short", day: "numeric",
                        })}
                      </p>
                    </div>
                    <StatusChip status={q.status} />
                    <span className="btn btn-primary btn-sm shrink-0">
                      <IconPen width={14} height={14} />
                      Review &amp; sign
                    </span>
                  </Link>
                );
              })}
              {queue.length > 25 && (
                <p className="px-5 py-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {queue.length - 25} more waiting — oldest are listed first.
                </p>
              )}
            </div>
          )}
        </section>

        <section>
          <SectionTitle icon={<IconUsers width={16} height={16} />}>
            My caseload
          </SectionTitle>
          {!caseClients.length ? (
            <EmptyState
              icon={<IconUsers />}
              title="No caseload assigned yet"
              body="Clients you case-manage appear here once your coordinator assigns them."
            />
          ) : (
            <div className="card stagger divide-y hairline overflow-hidden">
              {caseClients.map((c) => (
                <Link key={c.id} href={`/office/clients/${c.id}`} className="row-link group">
                  <Avatar name={`${c.first_name} ${c.last_name}`} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">
                      {c.first_name} {c.last_name}
                    </p>
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>{c.city ?? "—"}</p>
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
        </section>
      </div>
    </AppShell>
  );
}
