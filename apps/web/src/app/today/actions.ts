"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

/** Web EVV: record a clock in/out for a visit via the Lane-B RPC (assigned caregiver only,
 *  AAL2-enforced in the database). Location is captured client-side and passed through. */
export async function clockVisit(
  visitId: string,
  eventType: "clock_in" | "clock_out",
  coords: { lat: number; lng: number; acc: number } | null
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await supabaseServer();
  const { error } = await supabase.schema("app").rpc("clock_visit", {
    p_visit: visitId,
    p_event: eventType,
    p_lat: coords?.lat ?? null,
    p_lng: coords?.lng ?? null,
    p_accuracy: coords?.acc ?? null,
  });
  if (error) return { ok: false, error: "We couldn't save that. Nothing was lost — try again." };
  revalidatePath("/today");
  return { ok: true };
}
