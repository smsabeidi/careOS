"use client";

/**
 * The only client code on this screen: a form shell that reports pending and result state.
 *
 * Every input is passed in as `children`, already rendered on the server. That matters more
 * here than elsewhere — the fields carry a client's address, which is PHI. Keeping them
 * server-rendered means the address is markup on an authenticated page and never a prop
 * crossing into a client component or a value the bundle has to carry (docs/10 §5).
 *
 * Deliberateness is NOT handled here. The one act on this screen that is a signature —
 * confirming a pin, which puts the coordinator's name on the record (D-025) — is guarded by
 * a required attestation checkbox rendered on the server and re-checked inside the Server
 * Action. That is enforced by the browser's own constraint validation and again by the
 * action, rather than by a JavaScript dialog that a direct POST would never see.
 */

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "./actions";

const idle: ActionResult = { ok: true };

export function LocationForm({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  variant = "primary",
  children,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary";
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
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className={`btn btn-sm ${variant === "primary" ? "btn-primary" : "btn-secondary"}`}
        >
          {isPending ? pendingLabel : submitLabel}
        </button>
        {message && (
          <p
            role="status"
            aria-live="polite"
            className="min-w-0 flex-1 text-[13px] leading-relaxed"
            style={{ color: state.error ? "var(--color-danger-700)" : "var(--text-secondary)" }}
          >
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
