"use client";

import { useState, useTransition } from "react";
import { ask, disposeBrainAnswer } from "./actions";
import type { DispositionAction, DispositionReason } from "@/lib/ai/client";

/** Derived from the action itself, so the console can never drift from what ask() returns. */
type AskResult = Awaited<ReturnType<typeof ask>>;
import { Badge } from "@/components/ui";
import { IconSparkle, IconShield, IconAlert, IconCheck, IconPen, IconX, IconSearch } from "@/components/icons";

const EXAMPLES = [
  "What is our fall-prevention policy?",
  "How often are supervisory visits required?",
  "What do I do if a client has a medication reaction?",
  "How do I report an incident?",
];

/** Mirrors the ai_disposition.reason_code CHECK constraint (migration 0015). */
const REASONS: { code: DispositionReason; label: string }[] = [
  { code: "wrong", label: "Wrong" },
  { code: "tone", label: "Tone" },
  { code: "incomplete", label: "Incomplete" },
  { code: "unsafe", label: "Unsafe" },
  { code: "other", label: "Other" },
];

const DONE_COPY: Record<DispositionAction, string> = {
  accepted: "Recorded as accepted",
  edited: "Recorded with your correction",
  rejected: "Recorded as rejected",
};

/** Honest per-answer retrieval label; the mode comes from the client's ladder, not a guess. */
function retrievalLabel(mode: AskResult["retrievalMode"]): string | null {
  if (mode === "vector_rpc" || mode === "vector_ts") return "Semantic match";
  if (mode === "keyword") return "Keyword match";
  return null;
}

type DispoState =
  | { kind: "idle" }
  | { kind: "panel"; action: "edited" | "rejected" }
  | { kind: "saving" }
  | { kind: "done"; action: DispositionAction }
  | { kind: "error"; message: string };

/**
 * The flywheel made visible (docs/16 §3.2). Each label is written to ai_disposition
 * keyed to this answer's ai_interaction row — which already carries the model and
 * prompt_version — so accept / edit / reject pairs are evaluation and training data
 * from the first click, not something to backfill later.
 */
