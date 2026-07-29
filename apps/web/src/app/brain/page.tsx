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
          sub={`Grounded in ${docCount ?? 0} policy ${docCount === 1 ? "document" : "documents"} · cites its sources or abstains`}
          actions={
            <Link href="/office/ai" className="btn btn-secondary btn-sm">
              <IconSparkle width={15} height={15} />
              Activity{typeof askCount === "number" ? ` · ${askCount}` : ""}
            </Link>
          }
        />
        <BrainConsole />
        <p className="mt-5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Every question and answer is logged (model, tokens, cost, tier) and never invents facts — it
          answers only from your policy documents, or says it doesn&apos;t know. No patient data is sent to
          the model.
        </p>
      </div>
    </AppShell>
  );
}
