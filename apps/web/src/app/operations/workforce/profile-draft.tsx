"use client";

/**
 * The one interactive island on /operations/workforce: asking for a T2 operational
 * profile draft (docs/17 §11, D-028).
 *
 * It is a client component for exactly one reason — a person has to press something, and
 * what comes back belongs to that person's screen and nowhere else. No PHI is passed in
 * as a prop: the island receives an identifier, a display label the server already
 * resolved under RLS, and two dates. The figures it can never invent are rendered by the
 * server component above it.
 *
 * The copy is the point as much as the code. This screen says, before anything is
 * drafted and again after, that what it produces is evidence for a manager to read and
 * decide upon — not a decision, not a recommendation, and never a proposal about
 * somebody's job (D-021).
 */

import { useState, useTransition } from "react";
import { IconAlert, IconLock, IconPen, IconSparkle } from "@/components/icons";
import { requestOperationalProfile, type ProfileActionResult } from "./actions";

type Props = {
  caregiverId: string;
  /** Already resolved under RLS by the server; "(restricted)" when it could not be. */
  caregiverLabel: string;
  from: string;
  to: string;
};

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; result: ProfileActionResult };

export function ProfileDraftPanel({ caregiverId, caregiverLabel, from, to }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  function run() {
    setState({ kind: "working" });
    startTransition(async () => {
      const result = await requestOperationalProfile({ caregiverId, from, to });
      setState({ kind: "done", result });
    });
  }

  const draft = state.kind === "done" && state.result.ok ? state.result.draft : undefined;
  const failure = state.kind === "done" && !state.result.ok ? state.result.error : undefined;

  return (
    <section className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <span style={{ color: "var(--accent)" }} className="flex">
              <IconPen width={16} height={16} />
            </span>
            Draft a written profile for review
          </h3>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            This writes a plain-language draft of {caregiverLabel}&apos;s figures for a manager to read,
            edit and decide upon. It is evidence, not a decision: it proposes no action about anyone&apos;s
            job, it is never shown to the person it describes, and nothing is saved to their record.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={pending || state.kind === "working"}
          className="btn btn-secondary btn-sm shrink-0"
        >
          <IconSparkle width={14} height={14} />
          {pending || state.kind === "working" ? "Drafting…" : "Draft for review"}
        </button>
      </div>

      {failure && (
        <div className="border-t px-5 py-4 hairline" role="alert">
          <p className="flex items-start gap-2 text-[14px]" style={{ color: "var(--color-danger-700)" }}>
            <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
            {failure}
          </p>
        </div>
      )}

      {draft?.abstained && (
        <div className="border-t px-5 py-4 hairline">
          <p className="flex items-start gap-2 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--text-muted)" }} className="mt-0.5 flex shrink-0">
              <IconLock width={16} height={16} />
            </span>
            {draft.abstained}
          </p>
        </div>
      )}

      {draft?.draft && (
        <div className="border-t hairline">
          <div className="px-5 py-4">
            <p
              className="mb-2 text-[11px] font-semibold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
            >
              Draft · for a manager to review and edit
            </p>
            <div className="flex flex-col gap-3">
              {draft.draft.paragraphs.map((p, i) => (
                <p key={i} className="text-[14.5px] leading-relaxed">
                  {p}
                </p>
              ))}
            </div>

            {draft.draft.ambiguities.length > 0 && (
              <div className="card-inset mt-4 px-4 py-3.5">
                <p className="text-[13px] font-semibold">What these figures do not tell you</p>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {draft.draft.ambiguities.map((a, i) => (
                    <li key={i} className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-5 py-2.5 text-[12px] hairline"
            style={{ color: "var(--text-muted)" }}
          >
            <span>
              Drafted by {draft.model ?? "the pinned model"} from the figures above, which the platform
              computed. A person decides what, if anything, happens next.
            </span>
            {draft.dropped > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <IconAlert width={12} height={12} />
                {draft.dropped} sentence{draft.dropped === 1 ? "" : "s"} set aside for not matching the figures.
              </span>
            )}
          </div>
        </div>
      )}

      {draft && !draft.draft && !draft.abstained && draft.note && (
        <div className="border-t px-5 py-4 hairline">
          <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {draft.note}
          </p>
        </div>
      )}
    </section>
  );
}
