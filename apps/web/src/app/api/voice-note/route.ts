/**
 * POST /api/voice-note — Wave 1 · G1 voice-to-visit-note (docs/16 §2.5, §4).
 *
 * A caregiver speaks for up to 90 seconds; this route turns that audio into a
 * STRUCTURED DRAFT of the agency's visit-note template. Nothing is saved here —
 * the draft goes back to the author for per-section review, and only the author's
 * confirmed save (app/today/voice-actions.ts) writes a record (invariant 8, T2).
 *
 * What this route guarantees:
 *   · Auth + authorization — user-scoped Supabase client (invariant 6); the visit
 *     must be readable under the caller's RLS (which already requires AAL2 for PHI,
 *     invariant 3) AND the caller must be the assigned caregiver or on the care team.
 *   · Deterministic facts are INJECTED, never asked (invariant 13). The visit date and
 *     the EVV clock times come from the visit record; the model is told they are ground
 *     truth and is forbidden (by the registry prompt) from guessing them. The date is
 *     never taken from the model's output — the save action recomputes it server-side.
 *   · The template is the schema. Field keys, labels, types and select options are read
 *     from form_template (key = 'visit_note') under RLS, and the strict JSON schema is
 *     built from them — the model can only emit keys the template actually has.
 *   · Two model calls, two governed ledger rows (invariant 10). Transcription rides
 *     `transcribeAudio()` and structuring rides `runCapability()`; both resolve THIS
 *     capability's registry row first, so the kill switch, the monthly budget and the
 *     versioned prompt apply to the audio call as well as the text one, and each call's
 *     spend is attributed to itself rather than folded into a neighbour's row.
 *   · PHI discipline (invariant 5). The digest this route hands the ledger carries counts
 *     and an id prefix only — never a word of what was said. Nothing is logged. The audio
 *     is never written to disk, never stored, and is dropped when the request ends.
 *   · Graceful degradation, always. If the model is off, over budget, erroring, or returns
 *     something unparseable, the caregiver still gets their words back — verbatim, in the
 *     note's main field, clearly labelled as unstructured. Transcription failure is the
 *     only hard stop, and it returns an honest 503 that the client turns into "type it
 *     instead", never an error wall.
 *
 * Vendor note: audio and transcript go to OpenAI. Synthetic (Meadowbrook) universe only
 * until the BAA is executed and registered in docs/09 §6 (docs/16 §3.5).
 *
 * GAP CLOSED (ST-236, was: "transcription is a model call made here rather than through
 * lib/ai/client.ts"). The chokepoint now exposes `transcribeAudio()`, and this route uses
 * it: there is no raw provider fetch left in this file. What that bought, concretely —
 *   · the STT model is pinned in lib/ai/registry.ts (TRANSCRIPTION_MODEL, D-013) instead
 *     of being a const in a route handler, so changing it is a reviewed code change;
 *   · the capability's KILL SWITCH and monthly BUDGET now gate the audio call too. Before,
 *     a switched-off capability still transcribed and still spent; now the audio never
 *     leaves the building and the caregiver is told plainly to type the note;
 *   · transcription writes its OWN ai_interaction row (one row per model call), so this
 *     route no longer folds audio spend into the structuring row via extraCostUsd —
 *     doing both would double-count the same minute of audio.
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { digest, runCapability, transcribeAudio } from "@/lib/ai/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAPABILITY = "note.voice_draft";
/** The caregiver visit-note template (supabase/seed.sql). Its fields ARE the draft schema.
 *  Module-local on purpose: a route module may only export handlers, config, and types —
 *  a stray value export fails Next's generated route validator at build time. */
const VISIT_NOTE_TEMPLATE_KEY = "visit_note";
const MAX_SECONDS = 90;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
/** Domain vocabulary only — generic care words, never a client name or any identifier
 *  (docs/16 §3.1: the biasing hint stays inside the capability's PHI allowlist). */
const TRANSCRIBE_VOCABULARY =
  "Home care visit note. Vocabulary: caregiver, care plan, transfer, ambulation, walker, " +
  "incontinence care, range of motion, medication reminder, blood pressure, blood sugar, " +
  "meal prep, light housekeeping, respite.";
/** Maryland RSA — visit dates are agency-local, not UTC, or a 9pm visit files a day late. */
const AGENCY_TZ = "America/New_York";