function DispositionBar({ interactionId }: { interactionId: string | null }) {
  const [state, setState] = useState<DispoState>({ kind: "idle" });
  const [reason, setReason] = useState<DispositionReason | null>(null);
  const [edited, setEdited] = useState("");

  if (!interactionId) {
    return (
      <p className="mt-4 border-t pt-3 text-[12px] hairline" style={{ color: "var(--text-muted)" }}>
        Feedback is unavailable for this answer — it has no ledger record to attach to.
      </p>
    );
  }

  // Re-bound after the guard above: a destructured parameter's narrowing does not
  // survive into a closure, but a const initialized from it does.
  const ledgerId = interactionId;

  async function save(action: DispositionAction, r?: DispositionReason, text?: string) {
    setState({ kind: "saving" });
    const res = await disposeBrainAnswer(ledgerId, action, r, text);
    setState(res.ok ? { kind: "done", action } : { kind: "error", message: res.error ?? "Not saved." });
  }

  if (state.kind === "done") {
    return (
      <p
        className="mt-4 flex items-center gap-1.5 border-t pt-3 text-[12px] hairline"
        style={{ color: "var(--text-muted)" }}
      >
        <IconCheck width={13} height={13} />
        {DONE_COPY[state.action]}. This becomes evaluation data for the model and prompt that answered.
      </p>
    );
  }

  const panel = state.kind === "panel" ? state : null;
  const busy = state.kind === "saving";

  return (
    <div className="mt-4 border-t pt-3 hairline">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-1 text-[12px] font-medium" style={{ color: "var(--text-muted)" }}>
          Was this useful?
        </p>
        <button
          type="button"
          className="btn btn-white btn-sm btn-pill"
          disabled={busy}
          aria-pressed={false}
          onClick={() => void save("accepted")}
        >
          <IconCheck width={14} height={14} />
          Accept
        </button>
        <button
          type="button"
          className="btn btn-white btn-sm btn-pill"
          disabled={busy}
          aria-expanded={panel?.action === "edited"}
          onClick={() => {
            setReason(null);
            setState({ kind: "panel", action: "edited" });
          }}
        >
          <IconPen width={14} height={14} />
          Edit
        </button>
        <button
          type="button"
          className="btn btn-white btn-sm btn-pill"
          disabled={busy}
          aria-expanded={panel?.action === "rejected"}
          onClick={() => {
            setReason(null);
            setState({ kind: "panel", action: "rejected" });
          }}
        >
          <IconX width={14} height={14} />
          Reject
        </button>
        {busy && (
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Saving…
          </span>
        )}
      </div>

      {state.kind === "error" && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--color-danger-700)" }}>
          {state.message} The answer above is unaffected — you can try again.
        </p>
      )}

      {panel && (
        <div className="mt-3">
          <div role="group" aria-label="Reason" className="flex flex-wrap items-center gap-2">
            <p className="mr-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
              {panel.action === "rejected" ? "What was wrong with it?" : "What did you change?"}
            </p>
            {REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                aria-pressed={reason === r.code}
                onClick={() => setReason(reason === r.code ? null : r.code)}
                className="btn btn-sm btn-pill"
                style={
                  reason === r.code
                    ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                    : { background: "#fff" }
                }
              >
                {r.label}
              </button>
            ))}
          </div>

          {panel.action === "edited" && (
            <>
              <label htmlFor="brain-edit" className="sr-only">
                What the answer should have said
              </label>
              <textarea
                id="brain-edit"
                value={edited}
                onChange={(e) => setEdited(e.target.value)}
                rows={3}
                placeholder="What it should have said (optional)"
                className="input mt-2 w-full resize-none text-[14px]"
              />
              <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                Stored as a PHI-safe digest, never raw client content.
              </p>
            </>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || (panel.action === "rejected" && !reason)}
              onClick={() =>
                void save(
                  panel.action,
                  reason ?? undefined,
                  panel.action === "edited" ? edited : undefined
                )
              }
            >
              Save feedback
            </button>
            <button
              type="button"
              className="btn btn-white btn-sm"
              disabled={busy}
              onClick={() => setState({ kind: "idle" })}
            >
              Cancel
            </button>
            {panel.action === "rejected" && !reason && (
              <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                Pick a reason to save.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function BrainConsole() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setAsked(trimmed);
    setResult(null);
    setFailed(false);
    startTransition(async () => {
      try {
        setResult(await ask(trimmed));
      } catch {
        setFailed(true);
      }
    });
  }

  const mode = result ? retrievalLabel(result.retrievalMode) : null;

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(question);
        }}
        className="card p-4"
      >
        <label htmlFor="brain-q" className="sr-only">Ask a policy question</label>
        <textarea
          id="brain-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="Ask a question about agency policy…"
          className="input w-full resize-none"
          style={{ minHeight: 56 }}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Answers come only from agency policy documents, with sources. When no policy applies, the Brain abstains.
          </p>
          <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={pending || !question.trim()}>
            <IconSparkle width={15} height={15} />
            {pending ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>

      {!asked && (
        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setQuestion(ex);
                run(ex);
              }}
              className="btn btn-white btn-sm btn-pill"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {asked && (
        <div className="mt-5">
          <p className="mb-2 text-[15px] font-semibold">{asked}</p>
          {pending ? (
            <div className="card p-5">
              <div className="skeleton h-3.5 w-3/4" />
              <div className="skeleton mt-2 h-3.5 w-full" />
              <div className="skeleton mt-2 h-3.5 w-2/3" />
            </div>
          ) : failed ? (
            <div className="card p-5">
              <Badge tone="danger" icon={<IconAlert />}>Not delivered</Badge>
              <p className="mt-3 text-[14px]">
                The question did not reach the Brain. Nothing was saved. Try asking again.
              </p>
            </div>
          ) : result ? (
            <div className="card p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {result.abstained ? (
                  <Badge tone="warning" icon={<IconAlert />}>No policy found</Badge>
                ) : (
                  <Badge tone="success" icon={<IconCheck />}>Answered from policy</Badge>
                )}
                <Badge tone={result.provider === "openai" ? "accent" : "neutral"} icon={<IconSparkle />}>
                  {result.provider === "openai" ? "OpenAI" : "Mock"} · {result.model}
                </Badge>
                {mode && (
                  <Badge tone="neutral" icon={<IconSearch />}>{mode}</Badge>
                )}
              </div>
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{result.answer}</p>
              {result.citations.length > 0 && (
                <div className="mt-4 border-t pt-3 hairline">
                  <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase"
                     style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                    <IconShield width={13} height={13} /> Sources
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {result.citations.map((c) => (
                      <li key={c.n} className="flex items-start gap-2 text-[13px]">
                        <span className="tabular shrink-0 font-semibold" style={{ color: "var(--accent)" }}>[{c.n}]</span>
                        <span>
                          {c.title}
                          {c.source_ref && (
                            <span style={{ color: "var(--text-muted)" }}> · {c.source_ref}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <DispositionBar key={result.aiInteractionId ?? asked} interactionId={result.aiInteractionId} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
