import Link from "next/link";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell";
import { Badge, EmptyState, ErrorState, PageHeader, SectionTitle, Tabs } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconHistory,
  IconLock,
  IconMapPin,
  IconPen,
  IconShield,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import { PolicyForm } from "./policy-form";
import { saveVisitPolicy } from "./actions";
import {
  POLICY_BASELINE,
  POLICY_FIELDS,
  POLICY_GROUPS,
  displayPolicyValue,
  type PolicyField,
  type PolicySettingKey,
} from "./policy-fields";

export const metadata = { title: "Visit policy" };
export const dynamic = "force-dynamic";

/**
 * The visit-policy editor — docs/17 §3.4, §4.2, §6.2, migration 0044.
 *
 * A policy row is the set of rules a visit is measured against: how close counts as
 * arrived, how late is late, what has to be written down, how minutes become pay. Two
 * properties of that table decide the whole shape of this screen:
 *
 *  1. **It is append-only.** `visit_policy` has no UPDATE and no DELETE grant. Saving
 *     appends the next version with `supersedes_id` pointing at the one it replaces, and
 *     the replaced version stays readable forever — because a visit already measured
 *     against it has to keep meaning what it meant (invariant 1, D-014's binding
 *     precedent). Nothing in this UI says "edit" or "update", because nothing does.
 *  2. **Values are resolved up a ladder.** client → service_type → payer_kind → program →
 *     tenant, most specific wins. `app.visit_policy_chain` computes it in SQL and is
 *     deliberately not granted to a session, so the preview below rebuilds the same
 *     selection from the rows themselves: for each rung, the highest version actually in
 *     force at this instant. The rows are the source; this is a reading of them.
 *
 * Not PHI: a policy row carries no client, no caregiver and no coordinate. Client and
 * service-type NAMES are, so they are refetched under RLS and render "(restricted)" when a
 * policy exists for a record the reader cannot see.
 *
 * Regulatory posture (docs/17 §3.4, D-017): every number here is this agency's operating
 * choice. No COMAR provision and no federal EVV rule sets a geofence radius, a grace
 * period or a rounding increment. The copy says so where an author will read it, so
 * nothing on this screen can be shown to a surveyor as a requirement.
 */

const AGENCY_TZ = "America/New_York";

const SCOPE_TABS = [
  { key: "tenant", label: "Agency default" },
  { key: "payer_kind", label: "Payer kind" },
  { key: "service_type", label: "Service type" },
  { key: "client", label: "Client" },
] as const;
type ScopeKind = (typeof SCOPE_TABS)[number]["key"];

const PAYER_KINDS: { value: string; label: string }[] = [
  { value: "medicaid", label: "Medicaid" },
  { value: "medicare", label: "Medicare" },
  { value: "private", label: "Private pay" },
  { value: "waiver", label: "Waiver" },
  { value: "other", label: "Other payer" },
];
const PAYER_LABEL = new Map(PAYER_KINDS.map((p) => [p.value, p.label]));

/* ── Row shapes (explicit columns only; never select(*)) ───────────────────── */

type PolicyRow = {
  id: string;
  scope_kind: string;
  scope_id: string | null;
  scope_value: string | null;
  version_no: number;
  effective_from: string;
  effective_until: string | null;
  geofence_tier: string;
  geofence_radius_m: number;
  max_accuracy_m: number;
  require_clock_in_location: boolean;
  require_clock_out_location: boolean;
  allow_location_exception: boolean;
  early_clock_in_minutes: number;
  late_threshold_minutes: number;
  clock_out_grace_minutes: number;
  missing_clock_out_minutes: number;
  missed_visit_minutes: number;
  max_visit_minutes: number;
  require_visit_note: boolean;
  require_task_completion: boolean;
  signature_requirement: string;
  rounding_policy: string;
  overtime_weekly_minutes: number;
  impossible_travel_kmh: number;
  supersedes_id: string | null;
  change_reason: string | null;
  created_by: string;
  created_at: string;
};

const POLICY_COLUMNS =
  "id, scope_kind, scope_id, scope_value, version_no, effective_from, effective_until, " +
  "geofence_tier, geofence_radius_m, max_accuracy_m, require_clock_in_location, " +
  "require_clock_out_location, allow_location_exception, early_clock_in_minutes, " +
  "late_threshold_minutes, clock_out_grace_minutes, missing_clock_out_minutes, " +
  "missed_visit_minutes, max_visit_minutes, require_visit_note, require_task_completion, " +
  "signature_requirement, rounding_policy, overtime_weekly_minutes, impossible_travel_kmh, " +
  "supersedes_id, change_reason, created_by, created_at";

