import Link from "next/link";
import { AppShell } from "@/components/shell";
import {
  Avatar, Badge, DataTable, DueChip, EmptyState, PageHeader, SectionTitle, StatusChip, Tabs, TintTile,
} from "@/components/ui";
import {
  IconCheck, IconChevronRight, IconClipboard, IconClipboardCheck, IconPen, IconUsers,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { getOrGenerateBrief } from "@/lib/ai/huddle";
import { HuddleBriefCard } from "@/components/huddle-brief";
import { getLocale, getT } from "@/lib/i18n/server";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { FlagsPanel, type FlagView } from "./flags-panel";
import { CarePlanReviewPanel, type CarePlanRowView } from "./careplan-review";
import type { FlagKind, FlagSeverity } from "./clinical-actions";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("page.clinical") };
}
export const dynamic = "force-dynamic";

const TABS: { key: string; labelKey: TranslationKey }[] = [
  { key: "signatures", labelKey: "clinical.tabSignatures" },
  { key: "flags", labelKey: "clinical.tabFlags" },
  { key: "careplans", labelKey: "clinical.tabCarePlans" },
  { key: "supervisory", labelKey: "clinical.tabSupervisory" },
  { key: "caseload", labelKey: "clinical.tabCaseload" },
];

/** A plan is in its review window this many days before the platform's review date. */
const REVIEW_WINDOW_DAYS = 14;
const FLAG_KINDS = ["condition_trend", "mood_trend", "exception_spike", "visit_shortfall"];
const FLAG_SEVERITIES = ["info", "medium", "high"];

function nameOf<T extends { first_name: string; last_name: string }>(
  c: T | T[] | null,
  fallback: string
): string {
  const x = Array.isArray(c) ? c[0] : c;
  return x ? `${x.first_name} ${x.last_name}` : fallback;
}

