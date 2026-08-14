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
  /**
   * Kind-specific capability contract (migration 0055). For an action-drafting
   * capability this carries the ACTION ALLOWLIST — `{"actions": {"<rpc>": {...}}}` — and
   * it lives in the database on purpose: the allowlist must be governed in the same row
   * as the tier, kill switch and budget, or the registry stops being the single unit of
   * governance. null when the column is absent (pre-0055) or the row sets none.
   */
  config: Record<string, unknown> | null;
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
  // ── Verified Visit & Workforce Intelligence (docs/17 §11, migration 0052) ──
  // Tier, human-disposer and model pin mirror app.seed_visit_ai_capabilities exactly, so
  // a tenant whose registry rows have not been provisioned degrades to the RATIFIED
  // posture rather than to a guess. Models are stated rather than inherited from
  // OPENAI_MODEL for the same reason: 0052 pins luna for per-item narration and terra for
  // synthesis, and an env var is not a decision log.
  "visit.exception_triage": {
    tier: "T1",
    requires_human: false,
    model: DEFAULT_MODEL,
    prompt_version: "visit.triage.builtin",
  },
  "workforce.weekly_report": {
    tier: "T1",
    requires_human: false,
    model: SYNTHESIS_MODEL,
    prompt_version: "workforce.weekly.builtin",
  },
  "payroll.readiness_brief": {
    tier: "T1",
    requires_human: false,
    model: SYNTHESIS_MODEL,
    prompt_version: "payroll.readiness.builtin",
  },
  // T2 + human disposer required (D-028, D-021): it characterises one employee. 0052 also
  // ships its kill switch OFF, and lib/ai/visit-intelligence.ts refuses to call it unless
  // an enabled registry row actually exists — for this one capability, absent means off.
  "visit.operational_profile": {
    tier: "T2",
    requires_human: true,
    model: SYNTHESIS_MODEL,
    prompt_version: "visit.profile.builtin",
  },
  // ── Intelligent Front Door (docs/designs/intelligent-front-door.md, migration 0057) ──
  // Same rule as 0052: tier, human-disposer and model pin mirror
  // app.seed_front_door_capabilities exactly, so an unprovisioned tenant degrades to the
  // RATIFIED posture rather than to a guess. Note what a built-in CANNOT carry: the
  // action allowlist. `config` is read from the row or it is absent, and an absent
  // allowlist means nothing is draftable (see actionAllowlist below) — a capability may
  // never acquire the right to act by falling back to code.
  "note.quality_coach": {
    tier: "T1",
    requires_human: false,
    model: DEFAULT_MODEL,
    prompt_version: "note.coach.builtin",
  },
  "command.schedule_draft": {
    tier: "T2",
    requires_human: true,
    model: DEFAULT_MODEL,
    prompt_version: "command.schedule.builtin",
  },
  "schedule.preflight": {
    tier: "T1",
    requires_human: false,
    model: DEFAULT_MODEL,
    prompt_version: "schedule.preflight.builtin",
  },
  "form.import_pdf": {
    tier: "T2",
    requires_human: true,
    model: SYNTHESIS_MODEL,
    prompt_version: "form.import.builtin",
  },
  "family.weekly_draft": {
    tier: "T2",
    requires_human: true,
    model: SYNTHESIS_MODEL,
    prompt_version: "family.weekly.builtin",
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

/** A plain JSON object, or null. Arrays and scalars are not a capability contract. */
function asConfigObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The RPCs an action-drafting capability is allowed to draft, read from its registry row
 * (migration 0055 `ai_capability.config`). This is the shape validation 0055's header
 * defers to the loader: `{"actions": {"<rpc key>": {...}}}`.
 *
 * Fail-closed by construction. A missing column, a missing row, a null config, a config
 * with no `actions` object, or an `actions` object with no keys all return an EMPTY list,
 * and an empty allowlist means nothing may be drafted. There is deliberately no built-in
 * fallback: an allowlist that application code could supply would be an allowlist the
 * database does not govern, which is the tier-laundering failure this column exists to
 * prevent. The model never widens it either — it only ever names an action, and the
 * caller checks that name against this list.
 */
export function actionAllowlist(entry: CapabilityEntry): string[] {
  const actions = asConfigObject(entry.config?.actions);
  return actions ? Object.keys(actions) : [];
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
    config: null,
  };

  // Capability row (CFG table, no PHI). Explicit columns, never select(*). Column sets
  // are tried newest-first and each rung is a whole migration's worth of columns: 0055
  // added `config`, 0015 added enabled/model/monthly_budget_usd, 0014 is the floor. An
  // environment that has not run one of them errors on the unknown NAME, so a narrower
  // retry keeps the ratified tier/requires_human posture instead of losing it entirely.
  const applyCapabilityRow = (row: Record<string, unknown>) => {
    // Either flag off means off: `enabled` is the 0015 kill switch, `active` the 0014
    // lifecycle flag. A column absent from the row is undefined and changes nothing.
    if (row.enabled === false || row.active === false) entry.enabled = false;
    if (isTier(row.tier)) entry.tier = row.tier;
    if (typeof row.requires_human === "boolean") entry.requires_human = row.requires_human;
    if (typeof row.model === "string" && row.model) entry.model = row.model;
    const budget = asNumber(row.monthly_budget_usd);
    if (budget !== null && budget > 0) entry.monthly_budget_usd = budget;
    if ("config" in row) entry.config = asConfigObject(row.config);
  };

  const COLUMN_SETS = [
    "tier, requires_human, active, enabled, model, monthly_budget_usd, config",
    "tier, requires_human, active, enabled, model, monthly_budget_usd",
    "tier, requires_human, active",
  ];

  try {
    for (const columns of COLUMN_SETS) {
      const { data, error } = await supabase
        .from("ai_capability")
        .select(columns)
        .eq("key", key)
        .maybeSingle();
      if (data) {
        // Through `unknown`: the column list is a variable, so PostgREST's generated
        // types cannot narrow the row shape and infer a parse-error placeholder instead.
        applyCapabilityRow(data as unknown as Record<string, unknown>);
        break;
      }
      // No row and no error means the capability is simply not registered for this
      // tenant — retrying with fewer columns would ask the same question again.
      if (!error) break;
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
