"use client";

/**
 * The only client code on this screen: a form shell that reports pending and result state.
 *
 * The eighteen inputs are NOT rendered here — they are passed in as `children`, already
 * rendered on the server. That keeps the field catalogue, the current values and the
 * inheritance labels out of the browser bundle and out of client props; this island holds
 * nothing but submission state (docs/10 §5 — a client island earns its place by
 * interaction, not by convenience).
 *
 * It never assumes success: the message it shows is whatever the Server Action returned,
 * and a refusal says what was preserved (docs/10 voice — what happened, what is saved,
 * what to do next).
 */

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "./actions";

const idle: ActionResult = { ok: true };

export function PolicyForm({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  children,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  pendingLabel?: string;
  children: ReactNode;
}) {
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => action(formData),
    idle
  );
  const message = state.error ?? state.message;

  return (
    <form action={formAction}>
      {children}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4 hairline">
        <button type="submit" disabled={isPending} className="btn btn-primary btn-sm">
          {isPending ? pendingLabel : submitLabel}
        </button>
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Saving creates a new version. The one in force now is kept.
        </p>
        {message && (
          <p
            role="status"
            aria-live="polite"
            className="w-full text-[13px] leading-relaxed"
            style={{ color: state.error ? "var(--color-danger-700)" : "var(--text-secondary)" }}
          >
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
