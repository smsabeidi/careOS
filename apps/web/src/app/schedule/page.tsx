import { redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/shell";
import { EmptyState, ErrorState, PageHeader, SectionTitle } from "@/components/ui";
import { IconCalendar, IconLock, IconPlus, IconAlert, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import {
  type Caregiver,
  type Client,
  buildWeek,
  findOpenShift,
  rankCandidates,
} from "./schedule-data";
import {
  AssignDrawer,
  AttentionPanel,
  CoveragePanel,
  CoverageRequests,
  FilterTabs,
  FlashBanner,
  Legend,
  PreviewBanner,
  ScheduleMetrics,
  WeekGrid,
  WeekNav,
  href,
} from "./components";
import { loadCoveragePanel, loadOpenVisits, runShiftFill } from "./agent-actions";

export const metadata = { title: "Schedule" };
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "coordinator"];

type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function clampOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "0", 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-52, Math.min(52, n));
}
function normFilter(raw: string | undefined): string {
  return raw === "open" || raw === "exceptions" ? raw : "all";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fill-agent flash copy. Every message says what happened, what is saved, and what is
 * next — including on the degraded path, where the plan is the platform's own words.
 */
const FILL_FLASH: Record<string, string> = {
  "fill-created":
    "Coverage plan saved. It is waiting for approval — review the ranking and the drafted offers below, then approve or reject the plan.",
  "fill-created-degraded":
    "Coverage plan saved. Offer wording could not be drafted, so the plan below is the platform's own; the ranking and the blockers are unaffected.",
  "fill-existing":
    "A coverage plan for this visit is already waiting for approval. It is shown below — nothing was created twice.",
  "fill-engine":
    "The scheduling engine could not rank candidates for this visit. Nothing was changed. Try again, or verify your session if it has expired.",
  "fill-unknown":
    "That visit could not be found on your account. Nothing was changed.",
  "fill-unsaved":
    "The coverage plan could not be saved, so nothing is waiting for approval. The ranking below is live — try again.",
};

/**
 * Illustrative assign. When the scheduling engine lands, this becomes a Lane-B Server
 * Action → `app.assign_visit` (which runs `app.assert_schedulable` in the same transaction
 * and emits an audit + outbox event). Until then it writes nothing and says so — no fake
 * success, and no PHI (names) placed in the redirect URL.
 */
async function assignVisit(formData: FormData) {
  "use server";
  const week = clampOffset(String(formData.get("week") ?? "0"));
  const filter = normFilter(String(formData.get("filter") ?? "all"));
  const sp = new URLSearchParams();
  if (week !== 0) sp.set("week", String(week));
  if (filter !== "all") sp.set("filter", filter);
  sp.set("flash", "preview-assign");
  redirect(`/schedule?${sp.toString()}`);
}

export default async function SchedulePage({ searchParams }: { searchParams: SP }) {
  const params = await searchParams;
  await requireRole(ROLES);
  const supabase = await supabaseServer();

  const offset = clampOffset(one(params.week));
  const filter = normFilter(one(params.filter));
  const flash = one(params.flash);
  const assignId = one(params.assign);
  const fillRaw = one(params.fill);
  const fillId = fillRaw && UUID_RE.test(fillRaw) ? fillRaw : undefined;
  const ctx = { offset, filter };

  // ── Real, RLS-scoped care-team data (the honest foundation for the illustration) ──
  const { data: rawAssign, error: assignErr } = await supabase
    .from("care_team_assignment")
    .select("user_id, client_id")
    .eq("role_on_case", "caregiver")
    .is("ends_on", null)
    .limit(3000);

  if (assignErr) {
    return (
      <AppShell active="/schedule">
        <div className="rise">
          <PageHeader title="Schedule" sub="Week at a glance" />
          <ErrorState
            title="Couldn't load the schedule"
            body="Couldn't load care team data. Nothing was changed. Try again."
            retry={
              <Link href={href({ week: offset, filter })} className="btn btn-secondary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const assignments = (rawAssign ?? []).filter(
    (a): a is { user_id: string; client_id: string } => Boolean(a.user_id && a.client_id)
  );
  const caregiverIds = [...new Set(assignments.map((a) => a.user_id))];
  const clientIds = [...new Set(assignments.map((a) => a.client_id))];

  const [{ data: cgRows }, { data: clientRows }] = await Promise.all([
    caregiverIds.length
      ? supabase.from("app_user").select("id, full_name, status").in("id", caregiverIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; status: string }[] }),
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name, city, status").in("id", clientIds)
      : Promise.resolve({
          data: [] as { id: string; first_name: string; last_name: string; city: string | null; status: string }[],
        }),
  ]);

  const caregivers: Caregiver[] = (cgRows ?? [])
    .filter((r) => r.status !== "separated")
    .map((r) => ({ id: r.id, name: r.full_name ?? "Caregiver", status: r.status }));

  const clients = new Map<string, Client>(
    (clientRows ?? []).map((c) => [
      c.id,
      { id: c.id, name: `${c.first_name} ${c.last_name}`, city: c.city ?? "", status: c.status },
    ])
  );

  // Empty: no caregiver care-team assignments visible to this user.
  if (caregivers.length === 0 || assignments.length === 0) {
    return (
      <AppShell active="/schedule">
        <div className="rise">
          <PageHeader title="Schedule" sub="Week at a glance" />
          <EmptyState
            icon={<IconCalendar />}
            title="No caregivers assigned"
            body="Schedules appear once caregivers are assigned to clients. Open shifts and coverage gaps appear at the top."
            action={
              <Link href="/office/staff" className="btn btn-primary btn-sm">
                Go to staff
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  // Degraded: caregivers/assignments loaded, but client records are gated (session not
  // step-up verified, or client.read.all withheld). Be honest about why it's blank.
  if (clients.size === 0) {
    return (
      <AppShell active="/schedule">
        <div className="rise">
          <PageHeader title="Schedule" sub="Week at a glance" />
          <EmptyState
            icon={<IconLock />}
            title="Verify your session to see the schedule"
            body="Client visits are protected health information and appear only on a verified (MFA) session."
            action={
              <Link href="/mfa" className="btn btn-primary btn-sm">
                Verify session
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  // ── The fill agent, on REAL visit rows (the board below is an illustration) ──
  // Both reads are RLS-scoped and degrade to nothing rather than taking the page down.
  const [openVisits, coverage] = await Promise.all([
    loadOpenVisits(),
    fillId ? loadCoveragePanel(fillId) : Promise.resolve(null),
  ]);

  const links = assignments.map((a) => ({ caregiverId: a.user_id, clientId: a.client_id }));
  const week = buildWeek({ now: new Date(), offset, caregivers, clients, assignments: links });
  const openShift = assignId ? findOpenShift(week, assignId) : undefined;
  const candidates = openShift ? rankCandidates(openShift, week, caregivers) : [];

  const subCounts: string[] = [];
  if (week.stats.open) subCounts.push(`${week.stats.open} open ${week.stats.open === 1 ? "shift" : "shifts"}`);
  if (week.stats.exceptions) subCounts.push(`${week.stats.exceptions} to review`);
  const sub = subCounts.length ? subCounts.join(" · ") : "All visits covered this week";

  return (
    <AppShell active="/schedule">
      <div className="rise">
        <PageHeader
          title="Schedule"
          sub={sub}
          actions={<WeekNav week={week} ctx={ctx} />}
        />

        <PreviewBanner />
        {flash === "preview-assign" && (
          <FlashBanner text="Preview only. Assignment not saved." />
        )}
        {flash && FILL_FLASH[flash] && <FlashBanner text={FILL_FLASH[flash]} />}

        {coverage && (
          <div className="mb-2">
            <CoveragePanel panel={coverage} ctx={ctx} />
          </div>
        )}
        {fillId && !coverage && (
          <div className="mb-8">
            <ErrorState
              title="That visit is not available"
              body="The visit could not be found on your account, or your session is no longer verified. Nothing was changed."
              retry={
                <Link href={href({ week: offset, filter })} className="btn btn-secondary btn-sm">
                  Back to the schedule
                </Link>
              }
            />
          </div>
        )}

        <section className="mb-8">
          <SectionTitle icon={<IconUsers width={16} height={16} />}>
            Live coverage · from the scheduling engine
          </SectionTitle>
          <CoverageRequests visits={openVisits} ctx={ctx} fillAction={runShiftFill} />
        </section>

        <ScheduleMetrics week={week} />

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <FilterTabs week={week} ctx={ctx} />
          <Legend />
        </div>

        {filter === "all" && (
          <>
            <section className="mb-8">
              <AttentionPanel week={week} ctx={ctx} />
            </section>
            <section>
              <SectionTitle icon={<IconCalendar width={16} height={16} />}>
                Week grid · by caregiver
              </SectionTitle>
              <WeekGrid week={week} ctx={ctx} />
            </section>
          </>
        )}

        {filter === "open" && (
          <section>
            <SectionTitle icon={<IconPlus width={16} height={16} />}>
              Open shifts · {week.stats.open}
            </SectionTitle>
            {week.stats.open === 0 ? (
              <EmptyState
                icon={<IconCalendar />}
                title="No open shifts this week"
                body="All visits have an assigned caregiver. Coverage gaps appear here."
              />
            ) : (
              <>
                <div className="mb-6">
                  <AttentionPanel week={week} ctx={ctx} />
                </div>
                <WeekGrid week={week} ctx={ctx} />
              </>
            )}
          </section>
        )}

        {filter === "exceptions" && (
          <section>
            <SectionTitle icon={<IconAlert width={16} height={16} />}>
              Exceptions · {week.stats.exceptions}
            </SectionTitle>
            {week.stats.exceptions === 0 ? (
              <EmptyState
                icon={<IconCalendar />}
                title="No exceptions this week"
                body="Lapsed credentials, coverage conflicts, and late notes appear here."
              />
            ) : (
              <ExceptionList week={week} ctx={ctx} />
            )}
          </section>
        )}
      </div>

      {openShift && (
        <AssignDrawer week={week} ctx={ctx} shift={openShift} candidates={candidates} assignAction={assignVisit} />
      )}
    </AppShell>
  );
}

/** Full exceptions list — the "review everything" view for the Exceptions filter. */
function ExceptionList({
  week,
  ctx,
}: {
  week: ReturnType<typeof buildWeek>;
  ctx: { offset: number; filter: string };
}) {
  const weekday = (d: number) => week.days[d]?.weekday ?? "";
  return (
    <div className="card stagger divide-y hairline overflow-hidden">
      {week.exceptions.map((v) => (
        <div key={v.id} className="flex items-center gap-3.5 px-5 py-4">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-[12px]"
            style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}
          >
            {v.exception?.kind === "credential" ? <IconLock width={18} height={18} /> : <IconAlert width={18} height={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">{v.exception?.detail}</p>
            <p className="tabular mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
              {v.clientName} · {weekday(v.day)} · {v.clientCity || "—"}
            </p>
          </div>
          <Link href={href({ week: ctx.offset, filter: "all" })} className="btn btn-secondary btn-sm shrink-0">
            View week
          </Link>
        </div>
      ))}
    </div>
  );
}
