import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell";
import {
  Avatar, Badge, PageHeader, ProgressMeter, SectionTitle, StatusChip, Timeline,
} from "@/components/ui";
import { IconCalendar, IconClipboard, IconLock, IconShield, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import { QuickAction, ReasonAction, SeparateForm } from "../staff-forms";

export const metadata = { title: "Staff member" };
export const dynamic = "force-dynamic";

type AuditRow = { occurred_at: string; action: string; entity_type: string };

const STEP_LABEL: Record<string, string> = {
  auth_ban: "Ban the sign-in account",
  refresh_revoke: "Revoke refresh tokens",
  push_invalidate: "Invalidate device push tokens",
  secrets_rotation: "Rotate any shared secrets they touched",
  equipment_return: "Collect equipment and badges",
  final_documentation: "Close out the personnel file",
};

/** Ledger actions → plain language (no dark automation: everything shows here). */
function humanize(a: AuditRow): string {
  const map: Record<string, string> = {
    "identity.invited": "Invited to the agency",
    "identity.invitation_accepted": "Accepted their invitation",
    "identity.role_granted": "Granted a role",
    "identity.role_revoked": "A role was revoked",
    "identity.suspended": "Access suspended",
    "identity.reinstated": "Access reinstated",
    "identity.separated": "Separated from the agency",
    "identity.revocation_step": "Revocation step completed",
    "identity.revocation_verified": "Revocation fully verified",
    "assignment.created": "Assigned to a client's care team",
    "assignment.ended": "A care-team assignment ended",
    "employee.updated": "Employment record updated",
    "onboarding.started": "Onboarding file opened",
    "onboarding.item_completed": "An onboarding item was verified",
    "onboarding.item_waived": "An onboarding item was waived",
    "onboarding.completed": "Personnel file completed",
    "credential.created": "A credential was added",
    "credential.verified": "A credential was verified",
    "credential.renewed": "A credential was renewed",
    "credential.expired": "A credential expired",
    "visit.reassign": "A visit assignment changed",
  };
  return map[a.action] ?? a.action.replaceAll(".", " · ");
}

export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePerm("user.read");
  const { id } = await params;
  const supabase = await supabaseServer();

  const [
    { data: person },
    { data: employee },
    { data: assignments },
    { data: credentials },
    { data: items },
    { data: checklistCatalog },
    { data: file },
    { data: revocation },
    { data: canManage },
    { data: canVerify },
  ] = await Promise.all([
    supabase
      .from("app_user")
      .select("id, full_name, work_email, phone, status, separated_at, user_role!user_role_user_id_fkey(role(key, name))")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("employee").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("care_team_assignment")
      .select("id, client_id, role_on_case, starts_on, ends_on")
      .eq("user_id", id)
      .order("starts_on", { ascending: false })
      .limit(25),
    supabase
      .from("credential_expiry")
      .select("credential_id, credential_type_name, status, expires_on, days_to_expiry, expiry_bucket, blocks_scheduling")
      .eq("app_user_id", id)
      .order("expires_on", { ascending: true }),
    supabase
      .from("onboarding_item")
      .select("checklist_key, status, verified_at, waiver_reason")
      .eq("employee_id", id),
    supabase.from("onboarding_checklist").select("key, name, kind, sort_order").order("sort_order"),
    supabase.from("employee_file_status").select("*").eq("employee_id", id).maybeSingle(),
    supabase
      .from("revocation_checklist")
      .select("step, status, completed_at, note")
      .eq("user_id", id),
    supabase.schema("app").rpc("has_perm", { p: "staff.manage" }),
    supabase.schema("app").rpc("has_perm", { p: "credential.write" }),
  ]);

  if (!person) notFound();

  // The activity feed rides the audit ledger read RPC (0025) — owner/admin only.
  // Everyone else simply doesn't get the section (the RPC refuses; we don't).
  let feed: AuditRow[] = [];
  const { data: trail } = await supabase
    .schema("app")
    .rpc("read_audit_trail", { p_entity_type: "app_user", p_entity_id: id, p_limit: 30 });
  if (Array.isArray(trail)) feed = trail as AuditRow[];

  const roleNames = (person.user_role ?? [])
    .map((ur: { role: { name: string } | { name: string }[] | null }) =>
      Array.isArray(ur.role) ? ur.role[0]?.name : ur.role?.name
    )
    .filter(Boolean)
    .join(" · ");

  const catalogByKey = new Map(
    (checklistCatalog ?? []).map((c: { key: string; name: string; kind: string; sort_order: number }) => [c.key, c])
  );
  const openItems = (items ?? [])
    .filter((i: { status: string }) => i.status === "pending" || i.status === "submitted")
    .sort(
      (a: { checklist_key: string }, b: { checklist_key: string }) =>
        (catalogByKey.get(a.checklist_key)?.sort_order ?? 999) -
        (catalogByKey.get(b.checklist_key)?.sort_order ?? 999)
    );
  const closedItems = (items ?? []).filter(
    (i: { status: string }) => i.status === "verified" || i.status === "waived"
  );

  const pendingRevocation = (revocation ?? []).filter((s: { status: string }) => s.status === "pending");
  const isSeparated = person.status === "separated";

  return (
    <AppShell active="/office/staff">
      <div className="rise">
        <PageHeader title={person.full_name} sub={roleNames || "No role assigned"} />

        {/* Identity card */}
        <div className="card mb-6 flex items-center gap-4 p-4">
          <Avatar name={person.full_name} size={52} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
              {person.work_email}
              {person.phone ? ` · ${person.phone}` : ""}
            </p>
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              {employee
                ? `${employee.role_title} · hired ${new Date(employee.hire_date).toLocaleDateString()}`
                : "No employment record"}
            </p>
          </div>
          <StatusChip status={isSeparated ? "separated" : (employee?.employment_status ?? person.status)} />
        </div>

        {/* Separation checklist — front and center while the clock runs */}
        {isSeparated && (revocation ?? []).length ? (
          <section className="mb-7">
            <SectionTitle icon={<IconLock width={16} height={16} />}>
              Revocation checklist
              {pendingRevocation.length ? (
                <span className="ml-2"><Badge tone="danger">{pendingRevocation.length} open</Badge></span>
              ) : (
                <span className="ml-2"><Badge tone="success">verified</Badge></span>
              )}
            </SectionTitle>
            <div className="card divide-y hairline overflow-hidden">
              {(revocation ?? []).map((s: { step: string; status: string; completed_at: string | null; note: string | null }) => (
                <div key={s.step} className="row-link">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium">{STEP_LABEL[s.step] ?? s.step}</p>
                    {s.note ? (
                      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>{s.note}</p>
                    ) : null}
                  </div>
                  {s.status === "pending" && canManage ? (
                    <QuickAction
                      action="completeRevocationStep"
                      label="Mark done"
                      fields={{ user_id: id, step: s.step }}
                    />
                  ) : (
                    <StatusChip status={s.status === "pending" ? "pending" : "complete"} />
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Onboarding file */}
        {file && (file.items_total ?? 0) > 0 && !isSeparated ? (
          <section className="mb-7">
            <SectionTitle icon={<IconClipboard width={16} height={16} />}>Personnel file</SectionTitle>
            <div className="card p-4">
              <ProgressMeter
                value={file.items_total ? (file.items_closed / file.items_total) * 100 : 0}
                label={`${file.items_closed} of ${file.items_total} items closed`}
                tone={file.file_complete ? "success" : "accent"}
              />
            </div>
            {openItems.length ? (
              <div className="card mt-3 divide-y hairline overflow-hidden">
                {openItems.map((i: { checklist_key: string }) => {
                  const cat = catalogByKey.get(i.checklist_key);
                  return (
                    <div key={i.checklist_key} className="flex flex-col gap-2 p-3">
                      <div className="flex items-center gap-3">
                        <p className="flex-1 text-[14px] font-medium">{cat?.name ?? i.checklist_key}</p>
                        {canManage || canVerify ? (
                          <QuickAction
                            action="completeOnboardingItem"
                            label="Verify"
                            fields={{ employee_id: id, checklist_key: i.checklist_key }}
                          />
                        ) : null}
                      </div>
                      {canManage ? (
                        <ReasonAction
                          kind="waive"
                          label="Waive"
                          placeholder="Waiver reason (goes on the record)"
                          fields={{ employee_id: id, checklist_key: i.checklist_key }}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {closedItems.length ? (
              <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                Closed: {closedItems.map((i: { checklist_key: string }) => catalogByKey.get(i.checklist_key)?.name ?? i.checklist_key).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {/* Credential wall */}
        <section className="mb-7">
          <SectionTitle icon={<IconShield width={16} height={16} />}>Credentials</SectionTitle>
          {(credentials ?? []).length ? (
            <div className="card divide-y hairline overflow-hidden">
              {(credentials ?? []).map((c: {
                credential_id: string; credential_type_name: string; status: string;
                expires_on: string | null; days_to_expiry: number | null;
                expiry_bucket: string; blocks_scheduling: boolean;
              }) => (
                <div key={c.credential_id} className="row-link">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium">{c.credential_type_name}</p>
                    <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {c.expires_on
                        ? `expires ${new Date(c.expires_on).toLocaleDateString()}`
                        : "does not expire"}
                      {c.blocks_scheduling ? " · blocks scheduling" : ""}
                    </p>
                  </div>
                  {c.expiry_bucket === "lapsed" ? (
                    <Badge tone="danger">lapsed</Badge>
                  ) : c.expiry_bucket === "expiring_soon" ? (
                    <Badge tone="warning">
                      {c.days_to_expiry != null ? `${c.days_to_expiry}d left` : "expiring"}
                    </Badge>
                  ) : (
                    <StatusChip status={c.status} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              No credentials on file.
            </p>
          )}
        </section>

        {/* Assignments */}
        <section className="mb-7">
          <SectionTitle icon={<IconUsers width={16} height={16} />}>Care-team assignments</SectionTitle>
          {(assignments ?? []).length ? (
            <div className="card divide-y hairline overflow-hidden">
              {(assignments ?? []).map((a: {
                id: string; role_on_case: string; starts_on: string; ends_on: string | null;
              }) => (
                <div key={a.id} className="row-link">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium capitalize">{a.role_on_case.replaceAll("_", " ")}</p>
                    <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      since {new Date(a.starts_on).toLocaleDateString()}
                      {a.ends_on ? ` · ended ${new Date(a.ends_on).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <StatusChip status={a.ends_on ? "ended" : "active"} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              No assignments on record.
            </p>
          )}
        </section>

        {/* Activity feed — the audit ledger in plain language (owner/admin) */}
        {feed.length ? (
          <section className="mb-7">
            <SectionTitle icon={<IconCalendar width={16} height={16} />}>Activity</SectionTitle>
            <div className="card p-4">
              <Timeline
                items={feed.map((a) => ({
                  title: humanize(a),
                  time: new Date(a.occurred_at).toLocaleString(),
                }))}
              />
            </div>
          </section>
        ) : null}

        {/* Access controls */}
        {canManage && !isSeparated ? (
          <section className="mb-10 flex flex-col gap-3">
            <SectionTitle icon={<IconLock width={16} height={16} />}>Access</SectionTitle>
            {person.status === "suspended" ? (
              <div>
                <QuickAction action="reinstateUser" label="Reinstate access" quiet={false} fields={{ user_id: id }} />
              </div>
            ) : (
              <div className="card p-3">
                <ReasonAction
                  kind="suspend"
                  label="Suspend"
                  placeholder="Suspension reason (goes on the record)"
                  fields={{ user_id: id }}
                />
              </div>
            )}
            <SeparateForm userId={id} fullName={person.full_name} />
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
