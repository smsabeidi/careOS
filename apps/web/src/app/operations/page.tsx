import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Badge, DataTable, EmptyState, ErrorState, MetricTile, PageHeader } from "@/components/ui";
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconLock,
  IconX,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import {
  AGENCY_TZ,
  DOT,
  RESTRICTED,
  VerificationChip,
  VisitStatusChip,
  agencyDay,
  fmtMinutes,
  fmtTime,
  fmtWindow,
} from "./components";

export const metadata = { title: "Operations" };
export const dynamic = "force-dynamic";

/**
 * The live operations board (docs/17 §7.2 — `/operations`).
 *
 * What today looks like, from the two derived read models the verified-visit layer
 * publishes: `public.verified_visit` (the four status axes plus the clock ledger's
 * derived minutes) and `public.visit_exception_state` (current state = the latest
 * disposition). Both are `security_invoker` views, so RLS composes THROUGH them — this
 * page has no privileged read path and an unverified session sees nothing rather than
 * something (invariants 2, 3, 9).
 *
 * NOTHING ON THIS PAGE IS COMPUTED BY JUDGEMENT. Late minutes, verified minutes, missed
 * status and every exception are produced by the SQL engines in 0045–0047; the page
 * counts rows and picks words (invariant 13). The counters are therefore defensible to a
 * surveyor: each one is a filter over a column the database wrote.
 *
 * PHI (invariant 5, D-030): the view exposes `clock_in_distance_m` / `clock_out_distance_m`.
 * This page does not select them, does not receive them, and has no path that could render
 * a metre value or a coordinate. Client and caregiver names are refetched under RLS in a
 * second query; when RLS withholds one the row still renders, marked "(restricted)".
 */

/* ── Row shapes (explicit columns only; never select(*)) ────────────────────── */

/** Exactly the columns this board renders or counts — nothing wider is asked for, and
 *  the two distance columns the view also publishes are deliberately not among them. */
type VerifiedVisitRow = {
  visit_id: string;
  client_id: string;
  caregiver_id: string | null;
  status: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  verified_minutes: number | null;
  late_minutes: number | null;
  verification_status: string;
  had_offline_capture: boolean | null;
};

type ExceptionStateRow = {
  exception_id: string;
  visit_id: string;
  kind: string;
  severity: string;
  detected_at: string;
  open: boolean;
};

type ClientRow = { id: string; first_name: string; last_name: string };
type StaffRow = { id: string; full_name: string | null };

/**
 * The query window. Deliberately wider than a calendar day and then bucketed by the
 * agency's own date string: comparing `YYYY-MM-DD` in `America/New_York` is exact and
 * survives both DST changes and a server running in UTC, where a naive local-midnight
 * boundary would silently roll the board over at 8pm.
 */
const WINDOW_HOURS = 30;
const MAX_VISITS = 400;
/** Ceiling on the id list handed to the exception lookup — a bounded URL, always. */
const MAX_EXCEPTION_LOOKUP = 300;

