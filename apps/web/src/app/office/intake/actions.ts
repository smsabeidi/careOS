"use server";

/**
 * Intake desk server actions — Wave 3 "paper becomes chart" (docs/16 §2.3 C6, C7; §4 Wave 3).
 *
 * What this module is responsible for, and what it deliberately refuses to do:
 *
 *   · It NEVER commits a chart on the model's word. Extraction writes `extraction_field`
 *     rows that hold what the model read; a person accepts or corrects each one, and only
 *     then does `commitIntake` create anything (invariant 8, T2 — docs/16 C6 "never
 *     auto-commit"). The extracted value is immutable by construction: migration 0016
 *     grants UPDATE on (accepted, accepted_value, accepted_by, accepted_at) and nothing
 *     else, with a guard trigger underneath the grant.
 *
 *   · It never asks a model anything deterministic. Which fields exist, what a payer type
 *     may be, what a chart needs before it can be opened, and what a referral is missing
 *     are rules in this file and CHECK constraints in the database — never a judgment
 *     (invariant 13). The model reads paper; the platform decides what the reading means.
 *
 *   · Every model call rides `runCapability` (invariant 10): registry model pin, kill
 *     switch, budget gate, registry-versioned prompt, and one `ai_interaction` ledger row
 *     per call — including the failures. Digests carry counts and id prefixes, never a
 *     name, an address, or a member number (invariant 5).
 *
 *   · Everything degrades. With the model off, over budget, or returning 429, the desk
 *     still files the job with what happened to it, and points the coordinator at manual
 *     entry. AI is an accelerant here, never a dependency (docs/16 §6 blast-radius).
 *
 * KNOWN GAP (raised, not silently accepted): page images are read by a direct vision call
 * in `readPages` below rather than through lib/ai/client.ts, because the chokepoint exposes
 * no image helper yet — the same gap the voice-note route documented for audio. It is kept
 * as narrow as possible: the kill switch and the budget are checked BEFORE the call, the
 * vision spend is folded into the capability's ledger row via `extraCostUsd`, and every
 * decision about what the text MEANS happens inside `runCapability`. One consequence is
 * recorded here rather than hidden: when the vision leg itself fails (429, timeout), there
 * is no chokepoint call to ledger, so the failure lands on the `extraction_job` row
 * (status = failed) and in the audit event, not in `ai_interaction`. The correct home is a
 * `runVisionCapability()` in lib/ai/client.ts; proposed in the task result, not built here
 * (that file belongs to another surface this sprint).
 *
 * Vendor note: page images and referral text go to OpenAI. Synthetic (Meadowbrook) universe
 * only until the BAA is executed and registered in docs/09 §6 (docs/16 §3.5) — the UI says
 * so above every upload and paste box.
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { digest, runCapability } from "@/lib/ai/client";
import { getCapability } from "@/lib/ai/registry";

/* ── Wire types (imported type-only by the page and the client component) ────── */

export type IntakeKind = "intake_packet" | "credential_doc";

export type UploadedPage = {
  name: string;
  mime: string;
  /** data:image/…;base64,… — produced client-side, never written to disk here. */
  dataUrl: string;
};

export type ExtractedField = {
  id: string;
  field_key: string;
  /** Human label resolved from the catalog server-side, so no surface re-derives it. */
  label: string;
  extracted_value: string | null;
  confidence: number | null;
  page_ref: number | null;
  accepted_value: string | null;
  accepted: boolean | null;
};

export type ExtractionJobView = {
  id: string;
  kind: string;
  source_name: string | null;
  page_count: number | null;
  status: string;
  client_id: string | null;
  created_at: string;
  fields: ExtractedField[];
  /** Honest one-liner when the pages could not be read. null when extraction succeeded. */
  notice: string | null;
};

export type ExtractionResult = {
  ok: boolean;
  job: ExtractionJobView | null;
  /** Plain-language failure for the surface. Never carries document content. */
  error?: string;
};

export type TriageUrgency = "urgent" | "soon" | "routine";

export type TriageResult = {
  ok: boolean;
  /** null when no model was available to rank it — the checklist still stands. */
  urgency: TriageUrgency | null;
  summary: string | null;
  serviceFit: string | null;
  nextStep: string | null;
  /** Deterministic completeness checklist — computed here, always present. */
  missing: string[];
  present: string[];
  /** true ⇒ the model half is absent; the deterministic half is what you see. */
  degraded: boolean;
  notice: string | null;
  /** ai_proposal row id when the triage was filed to the approvals inbox. */
  proposalId: string | null;
  error?: string;
};

