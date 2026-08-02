"use client";

/**
 * The approvals inbox, client half (docs/16 Wave 2).
 *
 * The doctrine this UI has to make obvious, item by item:
 *   - the draft is a DRAFT — it sits in a text box the coordinator can rewrite;
 *   - the reason it exists is deterministic and is shown next to it;
 *   - the capability's tier and human-disposer requirement are on the card, not in a
 *     settings screen;
 *   - approve / approve with edits / reject are equally weighted — rejecting is a normal
 *     outcome, and it asks for a reason because the reason is the eval rubric (docs/16 §3.2);
 *   - when no model wrote the text, the card says so instead of implying one did.
 *
 * Every decision is append-only underneath: the original draft and the human's edit both
 * persist, and the proposal row itself is never rewritten (invariant 1).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconPen,
  IconSparkle,
  IconX,
} from "@/components/icons";
import type { DispositionReason } from "@/lib/ai/client";
import { disposeProposal, generateChaseDrafts } from "./actions";

/* ═══════════════════════════════════════════════════════════════════════════
 * Shared view model (built server-side in page.tsx; serializable by design)
 * ═══════════════════════════════════════════════════════════════════════════ */

export type ProposalOrigin = "model" | "fallback" | "unknown";

export type ProposalView = {
  id: string;
  title: string;
  /** The immutable drafted body. The human's edit is a separate, later record. */
  body: string;
  rationale: string | null;
  kind: string;
  capabilityKey: string;
  capabilityName: string;
  tier: string;
  requiresHuman: boolean;
  capabilityEnabled: boolean;
  subjectLabel: string;
  /** Internal deep link into the record this is about; validated server-side. */
  href: string | null;
  confidence: number | null;
  proposedAt: string;
  proposedBy: string;
  status: string;
  origin: ProposalOrigin;
  /** Plain-language truth about where the text came from; null when unremarkable. */
  originNote: string | null;
  disposition: {
    action: string;
    actorName: string;
    at: string;
    note: string | null;
    editedBody: string | null;
  } | null;
  eventCount: number;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * Formatting helpers (explicit locale + zone so server and client agree)
 * ═══════════════════════════════════════════════════════════════════════════ */

const AGENCY_TZ = "America/New_York";

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: AGENCY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const REASONS: { code: DispositionReason; label: string; hint: string }[] = [
  { code: "wrong", label: "Wrong", hint: "A fact or name in the draft is not right" },
  { code: "tone", label: "Tone", hint: "Right facts, wrong voice for this person" },
  { code: "incomplete", label: "Incomplete", hint: "Missing something the reader needs" },
  { code: "unsafe", label: "Unsafe", hint: "Could cause harm, or says too much" },
  { code: "other", label: "Other", hint: "Something else — say what in the note" },
];

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for a decision",
  approved: "Approved",
  edited: "Approved with edits",
  executed: "Approved and sent",
  rejected: "Rejected",
  expired: "Expired",
};

const ORIGIN_LABEL: Record<ProposalOrigin, string> = {
  model: "Model draft",
  fallback: "Deterministic draft",
  unknown: "AI-assisted",
};

const FLYWHEEL_NOTE: Record<string, string> = {
  recorded: "Recorded as evaluation data against the model and prompt version that drafted it.",
  no_model_output:
    "Saved to the proposal record. There was no model output behind this draft, so there is nothing to label.",
  not_recorded:
    "Saved to the proposal record. The evaluation label could not be written — the decision itself still stands.",
};

/* ═══════════════════════════════════════════════════════════════════════════
 * Generate drafts — deterministic candidates in, drafts out
 * ═══════════════════════════════════════════════════════════════════════════ */

type GenerateResult = Awaited<ReturnType<typeof generateChaseDrafts>>;