export default async function OperationsPage() {
  await requirePerm("visit.verify.read");
  const supabase = await supabaseServer();

  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_HOURS * 3_600_000).toISOString();
  const to = new Date(now.getTime() + WINDOW_HOURS * 3_600_000).toISOString();
  const today = agencyDay(now.toISOString());

  const visitRes = await supabase
    .from("verified_visit")
    // One string literal, not a concatenation: supabase-js parses the select list at the
    // type level, and a computed string collapses every row to GenericStringError.
    .select(
      "visit_id, client_id, caregiver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, verified_minutes, late_minutes, verification_status, had_offline_capture"
    )
    .gte("scheduled_start", from)
    .lt("scheduled_start", to)
    .order("scheduled_start", { ascending: true })
    .limit(MAX_VISITS);

  const dayLabel = now.toLocaleDateString("en-US", {
    timeZone: AGENCY_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  if (visitRes.error) {
    return (
      <AppShell active="/operations">
        <div className="rise">
          <PageHeader title="Operations" sub={dayLabel} />
          <ErrorState
            title="Couldn't load today's board"
            body="Nothing was changed — every clock event, exception and approval is exactly where it was. Refresh to try again."
            retry={
              <Link href="/operations" className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const all = (visitRes.data ?? []) as VerifiedVisitRow[];
  const rows = all.filter((v) => agencyDay(v.scheduled_start) === today);

  // Degraded read: the whole verified-visit surface is AAL2-gated, so an unverified
  // session sees an empty list rather than an error. Say which one it is instead of
  // reporting a quiet day the agency did not have.
  if (rows.length === 0) {
    let aal2 = true;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = !data || data.currentLevel === "aal2";
    } catch {
      aal2 = true; // never block the board on an assurance-level probe
    }
    return (
      <AppShell active="/operations">
        <div className="rise">
          <PageHeader title="Operations" sub={dayLabel} />
          {aal2 ? (
            <EmptyState
              icon={<IconCalendar />}
              title="Nothing scheduled for today"
              body="Every visit scheduled for today appears here as it is worked — who is with whom, when they arrived, and anything the automatic checks want a person to look at. Schedule a visit and it shows up on this board."
              action={
                <Link href="/schedule" className="btn btn-primary btn-sm">
                  Open the schedule
                </Link>
              }
            />
          ) : (
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to see the board"
              body="The board names clients and caregivers, so it opens only on a verified (MFA) session. Today's visits are being recorded either way — you just can't see them from here yet."
              action={
                <Link href="/mfa" className="btn btn-primary btn-sm">
                  Verify session
                </Link>
              }
            />
          )}
        </div>
      </AppShell>
    );
  }

  /* ── Second pass: open findings, and the names behind the ids ───────────────
   * IDs travel; names are refetched under the reader's own RLS (invariant 5). A name
   * the policy withholds becomes "(restricted)" — the row still tells the truth about
   * the visit. */
  const visitIds = rows.slice(0, MAX_EXCEPTION_LOOKUP).map((v) => v.visit_id);
  const clientIds = [...new Set(rows.map((v) => v.client_id))];
  const caregiverIds = [...new Set(rows.map((v) => v.caregiver_id).filter((x): x is string => Boolean(x)))];

  const [exceptionRes, clientRes, staffRes] = await Promise.all([
    supabase
      .from("visit_exception_state")
      .select("exception_id, visit_id, kind, severity, detected_at, open")
      .in("visit_id", visitIds)
      .eq("open", true)
      .limit(600),
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as ClientRow[], error: null }),
    caregiverIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", caregiverIds)
      : Promise.resolve({ data: [] as StaffRow[], error: null }),
  ]);

  // A failed exception overlay degrades the board rather than taking it down: the visit
  // table is still true and useful, and the page says plainly what it could not load.
  const exceptionsUnavailable = Boolean(exceptionRes.error);
  const openExceptions = (exceptionRes.data ?? []) as ExceptionStateRow[];

  const openByVisit = new Map<string, ExceptionStateRow[]>();
  for (const e of openExceptions) {
    const list = openByVisit.get(e.visit_id) ?? [];
    list.push(e);
    openByVisit.set(e.visit_id, list);
  }

  const clientName = new Map(
    ((clientRes.data ?? []) as ClientRow[]).map((c) => [c.id, `${c.first_name} ${c.last_name}`])
  );
  const staffName = new Map(
    ((staffRes.data ?? []) as StaffRow[]).map((s) => [s.id, s.full_name ?? RESTRICTED])
  );

  /* ── Counters. Each one is a filter over a column the database wrote ──────── */

  const active = rows.filter((v) => v.status === "in_progress").length;
  const completed = rows.filter((v) => v.status === "completed").length;
  const missed = rows.filter((v) => v.status === "missed").length;
  // late_minutes is NULL — never 0 — when no arrival was recorded, so this counts
  // recorded late arrivals only, and never mistakes a no-show for an on-time visit.
  const lateStarts = rows.filter((v) => (v.late_minutes ?? 0) > 0).length;
  // A separate, equally factual observation: scheduled, past its start time, nothing
  // recorded. Not a threshold judgement — the policy's late threshold lives in SQL.
  const notStartedYet = rows.filter(
    (v) => v.status === "scheduled" && !v.actual_start && new Date(v.scheduled_start) < now
  ).length;
  const visitsWithFindings = rows.filter((v) => (openByVisit.get(v.visit_id)?.length ?? 0) > 0).length;
  const findingCount = openExceptions.length;
  const criticalCount = openExceptions.filter((e) => e.severity === "critical").length;

  const subParts = [dayLabel, `${rows.length} ${rows.length === 1 ? "visit" : "visits"}`];
  if (active) subParts.push(`${active} in progress`);
  const sub = subParts.join(DOT);

  return (
    <AppShell active="/operations">
      <div className="rise">
        <PageHeader
          title="Operations"
          sub={sub}
          actions={
            <Link href="/operations/exceptions" className="btn btn-secondary btn-sm">
              <IconAlert width={15} height={15} />
              Findings{findingCount ? ` · ${findingCount}` : ""}
            </Link>
          }
        />

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricTile
            label="In progress"
            value={active}
            tone="accent"
            icon={<IconClock />}
            hint={active ? "clocked in, not yet closed" : "nobody is clocked in"}
          />
          <MetricTile
            label="Completed"
            value={completed}
            tone="success"
            icon={<IconCheck />}
            hint={`of ${rows.length} scheduled`}
          />
          <MetricTile
            label="Late starts"
            value={lateStarts}
            tone="warning"
            icon={<IconClock />}
            hint={
              notStartedYet
                ? `${notStartedYet} past start, nothing recorded`
                : "arrivals after the scheduled time"
            }
          />
          <MetricTile
            label="Needs review"
            value={exceptionsUnavailable ? "—" : visitsWithFindings}
            tone="warning"
            icon={<IconAlert />}
            hint={
              exceptionsUnavailable
                ? "findings unavailable"
                : criticalCount
                  ? `${criticalCount} critical`
                  : findingCount
                    ? `${findingCount} open ${findingCount === 1 ? "finding" : "findings"}`
                    : "nothing open"
            }
          />
          <MetricTile
            label="Never started"
            value={missed}
            tone="danger"
            icon={<IconX />}
            hint={missed ? "marked missed by the checks" : "none today"}
          />
        </div>

        <p className="mb-6 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Every number here is counted from what the record already says: the clock ledger decides
          when a visit started, the automatic checks decide what was late, missed or overlapping, and
          this board only adds them up. Anything a person needs to decide sits in{" "}
          <Link href="/operations/exceptions" className="underline underline-offset-2" style={{ color: "var(--accent-text)" }}>
            findings
          </Link>
          .
        </p>

        {exceptionsUnavailable && (
          <div className="card mb-4 px-5 py-4" role="status">
            <p className="text-[14px] font-medium">Findings couldn&rsquo;t be loaded</p>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              The visit list below is complete and correct. What is missing is the &ldquo;needs
              review&rdquo; column — nothing was changed, and refreshing usually brings it back.
            </p>
          </div>
        )}

        <DataTable
          caption="Today's visits, in scheduled order"
          columns={[
            { header: "Caregiver" },
            { header: "Client" },
            { header: "Scheduled" },
            { header: "Recorded" },
            { header: "Status" },
            { header: <span className="sr-only">Review</span>, align: "right" },
          ]}
          rows={rows.map((v) => {
            const findings = openByVisit.get(v.visit_id) ?? [];
            const critical = findings.some((f) => f.severity === "critical");
            const caregiver = v.caregiver_id ? staffName.get(v.caregiver_id) ?? RESTRICTED : "Unassigned";
            const client = clientName.get(v.client_id) ?? RESTRICTED;

            return {
              key: v.visit_id,
              cells: [
                <span key="cg" className="font-medium">
                  {caregiver}
                </span>,
                <span key="cl">{client}</span>,
                <span key="sch" className="tabular whitespace-nowrap">
                  {fmtWindow(v.scheduled_start, v.scheduled_end)}
                </span>,
                <span key="act" className="tabular whitespace-nowrap">
                  {v.actual_start ? (
                    <>
                      {fmtTime(v.actual_start)}
                      {v.actual_end ? ` – ${fmtTime(v.actual_end)}` : " – open"}
                      {v.verified_minutes !== null && (
                        <span className="ml-1.5" style={{ color: "var(--text-muted)" }}>
                          {fmtMinutes(v.verified_minutes)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>Nothing recorded</span>
                  )}
                </span>,
                <span key="st" className="flex flex-wrap items-center gap-1.5">
                  <VisitStatusChip status={v.status} />
                  <VerificationChip status={v.verification_status} />
                  {(v.late_minutes ?? 0) > 0 && (
                    <Badge tone="warning" icon={<IconClock />}>
                      <span className="tabular">{v.late_minutes}</span>&nbsp;min late
                    </Badge>
                  )}
                  {/* §7.6: an offline replay is never presented as ordinarily verified. */}
                  {v.had_offline_capture && (
                    <Badge tone="neutral" icon={<IconClock />}>
                      Recorded offline
                    </Badge>
                  )}
                </span>,
                <span key="go" className="whitespace-nowrap">
                  {findings.length > 0 ? (
                    <Link
                      href={`/operations/exceptions?visit=${v.visit_id}`}
                      className="btn btn-secondary btn-sm"
                      aria-label={`Review ${findings.length} open ${findings.length === 1 ? "finding" : "findings"} on this visit`}
                    >
                      <IconAlert
                        width={14}
                        height={14}
                        style={critical ? { color: "var(--color-danger-700)" } : undefined}
                      />
                      Review · {findings.length}
                    </Link>
                  ) : (
                    <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                      —
                    </span>
                  )}
                </span>,
              ],
            };
          })}
        />

        <p className="mt-4 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Recorded times come from the clock ledger, which is append-only: a time that turns out to be
          wrong is corrected by adding the correction, never by rewriting what was recorded. Both stay
          on the visit.
        </p>
      </div>
    </AppShell>
  );
}
