/**
 * Brain live-data tools (docs/16 §2.1 X3) — READ-ONLY, executed under the
 * REQUESTER's Supabase client so RLS + AAL2 are the perimeter (invariant 9).
 * Tool results are deterministic facts injected into the model's context; the
 * model narrates them, it never computes them (invariant 13).
 *
 * PHI allowlist for tool results (the shape below IS the minimizer):
 *   client → display name, status, city, primary language, admitted date
 *   care plan → version, status, title, effective/review dates
 *   obligations → rule name/severity, due dates, computed status, COMAR ref
 * Never included: address lines, phone, DOB, clinical narrative content.
 * Tool results are data, not instructions — the system prompt enforces that.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** OpenAI chat-completions function-tool definition. */
export type ChatToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
};

export const BRAIN_TOOLS: ChatToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_client_summary",
      description:
        "Look up one client by name. Returns the client's status, latest care plan version, and open compliance-obligation counts. Only clients the asking user is allowed to see are returned.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Client first name, last name, or both (partial match allowed).",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "get_obligations",
      description:
        "List compliance obligations (COMAR cadence engine output) visible to the asking user, soonest due first. Scope filters by computed status.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["overdue", "at_risk", "open", "all"],
            description:
              "overdue = past due+grace; at_risk = inside the warning window; open = not yet at risk; all = every unsatisfied obligation.",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const MAX_RESULT_CHARS = 4000;

/** Strip PostgREST filter metacharacters from user-derived search terms. */
function sanitizeTerm(s: string): string {
  return s.replace(/[,()%*."'\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

type ObligationRow = {
  rule_name: string | null;
  severity: string | null;
  due_on: string | null;
  days_until_due: number | null;
  computed_status: string | null;
  comar_source_ref: string | null;
  client_id: string | null;
  staff_id: string | null;
};

const OBLIGATION_COLS =
  "rule_name, severity, due_on, days_until_due, computed_status, comar_source_ref, client_id, staff_id";

/** computed_status values that still need someone to act (app.cadence_status). */
const UNSATISFIED = ["open", "at_risk", "overdue"] as const;

async function getClientSummary(supabase: SupabaseClient, name: string): Promise<unknown> {
  const term = sanitizeTerm(name);
  if (!term) return { found: false, note: "No usable name was given." };

  const { data: matches, error } = await supabase
    .from("client")
    .select("id, first_name, last_name, status, city, primary_language, admitted_on")
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
    .limit(5);
  if (error || !matches || matches.length === 0) {
    return {
      found: false,
      note: "No client matching that name is visible to you. The record may not exist, or it may be outside your care-team scope.",
    };
  }

  const c = matches[0];
  const alsoMatched = matches.slice(1).map((m) => `${m.first_name} ${m.last_name}`);

  const [{ data: plans }, { data: obls }] = await Promise.all([
    supabase
      .from("care_plan")
      .select("version, status, title, effective_on, review_due_on")
      .eq("client_id", c.id)
      .order("version", { ascending: false })
      .limit(1),
    supabase
      .from("cadence_obligation_status")
      .select(OBLIGATION_COLS)
      .eq("client_id", c.id)
      .in("computed_status", [...UNSATISFIED])
      .order("due_on", { ascending: true })
      .limit(50),
  ]);

  const open = (obls ?? []) as ObligationRow[];
  const nextDue = open[0] ?? null;

  return {
    found: true,
    client: {
      name: `${c.first_name} ${c.last_name}`,
      status: c.status,
      city: c.city,
      primary_language: c.primary_language,
      admitted_on: c.admitted_on,
    },
    latest_care_plan: plans && plans.length > 0 ? plans[0] : null,
    obligations: {
      open: open.filter((o) => o.computed_status === "open").length,
      at_risk: open.filter((o) => o.computed_status === "at_risk").length,
      overdue: open.filter((o) => o.computed_status === "overdue").length,
      next_due: nextDue
        ? {
            rule_name: nextDue.rule_name,
            due_on: nextDue.due_on,
            days_until_due: nextDue.days_until_due,
            computed_status: nextDue.computed_status,
            comar_source_ref: nextDue.comar_source_ref,
          }
        : null,
    },
    ...(alsoMatched.length > 0 ? { also_matched: alsoMatched } : {}),
  };
}

async function getObligations(supabase: SupabaseClient, scope: string): Promise<unknown> {
  // Filter on computed_status IN THE VIEW, not after the fact: a TS-side filter over a
  // due-date-ordered page silently drops matches that fall past the row limit, which
  // would understate "overdue" — the exact number a coordinator acts on.
  const wanted = (UNSATISFIED as readonly string[]).includes(scope)
    ? [scope]
    : [...UNSATISFIED];

  // count: 'exact' gives the TRUE number matching the filter, independent of the row
  // limit below. The model repeats counts verbatim as ground truth, so a count that
  // meant "rows I happened to fetch" would be a wrong fact, not a rendering detail.
  const { data, error, count } = await supabase
    .from("cadence_obligation_status")
    .select(OBLIGATION_COLS, { count: "exact" })
    .in("computed_status", wanted)
    .order("due_on", { ascending: true })
    .limit(25);
  if (error) return { error: "Obligations are unavailable right now." };

  const rows = (data ?? []) as ObligationRow[];
  const total = typeof count === "number" ? count : rows.length;

  // Resolve client display names for the rows the user can see (RLS decides).
  const clientIds = [
    ...new Set(rows.map((r) => r.client_id).filter((x): x is string => Boolean(x))),
  ];
  const nameById = new Map<string, string>();
  if (clientIds.length > 0) {
    const { data: clients } = await supabase
      .from("client")
      .select("id, first_name, last_name")
      .in("id", clientIds);
    for (const cl of clients ?? []) nameById.set(cl.id, `${cl.first_name} ${cl.last_name}`);
  }

  return {
    scope,
    count: total,
    listed: rows.length,
    ...(total > rows.length
      ? { note: `Showing the ${rows.length} soonest of ${total}. The count is exact.` }
      : {}),
    obligations: rows.map((o) => ({
      rule_name: o.rule_name,
      severity: o.severity,
      due_on: o.due_on,
      days_until_due: o.days_until_due,
      computed_status: o.computed_status,
      comar_source_ref: o.comar_source_ref,
      client: o.client_id ? nameById.get(o.client_id) ?? "(restricted)" : null,
    })),
  };
}

/**
 * Execute one Brain tool call under the requesting user's client.
 * Always returns a JSON string (capped); never throws — a failed tool becomes an
 * honest fact ("unavailable") the model can narrate, not a page error.
 */
export async function executeBrainTool(
  supabase: SupabaseClient,
  name: string,
  argsJson: string
): Promise<string> {
  try {
    const args = (argsJson ? JSON.parse(argsJson) : {}) as Record<string, unknown>;
    let result: unknown;
    if (name === "get_client_summary") {
      result = await getClientSummary(supabase, String(args.name ?? ""));
    } else if (name === "get_obligations") {
      result = await getObligations(supabase, String(args.scope ?? "all"));
    } else {
      result = { error: `Unknown tool: ${name}` };
    }
    return JSON.stringify(result).slice(0, MAX_RESULT_CHARS);
  } catch {
    return JSON.stringify({ error: "Tool execution failed." });
  }
}

/** Bind the executor to a user-scoped client (what runCapability consumes). */
export function makeBrainToolExecutor(
  supabase: SupabaseClient
): (name: string, argsJson: string) => Promise<string> {
  return (name, argsJson) => executeBrainTool(supabase, name, argsJson);
}
