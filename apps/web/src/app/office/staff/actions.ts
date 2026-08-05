"use server";

/**
 * Staff lifecycle actions — thin wrappers over the Lane-B identity RPCs (0030–0033).
 *
 * Three rules hold everywhere below:
 *  1. **The database is the authority.** Every guard (permission, transition, last-admin,
 *     human-verifier) lives in the RPC; this file only translates CAREOS_* refusals into
 *     plain language (docs/10 voice: what happened, what to do next).
 *  2. **Writes run under the caller's own client** — RLS and RPC EXECUTE grants decide,
 *     never app code (invariant 6).
 *  3. **The invite token is minted here and never stored** — the RPC receives its sha256;
 *     the raw token exists only in the returned link the office hands to the hire
 *     (email delivery arrives with the Phase-3 actuator; until then the UI says so).
 */

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";

export type ActionResult = {
  ok: boolean;
  message: string;
  /** Present only after a successful invite: the link to hand to the hire. */
  inviteLink?: string;
};

/** CAREOS_* refusals → plain language. Everything else stays generic (no PHI in errors). */
function friendly(raw: string | undefined): string {
  const code = raw?.match(/CAREOS_[A-Z_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs a fresh verification — unlock with your authenticator and try again.";
    case "CAREOS_FORBIDDEN":
      return "Your role does not include this action.";
    case "CAREOS_DUPLICATE":
      return "A pending invitation already exists for that email.";
    case "CAREOS_ALREADY_ENROLLED":
      return "That email already belongs to an active account.";
    case "CAREOS_BAD_EMAIL":
      return "That does not look like a work email.";
    case "CAREOS_NOT_FOUND":
      return "That record is not available to you.";
    case "CAREOS_REASON_REQUIRED":
      return "A reason is required — it goes on the record.";
    case "CAREOS_SELF_TARGET":
      return "You cannot take this action on your own account.";
    case "CAREOS_LAST_ADMIN":
      return "This would leave the agency with nobody who can manage access. Grant another administrator first.";
    case "CAREOS_INVALID_TRANSITION":
      return "That change is not allowed from the record's current state.";
    case "CAREOS_STALE":
      return "The record changed while you were editing. Reload and try again.";
    case "CAREOS_USE_SEPARATION":
      return "Separation runs through the separation flow, not an edit.";
    case "CAREOS_HUMAN_REQUIRED":
      return "Only a person can verify this item.";
    case "CAREOS_EXPIRED":
      return "That invitation has expired — send a new one.";
    default:
      return "Something went wrong. Nothing was saved.";
  }
}

async function siteOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

export async function inviteStaff(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "").trim();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const roleId = String(formData.get("role_id") ?? "");
  const roleTitle = String(formData.get("role_title") ?? "");
  if (!email || !fullName || !roleId || !roleTitle) {
    return { ok: false, message: "Name, email, role and title are all needed." };
  }

  // The raw token lives only in the link; the database keeps its hash (0030).
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256")
    .update(Buffer.from(rawToken, "hex"))
    .digest("hex");

  const supabase = await supabaseServer();
  const { error } = await supabase.schema("app").rpc("invite_staff", {
    p_email: email,
    p_full_name: fullName,
    p_role_id: roleId,
    p_role_title: roleTitle,
    p_token_hash_hex: tokenHash,
  });
  if (error) return { ok: false, message: friendly(error.message) };

  revalidatePath("/office/staff");
  return {
    ok: true,
    message:
      `Invitation recorded for ${fullName}. Hand them the link below — ` +
      "CareOS does not send email yet, so it travels by you.",
    inviteLink: `${await siteOrigin()}/accept?token=${rawToken}`,
  };
}

export async function revokeInvitation(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const { error } = await supabase.schema("app").rpc("revoke_invitation", {
    p_invitation: String(formData.get("invitation_id") ?? ""),
  });
  if (error) return { ok: false, message: friendly(error.message) };
  revalidatePath("/office/staff");
  return { ok: true, message: "Invitation revoked." };
}

export async function suspendUser(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const userId = String(formData.get("user_id") ?? "");
  const { error } = await supabase.schema("app").rpc("suspend_user", {
    p_user: userId,
    p_reason: String(formData.get("reason") ?? ""),
  });
  if (error) return { ok: false, message: friendly(error.message) };
  revalidatePath(`/office/staff/${userId}`);
  revalidatePath("/office/staff");
  return { ok: true, message: "Access suspended. Every session went dark at that moment." };
}

export async function reinstateUser(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const userId = String(formData.get("user_id") ?? "");
  const { error } = await supabase.schema("app").rpc("reinstate_user", { p_user: userId });
  if (error) return { ok: false, message: friendly(error.message) };
  revalidatePath(`/office/staff/${userId}`);
  revalidatePath("/office/staff");
  return { ok: true, message: "Access reinstated." };
}

export async function separateUser(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const userId = String(formData.get("user_id") ?? "");
  const { data, error } = await supabase.schema("app").rpc("separate_user", {
    p_user: userId,
    p_reason: String(formData.get("reason") ?? ""),
  });
  if (error) return { ok: false, message: friendly(error.message) };
  const d = (data ?? {}) as { assignments_ended?: number; visits_vacated?: number };
  revalidatePath(`/office/staff/${userId}`);
  revalidatePath("/office/staff");
  return {
    ok: true,
    message:
      `Separated. Access closed immediately; ${d.assignments_ended ?? 0} assignment(s) ended; ` +
      `${d.visits_vacated ?? 0} future visit(s) returned to the open board. ` +
      "Work the revocation checklist below — the 15-minute clock is running.",
  };
}

export async function completeRevocationStep(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const userId = String(formData.get("user_id") ?? "");
  const { error } = await supabase.schema("app").rpc("complete_revocation_step", {
    p_user: userId,
    p_step: String(formData.get("step") ?? ""),
    p_note: String(formData.get("note") ?? "") || null,
  });
  if (error) return { ok: false, message: friendly(error.message) };
  revalidatePath(`/office/staff/${userId}`);
  return { ok: true, message: "Step recorded." };
}

export async function completeOnboardingItem(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const employeeId = String(formData.get("employee_id") ?? "");
  const { error } = await supabase.schema("app").rpc("complete_onboarding_item", {
    p_employee: employeeId,
    p_checklist_key: String(formData.get("checklist_key") ?? ""),
  });
  if (error) return { ok: false, message: friendly(error.message) };
  revalidatePath(`/office/staff/${employeeId}`);
  revalidatePath("/office/staff/onboarding");
  return { ok: true, message: "Verified — it carries your name on the file." };
}

export async function waiveOnboardingItem(formData: FormData): Promise<ActionResult> {
  const supabase = await supabaseServer();
  const employeeId = String(formData.get("employee_id") ?? "");
  const { error } = await supabase.schema("app").rpc("waive_onboarding_item", {
    p_employee: employeeId,
    p_checklist_key: String(formData.get("checklist_key") ?? ""),
    p_reason: String(formData.get("reason") ?? ""),
  });
  if (error) return { ok: false, message: friendly(error.message) };
  revalidatePath(`/office/staff/${employeeId}`);
  revalidatePath("/office/staff/onboarding");
  return { ok: true, message: "Waived, with the reason on the record." };
}