export default async function ClinicalPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab = TABS.some((item) => item.key === params.tab) ? params.tab! : "signatures";
  const t = await getT();
  const locale = await getLocale();
  const clientFallback = t("clinical.clientFallback");
  const profile = await requireRole(["rn", "owner", "admin"]);
  const supabase = await supabaseServer();

  // ── Signature queue: RN-signature-required assessments still unsigned ──
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
    const { data: versions } = await supabase.from("form_version").select("id, instance_id").in("instance_id", ids);
    const versionIds = (versions ?? []).map((v) => v.id);
    const { data: sigs } = versionIds.length
      ? await supabase.from("signature").select("form_version_id").in("form_version_id", versionIds)
      : { data: [] as { form_version_id: string }[] };
    const signed = new Set((sigs ?? []).map((s) => s.form_version_id));
    const signedInstances = new Set((versions ?? []).filter((v) => signed.has(v.id)).map((v) => v.instance_id));
    queue = queue.filter((q) => !signedInstances.has(q.id));
  }

  // ── Caseload (RN case-managed clients) ──
  const { data: caseload } = await supabase
    .from("care_team_assignment")
    .select("client_id, client(id, first_name, last_name, city, status)")
    .eq("user_id", profile.userId)
    .eq("role_on_case", "rn_case_manager")
    .is("ends_on", null)
    .limit(300);
  const caseClients = (caseload ?? [])
    .map((a) => (Array.isArray(a.client) ? a.client[0] : a.client))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .sort((a, b) => a.last_name.localeCompare(b.last_name));

  // ── Supervisory visits I own (45/90/120-day cadence) ──
  const { data: supRows } = await supabase
    .from("supervisory_visit")
    .select("id, client_id, kind, status, due_on, completed_on, client(first_name, last_name)")
    .eq("rn_id", profile.userId)
    .order("due_on", { ascending: true })
    .limit(200);
  const supervisory = supRows ?? [];
  const supOpen = supervisory.filter((s) => !s.completed_on);

  // ── Care plans across my caseload (latest version per client) ──
  const caseIds = caseClients.map((c) => c.id);
  const { data: planRows } = caseIds.length
    ? await supabase
        .from("care_plan")
        .select("id, client_id, version, status, title, review_due_on, authored_at, client(first_name, last_name)")
        .in("client_id", caseIds)
        .order("version", { ascending: false })
        .limit(500)
    : { data: [] as {
        id: string; client_id: string; version: number; status: string; title: string | null;
        review_due_on: string | null; authored_at: string;
        client: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
      }[] };
  const latestPlan = new Map<string, NonNullable<typeof planRows>[number]>();
  for (const p of planRows ?? []) if (!latestPlan.has(p.client_id)) latestPlan.set(p.client_id, p);
  const plans = [...latestPlan.values()];

  // The review window is a comparison against the platform's own review_due_on —
  // no date is invented here, and none is invented by a model (invariant 13).
  const reviewCutoff = new Date(Date.now() + REVIEW_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const planViews: CarePlanRowView[] = plans
    .map((p) => ({
      id: p.id,
      clientId: p.client_id,
      clientName: nameOf(p.client, clientFallback),
      title: p.title ?? t("clinical.carePlanFallback"),
      version: p.version,
      status: p.status,
      reviewDueOn: p.review_due_on,
      reviewDue: Boolean(p.review_due_on && p.review_due_on <= reviewCutoff),
    }))
    .sort((a, b) => {
      if (a.reviewDue !== b.reviewDue) return a.reviewDue ? -1 : 1;
      return (a.reviewDueOn ?? "9999").localeCompare(b.reviewDueOn ?? "9999");
    });

  // ── Clinical early-warning flags (RLS: care team or client.read.all, AAL2) ──
  const { data: flagRows } = await supabase
    .from("clinical_flag")
    .select(
      "id, client_id, kind, severity, summary, evidence, status, ai_interaction_id, created_at, acknowledged_at, client(first_name, last_name)"
    )
    .order("created_at", { ascending: false })
    .limit(60);

  const flags: FlagView[] = (flagRows ?? [])
    .filter((f) => FLAG_KINDS.includes(f.kind) && FLAG_SEVERITIES.includes(f.severity))
    .map((f) => ({
      id: f.id,
      clientId: f.client_id,
      clientName: nameOf(f.client, clientFallback),
      kind: f.kind as FlagKind,
      severity: f.severity as FlagSeverity,
      summary: f.summary,
      evidence:
        f.evidence && typeof f.evidence === "object" && !Array.isArray(f.evidence)
          ? (f.evidence as Record<string, unknown>)
          : null,
      status: (f.status === "acknowledged" || f.status === "dismissed" ? f.status : "open") as
        | "open"
        | "acknowledged"
        | "dismissed",
      aiWritten: Boolean(f.ai_interaction_id),
      createdAt: f.created_at,
      disposedAt: f.acknowledged_at,
    }));
  const openFlags = flags.filter((f) => f.status === "open");

  const isClinical = profile.roles.some((r) => ["rn", "owner", "admin"].includes(r));

  const counts = {
    signatures: queue.length,
    flags: openFlags.length,
    careplans: plans.length,
    supervisory: supOpen.length,
    caseload: caseClients.length,
  };

  const sub =
    tab === "signatures"
      ? queue.length
        ? t(queue.length === 1 ? "clinical.subSignaturesOne" : "clinical.subSignaturesMany", {
            count: queue.length,
          })
        : t("clinical.subSignaturesNone")
      : tab === "flags"
        ? openFlags.length
          ? t(openFlags.length === 1 ? "clinical.subFlagsOne" : "clinical.subFlagsMany", {
              count: openFlags.length,
            })
          : t("clinical.subFlagsNone")
        : t(caseClients.length === 1 ? "clinical.subCaseloadOne" : "clinical.subCaseloadMany", {
            count: caseClients.length,
          });

  const brief = await getOrGenerateBrief(supabase, "rn", profile.userId);

  return (
    <AppShell active="/clinical">
      <div className="rise">
        <PageHeader title={t("page.clinical")} sub={sub} />

        <HuddleBriefCard brief={brief} canRegenerate />

        <div className="mb-6">
          <Tabs
            active={`/clinical${tab === "signatures" ? "" : `?tab=${tab}`}`}
            items={TABS.map((item) => ({
              href: `/clinical${item.key === "signatures" ? "" : `?tab=${item.key}`}`,
              label: t(item.labelKey),
              count: counts[item.key as keyof typeof counts],
            }))}
          />
        </div>

        {tab === "signatures" && (
          <section>
            <SectionTitle icon={<IconPen width={16} height={16} />}>{t("clinical.needsYourSignature")}</SectionTitle>
            {!queue.length ? (
              <div className="card flex items-center gap-3.5 px-5 py-4">
                <TintTile icon={<IconCheck width={20} height={20} />} tone="success" size={40} />
                <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
                  {t("clinical.noPendingSignature")}
                </p>
              </div>
            ) : (
              <div className="card stagger divide-y hairline overflow-hidden">
                {queue.slice(0, 40).map((q) => {
                  const tpl = Array.isArray(q.form_template) ? q.form_template[0] : q.form_template;
                  const c = Array.isArray(q.client) ? q.client[0] : q.client;
                  return (
                    <Link key={q.id} href={`/office/forms/${q.id}`} className="row-link">
                      <TintTile icon={<IconClipboard width={20} height={20} />} size={40} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-medium">
                          {tpl?.title ?? t("clinical.recordFallback")}
                          {c && <span style={{ color: "var(--text-muted)" }}> · {c.first_name} {c.last_name}</span>}
                        </p>
                        <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {t("clinical.lastUpdated", {
                            date: new Date(q.updated_at).toLocaleDateString(locale, { month: "short", day: "numeric" }),
                          })}
                        </p>
                      </div>
                      <StatusChip status={q.status} />
                      <span className="btn btn-primary btn-sm shrink-0">
                        <IconPen width={14} height={14} />
                        {t("clinical.reviewAndSign")}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {tab === "flags" && (
          <FlagsPanel flags={flags} canScan={isClinical} canDispose={isClinical} />
        )}

        {tab === "careplans" && (
          <CarePlanReviewPanel plans={planViews} canReview={isClinical} />
        )}

        {tab === "supervisory" && (
          <section>
            <SectionTitle icon={<IconClipboardCheck width={16} height={16} />}>{t("clinical.supervisoryTitle")}</SectionTitle>
            {!supervisory.length ? (
              <EmptyState
                icon={<IconClipboardCheck />}
                title={t("clinical.noSupervisoryTitle")}
                body={t("clinical.noSupervisoryBody")}
              />
            ) : (
              <DataTable
                columns={[
                  { header: t("clinical.colClient") },
                  { header: t("clinical.colVisit") },
                  { header: t("clinical.colDue"), align: "right" },
                  { header: t("clinical.colStatus"), align: "right" },
                ]}
                rows={supervisory.map((s) => {
                  // "45_day" → the cadence reads "45-day supervisory" / "supervisión de
                  // 45 días". Anything non-numeric falls back to the raw kind, untranslated.
                  const days = /^\d+/.exec(s.kind)?.[0];
                  return {
                  key: s.id,
                  cells: [
                    <span key="c" className="flex items-center gap-2.5">
                      <Avatar name={nameOf(s.client, clientFallback)} size={28} />
                      <span className="font-medium">{nameOf(s.client, clientFallback)}</span>
                    </span>,
                    <span key="k">
                      {days
                        ? t("clinical.supervisoryDay", { days })
                        : t("clinical.supervisoryOther", { kind: s.kind.replace(/_/g, "-") })}
                    </span>,
                    s.completed_on ? (
                      <Badge key="d" tone="success" icon={<IconCheck />}>{t("clinical.visitCompleted")}</Badge>
                    ) : (
                      <DueChip key="d" due={s.due_on} />
                    ),
                    s.completed_on ? (
                      <Badge key="s" tone="success">{t("clinical.visitCompleted")}</Badge>
                    ) : s.status === "missed" ? (
                      <Badge key="s" tone="danger">{t("clinical.visitMissed")}</Badge>
                    ) : (
                      <Badge key="s" tone="info">{t("clinical.visitScheduled")}</Badge>
                    ),
                  ],
                  };
                })}
              />
            )}
          </section>
        )}

        {tab === "caseload" && (
          <section>
            <SectionTitle icon={<IconUsers width={16} height={16} />}>{t("clinical.yourCaseload")}</SectionTitle>
            {!caseClients.length ? (
              <EmptyState
                icon={<IconUsers />}
                title={t("clinical.noCaseloadTitle")}
                body={t("clinical.noCaseloadBody")}
              />
            ) : (
              <div className="card stagger divide-y hairline overflow-hidden">
                {caseClients.map((c) => (
                  <Link key={c.id} href={`/office/clients/${c.id}`} className="row-link group">
                    <Avatar name={`${c.first_name} ${c.last_name}`} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{c.first_name} {c.last_name}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>{c.city ?? "—"}</p>
                    </div>
                    <StatusChip status={c.status} />
                    <IconChevronRight className="opacity-0 transition-opacity duration-150 group-hover:opacity-60" style={{ color: "var(--text-muted)" }} />
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
