"use server";

/**
 * PDF form import — the server half (ST-237, Front Door W4).
 *
 * TWO ACTIONS, AND THE LINE BETWEEN THEM IS THE WHOLE DESIGN.
 *
 *   1. `importFormStructure` sends the text a page already carries to `form.import_pdf`
 *      through lib/ai/client.ts (invariant 10) and returns a DRAFT for a person to read.
 *      It writes nothing. The raw file never reaches this process — the browser extracted
 *      the text and the file stayed on the coordinator's computer (program plan R3/3A).
 *
 *   2. `saveDraftTemplate` files what the reviewer approved of that draft as an inert
 *      `ai_proposal` row. It creates no form, no template and no version.
 *
 * WHERE THE DRAFT IS FILED, AND WHY IT IS NOT A `form_template` ROW — READ THIS BEFORE
 * "FIXING" IT. The story called for the existing template-authoring path. There is none:
 * `public.form_template` has SELECT and nothing else (migration 0005 — "Template authoring
 * is a config-audited admin RPC (later story) — no write grants"), migration 0017 attached
 * `forbid_mutation` to it, and no RPC in the repo has ever written it. Inventing one here
 * would mean new DDL, a new grant and a new definer function on the table whose immutability
 * a signed 2026 record depends on — exactly the thing invariant 2 and D-011 exist to stop.
 *
 * So the draft lands where a T2 capability's output is supposed to land: `ai_proposal`,
 * append-only, self-pinned, AAL2-gated, disposed by a human on the existing approvals
 * surface (invariant 8). `form.import_pdf` is registered T2 with `requires_human = true`
 * (0057), so this is not a workaround — it is the posture the registry already declares.
 * `triageReferral` in /office/intake files its output the same way, so this is the house
 * pattern rather than a new one. Publishing a design as a usable form remains the human
 * act it always was, and the UI says so in those words rather than implying a form exists.
 * When the template-authoring RPC lands, approval of one of these proposals is what should
 * call it — the row already carries the whole structure.
 *
 * PHI POSTURE (invariant 5). `toImportPromptFacts` IS the declared allowlist for this
 * capability: a page count and the extracted text, which is what 0057's registered prompt
 * says it receives ("the extracted text of one paper form"). The ledger digest carries
 * counts only — never a label, never a line of the document. The surface tells the
 * coordinator, above the picker, that the page text is sent and that blank forms are what
 * this is for, because a filled form's text is a client's details.
 *
 * AUDIT. `app.emit_audit` has no client grant (migration 0003 — definer-owned RPCs only),
 * so the append-only `ai_proposal` row, its `ai_interaction_id` and the ledger row behind
 * it are the record of what happened. Every model call — including the blocked and failed
 * ones — is one `ai_interaction` row, written by `runCapability`.
 *
 * @trace ST-237, docs/designs/intelligent-front-door.md W4, migration 0057, invariants 1,
 *        5, 8, 10
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { digest, runCapability } from "@/lib/ai/client";
import {
  draftOutline,
  parseImportedStructure,
  summarizeDraft,
  type DraftSection,
  type FormDraft,
} from "./detect";

/* Not exported: a "use server" module may export async functions and types only, so a
 * shared constant here would be a build error rather than a convenience. */
const CAPABILITY = "form.import_pdf";

/** Enough for a long agency form; short enough that one call stays predictable. */
const MAX_PROMPT_CHARS = 24_000;
const MAX_SOURCE_NAME = 120;

export type ImportResult = {
  ok: boolean;
  draft: FormDraft | null;
  /** Honest sentence when the conversion could not run or came back unusable. */
  notice: string | null;
  interactionId: string | null;
};

export type SaveResult = {
  ok: boolean;
  proposalId: string | null;
  /** Plain-language refusal. Never carries a line of the document. */
  error?: string;
};

type Ctx = {
  supabase: Awaited<ReturnType<typeof supabaseServer>>;
  userId: string;
  tenantId: string;
};

async function ctx(): Promise<Ctx | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: me } = await supabase
    .from("app_user")
    .select("tenant_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.tenant_id) return null;
  return { supabase, userId: user.id, tenantId: me.tenant_id as string };
}

/**
 * The PHI minimizer for `form.import_pdf`. This object IS the declared allowlist: the
 * page count, and the text the browser read off the pages. No file, no bytes, no
 * filename, no client, no user, nothing else.
 */
function toImportPromptFacts(pageCount: number, text: string): Record<string, unknown> {
  return { page_count: pageCount, extracted_text: text.slice(0, MAX_PROMPT_CHARS) };
}

/* ── 1. Convert: extracted text in, a draft structure out ─────────────────────── */

/**
 * Run the structure extraction. Never throws; every degrade path returns `ok: false` with
 * a sentence that says what happened, what was kept (nothing) and what to do next.
 *
 * There is deliberately no `responseFormat` here. OpenAI's strict json_schema mode cannot
 * express 0057's `confidence` object — an open map keyed by field label — without changing
 * the registered contract, and the registered contract is what the eval gate exercises.
 * The guarantee is kept where it belongs instead: `parseImportedStructure` is a total
 * function that turns anything but a well-formed structure into null, so a chatty or
 * malformed completion produces the honest "we couldn't turn that into fields" state
 * rather than a half-built form.
 */
