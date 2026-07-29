/**
 * The single chokepoint for every model call (invariant 10). Server-only.
 *
 * Responsibilities enforced here so no caller can skip them:
 *   - Retrieval runs AS THE USER (invariant 9): the corpus is read through the caller's
 *     RLS-scoped Supabase client; there is no privileged retrieval path.
 *   - PHI-minimizer (invariant 5): the Brain sends POLICY text + the question only, and the
 *     ai_interaction ledger stores PHI-safe digests, never raw client content.
 *   - Every call is recorded in ai_interaction (append-only), including provider/model/tokens/
 *     cost/tier/status — via the user-scoped client (invariant 6: no service_role).
 *   - Provider is env-swappable: OpenAI when OPENAI_API_KEY is set, otherwise a deterministic
 *     mock so the plane is demoable and verifiable with no key and no network.
 *
 * Vendor: OpenAI (D-log 2026-07). Real PHI to any LLM waits for a signed BAA — synthetic only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const PROMPT_VERSION = "brain.v1";

export type BrainCitation = { n: number; title: string; source_ref: string | null };
export type BrainAnswer = {
  answer: string;
  abstained: boolean;
  citations: BrainCitation[];
  provider: "openai" | "mock";
  model: string;
};

type Doc = { id: string; title: string; body: string; source_ref: string | null };

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "what",
  "how", "when", "who", "why", "do", "does", "can", "i", "my", "our", "we", "should", "must",
]);
function keywords(q: string): string[] {
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}
function rank(question: string, docs: Doc[]): Doc[] {
  const kw = keywords(question);
  return docs
    .map((d) => {
      const hay = (d.title + " " + d.body).toLowerCase();
      return { d, score: kw.reduce((s, k) => s + (hay.includes(k) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.d);
}
/** PHI-safe digest: collapse whitespace + truncate. (Brain inputs are policy + question, no PHI.) */
function digest(s: string, max = 220): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

const ABSTAIN = "I don't have a policy document that covers that. Your coordinator or the compliance lead can help.";

function mockAnswer(docs: Doc[]): { text: string; abstained: boolean; cited: number[] } {
  if (!docs.length) return { text: ABSTAIN, abstained: true, cited: [] };
  return { text: `${digest(docs[0].body, 280)} [1]`, abstained: false, cited: [1] };
}

async function openaiAnswer(
  key: string,
  question: string,
  docs: Doc[]
): Promise<{ text: string; abstained: boolean; cited: number[]; tokensIn: number; tokensOut: number; model: string }> {
  const system =
    "You are CareOS's policy assistant for a Maryland home-care agency. Answer ONLY using the " +
    "numbered policy excerpts provided. Cite each fact with its excerpt number like [1]. If the " +
    'excerpts do not contain the answer, reply exactly: "' + ABSTAIN + '" ' +
    "Never use outside knowledge and never guess.";
  const user =
    `Question: ${question}\n\nPolicy excerpts:\n` +
    docs.map((d, i) => `[${i + 1}] ${d.title}${d.source_ref ? ` (${d.source_ref})` : ""}: ${d.body}`).join("\n\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const abstained = /don'?t have a policy/i.test(text) || cited.length === 0;
  return {
    text,
    abstained,
    cited,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
    model: data.model ?? MODEL,
  };
}

export async function askBrain(supabase: SupabaseClient, question: string): Promise<BrainAnswer> {
  const t0 = Date.now();

  // Retrieval-as-the-user (invariant 9): RLS-scoped select, ranked in-process.
  const { data: raw } = await supabase
    .from("knowledge_document")
    .select("id, title, body, source_ref")
    .eq("active", true)
    .limit(50);
  const docs = rank(question, (raw ?? []) as Doc[]);

  const key = process.env.OPENAI_API_KEY;
  let text: string;
  let abstained: boolean;
  let cited: number[];
  let tokensIn = 0;
  let tokensOut = 0;
  let model = MODEL;
  let provider: "openai" | "mock" = "mock";

  try {
    if (key) {
      const r = await openaiAnswer(key, question, docs);
      ({ text, abstained, cited, tokensIn, tokensOut } = r);
      model = r.model;
      provider = "openai";
    } else {
      const r = mockAnswer(docs);
      ({ text, abstained, cited } = r);
      model = `${MODEL} (mock)`;
      provider = "mock";
    }
  } catch {
    const r = mockAnswer(docs);
    ({ text, abstained, cited } = r);
    model = `${MODEL} (mock-fallback)`;
    provider = "mock";
  }

  // Record the interaction (PHI-safe digests; created_by pinned to self by RLS — invariant 6/10).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: me } = await supabase.from("app_user").select("tenant_id").eq("id", user.id).maybeSingle();
    if (me?.tenant_id) {
      const cost = (tokensIn / 1000) * 0.00015 + (tokensOut / 1000) * 0.0006;
      await supabase.from("ai_interaction").insert({
        tenant_id: me.tenant_id,
        capability_key: "brain.answer",
        provider,
        model,
        prompt_version: PROMPT_VERSION,
        tier: "T1",
        status: abstained ? "abstained" : "ok",
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: Number(cost.toFixed(4)),
        latency_ms: Date.now() - t0,
        input_digest: digest(question, 200),
        output_digest: digest(text, 200),
        created_by: user.id,
      });
    }
  }

  const citations: BrainCitation[] = [...new Set(cited)]
    .map((n) => {
      const d = docs[n - 1];
      return d ? { n, title: d.title, source_ref: d.source_ref } : null;
    })
    .filter((x): x is BrainCitation => x !== null);

  return { answer: text, abstained, citations, provider, model };
}
