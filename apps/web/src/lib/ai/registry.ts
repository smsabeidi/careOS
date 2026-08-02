/**
 * AI capability registry (Wave 0 governance floor — docs/16 §4).
 *
 * Resolves, per capability key: model, kill switch, autonomy tier, human-disposer
 * requirement, monthly budget, and the ACTIVE registry-versioned system prompt.
 * Reads run under the CALLER's Supabase client (RLS-scoped, invariant 9) — there is
 * no privileged registry identity.
 *
 * Resilience contract: registry rows, the `ai_prompt_template` table, and the budget
 * columns may not exist yet in a given environment (they land with migration 0015).
 * Every lookup degrades to built-in defaults — the app never breaks because governance
 * metadata is missing. The one case that DISABLES a capability is an existing row that
 * says so: `enabled = false` (the 0015 kill switch) or `active = false` (the 0014
 * lifecycle flag). Either one off means off.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type CapabilityTier = "T0" | "T1" | "T2" | "T3";

export type CapabilityEntry = {
  key: string;
  /** Model ID the capability is pinned to (registry row → OPENAI_MODEL env → default). */
  model: string;
  /** false only when a registry row exists and is switched off (`enabled`/`active`). */
  enabled: boolean;
  tier: CapabilityTier;
  requires_human: boolean;
  /** Soft monthly cap in USD; null = no cap configured. */
  monthly_budget_usd: number | null;
  /** Active registry prompt; null = caller uses its built-in system prompt. */
  system_prompt: string | null;
  /** Version label recorded in ai_interaction.prompt_version. */
  prompt_version: string;
};

export type BudgetCheck = {
  allowed: boolean;
  /** This calendar month's ai_interaction.cost_usd sum visible to the caller. */
  spent: number;
  cap: number | null;
};

/** Ratified default workhorse (docs/16 §3.1). Synthesis capabilities pin terra in the registry. */
export const DEFAULT_MODEL = "gpt-5.6-luna";
export const SYNTHESIS_MODEL = "gpt-5.6-terra";
export const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Built-in fallbacks so a missing registry row can never take a surface down.
 * Tier + requires_human mirror the seeded registry (supabase/seeds/zz_ai.sql,
 * zz_ai_governance.sql) so a capability degrades to its RATIFIED posture, not to a
 * guess. A key absent here falls to SAFE_DEFAULT (T2 + human required).
 */
const BUILT_IN: Record<
  string,
  { tier: CapabilityTier; requires_human: boolean; model?: string; prompt_version: string }
> = {
  "brain.answer": { tier: "T1", requires_human: false, prompt_version: "brain.builtin" },
  "huddle.brief": {
    tier: "T1",
    requires_human: false,
    model: SYNTHESIS_MODEL,
    prompt_version: "huddle.builtin",
  },
  "note.voice_draft": { tier: "T2", requires_human: true, prompt_version: "voice.builtin" },
  "intake.extract": {
    tier: "T1",
    requires_human: true,
    model: SYNTHESIS_MODEL,
    prompt_version: "intake.builtin",
  },
  "credential.flag": { tier: "T1", requires_human: true, prompt_version: "credential.builtin" },
  "coordination.suggest": {
    tier: "T2",
    requires_human: true,
    prompt_version: "coordination.builtin",
  },
};

/** Unknown keys get the safest posture: T2, human required (invariant 8). */
const SAFE_DEFAULT = { tier: "T2" as CapabilityTier, requires_human: true };

function asNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function isTier(v: unknown): v is CapabilityTier {
  return v === "T0" || v === "T1" || v === "T2" || v === "T3";
}

/**
 * Load the registry entry for a capability under the caller's RLS.
 * Never throws; on any failure it returns built-in defaults (enabled=true).
 */
