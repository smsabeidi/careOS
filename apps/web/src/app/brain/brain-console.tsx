"use client";

import { useState, useTransition } from "react";
import { ask } from "./actions";
import type { BrainAnswer } from "@/lib/ai/client";
import { Badge } from "@/components/ui";
import { IconSparkle, IconShield, IconAlert, IconCheck } from "@/components/icons";

const EXAMPLES = [
  "What is our fall-prevention policy?",
  "How often are supervisory visits required?",
  "What do I do if a client has a medication reaction?",
  "How do I report an incident?",
];

export function BrainConsole() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<BrainAnswer | null>(null);
  const [pending, startTransition] = useTransition();

  function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setAsked(trimmed);
    setResult(null);
    startTransition(async () => {
      const res = await ask(trimmed);
      setResult(res);
    });
  }

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
          ) : result ? (
            <div className="card p-5">
              <div className="mb-3 flex items-center gap-2">
                {result.abstained ? (
                  <Badge tone="warning" icon={<IconAlert />}>No policy found</Badge>
                ) : (
                  <Badge tone="success" icon={<IconCheck />}>Answered from policy</Badge>
                )}
                <Badge tone={result.provider === "openai" ? "accent" : "neutral"} icon={<IconSparkle />}>
                  {result.provider === "openai" ? "OpenAI" : "Mock"} · {result.model}
                </Badge>
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
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
