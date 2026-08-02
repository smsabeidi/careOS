"use server";

import { supabaseServer } from "@/lib/supabase/server";
import {
  askBrain,
  recordDisposition,
  type BrainAnswer,
  type DispositionAction,
  type DispositionReason,
} from "@/lib/ai/client";

/** Every row this surface writes is keyed to this capability (docs/16 §3.2 registry rule). */
const CAPABILITY_KEY = "brain.answer";

/**
 * Not exported: a "use server" module's runtime exports must all be async functions,
 * and the console derives this shape with `Awaited<ReturnType<typeof ask>>` instead —
 * which cannot drift from the real return value.
 */
type AskResult = {
  ok: boolean;
  /**
   * The ledger row this answer came from. The disposition bar needs it to key the
   * human's label to the exact model + prompt_version that produced the answer —
   * without it, the pair is untrainable (docs/16 §3.2: "no pair is useful unless it
   * answers which template version and model produced this?"). Null only when the
   * ledger write itself failed, and the UI degrades honestly in that case.
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
      .eq("capability_key", CAPABILITY_KEY)
      .eq("created_by", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

export async function ask(question: string): Promise<AskResult> {
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, aiInteractionId: null, ...EMPTY };

  const supabase = await supabaseServer();
  const res = await askBrain(supabase, q);

  const aiInteractionId = res.interactionId ?? (await latestOwnInteractionId());
  return { ok: true, aiInteractionId, ...res };
}

/**
 * Record the asker's disposition of a Brain answer (invariant 8: AI proposes, a human
 * disposes). Append-only by construction — ai_disposition has no update or delete path,
 * and the insert is self-pinned by RLS, so a person can only ever label their own answer.
 *
 * Failures are returned, never thrown: losing a label must not cost the reader the answer
 * they already have on screen.
 */
export async function disposeBrainAnswer(
  aiInteractionId: string,
  action: DispositionAction,
  reason?: DispositionReason,
  editedText?: string
): Promise<{ ok: boolean; error?: string }> {
  const id = aiInteractionId?.trim();
  if (!id) return { ok: false, error: "This answer has no ledger record to attach feedback to." };

  const supabase = await supabaseServer();
  // recordDisposition digests editedText again on the way in — raw text never lands.
  const res = await recordDisposition(
    supabase,
    id,
    CAPABILITY_KEY,
    action,
    reason,
    editedText?.trim() || undefined
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "Feedback could not be saved." };
}