export async function getCapability(
  supabase: SupabaseClient,
  key: string
): Promise<CapabilityEntry> {
  const builtIn = BUILT_IN[key];
  const entry: CapabilityEntry = {
    key,
    model: builtIn?.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    enabled: true,
    tier: builtIn?.tier ?? SAFE_DEFAULT.tier,
    requires_human: builtIn?.requires_human ?? SAFE_DEFAULT.requires_human,
    monthly_budget_usd: null,
    system_prompt: null,
    prompt_version: builtIn?.prompt_version ?? `${key}.builtin`,
  };

  // Capability row (CFG table, no PHI). Explicit columns, never select(*). The 0015
  // columns (enabled, model, monthly_budget_usd) are requested first; a pre-0015
  // environment errors on those names, so we retry with the 0014 column set rather
  // than losing the ratified tier/requires_human posture entirely.
  const applyCapabilityRow = (row: Record<string, unknown>) => {
    // Either flag off means off: `enabled` is the 0015 kill switch, `active` the 0014
    // lifecycle flag. A column absent from the row is undefined and changes nothing.
    if (row.enabled === false || row.active === false) entry.enabled = false;
    if (isTier(row.tier)) entry.tier = row.tier;
    if (typeof row.requires_human === "boolean") entry.requires_human = row.requires_human;
    if (typeof row.model === "string" && row.model) entry.model = row.model;
    const budget = asNumber(row.monthly_budget_usd);
    if (budget !== null && budget > 0) entry.monthly_budget_usd = budget;
  };

  try {
    const { data, error } = await supabase
      .from("ai_capability")
      .select("tier, requires_human, active, enabled, model, monthly_budget_usd")
      .eq("key", key)
      .maybeSingle();
    if (data) {
      applyCapabilityRow(data as Record<string, unknown>);
    } else if (error) {
      const { data: legacy } = await supabase
        .from("ai_capability")
        .select("tier, requires_human, active")
        .eq("key", key)
        .maybeSingle();
      if (legacy) applyCapabilityRow(legacy as Record<string, unknown>);
    }
  } catch {
    // Table absent / transient failure → built-in defaults.
  }

  // Active registry prompt (immutable versions; the active pointer wins — docs/11).
  // Highest active version wins if more than one is ever left active.
  try {
    const { data, error } = await supabase
      .from("ai_prompt_template")
      .select("version, system_prompt")
      .eq("capability_key", key)
      .eq("active", true)
      .order("version", { ascending: false })
      .limit(1);
    const tpl = !error && data && data.length > 0 ? (data[0] as Record<string, unknown>) : null;
    if (tpl && typeof tpl.system_prompt === "string" && tpl.system_prompt.trim()) {
      entry.system_prompt = tpl.system_prompt;
      entry.prompt_version = `${key}.v${String(tpl.version ?? 1)}`;
    }
  } catch {
    // Template table absent → built-in prompt.
  }

  return entry;
}

/**
 * Soft budget gate: sum this calendar month's ai_interaction.cost_usd for the
 * capability and compare against the cap. Over cap → allowed=false (the caller
 * logs a 'blocked' ledger row and renders the deterministic fallback).
 *
 * Scope note: the sum runs under the caller's RLS — a user without `ai.read` sees
 * only their own rows, so this is a per-viewer floor on tenant spend. The nightly
 * X7 rollup is the authoritative tenant-wide number; this gate is the cheap
 * in-request guardrail, intentionally soft (docs/16 §6 blast-radius controls).
 */
export async function checkBudget(
  supabase: SupabaseClient,
  tenantId: string,
  key: string,
  capBudgetUsd: number | null
): Promise<BudgetCheck> {
  if (capBudgetUsd === null || capBudgetUsd <= 0) return { allowed: true, spent: 0, cap: null };

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  try {
    const { data, error } = await supabase
      .from("ai_interaction")
      .select("cost_usd")
      .eq("tenant_id", tenantId)
      .eq("capability_key", key)
      .gte("created_at", monthStart)
      .limit(5000);
    if (error) return { allowed: true, spent: 0, cap: capBudgetUsd }; // fail open: never take the surface down on a read error
    const spent = (data ?? []).reduce((s, r) => s + (asNumber((r as { cost_usd: unknown }).cost_usd) ?? 0), 0);
    return { allowed: spent < capBudgetUsd, spent: Number(spent.toFixed(4)), cap: capBudgetUsd };
  } catch {
    return { allowed: true, spent: 0, cap: capBudgetUsd };
  }
}
