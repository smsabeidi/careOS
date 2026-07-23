import Link from "next/link";
import { AppShell } from "@/components/shell";
import { PageHeader, SectionTitle, Stat, StatusChip } from "@/components/ui";
import { IconActivity, IconCalendar, IconChevronRight, IconPen, IconShield } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";

export const metadata = { title: "Command" };
export const dynamic = "force-dynamic";

export default async function ExecPage() {
  await requireRole(["owner", "admin"]);
  const supabase = await supabaseServer();

  const [
    { count: activeClients },
    { count: allClients },
    { count: onHold },
    { count: pendingAdm },
    { count: staffActive },
    { count: rnQueue },
    { count: finalRecords },
    { count: drafts },
    { data: recent },
  ] = await Promise.all([
    supabase.from("client").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("client").select("id", { count: "exact", head: true }),
    supabase.from("client").select("id", { count: "exact", head: true }).eq("status", "on_hold"),
    supabase.from("client").select("id", { count: "exact", head: true }).eq("status", "pending_admission"),
    supabase.from("app_user").select("id", { count: "exact", head: true }).eq("kind", "staff").eq("status", "active"),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "in_review"),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "final"),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "draft"),
    supabase
      .from("form_instance")
      .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
      .order("updated_at", { ascending: false })
      .limit(7),
  ]);

  return (
    <AppShell active="/exec">
      <div className="rise">
        <PageHeader
          title="Command"
          sub="The agency at a glance — census, staffing, documentation, and what changed."
        />

        <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Active clients" value={activeClients ?? 0}
                hint={`${allClients ?? 0} on file · ${onHold ?? 0} on hold · ${pendingAdm ?? 0} pending`} />
          <Stat label="Active staff" value={staffActive ?? 0} hint="nurses, caregivers & office" />
          <Stat label="Records on file" value={finalRecords ?? 0}
                hint={`${drafts ?? 0} drafts in progress`} />
          <Stat label="Awaiting RN signature" value={rnQueue ?? 0} hint="in the clinical queue" />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <section className="card overflow-hidden">
            <div className="px-5 pt-5">
              <SectionTitle icon={<IconActivity width={16} height={16} />}>
                Recent activity
              </SectionTitle>
            </div>
            {!recent?.length ? (
              <p className="px-5 pb-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                Activity appears here as your team documents care.
              </p>
            ) : (
              <ul className="stagger divide-y hairline border-t">
                {recent.map((f) => {
                  const t = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
                  const c = Array.isArray(f.client) ? f.client[0] : f.client;
                  return (
                    <li key={f.id}>
                      <Link href={`/office/forms/${f.id}`} className="row-link">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[15px] font-medium">
                            {t?.title ?? "Record"}
                            {c ? <span style={{ color: "var(--text-muted)" }}> · {c.first_name} {c.last_name}</span> : null}
                          </p>
                          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                            {new Date(f.updated_at).toLocaleString(undefined, {
                              weekday: "short", hour: "numeric", minute: "2-digit",
                            })}
                          </p>
                        </div>
                        <StatusChip status={f.status} />
                        <IconChevronRight className="shrink-0"
                          style={{ color: "var(--text-muted)" }} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="flex flex-col gap-4">
            <section className="card p-5">
              <SectionTitle icon={<IconPen width={16} height={16} />}>Clinical queue</SectionTitle>
              <p className="text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {rnQueue
                  ? `${rnQueue} ${rnQueue === 1 ? "assessment is" : "assessments are"} drafted and waiting for an RN signature.`
                  : "Every drafted assessment has been signed."}
              </p>
              <Link href="/clinical" className="btn btn-tinted btn-sm mt-4">
                Open the clinical queue
              </Link>
            </section>

            <section className="card p-5">
              <SectionTitle icon={<IconShield width={16} height={16} />}>Compliance heat</SectionTitle>
              <div className="flex items-start gap-3">
                <IconCalendar width={18} height={18} className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                <p className="text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  COMAR deadlines — assessments, supervisory visits, credential expiries — land here
                  when the cadence engine ships in Sprint 3. Until then, records already can't be
                  lost or silently changed: the audit chain is live and verified.
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
