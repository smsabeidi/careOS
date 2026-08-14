"use client";

/**
 * The one interactive island on the client chart: asking for a family update draft
 * (ST-241, Front Door W7).
 *
 * It holds no PHI of its own. The server resolved the client under RLS and handed this
 * island an id and a first name; everything the draft is written from is read server-side,
 * on demand, and never travels to the browser. What comes back is a sentence about what
 * happened — never the draft itself, because the draft belongs in the approvals inbox
 * where it can be edited and disposed, not on a chart page where it could be mistaken for
 * something already shared.
 *
 * Every outcome is spoken, not coloured (D-012): the consent refusal, the degrade paths and
 * the success all render their own sentence, and the live region announces the change so a
 * screen-reader user learns the result without hunting for it.
 */

import Link from "next/link";
import { useState, useTransition } from "react";
import { IconAlert, IconCheck, IconLock, IconSparkle } from "@/components/icons";
import { requestFamilyUpdateDraft, type FamilyDraftActionResult } from "./family-actions";

type State = { kind: "idle" } | { kind: "working" } | { kind: "done"; result: FamilyDraftActionResult };

export function FamilyDraftButton({ clientId }: { clientId: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const busy = pending || state.kind === "working";

  function run() {
    setState({ kind: "working" });
    startTransition(async () => {
      const result = await requestFamilyUpdateDraft(clientId);
      setState({ kind: "done", result });
    });
  }

  const result = state.kind === "done" ? state.result : null;

  return (
    <div>
      <button type="button" onClick={run} disabled={busy} className="btn btn-secondary btn-sm">
        <IconSparkle width={14} height={14} />
        {busy ? "Drafting…" : "Draft this week's update"}
      </button>

      {/* One live region for every outcome, so the result is announced once and read in
          the same place each time. */}
      <div aria-live="polite" className="mt-3 empty:mt-0">
        {busy && (
          <p className="text-[13.5px]" style={{ color: "var(--text-muted)" }}>
            Reading this week&apos;s visits and writing a draft. Nothing is shared until you approve it.
          </p>
        )}

        {result?.ok && (
          <div className="card-inset px-4 py-3.5">
            <p className="flex items-start gap-2 text-[14px] font-medium">
              <span style={{ color: "var(--color-success-700)" }} className="mt-0.5 flex shrink-0">
                <IconCheck width={16} height={16} />
              </span>
              <span>
                Draft sent for approval —{" "}
                <Link href="/inbox" className="underline">
                  Approvals inbox
                </Link>
              </span>
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Nothing has reached the family yet. Approving it there is what shares it.
            </p>
            {result.note && (
              <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {result.note}
              </p>
            )}
          </div>
        )}

        {result && !result.ok && result.kind === "consent" && (
          <div className="card-inset px-4 py-3.5" role="status">
            <p className="flex items-start gap-2 text-[14px] font-medium">
              <span style={{ color: "var(--text-muted)" }} className="mt-0.5 flex shrink-0">
                <IconLock width={16} height={16} />
              </span>
              {result.error}
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Nothing was read from this week&apos;s visits and nothing was written. Record the family&apos;s
              consent for updates first, and this will draft from the same visits.
            </p>
          </div>
        )}

        {result && !result.ok && result.kind === "refused" && (
          <p
            role="alert"
            className="flex items-start gap-2 text-[13.5px] leading-relaxed"
            style={{ color: "var(--color-danger-700)" }}
          >
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
            {result.error}
          </p>
        )}
      </div>
    </div>
  );
}
