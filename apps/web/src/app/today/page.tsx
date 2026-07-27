import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, Badge, EmptyState, PageHeader, SectionTitle, StatusChip, TintTile } from "@/components/ui";
import { IconCalendar, IconChevronRight, IconClipboard, IconClock, IconMapPin, IconCheck } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

type Visit = {
  id: string;
  client_id: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  client: { first_name: string; last_name: string; city: string | null; address_line1: string | null }
    | { first_name: string; last_name: string; city: string | null; address_line1: string | null }[]
    | null;
};

function clientOf(v: Visit) {
  return Array.isArray(v.client) ? v.client[0] : v.client;
}
function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default async function TodayPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const uid = user?.id ?? "";

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // ── My visits: today (window) + the next few upcoming ──
  const { data: visitRows } = await supabase
    .from("visit")
    .select("id, client_id, scheduled_start, scheduled_end, status, client(first_name, last_name, city, address_line1)")
    .eq("caregiver_id", uid)
    .gte("scheduled_start", startOfDay.toISOString())
    .order("scheduled_start", { ascending: true })
    .limit(40);
  const visits = (visitRows ?? []) as Visit[];
  const todays = visits.filter((v) => new Date(v.scheduled_start) < endOfDay);
  const upcoming = visits.filter((v) => new Date(v.scheduled_start) >= endOfDay).slice(0, 6);

  const { data: assignments } = await supabase
    .from("care_team_assignment")
    .select("client_id, role_on_case, client(id, first_name, last_name, city, status)")
    .eq("user_id", uid)
    .is("ends_on", null);

  const { data: myDrafts } = await supabase
    .from("form_instance")
    .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
    .eq("created_by", uid)
    .in("status", ["draft", "in_review"])
    .order("updated_at", { ascending: false })
    .limit(5);

  const today = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const doneCount = todays.filter((v) => v.status === "completed").length;
  const sub = todays.length
    ? `${today} · ${doneCount}/${todays.length} visits done`
    : today;

  return (
    <AppShell active="/today">
      <div className="rise mx-auto max-w-xl">
        <PageHeader title="Today" sub={sub} />

        {/* ── Today's visits ── */}
        <section className="mb-6">
          <SectionTitle icon={<IconCalendar width={16} height={16} />}>Your visits</SectionTitle>
          {!todays.length ? (
            <EmptyState
              icon={<IconCalendar />}
              title="No visits scheduled today"
              body="When your coordinator schedules you, each visit shows up here with the time, the client and the address — ready to tap into."
            />
          ) : (
            <div className="stagger flex flex-col gap-3">
              {todays.map((v) => {
                const c = clientOf(v);
                const name = c ? `${c.first_name} ${c.last_name}` : "Client";
                const done = v.status === "completed";
                const active = v.status === "in_progress";
                return (
                  <div key={v.id} className="card p-4">
                    <div className="flex items-center gap-3.5">
                      <div className="flex w-14 shrink-0 flex-col items-center">
                        <span className="tabular text-[15px] font-semibold">{timeOf(v.scheduled_start)}</span>
                        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                          {timeOf(v.scheduled_end)}
                        </span>
                      </div>
                      <Avatar name={name} size={44} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[16px] font-semibold">{name}</p>
                        {c?.address_line1 && (
                          <p className="mt-0.5 flex items-center gap-1 truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                            <IconMapPin width={13} height={13} />
                            {c.address_line1}{c.city ? `, ${c.city}` : ""}
                          </p>
                        )}
                      </div>
                      {done ? (
                        <Badge tone="success" icon={<IconCheck />}>Done</Badge>
                      ) : active ? (
                        <Badge tone="warning" icon={<IconClock />}>In progress</Badge>
                      ) : null}
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className={`btn btn-sm min-h-11 flex-1 ${done ? "btn-secondary" : "btn-primary"}`}
                        disabled={done}
                      >
                        <IconClock width={15} height={15} />
                        {done ? "Visit complete" : active ? "Clock out" : "Clock in"}
                      </button>
                      <Link href={`/office/clients/${v.client_id}`} className="btn btn-secondary btn-sm min-h-11">
                        <IconClipboard width={15} height={15} />
                        Notes
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 px-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Clocking in from here is a preview. Live GPS-verified clock-in (EVV) works offline in the CareOS
            field app — even in a basement with no signal — and syncs when you&apos;re back on.
          </p>
        </section>

        {/* ── Upcoming ── */}
        {upcoming.length > 0 && (
          <section className="mb-6">
            <SectionTitle>Coming up</SectionTitle>
            <div className="card stagger divide-y hairline overflow-hidden">
              {upcoming.map((v) => {
                const c = clientOf(v);
                const name = c ? `${c.first_name} ${c.last_name}` : "Client";
                return (
                  <Link key={v.id} href={`/office/clients/${v.client_id}`} className="row-link group min-h-14">
                    <TintTile icon={<IconCalendar width={18} height={18} />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{name}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {new Date(v.scheduled_start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                        {" · "}{timeOf(v.scheduled_start)}
                      </p>
                    </div>
                    <IconChevronRight style={{ color: "var(--text-muted)" }} />
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* ── My clients ── */}
        <section className="mb-6">
          <SectionTitle>My clients</SectionTitle>
          {!assignments?.length ? (
            <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              Clients you&apos;re assigned to will appear here.
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
                        {c.city ?? "—"} · you&apos;re their {a.role_on_case.replace(/_/g, " ")}
                      </p>
                    </div>
                    <IconChevronRight style={{ color: "var(--text-muted)" }} />
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ── My open notes ── */}
        <section>
          <SectionTitle>My open notes</SectionTitle>
          {!myDrafts?.length ? (
            <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              Drafts you&apos;re working on will wait for you here — saved automatically, never lost.
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
