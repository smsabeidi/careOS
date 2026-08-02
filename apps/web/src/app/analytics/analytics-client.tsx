"use client";

/**
 * Analytics console — the question box, the eight suggested reports, and the answer.
 *
 * The only interactive part of this surface, and deliberately thin: it holds no data of
 * its own, computes no number, and knows nothing about SQL. Every answer arrives from a
 * server action that ran a governed report under the asker's own RLS.
 *
 * The four states are all here: idle (the suggested questions), loading (a table-shaped
 * skeleton, not a spinner), error (what happened, what is preserved, what to do), and
 * degraded (the assistant unavailable — the suggested questions still run end to end,
 * because a button is a report id, not a prompt).
 */

import { useState, useTransition } from "react";
import { askAnalytics, disposeAnalytics, listReports, runReport } from "./actions";
import { Badge, DataTable } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconSearch,
  IconShield,
  IconSparkle,
  IconX,
} from "@/components/icons";

/** Derived from the actions themselves, so the console can never drift from what they return. */
type Answer = Awaited<ReturnType<typeof askAnalytics>>;
type Report = Awaited<ReturnType<typeof listReports>>[number];

type Feedback = "idle" | "saving" | "saved" | "failed";

function RoutingBadge({ answer }: { answer: Answer }) {
  if (answer.routedBy === "assistant") {
    return (
      <Badge tone="accent" icon={<IconSparkle />}>
        Routed by the assistant{answer.model ? ` · ${answer.model}` : ""}
      </Badge>
    );
  }
  if (answer.routedBy === "keywords") {
    return (
      <Badge tone="neutral" icon={<IconSearch />}>
        Matched from your words
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" icon={<IconShield />}>
      Report run directly
    </Badge>
  );
}

function FeedbackBar({ interactionId }: { interactionId: string }) {
  const [state, setState] = useState<Feedback>("idle");

  async function save(action: "accepted" | "rejected") {
    setState("saving");
    const res = await disposeAnalytics(interactionId, action, action === "rejected" ? "wrong" : undefined);
    setState(res.ok ? "saved" : "failed");
  }

  if (state === "saved") {
    return (
      <p
        className="mt-4 flex items-center gap-1.5 border-t pt-3 text-[12px] hairline"
        style={{ color: "var(--text-muted)" }}
      >
        <IconCheck width={13} height={13} />
        Recorded. This becomes evaluation data for the model and prompt that chose the report.
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3 hairline">
      <p className="mr-1 text-[12px] font-medium" style={{ color: "var(--text-muted)" }}>
        Did this answer the question?
      </p>
      <button
        type="button"
        className="btn btn-white btn-sm btn-pill"
        disabled={state === "saving"}
        onClick={() => void save("accepted")}
      >
        <IconCheck width={14} height={14} />
        Yes
      </button>
      <button
        type="button"
        className="btn btn-white btn-sm btn-pill"
        disabled={state === "saving"}
        onClick={() => void save("rejected")}
      >
        <IconX width={14} height={14} />
        Wrong report
      </button>
      {state === "failed" && (
        <span className="text-[12px]" style={{ color: "var(--color-danger-700)" }}>
          Feedback was not saved. The answer above is unaffected.
        </span>
      )}
    </div>
  );
}

function AnswerCard({ answer }: { answer: Answer }) {
  if (!answer.ok) {
    return (
      <div className="card p-5" role="alert">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone="warning" icon={<IconAlert />}>
            No report ran
          </Badge>
          <RoutingBadge answer={answer} />
        </div>
        <p className="text-[15px] leading-relaxed">{answer.error}</p>
        {answer.aiNote && (
          <p className="mt-2 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            {answer.aiNote}
          </p>
        )}
        <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Nothing was changed and nothing was written. Pick one of the suggested questions to run a
          report directly.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card mb-3 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone="success" icon={<IconCheck />}>
            Answered
          </Badge>
          <RoutingBadge answer={answer} />
          {answer.windowLabel && <Badge tone="neutral">{answer.windowLabel}</Badge>}
        </div>

        <p className="text-[16px] leading-relaxed">{answer.narration}</p>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {`Answered with the “${answer.reportName}” report — a governed, read-only query. `}
          The assistant chooses which report runs; the numbers come from the database.
        </p>
        {answer.aiNote && (
          <p
            className="mt-2 flex items-start gap-1.5 text-[12.5px]"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="mt-0.5 shrink-0">
              <IconAlert width={12} height={12} />
            </span>
            {answer.aiNote}
          </p>
        )}
        {answer.interactionId && answer.routedBy === "assistant" && (
          <FeedbackBar interactionId={answer.interactionId} />
        )}
      </div>

      <DataTable
        caption={`${answer.reportName ?? "Report"} results`}
        columns={answer.columns.map((c) => ({ header: c.header, align: c.align ?? "left" }))}
        rows={answer.rows.map((cells, i) => ({ key: String(i), cells }))}
        empty={
          <div
            className="card px-5 py-10 text-center text-[14px]"
            style={{ color: "var(--text-muted)" }}
          >
            No rows matched. That is the answer, not an error.
          </div>
        }
      />

      <div className="mt-2 flex flex-col gap-1">
        {answer.total > answer.rows.length && (
          <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            Showing the first {answer.rows.length} of {answer.total} rows.
          </p>
        )}
        {answer.scopeNote && (
          <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            {answer.scopeNote}
          </p>
        )}
        <p
          className="flex items-start gap-1.5 text-[12.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="mt-0.5 shrink-0">
            <IconShield width={13} height={13} />
          </span>
          Every report runs under your own permissions. Records you are not allowed to see are not
          counted and are never returned.
        </p>
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="card overflow-hidden" aria-busy="true" aria-label="Running the report">
      <div className="px-5 py-4">
        <div className="skeleton h-3.5 w-2/3" />
        <div className="skeleton mt-2 h-3 w-1/3" />
      </div>
      <div className="divide-y hairline">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5">
            <div className="skeleton h-3.5 w-40" />
            <div className="skeleton h-3.5 w-28" />
            <div className="skeleton h-3.5 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AnalyticsConsole({ reports }: { reports: Report[] }) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setAsked(trimmed);
    setAnswer(null);
    setFailed(false);
    startTransition(async () => {
      try {
        setAnswer(await askAnalytics(trimmed));
      } catch {
        setFailed(true);
      }
    });
  }

  /** A suggested question runs its report directly — no model in the path. */
  function run(report: Report) {
    setAsked(report.question);
    setAnswer(null);
    setFailed(false);
    setQuestion("");
    startTransition(async () => {
      try {
        setAnswer(await runReport(report.id));
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="card p-4"
      >
        <label htmlFor="analytics-q" className="sr-only">
          Ask a question about the agency
        </label>
        <textarea
          id="analytics-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="Ask about visits, coverage, credentials or compliance…"
          className="input w-full resize-none"
          style={{ minHeight: 56 }}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Questions are answered by governed, read-only reports. The assistant only chooses which
            report runs — it never writes a query and never sees a row.
          </p>
          <button
            type="submit"
            className="btn btn-primary btn-sm shrink-0"
            disabled={pending || !question.trim()}
          >
            <IconSparkle width={15} height={15} />
            {pending ? "Working…" : "Ask"}
          </button>
        </div>
      </form>

      <div className="mt-4">
        <p className="mb-2 text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
          Reports you can run right now
        </p>
        <div className="flex flex-wrap gap-2">
          {reports.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => run(r)}
              disabled={pending}
              title={r.description}
              className="btn btn-white btn-sm btn-pill"
            >
              {r.question}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Each button runs its report directly, so these keep working when the assistant is
          unavailable.
        </p>
      </div>

      {asked && (
        <div className="mt-6">
          <p className="mb-2 text-[15px] font-semibold">{asked}</p>
          {pending ? (
            <TableSkeleton />
          ) : failed ? (
            <div className="card p-5" role="alert">
              <Badge tone="danger" icon={<IconAlert />}>
                Not delivered
              </Badge>
              <p className="mt-3 text-[14px]">
                The question did not reach the server. Nothing was changed. Try asking again.
              </p>
            </div>
          ) : answer ? (
            <AnswerCard answer={answer} />
          ) : null}
        </div>
      )}
    </div>
  );
}