type ServiceTypeRow = { id: string; code: string; name: string; payer_kind: string; active: boolean };
type ClientRow = { id: string; first_name: string; last_name: string; status: string };

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function fmtStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: AGENCY_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The rung winner: the highest version of one scope actually in force at `now`.
 * This mirrors `app.visit_policy_chain`'s DISTINCT ON — a version superseded by a
 * scheduled-ahead one still governs until that one starts.
 */
function inForce(rows: PolicyRow[], kind: string, id: string | null, value: string | null, now: number): PolicyRow | null {
  const candidates = rows.filter(
    (r) =>
      r.scope_kind === kind &&
      (r.scope_id ?? null) === id &&
      (r.scope_value ?? null) === value &&
      new Date(r.effective_from).getTime() <= now &&
      (!r.effective_until || new Date(r.effective_until).getTime() > now)
  );
  candidates.sort(
    (a, b) => b.version_no - a.version_no || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  return candidates[0] ?? null;
}

function valueOf(row: PolicyRow, key: PolicySettingKey): string | number | boolean {
  return row[key];
}

/* ── Small server-rendered pieces ──────────────────────────────────────────── */

function FieldInput({ field, value }: { field: PolicyField; value: string | number | boolean }) {
  const id = `f_${field.key}`;
  const help = `${id}_help`;
  return (
    <div>
      <label className="label" htmlFor={id}>
        {field.label}
      </label>
      {field.kind === "bool" ? (
        <select id={id} name={field.key} defaultValue={value === true ? "true" : "false"} aria-describedby={help} className="select">
          <option value="true">{field.trueLabel}</option>
          <option value="false">{field.falseLabel}</option>
        </select>
      ) : field.kind === "enum" ? (
        <select id={id} name={field.key} defaultValue={String(value)} aria-describedby={help} className="select">
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex items-center gap-2">
          <input
            id={id}
            name={field.key}
            type="number"
            inputMode="numeric"
            step={1}
            min={field.min}
            max={field.max}
            defaultValue={String(value)}
            aria-describedby={help}
            required
            className="input tabular w-32"
          />
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            {field.unit}
          </span>
        </div>
      )}
      <p id={help} className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {field.help}
      </p>
    </div>
  );
}

function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="card-inset px-5 py-4">
      <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {children}
      </p>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function VisitPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; id?: string; value?: string }>;
}) {
  const params = await searchParams;
  const scope: ScopeKind = (SCOPE_TABS.find((t) => t.key === params.scope)?.key ?? "tenant") as ScopeKind;
  const targetId = typeof params.id === "string" && params.id.trim() ? params.id.trim() : null;
  const targetValue =
    scope === "payer_kind" && PAYER_LABEL.has(String(params.value)) ? String(params.value) : null;

  await requirePerm("policy.manage");
  const supabase = await supabaseServer();

  // Three reads rather than one, because the tenant floor is the row that must never be
  // the one a LIMIT drops: without it there is no policy at all (§4.2 makes its absence an
  // error, not a degraded answer), and client-scope rows are the ones that multiply. So the
  // floor is fetched on its own, the rest is fetched with the most-specific scopes ordered
  // last, and the scope actually being looked at is fetched targeted so its own history is
  // complete no matter how large the middle query gets.
  // The tenant scope needs no targeted read — the floor query below IS its whole history.
  const scopeTarget = scope === "payer_kind" ? targetValue : targetId;
  const scopedQuery =
    scope === "tenant" || !scopeTarget
      ? null
      : scope === "payer_kind"
        ? supabase
            .from("visit_policy")
            .select(POLICY_COLUMNS)
            .eq("scope_kind", scope)
            .is("scope_id", null)
            .eq("scope_value", scopeTarget)
            .limit(100)
        : supabase
            .from("visit_policy")
            .select(POLICY_COLUMNS)
            .eq("scope_kind", scope)
            .eq("scope_id", scopeTarget)
            .is("scope_value", null)
            .limit(100);

  const [floorRes, otherRes, scopedRes, serviceTypeRes] = await Promise.all([
    supabase.from("visit_policy").select(POLICY_COLUMNS).eq("scope_kind", "tenant").limit(100),
    supabase
      .from("visit_policy")
      .select(POLICY_COLUMNS)
      .neq("scope_kind", "tenant")
      // Descending puts service_type/program/payer_kind ahead of client, so the rungs a
      // ladder needs survive a truncation and the long tail of per-client rows does not.
      .order("scope_kind", { ascending: false })
      .order("version_no", { ascending: false })
      .limit(800),
    scopedQuery ?? Promise.resolve({ data: [], error: null }),
    supabase
      .from("service_type")
      .select("id, code, name, payer_kind, active")
      .order("name", { ascending: true })
      .limit(200),
  ]);

  // All three reads are fatal. The floor's failure means there is no policy to show at all;
  // the other two would quietly hide rows, and a ladder missing a rung is worse than a
  // screen that admits it could not be read.
  const readError = floorRes.error ?? otherRes.error ?? scopedRes.error;

  const header = <PageHeader title="Visit policy" sub="The rules every visit is measured against" />;

  if (readError) {
    return (
      <AppShell active="/settings/visit-policy">
        <div className="rise">
          {header}
          <ErrorState
            title="Couldn't load the visit policy"
            body="Nothing was changed. The rules currently in force are unaffected and are still being applied to visits — this screen simply could not read them. Refresh to try again."
            retry={
              <Link href="/settings/visit-policy" className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  // De-duplicate by id: the targeted read deliberately overlaps the other two.
  const byId = new Map<string, PolicyRow>();
  for (const row of [
    ...((floorRes.data ?? []) as unknown as PolicyRow[]),
    ...((otherRes.data ?? []) as unknown as PolicyRow[]),
    ...((scopedRes.data ?? []) as unknown as PolicyRow[]),
  ]) {
    byId.set(row.id, row);
  }
  const policies = [...byId.values()];
  const serviceTypes = (serviceTypeRes.data ?? []) as ServiceTypeRow[];
  const serviceTypeById = new Map(serviceTypes.map((s) => [s.id, s]));
  const now = Date.now();

  // Names for the ids that already carry their own policy — a targeted refetch under RLS,
  // not a directory dump. A row whose subject the reader cannot see reads "(restricted)".
  const scopedClientIds = [
    ...new Set(policies.filter((p) => p.scope_kind === "client" && p.scope_id).map((p) => p.scope_id as string)),
  ];
  const authorIds = [...new Set(policies.map((p) => p.created_by))];

  const [scopedClientRes, authorRes, pickerClientRes] = await Promise.all([
    scopedClientIds.length
      ? supabase.from("client").select("id, first_name, last_name").in("id", scopedClientIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string; last_name: string }[], error: null }),
    authorIds.length
      ? supabase.from("app_user").select("id, full_name").in("id", authorIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[], error: null }),
    // The client list is loaded ONLY on the tab that needs to pick one. The other three
    // tabs of this screen never pull a roster of names they have no use for.
    scope === "client"
      ? supabase
          .from("client")
          .select("id, first_name, last_name, status")
          .order("last_name", { ascending: true })
          .limit(300)
      : Promise.resolve({ data: [] as ClientRow[], error: null }),
  ]);

  const clientName = new Map(
    ((scopedClientRes.data ?? []) as { id: string; first_name: string; last_name: string }[]).map((c) => [
      c.id,
      `${c.first_name} ${c.last_name}`,
    ])
  );
  for (const c of (pickerClientRes.data ?? []) as ClientRow[]) {
    clientName.set(c.id, `${c.first_name} ${c.last_name}`);
  }
  const authorName = new Map(
    ((authorRes.data ?? []) as { id: string; full_name: string | null }[]).map((a) => [
      a.id,
      a.full_name ?? "A team member",
    ])
  );

  /* ── The ladder for the scope being looked at ─────────────────────────────── */

  const tenantRow = inForce(policies, "tenant", null, null, now);
  const selectedServiceType = scope === "service_type" && targetId ? serviceTypeById.get(targetId) : undefined;

  type Rung = { key: string; label: string; detail: string; row: PolicyRow | null; inert?: boolean };
  const chain: Rung[] = [];

  if (scope === "client" && targetId) {
    chain.push({
      key: "client",
      label: "This client",
      detail: clientName.get(targetId) ?? "(restricted)",
      row: inForce(policies, "client", targetId, null, now),
    });
  }
  if (scope === "service_type" && targetId) {
    chain.push({
      key: "service_type",
      label: "This service type",
      detail: selectedServiceType ? `${selectedServiceType.name} (${selectedServiceType.code})` : "(restricted)",
      row: inForce(policies, "service_type", targetId, null, now),
    });
    if (selectedServiceType) {
      chain.push({
        key: "payer_kind",
        label: "Its payer kind",
        detail: PAYER_LABEL.get(selectedServiceType.payer_kind) ?? selectedServiceType.payer_kind,
        row: inForce(policies, "payer_kind", null, selectedServiceType.payer_kind, now),
      });
    }
  }
  if (scope === "payer_kind" && targetValue) {
    chain.push({
      key: "payer_kind",
      label: "This payer kind",
      detail: PAYER_LABEL.get(targetValue) ?? targetValue,
      row: inForce(policies, "payer_kind", null, targetValue, now),
    });
  }
  // The ladder docs/17 §3.4 pins has a program rung. No program entity exists in the
  // corpus yet, so a program-scope row is storable and inert — the resolver has nothing
  // to join a client to a program with. Naming it here beats an invisible gap.
  chain.push({
    key: "program",
    label: "Program",
    detail: "Not in use yet",
    row: null,
    inert: true,
  });
  chain.push({
    key: "tenant",
    label: "Agency default",
    detail: "Everything falls back to this",
    row: tenantRow,
  });

  const effectiveRung = chain.find((r) => r.row) ?? null;
  const effective = effectiveRung?.row ?? null;

  // What the editor starts from: the values in force for this scope, or — when this agency
  // has no policy at all — the 0044 column defaults, so the first save is a review rather
  // than eighteen blank boxes.
  const formValues: Record<PolicySettingKey, string | number | boolean> = effective
    ? (Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, valueOf(effective, f.key)])) as Record<
        PolicySettingKey,
        string | number | boolean
      >)
    : POLICY_BASELINE;

  // The exact scope being authored — its own version chain, newest first.
  const scopeVersions = policies
    .filter(
      (p) =>
        p.scope_kind === scope &&
        (p.scope_id ?? null) === (scope === "service_type" || scope === "client" ? targetId : null) &&
        (p.scope_value ?? null) === (scope === "payer_kind" ? targetValue : null)
    )
    .sort((a, b) => b.version_no - a.version_no);

  const scopeChosen = scope === "tenant" || (scope === "payer_kind" ? Boolean(targetValue) : Boolean(targetId));

  // A policy row is not PHI, so reading it is deliberately allowed at AAL1 — a caregiver
  // standing on a porch needs to know their own grace period. WRITING one reconfigures
  // enforcement for the whole agency and requires AAL2. Say that before someone fills in
  // eighteen fields and hits a refusal, rather than after.
  let canWrite = true;
  if (scopeChosen) {
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      canWrite = !data || data.currentLevel === "aal2";
    } catch {
      canWrite = true; // never block the editor on an assurance-level probe
    }
  }

  const tabHref = (key: ScopeKind) => (key === "tenant" ? "/settings/visit-policy" : `/settings/visit-policy?scope=${key}`);
  const activeHref =
    scope === "tenant"
      ? "/settings/visit-policy"
      : `/settings/visit-policy?scope=${scope}`;

  // Scopes that already carry their own policy — the map of where this agency has diverged.
  const overrideScopes = policies
    .filter((p) => p.scope_kind !== "tenant")
    .reduce((acc, p) => {
      const key = `${p.scope_kind}:${p.scope_id ?? p.scope_value ?? "-"}`;
      if (!acc.has(key)) acc.set(key, p);
      return acc;
    }, new Map<string, PolicyRow>());

  return (
    <AppShell active="/settings/visit-policy">
      <div className="rise">
        {header}

        <div className="mb-6 grid gap-3 lg:grid-cols-2">
          <Rail>
            <strong className="font-semibold" style={{ color: "var(--text)" }}>
              Saving creates a new version; the old one is kept.
            </strong>{" "}
            A policy is never edited in place. Each save appends the next version and records who wrote it and
            why, and the version it replaces stays exactly as authored — so a visit already measured against the
            old rules still means what it meant when it happened.
          </Rail>
          <Rail>
            <strong className="font-semibold" style={{ color: "var(--text)" }}>
              These numbers are this agency&rsquo;s operating choices.
            </strong>{" "}
            No COMAR provision and no federal rule sets an arrival radius, a grace period or a rounding
            increment. The agency sets them and answers for them — nothing on this screen should be shown to a
            surveyor as a requirement.
          </Rail>
        </div>

        <div className="mb-4">
          <Tabs
            label="Policy scope"
            active={activeHref}
            items={SCOPE_TABS.map((t) => ({ href: tabHref(t.key), label: t.label }))}
          />
        </div>

        {/* ── Scope picker (server-rendered GET form; no JS needed to change scope) ── */}
        {scope !== "tenant" && (
          <form method="get" action="/settings/visit-policy" className="card mb-6 flex flex-wrap items-end gap-3 px-5 py-4">
            <input type="hidden" name="scope" value={scope} />
            <div className="min-w-64 flex-1">
              <label className="label" htmlFor="scope_target">
                {scope === "payer_kind" ? "Payer kind" : scope === "service_type" ? "Service type" : "Client"}
              </label>
              {scope === "payer_kind" ? (
                <select id="scope_target" name="value" defaultValue={targetValue ?? ""} className="select" required>
                  <option value="">Choose a payer kind…</option>
                  {PAYER_KINDS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              ) : scope === "service_type" ? (
                <select id="scope_target" name="id" defaultValue={targetId ?? ""} className="select" required>
                  <option value="">Choose a service type…</option>
                  {serviceTypes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code}){s.active ? "" : " · retired"}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <select id="scope_target" name="id" defaultValue={targetId ?? ""} className="select" required>
                    <option value="">Choose a client…</option>
                    {((pickerClientRes.data ?? []) as ClientRow[]).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.last_name}, {c.first_name}
                        {c.status === "active" ? "" : ` · ${c.status.replace(/_/g, " ")}`}
                      </option>
                    ))}
                  </select>
                  {((pickerClientRes.data ?? []) as ClientRow[]).length === 0 && (
                    // Authoring policy and reading the client roster are separate
                    // permissions. Say which one is missing rather than showing a blank list.
                    <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                      No client is readable on this session. Client-level policy is written against a client
                      record, so you need a verified session and access to that client — through the care team or
                      agency-wide client access — before one can be chosen here.
                    </p>
                  )}
                </>
              )}
            </div>
            <button type="submit" className="btn btn-secondary btn-sm">
              Show this policy
            </button>
          </form>
        )}

        {!scopeChosen ? (
          <>
            <EmptyState
              icon={<IconShield />}
              title={
                scope === "payer_kind"
                  ? "Choose a payer kind to see its rules"
                  : scope === "service_type"
                    ? "Choose a service type to see its rules"
                    : "Choose a client to see their rules"
              }
              body="Nothing here is set until you pick one. Whatever you choose starts from the agency default and only differs where you say it does — a policy at this level never resets the settings you have not touched."
            />
            {overrideScopes.size > 0 && (
              <div className="mt-6">
                <SectionTitle icon={<IconPen />}>Where this agency has its own rules</SectionTitle>
                <div className="card divide-y hairline overflow-hidden">
                  {[...overrideScopes.values()].map((p) => {
                    const label =
                      p.scope_kind === "client"
                        ? clientName.get(p.scope_id ?? "") ?? "(restricted)"
                        : p.scope_kind === "service_type"
                          ? serviceTypeById.get(p.scope_id ?? "")?.name ?? "(restricted)"
                          : PAYER_LABEL.get(p.scope_value ?? "") ?? p.scope_value ?? "—";
                    const href =
                      p.scope_kind === "payer_kind"
                        ? `/settings/visit-policy?scope=payer_kind&value=${encodeURIComponent(p.scope_value ?? "")}`
                        : `/settings/visit-policy?scope=${p.scope_kind}&id=${encodeURIComponent(p.scope_id ?? "")}`;
                    return (
                      <Link key={p.id} href={href} className="flex items-center gap-4 px-5 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[14px] font-medium">{label}</p>
                          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {p.scope_kind.replace(/_/g, " ")} · version {p.version_no} · {fmtStamp(p.created_at)}
                          </p>
                        </div>
                        <Badge tone="accent">Open</Badge>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* ── Inheritance preview ── */}
            <div className="mb-6">
              <SectionTitle icon={<IconMapPin />}>Where these rules come from</SectionTitle>
              <div className="card px-5 py-4">
                <ol className="flex flex-col gap-2">
                  {chain.map((rung) => {
                    const isSource = effectiveRung?.key === rung.key;
                    return (
                      <li key={rung.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="w-40 shrink-0 text-[13px] font-medium">{rung.label}</span>
                        <span className="min-w-0 flex-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                          {rung.detail}
                        </span>
                        {rung.inert ? (
                          <Badge tone="neutral">Not in use yet</Badge>
                        ) : rung.row ? (
                          <Badge tone={isSource ? "success" : "neutral"} icon={isSource ? <IconCheck /> : undefined}>
                            {isSource ? `In effect · version ${rung.row.version_no}` : `Set here · version ${rung.row.version_no}`}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">Nothing set — inherits</Badge>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  The most specific rung with a policy supplies every value; the rungs below it are what those
                  values fall back to when it is removed from the picture. Each rung shows the highest version
                  actually in force right now — a version scheduled to start later is stored, and simply does not
                  govern yet.
                  {scope === "client" &&
                    " A visit that also names a service type inserts the service-type and payer-kind rungs between these two."}
                </p>
              </div>
            </div>

            {!effective ? (
              <EmptyState
                icon={<IconAlert />}
                title="This agency has no visit policy yet"
                body="Nothing is being measured against anything. Set the agency default below — every other scope builds on it, and CareOS refuses to resolve a policy at all until it exists. The values shown are the starting points CareOS ships with, not rules anyone has agreed to yet."
              />
            ) : (
              <div className="mb-6">
                <SectionTitle icon={<IconShield />}>In force now</SectionTitle>
                <div className="grid gap-3 lg:grid-cols-2">
                  {POLICY_GROUPS.map((group) => (
                    <div key={group.key} className="card px-5 py-4">
                      <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{group.title}</h3>
                      <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                        {group.blurb}
                      </p>
                      <dl className="mt-3 flex flex-col gap-2">
                        {POLICY_FIELDS.filter((f) => f.group === group.key).map((field) => {
                          const value = valueOf(effective, field.key);
                          const base = tenantRow ? valueOf(tenantRow, field.key) : null;
                          const fromTenant = effectiveRung?.key === "tenant";
                          const differs = base !== null && base !== value;
                          return (
                            <div key={field.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                                {field.label}
                              </dt>
                              <dd className="tabular text-[13px] font-medium">
                                {displayPolicyValue(field, value)}
                                {!fromTenant && (
                                  <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--text-muted)" }}>
                                    {differs
                                      ? `agency default: ${displayPolicyValue(field, base)}`
                                      : "same as the agency default"}
                                  </span>
                                )}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                  From {effectiveRung?.label.toLowerCase()} · version {effective.version_no} · in force since{" "}
                  {fmtStamp(effective.effective_from)}
                  {effective.effective_until ? ` until ${fmtStamp(effective.effective_until)}` : ""} · written by{" "}
                  {authorName.get(effective.created_by) ?? "a team member"}
                </p>
              </div>
            )}

            {/* ── The editor ── */}
            <div className="mb-6">
              <SectionTitle icon={<IconPen />}>
                {effectiveRung && effectiveRung.key !== scope && scope !== "tenant"
                  ? "Set rules for this scope"
                  : "Save the next version"}
              </SectionTitle>
              <div className="card px-5 py-5">
                {!canWrite && (
                  <div
                    className="mb-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] px-4 py-3"
                    style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}
                  >
                    <IconLock width={16} height={16} />
                    <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
                      You can read these rules on this session, but saving a version changes how visits are
                      enforced for the whole agency, so it needs a verified session. Verify first — nothing you
                      type here is lost by doing so.
                    </p>
                    <Link href="/mfa" className="btn btn-secondary btn-sm">
                      Verify session
                    </Link>
                  </div>
                )}
                <PolicyForm action={saveVisitPolicy} submitLabel="Save a new version">
                  <input type="hidden" name="scope_kind" value={scope} />
                  <input type="hidden" name="scope_id" value={scope === "service_type" || scope === "client" ? targetId ?? "" : ""} />
                  <input type="hidden" name="scope_value" value={scope === "payer_kind" ? targetValue ?? "" : ""} />

                  {effectiveRung && effectiveRung.key !== scope && (
                    <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                      This scope has no policy of its own yet, so the values below are the ones it currently
                      inherits from {effectiveRung.label.toLowerCase()}. Saving starts a chain here: only the
                      settings that differ will actually differ, and everything you leave alone stays where it is.
                    </p>
                  )}

                  <div className="flex flex-col gap-6">
                    {POLICY_GROUPS.map((group) => (
                      <fieldset key={group.key} className="min-w-0">
                        <legend className="text-[15px] font-semibold tracking-[-0.01em]">{group.title}</legend>
                        <p className="mt-1 mb-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                          {group.blurb}
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          {POLICY_FIELDS.filter((f) => f.group === group.key).map((field) => (
                            <FieldInput key={field.key} field={field} value={formValues[field.key]} />
                          ))}
                        </div>
                      </fieldset>
                    ))}

                    <fieldset className="min-w-0">
                      <legend className="text-[15px] font-semibold tracking-[-0.01em]">This change</legend>
                      <p className="mt-1 mb-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                        The reason is kept on the new version and shown to anyone reading the history. Leave the
                        dates blank to have the change take effect the moment you save.
                      </p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="sm:col-span-2">
                          <label className="label" htmlFor="f_reason">
                            Why this is changing
                          </label>
                          <textarea
                            id="f_reason"
                            name="reason"
                            required
                            maxLength={500}
                            rows={2}
                            className="textarea"
                            placeholder="e.g. Widened the arrival radius for the rural route after three drivers reported the check failing at the end of long driveways."
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor="f_effective_from">
                            Starts (optional)
                          </label>
                          <input
                            id="f_effective_from"
                            name="effective_from"
                            type="datetime-local"
                            className="input tabular"
                            defaultValue=""
                          />
                          <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                            A date ahead of now stores the version and holds it until then. Until it starts, the
                            current version keeps governing.
                          </p>
                        </div>
                        <div>
                          <label className="label" htmlFor="f_effective_until">
                            Ends (optional)
                          </label>
                          <input
                            id="f_effective_until"
                            name="effective_until"
                            type="datetime-local"
                            className="input tabular"
                            defaultValue=""
                          />
                          <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                            Leave blank for an open-ended version. When it ends, the rung below takes over again.
                          </p>
                        </div>
                      </div>
                    </fieldset>
                  </div>
                </PolicyForm>
              </div>
            </div>

            {/* ── Version history for this exact scope ── */}
            <div>
              <SectionTitle icon={<IconHistory />}>Every version of this scope</SectionTitle>
              {scopeVersions.length === 0 ? (
                <div className="card px-5 py-4">
                  <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    No version has ever been written at this level. Whatever applies today is inherited from a
                    less specific rung above.
                  </p>
                </div>
              ) : (
                <div className="card divide-y hairline overflow-hidden">
                  {scopeVersions.map((v) => {
                    const live = v.id === effective?.id;
                    const scheduled = new Date(v.effective_from).getTime() > now;
                    return (
                      <div key={v.id} className="px-5 py-4">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <span className="tabular text-[14px] font-semibold">Version {v.version_no}</span>
                          {live ? (
                            <Badge tone="success" icon={<IconCheck />}>
                              In force
                            </Badge>
                          ) : scheduled ? (
                            <Badge tone="warning">Scheduled</Badge>
                          ) : (
                            <Badge tone="neutral">Superseded, kept</Badge>
                          )}
                          <span className="tabular text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {fmtStamp(v.effective_from)}
                            {v.effective_until ? ` → ${fmtStamp(v.effective_until)}` : ""}
                          </span>
                          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {authorName.get(v.created_by) ?? "A team member"}
                          </span>
                        </div>
                        {v.change_reason && (
                          <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                            {v.change_reason}
                          </p>
                        )}
                        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          Arrival {v.geofence_radius_m} m ({v.geofence_tier}) · late after{" "}
                          {v.late_threshold_minutes} min · missed after {v.missed_visit_minutes} min · rounding{" "}
                          {v.rounding_policy.replace(/_/g, " ")}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        <p className="mt-6 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          <IconLock width={12} height={12} className="mr-1 inline align-[-1px]" />
          Every save runs through <span className="tabular">app.upsert_visit_policy</span> on your own session.
          The database checks your permission and your verification, assigns the version number, and refuses any
          setting it does not recognise — this screen cannot write around it.
        </p>
      </div>
    </AppShell>
  );
}
