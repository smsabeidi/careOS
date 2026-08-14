"use client";

/**
 * The note coach, beside the note (ST-235, Front Door W3) — the caregiver-facing half.
 *
 * It sits inside the review sheet, where a caregiver is looking at the note they are
 * about to save, and it does exactly one thing: on an explicit press, it asks at most
 * three questions about what they wrote.
 *
 * Four decisions worth stating, because each one is a thing this deliberately does NOT do:
 *
 *   · IT NEVER FIRES ON A KEYSTROKE. Coaching costs money and attention, and a companion
 *     that interrupts every few words teaches people to ignore it. One button, one press,
 *     one answer. The caregiver decides when a second read is worth having.
 *
 *   · NO CONTROL WRITES A SUGGESTION INTO THE NOTE. There is no "apply", no "fix it for
 *     me", no click target that edits a field — not because a guard forbids it, but
 *     because the code to do it does not exist here. The note stays the caregiver's
 *     words, which is what makes it usable as a clinical record.
 *
 *   · A SUGGESTION ABOUT DELETED TEXT DISAPPEARS. Suggestions quote the note verbatim
 *     (coach-parse.ts drops any that don't), so once the caregiver edits that fragment
 *     away, its card stops applying and stops rendering. A card pointing at words that
 *     are no longer on screen is just noise a tired person has to decode.
 *
 *   · IT SAYS WHICH OF THE FOUR STATES IT IS IN, HONESTLY. Reading · suggestions · "this
 *     reads well" · "coaching is unavailable". The unavailable state names the one thing
 *     the caregiver actually cares about — their note is unaffected — because a failure
 *     here must never feel like a failure of the note.
 *
 * Rendering is gated in the SERVER component (`/today` reads app.feature_enabled and
 * passes the answer down); when the flag is off, this component is never mounted at all —
 * no teaser, no disabled button.
 *
 * @trace ST-235, docs/designs/intelligent-front-door.md W3, docs/10 four-state doctrine, D-012
 */

import { useEffect, useMemo, useState } from "react";
import { IconAlert, IconCheck, IconSparkle, IconX } from "@/components/icons";
import { coachNote } from "./coach-actions";
import { COACH_KIND_LABEL, type CoachResult, type CoachSuggestion } from "./coach-parse";

function keyOf(s: CoachSuggestion): string {
  return `${s.kind}|${s.quote}`;
}

export function CoachPanel({ visitId, note }: { visitId: string; note: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CoachResult | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  /** The note as it stood when the coaching was asked for — the yardstick for staleness. */
  const [coachedNote, setCoachedNote] = useState("");

  // A note edited after coaching may no longer contain the quoted fragments. The result
  // is not thrown away (the caregiver may be mid-sentence), but the panel stops pretending
  // it is current — see `stale` below.
  const suggestions = result?.status === "ok" ? result.suggestions : [];
  const visible = useMemo(
    () => suggestions.filter((s) => note.includes(s.quote) && !dismissed.includes(keyOf(s))),
    [suggestions, note, dismissed]
  );
  const stale = coachedNote !== "" && note.trim() !== coachedNote.trim();

  // A fresh recording replaces the draft entirely; last round's coaching is about a note
  // that no longer exists, so it goes with it.
  useEffect(() => {
    if (note.trim().length === 0 && result !== null) {
      setResult(null);
      setDismissed([]);
      setCoachedNote("");
    }
  }, [note, result]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setDismissed([]);
    try {
      const res = await coachNote({ visitId, note });
      setResult(res);
      setCoachedNote(note);
    } catch {
      // A thrown server action is a transport failure, not a reason to lose a note.
      setResult({ status: "unavailable", suggestions: [], dropped: 0 });
      setCoachedNote(note);
    } finally {
      setBusy(false);
    }
  }

  // The flag is off for this agency: say nothing, show nothing. (The surface should not
  // have mounted at all; this is the belt to the server's braces.)
  if (result?.status === "off") return null;

  return (
    <section className="mt-4 border-t pt-4 hairline" aria-label="Note coaching">
      <button
        type="button"
        className="btn btn-secondary btn-sm min-h-11 w-full"
        onClick={run}
        disabled={busy}
      >
        <IconSparkle width={15} height={15} />
        {busy ? "Reading your note…" : result ? "Ask again" : "Get coaching"}
      </button>
      <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
        Coaching is advice, not a change. Nothing here edits your note — you decide what to
        write.
      </p>

      <div aria-live="polite" aria-busy={busy}>
        {busy && (
          <div className="mt-3">
            <div className="skeleton h-3.5 w-1/2" />
            <div className="skeleton mt-2 h-3.5 w-3/4" />
          </div>
        )}

        {!busy && result?.status === "ok" && visible.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {visible.map((s) => (
              <article key={keyOf(s)} className="card p-3.5">
                <div className="flex items-start gap-2">
                  {/* The kind travels as words, never as a colour or a code (D-012). */}
                  <p className="flex-1 text-[12px] font-semibold">{COACH_KIND_LABEL[s.kind]}</p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setDismissed((prev) => [...prev, keyOf(s)])}
                    // Named by what it dismisses: several cards can be on screen, and
                    // "Dismiss, Dismiss, Dismiss" tells a screen-reader user nothing.
                    // Trimmed, because an accessible name is read aloud in full.
                    aria-label={`Dismiss this suggestion about “${s.quote.slice(0, 60)}”`}
                  >
                    <IconX width={13} height={13} />
                    Dismiss
                  </button>
                </div>
                <p
                  className="mt-1.5 text-[13px] italic leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  “{s.quote}”
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed">{s.prompt}</p>
              </article>
            ))}
          </div>
        )}

        {!busy && result?.status === "ok" && suggestions.length === 0 && (
          <p className="mt-3 flex items-start gap-2 text-[13px]" role="status">
            <IconCheck
              width={15}
              height={15}
              className="mt-0.5 shrink-0"
              style={{ color: "var(--color-success-600)" }}
            />
            <span>This note reads well — specific and connected to the goals.</span>
          </p>
        )}

        {/* Every card was either dismissed or edited away. Say so; don't render silence. */}
        {!busy && result?.status === "ok" && suggestions.length > 0 && visible.length === 0 && (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
            No suggestions left on screen. Ask again if you'd like a fresh read.
          </p>
        )}

        {!busy && result?.status === "no_note" && (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }} role="status">
            There's nothing to coach yet — write a few lines first.
          </p>
        )}

        {!busy && result?.status === "unavailable" && (
          <p
            className="mt-3 flex items-start gap-2 text-[13px]"
            role="status"
            style={{ color: "var(--color-warning-700)" }}
          >
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
            <span>Coaching is unavailable right now — your note is unaffected.</span>
          </p>
        )}

        {/* Guardrail transparency: a dropped suggestion is reported, never hidden. */}
        {!busy && result?.status === "ok" && result.dropped > 0 && (
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            {result.dropped === 1
              ? "One suggestion didn't quote your note exactly, so it wasn't shown."
              : `${result.dropped} suggestions didn't quote your note exactly, so they weren't shown.`}
          </p>
        )}

        {!busy && stale && visible.length > 0 && (
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Your note has changed since this read. Ask again for fresh suggestions.
          </p>
        )}
      </div>
    </section>
  );
}
