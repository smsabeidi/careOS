import type { ReactNode } from "react";
import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, Badge, EmptyState, PageHeader, SectionTitle, StatusChip } from "@/components/ui";
import { IconCalendar, IconClipboard, IconHeart, IconLock, IconShield, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import { InviteForm, QuickAction } from "./staff-forms";

export const metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

const GROUPS: { key: string; title: string }[] = [
  { key: "rn", title: "Nurses" },
  { key: "caregiver", title: "Caregivers" },
  { key: "coordinator", title: "Coordinators" },
  { key: "hr", title: "HR" },
  { key: "owner", title: "Leadership" },
  { key: "admin", title: "Administrators" },
];

const GROUP_ICON: Record<string, ReactNode> = {
  rn: <IconHeart width={16} height={16} />,
  caregiver: <IconUsers width={16} height={16} />,
  coordinator: <IconCalendar width={16} height={16} />,
  hr: <IconClipboard width={16} height={16} />,
  owner: <IconShield width={16} height={16} />,
  admin: <IconLock width={16} height={16} />,
};

type StaffRow = {
  id: string;
  full_name: string;
  work_email: string;
  status: string;
  user_role: { role: { key: string; name: string } | { key: string; name: string }[] | null }[];
};
type EmployeeRow = { id: string; role_title: string; employment_status: string };
type ExpiryRow = { app_user_id: string; expiry_bucket: string; blocks_scheduling: boolean };
type FileRow = { employee_id: string; items_total: number; items_closed: number; file_complete: boolean };
type InvitationRow = { id: string; email: string; full_name: string; role_title: string; status: string; expires_at: string };

export default async function StaffPage() {
  await requirePerm("user.read");
  const supabase = await supabaseServer();

  const [
    { data: staff },
    { data: activeAssignments },
    { data: employees },
    { data: expiries },
    { data: files },
    { data: canManage },
    { data: invitations },
    { data: roles },
  ] = await Promise.all([
    supabase
      .from("app_user")
      .select("id, full_name, work_email, status, user_role!user_role_user_id_fkey(role(key, name))")
      .eq("kind", "staff")
      .order("full_name")
      .limit(300),
    supabase.from("care_team_assignment").select("user_id").is("ends_on", null).limit(2000),
    supabase.from("employee").select("id, role_title, employment_status").limit(300),
    supabase
      .from("credential_expiry")
      .select("app_user_id, expiry_bucket, blocks_scheduling")
      .in("expiry_bucket", ["expiring_soon", "lapsed"])
      .limit(2000),
    supabase.from("employee_file_status").select("employee_id, items_total, items_closed, file_complete").limit(300),
    supabase.schema("app").rpc("has_perm", { p: "staff.manage" }),
    supabase
      .from("invitation")
      .select("id, email, full_name, role_title, status, expires_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("role").select("id, key, name").order("name"),
  ]);

  const loadByUser = new Map<string, number>();
  for (const a of activeAssignments ?? []) {
    loadByUser.set(a.user_id, (loadByUser.get(a.user_id) ?? 0) + 1);
  }
  const empByUser = new Map((employees ?? []).map((e: EmployeeRow) => [e.id, e]));
  const fileByUser = new Map((files ?? []).map((f: FileRow) => [f.employee_id, f]));
  const wall = new Map<string, { lapsed: number; expiring: number }>();
  for (const c of (expiries ?? []) as ExpiryRow[]) {
    if (!c.blocks_scheduling) continue;
    const w = wall.get(c.app_user_id) ?? { lapsed: 0, expiring: 0 };
    if (c.expiry_bucket === "lapsed") w.lapsed += 1;
    else w.expiring += 1;
    wall.set(c.app_user_id, w);
  }

  const roleOf = (s: StaffRow): string => {
    for (const ur of s.user_role ?? []) {
      const role = Array.isArray(ur.role) ? ur.role[0] : ur.role;
      if (role?.key) return role.key;
    }
    return "unassigned";
  };

  const rows = (staff ?? []) as unknown as StaffRow[];
  const grouped = GROUPS.map((g) => ({
    ...g,
    members: rows.filter((s) => roleOf(s) === g.key),
  })).filter((g) => g.members.length > 0);

  const activeCount = rows.filter((s) => s.status === "active").length;
  const onboardingCount = (employees ?? []).filter(
    (e: EmployeeRow) => e.employment_status === "onboarding"
  ).length;
  const wallProblems = [...wall.values()].reduce((n, w) => n + w.lapsed, 0);

  return (
    <AppShell active="/office/staff">
      <div className="rise">
        <PageHeader
          title="Staff"
          sub={`${activeCount} active · ${onboardingCount} onboarding · ${wallProblems} lapsed blocking credential${wallProblems === 1 ? "" : "s"}`}
        />

        {onboardingCount > 0 ? (
          <div className="mb-5">
            <Link href="/office/staff/onboarding" className="row-link card">
              <IconClipboard width={18} height={18} />
              <span className="flex-1 text-[14px] font-medium">
                Onboarding tracker — {onboardingCount} personnel file{onboardingCount === 1 ? "" : "s"} in progress
              </span>
              <span aria-hidden>→</span>
            </Link>
          </div>
        ) : null}

        {canManage ? (
          <section className="mb-7">
            <SectionTitle icon={<IconUsers width={16} height={16} />}>Invite staff</SectionTitle>
            <div className="card p-4">
              <InviteForm roles={(roles ?? []) as { id: string; key: string; name: string }[]} />
            </div>
            {(invitations ?? []).length ? (
              <div className="card mt-3 divide-y hairline overflow-hidden">
                {(invitations as InvitationRow[]).map((inv) => (
                  <div key={inv.id} className="row-link">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{inv.full_name}</p>
                      <p className="truncate text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {inv.email} · {inv.role_title} · expires{" "}
                        {new Date(inv.expires_at).toLocaleDateString()}
                      </p>
                    </div>
                    <StatusChip status="pending" />
                    <QuickAction
                      action="revokeInvitation"
                      label="Revoke"
                      fields={{ invitation_id: inv.id }}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {!rows.length ? (
          <EmptyState
            icon={<IconShield />}
            title="No staff records visible"
            body="Staff details are visible to office and leadership roles. Contact your administrator to request access."
          />
        ) : (
          <div className="stagger flex flex-col gap-7">
            {grouped.map((g) => (
              <section key={g.key}>
                <SectionTitle icon={GROUP_ICON[g.key]}>
                  {g.title}
                  <span className="ml-auto tabular text-[13px] font-normal" style={{ color: "var(--text-secondary)" }}>
                    {g.members.length}
                  </span>
                </SectionTitle>
                <div className="card divide-y hairline overflow-hidden">
                  {g.members.map((s) => {
                    const load = loadByUser.get(s.id) ?? 0;
                    const emp = empByUser.get(s.id);
                    const w = wall.get(s.id);
                    const file = fileByUser.get(s.id);
                    const nextAction =
                      w?.lapsed
                        ? `${w.lapsed} lapsed credential${w.lapsed === 1 ? "" : "s"} — start renewal`
                        : w?.expiring
                          ? `${w.expiring} credential${w.expiring === 1 ? "" : "s"} expiring soon`
                          : emp?.employment_status === "onboarding" && file
                            ? `file ${file.items_closed}/${file.items_total} — continue onboarding`
                            : null;
                    return (
                      <Link key={s.id} href={`/office/staff/${s.id}`} className="row-link">
                        <Avatar name={s.full_name} size={40} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[15px] font-medium tracking-[-0.01em]">
                            {s.full_name}
                            {emp ? (
                              <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--text-muted)" }}>
                                {emp.role_title}
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate text-[13px]" style={{ color: nextAction ? "var(--text-secondary)" : "var(--text-muted)" }}>
                            {nextAction ?? s.work_email}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {w?.lapsed ? <Badge tone="danger">{w.lapsed} lapsed</Badge> : null}
                          {!w?.lapsed && w?.expiring ? <Badge tone="warning">{w.expiring} expiring</Badge> : null}
                          {(g.key === "caregiver" || g.key === "rn") && (
                            <span className="tabular text-[13px]" style={{ color: "var(--text-secondary)" }}>
                              {load} {load === 1 ? "client" : "clients"}
                            </span>
                          )}
                          <StatusChip
                            status={emp?.employment_status === "onboarding" ? "onboarding" : s.status}
                          />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
