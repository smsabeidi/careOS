import Link from "next/link";
import { AppShell } from "@/components/shell";
import { Avatar, EmptyState, PageHeader, ProgressMeter, SectionTitle } from "@/components/ui";
import { IconClipboard } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";

export const metadata = { title: "Onboarding" };
export const dynamic = "force-dynamic";

type FileRow = {
  employee_id: string;
  role_title: string;
  employment_status: string;
  items_total: number;
  items_closed: number;
  items_open: string[];
  file_complete: boolean;
};

export default async function OnboardingTrackerPage() {
  await requirePerm("user.read");
  const supabase = await supabaseServer();

  const [{ data: files }, { data: people }, { data: catalog }] = await Promise.all([
    supabase
      .from("employee_file_status")
      .select("*")
      .eq("employment_status", "onboarding")
      .order("items_closed", { ascending: false }),
    supabase.from("app_user").select("id, full_name, work_email").eq("kind", "staff").limit(300),
    supabase.from("onboarding_checklist").select("key, name"),
  ]);

  const nameOf = new Map((people ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name]));
  const itemName = new Map((catalog ?? []).map((c: { key: string; name: string }) => [c.key, c.name]));
  const rows = (files ?? []) as FileRow[];

  return (
    <AppShell active="/office/staff">
      <div className="rise">
        <PageHeader
          title="Onboarding"
          sub={
            rows.length
              ? `${rows.length} personnel file${rows.length === 1 ? "" : "s"} in progress`
              : "No files in progress"
          }
        />

        {!rows.length ? (
          <EmptyState
            icon={<IconClipboard />}
            title="Nobody is onboarding right now"
            body="When an invitation is accepted, the new hire's COMAR personnel file opens here with every required item."
          />
        ) : (
          <div className="stagger flex flex-col gap-4">
            {rows.map((f) => (
              <Link key={f.employee_id} href={`/office/staff/${f.employee_id}`} className="card block p-4">
                <div className="mb-3 flex items-center gap-3">
                  <Avatar name={nameOf.get(f.employee_id) ?? "?"} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">
                      {nameOf.get(f.employee_id) ?? f.employee_id}
                    </p>
                    <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {f.role_title}
                    </p>
                  </div>
                </div>
                <ProgressMeter
                  value={f.items_closed}
                  max={f.items_total}
                  label={`${f.items_closed} of ${f.items_total} items closed`}
                  valueLabel={`${f.items_total - f.items_closed} to go`}
                  tone={f.file_complete ? "success" : "accent"}
                />
                {f.items_open?.length ? (
                  <p className="mt-2 truncate text-[12px]" style={{ color: "var(--text-secondary)" }}>
                    Next: {f.items_open.slice(0, 3).map((k) => itemName.get(k) ?? k).join(" · ")}
                    {f.items_open.length > 3 ? ` · +${f.items_open.length - 3} more` : ""}
                  </p>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
