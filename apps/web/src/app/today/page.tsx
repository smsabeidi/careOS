import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  SectionTitle,
  StatusChip,
  TintTile,
} from "@/components/ui";
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconClock,
  IconLock,
  IconMapPin,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { VoiceNote } from "@/components/voice-note";
import { getLocale, getT } from "@/lib/i18n/server";
import { ClockButton } from "./clock-button";
import { ConnectionStatus } from "./connection-status";

/**
 * The caregiver's whole day, on a phone (docs/10 §2, docs/17 §7.1).
 *
 * Two things changed when the verified visit landed. First, the card now shows what the
 * RECORD says, not what the schedule hoped: `actual_start` comes from public.verified_visit,
 * which derives it from the append-only clock ledger rather than from a denormalised column
 * that could drift (0045's "a view can be slow; it cannot be stale"). Second, the four-state
 * doctrine is honoured properly — an error says what is preserved, and an empty list is
 * probed for the AAL2 cause before it is allowed to claim there is nothing to do.
 *
 * Only two columns of verified_visit are read here, and neither is a distance: the view
 * carries clock_in_distance_m for the RLS-gated admin surfaces, and D-030 keeps it there.
 * The caregiver never sees a metre, a coordinate, or the word EVV anywhere on this page.
 */

export async function generateMetadata() {
  const t = await getT();
  return { title: t("page.today") };
}
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

/** The derived read model — explicit columns, no coordinates, no distances (D-030). */
type VerifiedVisitRow = {
  visit_id: string;
  actual_start: string | null;
  actual_end: string | null;
  verification_status: string;
};