export function GenerateDraftsButton({ canGenerate }: { canGenerate: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<GenerateResult | null>(null);

  if (!canGenerate) return null;

  function run() {
    setResult(null);
    startTransition(async () => {
      const res = await generateChaseDrafts();
      setResult(res);
      if (res.ok && res.created > 0) router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={pending}>
        <IconSparkle width={15} height={15} />
        {pending ? "Drafting…" : "Generate drafts"}
      </button>
      <p
        aria-live="polite"
        className="max-w-sm text-right text-[12px] leading-relaxed"
        style={{ color: result?.ok === false ? "var(--color-danger-700)" : "var(--text-muted)" }}
      >
        {pending
          ? "Reading the credential, cadence and exception engines…"
          : result
            ? result.ok
              ? `${result.message}${
                  result.deterministic > 0 && result.degradeReason
                    ? ` The model was unavailable (${result.degradeReason}).`
                    : ""
                }`
              : (result.error ?? "Nothing was drafted.")
            : ""}
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * The board
 * ═══════════════════════════════════════════════════════════════════════════ */

export function InboxBoard({ proposals }: { proposals: ProposalView[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {proposals.map((p) => (
        <li key={p.id}>{p.status === "pending" ? <PendingCard p={p} /> : <DisposedCard p={p} />}</li>
      ))}
    </ul>
  );
}

/* ── Card chrome shared by both states ─────────────────────────────────────── */

function CardHeader({ p }: { p: ProposalView }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{p.title}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          <span>{p.subjectLabel}</span>
          <span aria-hidden>·</span>
          <span>
            Proposed {stamp(p.proposedAt)} by {p.proposedBy}
          </span>
          {p.href && (
            <>
              <span aria-hidden>·</span>
              <Link href={p.href} className="inline-flex items-center gap-0.5 font-medium" style={{ color: "var(--accent-text)" }}>
                Open the record
                <IconChevronRight width={13} height={13} />
              </Link>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Badge tone={p.tier === "T0" || p.tier === "T1" ? "info" : "accent"} icon={<IconSparkle />}>
          {p.capabilityName} · {p.tier}
          {p.requiresHuman ? " · human decides" : ""}
        </Badge>
        <Badge tone={p.origin === "model" ? "accent" : "neutral"}>{ORIGIN_LABEL[p.origin]}</Badge>
        {typeof p.confidence === "number" && (
          <Badge tone="neutral">{Math.round(p.confidence * 100)}% confidence</Badge>
        )}
      </div>
    </div>
  );
}

function Rationale({ p }: { p: ProposalView }) {
  if (!p.rationale) return null;
  return (
    <div className="card-inset mt-3 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}>
        Why this was proposed
      </p>
      <p className="mt-1 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {p.rationale}
      </p>
    </div>
  );
}

function OriginNote({ p }: { p: ProposalView }) {
  if (!p.originNote) return null;
  return (
    <p
      className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed"
      style={{ color: "var(--text-muted)" }}
    >
      <IconAlert width={13} height={13} style={{ marginTop: 2, flexShrink: 0 }} />
      <span>{p.originNote}</span>
    </p>
  );
}

/* ── Pending: the editable draft plus the three decisions ──────────────────── */

type CardState =
  | { kind: "idle" }
  | { kind: "rejecting" }
  | { kind: "saving" }
  | { kind: "done"; heading: string; note: string }
  | { kind: "error"; message: string };

function PendingCard({ p }: { p: ProposalView }) {
  const router = useRouter();
  const [text, setText] = useState(p.body);
  const [state, setState] = useState<CardState>({ kind: "idle" });
  const [reason, setReason] = useState<DispositionReason | null>(null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const edited = text.trim() !== p.body.trim();
  const busy = pending || state.kind === "saving";

  function dispose(
    decision: "approve" | "approve_edited" | "reject",
    heading: string,
    reasonCode?: DispositionReason
  ) {
    setState({ kind: "saving" });
    startTransition(async () => {
      const res = await disposeProposal(
        p.id,
        decision,
        decision === "approve_edited" ? text : undefined,
        reasonCode,
        note.trim() || undefined
      );
      if (!res.ok) {
        setState({ kind: "error", message: res.error ?? "The decision was not saved." });
        return;
      }
      setState({
        kind: "done",
        heading,
        note: FLYWHEEL_NOTE[res.flywheel ?? "not_recorded"] ?? FLYWHEEL_NOTE.not_recorded,
      });
      router.refresh();
    });
  }

  if (state.kind === "done") {
    return (
      <div className="card px-5 py-5" role="status">
        <div className="flex items-start gap-3">
          <span style={{ color: "var(--color-success-700)" }}>
            <IconCheck width={18} height={18} />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">{state.heading}</p>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              {state.note}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const textareaId = `draft-${p.id}`;
  const noteId = `note-${p.id}`;

  return (
    <div className="card px-5 py-5">
      <CardHeader p={p} />

      {!p.capabilityEnabled && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
          This capability is paused, so no new drafts are being written. Items already proposed are still
          yours to approve or reject.
        </p>
      )}

      <div className="mt-4">
        <label htmlFor={textareaId} className="text-[13px] font-medium">
          Drafted message
        </label>
        <p className="mb-1.5 mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Edit it freely. Your version is saved beside the original — neither one overwrites the other.
        </p>
        <textarea
          id={textareaId}
          className="textarea w-full"
          rows={6}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <Rationale p={p} />
      <OriginNote p={p} />

      {state.kind === "rejecting" ? (
        <fieldset className="mt-4 border-t pt-4 hairline" disabled={busy}>
          <legend className="text-[13px] font-medium">Why is this being rejected?</legend>
          <p className="mb-2.5 mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
            The reason is what turns a rejection into evaluation data. Pick the closest one.
          </p>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <label
                key={r.code}
                className="btn btn-white btn-sm btn-pill cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)]"
                style={
                  reason === r.code
                    ? { background: "var(--accent-soft)", color: "var(--accent-text)", borderColor: "var(--accent-soft-border)" }
                    : undefined
                }
              >
                <input
                  type="radio"
                  name={`reason-${p.id}`}
                  value={r.code}
                  checked={reason === r.code}
                  aria-label={`${r.label} — ${r.hint}`}
                  onChange={() => setReason(r.code)}
                  className="sr-only"
                />
                {r.label}
              </label>
            ))}
          </div>

          <div className="mt-3">
            <label htmlFor={noteId} className="text-[13px] font-medium">
              Note (optional)
            </label>
            <input
              id={noteId}
              className="input mt-1.5 w-full"
              placeholder="What a reviewer should know — in your words"
              value={note}
              maxLength={280}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy || !reason}
              onClick={() => dispose("reject", "Rejected", reason ?? undefined)}
            >
              <IconX width={15} height={15} />
              {busy ? "Saving…" : "Confirm rejection"}
            </button>
            <button
              type="button"
              className="btn btn-white btn-sm"
              disabled={busy}
              onClick={() => setState({ kind: "idle" })}
            >
              Cancel
            </button>
            {!reason && (
              <span className="self-center text-[12px]" style={{ color: "var(--text-muted)" }}>
                Choose a reason to continue.
              </span>
            )}
          </div>
        </fieldset>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4 hairline">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || edited}
            onClick={() => dispose("approve", "Approved")}
          >
            <IconCheck width={15} height={15} />
            Approve
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !edited}
            onClick={() => dispose("approve_edited", "Approved with your edits")}
          >
            <IconPen width={15} height={15} />
            Approve with edits
          </button>
          <button
            type="button"
            className="btn btn-white btn-sm"
            disabled={busy}
            onClick={() => {
              setReason(null);
              setState({ kind: "rejecting" });
            }}
          >
            <IconX width={15} height={15} />
            Reject
          </button>
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {busy
              ? "Saving your decision…"
              : edited
                ? "Edited — approve with edits keeps both versions."
                : "Nothing is sent until you decide."}
          </span>
        </div>
      )}

      {state.kind === "error" && (
        <p className="mt-3 text-[13px]" role="alert" style={{ color: "var(--color-danger-700)" }}>
          {state.message}
        </p>
      )}
    </div>
  );
}

/* ── Disposed: the decision, in the disposer's words, with both texts kept ─── */

function DisposedCard({ p }: { p: ProposalView }) {
  const d = p.disposition;
  const final = d?.editedBody ?? p.body;
  const wasEdited = Boolean(d?.editedBody && d.editedBody.trim() !== p.body.trim());
  const rejected = p.status === "rejected" || p.status === "expired";

  return (
    <div className="card px-5 py-5">
      <CardHeader p={p} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge
          tone={rejected ? "danger" : p.status === "executed" ? "success" : "success"}
          icon={rejected ? <IconX /> : <IconCheck />}
        >
          {STATUS_LABEL[p.status] ?? p.status}
        </Badge>
        {d && (
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            {d.actorName} · {stamp(d.at)}
          </span>
        )}
        <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          <IconClock width={12} height={12} style={{ display: "inline", marginRight: 4, verticalAlign: -1 }} />
          {p.eventCount} {p.eventCount === 1 ? "entry" : "entries"} on the record
        </span>
      </div>

      {d?.note && (
        <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          “{d.note}”
        </p>
      )}

      <div className="card-inset mt-3 whitespace-pre-wrap px-4 py-3 text-[14px] leading-relaxed">{final}</div>

      {wasEdited && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px]" style={{ color: "var(--text-muted)" }}>
            Show the original draft
          </summary>
          <div
            className="card-inset mt-2 whitespace-pre-wrap px-4 py-3 text-[13px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            {p.body}
          </div>
        </details>
      )}

      <Rationale p={p} />
      <OriginNote p={p} />
    </div>
  );
}
