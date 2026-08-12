"use client";

/**
 * The one interactive island on the exception inbox (docs/17 §6.3, §7.2).
 *
 * Everything else on that page is a server component: the findings, the names, the
 * ranking and the evidence never enter the JS bundle. What needs the client is exactly
 * this — four decisions and the reason that has to accompany one.
 *
 * THE REASON IS ASKED FOR, NOT ENFORCED BY ERROR. `app.dispose_visit_exception` refuses a
 * blank reason with `CAREOS_REASON_REQUIRED`, and that refusal is correct — but a person
 * should never meet it. Choosing a decision opens the reason field first; Save stays
 * disabled until there are words in it. The database remains the authority; this is the
 * flow that keeps the authority from ever having to say no.
 *
 * Append-only, said plainly (invariant 1): a decision adds a row. Re-submitting the same
 * decision comes back `unchanged` and the UI says "already on the record" rather than
 * implying a second write happened.
 */

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconAlert, IconCheck, IconHistory, IconX } from "@/components/icons";
import { disposeVisitException, type Disposition } from "../actions";

type Choice = {
  key: Disposition;
  label: string;
  /** What this decision means for the queue and the record — shown before it is taken. */
  meaning: string;
  /** What the reason field should contain, in the words a coordinator would use. */
  prompt: string;
  className: string;
  icon: ReactNode;
};

const OPEN_CHOICES: Choice[] = [
  {
    key: "acknowledged",
    label: "Acknowledge",
    meaning: "Seen, and being handled. It leaves the queue and stays on the record.",
    prompt: "Who is handling it, and how",
    className: "btn btn-secondary btn-sm",
    icon: <IconCheck width={15} height={15} />,
  },
  {
    key: "resolved",
    label: "Resolve",
    meaning: "Settled. The reason is the account of how it was settled.",
    prompt: "What was actually done about it",
    className: "btn btn-primary btn-sm",
    icon: <IconCheck width={15} height={15} />,
  },
  {
    key: "dismissed",
    label: "Dismiss",
    meaning: "Not a real problem. The reason is why it isn't.",
    prompt: "Why this isn't a problem",
    className: "btn btn-secondary btn-sm",
    icon: <IconX width={15} height={15} />,
  },
  {
    key: "escalated",
    label: "Escalate",
    meaning: "Beyond this desk. It leaves this queue for whoever handles it next.",
    prompt: "What needs deciding, and by whom",
    className: "btn btn-secondary btn-sm",
    icon: <IconAlert width={15} height={15} />,
  },
];

const REOPEN_CHOICE: Choice = {
  key: "reopened",
  label: "Reopen",
  meaning: "Back into the queue. The earlier decision stays on the record beside this one.",
  prompt: "What changed, or what the earlier decision missed",
  className: "btn btn-secondary btn-sm",
  icon: <IconHistory width={15} height={15} />,
};

const MAX_REASON = 1000;

type State =
  | { kind: "idle" }
  | { kind: "choosing"; choice: Choice }
  | { kind: "saving"; choice: Choice }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string; choice: Choice };

export function DisposeControls({
  exceptionId,
  canAct,
  open,
}: {
  exceptionId: string;
  canAct: boolean;
  /** From `visit_exception_state.open` — the product's single definition of "still needs
   *  a decision". A closed finding offers Reopen instead of the four decisions. */
  open: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const busy = pending || state.kind === "saving";
  const reasonId = `reason-${exceptionId}`;
  const errorId = `reason-error-${exceptionId}`;

  if (!canAct) {
    return (
      <p className="mt-3 border-t pt-3 text-[12px] hairline" style={{ color: "var(--text-muted)" }}>
        You can read this queue. Closing a finding needs the permission to act on visit
        verification — ask an administrator if you should have it.
      </p>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="mt-3 flex items-start gap-2 border-t pt-3 hairline" role="status">
        <span className="mt-0.5 shrink-0" style={{ color: "var(--color-success-700)" }}>
          <IconCheck width={16} height={16} />
        </span>
        <p className="text-[13px] leading-relaxed">{state.message}</p>
      </div>
    );
  }

  function save(choice: Choice) {
    const words = reason.trim();
    if (!words) return;
    setState({ kind: "saving", choice });
    startTransition(async () => {
      const res = await disposeVisitException(exceptionId, choice.key, words);
      if (!res.ok) {
        setState({
          kind: "error",
          choice,
          message: res.error ?? "The decision could not be saved. Nothing was recorded.",
        });
        return;
      }
      setState({
        kind: "done",
        message: res.unchanged
          ? `This was already recorded as ${choice.label.toLowerCase()}d — nothing was written twice.`
          : `${choice.label}d. Your reason is on the record beside your name, and the finding itself is unchanged.`,
      });
      setReason("");
      router.refresh();
    });
  }

  const choices = open ? OPEN_CHOICES : [REOPEN_CHOICE];

  if (state.kind === "idle") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 hairline">
        {choices.map((c) => (
          <button
            key={c.key}
            type="button"
            className={c.className}
            onClick={() => {
              setReason("");
              setState({ kind: "choosing", choice: c });
            }}
          >
            {c.icon}
            {c.label}
          </button>
        ))}
      </div>
    );
  }

  const choice = state.choice;
  const failed = state.kind === "error";

  return (
    <div className="mt-3 border-t pt-3 hairline">
      <fieldset disabled={busy}>
        <legend className="text-[13px] font-semibold">
          {choice.label} this finding
        </legend>
        <p className="mt-0.5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {choice.meaning}
        </p>

        <label htmlFor={reasonId} className="label mt-3">
          {choice.prompt}
        </label>
        <textarea
          id={reasonId}
          className="textarea"
          rows={3}
          value={reason}
          maxLength={MAX_REASON}
          required
          aria-required="true"
          aria-describedby={failed ? errorId : undefined}
          aria-invalid={failed || undefined}
          placeholder="A sentence is enough — it is what a surveyor reads a year from now."
          onChange={(e) => setReason(e.target.value)}
        />

        {failed && (
          <p id={errorId} role="alert" className="mt-2 text-[13px]" style={{ color: "var(--color-danger-700)" }}>
            {state.message}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={choice.key === "dismissed" ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"}
            disabled={busy || !reason.trim()}
            onClick={() => save(choice)}
          >
            {choice.icon}
            {busy ? "Saving…" : `Save · ${choice.label}`}
          </button>
          <button
            type="button"
            className="btn btn-white btn-sm"
            disabled={busy}
            onClick={() => {
              setReason("");
              setState({ kind: "idle" });
            }}
          >
            Cancel
          </button>
          {!reason.trim() && (
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              A reason is required — it goes on the record.
            </span>
          )}
        </div>
      </fieldset>
    </div>
  );
}
