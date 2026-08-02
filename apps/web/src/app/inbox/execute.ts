/**
 * Execution — what actually happens when a human approves a proposal.
 *
 * Without this the inbox is a decision log: an approved family update never reaches the
 * family, an approved assignment never fills the shift. This module is the other half of
 * invariant 8 — the human disposes, and *then* the platform acts, in that order.
 *
 * Three rules hold everywhere below:
 *
 *  1. **Re-verify at execution time, never trust the proposal.** A shift-fill plan drafted
 *     at 06:02 may be wrong at 06:20 — a credential can lapse in between. Eligibility is
 *     re-checked against `app.assert_schedulable` immediately before the write, and a
 *     candidate who has since become blocked is refused. The proposal is a suggestion; the
 *     engine is the authority (invariant 13).
 *  2. **Write under the approver's own client.** Every effect below runs through the
 *     user-scoped Supabase client, so RLS decides what is permitted — consent gating on
 *     family updates, `schedule.write` on assignments. There is no privileged path
 *     (invariant 6).
 *  3. **Say what did not happen.** Outbound delivery (SMS/email) has no vendor in the
 *     docs/09 §6 register and therefore no BAA, so this platform does not send messages.
 *     An approved chase message is recorded and handed back for a human to send — the UI
 *     says exactly that rather than implying a send occurred.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ExecutionOutcome = {
  /** true when a durable side effect was written. */
  executed: boolean;
  /** Plain-language result for the approver. Always set. */
  message: string;
  /** Paths to revalidate so the effect is visible immediately. */
  revalidate: string[];
};

type ProposalForExecution = {
  id: string;
  tenant_id: string;
  capability_key: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  title: string | null;
  body: string | null;
  payload: unknown;
};

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Share an approved update with the family. RLS enforces the consent gate: the insert
 * only succeeds where the client has granted family-portal consent covering updates, so
 * approval can never widen what a family is entitled to see.
 */
async function executeFamilyUpdate(
  supabase: SupabaseClient,
  proposal: ProposalForExecution,
  approvedBody: string,
  actorId: string
): Promise<ExecutionOutcome> {
  const clientId =
    proposal.subject_type === "client" && proposal.subject_id
      ? proposal.subject_id
      : (payloadObject(proposal.payload).client_id as string | undefined) ?? null;

  if (!clientId) {
    return {
      executed: false,
      message: "Approved and recorded. It was not published because this draft is not linked to a client.",
      revalidate: [],
    };
  }

  const { error } = await supabase.from("family_update").insert({
    tenant_id: proposal.tenant_id,
    client_id: clientId,
    author_id: actorId,
    title: (proposal.title ?? "Update from the care team").slice(0, 200),
    body: approvedBody,
  });

  if (error) {
    return {
      executed: false,
      message:
        "Approved and recorded, but it was not published to the family portal. That requires consent for updates to be on file for this client.",
      revalidate: [],
    };
  }
  return {
    executed: true,
    message: "Approved and published. The family can see this update in their portal now.",
    revalidate: ["/family", "/office/clients"],
  };
}

/**
 * Fill an open shift with the approved caregiver — after re-proving eligibility. The
 * scheduling guard runs again here because time has passed since the plan was drafted.
 */
async function executeAssignment(
  supabase: SupabaseClient,
  proposal: ProposalForExecution
): Promise<ExecutionOutcome> {
  const payload = payloadObject(proposal.payload);
  const visitId =
    proposal.subject_type === "visit" && proposal.subject_id
      ? proposal.subject_id
      : (payload.visit_id as string | undefined) ?? null;
  const caregiverId =
    (payload.caregiver_id as string | undefined) ??
    (Array.isArray(payload.outreach_order) && payload.outreach_order.length > 0
      ? ((payload.outreach_order[0] as Record<string, unknown>)?.caregiver_id as string | undefined)
      : undefined) ??
    null;

  if (!visitId || !caregiverId) {
    return {
      executed: false,
      message:
        "Approved and recorded. No assignment was written because this plan does not name a single caregiver — open the schedule to assign.",
      revalidate: ["/schedule"],
    };
  }

  const { data: visit } = await supabase
    .from("visit")
    .select("id, client_id, caregiver_id, scheduled_start, scheduled_end, status")
    .eq("id", visitId)
    .maybeSingle();

  if (!visit) {
    return { executed: false, message: "Approved and recorded. That visit is no longer available.", revalidate: [] };
  }
  const v = visit as {
    id: string;
    client_id: string;
    caregiver_id: string | null;
    scheduled_start: string;
    scheduled_end: string;
    status: string;
  };
  if (v.caregiver_id) {
    return {
      executed: false,
      message: "Approved and recorded. Someone else was already assigned to this visit, so nothing was changed.",
      revalidate: ["/schedule"],
    };
  }

  // The authority on eligibility, re-run at the moment of the write (invariant 13).
  const { data: guard } = await supabase.schema("app").rpc("assert_schedulable", {
    p_caregiver: caregiverId,
    p_client: v.client_id,
    p_window: `[${v.scheduled_start},${v.scheduled_end})`,
  });
  const verdict = guard as { schedulable?: boolean; blockers?: { name?: string; reason?: string }[] } | null;
  if (verdict && verdict.schedulable === false) {
    const first = verdict.blockers?.[0];
    const why = first?.name ? `${first.name} is ${first.reason ?? "not valid"}` : "a credential is not valid";
    return {
      executed: false,
      message: `Approved and recorded, but the assignment was refused: ${why}. The shift is still open.`,
      revalidate: ["/schedule"],
    };
  }

  const { error } = await supabase
    .from("visit")
    .update({ caregiver_id: caregiverId, updated_at: new Date().toISOString() })
    .eq("id", visitId);

  if (error) {
    return {
      executed: false,
      message: "Approved and recorded. The assignment was not written — scheduling permission is required.",
      revalidate: ["/schedule"],
    };
  }
  return {
    executed: true,
    message: "Approved and assigned. The shift is filled and the caregiver sees it on their day.",
    revalidate: ["/schedule", "/today"],
  };
}

/**
 * Run the side effect for an approved proposal. Never throws: a failed effect still
 * leaves the approval on the record, and the approver is told plainly what happened.
 */
export async function executeApprovedProposal(
  supabase: SupabaseClient,
  proposal: ProposalForExecution,
  approvedBody: string,
  actorId: string
): Promise<ExecutionOutcome> {
  try {
    if (proposal.capability_key === "family.update") {
      return await executeFamilyUpdate(supabase, proposal, approvedBody, actorId);
    }
    if (proposal.kind === "assignment" || proposal.capability_key === "shift.fill") {
      return await executeAssignment(supabase, proposal);
    }
    if (proposal.kind === "message") {
      // Deliberately not sent: no messaging vendor is in the docs/09 §6 register, so there
      // is no BAA covering outbound PHI. The approved wording is the deliverable.
      return {
        executed: false,
        message:
          "Approved and recorded. CareOS does not send messages yet — copy the approved wording to send it from your own phone or email.",
        revalidate: [],
      };
    }
    return { executed: false, message: "Approved and recorded.", revalidate: [] };
  } catch {
    return {
      executed: false,
      message: "Approved and recorded. The follow-up action did not complete — nothing else was changed.",
      revalidate: [],
    };
  }
}
