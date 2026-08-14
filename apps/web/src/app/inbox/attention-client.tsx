"use client";

/**
 * The unified attention queue, client half (ST-238, Front Door W5).
 *
 * WHAT THIS SCREEN HAS TO MAKE OBVIOUS, row by row:
 *   - the severity is a WORD, not a colour (D-012) — "Critical", "Warning",
 *     "For information" — with the lane it came from beside it;
 *   - a row leads somewhere: every lane except proposals deep-links to the surface that
 *     owns it, so the queue is a routing table, never a dead end;
 *   - acknowledging is a RECORD, not a delete — the copy says so, and the row leaves the
 *     queue rather than the database;
 *   - a proposal is NOT acknowledgeable. It expands in place into the same disposition
 *     board the rest of this page uses, because `/inbox` remains the only surface where a
 *     draft is approved or rejected (W5, invariant 8);
 *   - a lane that could not be read says which lane and what is unaffected. A queue that
 *     silently drops a source turns "nothing is waiting" into a lie.
 *
 * PHI (invariant 5): this island receives rows already assembled and RLS-filtered by the
 * server. It holds no query, no id it did not need for the acknowledgement RPC, and it
 * writes nothing to storage — a queue cached in a browser is PHI at rest.
 *
 * @trace ST-238, docs/designs/intelligent-front-door.md W5, D-012, invariants 1, 5, 8
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui";
import { IconAlert, IconCheck, IconChevronRight, IconInbox } from "@/components/icons";
import {
  SEVERITY_TONE,
  SEVERITY_WORD,
  SOURCE_LABEL,
  type AttentionSeverity,
} from "./attention-severity";
import type { AttentionQueue, AttentionRow } from "./attention";
import { InboxBoard, type ProposalView } from "./inbox-client";
import { acknowledgeAlert } from "./attention-actions";

/* ── Severity chip: the colour and the word, always together ────────────────── */

function SeverityChip({ severity }: { severity: AttentionSeverity }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} icon={severity === "info" ? undefined : <IconAlert />}>
      {SEVERITY_WORD[severity]}
    </Badge>
  );
}

/* ── One row ────────────────────────────────────────────────────────────────── */

type RowState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "acked"; message: string }
  | { kind: "error"; message: string };

