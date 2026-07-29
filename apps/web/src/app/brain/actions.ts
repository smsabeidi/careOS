"use server";

import { supabaseServer } from "@/lib/supabase/server";
import { askBrain, type BrainAnswer } from "@/lib/ai/client";

export async function ask(question: string): Promise<{ ok: boolean } & BrainAnswer> {
  const q = question.trim().slice(0, 500);
  if (!q) {
    return { ok: false, answer: "", abstained: true, citations: [], provider: "mock", model: "" };
  }
  const supabase = await supabaseServer();
  const res = await askBrain(supabase, q);
  return { ok: true, ...res };
}
