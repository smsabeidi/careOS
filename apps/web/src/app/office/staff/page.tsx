import type { ReactNode } from "react";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, SectionTitle, StatusChip } from "@/components/ui";
import { IconCalendar, IconClipboard, IconHeart, IconLock, IconShield, IconUsers } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";

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

/* Grouped-list section glyphs — one calm blue tint, Apple Settings section style. */
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

export default async function StaffPage() {
  await requireRole(["owner", "admin", "coordinator", "hr"]);
  const supabase = await supabaseServer();

  const [{ data: staff }, { data: activeAssignments }] = await Promise.all([
    supabase
      .from("app_user")
      .select("id, full_name, work_email, status, user_role(role(key, name))")
      .eq("kind", "staff")
      .order("full_name")
      .limit(300),
    supabase
      .from("care_team_assignment")
      .select("user_id")
      .is("ends_on", null)
      .limit(2000),
  ]);

  const loadByUser = new Map<string, number>();
  for (const a of activeAssignments ?? []) {
    loadByUser.set(a.user_id, (loadByUser.get(a.user_id) ?? 0) + 1);
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

  return (
    <AppShell active="/office/staff">
      <div className="rise">
        <PageHeader
          title="Staff"
          sub={`${activeCount} active team members across ${grouped.length} roles`}
        />

        {!rows.length ? (
          <EmptyState
            icon={<IconShield />}
            title="The directory needs a permission"
            body="Staff details are visible to office and leadership roles. If you should have access, your administrator can grant it."
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
                    return (
                      <div key={s.id} className="row-link">
                        <Avatar name={s.full_name} size={40} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{s.full_name}</p>
                          <p className="truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                            {s.work_email}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {(g.key === "caregiver" || g.key === "rn") && (
                            <span className="tabular text-[13px]" style={{ color: "var(--text-secondary)" }}>
                              {load} {load === 1 ? "client" : "clients"}
                            </span>
                          )}
                          <StatusChip status={s.status === "active" ? "active" : s.status} />
                        </div>
                      </div>
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
