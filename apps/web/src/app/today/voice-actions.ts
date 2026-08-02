"use server";

/**
 * Voice-note dispositions (Wave 1 · G1, docs/16 §2.5). The T2 half of the loop:
 * the model proposed a draft, and here a licensed human disposes of it.
 *
 * Design rules this file holds to:
 *   · The draft is saved through the EXISTING forms engine — app.create_form (migration
 *     0006). No new write path, no direct table insert: version numbering, tenant pinning,
 *     AAL2, care-team authorization and the audit event all stay where they already live.
 *   · Deterministic fields are recomputed HERE from the visit record and overwrite whatever
 *     the browser sent (invariant 13). The client cannot set a visit date.
 *   · The template read under RLS is the only source of truth for which keys exist and what
 *     type each one is. Unknown keys are dropped; select values outside the template's own
 *     options are dropped. A draft can never carry a field the agency's template lacks.
 *   · Provenance travels in the version content under `_meta` (docs/16 §1: AI output enters
 *     the system as a form version carrying its ai_interaction_id). form_version has an
 *     `ai_interaction_id` COLUMN, but app.create_form takes no parameter for it and this
 *     lane has no insert grant — so the linkage lives in content rather than in a faked
 *     column. Wiring the column properly is an RPC change, proposed in the task result.
 *   · Every save records the human's disposition against the ledger row (docs/16 §3.2 —
 *     accepted vs edited is the training label). No note content is ever passed to the
 *     disposition: `edited_digest` stays null, because a caregiver's note is PHI and
 *     ai_disposition is a PHI-safe table.
 *   · A disposition failure never costs the caregiver their note. The record is saved first;
 *     the label is best-effort after it.
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { recordDisposition } from "@/lib/ai/client";

const CAPABILITY = "note.voice_draft";
const VISIT_NOTE_TEMPLATE_KEY = "visit_note";
const AGENCY_TZ = "America/New_York";
const MAX_FIELD_CHARS = 4000;

type FieldType = "text" | "textarea" | "date" | "select" | "boolean" | "number";
type TemplateField = { key: string; type: FieldType; options?: string[] };

export type SaveVoiceDraftResult =
  | { ok: true; instanceId: string }
  | { ok: false; error: string };

function agencyDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENCY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function isFieldType(v: unknown): v is FieldType {
  return (
    v === "text" || v === "textarea" || v === "date" ||
    v === "select" || v === "boolean" || v === "number"
  );
}

function parseFields(schema: unknown): TemplateField[] {
  const raw = (schema as { fields?: unknown })?.fields;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f): TemplateField | null => {
      const o = f as Record<string, unknown>;
      if (typeof o?.key !== "string" || !o.key) return null;
      return {
        key: o.key,
        type: isFieldType(o.type) ? o.type : "text",
        options: Array.isArray(o.options)
          ? o.options.filter((x): x is string => typeof x === "string")
          : undefined,
      };
    })
    .filter((f): f is TemplateField => f !== null);
}

/** Plain-language mapping of the RPC's stable error codes (docs/08 §2). Never leaks PHI. */
function friendly(message: string): string {
  if (message.includes("CAREOS_AAL2_REQUIRED"))
    return "Your verified session expired. Nothing was saved — sign in again with your authenticator, and the note is still on this screen.";
  if (message.includes("CAREOS_NOT_ON_CARE_TEAM"))
    return "You're not on this client's care team, so this note can't be filed under your account.";
  if (message.includes("CAREOS_NOT_FOUND"))
    return "The visit-note template isn't available for your agency. Your coordinator can publish it.";
  return "We couldn't save that note. Nothing was lost — it's still on this screen. Try again.";
}

/**
 * Save the reviewed draft as a new visit note (status draft, version 1) and record the
 * author's disposition of the AI draft.
 *
 * `edited` is the client's dirty flag: true when the author changed any section before
 * saving. It selects the disposition action — 'edited' vs 'accepted' — which is the label
 * the flywheel trains on. It has no effect on what is stored in the record itself.
 */
export async function saveVoiceDraft(input: {
  visitId: string;
  sections: Record<string, string>;
  aiInteractionId: string | null;
  edited: boolean;
}): Promise<SaveVoiceDraftResult> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in again to save this note." };

  const visitId = input.visitId?.trim();
  if (!visitId) return { ok: false, error: "This note isn't linked to a visit." };

  // Visit read is RLS-scoped (AAL2 + caregiver/care-team) — the same perimeter the
  // draft route used. It also supplies the deterministic visit date.
  const { data: visit } = await supabase
    .from("visit")
    .select("id, client_id, scheduled_start")
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) {
    return {
      ok: false,
      error:
        "We couldn't open that visit for your account. If your verified session expired, sign in again with your authenticator.",
    };
  }

  const { data: template } = await supabase
    .from("form_template")
    .select("id, schema")
    .eq("key", VISIT_NOTE_TEMPLATE_KEY)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fields = parseFields(template?.schema);
  if (!template || fields.length === 0) {
    return {
      ok: false,
      error: "The visit-note template isn't published for your agency yet, so there's nothing to save into.",
    };
  }

  // ── Content: template keys only, template types only, deterministic date server-side ──
  const submitted = input.sections ?? {};
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "date") {
      content[f.key] = agencyDate(visit.scheduled_start); // never from the client
      continue;
    }
    const raw = typeof submitted[f.key] === "string" ? submitted[f.key].trim() : "";
    if (!raw) continue; // an untouched section stays absent rather than storing a blank claim
    if (f.type === "select") {
      if (f.options?.includes(raw)) content[f.key] = raw;
      continue;
    }
    if (f.type === "boolean") {
      if (raw === "Yes") content[f.key] = true;
      else if (raw === "No") content[f.key] = false;
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) content[f.key] = n;
      continue;
    }
    content[f.key] = raw.slice(0, MAX_FIELD_CHARS);
  }

  // Provenance (docs/16 §1). Ids only — no transcript, no note text.
  content._meta = {
    source: "voice",
    capability: CAPABILITY,
    ai_interaction_id: input.aiInteractionId,
    visit_id: visitId,
    disposition: input.edited ? "edited" : "accepted",
    drafted_at: new Date().toISOString(),
  };

  const { data: instanceId, error } = await supabase.schema("app").rpc("create_form", {
    p_template: template.id,
    p_client: visit.client_id,
    p_content: content,
  });
  if (error || !instanceId) {
    return { ok: false, error: friendly(error?.message ?? "") };
  }

  // Flywheel label — best effort, after the record is safe. No content is passed.
  if (input.aiInteractionId) {
    await recordDisposition(
      supabase,
      input.aiInteractionId,
      CAPABILITY,
      input.edited ? "edited" : "accepted"
    );
  }

  revalidatePath("/today");
  return { ok: true, instanceId: String(instanceId) };
}

/**
 * The author threw the draft away. Nothing was written to the chart, but the rejection is
 * exactly the signal the flywheel most needs (docs/16 §3.2), so it is recorded against the
 * ledger row. Never throws: a lost label must not turn into an error on a discard.
 */
export async function discardVoiceDraft(
  aiInteractionId: string | null
): Promise<{ ok: boolean }> {
  if (!aiInteractionId) return { ok: true };
  const supabase = await supabaseServer();
  const res = await recordDisposition(supabase, aiInteractionId, CAPABILITY, "rejected");
  return { ok: res.ok };
}
