import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Badge,
  EmptyState,
  ErrorState,
  MetricTile,
  PageHeader,
  Tabs,
  TintTile,
} from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconHistory,
  IconInbox,
  IconLock,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import {
  DOT,
  DispositionChip,
  RESTRICTED,
  SeverityChip,
  ageLabel,
  agencyDay,
  describeException,
  detectorLabel,
  fmtDay,
  fmtWindow,
  kindGroup,
  kindIcon,
  kindLabel,
} from "../components";
import { BAND_LABEL, rankAll, type RankInput, type UrgencyBand } from "./ranking";
import { DisposeControls } from "./dispose-controls";

export const metadata = { title: "Findings" };
export const dynamic = "force-dynamic";

/**
 * The exception inbox (docs/17 §7.2 — `/operations/exceptions`).
 *
 * Everything the automatic checks found, in the order a person should work it.
 *
 * THE ORDER IS ARITHMETIC. docs/17 §11 ratifies it: ranking is deterministic — severity,
 * recency, payroll impact and whether anyone has decided yet — and "the model only writes
 * the *why*". The whole ranking lives in ./ranking.ts as a pure function with named
 * weights, and this page calls it. No capability is invoked here, no model is consulted,
 * and no narration is fetched: a sibling slice owns that and will attach it to a row
 * without touching the order (invariant 13).
 *
 * A DECISION NEEDS A REASON, AND THE REASON IS ASKED FOR. `app.dispose_visit_exception`
 * refuses a blank reason with CAREOS_REASON_REQUIRED. The UI never lets a person meet
 * that refusal: choosing a decision opens the reason field first (./dispose-controls).
 *
 * Reads are RLS-composed all the way down: `visit_exception_state` and `verified_visit`
 * are both `security_invoker` views, and names are refetched under the reader's own
 * policies (invariant 5) — a name RLS withholds renders "(restricted)" rather than an id.
 *
 * PHI (D-030): `visit_exception.evidence` carries IDs and numbers only, and
 * `describeException` reads a closed allowlist of keys per kind. No coordinate and no
 * metre distance appears on this screen or in any link it builds.
 */

