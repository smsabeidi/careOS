import Link from "next/link";
import { AppShell } from "@/components/shell";
import { EmptyState, ErrorState, PageHeader } from "@/components/ui";
import { IconLock, IconShield } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { listReports } from "./actions";
import { AnalyticsConsole } from "./analytics-client";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

/** Office roles only. RLS is still the perimeter; this is routing UX (docs/10). */
const ROLES = ["owner", "admin", "coordinator"];

export default async function AnalyticsPage() {
  await requireRole(ROLES);
  const supabase = await supabaseServer();

  // Cheap probe for the two states that are not "here is the console": a read failure,
  // and a session that is signed in but not step-up verified (PHI needs AAL2).
  const { data: probe, error } = await supabase.from("client").select("id").limit(1);

  if (error) {
    return (
      <AppShell active="/analytics">
        <div className="rise">
          <PageHeader title="Analytics" sub="Ask a question about your agency" />
          <ErrorState
            title="Couldn't reach your records"
            body="The reports could not be loaded. Nothing was changed and nothing was written. Try again."
            retry={
              <Link href="/analytics" className="btn btn-secondary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  if (!probe || probe.length === 0) {
    return (
      <AppShell active="/analytics">
        <div className="rise">
          <PageHeader title="Analytics" sub="Ask a question about your agency" />
          <EmptyState
            icon={<IconLock />}
            title="Verify your session to run reports"
            body="Reports read protected health information and run only on a verified (MFA) session. Verify your session and the reports appear here."
            action={
              <Link href="/mfa" className="btn btn-primary btn-sm">
                Verify session
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  const reports = await listReports();

  return (
    <AppShell active="/analytics">
      <div className="rise">
        <PageHeader
          title="Analytics"
          sub="Ask a question about your agency in plain English"
        />

        <div
          className="card-inset mb-6 flex items-start gap-3 px-4 py-3.5"
          style={{ background: "var(--accent-soft)", borderColor: "var(--accent-soft-border)" }}
        >
          <span style={{ color: "var(--accent)" }} className="mt-0.5 shrink-0">
            <IconShield width={18} height={18} />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold" style={{ color: "var(--accent-text)" }}>
              {reports.length} governed reports. No free-text queries, ever
            </p>
            <p
              className="mt-0.5 text-[13px] leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              The assistant maps your question onto one of these read-only reports and fills its
              time window. It never writes a query, never sees a row, and never states a number.
              Each report runs under your own permissions, so you see exactly what you are allowed
              to see — and every routed question is recorded in the AI ledger.
            </p>
          </div>
        </div>

        <AnalyticsConsole reports={reports} />
      </div>
    </AppShell>
  );
}