/* ── Wire types (imported type-only by the client component) ─────────────────── */

export type VoiceFieldType = "text" | "textarea" | "date" | "select" | "boolean" | "number";

export type VoiceSection = {
  key: string;
  label: string;
  type: VoiceFieldType;
  options?: string[];
  help?: string;
  /** Always a string in transit; the save action coerces back to the template's type. */
  value: string;
  /**
   * Where the value came from — the four-state doctrine applied per section:
   *   record     · deterministic, from the visit record (read-only in the UI)
   *   ai         · structured from the recording by the model
   *   transcript · the degrade path: the caregiver's own words, unstructured
   *   empty      · the recording didn't cover this field (never invented)
   */
  source: "record" | "ai" | "transcript" | "empty";
};

export type VoiceDraft = {
  visitId: string;
  clientId: string;
  sections: VoiceSection[];
  /** PHI-safe description of the recording — counts only, never content. */
  transcript_digest: string;
  ai_interaction_id: string | null;
  ai: {
    status: "ok" | "abstained" | "error" | "blocked";
    provider: "openai" | "mock";
    model: string;
    /** true ⇒ sections hold raw spoken words, not model-structured fields. */
    degraded: boolean;
    /** Honest one-liner for the review sheet when something degraded. */
    notice: string | null;
  };
};

type TemplateField = {
  key: string;
  label: string;
  type: VoiceFieldType;
  options?: string[];
  help?: string;
};

/* ── Small helpers ───────────────────────────────────────────────────────────── */

function problem(status: number, code: string, error: string) {
  // No PHI in error bodies, ever (docs/08 §2).
  return NextResponse.json({ code, error }, { status });
}

/** Agency-local calendar date of a timestamp, as YYYY-MM-DD. */
function agencyDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENCY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function agencyTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: AGENCY_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function isFieldType(v: unknown): v is VoiceFieldType {
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
        label: typeof o.label === "string" ? o.label : o.key,
        type: isFieldType(o.type) ? o.type : "text",
        options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === "string") : undefined,
        help: typeof o.help === "string" ? o.help : undefined,
      };
    })
    .filter((f): f is TemplateField => f !== null);
}

/** The field a degraded (unstructured) transcript falls into: first textarea, else first text. */
function primaryTextField(fields: TemplateField[]): TemplateField | null {
  return fields.find((f) => f.type === "textarea") ?? fields.find((f) => f.type === "text") ?? null;
}

/** Strict JSON schema built FROM THE TEMPLATE — date fields excluded (deterministic). */
function draftSchema(fields: TemplateField[]): { name: string; schema: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "date") continue; // supplied by the platform, never by the model
    if (f.type === "boolean") properties[f.key] = { type: ["boolean", "null"] };
    else if (f.type === "number") properties[f.key] = { type: ["number", "null"] };
    else if (f.type === "select" && f.options?.length)
      properties[f.key] = { type: ["string", "null"], enum: [...f.options, null] };
    else properties[f.key] = { type: ["string", "null"] };
  }
  return {
    name: "visit_note_draft",
    schema: {
      type: "object",
      properties,
      required: Object.keys(properties), // strict mode requires every key; null carries "not said"
      additionalProperties: false,
    },
  };
}

/** Model value → the string the review sheet edits. null/absent ⇒ "" (an empty section). */
function toEditableString(v: unknown, f: TemplateField): string {
  if (v === null || v === undefined) return "";
  if (f.type === "boolean") return v === true ? "Yes" : v === false ? "No" : "";
  if (f.type === "number") return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  // A select may only ever hold one of its own options — the model's enum is not trusted blindly.
  if (f.type === "select" && f.options?.length && !f.options.includes(s)) return "";
  return s.slice(0, 4000);
}

