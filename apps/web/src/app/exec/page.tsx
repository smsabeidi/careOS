import { AppShell } from "@/components/shell";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { getExecMetrics } from "@/lib/exec/metrics";
import {
  ActivityPanel, AttentionPanel, CensusPanel, CommandHero, HorizonPanel,
  IntegrityPanel, PayerPanel, QuickNav, WorkforcePanel,
} from "@/components/exec/panels";

export const metadata = { title: "Command" };
export const dynamic = "force-dynamic";

export default async function ExecPage() {
  const profile = await requireRole(["owner", "admin"]);
  const supabase = await supabaseServer();
  const m = await getExecMetrics(supabase);

  return (
    <AppShell active="/exec">
      <div className="rise">
        <CommandHero name={profile.name} agencyName={m.agencyName} />
        <div className="mb-6">
          <QuickNav />
        </div>

        <div className="stagger flex flex-col gap-5">
          <AttentionPanel m={m} />

          <div className="grid gap-5 lg:grid-cols-2">
            <CensusPanel m={m} />
            <WorkforcePanel m={m} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <PayerPanel m={m} />
            <IntegrityPanel m={m} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ActivityPanel m={m} />
            <HorizonPanel />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
