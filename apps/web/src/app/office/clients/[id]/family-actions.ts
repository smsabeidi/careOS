"use server";

/**
 * The one action behind the client chart's family-update card (ST-241, Front Door W7).
 *
 * Order matters here more than anything else in the file, and it is not negotiable:
 *
 *   flag  →  role  →  client under RLS  →  CONSENT  →  facts  →  model  →  ai_proposal
 *
 * Consent is checked BEFORE the period's notes are assembled and before the capability is
 * called, because a family with no consent on file must not have their relative's visit
 * notes gathered into a prompt at all — refusing after drafting would be a leak with an
 * apology attached. The pre-check is deterministic SQL (invariant 13); the model never
 * sees the question.
 *
 * Nothing here publishes. The action's only write is an inert `ai_proposal` row: 0057
 * registers `family.weekly_draft` as T2 with `requires_human`, and `trg_proposal_human_disposer`
 * enforces in the database that a human disposes it. The approval — in the approver's own
 * session, in apps/web/src/app/inbox/execute.ts — is what inserts the `family_update` row,
 * and that insert is when 0012's share audit fires. A draft is never family-readable.
 *
 * A Server Action is a public endpoint, so every guard the page applied is applied again
 * here: the page's checks do not travel with the POST.
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { featureEnabled } from "@/lib/flags";
import {
  CAPABILITY_FAMILY_WEEKLY,
  FAMILY_DRAFT_KIND,
  FAMILY_DRAFT_SUBJECT,
  FAMILY_WEEKLY_FLAG,
  NO_CONSENT_REFUSAL,
  checkFamilyUpdateConsent,
  collectFamilyFacts,
  draftFamilyUpdate,
  familyUpdateWindow,
  periodLabel,
} from "@/lib/ai/family-update";

/** Who may ask for a draft. RLS is the perimeter; this is the honest, earlier refusal. */
const DRAFT_ROLES = ["owner", "admin", "coordinator", "rn"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FamilyDraftActionResult =
  | { ok: true; message: string; note: string | null }
  | { ok: false; error: string; kind: "consent" | "refused" };

export async function requestFamilyUpdateDraft(
  clientId: string
): Promise<FamilyDraftActionResult> {
  if (!UUID.test(clientId ?? "")) {
    return { ok: false, kind: "refused", error: "That request was not understood. Reload the page and try again." };
  }

  const profile = await getProfile();
  if (!profile) {
    return { ok: false, kind: "refused", error: "Your session has ended. Sign in again to continue." };
  }
  if (!profile.roles.some((r) => DRAFT_ROLES.includes(r))) {
    return {
      ok: false,
      kind: "refused",
      error: "Drafting family updates is available to owners, administrators, coordinators and nurses.",
    };
  }

  // The flag again, server-side. Postgres owns the answer, and a POST that arrives after
  // the flag was switched off must be refused, not honoured because a page was already open.
  if (!(await featureEnabled(FAMILY_WEEKLY_FLAG, false))) {
    return {
      ok: false,
      kind: "refused",
      error: "Family update drafts aren't switched on for this agency. Nothing was drafted.",
    };
  }

  const supabase = await supabaseServer();

  const { data: clientRow } = await supabase
    .from("client")
    .select("id, first_name, tenant_id")
    .eq("id", clientId)
    .maybeSingle();
  const client = clientRow as { id: string; first_name: string; tenant_id: string } | null;
  if (!client) {
    return {
      ok: false,
      kind: "refused",
      error:
        "That client isn't available on this session. It may need a verified (MFA) session, or it may not be yours to see. Nothing was drafted.",
    };
  }

  /* ── The deterministic consent gate (invariant 13). Nothing is read from the chart
     until this passes. ──────────────────────────────────────────────────────────── */
  const consent = await checkFamilyUpdateConsent(supabase, clientId);
  if (consent.error) {
    return {
      ok: false,
      kind: "refused",
      error:
        "The consent record couldn't be read, so nothing was drafted. Nothing was changed — try again in a moment.",
    };
  }
  if (!consent.granted) {
    return { ok: false, kind: "consent", error: `${NO_CONSENT_REFUSAL}.` };
  }

  const window = familyUpdateWindow();
  const facts = await collectFamilyFacts(supabase, clientId, window);
  if (facts.error) {
    return {
      ok: false,
      kind: "refused",
      error: "This week's visits couldn't be read, so nothing was drafted. Nothing was changed.",
    };
  }
  if (facts.visits.length === 0) {
    return {
      ok: false,
      kind: "refused",
      error:
        "There are no completed visits in the last seven days, so there is nothing to write about yet. Nothing was drafted.",
    };
  }

  const drafted = await draftFamilyUpdate(supabase, {
    clientFirstName: client.first_name,
    window,
    visits: facts.visits,
    promptScope: consent.promptScope,
  });
  if (!drafted.draft) {
    return { ok: false, kind: "refused", error: drafted.note ?? "Nothing was drafted." };
  }

  const label = periodLabel(window);
  const { error: insertError } = await supabase.from("ai_proposal").insert({
    tenant_id: client.tenant_id,
    capability_key: CAPABILITY_FAMILY_WEEKLY,
    kind: FAMILY_DRAFT_KIND,
    subject_type: FAMILY_DRAFT_SUBJECT,
    subject_id: clientId,
    title: `Family update — ${client.first_name}, ${label}`,
    body: drafted.draft,
    payload: {
      // IDs and labels only. The draft body is the content; the payload carries what the
      // approval path needs to publish it and nothing a log would regret (invariant 5).
      client_id: clientId,
      period_from: window.from,
      period_to: window.to,
      period_label: label,
      /** The title the FAMILY sees when this is published. Never the staff-side title. */
      family_title: `Update from the care team — ${label}`,
      consent_scope: consent.scope,
      visit_count: facts.visitCount,
      linked_family: consent.linkedFamily,
      /** Where the inbox row deep-links back to: the chart this draft came from. */
      href: `/office/clients/${clientId}`,
    },
    rationale:
      `Consent for family updates is on file for this client (${consent.scope.join(", ")}), and ` +
      `${facts.visitCount} completed ${facts.visitCount === 1 ? "visit" : "visits"} were recorded between ` +
      `${window.from} and ${window.to}. The draft was written from those visits only; approving it is what shares it.`,
    ai_interaction_id: drafted.interactionId,
    created_by: profile.userId,
  });

  if (insertError) {
    return {
      ok: false,
      kind: "refused",
      error:
        "The draft couldn't be saved for approval, so nothing was sent. Drafts need a verified (MFA) session — verify and try again.",
    };
  }

  revalidatePath(`/office/clients/${clientId}`);
  revalidatePath("/inbox");

  return {
    ok: true,
    message: "Draft sent for approval — Approvals inbox",
    note:
      consent.linkedFamily === 0
        ? "No family member is linked to this client yet, so nobody can open it until someone is. The draft is safe in the approvals inbox either way."
        : null,
  };
}
