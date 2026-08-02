"use client";

/**
 * Care-plan review drafting (docs/16 §2.4 R2) — the RN's side-by-side.
 *
 * The left column is the plan as it stands today, read from the database. The right
 * column is what the drafter proposes, each item anchored to the record it came from.
 * The nurse keeps, edits, rejects, or writes their own; pressing save authors a NEW
 * plan version (append-only — the current version is never touched, and it stays
 * visible in the list underneath as the version this one revises).
 *
 * With the model unavailable the left column and the record list are unchanged, the
 * right column says so in one line, and the nurse can still write their own revisions
 * and save a version. The surface never depends on a model being reachable.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  commitCarePlanReview,
  discardCarePlanReview,
  draftCarePlanReview,
  type CarePlanDraft,
  type CommitItem,
} from "./clinical-actions";
import { Avatar, Badge, DueChip, EmptyState, StatusChip } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconHeart,
  IconHistory,
  IconPen,
  IconPlus,
  IconSparkle,
  IconX,
} from "@/components/icons";

export type CarePlanRowView = {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  version: number;
  status: string;
  reviewDueOn: string | null;
  /** Deterministic: the platform's review date is inside the review window (or past). */
  reviewDue: boolean;
};

type Editable = {
  key: string;
  kind: "goal" | "intervention";
  text: string;
  target: string;
  accepted: boolean;
  origin: "carried" | "proposed" | "nurse";
  originalText?: string;
  originalTarget?: string;
  anchorLabel?: string;
  rationale?: string;
};

function toEditables(draft: CarePlanDraft): Editable[] {
  const carried: Editable[] = draft.currentItems.map((i) => ({
    key: `c-${i.id}`,
    kind: i.kind,
    text: i.text,
    target: i.target ?? "",
    accepted: true,
    origin: "carried",
  }));
  const proposed: Editable[] = draft.proposals.map((p) => ({
    key: `p-${p.ref}`,
    kind: p.kind,
    text: p.text,
    target: p.target ?? "",
    accepted: false,
    origin: "proposed",
    originalText: p.text,
    originalTarget: p.target ?? "",
    anchorLabel: p.anchorLabel,
    rationale: p.rationale,
  }));
  return [...carried, ...proposed];
}

