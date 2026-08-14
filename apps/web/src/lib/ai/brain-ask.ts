/**
 * The one question path — shared by /brain and the command bar (ST-232).
 *
 * The command bar is a second door onto the SAME retrieval, not a second retrieval.
 * Before this module existed, `askBrain` had exactly one caller and the ledger-recovery
 * behaviour around it lived inside that caller's server action; a bar that reimplemented
 * the wrapper would have drifted from /brain the first time either changed — different
 * truncation, a different capability key on the disposition, a lost interaction id — and
 * two answers to the same question from one agency is a trust problem, not a bug.
 *
 * So the wrapper moved here and /brain now delegates. Everything the path guarantees is
 * unchanged: retrieval runs as the requester (invariant 9), the call rides
 * `runCapability` (invariant 10), and the answer carries the `ai_interaction` id its
 * disposition must be keyed to (docs/16 §3.2).
 *
 * @trace ST-232, docs/designs/intelligent-front-door.md W1, invariants 9 + 10
 */
import { supabaseServer } from "@/lib/supabase/server";
import { askBrain, type BrainAnswer } from "@/lib/ai/client";

/** Every row either surface writes for a Brain answer is keyed to this capability. */
export const BRAIN_CAPABILITY_KEY = "brain.answer";

/** The longest question the Brain is asked. Beyond this the tail is a paste, not a question. */
const MAX_QUESTION_CHARS = 500;

export type BrainAskResult = {
  ok: boolean;
  /**
   * The ledger row this answer came from. The disposition bar needs it to key the
   * human's label to the exact model + prompt_version that produced the answer —
   * without it, the pair is untrainable. Null only when the ledger write itself
   * failed, and both surfaces degrade honestly in that case.
   */
  aiInteractionId: string | null;
} & BrainAnswer;

const EMPTY: BrainAnswer = {
  answer: "",
  abstained: true,
  citations: [],
  provider: "mock",
  model: "",
};

/**
 * Recover the ledger id when runCapability could not hand one back (it swallows
 * ledger failures so the surface never goes down). Reads AS THE USER — RLS on
 * ai_interaction plus an explicit created_by filter mean this can only ever find
 * the caller's own most recent Brain row.
 */
async function latestOwnInteractionId(): Promise<string | null> {
  try {
    const supabase = await supabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase
      .from("ai_interaction")
      .select("id")
      .eq("capability_key", BRAIN_CAPABILITY_KEY)
      .eq("created_by", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** Ask the Brain one question under the caller's own session. Never throws. */
export async function askBrainQuestion(question: string): Promise<BrainAskResult> {
  const q = question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) return { ok: false, aiInteractionId: null, ...EMPTY };

  const supabase = await supabaseServer();
  const res = await askBrain(supabase, q);

  const aiInteractionId = res.interactionId ?? (await latestOwnInteractionId());
  return { ok: true, aiInteractionId, ...res };
}
