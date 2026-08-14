"use server";

import { supabaseServer } from "@/lib/supabase/server";
import { askBrainQuestion, BRAIN_CAPABILITY_KEY, type BrainAskResult } from "@/lib/ai/brain-ask";
import {
  recordDisposition,
  type DispositionAction,
  type DispositionReason,
} from "@/lib/ai/client";

/** Every row this surface writes is keyed to this capability (docs/16 §3.2 registry rule). */
const CAPABILITY_KEY = BRAIN_CAPABILITY_KEY;

/**
 * The console derives its shape with `Awaited<ReturnType<typeof ask>>`, so this cannot
 * drift from the real return value. The body moved to lib/ai/brain-ask.ts when the
 * command bar became a second door onto the same path (ST-232) — one question path,
 * two surfaces, so the two can never answer the same question differently.
 */
export async function ask(question: string): Promise<BrainAskResult> {
  return askBrainQuestion(question);
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