export function CarePlanReviewPanel({
  plans,
  canReview,
}: {
  plans: CarePlanRowView[];
  canReview: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CarePlanDraft | null>(null);
  const [items, setItems] = useState<Editable[]>([]);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ version: number; itemCount: number; clientName: string } | null>(null);

  const dueCount = plans.filter((p) => p.reviewDue).length;

  function openDraft(planId: string) {
    setError(null);
    setSaved(null);
    setOpenPlanId(planId);
    setDraft(null);
    startTransition(async () => {
      const res = await draftCarePlanReview(planId);
      if (!res.ok) {
        setError(res.error);
        setOpenPlanId(null);
        return;
      }
      setDraft(res.draft);
      setItems(toEditables(res.draft));
      setSummary(res.draft.proposedSummary ?? res.draft.currentSummary ?? "");
    });
  }

  /** Walking away from real proposals is a rejection; walking away from "no change
   *  proposed" is not, so only the first case becomes a training label. */
  function closeDraft(recordRejection: boolean) {
    const hadProposals = (draft?.proposals.length ?? 0) > 0;
    const interactionId =
      draft && !draft.ai.degraded && hadProposals ? draft.ai.interactionId : null;
    setOpenPlanId(null);
    setDraft(null);
    setItems([]);
    setSummary("");
    setError(null);
    if (recordRejection && interactionId) void discardCarePlanReview(interactionId);
  }

  const accepted = items.filter((i) => i.accepted);
  const proposals = items.filter((i) => i.origin === "proposed");
  const acceptedProposals = proposals.filter((i) => i.accepted);
  const nurseItems = items.filter((i) => i.origin === "nurse");

  /** Disposition label: what the nurse actually did with what the model proposed. */
  const disposition: "accepted" | "edited" | "rejected" = useMemo(() => {
    if (proposals.length === 0) return "rejected";
    if (acceptedProposals.length === 0) return "rejected";
    const changed = acceptedProposals.some(
      (p) => p.text !== p.originalText || p.target !== (p.originalTarget ?? "")
    );
    if (changed || acceptedProposals.length < proposals.length || nurseItems.length > 0) return "edited";
    return "accepted";
  }, [proposals, acceptedProposals, nurseItems]);

  function addItem(kind: "goal" | "intervention") {
    setItems((prev) => [
      ...prev,
      {
        key: `n-${kind}-${Date.now()}-${prev.length}`,
        kind,
        text: "",
        target: "",
        accepted: true,
        origin: "nurse",
      },
    ]);
  }

  function update(key: string, patch: Partial<Editable>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function save() {
    if (!draft) return;
    setError(null);
    const payload: CommitItem[] = accepted
      .filter((i) => i.text.trim())
      .map((i) => ({
        kind: i.kind,
        text: i.text.trim(),
        target: i.target.trim() ? i.target.trim() : null,
        source: i.origin,
      }));
    if (payload.length === 0) {
      setError("A plan version needs at least one goal or intervention. Nothing was saved.");
      return;
    }

    const interactionId = draft.ai.degraded ? null : draft.ai.interactionId;
    startTransition(async () => {
      const res = await commitCarePlanReview({
        planId: draft.planId,
        items: payload,
        summary: summary.trim() ? summary.trim() : null,
        aiInteractionId: disposition === "rejected" ? null : interactionId,
        edited: disposition === "edited",
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A rejected set is still the label the flywheel most needs.
      if (disposition === "rejected" && interactionId) void discardCarePlanReview(interactionId);
      setSaved({ version: res.version, itemCount: res.itemCount, clientName: draft.clientName });
      setOpenPlanId(null);
      setDraft(null);
      setItems([]);
      setSummary("");
      router.refresh();
    });
  }

  /* ── The review sheet ──────────────────────────────────────────────────── */
  if (openPlanId) {
    return (
      <section className="rise">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
            <span className="flex" style={{ color: "var(--accent)" }}>
              <IconPen width={16} height={16} />
            </span>
            {draft ? `Review · ${draft.title} · ${draft.clientName}` : "Drafting review…"}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => closeDraft(true)}>
            <IconX width={14} height={14} />
            Close without saving
          </button>
        </div>

        {!draft ? (
          <div className="card p-5" aria-busy="true">
            <div className="skeleton h-3.5 w-1/3" />
            <div className="skeleton mt-2.5 h-3.5 w-full" />
            <div className="skeleton mt-2.5 h-3.5 w-2/3" />
            <p className="mt-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
              Reading the plan and the records filed since it was authored. Nothing is saved until you
              press save.
            </p>
          </div>
        ) : (
          <>
            <div className="card mb-4 flex flex-wrap items-center gap-2 px-5 py-3.5">
              <Badge tone="neutral">Current version v{draft.version}</Badge>
              {draft.reviewDueOn && <DueChip due={draft.reviewDueOn} prefix="Review" />}
              {draft.ai.degraded ? (
                <Badge tone="warning" icon={<IconAlert />}>
                  Drafting unavailable
                </Badge>
              ) : draft.noChange && draft.proposals.length === 0 ? (
                <Badge tone="success" icon={<IconCheck />}>
                  No revisions proposed
                </Badge>
              ) : (
                <Badge tone="accent" icon={<IconSparkle />}>
                  {draft.proposals.length} proposed {draft.proposals.length === 1 ? "revision" : "revisions"}
                </Badge>
              )}
              <span className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                {draft.ai.note ??
                  "You are the author. Keep what still fits, accept or edit what is proposed, then save a new version."}
              </span>
            </div>

            {error && (
              <div className="card mb-4 px-5 py-3.5" role="alert">
                <p className="flex items-start gap-2 text-[13.5px]" style={{ color: "var(--color-danger-700)" }}>
                  <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </p>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              {/* Left — the plan as it stands */}
              <div className="card overflow-hidden">
                <header className="border-b px-5 py-3 hairline">
                  <p className="text-[14px] font-semibold">Current plan · v{draft.version}</p>
                  <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                    Untick anything that no longer belongs. It stays on version {draft.version} either way.
                  </p>
                </header>
                <div className="flex flex-col gap-3 px-5 py-4">
                  {draft.currentSummary && (
                    <p className="text-[13.5px]" style={{ color: "var(--text-secondary)" }}>
                      {draft.currentSummary}
                    </p>
                  )}
                  {items.filter((i) => i.origin === "carried").length === 0 ? (
                    <p className="text-[13.5px]" style={{ color: "var(--text-muted)" }}>
                      This version has no goals or interventions on file.
                    </p>
                  ) : (
                    items
                      .filter((i) => i.origin === "carried")
                      .map((i) => (
                        <label key={i.key} className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={i.accepted}
                            onChange={(e) => update(i.key, { accepted: e.target.checked })}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge tone="neutral">{i.kind === "goal" ? "Goal" : "Intervention"}</Badge>
                            </span>
                            <span className="mt-1 block text-[14px] leading-relaxed">{i.text}</span>
                            {i.target && (
                              <span className="mt-0.5 block text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                                Target: {i.target}
                              </span>
                            )}
                          </span>
                        </label>
                      ))
                  )}
                </div>

                {draft.records.length > 0 && (
                  <div className="border-t px-5 py-4 hairline">
                    <p
                      className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase"
                      style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
                    >
                      <IconHistory width={13} height={13} />
                      {draft.recordsWindow === "since_version"
                        ? "Records since this version"
                        : "Recent records in the chart"}
                    </p>
                    {draft.recordsWindow === "recent" && (
                      <p className="mb-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Nothing has been filed since version {draft.version} was authored, so the draft
                        reads the most recent records in the chart instead.
                      </p>
                    )}
                    <ul className="flex flex-col gap-2">
                      {draft.records.map((r) => (
                        <li key={r.ref} className="text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
                          <span className="font-medium">
                            {r.label} · {r.date}
                          </span>{" "}
                          — {r.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Right — what is proposed, and anything the nurse adds */}
              <div className="card overflow-hidden">
                <header className="border-b px-5 py-3 hairline">
                  <p className="text-[14px] font-semibold">Proposed for v{draft.version + 1}</p>
                  <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                    Nothing here is in the chart until you save. Every proposal names the record it
                    stands on.
                  </p>
                </header>

                <div className="flex flex-col gap-4 px-5 py-4">
                  {proposals.length === 0 && nurseItems.length === 0 && (
                    <p className="text-[13.5px]" style={{ color: "var(--text-muted)" }}>
                      {draft.ai.degraded
                        ? "No draft is available right now. Add your own goals or interventions below — the version you save is authored by you either way."
                        : "The records since this version show no meaningful change, so nothing is proposed. You can still add a revision of your own."}
                    </p>
                  )}

                  {items
                    .filter((i) => i.origin !== "carried")
                    .map((i) => (
                      <div key={i.key} className="flex flex-col gap-1.5">
                        <label className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={i.accepted}
                            onChange={(e) => update(i.key, { accepted: e.target.checked })}
                          />
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={i.origin === "nurse" ? "neutral" : "accent"}>
                              {i.kind === "goal" ? "Goal" : "Intervention"}
                            </Badge>
                            {i.origin === "proposed" && i.anchorLabel && (
                              <Badge tone="neutral">From {i.anchorLabel}</Badge>
                            )}
                            {i.origin === "nurse" && <Badge tone="neutral">Yours</Badge>}
                          </span>
                        </label>

                        <textarea
                          className="textarea"
                          rows={2}
                          value={i.text}
                          disabled={!i.accepted}
                          placeholder={
                            i.kind === "goal"
                              ? "What the plan is aiming for"
                              : "What the caregiver or nurse will do"
                          }
                          onChange={(e) => update(i.key, { text: e.target.value })}
                          aria-label={`${i.kind === "goal" ? "Goal" : "Intervention"} text`}
                        />
                        <input
                          className="input"
                          value={i.target}
                          disabled={!i.accepted}
                          placeholder="Measurable target or frequency (optional)"
                          onChange={(e) => update(i.key, { target: e.target.value })}
                          aria-label="Target or frequency"
                        />
                        {i.rationale && (
                          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                            Why: {i.rationale}
                          </p>
                        )}
                      </div>
                    ))}

                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => addItem("goal")}>
                      <IconPlus width={14} height={14} />
                      Add a goal
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => addItem("intervention")}
                    >
                      <IconPlus width={14} height={14} />
                      Add an intervention
                    </button>
                  </div>

                  <div>
                    <label className="label" htmlFor="plan-summary">
                      Plan summary for the new version
                    </label>
                    <textarea
                      id="plan-summary"
                      className="textarea"
                      rows={3}
                      value={summary}
                      placeholder="Plain-language overview of the plan"
                      onChange={(e) => setSummary(e.target.value)}
                    />
                    <p className="mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                      The review date carries forward unchanged — cadence dates are set by the platform,
                      never by this screen.
                    </p>
                  </div>
                </div>

                <footer className="flex flex-wrap items-center gap-2 border-t px-5 py-3.5 hairline">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={pending}
                    onClick={save}
                  >
                    <IconCheck width={15} height={15} />
                    {pending ? "Saving…" : `Save as version ${draft.version + 1}`}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={pending}
                    onClick={() => closeDraft(true)}
                  >
                    Discard draft
                  </button>
                  <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {accepted.length} {accepted.length === 1 ? "item" : "items"} will be saved. Version{" "}
                    {draft.version} stays on file unchanged.
                  </span>
                </footer>
              </div>
            </div>
          </>
        )}
      </section>
    );
  }

  /* ── The plan list ─────────────────────────────────────────────────────── */
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
          <span className="flex" style={{ color: "var(--accent)" }}>
            <IconHeart width={16} height={16} />
          </span>
          Care plans on your caseload
        </h2>
        {dueCount > 0 && (
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            {dueCount} {dueCount === 1 ? "plan is" : "plans are"} in the review window
          </span>
        )}
      </div>

      {saved && (
        <div className="card mb-4 px-5 py-3.5" role="status">
          <p className="flex items-start gap-2 text-[13.5px]">
            <IconCheck width={15} height={15} className="mt-0.5 shrink-0" style={{ color: "var(--color-success-600)" }} />
            <span>
              Saved as version {saved.version} for {saved.clientName} with {saved.itemCount}{" "}
              {saved.itemCount === 1 ? "item" : "items"}. It is a draft until it is finalized, and every
              earlier version is still on file.
            </span>
          </p>
        </div>
      )}

      {error && !openPlanId && (
        <div className="card mb-4 px-5 py-3.5" role="alert">
          <p className="flex items-start gap-2 text-[13.5px]" style={{ color: "var(--color-danger-700)" }}>
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        </div>
      )}

      {plans.length === 0 ? (
        <EmptyState
          icon={<IconHeart />}
          title="No care plans yet"
          body="A care plan is authored as version 1; revisions add new versions and never overwrite. Plans for your clients appear here."
        />
      ) : (
        <div className="card stagger divide-y hairline overflow-hidden">
          {plans.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <Avatar name={p.clientName} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">
                  {p.clientName}
                  <span style={{ color: "var(--text-muted)" }}> · {p.title}</span>
                </p>
                <p className="tabular mt-0.5 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                  Version {p.version}
                </p>
              </div>
              <StatusChip status={p.status} />
              {p.reviewDueOn ? (
                <DueChip due={p.reviewDueOn} prefix="Review" />
              ) : (
                <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                  No review date
                </span>
              )}
              {canReview && p.reviewDue && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm shrink-0"
                  disabled={pending}
                  onClick={() => openDraft(p.id)}
                >
                  <IconSparkle width={14} height={14} />
                  Draft review
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
