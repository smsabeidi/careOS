import Link from "next/link";
import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";
import { IconSparkle } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { BrainConsole } from "./brain-console";

export const metadata = { title: "Brain" };
export const dynamic = "force-dynamic";

/**
 * Say out loud how retrieval will actually behave, from the corpus as it stands right
 * now — not from what the ladder is capable of. knowledge_chunk ships with `embedding`
 * null, so "we have an HNSW index" is not the same claim as "the passages are embedded",
 * and a reader deciding whether to trust an answer deserves the difference.
 */
function retrievalNote(chunks: number, embedded: number): string {
  if (chunks === 0) {
    return "Retrieval is keyword match over policy documents — no passage index is present yet.";
  }
  if (embedded === 0) {
    return `Retrieval covers ${chunks} policy ${chunks === 1 ? "passage" : "passages"}, none of which has a stored embedding yet. Embeddings are computed at question time, and retrieval falls back to keyword match whenever the embeddings service is unavailable.`;
  }
  if (embedded < chunks) {
    return `Retrieval is semantic match over ${embedded} of ${chunks} policy passages; the rest are embedded at question time, with keyword match as the fallback.`;
  }
  return `Retrieval is semantic match over ${chunks} embedded policy ${chunks === 1 ? "passage" : "passages"}, with keyword match as the fallback.`;
}

export default async function BrainPage() {
  await requireRole(["owner", "admin", "coordinator", "rn"]);
  const supabase = await supabaseServer();

  // Every probe runs as the requesting user (invariant 9) — head-only counts, no content.
  const [{ count: docCount }, { count: askCount }, { count: chunkCount }, { count: embeddedCount }] =
    await Promise.all([
      supabase.from("knowledge_document").select("id", { count: "exact", head: true }).eq("active", true),
      supabase.from("ai_interaction").select("id", { count: "exact", head: true }).eq("capability_key", "brain.answer"),
      supabase.from("knowledge_chunk").select("id", { count: "exact", head: true }),
      supabase.from("knowledge_chunk").select("id", { count: "exact", head: true }).not("embedding", "is", null),
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
          the model. {retrievalNote(chunkCount ?? 0, embeddedCount ?? 0)} Your accept, edit, and reject
          feedback is recorded against the answer it judges and cannot be edited or removed afterward.
        </p>
      </div>
    </AppShell>
  );
}