/* ── Deterministic field catalogs — the schema the model may fill, and no more ── */

type FieldSpec = { key: string; label: string; hint: string };

const INTAKE_FIELDS: FieldSpec[] = [
  { key: "client.first_name", label: "First name", hint: "given name of the person to be served" },
  { key: "client.last_name", label: "Last name", hint: "family name of the person to be served" },
  { key: "client.dob", label: "Date of birth", hint: "YYYY-MM-DD, exactly as printed" },
  { key: "client.address_line1", label: "Address", hint: "street address of the service location" },
  { key: "client.city", label: "City", hint: "" },
  { key: "client.state", label: "State", hint: "two-letter abbreviation" },
  { key: "client.zip", label: "ZIP", hint: "" },
  { key: "client.primary_phone", label: "Phone", hint: "as printed, including area code" },
  { key: "client.primary_language", label: "Primary language", hint: "e.g. en, es" },
  { key: "payer.type", label: "Payer", hint: "one of: private, medicaid, ltc_insurance, va, other" },
  { key: "payer.member_id", label: "Member or policy number", hint: "character for character" },
  { key: "referral.source", label: "Referral source", hint: "the organization or person referring" },
  { key: "referral.requested_start", label: "Requested start", hint: "YYYY-MM-DD if a date is stated" },
  { key: "referral.contact_name", label: "Referral contact", hint: "who to call back" },
  { key: "referral.contact_phone", label: "Contact phone", hint: "" },
];

const CREDENTIAL_FIELDS: FieldSpec[] = [
  { key: "credential.holder_name", label: "Holder", hint: "the name printed on the document" },
  { key: "credential.type", label: "Document type", hint: "e.g. CNA certification, CPR card, TB screening" },
  { key: "credential.number", label: "License or certificate number", hint: "character for character" },
  { key: "credential.issuer", label: "Issued by", hint: "the issuing board, school, or clinic" },
  { key: "credential.issued_on", label: "Issued on", hint: "YYYY-MM-DD as printed" },
  { key: "credential.expires_on", label: "Expires on", hint: "YYYY-MM-DD as printed" },
];

const ALL_SPECS = [...INTAKE_FIELDS, ...CREDENTIAL_FIELDS];

function fieldsFor(kind: IntakeKind): FieldSpec[] {
  return kind === "credential_doc" ? CREDENTIAL_FIELDS : INTAKE_FIELDS;
}