function QueueRow({
  row,
  proposal,
}: {
  row: AttentionRow;
  /** Present only on `proposal` rows: the draft this row expands into. */
  proposal: ProposalView | null;
}) {
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = pending || state.kind === "saving";

  // An acknowledged row leaves the queue on the spot, and says so where it stood rather
  // than vanishing silently — a row that disappears without a word leaves the reader
  // wondering whether it was cleared or lost. The server revalidates behind this, so the
  // next render drops it entirely: the disappearance is real, not a local illusion.
  if (state.kind === "acked") {
    return (
      <li className="card-inset px-5 py-3" role="status">
        <p className="flex items-start gap-1.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          <IconCheck width={14} height={14} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>{state.message}</span>
        </p>
      </li>
    );
  }

  const panelId = `attention-panel-${row.key.replace(/[^a-zA-Z0-9-]/g, "-")}`;

  function acknowledge() {
    setState({ kind: "saving" });
    startTransition(async () => {
      const res = await acknowledgeAlert(row.source, row.sourceId);
      if (!res.ok) {
        setState({ kind: "error", message: res.error ?? "The acknowledgement was not saved." });
        return;
      }
      setState({ kind: "acked", message: res.message ?? "Acknowledged." });
    });
  }

  return (
    <li className="card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <SeverityChip severity={row.severity} />
            <Badge tone="neutral">{SOURCE_LABEL[row.source]}</Badge>
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {row.when}
            </span>
          </div>
          <p className="text-[15px] font-semibold leading-snug">{row.title}</p>
          {row.detail && (
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {row.detail}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {row.href && row.hrefLabel && (
            <Link href={row.href} className="btn btn-white btn-sm">
              {row.hrefLabel}
              <IconChevronRight width={14} height={14} />
            </Link>
          )}

          {proposal ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide the draft" : "Review the draft"}
            </button>
          ) : (
            <button type="button" className="btn btn-white btn-sm" disabled={busy} onClick={acknowledge}>
              <IconCheck width={14} height={14} />
              {busy ? "Saving…" : "Acknowledge"}
            </button>
          )}
        </div>
      </div>

      {/* A proposal is decided, never dismissed: the row opens the real disposition board. */}
      {proposal && open && (
        <div id={panelId} className="mt-4 border-t pt-4 hairline">
          <InboxBoard proposals={[proposal]} />
        </div>
      )}

      {state.kind === "error" && (
        <p className="mt-2 text-[13px]" role="alert" style={{ color: "var(--color-danger-700)" }}>
          {state.message}
        </p>
      )}
    </li>
  );
}

/* ── The section ────────────────────────────────────────────────────────────── */

export function AttentionQueuePanel({
  queue,
  proposals,
}: {
  queue: AttentionQueue;
  /** The pending drafts, so a proposal row can expand into its real disposition card. */
  proposals: ProposalView[];
}) {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const counts = {
    critical: queue.rows.filter((r) => r.severity === "critical").length,
    warning: queue.rows.filter((r) => r.severity === "warning").length,
    info: queue.rows.filter((r) => r.severity === "info").length,
  };

  return (
    <section aria-labelledby="attention-heading" className="mb-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="attention-heading" className="text-[18px] font-semibold tracking-[-0.01em]">
          Needs your attention
        </h2>
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {queue.rows.length === 0
            ? "Nothing open"
            : `${counts.critical} critical · ${counts.warning} warning · ${counts.info} for information`}
        </p>
      </div>

      <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Everything waiting on you, from every part of CareOS, in one list ordered by how
        serious it is and how long it has waited. You only see what your own access already
        lets you see. Acknowledging a row takes it off your queue and puts your name and the
        time on the record — it never deletes anything, and it never clears it from anyone
        else&rsquo;s queue.
        {queue.hasCredentialRows
          ? " Expired credentials block scheduling — this is enforced automatically."
          : ""}
      </p>

      {/* A lane that could not be read is named, with what is unaffected (error registry). */}
      {queue.failures.length > 0 && (
        <div
          className="card mb-4 px-5 py-4"
          role="alert"
          style={{ background: "var(--color-warning-50)", borderColor: "var(--chip-warning-border)" }}
        >
          <p
            className="flex items-start gap-2 text-[14px] font-semibold"
            style={{ color: "var(--color-warning-700)" }}
          >
            <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
            {queue.failures.length === 1
              ? "One part of this queue could not be read"
              : `${queue.failures.length} parts of this queue could not be read`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {queue.failures.map((f) => (
              <li key={f.source} className="text-[13px] leading-relaxed" style={{ color: "var(--color-warning-700)" }}>
                {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {queue.rows.length === 0 ? (
        <EmptyState
          icon={<IconInbox />}
          title="Nothing is waiting on you"
          body={
            queue.ackedCount > 0
              ? `Every open item you can see has been acknowledged or decided — ${queue.ackedCount} ${
                  queue.ackedCount === 1 ? "row is" : "rows are"
                } on the record with your name against ${queue.ackedCount === 1 ? "it" : "them"}. New credential deadlines, visit findings, clinical flags, notifications and shift offers appear here as they arise.`
              : "Credential deadlines, visit findings, clinical flags, notifications, shift offers and drafts waiting on a decision all arrive here. An empty queue means nothing your access covers is open right now."
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {queue.rows.map((row) => (
            <QueueRow
              key={row.key}
              row={row}
              proposal={row.proposalId ? byId.get(row.proposalId) ?? null : null}
            />
          ))}
        </ul>
      )}

      {queue.ackedCount > 0 && queue.rows.length > 0 && (
        <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {queue.ackedCount} {queue.ackedCount === 1 ? "row is" : "rows are"} hidden because you
          acknowledged {queue.ackedCount === 1 ? "it" : "them"}. Acknowledgements are kept — they
          are never removed — and if a condition happens again it comes back as a new row.
        </p>
      )}
    </section>
  );
}
