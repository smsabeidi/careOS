import Link from "next/link";
import { Badge, ErrorState, SectionTitle } from "@/components/ui";
import { IconClock, IconHeart, IconInbox } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { CAPABILITY_FAMILY_WEEKLY } from "@/lib/ai/family-update";
import { FamilyDraftButton } from "./family-draft-button";

/**
 * The family-update card on a client's chart (ST-241, Front Door W7).
 *
 * MOUNTED ONLY BEHIND `front_door.family_weekly`. The gate is the server component that
 * renders this one: it asks Postgres (`app.feature_enabled`) and renders nothing at all
 * when the answer is no — no teaser, no disabled control, no hint that the feature exists.
 * The server action re-asks on every POST, because a page already open must not outlive a
 * flag that was switched off.
 *
 * What the card shows is deliberately narrow: when the family last heard from the care
 * team, whether a draft is already waiting for a decision, and one button. It never shows
 * draft text — a draft lives in the approvals inbox, where it can be edited and disposed,
 * and putting it on the chart would invite a reader to mistake it for something shared.
 *
 * Four states, all honest: the read failed (say so, and say nothing was drafted), no
 * update has ever been shared (say that, and offer the draft), an update was shared on a
 * date (show it), and a draft is already pending (link to it instead of drafting a second).
 */

type LatestUpdate = { id: string; created_at: string };
type PendingDraft = { proposal_id: string; proposed_at: string };

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export async function FamilyUpdateCard({ clientId }: { clientId: string }) {
  const supabase = await supabaseServer();

  const [latestRes, pendingRes] = await Promise.all([
    supabase
      .from("family_update")
      .select("id, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(1),
    // The derived state of the append-only event ledger (0016) — never a status column.
    supabase
      .from("ai_proposal_status")
      .select("proposal_id, proposed_at")
      .eq("capability_key", CAPABILITY_FAMILY_WEEKLY)
      .eq("subject_type", "client")
      .eq("subject_id", clientId)
      .eq("status", "pending")
      .order("proposed_at", { ascending: false })
      .limit(1),
  ]);

  if (latestRes.error) {
    return (
      <section className="mb-6">
        <SectionTitle icon={<IconHeart width={16} height={16} />}>Family update</SectionTitle>
        <ErrorState
          title="Family updates couldn't be read"
          body="Nothing was changed and nothing was shared. This section needs a verified (MFA) session — verify and reload, and the history appears."
        />
      </section>
    );
  }

  const latest = ((latestRes.data ?? []) as LatestUpdate[])[0] ?? null;
  const pending = ((pendingRes.data ?? []) as PendingDraft[])[0] ?? null;

  return (
    <section className="mb-6">
      <SectionTitle icon={<IconHeart width={16} height={16} />}>Family update</SectionTitle>
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[15px] font-medium">
              {latest ? `Last shared ${fmtDate(latest.created_at)}` : "No update shared yet"}
            </p>
            <p
              className="mt-1 max-w-xl text-[13px] leading-relaxed"
              style={{ color: "var(--text-muted)" }}
            >
              {latest
                ? "Updates are permanent once shared: a new update is a new entry, never an edit of that one."
                : "The family portal has no update for this client yet. A draft is written from the last seven days of completed visits and goes to the approvals inbox first."}
            </p>
          </div>

          {pending ? (
            <Badge tone="warning" icon={<IconClock />}>
              Draft waiting for approval
            </Badge>
          ) : null}
        </div>

        <div className="mt-4 border-t pt-4 hairline">
          {pending ? (
            /* A second draft for the same client would put two versions of one week in
               front of one approver. The honest move is to point at the one that exists. */
            <div>
              <p className="text-[14px] font-medium">
                Draft sent for approval —{" "}
                <Link href="/inbox" className="underline">
                  Approvals inbox
                </Link>
              </p>
              <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                <span className="mr-1.5 inline-flex align-[-2px]">
                  <IconInbox width={13} height={13} />
                </span>
                Nothing has reached the family yet. Approve or reject that draft, and this card frees up
                for the next one.
              </p>
            </div>
          ) : (
            <FamilyDraftButton clientId={clientId} />
          )}
        </div>
      </div>
    </section>
  );
}