/* ── The handler ─────────────────────────────────────────────────────────────── */

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return problem(401, "CAREOS_NOT_AUTHENTICATED", "Sign in again to record a note.");
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return problem(400, "CAREOS_INVALID_REQUEST", "That recording didn't arrive intact. Try again.");
  }
  const audio = form.get("audio");
  const visitId = String(form.get("visitId") ?? "").trim();
  const seconds = Math.min(MAX_SECONDS, Math.max(0, Number(form.get("seconds") ?? 0) || 0));

  if (!visitId) return problem(400, "CAREOS_INVALID_REQUEST", "That note isn't linked to a visit.");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return problem(400, "CAREOS_INVALID_REQUEST", "No audio came through. Nothing was saved — try again.");
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return problem(413, "CAREOS_INVALID_REQUEST", "That recording is too long. Keep voice notes under 90 seconds.");
  }

  // ── Authorization: the visit must be readable under RLS (AAL2-gated), and the
  //    caller must be its caregiver or on the client's care team. ───────────────
  const { data: visit } = await supabase
    .from("visit")
    .select("id, client_id, caregiver_id, scheduled_start")
    .eq("id", visitId)
    .maybeSingle();
  if (!visit) {
    return problem(
      404,
      "CAREOS_NOT_FOUND",
      "We couldn't open that visit for your account. If your verified session expired, sign in again with your authenticator."
    );
  }

  if (visit.caregiver_id !== user.id) {
    const { data: onTeam } = await supabase
      .from("care_team_assignment")
      .select("client_id")
      .eq("client_id", visit.client_id)
      .eq("user_id", user.id)
      .is("ends_on", null)
      .maybeSingle();
    if (!onTeam) {
      return problem(
        403,
        "CAREOS_NOT_ON_CARE_TEAM",
        "You're not on this client's care team, so you can't write a note for this visit."
      );
    }
  }

  // ── The template is the schema (read as the user) ───────────────────────────
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
    return problem(
      503,
      "CAREOS_NOT_FOUND",
      "The visit-note template isn't published for your agency yet, so there's nothing to draft into."
    );
  }

  // ── Deterministic facts (invariant 13): the platform's answers, not the model's ──
  const visitDate = agencyDate(visit.scheduled_start);
  const { data: clockRows } = await supabase
    .from("visit_event")
    .select("event_type, occurred_at")
    .eq("visit_id", visitId)
    .order("occurred_at", { ascending: true })
    .limit(10);
  const events = clockRows ?? [];
  const clockIn = events.find((e) => e.event_type === "clock_in")?.occurred_at ?? null;
  const clockOut =
    events.filter((e) => e.event_type === "clock_out").at(-1)?.occurred_at ?? null;

  // ── Transcription, through the governed chokepoint (invariant 10) ───────────
  // The blob is forwarded straight through — never buffered to disk, never retained.
  const ext = (audio.type || "audio/webm").includes("mp4") ? "mp4" : "webm";
  const stt = await transcribeAudio(supabase, CAPABILITY, {
    audio,
    filename: `visit-note.${ext}`,
    seconds,
    vocabulary: TRANSCRIBE_VOCABULARY,
    // PHI-safe: an id prefix and a duration. Nothing about what was said (invariant 5).
    inputDigest: digest(`voice audio · visit ${visitId.slice(0, 8)} · ${seconds}s`, 200),
  });

  // Each outcome gets its own sentence, because "unavailable" and "switched off" are
  // different facts and a caregiver deciding what to do next deserves the real one.
  if (stt.status === "blocked") {
    return problem(
      503,
      "CAREOS_UNAVAILABLE",
      stt.reason === "budget"
        ? "Voice notes are paused for this month's AI budget. Nothing was saved and the recording wasn't kept — you can type this note instead."
        : "Voice notes are switched off for your agency. Nothing was saved and the recording wasn't kept — you can type this note instead."
    );
  }
  if (stt.status === "error") {
    // 429 / timeout / 5xx / no provider configured. Honest, and never an error wall.
    return problem(
      503,
      "CAREOS_UNAVAILABLE",
      "We couldn't turn that recording into words just now. Nothing was saved and the audio wasn't kept — you can type this note instead."
    );
  }
  if (stt.status === "abstained" || !stt.text) {
    return problem(
      422,
      "CAREOS_EMPTY_TRANSCRIPT",
      "We didn't catch any speech in that recording. Nothing was saved — try again somewhere quieter, or type the note."
    );
  }
  const transcript = stt.text;

  // ── Structuring through the governed chokepoint (invariant 10) ──────────────
  const modelFields = fields.filter((f) => f.type !== "date");
  const fieldSpec = modelFields
    .map((f) => {
      const opts = f.type === "select" && f.options?.length ? ` Options: ${f.options.join(" | ")}.` : "";
      const help = f.help ? ` Guidance: ${f.help}` : "";
      return `- ${f.key} (${f.type}) — "${f.label}".${opts}${help}`;
    })
    .join("\n");

  const facts = [
    `visit_date: ${visitDate}`,
    clockIn ? `clock_in: ${agencyTime(clockIn)}` : "clock_in: not recorded",
    clockOut ? `clock_out: ${agencyTime(clockOut)}` : "clock_out: not recorded",
  ].join("\n");

  const words = transcript.split(/\s+/).filter(Boolean).length;
  const transcriptDigest =
    `${seconds ? `${seconds}s of audio · ` : ""}${words} word${words === 1 ? "" : "s"} transcribed`;

  const userMessage =
    `Visit-note template fields — fill only these keys:\n${fieldSpec}\n\n` +
    `Deterministic visit facts supplied by the platform (ground truth — never restate them as ` +
    `observations and never guess dates or times):\n${facts}\n\n` +
    `Transcript of the caregiver's spoken note:\n"""\n${transcript.slice(0, 8000)}\n"""`;

  const run = await runCapability(supabase, CAPABILITY, {
    // The ACTIVE registry prompt (ai_prompt_template · note.voice_draft v1) overrides this;
    // it exists only so a pre-0015 environment still behaves.
    system:
      "You are the CareOS visit-note structurer. Return only a JSON object whose keys are exactly " +
      "the template field keys. Fill a field only from what the transcript actually says; use null " +
      "when it isn't covered. Never invent an observation, task, time, or measurement. Keep the " +
      "caregiver's plain words. This output is a draft the author reviews before anything is saved.",
    user: userMessage,
    temperature: 0,
    maxToolRounds: 0,
    responseFormat: draftSchema(modelFields),
    // PHI-safe (invariant 5): counts and an id prefix. Not one word of what was said.
    inputDigest: digest(
      `voice note · visit ${visitId.slice(0, 8)} · ${seconds}s · ${words} words · ${modelFields.length} fields`,
      200
    ),
    // Empty on purpose: the degrade below is assembled here from the transcript, so the
    // ledger's output_digest never carries note content on a failure path.
    fallback: () => ({ text: "", abstained: true }),
    // No extraCostUsd: transcription carries its own ai_interaction row now (one row per
    // model call), so folding its spend in here would bill the same minute twice.
  });

  // ── Assemble the draft ──────────────────────────────────────────────────────
  let structured: Record<string, unknown> | null = null;
  if (run.status === "ok" && run.text.trim()) {
    try {
      const parsed = JSON.parse(run.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        structured = parsed as Record<string, unknown>;
      }
    } catch {
      structured = null; // unparseable → degrade, never an error wall
    }
  }

  const degraded = structured === null;
  const primary = primaryTextField(fields);
  const notice = !degraded
    ? null
    : run.status === "blocked" && run.reason === "budget"
      ? "Automatic structuring is paused for this month, so your words are below exactly as you said them. Review and save."
      : run.status === "blocked"
        ? "Automatic structuring is turned off, so your words are below exactly as you said them. Review and save."
        : "We couldn't structure this note automatically. Your words are below exactly as you said them — review and save.";

  const sections: VoiceSection[] = fields.map((f): VoiceSection => {
    if (f.type === "date") {
      // Deterministic: from the visit record. Read-only, and recomputed on save.
      return { ...f, value: visitDate, source: "record" };
    }
    if (degraded) {
      const isPrimary = primary !== null && f.key === primary.key;
      return {
        ...f,
        value: isPrimary ? transcript.slice(0, 4000) : "",
        source: isPrimary ? "transcript" : "empty",
      };
    }
    const value = toEditableString(structured?.[f.key], f);
    return { ...f, value, source: value ? "ai" : "empty" };
  });

  const body: VoiceDraft = {
    visitId,
    clientId: visit.client_id,
    sections,
    transcript_digest: transcriptDigest,
    ai_interaction_id: run.interactionId,
    ai: {
      status: run.status,
      provider: run.provider,
      model: run.model,
      degraded,
      notice,
    },
  };

  // The audio is not persisted anywhere; it goes out of scope with this request.
  return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
}