function clientOf(v: Visit) {
  return Array.isArray(v.client) ? v.client[0] : v.client;
}
function timeOf(iso: string, locale: string) {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

export default async function TodayPage() {
  const t = await getT();
  const locale = await getLocale();
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const uid = user?.id ?? "";

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // ── My visits: today (window) + the next few upcoming, and the clock facts beside them ──
  const [visitRes, verifiedRes, assignmentRes, draftRes] = await Promise.all([
    supabase
      .from("visit")
      .select(
        "id, client_id, scheduled_start, scheduled_end, status, client(first_name, last_name, city, address_line1)"
      )
      .eq("caregiver_id", uid)
      .gte("scheduled_start", startOfDay.toISOString())
      .order("scheduled_start", { ascending: true })
      .limit(40),
    supabase
      .from("verified_visit")
      .select("visit_id, actual_start, actual_end, verification_status")
      .eq("caregiver_id", uid)
      .gte("scheduled_start", startOfDay.toISOString())
      .limit(40),
    supabase
      .from("care_team_assignment")
      .select("client_id, role_on_case, client(id, first_name, last_name, city, status)")
      .eq("user_id", uid)
      .is("ends_on", null),
    supabase
      .from("form_instance")
      .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
      .eq("created_by", uid)
      .in("status", ["draft", "in_review"])
      .order("updated_at", { ascending: false })
      .limit(5),
  ]);

  // ── Error state: the day's schedule is the reason this page exists. If it cannot be
  //    read, say so plainly rather than rendering an empty day somebody might believe.
  if (visitRes.error) {
    return (
      <AppShell active="/today">
        <div className="rise mx-auto max-w-xl">
          <PageHeader title={t("page.today")} />
          <ErrorState
            title={t("today.errorTitle")}
            body={t("today.errorBody")}
            retry={
              <Link href="/today" className="btn btn-primary btn-sm">
                {t("common.tryAgain")}
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const visits = (visitRes.data ?? []) as Visit[];

  // ── Degraded read: visits are AAL2-gated PHI, so an unverified session sees an empty
  //    list rather than an error. Probe for that cause before claiming "nothing today" —
  //    a caregiver told they have no visits will go home.
  if (visits.length === 0) {
    let aal2 = true;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = !data || data.currentLevel === "aal2";
    } catch {
      aal2 = true; // never block the page on an assurance-level probe
    }
    if (!aal2) {
      return (
        <AppShell active="/today">
          <div className="rise mx-auto max-w-xl">
            <PageHeader title={t("page.today")} />
            <EmptyState
              icon={<IconLock />}
              title={t("today.lockedTitle")}
              body={t("today.lockedBody")}
              action={
                <Link href="/mfa" className="btn btn-primary btn-sm">
                  {t("today.lockedCta")}
                </Link>
              }
            />
          </div>
        </AppShell>
      );
    }
  }

  const verifiedById = new Map(
    ((verifiedRes.data ?? []) as VerifiedVisitRow[]).map((r) => [r.visit_id, r])
  );
  const assignments = assignmentRes.data;
  const myDrafts = draftRes.data;

  const todays = visits.filter((v) => new Date(v.scheduled_start) < endOfDay);
  const upcoming = visits.filter((v) => new Date(v.scheduled_start) >= endOfDay).slice(0, 6);

  const today = now.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
  const doneCount = todays.filter((v) => v.status === "completed").length;
  const sub = todays.length
    ? `${today} · ${t("today.subVisits", { done: doneCount, total: todays.length })}`
    : today;

  return (
    <AppShell active="/today">
      <div className="rise mx-auto max-w-xl">
        <PageHeader title={t("page.today")} sub={sub} actions={<ConnectionStatus />} />

        {/* ── Today's visits ── */}
        <section className="mb-6">
          <SectionTitle icon={<IconCalendar width={16} height={16} />}>{t("today.yourVisits")}</SectionTitle>
          {!todays.length ? (
            /* Two different emptinesses used to share one line of copy. A caregiver who has
               visits later in the week only needs "nothing today" — the Upcoming section is
               directly below and answers the rest. A caregiver whose whole list is empty is
               almost always new here, and a blank first screen reads as a broken one, so
               that case gets the coaching instead: what lands on this screen, who puts it
               there, and one live place to go now (docs/10 §8).
               The AAL2 probe above has already returned for an unverified session, so
               reaching this branch with no visits means the session IS verified and the
               emptiness is real — never RLS quietly filtering a day the caregiver has. */
            !visits.length ? (
              <EmptyState
                icon={<IconCalendar />}
                title={t("today.emptyCoach.title")}
                body={t("today.emptyCoach.body")}
                action={
                  <Link href="/office/clients" className="btn btn-primary btn-sm">
                    {t("nav.myClients")}
                  </Link>
                }
              />
            ) : (
              <EmptyState
                icon={<IconCalendar />}
                title={t("today.noVisitsTitle")}
                body={t("today.noVisitsBody")}
              />
            )
          ) : (
            <div className="stagger flex flex-col gap-3">
              {todays.map((v) => {
                const c = clientOf(v);
                const name = c ? `${c.first_name} ${c.last_name}` : t("today.clientFallback");
                const done = v.status === "completed";
                const active = v.status === "in_progress";
                const derived = verifiedById.get(v.id);
                // Formatted server-side, like every other time on this page, so the first
                // paint carries no timezone guess and nothing shifts on hydration.
                const arrival = derived?.actual_start ? timeOf(derived.actual_start, locale) : null;
                const flagged = derived?.verification_status === "exception";
                return (
                  <div key={v.id} className="card p-4">
                    <div className="flex items-center gap-3.5">
                      <div className="flex w-14 shrink-0 flex-col items-center">
                        <span className="tabular text-[15px] font-semibold">{timeOf(v.scheduled_start, locale)}</span>
                        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                          {timeOf(v.scheduled_end, locale)}
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
                        <Badge tone="success" icon={<IconCheck />}>{t("today.completed")}</Badge>
                      ) : active ? (
                        <Badge tone="warning" icon={<IconClock />}>{t("today.inProgress")}</Badge>
                      ) : null}
                    </div>

                    {/* Status is colour + icon + label, never colour alone. "Your coordinator
                        will take a look" is the whole message — no accusation, no numbers. */}
                    {flagged && (
                      <p
                        className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed"
                        style={{ color: "var(--color-warning-700)" }}
                      >
                        <IconAlert width={13} height={13} className="mt-0.5 shrink-0" />
                        {t("today.flagged")}
                      </p>
                    )}

                    <div className="mt-3 flex items-start gap-2">
                      {/* Keyed on the visit's status so a successful clock remounts the
                          control: the optimistic "Clocked in · 9:02 AM" hands over cleanly
                          to the server's own reading, and no stale disabled state survives
                          the revalidation. A SOFT refusal does not change status, so the
                          exception affordance the caregiver is reading is never torn down
                          underneath them. */}
                      <ClockButton
                        key={v.status}
                        visitId={v.id}
                        mode={done ? "done" : active ? "clock_out" : "clock_in"}
                        clockedInLabel={active ? arrival : null}
                      />
                      <Link href={`/office/clients/${v.client_id}`} className="btn btn-secondary btn-sm min-h-11">
                        <IconClipboard width={15} height={15} />
                        {t("today.openNotes")}
                      </Link>
                    </div>
                    {/* Speak the note instead of typing it. The draft is reviewed section by
                        section and saved by the caregiver — nothing files itself (docs/16 G1). */}
                    <VoiceNote visitId={v.id} clientId={v.client_id} clientName={name} />
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 px-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            {t("today.clockNote")}
          </p>
        </section>

        {/* ── Upcoming ── */}
        {upcoming.length > 0 && (
          <section className="mb-6">
            <SectionTitle>{t("today.upcoming")}</SectionTitle>
            <div className="card stagger divide-y hairline overflow-hidden">
              {upcoming.map((v) => {
                const c = clientOf(v);
                const name = c ? `${c.first_name} ${c.last_name}` : t("today.clientFallback");
                return (
                  <Link key={v.id} href={`/office/clients/${v.client_id}`} className="row-link group min-h-14">
                    <TintTile icon={<IconCalendar width={18} height={18} />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{name}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {new Date(v.scheduled_start).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}
                        {" · "}{timeOf(v.scheduled_start, locale)}
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
          <SectionTitle>{t("nav.myClients")}</SectionTitle>
          {!assignments?.length ? (
            <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              {t("today.noClients")}
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
                        {c.city ?? "—"} · {a.role_on_case.replace(/_/g, " ")}
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
          <SectionTitle>{t("today.myOpenNotes")}</SectionTitle>
          {!myDrafts?.length ? (
            <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              {t("today.noDrafts")}
            </p>
          ) : (
            <div className="card stagger divide-y hairline overflow-hidden">
              {myDrafts.map((f) => {
                const tpl = Array.isArray(f.form_template) ? f.form_template[0] : f.form_template;
                const c = Array.isArray(f.client) ? f.client[0] : f.client;
                return (
                  <Link key={f.id} href={`/office/forms/${f.id}`} className="row-link group min-h-14">
                    <TintTile icon={<IconClipboard />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{tpl?.title ?? t("today.noteFallback")}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {c ? `${c.first_name} ${c.last_name} · ` : ""}
                        {t("today.savedAt", { time: timeOf(f.updated_at, locale) })}
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
