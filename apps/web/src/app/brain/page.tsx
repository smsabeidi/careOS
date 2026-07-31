import Link from "next/link";
import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";
import { IconSparkle } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { BrainConsole } from "./brain-console";

export const metadata = { title: "Brain" };
export const dynamic = "force-dynamic";

export default async function BrainPage() {
  await requireRole(["owner", "admin", "coordinator", "rn"]);
  const supabase = await supabaseServer();

  const [{ count: docCount }, { count: askCount }] = await Promise.all([
    supabase.from("knowledge_document").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("ai_interaction").select("id", { count: "exact", head: true }).eq("capability_key", "brain.answer"),
  ]);

  return (
    <AppShell active="/brain">
      <div className="rise mx-auto max-w-2xl">
        <PageHeader
          title="Brain"
          sub={`Grounded in ${docCount ?? 0} policy ${docCount === 1 ? "document" : "documents"} · answers cite sources or abstain`}
          actions={
            <Link href="/office/ai" className="btn btn-secondary btn-sm">
              <IconSparkle width={15} height={15} />
              View activity{typeof askCount === "number" ? ` · ${askCount}` : ""}
            </Link>
          }
        />
        <BrainConsole />
        <p className="mt-5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Each question and answer is logged with model, tokens, cost, and tier. Answers come only from
          agency policy documents; when no policy applies, the Brain abstains. No client data is sent to
          the model.
        </p>
      </div>
    </AppShell>
  );
}
