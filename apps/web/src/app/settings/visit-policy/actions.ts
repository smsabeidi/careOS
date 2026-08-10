"use server";

/**
 * Visit-policy write path — one thin wrapper over `app.upsert_visit_policy` (0044, §6.2).
 *
 * Three rules hold here, and none of them are enforced by this file:
 *  1. **The database is the authority.** AAL2, `policy.manage`, scope shape, the settings
 *     allowlist, the bounds and the version number all live in the RPC. This action only
 *     shapes a form into `p_settings` and turns CAREOS_* refusals into plain language.
 *  2. **Saving APPENDS.** `visit_policy` is append-only: the RPC merges the delta over the
 *     current version of the scope and inserts the next one with `supersedes_id` set. The
 *     version being replaced is kept exactly as it was authored (invariant 1) — which is
 *     why nothing in this file, and nothing in the copy it returns, says "edit" or
 *     "update".
 *  3. **The caller's own client.** RLS and the EXECUTE grant decide; no service_role ever
 *     touches a request path (invariant 6).
 *
 * The whole settings set is sent every time rather than a computed delta. The RPC merges
 * it over the base and compares the result field by field, so an unchanged save returns
 * `unchanged: true` and writes no version — the idempotence lives in one place instead of
 * being re-derived (and mis-derived) here.
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { POLICY_FIELDS, type PolicySettingKey } from "./policy-fields";

export type ActionResult = { ok: boolean; error?: string; message?: string };

/** CAREOS_* refusals → plain language. Everything else stays generic (no PHI in errors). */
function friendly(raw: string | undefined): string {
  const code = raw?.match(/CAREOS_[A-Z_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs a fresh verification — unlock with your authenticator and try again. Nothing was saved.";
    case "CAREOS_FORBIDDEN":
      return "Your role does not include authoring visit policy. Nothing was saved.";
    case "CAREOS_BAD_SCOPE":
      return "That combination of scope and target is not one CareOS can store. Nothing was saved.";
    case "CAREOS_REASON_REQUIRED":
      return "A reason is required — it is kept on the new version so anyone reading the history knows why it changed.";
    case "CAREOS_BAD_SETTING":
      return "One of the settings was not recognised, so nothing was saved. Reload the page and try again.";
    case "CAREOS_BAD_WINDOW":
      return "A policy has to end after it starts. Nothing was saved.";
    case "CAREOS_NOT_FOUND":
      return "That client or service type is not available on your account. Nothing was saved.";
    case "CAREOS_POLICY_MISSING":
      return "This agency has no baseline policy yet. Save the agency default first — everything else builds on it.";
    case "CAREOS_NO_TENANT_CONTEXT":
      return "Your workspace could not be resolved on this session. Nothing was saved.";
    default:
      return "The policy could not be saved. Nothing was changed — the version in force is still the one you were looking at.";
  }
}

/** Re-guard in the action itself: a Server Action is a public endpoint, not a page child. */
async function assertPolicyManager(
  supabase: Awaited<ReturnType<typeof supabaseServer>>
): Promise<string | null> {
  const { data, error } = await supabase.schema("app").rpc("has_perm", { p: "policy.manage" });
  if (error) return "Your permissions could not be checked on this session. Nothing was saved.";
  if (data !== true) return "Your role does not include authoring visit policy. Nothing was saved.";
  return null;
}

const SCOPE_KINDS = new Set(["tenant", "payer_kind", "service_type", "client"]);
const PAYER_KINDS = new Set(["medicaid", "medicare", "private", "waiver", "other"]);

/** The scope words a coordinator reads, so success copy names what actually moved. */
const SCOPE_LABEL: Record<string, string> = {
  tenant: "the agency default",
  payer_kind: "this payer kind",
  service_type: "this service type",
  client: "this client",
};

/**
 * Append the next version of one policy scope.
 *
 * Never throws. A failure here must leave the author looking at the page they were on,
 * with the version in force untouched and a sentence saying so.
 */
export async function saveVisitPolicy(formData: FormData): Promise<ActionResult> {
  const scopeKind = String(formData.get("scope_kind") ?? "").trim();
  const scopeIdRaw = String(formData.get("scope_id") ?? "").trim();
  const scopeValueRaw = String(formData.get("scope_value") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!SCOPE_KINDS.has(scopeKind)) {
    return { ok: false, error: "That policy scope is not one CareOS can store. Nothing was saved." };
  }
  const needsId = scopeKind === "service_type" || scopeKind === "client";
  if (needsId && !scopeIdRaw) {
    return { ok: false, error: "Choose which record this policy applies to first. Nothing was saved." };
  }
  if (scopeKind === "payer_kind" && !PAYER_KINDS.has(scopeValueRaw)) {
    return { ok: false, error: "Choose a payer kind first. Nothing was saved." };
  }
  if (!reason) {
    return {
      ok: false,
      error:
        "Add a reason before saving — it is kept on the new version so anyone reading the history knows why it changed.",
    };
  }

  // Build p_settings from the eighteen known keys only. Anything else on the form is
  // ignored here and would be refused by the RPC's allowlist anyway.
  const settings: Record<string, string | number | boolean> = {};
  for (const field of POLICY_FIELDS) {
    const key: PolicySettingKey = field.key;
    if (field.kind === "bool") {
      // Rendered as an explicit two-option select rather than a checkbox: a checkbox that
      // sends nothing when cleared is indistinguishable from a field that never rendered,
      // and "the setting silently kept its old value" is not an outcome anyone should have
      // to guess at on a policy screen.
      settings[key] = String(formData.get(key) ?? "") === "true";
      continue;
    }
    const raw = String(formData.get(key) ?? "").trim();
    if (raw === "") {
      return {
        ok: false,
        error: `“${field.label}” was left blank. Every setting needs a value — nothing was saved.`,
      };
    }
    if (field.kind === "int") {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: `“${field.label}” has to be a whole number. Nothing was saved.` };
      }
      if (n < field.min || n > field.max) {
        return {
          ok: false,
          error: `“${field.label}” has to be between ${field.min} and ${field.max} ${field.unit}. Nothing was saved.`,
        };
      }
      settings[key] = n;
      continue;
    }
    if (!field.options.some((o) => o.value === raw)) {
      return { ok: false, error: `“${field.label}” is not one of the available choices. Nothing was saved.` };
    }
    settings[key] = raw;
  }

  // Optional scheduling. Only sent when the author actually asked for it: the RPC treats
  // the presence of effective_from as "this is a scheduled change", which deliberately
  // defeats the unchanged-save shortcut.
  const startsRaw = String(formData.get("effective_from") ?? "").trim();
  const endsRaw = String(formData.get("effective_until") ?? "").trim();
  const toIso = (v: string): string | null => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  if (startsRaw) {
    const iso = toIso(startsRaw);
    if (!iso) return { ok: false, error: "That start date could not be read. Nothing was saved." };
    settings.effective_from = iso;
  }
  if (endsRaw) {
    const iso = toIso(endsRaw);
    if (!iso) return { ok: false, error: "That end date could not be read. Nothing was saved." };
    settings.effective_until = iso;
  }

  const supabase = await supabaseServer();
  const denied = await assertPolicyManager(supabase);
  if (denied) return { ok: false, error: denied };

  const { data, error } = await supabase.schema("app").rpc("upsert_visit_policy", {
    p_scope_kind: scopeKind,
    p_scope_id: needsId ? scopeIdRaw : null,
    p_scope_value: scopeKind === "payer_kind" ? scopeValueRaw : null,
    p_settings: settings,
    p_reason: reason,
  });
  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { unchanged?: boolean; version_no?: number };
  revalidatePath("/settings/visit-policy");

  if (result.unchanged) {
    return {
      ok: true,
      message:
        "Nothing had changed, so no new version was created. Version " +
        `${result.version_no ?? "in force"} for ${SCOPE_LABEL[scopeKind]} still stands, exactly as it was authored.`,
    };
  }
  return {
    ok: true,
    message:
      `Saved as version ${result.version_no ?? "the next version"} of ${SCOPE_LABEL[scopeKind]}. ` +
      "The version it replaces is kept with its own reason and author — visits already measured against it are unaffected.",
  };
}
