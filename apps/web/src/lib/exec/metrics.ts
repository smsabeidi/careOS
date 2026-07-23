/**
 * Exec command-center metrics — all figures are REAL, queried as the signed-in owner
 * (RLS-scoped; no privileged retrieval). Aggregation happens server-side; only counts and
 * shapes cross to the client. No PHI names/DOBs are selected for aggregates (minimized);
 * the activity feed reuses the same authorized joins the rest of the app uses.
 *
 * Anything the platform hasn't built yet (COMAR cadence deadlines, EVV, credential expiries)
 * is surfaced as an honest not-yet state by the UI — never fabricated here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Types (the contract every exec widget renders from) ── */
export type CensusBucket = { key: string; label: string; count: number };
export type TrendPoint = { label: string; ym: string; count: number };
export type RoleCount = { key: string; label: string; count: number };
export type AttentionItem = {
  key: string;
  count: number;
  headline: string;
  detail: string;
  href: string;
  tone: "accent" | "warning" | "danger" | "success";
};
export type RecentItem = {
  id: string;
  status: string;
  updatedAt: string;
  title: string;
  clientName: string | null;
};

export type ExecMetrics = {
  agencyName: string;
  census: {
    total: number;
    inService: number; // active + on_hold
    buckets: CensusBucket[]; // ordered active → discharged
    active: number;
    pending: number;
    onHold: number;
    inquiry: number;
    discharged: number;
  };
  payerMix: CensusBucket[]; // among in-service clients, desc by count
  language: { en: number; es: number; other: number; esPct: number };
  admissions: TrendPoint[]; // last 12 months, oldest → newest
  workforce: {
    total: number;
    separated: number;
    byRole: RoleCount[];
  };
  coverage: {
    inService: number;
    withCaregiver: number;
    withoutCaregiver: number;
    withRn: number;
    withoutRn: number;
    caregiversWithLoad: number;
    avgCaregiverLoad: number;
    maxCaregiverLoad: number;
    rnsWithLoad: number;
    avgRnLoad: number;
  };
  docs: {
    total: number;
    final: number;
    draft: number;
    inReview: number;
    signatures: number;
    aal2Signatures: number;
    corrections: number;
  };
  attention: AttentionItem[]; // prioritized; empty ⇒ all clear
  recent: RecentItem[];
};

/* ── helpers ── */
function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
const ORDER: Record<string, { label: string; rank: number }> = {
  active: { label: "Active", rank: 0 },
  on_hold: { label: "On hold", rank: 1 },
  pending_admission: { label: "Pending admission", rank: 2 },
  inquiry: { label: "Inquiry", rank: 3 },
  discharged: { label: "Discharged", rank: 4 },
};
const PAYER_LABEL: Record<string, string> = {
  private: "Private pay",
  medicaid: "Medicaid",
  ltc_insurance: "LTC insurance",
  va: "VA",
  other: "Other",
};
const ROLE_LABEL: Record<string, { label: string; rank: number }> = {
  rn: { label: "Nurses (RN)", rank: 0 },
  caregiver: { label: "Caregivers", rank: 1 },
  coordinator: { label: "Coordinators", rank: 2 },
  hr: { label: "HR", rank: 3 },
  admin: { label: "Administrators", rank: 4 },
  owner: { label: "Owner", rank: 5 },
};

function count(res: { count: number | null } | null): number {
  return res?.count ?? 0;
}