const LIMIT = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABS = [
  { key: "open", label: "Needs a decision" },
  { key: "decided", label: "Decided" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/* ── Row shapes (explicit columns only; never select(*)) ────────────────────── */

type ExceptionStateRow = {
  exception_id: string;
  visit_id: string;
  caregiver_id: string | null;
  kind: string;
  severity: string;
  detected_by: string;
  evidence: Record<string, unknown> | null;
  detected_at: string;
  latest_disposition_id: string | null;
  latest_disposition: string | null;
  disposed_by: string | null;
  disposed_at: string | null;
  open: boolean;
};

/** Only what a finding card shows, plus the one column the ranking reads
 *  (`approval_status` — is the money still movable). No distance column is requested. */
type VisitRow = {
  visit_id: string;
  client_id: string;
  caregiver_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  approval_status: string;
};

type DispositionRow = { id: string; exception_id: string; reason: string };
type ClientRow = { id: string; first_name: string; last_name: string };
type StaffRow = { id: string; full_name: string | null };

const BAND_TONE: Record<UrgencyBand, "danger" | "warning" | "neutral"> = {
  now: "danger",
  today: "warning",
  queued: "neutral",
};

function bandIcon(band: UrgencyBand) {
  return band === "now" ? <IconAlert /> : <IconClock />;
}

function href(tab: TabKey, visit?: string): string {
  const sp = new URLSearchParams();
  if (tab !== "open") sp.set("tab", tab);
  if (visit) sp.set("visit", visit);
  const q = sp.toString();
  return q ? `/operations/exceptions?${q}` : "/operations/exceptions";
}

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; visit?: string }>;
}) {
  const params = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === params.tab)?.key ?? "open") as TabKey;
  // Only an id ever travels in a URL, and only after it looks like one (invariant 5).
  const visitFilter = params.visit && UUID_RE.test(params.visit) ? params.visit : undefined;

  await requirePerm("visit.verify.read");
  const supabase = await supabaseServer();
  const now = new Date();

  let query = supabase
    .from("visit_exception_state")
    // One string literal, not a concatenation: supabase-js parses the select list at the
    // type level, and a computed string collapses every row to GenericStringError.
    .select(
      "exception_id, visit_id, caregiver_id, kind, severity, detected_by, evidence, detected_at, latest_disposition_id, latest_disposition, disposed_by, disposed_at, open"
    )
    .order("detected_at", { ascending: false })
    .limit(LIMIT);
  if (visitFilter) query = query.eq("visit_id", visitFilter);

  // `visit.verify.act` is a second, narrower key: plenty of people may read this queue
  // and not close anything. Asked once, here, so the row controls can say so honestly
  // rather than offering a button the RPC will refuse.
  const [findingRes, actRes] = await Promise.all([
    query,
    supabase.schema("app").rpc("has_perm", { p: "visit.verify.act" }),
  ]);

  if (findingRes.error) {
    return (
      <AppShell active="/operations">
        <div className="rise">
          <PageHeader title="Findings" sub="What the automatic checks want a person to look at" />
          <ErrorState
            title="Couldn't load the findings queue"
            body="Nothing was changed — every finding and every decision already recorded is exactly where it was. Refresh to try again."
            retry={
              <Link href={href(tab, visitFilter)} className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const findings = (findingRes.data ?? []) as ExceptionStateRow[];
  const canAct = actRes.data === true;

  // Degraded read: the queue is AAL2-gated, so an unverified session sees an empty list
  // rather than an error. Never report a clean board that is really a closed door.
  if (findings.length === 0) {
    let aal2 = true;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = !data || data.currentLevel === "aal2";
    } catch {
      aal2 = true; // never block the queue on an assurance-level probe
    }
    return (
      <AppShell active="/operations">
        <div className="rise">
          <PageHeader title="Findings" sub="What the automatic checks want a person to look at" />
          {aal2 ? (
            <EmptyState
              icon={<IconCheck />}
              title={visitFilter ? "Nothing flagged on that visit" : "Nothing needs a decision"}
              body={
                visitFilter
                  ? "The automatic checks have not raised anything on this visit. If that looks wrong, clear the filter to see the whole queue."
                  : "When a visit is never started or never closed, when two visits overlap, when the place of care can't be confirmed, or when a time is corrected by hand, it lands here with what the checks actually saw. Nothing is closed without a person and a reason."
              }
              action={
                visitFilter ? (
                  <Link href={href(tab)} className="btn btn-secondary btn-sm">
                    Show all findings
                  </Link>
                ) : (
                  <Link href="/operations" className="btn btn-secondary btn-sm">
                    Back to the board
                  </Link>
                )
              }
            />
          ) : (
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to see findings"
              body="Findings name the visit and the people on it, so they open only on a verified (MFA) session. The checks keep running either way — nothing is being missed while you verify."
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

  /* ── Second pass: the visits behind the findings, the words behind the
   *    decisions, and the names behind the ids ─────────────────────────────── */

  const visitIds = [...new Set(findings.map((f) => f.visit_id))];
  const dispositionIds = findings
    .map((f) => f.latest_disposition_id)
    .filter((x): x is string => Boolean(x));

  const [visitRes, reasonRes] = await Promise.all([
    supabase
      .from("verified_visit")
      .select("visit_id, client_id, caregiver_id, scheduled_start, scheduled_end, approval_status")
      .in("visit_id", visitIds)
      .limit(LIMIT),
    dispositionIds.length
      ? supabase
          .from("visit_exception_disposition")
          .select("id, exception_id, reason")
          .in("id", dispositionIds)
          .limit(LIMIT)
      : Promise.resolve({ data: [] as DispositionRow[], error: null }),
  ]);

  const visits = new Map(((visitRes.data ?? []) as VisitRow[]).map((v) => [v.visit_id, v]));
  const reasonByException = new Map(
    ((reasonRes.data ?? []) as DispositionRow[]).map((d) => [d.exception_id, d.reason])
  );

  const clientIds = [...new Set([...visits.values()].map((v) => v.client_id))];
  const staffIds = [
    ...new Set(
      [
        ...findings.map((f) => f.caregiver_id),
        ...findings.map((f) => f.disposed_by),
        ...[...visits.values()].map((v) => v.caregiver_id),
      ].filter((x): x is string => Boolean(x))
    ),
  ];

  const [clientRes, staffRes] = await Promise.all([
    clientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as ClientRow[], error: null }),
    staffIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as StaffRow[], error: null }),
  ]);

  const clientName = new Map(
    ((clientRes.data ?? []) as ClientRow[]).map((c) => [c.id, `${c.first_name} ${c.last_name}`])
  );
  const staffName = new Map(
    ((staffRes.data ?? []) as StaffRow[]).map((s) => [s.id, s.full_name ?? RESTRICTED])
  );

  /* ── The deterministic ranking (./ranking.ts). No model, no judgement ─────── */

  const rankInputs: (RankInput & { row: ExceptionStateRow })[] = findings.map((f) => ({
    exceptionId: f.exception_id,
    kind: f.kind,
    severity: f.severity,
    detectedAt: f.detected_at,
    open: f.open,
    latestDisposition: f.latest_disposition,
    // Null when the visit row is not visible to this reader — the ranking then treats
    // pay as unknown rather than settled, which errs toward showing the finding sooner.
    approvalStatus: visits.get(f.visit_id)?.approval_status ?? null,
    row: f,
  }));

  const ranked = rankAll(rankInputs, now);
  const shown = ranked.filter((r) => (tab === "open" ? r.open : !r.open));

  const openCount = ranked.filter((r) => r.open).length;
  const decidedCount = ranked.length - openCount;
  const criticalOpen = ranked.filter((r) => r.open && r.severity === "critical").length;
  const oldestOpen = ranked
    .filter((r) => r.open)
    .reduce<string | null>(
      (oldest, r) => (!oldest || new Date(r.detectedAt) < new Date(oldest) ? r.detectedAt : oldest),
      null
    );
  // "Today" is the agency's calendar day, not the server's — the same rule the board uses.
  const todayStr = agencyDay(now.toISOString());
  const decidedToday = ranked.filter(
    (r) => !r.open && r.row.disposed_at && agencyDay(r.row.disposed_at) === todayStr
  ).length;

  /* ── Grouped by kind, groups ordered by their most urgent member ──────────── */

  const groups = new Map<string, typeof shown>();
  for (const item of shown) {
    const g = kindGroup(item.kind);
    const list = groups.get(g) ?? [];
    list.push(item);
    groups.set(g, list);
  }
  const orderedGroups = [...groups.entries()].sort(
    (a, b) => (b[1][0]?.rank.score ?? 0) - (a[1][0]?.rank.score ?? 0)
  );

  const sub = openCount
    ? `${openCount} ${openCount === 1 ? "finding needs" : "findings need"} a decision`
    : "Nothing is waiting for a decision";

  return (
    <AppShell active="/operations">
      <div className="rise">
        <PageHeader
          title="Findings"
          sub={sub}
          actions={
            <Link href="/operations" className="btn btn-secondary btn-sm">
              <IconClock width={15} height={15} />
              Today&rsquo;s board
            </Link>
          }
        />

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile
            label="Needs a decision"
            value={openCount}
            tone="warning"
            icon={<IconInbox />}
            hint={openCount ? "nobody has decided yet" : "queue is clear"}
          />
          <MetricTile
            label="Critical"
            value={criticalOpen}
            tone="danger"
            icon={<IconAlert />}
            hint={criticalOpen ? "open and serious" : "none open"}
          />
          <MetricTile
            label="Oldest open"
            value={oldestOpen ? ageLabel(oldestOpen, now) : "—"}
            tone="neutral"
            icon={<IconHistory />}
            hint={oldestOpen ? "since it was found" : "nothing waiting"}
          />
          <MetricTile
            label="Decided today"
            value={decidedToday}
            tone="success"
            icon={<IconCheck />}
            hint={decidedCount ? `${decidedCount} on record` : "none yet"}
          />
        </div>

        <p className="mb-6 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          The order is worked out, not guessed: how serious the finding is, how recently it was found,
          whether it stands between delivered work and a correct paycheque, and whether anyone has
          decided on it yet. Each card says why it sits where it does. Closing one takes a person and a
          reason — the reason is the record.
        </p>

        {visitFilter && (
          <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <p className="text-[13px]">Showing findings on one visit only.</p>
            <Link href={href(tab)} className="btn btn-white btn-sm">
              Show all findings
            </Link>
          </div>
        )}

        <div className="mb-4">
          <Tabs
            label="Finding state"
            active={href(tab, visitFilter)}
            items={TABS.map((t) => ({
              href: href(t.key, visitFilter),
              label: t.label,
              count: t.key === "open" ? openCount : decidedCount,
            }))}
          />
        </div>

        {shown.length === 0 ? (
          tab === "open" ? (
            <EmptyState
              icon={<IconCheck />}
              title="Nothing needs a decision"
              body="Every finding the checks raised has been acknowledged, resolved, dismissed or escalated by a person, with their reason on the record. New findings arrive here as the checks run."
              action={
                decidedCount ? (
                  <Link href={href("decided", visitFilter)} className="btn btn-secondary btn-sm">
                    See what was decided
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              icon={<IconHistory />}
              title="Nothing decided yet"
              body="Once someone acknowledges, resolves, dismisses or escalates a finding, it moves here with their reason and their name attached. Nothing is ever deleted — a decision is added, never written over."
            />
          )
        ) : (
          <div className="flex flex-col gap-8">
            {orderedGroups.map(([group, items]) => (
              <section key={group}>
                <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold tracking-[-0.01em]">
                  {group}
                  <span className="tabular text-[13px] font-normal" style={{ color: "var(--text-muted)" }}>
                    {items.length}
                  </span>
                </h2>
                <div className="stagger flex flex-col gap-3">
                  {items.map((item) => {
                    const f = item.row;
                    const visit = visits.get(f.visit_id);
                    const client = visit ? clientName.get(visit.client_id) ?? RESTRICTED : RESTRICTED;
                    const caregiverId = f.caregiver_id ?? visit?.caregiver_id ?? null;
                    const caregiver = caregiverId ? staffName.get(caregiverId) ?? RESTRICTED : "Unassigned";
                    const decidedBy = f.disposed_by ? staffName.get(f.disposed_by) ?? RESTRICTED : null;
                    const reason = reasonByException.get(f.exception_id);

                    return (
                      <article key={f.exception_id} className="card px-5 py-4">
                        <div className="flex items-start gap-3.5">
                          <TintTile
                            icon={kindIcon(f.kind)}
                            size={40}
                            tone={f.severity === "critical" ? "danger" : f.severity === "warning" ? "warning" : "neutral"}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-[15px] font-semibold">{kindLabel(f.kind)}</h3>
                              <SeverityChip severity={f.severity} />
                              {f.open ? (
                                <Badge tone={BAND_TONE[item.rank.band]} icon={bandIcon(item.rank.band)}>
                                  {BAND_LABEL[item.rank.band]}
                                </Badge>
                              ) : (
                                <DispositionChip disposition={f.latest_disposition ?? ""} />
                              )}
                            </div>

                            <p className="mt-1.5 text-[14px] leading-relaxed">
                              {describeException(f.kind, f.evidence)}
                            </p>

                            <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                              <span className="font-medium">{client}</span>
                              {DOT}
                              {visit ? fmtDay(visit.scheduled_start) : "date unavailable"}
                              {DOT}
                              <span className="tabular">
                                {visit ? fmtWindow(visit.scheduled_start, visit.scheduled_end) : "—"}
                              </span>
                              {DOT}
                              {caregiver}
                            </p>

                            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                              Found by {detectorLabel(f.detected_by)} {ageLabel(f.detected_at, now)}
                              {DOT}
                              {item.rank.explanation}
                            </p>

                            {!f.open && decidedBy && (
                              <div className="mt-2.5 rounded-[var(--radius-md)] px-3.5 py-2.5" style={{ background: "var(--color-surface-100)" }}>
                                <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                                  {decidedBy}
                                  {f.disposed_at ? `${DOT}${ageLabel(f.disposed_at, now)}` : ""}
                                </p>
                                {reason && <p className="mt-1 text-[13px] leading-relaxed">{reason}</p>}
                              </div>
                            )}

                            {/* Only an id travels here, and only when it would change
                                what is on screen (invariant 5: IDs travel, content is
                                refetched under RLS on arrival). */}
                            {!visitFilter && (
                              <p className="mt-2 text-[12px]">
                                <Link
                                  href={href(tab, f.visit_id)}
                                  className="underline underline-offset-2"
                                  style={{ color: "var(--accent-text)" }}
                                >
                                  Everything flagged on this visit
                                </Link>
                              </p>
                            )}

                            <DisposeControls exceptionId={f.exception_id} canAct={canAct} open={f.open} />
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {findings.length >= LIMIT && (
          <p className="mt-6 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Showing the {LIMIT} most recently found. Work the queue down and older findings appear here.
          </p>
        )}
      </div>
    </AppShell>
  );
}