/** Label for a stored field key. Unknown keys (an older catalog) degrade readably. */
function labelFor(key: string): string {
  const known = ALL_SPECS.find((f) => f.key === key);
  if (known) return known.label;
  const tail = key.split(".").pop() ?? key;
  const words = tail.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ── Limits (a phone-camera page is ~250KB after the client downscales it) ────── */

const MAX_PAGES = 6;
/** Server-action bodies are ~1MB by default; the client downscales to stay inside it. */
const MAX_TOTAL_BYTES = 950_000;
const VISION_TIMEOUT_MS = 60_000;
const CAPABILITY = "intake.extract";
const TRIAGE_CAPABILITY = "referral.triage";

/** Per-1M token pricing for the direct vision leg (docs/16 §3.1). */
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "gpt-5.6-terra": { in: 2, out: 12 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

function visionCost(model: string, tokensIn: number, tokensOut: number): number {
  const price =
    Object.entries(PRICE_PER_M).find(([prefix]) => model.startsWith(prefix))?.[1] ??
    PRICE_PER_M["gpt-5.6-terra"];
  return (tokensIn / 1e6) * price.in + (tokensOut / 1e6) * price.out;
}

/* ── Identity helper (user-scoped; invariant 6) ──────────────────────────────── */

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

/* ── Reads ───────────────────────────────────────────────────────────────────── */

const JOB_COLUMNS = "id, kind, source_name, page_count, status, client_id, created_at";
const FIELD_COLUMNS = "id, field_key, extracted_value, confidence, page_ref, accepted_value, accepted";

type FieldRow = Omit<ExtractedField, "label">;

async function loadJob(c: Ctx, jobId: string, notice: string | null): Promise<ExtractionJobView | null> {
  const { data: job } = await c.supabase
    .from("extraction_job")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;
  const { data: fields } = await c.supabase
    .from("extraction_field")
    .select(FIELD_COLUMNS)
    .eq("job_id", jobId)
    .order("field_key");
  return {
    ...(job as Omit<ExtractionJobView, "fields" | "notice">),
    fields: ((fields ?? []) as FieldRow[]).map((f) => ({ ...f, label: labelFor(f.field_key) })),
    notice,
  };
}

/** Re-read one job for the client after a mutation. */
export async function refreshJob(jobId: string): Promise<ExtractionJobView | null> {
  const c = await ctx();
  if (!c) return null;
  return loadJob(c, jobId, null);
}

/* ── The vision leg: pages in, plain text out. No interpretation happens here. ── */

const OCR_SYSTEM =
  "You are a document reader. Transcribe the text that is printed or handwritten on each page, " +
  "line by line, in reading order. Prefix each page with 'Page N:'. Copy names, dates, and numbers " +
  "character for character. Never summarize, never infer, never fill in anything that is not on the " +
  "page. If a page is blank or illegible, write 'Page N: unreadable'.";

async function readPages(
  apiKey: string,
  model: string,
  pages: UploadedPage[]
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const content: Record<string, unknown>[] = [
    {
      type: "text",
      text: `Transcribe these ${pages.length} page${pages.length === 1 ? "" : "s"} of a scanned document.`,
    },
    // detail: "original" is the OCR / small-text setting (docs/16 §3.1 Vision).
    ...pages.map((p) => ({ type: "image_url", image_url: { url: p.dataUrl, detail: "original" } })),
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: OCR_SYSTEM },
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
  };
}

/** Strict per-doc-type schema: the model may only name keys the catalog defines. */
function extractionSchema(specs: FieldSpec[]): { name: string; schema: Record<string, unknown> } {
  return {
    name: "document_extraction",
    schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", enum: specs.map((s) => s.key) },
              value: { type: ["string", "null"] },
              confidence: { type: "number" },
              page: { type: ["integer", "null"] },
            },
            required: ["key", "value", "confidence", "page"],
            additionalProperties: false,
          },
        },
        refusal: { type: ["string", "null"] },
      },
      required: ["fields", "refusal"],
      additionalProperties: false,
    },
  };
}

type ModelField = { key: string; value: string; confidence: number; page: number | null };

function parseExtraction(
  text: string,
  specs: FieldSpec[]
): { fields: ModelField[]; refusal: string | null } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as { fields?: unknown; refusal?: unknown };
    const allowed = new Set(specs.map((s) => s.key));
    const seen = new Set<string>();
    const fields: ModelField[] = Array.isArray(o.fields)
      ? o.fields
          .map((raw): ModelField | null => {
            const f = raw as Record<string, unknown>;
            const key = typeof f?.key === "string" ? f.key : "";
            if (!allowed.has(key) || seen.has(key)) return null;
            // A field the pages did not carry is simply absent — never an empty row.
            const value = typeof f.value === "string" ? f.value.trim().slice(0, 500) : "";
            if (!value) return null;
            seen.add(key);
            const c = typeof f.confidence === "number" && Number.isFinite(f.confidence) ? f.confidence : 0;
            const page = typeof f.page === "number" && Number.isFinite(f.page) ? Math.trunc(f.page) : null;
            return { key, value, confidence: Math.min(1, Math.max(0, c)), page };
          })
          .filter((f): f is ModelField => f !== null)
      : [];
    return {
      fields,
      refusal: typeof o.refusal === "string" && o.refusal.trim() ? o.refusal.trim() : null,
    };
  } catch {
    return null;
  }
}

/* ── 1. Extraction ───────────────────────────────────────────────────────────── */

/**
 * Open an extraction job for the uploaded pages and read them.
 *
 * The job row is written on every path, success or failure: that a packet arrived, who
 * opened it, how many pages, and what became of it is a record of consequence whether or
 * not a model was reachable. It is written AFTER the read so the row can carry its
 * `ai_interaction_id` — the column is insert-only by design (0016), and the provenance
 * link is what makes the correction pairs trainable (docs/16 §3.2).
 */
