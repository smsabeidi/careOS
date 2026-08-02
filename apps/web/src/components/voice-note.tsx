"use client";

/**
 * Voice-to-visit-note (Wave 1 · G1, docs/16 §2.5) — the caregiver-facing half.
 *
 * Speak for up to 90 seconds after a visit; the words come back as a structured draft of
 * the agency's visit-note template, section by section, for the author to review, edit and
 * save. This component never saves anything on its own: the person who spoke is the author
 * and the disposer (invariant 8, T2), and the save is an explicit press.
 *
 * The field surface is a microphone and a review sheet — no prompt box anywhere (docs/16 §6,
 * "the simple mandate"). Every state is designed to be readable by a tired caregiver on a
 * mid-tier phone in a basement:
 *   · microphone blocked  → say so plainly, and offer the typed note in the same breath
 *   · browser can't record → same fallback, no dead button
 *   · transcription down   → honest message, the audio was not kept, type it instead
 *   · model down/off/over budget → the caregiver's own words come back verbatim in the main
 *     field, labelled as unstructured. Documentation still gets done; AI is an accelerant,
 *     never a dependency (docs/16 §6).
 *
 * Audio handling: captured in memory, POSTed once, then dropped. It is never stored by the
 * browser or the server, and the chunk buffer is cleared on every terminal path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SVGProps } from "react";
import type { VoiceDraft, VoiceSection } from "@/app/api/voice-note/route";
import { discardVoiceDraft, saveVoiceDraft } from "@/app/today/voice-actions";
import { Badge } from "@/components/ui";
import { IconAlert, IconCheck, IconClipboard, IconSparkle, IconX } from "@/components/icons";

const MAX_SECONDS = 90;
const CANDIDATE_MIMES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4", // Safari
  "audio/ogg;codecs=opus",
];

/** Local glyph — the shared icon set has no microphone, and it is not mine to extend. */
const IconMic = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round" width={18} height={18} aria-hidden {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </svg>
);

const IconStop = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16} aria-hidden {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
  </svg>
);

type Phase = "idle" | "recording" | "working" | "review" | "saving" | "saved" | "error";

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return CANDIDATE_MIMES.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
}

