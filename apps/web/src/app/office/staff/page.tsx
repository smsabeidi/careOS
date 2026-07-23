import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, StatusChip } from "@/components/ui";
import { IconShield } from "@/components/icons";
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
          <div className="flex flex-col gap-6">
            {grouped.map((g) => (
              <section key={g.key}>
                <h2 className="mb-2 flex items-baseline gap-2 text-[15px] font-semibold">
                  {g.title}
                  <span className="tabular text-[13px] font-normal" style={{ color: "var(--text-muted)" }}>
                    {g.members.length}
                  </span>
                </h2>
                <div className="card divide-y hairline overflow-hidden">
                  {g.members.map((s) => {
                    const load = loadByUser.get(s.id) ?? 0;
                    return (
                      <div key={s.id} className="row-link">
                        <Avatar name={s.full_name} size={36} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14.5px] font-medium">{s.full_name}</p>
                          <p className="truncate text-[13px]" style={{ color: "var(--text-muted)" }}>
                            {s.work_email}
                          </p>
                        </div>
                        {(g.key === "caregiver" || g.key === "rn") && (
                          <span className="tabular text-[13px]" style={{ color: "var(--text-secondary)" }}>
                            {load} {load === 1 ? "client" : "clients"}
                          </span>
                        )}
                        <StatusChip status={s.status === "active" ? "active" : s.status} />
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