export async function runIntakeExtraction(input: {
  kind: IntakeKind;
  sourceName: string;
  pages: UploadedPage[];
}): Promise<ExtractionResult> {
  const c = await ctx();
  if (!c) return { ok: false, job: null, error: "Sign in again to open an intake job." };

  const kind: IntakeKind = input.kind === "credential_doc" ? "credential_doc" : "intake_packet";
  const pages = (input.pages ?? [])
    .slice(0, MAX_PAGES)
    .filter((p) => typeof p?.dataUrl === "string" && p.dataUrl.startsWith("data:image/"));
  if (pages.length === 0) {
    return { ok: false, job: null, error: "Add at least one page image before reading a document." };
  }
  const totalBytes = pages.reduce((n, p) => n + p.dataUrl.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      job: null,
      error:
        "Those pages are too large to send in one go. Try fewer pages, or retake them at a smaller size.",
    };
  }

  const sourceName = (input.sourceName || pages[0]?.name || "Uploaded document").slice(0, 160);

  /** File the job with what actually happened, then hand the surface a clean view. */
  const fileJob = async (
    status: "extracted" | "failed",
    aiInteractionId: string | null,
    notice: string | null,
    fields: ModelField[]
  ): Promise<ExtractionResult> => {
    const { data: created, error: jobError } = await c.supabase
      .from("extraction_job")
      .insert({
        tenant_id: c.tenantId,
        kind,
        source_name: sourceName,
        page_count: pages.length,
        status,
        ai_interaction_id: aiInteractionId,
        created_by: c.userId,
      })
      .select("id")
      .single();

    if (jobError || !created) {
      return {
        ok: false,
        job: null,
        error:
          "Your account can't open an intake job. Reading documents into a chart needs the client-records permission — an owner or administrator can run this, or grant it to you.",
      };
    }
    const jobId = (created as { id: string }).id;

    let filedNotice = notice;
    if (fields.length > 0) {
      const { error: fieldError } = await c.supabase.from("extraction_field").insert(
        fields.map((f) => ({
          tenant_id: c.tenantId,
          job_id: jobId,
          field_key: f.key,
          extracted_value: f.value,
          confidence: Number(f.confidence.toFixed(3)),
          page_ref: f.page,
        }))
      );
      if (fieldError) {
        await c.supabase.from("extraction_job").update({ status: "failed" }).eq("id", jobId);
        filedNotice =
          "We read the pages but couldn't file the results for review. Nothing was written to a chart — try again, or enter the details by hand.";
      }
    }

    revalidatePath("/office/intake");
    return { ok: true, job: await loadJob(c, jobId, filedNotice) };
  };

  // Governance before spend: kill switch and budget gate the expensive leg (docs/16 §6).
  const entry = await getCapability(c.supabase, CAPABILITY);
  if (!entry.enabled) {
    return fileJob(
      "failed",
      null,
      "Automatic reading is switched off for this agency, so these pages were not read. The job is on file — enter the details by hand and the record is exactly as complete.",
      []
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fileJob(
      "failed",
      null,
      "Reading a document needs model access, which isn't configured here. Nothing was lost — the pages are still in this tab and the chart can be entered by hand.",
      []
    );
  }

  // Leg 1 — the pages become text (direct vision call; see the KNOWN GAP note above).
  let pageText = "";
  let visionSpend = 0;
  try {
    const read = await readPages(apiKey, entry.model, pages);
    pageText = read.text.trim();
    visionSpend = visionCost(entry.model, read.tokensIn, read.tokensOut);
  } catch {
    return fileJob(
      "failed",
      null,
      "We couldn't read those pages just now — the document reader is unavailable. The job is on file with its page count; enter the details by hand, or try again later.",
      []
    );
  }
  if (!pageText) {
    return fileJob(
      "failed",
      null,
      "No text came back from those pages. Retake them with more light, or enter the details by hand.",
      []
    );
  }

  // Leg 2 — what the text MEANS, through the governed chokepoint (invariant 10).
  const specs = fieldsFor(kind);
  const fieldSpec = specs.map((s) => `- ${s.key} — "${s.label}"${s.hint ? `. ${s.hint}` : ""}`).join("\n");

  const run = await runCapability(c.supabase, CAPABILITY, {
    // The ACTIVE registry prompt (ai_prompt_template · intake.extract v1) overrides this;
    // it exists only so a pre-0015 environment still behaves.
    system:
      "You are the CareOS intake extractor. Return only JSON matching the schema. Extract only what " +
      "is literally on the page, copy identifiers character for character, use null when a field is " +
      "absent or illegible, and report an honest confidence per field. Every extraction is a draft " +
      "for human review.",
    user:
      `Document type: ${kind === "credential_doc" ? "credential document" : "intake or referral packet"}\n\n` +
      `Target fields — use these keys and no others:\n${fieldSpec}\n\n` +
      `Page text transcribed from ${pages.length} page${pages.length === 1 ? "" : "s"}:\n"""\n` +
      `${pageText.slice(0, 24000)}\n"""`,
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: extractionSchema(specs),
    // PHI-safe (invariant 5): counts and an id prefix. Not one value from the document.
    inputDigest: digest(
      `intake extraction · ${kind} · ${pages.length} pages · ${specs.length} target fields`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
    extraCostUsd: Number(visionSpend.toFixed(6)),
  });

  const parsed = run.status === "ok" ? parseExtraction(run.text, specs) : null;

  if (!parsed) {
    return fileJob(
      "failed",
      run.interactionId,
      run.status === "blocked" && run.reason === "budget"
        ? "Automatic reading is paused for this month — the extraction budget for this capability is spent. The job is on file; enter the details by hand."
        : run.status === "blocked"
          ? "Automatic reading is switched off, so these pages were not turned into fields. The job is on file; enter the details by hand."
          : "We read the pages but couldn't turn them into fields. Nothing was guessed and nothing was saved to a chart — enter the details by hand, or try again.",
      []
    );
  }

  if (parsed.refusal || parsed.fields.length === 0) {
    return fileJob(
      "failed",
      run.interactionId,
      parsed.refusal
        ? `The reader didn't recognize this as a ${kind === "credential_doc" ? "credential document" : "referral or intake packet"}. Check the pages, or enter the details by hand.`
        : "Nothing readable matched the fields we collect for this document type. Enter the details by hand.",
      []
    );
  }

  // The model's reading lands as immutable rows, awaiting a person.
  return fileJob("extracted", run.interactionId, null, parsed.fields);
}

/* ── 2. Human review — the only path that decides anything ───────────────────── */

/**
 * Accept (or un-accept) one field with the value the human approves.
 *
 * The column-scoped grant means this statement CANNOT touch `extracted_value`,
 * `confidence`, or `page_ref` even if it tried: what the model read stays on the record
 * next to what the person decided, forever (invariant 1).
 */
export async function acceptField(
  fieldId: string,
  acceptedValue: string,
  accepted: boolean
): Promise<{ ok: boolean; error?: string }> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Sign in again to review this document." };

  const value = (acceptedValue ?? "").trim().slice(0, 500);
  if (accepted && !value) {
    return { ok: false, error: "Give the field a value before accepting it, or mark it not used." };
  }

  // `.select()` matters: an UPDATE a policy filters out affects zero rows and returns NO
  // error. Without asking for the rows back, a coordinator without `client.write` would be
  // told their decision was saved when Postgres quietly declined it.
  const { data, error } = await c.supabase
    .from("extraction_field")
    .update(
      accepted
        ? {
            accepted: true,
            accepted_value: value,
            accepted_by: c.userId,
            accepted_at: new Date().toISOString(),
          }
        : {
            accepted: false,
            accepted_value: null,
            accepted_by: c.userId,
            accepted_at: new Date().toISOString(),
          }
    )
    .eq("id", fieldId)
    .select("id");

  if (error || !data || data.length === 0) {
    return {
      ok: false,
      error:
        "That decision couldn't be saved. Reviewing an extraction needs the client-records permission — nothing on the record changed.",
    };
  }
  revalidatePath("/office/intake");
  return { ok: true };
}

