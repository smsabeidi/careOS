import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, SectionTitle, StatusChip, TintTile } from "@/components/ui";
import { IconCalendar, IconChevronRight, IconClipboard } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: assignments } = await supabase
    .from("care_team_assignment")
    .select("client_id, role_on_case, client(id, first_name, last_name, city, status)")
    .eq("user_id", user?.id ?? "")
    .is("ends_on", null);

  const { data: myDrafts } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
    .eq("created_by", user?.id ?? "")
    .in("status", ["draft", "in_review"])
    .order("updated_at", { ascending: false })
    .limit(5);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });

  return (
    <AppShell active="/today">
      <div className="rise mx-auto max-w-xl">
        <PageHeader title="Today" sub={today} />

        {/* Visits — honest state until scheduling ships (S4) */}
        <section className="mb-6">
          <SectionTitle>Visits</SectionTitle>
          <EmptyState
            icon={<IconCalendar />}
            title="No visits scheduled here yet"
            body="Your schedule appears here once scheduling turns on. Until then, your coordinator will reach you the usual way — and your clients and notes below are ready."
          />
        </section>

        {/* My clients */}
        <section className="mb-6">
          <SectionTitle>My clients</SectionTitle>
          {!assignments?.length ? (
            <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              Clients you're assigned to will appear here.
            </p>
          ) : (
            <div className="card stagger divide-y hairline overflow-hidden">
              {assignments.map((a) => {
                const c = Array.isArray(a.client) ? a.client[0] : a.client;
                if (!c) return null;
                return (
                  <Link key={a.client_id} href={`/office/clients/${c.id}`} className="row-link group min-h-14">
                    <Avatar name={`${c.first_name} ${c.last_name}`} size={44} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium">{c.first_name} {c.last_name}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {c.city ?? "—"} · you're their {a.role_on_case.replace(/_/g, " ")}
                      </p>
                    </div>
                    <IconChevronRight style={{ color: "var(--text-muted)" }} />
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* My open notes */}
        <section>
          <SectionTitle>My open notes</SectionTitle>
          {!myDrafts?.length ? (
            <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              Drafts you're working on will wait for you here — saved automatically, never lost.
            </p>
          ) : (
            <div className="card stagger divide-y hairline overflow-hidden">
              {myDrafts.map((f) => {
                const t = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
                const c = Array.isArray(f.client) ? f.client[0] : f.client;
                return (
                  <Link key={f.id} href={`/office/forms/${f.id}`} className="row-link group min-h-14">
                    <TintTile icon={<IconClipboard />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{t?.title ?? "Note"}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {c ? `${c.first_name} ${c.last_name} · ` : ""}saved{" "}
                        {new Date(f.updated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </p>
                    </div>
                    <StatusChip status={f.status} />
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