export function VoiceNote({
  visitId,
  clientId,
  clientName,
}: {
  visitId: string;
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();

  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [micBlocked, setMicBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedInstanceId, setSavedInstanceId] = useState<string | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef<number>(0);
  const cancelled = useRef(false);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        typeof MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia)
    );
  }, []);

  const releaseCapture = useCallback(() => {
    if (ticker.current) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
    chunks.current = []; // the audio never outlives the request
  }, []);

  // Unmounting mid-recording must not leave the microphone live.
  useEffect(() => {
    return () => {
      cancelled.current = true;
      try {
        if (recorder.current?.state === "recording") recorder.current.stop();
      } catch {
        /* the tracks are stopped below regardless */
      }
      releaseCapture();
    };
  }, [releaseCapture]);

  const upload = useCallback(
    async (blob: Blob, recordedSeconds: number) => {
      setPhase("working");
      try {
        const body = new FormData();
        body.append("audio", blob, blob.type.includes("mp4") ? "note.mp4" : "note.webm");
        body.append("visitId", visitId);
        body.append("seconds", String(recordedSeconds));

        const res = await fetch("/api/voice-note", { method: "POST", body });
        const json = (await res.json().catch(() => null)) as (VoiceDraft & { error?: string }) | null;

        if (!res.ok || !json || !Array.isArray(json.sections)) {
          setError(
            json?.error ??
              "We couldn't turn that recording into a note. Nothing was saved and the audio wasn't kept — you can type this note instead."
          );
          setPhase("error");
          return;
        }
        setDraft(json);
        setValues(Object.fromEntries(json.sections.map((s) => [s.key, s.value])));
        setPhase("review");
      } catch {
        setError(
          "We couldn't reach CareOS to draft that note. Nothing was saved and the audio wasn't kept — check your signal and try again, or type the note."
        );
        setPhase("error");
      }
    },
    [visitId]
  );

  const stop = useCallback(() => {
    if (ticker.current) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
    try {
      if (recorder.current?.state === "recording") recorder.current.stop();
    } catch {
      releaseCapture();
      setError("The recording stopped unexpectedly. Nothing was saved — try again, or type the note.");
      setPhase("error");
    }
  }, [releaseCapture]);

  const start = useCallback(async () => {
    setError(null);
    setMicBlocked(false);
    // Re-recording over an unsaved draft is a rejection of that draft — the label the
    // flywheel most needs (docs/16 §3.2). Fire-and-forget: it never blocks recording.
    if (draft?.ai_interaction_id) void discardVoiceDraft(draft.ai_interaction_id);
    setDraft(null);
    setSavedInstanceId(null);
    setSeconds(0);

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, or no microphone. Both are the same choice for the caregiver: type it.
      setMicBlocked(true);
      setPhase("idle");
      return;
    }

    const mimeType = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    } catch {
      media.getTracks().forEach((t) => t.stop());
      setError("This browser can't record audio. You can type the note instead.");
      setPhase("error");
      return;
    }

    stream.current = media;
    recorder.current = rec;
    chunks.current = [];
    cancelled.current = false;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      const recorded = Math.min(MAX_SECONDS, Math.round((Date.now() - startedAt.current) / 1000));
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      releaseCapture();
      if (cancelled.current) return; // discarded mid-recording: nothing leaves the device
      if (blob.size === 0) {
        setError("That recording came out empty. Nothing was saved — try again, or type the note.");
        setPhase("error");
        return;
      }
      void upload(blob, recorded);
    };

    startedAt.current = Date.now();
    rec.start();
    setPhase("recording");

    ticker.current = setInterval(() => {
      const elapsed = (Date.now() - startedAt.current) / 1000;
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) stop();
    }, 250);
  }, [draft, releaseCapture, stop, upload]);

  function cancelRecording() {
    cancelled.current = true;
    try {
      if (recorder.current?.state === "recording") recorder.current.stop();
    } catch {
      /* ignore */
    }
    releaseCapture();
    setSeconds(0);
    setPhase("idle");
  }

  const dirty = useMemo(() => {
    if (!draft) return false;
    return draft.sections.some((s) => (values[s.key] ?? "") !== s.value);
  }, [draft, values]);

  async function save() {
    if (!draft) return;
    setPhase("saving");
    setError(null);
    const res = await saveVoiceDraft({
      visitId,
      sections: values,
      aiInteractionId: draft.ai_interaction_id,
      edited: dirty,
    });
    if (!res.ok) {
      setError(res.error);
      setPhase("review");
      return;
    }
    setSavedInstanceId(res.instanceId);
    setDraft(null);
    setValues({});
    setPhase("saved");
    router.refresh();
  }

  async function discard() {
    const id = draft?.ai_interaction_id ?? null;
    setDraft(null);
    setValues({});
    setSeconds(0);
    setPhase("idle");
    setError(null);
    await discardVoiceDraft(id);
  }

  const typedNoteHref = `/office/clients/${clientId}/new`;

  /* ── Trigger row ─────────────────────────────────────────────────────────── */
  const trigger =
    phase === "recording" ? (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={stop}
          className="btn btn-danger btn-sm min-h-11 flex-1"
          aria-label="Stop recording and draft the note"
        >
          <IconStop />
          Stop · {mmss(seconds)}
        </button>
        <button type="button" onClick={cancelRecording} className="btn btn-ghost btn-sm min-h-11">
          Cancel
        </button>
      </div>
    ) : phase === "working" ? (
      <button type="button" disabled className="btn btn-secondary btn-sm min-h-11 w-full">
        <IconSparkle width={15} height={15} />
        Drafting your note…
      </button>
    ) : (
      <button
        type="button"
        onClick={start}
        disabled={supported === false}
        className="btn btn-secondary btn-sm min-h-11 w-full"
      >
        <IconMic width={15} height={15} />
        {phase === "review" || phase === "saved" ? "Record again" : "Voice note"}
      </button>
    );

  return (
    <div className="mt-2">
      {trigger}

      {/* Recording meter — visible, honest about the 90-second ceiling. */}
      {phase === "recording" && (
        <div className="mt-2" aria-live="polite">
          <div
            className="h-1 w-full overflow-hidden rounded-full"
            style={{ background: "var(--color-surface-200)" }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={MAX_SECONDS}
            aria-valuenow={Math.floor(seconds)}
            aria-label="Recording length"
          >
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{
                width: `${Math.min(100, (seconds / MAX_SECONDS) * 100)}%`,
                background: "var(--color-danger-600)",
              }}
            />
          </div>
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Recording · say what you did, how {clientName.split(" ")[0]} seemed, and anything worth
            noting. Stops on its own at {mmss(MAX_SECONDS)}.
          </p>
        </div>
      )}

      {supported === false && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
          This browser can't record audio.{" "}
          <Link href={typedNoteHref} className="underline">
            Type the note instead
          </Link>
          .
        </p>
      )}

      {/* Microphone blocked — the one state most likely to strand someone. */}
      {micBlocked && (
        <div
          className="card mt-2 flex items-start gap-2.5 px-4 py-3 text-[13px]"
          role="status"
          style={{ background: "var(--color-warning-50)", borderColor: "#ffdca6" }}
        >
          <IconAlert width={15} height={15} className="mt-0.5 shrink-0" style={{ color: "var(--color-warning-700)" }} />
          <p style={{ color: "var(--color-warning-700)" }}>
            CareOS doesn't have access to your microphone. Allow it in your browser settings, or{" "}
            <Link href={typedNoteHref} className="underline">
              type this note instead
            </Link>
            .
          </p>
        </div>
      )}

      {/* Drafting — the model is working; nothing is saved yet. */}
      {phase === "working" && (
        <div className="card mt-2 p-4" aria-live="polite">
          <div className="skeleton h-3.5 w-2/3" />
          <div className="skeleton mt-2 h-3.5 w-full" />
          <div className="skeleton mt-2 h-3.5 w-1/2" />
          <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Turning your words into a draft. Nothing is saved until you review it.
          </p>
        </div>
      )}

      {/* Failure — honest, and never a dead end. */}
      {phase === "error" && error && (
        <div className="card mt-2 p-4" role="alert">
          <p className="flex items-start gap-2 text-[13px]" style={{ color: "var(--color-danger-700)" }}>
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={start}>
              <IconMic width={14} height={14} />
              Try again
            </button>
            <Link href={typedNoteHref} className="btn btn-ghost btn-sm">
              <IconClipboard width={14} height={14} />
              Type the note
            </Link>
          </div>
        </div>
      )}

      {/* Saved — the record exists, and it is a draft until the author finalizes it. */}
      {phase === "saved" && savedInstanceId && (
        <div className="card mt-2 p-4" role="status">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <IconCheck width={15} height={15} style={{ color: "var(--color-success-600)" }} />
            Saved as a draft note for {clientName}
          </p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            It's in your open notes. Nothing is final until you review and finalize it.
          </p>
          <Link href={`/office/forms/${savedInstanceId}`} className="btn btn-secondary btn-sm mt-3">
            <IconClipboard width={14} height={14} />
            Open the note
          </Link>
        </div>
      )}

      {/* ── Review sheet: every section is the author's to change ─────────────── */}
      {(phase === "review" || phase === "saving") && draft && (
        <section
          className="card rise mt-2 overflow-hidden"
          aria-label={`Review the drafted visit note for ${clientName}`}
        >
          <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 hairline">
            <p className="flex-1 text-[14px] font-semibold">Review your note</p>
            {draft.ai.degraded ? (
              <Badge tone="warning" icon={<IconAlert />}>Your words, unstructured</Badge>
            ) : (
              <Badge tone="accent" icon={<IconSparkle />}>Drafted with AI</Badge>
            )}
          </header>

          <div className="px-4 py-3">
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {draft.ai.notice ??
                "Drafted from your recording. You are the author — check each section, change anything that isn't right, then save."}
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {draft.transcript_digest}
              {draft.ai.provider === "openai" && !draft.ai.degraded ? ` · ${draft.ai.model}` : ""}
              {" · the recording was not kept"}
            </p>

            <div className="mt-4 flex flex-col gap-4">
              {draft.sections.map((s) => (
                <SectionEditor
                  key={s.key}
                  section={s}
                  value={values[s.key] ?? ""}
                  disabled={phase === "saving"}
                  onChange={(v) => setValues((prev) => ({ ...prev, [s.key]: v }))}
                />
              ))}
            </div>

            {error && (
              <p role="alert" className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--color-danger-700)" }}>
                <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}
          </div>

          <footer className="flex items-center gap-2 border-t px-4 py-3 hairline">
            <button
              type="button"
              className="btn btn-primary btn-sm min-h-11 flex-1"
              disabled={phase === "saving"}
              onClick={save}
            >
              <IconCheck width={15} height={15} />
              {phase === "saving" ? "Saving…" : "Save draft note"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm min-h-11"
              disabled={phase === "saving"}
              onClick={discard}
            >
              <IconX width={15} height={15} />
              Discard
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}

/* ── One section of the draft. Types come from the agency's own template. ────── */
function SectionEditor({
  section,
  value,
  disabled,
  onChange,
}: {
  section: VoiceSection;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const id = `voice-${section.key}`;

  // Deterministic sections are shown, not edited: they come from the visit record.
  if (section.source === "record") {
    return (
      <div>
        <p className="label">{section.label}</p>
        <p className="tabular mt-1 text-[15px]">{value || "—"}</p>
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          From the visit record.
        </p>
      </div>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {section.label}
      </label>

      {section.type === "select" ? (
        <select
          id={id}
          className="select"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Not stated</option>
          {section.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : section.type === "boolean" ? (
        <select
          id={id}
          className="select"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Not stated</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      ) : section.type === "textarea" ? (
        <textarea
          id={id}
          className="textarea"
          disabled={disabled}
          value={value}
          placeholder="Not covered in your recording"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={section.type === "number" ? "number" : "text"}
          inputMode={section.type === "number" ? "decimal" : undefined}
          disabled={disabled}
          value={value}
          placeholder="Not covered in your recording"
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {section.source === "empty" && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Not covered in your recording — add it if it matters.
        </p>
      )}
      {section.source === "transcript" && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Your words, exactly as recorded.
        </p>
      )}
      {section.help && section.source !== "empty" && section.source !== "transcript" && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {section.help}
        </p>
      )}
    </div>
  );
}