export async function importFormStructure(input: {
  sourceName: string;
  pageCount: number;
  text: string;
}): Promise<ImportResult> {
  const c = await ctx();
  if (!c) {
    return {
      ok: false,
      draft: null,
      notice: "Your session ended. Sign in again — the file is still on your computer and nothing was sent.",
      interactionId: null,
    };
  }

  const text = (input.text ?? "").trim();
  const pageCount = Math.max(0, Math.min(200, Math.round(input.pageCount || 0)));
  if (text.length === 0) {
    return {
      ok: false,
      draft: null,
      notice: "No text came off those pages, so there was nothing to convert. Nothing was sent or saved.",
      interactionId: null,
    };
  }

  const facts = toImportPromptFacts(pageCount, text);

  const run = await runCapability(c.supabase, CAPABILITY, {
    // The ACTIVE registry prompt (ai_prompt_template · form.import_pdf v1, migration 0057)
    // overrides this. It exists only so an environment without that row still behaves.
    system:
      "You are the CareOS form-structure extractor. You reconstruct a blank form's structure from " +
      "extracted text and output one JSON object and nothing else: " +
      '{"sections":[{"title":"…","fields":[{"label":"…","type":"text|date|time|checkbox|radio|signature","options":["…"]}]}],' +
      '"confidence":{"<field label>":0.0-1.0}}. Structure only, never a filled-in value. Never invent a ' +
      'field the text does not contain. If there is no recognizable structure, output {"sections": [], "confidence": {}}.',
    user:
      `Extracted text of one paper form, ${pageCount} page${pageCount === 1 ? "" : "s"}:\n` +
      `"""\n${String(facts.extracted_text)}\n"""`,
    temperature: 0,
    maxToolRounds: 0,
    // PHI-safe (invariant 5): counts only. Not one label, not one line of the document.
    inputDigest: digest(
      `form import · ${pageCount} pages · ${text.length} characters of extracted text`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    detectAbstain: (out) => out.trim().length === 0,
  });

  const draft = run.status === "ok" ? parseImportedStructure(run.text) : null;

  if (!draft) {
    return {
      ok: false,
      draft: null,
      interactionId: run.interactionId,
      notice:
        run.status === "blocked" && run.reason === "budget"
          ? "Converting forms is paused for this month — this capability's budget is spent. Nothing was saved, and your file is untouched on your computer."
          : run.status === "blocked"
            ? "Converting forms is switched off for this agency, so this file was not converted. Nothing was saved, and your file is untouched on your computer."
            : "We read the pages but couldn't turn them into fields. Nothing was guessed and nothing was saved — try again, or build the form by hand.",
    };
  }

  if (draft.fieldCount === 0) {
    return {
      ok: false,
      draft,
      interactionId: run.interactionId,
      notice:
        "No form structure was recognised in that file — no sections and no fields. Nothing was saved. If it is a form, check that the text is selectable in your PDF reader.",
    };
  }

  return { ok: true, draft, notice: null, interactionId: run.interactionId };
}

/* ── 2. File the reviewed draft. It creates no form. ──────────────────────────── */

/**
 * File the reviewer's version of the draft as an inert proposal.
 *
 * `created_by` is pinned to the caller because the RLS insert policy requires it
 * (`ai_proposal_insert_self`, migration 0016): a design is filed by the person who
 * reviewed it, never on a colleague's behalf. The row is append-only; there is no edit
 * path and none is wanted — a second review is a second row.
 */
export async function saveDraftTemplate(input: {
  sourceName: string;
  pageCount: number;
  sections: DraftSection[];
  interactionId: string | null;
}): Promise<SaveResult> {
  const c = await ctx();
  if (!c) return { ok: false, proposalId: null, error: "Your session ended. Sign in again — nothing was saved." };

  const sections = Array.isArray(input.sections) ? input.sections : [];
  const draft = summarizeDraft(sections);
  if (draft.fieldCount === 0) {
    return {
      ok: false,
      proposalId: null,
      error: "There are no fields in this draft to save. Add at least one field, or start again from the file.",
    };
  }

  const sourceName = (input.sourceName || "a PDF").slice(0, MAX_SOURCE_NAME);
  const title =
    `Form design from ${sourceName} — ${draft.sections.length} section` +
    `${draft.sections.length === 1 ? "" : "s"}, ${draft.fieldCount} field` +
    `${draft.fieldCount === 1 ? "" : "s"}`;

  const { data, error } = await c.supabase
    .from("ai_proposal")
    .insert({
      tenant_id: c.tenantId,
      capability_key: CAPABILITY,
      kind: "draft",
      subject_type: "form_template",
      subject_id: null,
      title,
      body: draftOutline(draft, sourceName),
      payload: {
        source_name: sourceName,
        page_count: Math.max(0, Math.min(200, Math.round(input.pageCount || 0))),
        field_count: draft.fieldCount,
        check_count: draft.checkCount,
        sections: draft.sections.map((s) => ({
          title: s.title,
          fields: s.fields.map((f) => ({
            label: f.label,
            type: f.type,
            options: f.options,
            confidence: f.confidence,
            needs_check: f.needsCheck,
          })),
        })),
      },
      rationale:
        "Structure read from a digital-text PDF and edited by a reviewer. It is a design, not a form: " +
        "no template, version or record was created, and publishing it as a usable form remains a human act.",
      ai_interaction_id: input.interactionId,
      created_by: c.userId,
    })
    .select("id")
    .single();

  if (error) {
    // RLS or AAL2 refused. Say which, in the reader's language, and never echo the row.
    const message = error.message ?? "";
    if (/aal2|row-level security|permission/i.test(message)) {
      return {
        ok: false,
        proposalId: null,
        error:
          "This account can't file a form design. Filing one needs a verified (MFA) session and the access an owner or administrator grants. Nothing was saved — your edits are still on this screen.",
      };
    }
    return {
      ok: false,
      proposalId: null,
      error: "That draft couldn't be filed just now. Nothing was saved — your edits are still on this screen, so try again.",
    };
  }

  revalidatePath("/office/forms");
  return { ok: true, proposalId: (data as { id: string } | null)?.id ?? null };
}