/** Threshold for the "accept all high-confidence" sweep. Everything else stays manual. */
const HIGH_CONFIDENCE = 0.9;

/**
 * Accept every still-undecided field the model was highly confident about.
 * A sweep, not an auto-commit: the person pressed the button, it is recorded as their
 * acceptance, and the low- and medium-confidence fields still need them one by one.
 */
export async function acceptHighConfidence(
  jobId: string
): Promise<{ ok: boolean; accepted: number; error?: string }> {
  const c = await ctx();
  if (!c) return { ok: false, accepted: 0, error: "Sign in again to review this document." };

  const { data: rows } = await c.supabase
    .from("extraction_field")
    .select("id, extracted_value, confidence")
    .eq("job_id", jobId)
    .is("accepted", null);

  const candidates = ((rows ?? []) as { id: string; extracted_value: string | null; confidence: number | null }[])
    .filter((r) => (r.confidence ?? 0) >= HIGH_CONFIDENCE && (r.extracted_value ?? "").trim().length > 0);
  if (candidates.length === 0) return { ok: true, accepted: 0 };

  const stamp = new Date().toISOString();
  let accepted = 0;
  for (const r of candidates) {
    const { data, error } = await c.supabase
      .from("extraction_field")
      .update({
        accepted: true,
        accepted_value: (r.extracted_value ?? "").trim(),
        accepted_by: c.userId,
        accepted_at: stamp,
      })
      .eq("id", r.id)
      .select("id"); // a policy-filtered update is 0 rows and no error — count rows, not errors
    if (!error && data && data.length > 0) accepted += 1;
  }

  if (accepted === 0) {
    return {
      ok: false,
      accepted: 0,
      error:
        "Those fields couldn't be accepted. Reviewing an extraction needs the client-records permission — nothing on the record changed.",
    };
  }
  revalidatePath("/office/intake");
  return { ok: true, accepted };
}

