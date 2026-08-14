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
import { CAPABILITY_FAMILY_WEEKLY, checkFamilyUpdateConsent } from "@/lib/ai/family-update";

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
 * Publish an approved family update draft (ST-241, Front Door W7 — capability
 * `family.weekly_draft`).
 *
 * THIS INSERT IS THE PUBLICATION ACT. The draft written by the capability is an inert
 * `ai_proposal` row that no family can read; the row below is the first thing a family
 * member can open, it is written under the APPROVER's own session, and `author_id` is
 * their user id — so the record says who published, not who drafted. Migration 0012's
 * `trg_family_update_audit` fires on this insert, which is when the share is audited:
 * before approval there is nothing to audit because nothing was shared.
 *
 * Consent is re-checked here, not assumed. Rule 1 of this module applies with force: a
 * consent granted when the draft was written may have been revoked before it was approved,
 * and 0012's insert policy on `family_update` checks care-team membership rather than
 * consent, so the database would let this through. The deterministic check is the gate.
 *
 * The family-facing title comes from the payload, never from the proposal's own title: the
 * inbox title names a client and a period for a coordinator's queue, and that is not what
 * a family should see at the top of their update.
 */
async function executeFamilyWeeklyDraft(
  supabase: SupabaseClient,
  proposal: ProposalForExecution,
  approvedBody: string,
  actorId: string
): Promise<ExecutionOutcome> {
  const payload = payloadObject(proposal.payload);
  const clientId =
    proposal.subject_type === "client" && proposal.subject_id
      ? proposal.subject_id
      : (payload.client_id as string | undefined) ?? null;

  if (!clientId) {
    return {
      executed: false,
      message:
        "Approved and recorded. It was not published because this draft is not linked to a client.",
      revalidate: [],
    };
  }

  const body = approvedBody.trim();
  if (!body) {
    return {
      executed: false,
      message: "Approved and recorded. Nothing was published because the update has no text.",
      revalidate: [],
    };
  }

  const consent = await checkFamilyUpdateConsent(supabase, clientId);
  if (consent.error) {
    return {
      executed: false,
      message:
        "Approved and recorded, but the consent record couldn't be read, so nothing was published. Your decision stands — try publishing again once consent can be confirmed.",
      revalidate: [],
    };
  }
  if (!consent.granted) {
    return {
      executed: false,
      message:
        "Approved and recorded, but nothing was published: there is no active consent on file for family updates for this client. Your decision stands on the record, and the family portal is unchanged.",
      revalidate: [],
    };
  }

  const { error } = await supabase.from("family_update").insert({
    tenant_id: proposal.tenant_id,
    client_id: clientId,
    author_id: actorId,
    title: ((payload.family_title as string | undefined) ?? "Update from the care team").slice(0, 200),
    body,
  });

  if (error) {
    return {
      executed: false,
      message:
        "Approved and recorded, but it was not published to the family portal. Publishing needs a verified (MFA) session and care-team access to this client — nothing was shared.",
      revalidate: [],
    };
  }

  return {
    executed: true,
    message:
      consent.linkedFamily === 0
        ? "Approved and published. It is waiting in the family portal — no family member is linked to this client yet, so nobody can open it until someone is."
        : "Approved and published. The family can see this update in their portal now.",
    revalidate: ["/family", `/office/clients/${clientId}`],
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

  // One atomic Lane-B call (0023): row lock, eligibility re-proof, and the write share
  // a transaction — the guard can no longer be raced between check and assignment.
  const { error } = await supabase.schema("app").rpc("assign_visit", {
    p_visit: visitId,
    p_caregiver: caregiverId,
  });

  if (error) {
    if (error.message.includes("CAREOS_NOT_SCHEDULABLE")) {
      let why = "a required credential is not valid";
      const start = error.message.indexOf("[");
      if (start !== -1) {
        try {
          const blockers = JSON.parse(error.message.slice(start)) as { name?: string; reason?: string }[];
          const first = blockers[0];
          if (first?.name) why = `${first.name} is ${first.reason ?? "not valid"}`;
        } catch {
          // keep the generic phrasing
        }
      }
      return {
        executed: false,
        message: `Approved and recorded, but the assignment was refused: ${why}. The shift is still open.`,
        revalidate: ["/schedule"],
      };
    }
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
    if (proposal.capability_key === CAPABILITY_FAMILY_WEEKLY) {
      return await executeFamilyWeeklyDraft(supabase, proposal, approvedBody, actorId);
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