/** Build the trailing 12 calendar months (oldest → newest) as YYYY-MM buckets. */
function lastTwelveMonths(): { ym: string; label: string }[] {
  const out: { ym: string; label: string }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ ym, label: d.toLocaleDateString(undefined, { month: "short" }) });
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getExecMetrics(
  supabase: SupabaseClient,
  greetingName?: string,
): Promise<ExecMetrics> {
  void greetingName;
  const [
    tenantRes,
    clientsRes,
    staffRes,
    rolesRes,
    assignRes,
    finalC,
    draftC,
    staleDraftC,
    reviewC,
    instTotalC,
    sigTotalC,
    sigAal2C,
    corrC,
    recentRes,
  ] = await Promise.all([
    supabase.from("tenant").select("name").limit(1).maybeSingle(),
    supabase.from("client").select("status, payer_type, primary_language, admitted_on"),
    supabase.from("app_user").select("id, status, separated_at").eq("kind", "staff"),
    supabase.from("user_role").select("user_id, role(key)"),
    supabase.from("care_team_assignment").select("client_id, user_id, role_on_case").is("ends_on", null),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "final"),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "draft"),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "draft")
      .lt("updated_at", new Date(Date.now() - 7 * 864e5).toISOString()),
    supabase.from("form_instance").select("id", { count: "exact", head: true }).eq("status", "in_review"),
    supabase.from("form_instance").select("id", { count: "exact", head: true }),
    supabase.from("signature").select("id", { count: "exact", head: true }),
    supabase.from("signature").select("id", { count: "exact", head: true }).eq("session_aal", "aal2"),
    supabase.from("form_version").select("id", { count: "exact", head: true }).eq("kind", "correction"),
    supabase
      .from("form_instance")
      .select("id, status, updated_at, form_template(title), client(first_name, last_name)")
      .order("updated_at", { ascending: false })
      .limit(8),
  ]);

  const clients = (clientsRes.data ?? []) as any[];
  const staff = (staffRes.data ?? []) as any[];
  const roleRows = (rolesRes.data ?? []) as any[];
  const assigns = (assignRes.data ?? []) as any[];

  /* ── Census ── */
  const statusCounts = new Map<string, number>();
  for (const c of clients) statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1);
  const buckets: CensusBucket[] = Object.keys(ORDER)
    .map((k) => ({ key: k, label: ORDER[k].label, count: statusCounts.get(k) ?? 0 }))
    .sort((a, b) => ORDER[a.key].rank - ORDER[b.key].rank);
  const active = statusCounts.get("active") ?? 0;
  const onHold = statusCounts.get("on_hold") ?? 0;
  const pending = statusCounts.get("pending_admission") ?? 0;
  const inquiry = statusCounts.get("inquiry") ?? 0;
  const discharged = statusCounts.get("discharged") ?? 0;
  const inService = active + onHold;

  /* ── Payer mix (in-service clients) ── */
  const payerCounts = new Map<string, number>();
  for (const c of clients) {
    if (c.status !== "active" && c.status !== "on_hold") continue;
    const key = c.payer_type ?? "other";
    payerCounts.set(key, (payerCounts.get(key) ?? 0) + 1);
  }
  const payerMix: CensusBucket[] = [...payerCounts.entries()]
    .map(([key, count]) => ({ key, label: PAYER_LABEL[key] ?? key, count }))
    .sort((a, b) => b.count - a.count);

  /* ── Language (in-service) ── */
  let en = 0, es = 0, otherLang = 0;
  for (const c of clients) {
    if (c.status !== "active" && c.status !== "on_hold") continue;
    if (c.primary_language === "es") es++;
    else if (c.primary_language === "en" || !c.primary_language) en++;
    else otherLang++;
  }
  const langTotal = en + es + otherLang || 1;

  /* ── Admissions trend (last 12 months) ── */
  const months = lastTwelveMonths();
  const monthIndex = new Map(months.map((m, i) => [m.ym, i]));
  const admissions: TrendPoint[] = months.map((m) => ({ label: m.label, ym: m.ym, count: 0 }));
  for (const c of clients) {
    if (!c.admitted_on) continue;
    const ym = String(c.admitted_on).slice(0, 7);
    const idx = monthIndex.get(ym);
    if (idx !== undefined) admissions[idx].count++;
  }

  /* ── Workforce by role (active staff only; "active team members" must mean active) ── */
  const activeStaff = staff.filter((s) => s.status === "active" && !s.separated_at);
  const staffIds = new Set(activeStaff.map((s) => s.id));
  const roleCounts = new Map<string, number>();
  for (const r of roleRows) {
    if (!staffIds.has(r.user_id)) continue;
    const role = pickOne<{ key: string }>(r.role);
    if (!role?.key) continue;
    roleCounts.set(role.key, (roleCounts.get(role.key) ?? 0) + 1);
  }
  const byRole: RoleCount[] = [...roleCounts.entries()]
    .filter(([k]) => ROLE_LABEL[k])
    .map(([k, count]) => ({ key: k, label: ROLE_LABEL[k].label, count }))
    .sort((a, b) => ROLE_LABEL[a.key].rank - ROLE_LABEL[b.key].rank);
  const separated = staff.length - activeStaff.length;

  /* ── Coverage & caseload ── */
  const caregiverClients = new Set<string>();
  const rnClients = new Set<string>();
  const caregiverLoad = new Map<string, number>();
  const rnLoad = new Map<string, number>();
  for (const a of assigns) {
    if (a.role_on_case === "caregiver") {
      caregiverClients.add(a.client_id);
      caregiverLoad.set(a.user_id, (caregiverLoad.get(a.user_id) ?? 0) + 1);
    } else if (a.role_on_case === "rn_case_manager") {
      rnClients.add(a.client_id);
      rnLoad.set(a.user_id, (rnLoad.get(a.user_id) ?? 0) + 1);
    }
  }
  const cgLoads = [...caregiverLoad.values()];
  const rnLoads = [...rnLoad.values()];
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  /* ── Documentation & integrity ── */
  const docs = {
    total: count(instTotalC),
    final: count(finalC),
    draft: count(draftC),
    inReview: count(reviewC),
    signatures: count(sigTotalC),
    aal2Signatures: count(sigAal2C),
    corrections: count(corrC),
  };

  /* ── Attention queue (exceptions first; only non-zero; ranked) ──
     Note: draft count alone is not an exception (in-progress work is normal); only drafts
     idle > 7 days are surfaced. Attention reflects live work-STATES, not COMAR due-dates. */
  const staleDrafts = count(staleDraftC);
  const attentionRaw: (AttentionItem & { rank: number })[] = [
    {
      key: "rn_queue",
      count: docs.inReview,
      headline: `${docs.inReview} ${docs.inReview === 1 ? "assessment is" : "assessments are"} waiting for a nurse's signature`,
      detail: "Drafted and in review — finalize to lock them on the record.",
      href: "/clinical",
      tone: "accent",
      rank: 1,
    },
    {
      key: "pending",
      count: pending,
      headline: `${pending} ${pending === 1 ? "person is" : "people are"} pending admission`,
      detail: "Awaiting the paperwork and assignment that starts their care.",
      href: "/office/clients?status=pending_admission",
      tone: "warning",
      rank: 2,
    },
    {
      key: "on_hold",
      count: onHold,
      headline: `${onHold} ${onHold === 1 ? "client is" : "clients are"} on hold`,
      detail: "Care is paused — review whether it should resume or discharge.",
      href: "/office/clients?status=on_hold",
      tone: "warning",
      rank: 3,
    },
    {
      key: "stale_drafts",
      count: staleDrafts,
      headline: `${staleDrafts} visit ${staleDrafts === 1 ? "note has" : "notes have"} sat unfinished for over a week`,
      detail: "Saved and safe, but stalled — a gentle nudge may help close them out.",
      href: "/office/forms",
      tone: "warning",
      rank: 4,
    },
    {
      key: "inquiry",
      count: inquiry,
      headline: `${inquiry} new ${inquiry === 1 ? "inquiry hasn't" : "inquiries haven't"} entered intake yet`,
      detail: "New leads waiting for a first follow-up.",
      href: "/office/clients?status=inquiry",
      tone: "accent",
      rank: 5,
    },
  ];
  const attention: AttentionItem[] = attentionRaw
    .filter((a) => a.count > 0)
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank, ...rest }) => { void rank; return rest; });

  /* ── Recent activity ── */
  const recent: RecentItem[] = ((recentRes.data ?? []) as any[]).map((f) => {
    const t = pickOne<{ title: string }>(f.form_template);
    const c = pickOne<{ first_name: string; last_name: string }>(f.client);
    return {
      id: f.id,
      status: f.status,
      updatedAt: f.updated_at,
      title: t?.title ?? "Record",
      clientName: c ? `${c.first_name} ${c.last_name}` : null,
    };
  });

  return {
    agencyName: (tenantRes.data as any)?.name ?? "your agency",
    census: {
      total: clients.length,
      inService,
      buckets,
      active,
      pending,
      onHold,
      inquiry,
      discharged,
    },
    payerMix,
    language: { en, es, other: otherLang, esPct: Math.round((es / langTotal) * 100) },
    admissions,
    workforce: { total: activeStaff.length, separated, byRole },
    coverage: {
      inService,
      withCaregiver: caregiverClients.size,
      withoutCaregiver: Math.max(0, inService - caregiverClients.size),
      withRn: rnClients.size,
      withoutRn: Math.max(0, inService - rnClients.size),
      caregiversWithLoad: cgLoads.length,
      avgCaregiverLoad: Math.round(avg(cgLoads) * 10) / 10,
      maxCaregiverLoad: cgLoads.length ? Math.max(...cgLoads) : 0,
      rnsWithLoad: rnLoads.length,
      avgRnLoad: Math.round(avg(rnLoads) * 10) / 10,
    },
    docs,
    attention,
    recent,
  };
}