/* ── 3. Commit — a person's decision becomes a chart ─────────────────────────── */

/** The payer enum is a database CHECK constraint; the model's guess is filtered by it. */
const PAYER_TYPES = new Set(["private", "medicaid", "ltc_insurance", "va", "other"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CommitResult = {
  ok: boolean;
  clientId?: string;
  message?: string;
  error?: string;
};

/**
 * Turn the accepted fields into a chart. Nothing here reads the model's values — only the
 * values a person accepted, because acceptance is the decision (docs/16 C6).
 *
 * An intake packet opens a client record in `inquiry` status: the chart exists, the office
 * can work it, and admission stays a human decision made elsewhere. A credential document
 * is recorded as reviewed and handed to the credentials desk — expiry math and eligibility
 * belong to the SQL engine, never to a document reader (invariant 13).
 */
export async function commitIntake(jobId: string): Promise<CommitResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Sign in again to commit this document." };

  const { data: job } = await c.supabase
    .from("extraction_job")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "We couldn't open that job for your account." };
  const j = job as { id: string; kind: string; status: string; client_id: string | null };

  if (j.status === "committed") {
    return {
      ok: false,
      error: "This document was already committed. Records are append-only — open the chart instead.",
    };
  }

  const { data: fieldRows } = await c.supabase.from("extraction_field").select(FIELD_COLUMNS).eq("job_id", jobId);
  const fields = (fieldRows ?? []) as FieldRow[];
  const accepted = new Map(
    fields.filter((f) => f.accepted === true).map((f) => [f.field_key, (f.accepted_value ?? "").trim()])
  );

  if (accepted.size === 0) {
    return {
      ok: false,
      error: "Accept at least one field before committing. Nothing is committed on the reader's word.",
    };
  }

  if (j.kind !== "intake_packet") {
    const { data, error } = await c.supabase
      .from("extraction_job")
      .update({ status: "committed" })
      .eq("id", jobId)
      .select("id");
    if (error || !data || data.length === 0) {
      return {
        ok: false,
        error:
          "That couldn't be saved. Committing a document needs the client-records permission — nothing on the record changed.",
      };
    }
    revalidatePath("/office/intake");
    return {
      ok: true,
      message:
        "Recorded. The accepted values and who accepted them are on file; add the credential on the credentials desk, where the expiry engine takes over.",
    };
  }

  const first = accepted.get("client.first_name");
  const last = accepted.get("client.last_name");
  if (!first || !last) {
    return {
      ok: false,
      error: "A chart needs an accepted first and last name. Accept those two fields, then commit.",
    };
  }

  const payer = accepted.get("payer.type")?.toLowerCase();
  const dob = accepted.get("client.dob");
  const language = accepted.get("client.primary_language");

  const { data: newClient, error: clientError } = await c.supabase
    .from("client")
    .insert({
      tenant_id: c.tenantId,
      status: "inquiry", // admission is a human decision made on the chart, not here
      first_name: first.slice(0, 120),
      last_name: last.slice(0, 120),
      dob: dob && ISO_DATE.test(dob) ? dob : null,
      address_line1: accepted.get("client.address_line1")?.slice(0, 200) ?? null,
      city: accepted.get("client.city")?.slice(0, 120) ?? null,
      state: accepted.get("client.state")?.slice(0, 2).toUpperCase() ?? null,
      zip: accepted.get("client.zip")?.slice(0, 12) ?? null,
      primary_phone: accepted.get("client.primary_phone")?.slice(0, 40) ?? null,
      primary_language: language ? language.slice(0, 12).toLowerCase() : "en",
      payer_type: payer && PAYER_TYPES.has(payer) ? payer : null,
    })
    .select("id")
    .single();

  if (clientError || !newClient) {
    return {
      ok: false,
      error:
        "The chart couldn't be created. Creating a client needs the client-records permission — nothing was written, and your accepted fields are still here.",
    };
  }

  const clientId = (newClient as { id: string }).id;
  const { data: statusRows, error: statusError } = await c.supabase
    .from("extraction_job")
    .update({ status: "committed" })
    .eq("id", jobId)
    .select("id");
  const statusStuck = Boolean(statusError) || !statusRows || statusRows.length === 0;

  revalidatePath("/office/intake");
  revalidatePath("/office/clients");

  return {
    ok: true,
    clientId,
    message: statusStuck
      ? "The chart was created. The job's status couldn't be updated — the chart is safe; refresh to see where it stands."
      : `Chart opened for ${first} ${last} in inquiry status, from ${accepted.size} accepted field${accepted.size === 1 ? "" : "s"}.`,
  };
}

/* ── 4. Referral triage (C7) — a proposal, never an action ───────────────────── */

/**
 * Deterministic completeness checklist. These are rules, not judgments: a coordinator
 * cannot open a chart without a name and a way to call back, and this says so with or
 * without a model (docs/16 C10 "det checklist" precedent).
 */
const CHECKS: { key: string; label: string; test: RegExp }[] = [
  {
    key: "phone",
    label: "a callback phone number",
    test: /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
  },
  {
    key: "address",
    label: "a service address",
    test: /\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(\s+[A-Za-z.'-]+)*\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|blvd|ct|court|pkwy|parkway|pl|place|ter|terrace)\b/i,
  },
  {
    key: "payer",
    label: "a payer or funding source",
    test: /\b(medicaid|medicare|private[\s-]?pay|ltc|long[\s-]?term care|insurance|va\b|waiver|policy|member\s*(id|#|number))\b/i,
  },
  {
    key: "start",
    label: "a requested start date",
    test: /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2}|asap|immediately|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
  },
  {
    key: "hours",
    label: "the hours or days of care requested",
    test: /\b(\d{1,2}\s*(hours?|hrs?)|\d{1,2}\s*(days?|x)\s*(per|a|\/)\s*week|overnight|live[\s-]?in|weekday|weekend)\b/i,
  },
];

const TRIAGE_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: "referral_triage",
  schema: {
    type: "object",
    properties: {
      urgency: { type: "string", enum: ["urgent", "soon", "routine"] },
      urgency_reason: { type: "string" },
      summary: { type: "string" },
      service_fit: { type: "string" },
      next_step: { type: "string" },
      refusal: { type: ["string", "null"] },
    },
    required: ["urgency", "urgency_reason", "summary", "service_fit", "next_step", "refusal"],
    additionalProperties: false,
  },
};

/**
 * Triage a pasted referral. The checklist is computed here and always shown; the model
 * adds the ranking and the plain-language summary when it is reachable. The result is
 * filed as an `ai_proposal` — a thing a coordinator disposes, never a thing that acts.
 */
export async function triageReferral(text: string): Promise<TriageResult> {
  const c = await ctx();
  const body = (text ?? "").trim().slice(0, 6000);
  const base: TriageResult = {
    ok: false,
    urgency: null,
    summary: null,
    serviceFit: null,
    nextStep: null,
    missing: [],
    present: [],
    degraded: true,
    notice: null,
    proposalId: null,
  };

  if (!c) return { ...base, error: "Sign in again to triage a referral." };
  if (body.length < 20) {
    return { ...base, error: "Paste the referral text first — a line or two isn't enough to work from." };
  }

  // Deterministic half — true with or without a model.
  const present: string[] = [];
  const missing: string[] = [];
  for (const check of CHECKS) (check.test.test(body) ? present : missing).push(check.label);

  const words = body.split(/\s+/).filter(Boolean).length;

  const run = await runCapability(c.supabase, TRIAGE_CAPABILITY, {
    system:
      "You are the CareOS referral triage assistant. Rank urgency only from what the referral itself " +
      "says, name the service fit by quoting the phrase that supports it, and write one next step for " +
      "the coordinator. You never decide eligibility, authorization, coverage, or admission.",
    user:
      `Agency: a Maryland residential service agency providing personal care, companion care and ` +
      `respite in Montgomery and Prince George's counties.\n` +
      `Deterministic completeness check already run by the platform (ground truth — do not recompute):\n` +
      `present: ${present.join(", ") || "none"}\nmissing: ${missing.join(", ") || "none"}\n\n` +
      `Referral text:\n"""\n${body}\n"""`,
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: TRIAGE_SCHEMA,
    inputDigest: digest(
      `referral triage · ${words} words · ${present.length} of ${CHECKS.length} expected items present`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
  });

  let urgency: TriageUrgency | null = null;
  let summary: string | null = null;
  let serviceFit: string | null = null;
  let nextStep: string | null = null;
  let refusal: string | null = null;

  if (run.status === "ok" && run.text.trim()) {
    try {
      const o = JSON.parse(run.text) as Record<string, unknown>;
      const u = typeof o.urgency === "string" ? o.urgency : "";
      urgency = u === "urgent" || u === "soon" || u === "routine" ? u : null;
      const reason = typeof o.urgency_reason === "string" ? o.urgency_reason.trim() : "";
      summary = typeof o.summary === "string" && o.summary.trim() ? o.summary.trim().slice(0, 1200) : null;
      if (summary && reason) summary = `${summary} ${reason}`.slice(0, 1400);
      serviceFit =
        typeof o.service_fit === "string" && o.service_fit.trim() ? o.service_fit.trim().slice(0, 600) : null;
      nextStep = typeof o.next_step === "string" && o.next_step.trim() ? o.next_step.trim().slice(0, 600) : null;
      refusal = typeof o.refusal === "string" && o.refusal.trim() ? o.refusal.trim().slice(0, 400) : null;
    } catch {
      urgency = null;
    }
  }

  const degraded = urgency === null || summary === null;
  const notice = refusal
    ? `The reader didn't read this as a referral: ${refusal}`
    : !degraded
      ? null
      : run.status === "blocked" && run.reason === "budget"
        ? "Ranking is paused for this month — the budget for this capability is spent. The completeness check below is the platform's own and still stands."
        : run.status === "blocked"
          ? "Ranking is switched off for this agency. The completeness check below is the platform's own and still stands."
          : "Ranking needs model access and it isn't available right now. The completeness check below is the platform's own and still stands — work the referral from it.";

  // File it as a proposal so it lands in the approvals inbox with everything else.
  const title = `Referral triage — ${words} words pasted${urgency ? `, ranked ${urgency}` : ", not ranked"}`;
  const proposalBody =
    summary ??
    `Not ranked — no model access at triage time. Completeness check: ${
      missing.length ? `missing ${missing.join(", ")}` : "all expected items present"
    }.`;

  let proposalId: string | null = null;
  try {
    const { data } = await c.supabase
      .from("ai_proposal")
      .insert({
        tenant_id: c.tenantId,
        capability_key: TRIAGE_CAPABILITY,
        kind: "draft",
        subject_type: "referral",
        subject_id: null,
        title,
        body: proposalBody,
        payload: {
          missing_items: missing,
          present_items: present,
          word_count: words,
          service_fit: serviceFit,
          next_step: nextStep,
          degraded,
        },
        rationale: degraded
          ? "Deterministic completeness check only — the ranking half was unavailable."
          : "Ranked from the referral text; eligibility, authorization and admission remain human decisions.",
        ai_interaction_id: run.interactionId,
        created_by: c.userId,
      })
      .select("id")
      .single();
    proposalId = (data as { id: string } | null)?.id ?? null;
  } catch {
    proposalId = null; // filing is a convenience; the coordinator still has the answer on screen
  }

  revalidatePath("/office/intake");
  return {
    ok: true,
    urgency,
    summary,
    serviceFit,
    nextStep,
    missing,
    present,
    degraded,
    notice,
    proposalId,
  };
}
