#!/usr/bin/env node
// CareOS eval harness (WE / ST-245 — docs/16 §3.1). See README.md beside this file.
//
// Reads each capability's ACTIVE system prompt from the LOCAL database registry
// (prompts are rows, never literals — invariant 10), runs every case in
// scripts/evals/cases/<capability>/ against the capability's pinned model via the
// OpenAI API, applies the case's deterministic assertions, and gates on
// thresholds.json. Synthetic inputs only (D-006): nothing in cases/ may carry PHI,
// and the harness never reads a tenant table — only ai_capability + ai_prompt_template.
//
// Honest-skip contract (the deadman "unarmed" pattern): a missing key or stack prints
// UNARMED and exits 0 — unless CAREOS_EVALS_REQUIRED=1 (the CI stage), where proving
// nothing is a failure, not a pass.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const CASES = join(ROOT, "cases");
const REQUIRED = process.env.CAREOS_EVALS_REQUIRED === "1";
const DB_CONTAINER = process.env.CAREOS_EVALS_DB_CONTAINER ?? "supabase_db_careOS";
const only = process.argv[2] ?? null;
// Evaluation-only model override. The registry pin is what SHIPS; this exists because the
// pin is CareOS vocabulary and the evaluating provider may not serve that exact id.
const MODEL_OVERRIDE = process.env.CAREOS_EVALS_MODEL || null;

// ST-244: a gate whose failure reason is only in the log is a gate only an admin can
// diagnose — GitHub returns 403 on job logs to everyone else, so the first two red runs
// of this gate showed nothing but "Process completed with exit code 1". Annotations are
// readable by anyone who can see the run, so every outcome that matters is emitted as one.
// Newlines must be encoded; a raw \n truncates an annotation at the first line.
function annotate(level, title, message) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const one = String(message).replace(/\r?\n/g, "%0A").replace(/::/g, ": ");
  console.log(`::${level} title=${title}::${one}`);
}

// ST-244: provider ACCESS failures are a different animal from provider errors. A 401,
// 403 or 429/insufficient_quota means the account cannot call the model at all — which is
// the same situation as having no key, and the code under test cannot influence it. The
// first armed run of this gate went red on `insufficient_quota` (an unpaid balance), and a
// gate that stays red on every push for a billing state no contributor can fix is how a
// team learns to scroll past red. So this class reports UNARMED and does not fail the
// build; a genuine prompt regression, a missing registry row and a missing threshold all
// still fail. The distinction is what is being proven, not how loud the message is.
function isProviderAccessError(message) {
  return /HTTP (401|403|429)\b/.test(message) || /insufficient_quota|billing|exceeded your current quota/i.test(message);
}

function unarmed(reason) {
  const line = `UNARMED — ${reason}. This run proved nothing about any prompt.`;
  console.log(line);
  annotate(REQUIRED ? "error" : "warning", "Eval gate unarmed", line);
  process.exit(REQUIRED ? 1 : 0);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) unarmed("OPENAI_API_KEY is not set");

// ── Registry read: capability → { model, prompt } from the local stack ────────
function sql(query) {
  return execFileSync(
    "docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-tA", "-c", query],
    { encoding: "utf8" }
  ).trim();
}
let registry;
try {
  // One JSON document, not rows: system_prompt is multi-line text, and any line- or
  // separator-based parse of it is a latent corruption bug.
  const raw = sql(
    "select coalesce(json_agg(json_build_object(" +
    "'key', c.key, 'model', c.model, 'prompt', t.system_prompt)), '[]'::json) " +
    "from public.ai_capability c " +
    "join public.ai_prompt_template t " +
    "on t.capability_key = c.key and t.tenant_id = c.tenant_id and t.active"
  );
  registry = new Map(JSON.parse(raw).map((r) => [r.key, { model: r.model, prompt: r.prompt }]));
} catch {
  unarmed(`local database registry unreachable (docker container '${DB_CONTAINER}')`);
}

const thresholds = JSON.parse(readFileSync(join(ROOT, "thresholds.json"), "utf8"));

async function callModel(model, system, input) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: input }],
    }),
  });
  if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.choices?.[0]?.message?.content ?? "";
}

function judge(output, expect) {
  const failures = [];
  const lower = output.toLowerCase();
  for (const s of expect.must_contain ?? [])
    if (!lower.includes(s.toLowerCase())) failures.push(`missing required substring: ${JSON.stringify(s)}`);
  for (const group of expect.must_contain_any ?? [])
    if (!group.some((s) => lower.includes(s.toLowerCase())))
      failures.push(`none of the alternatives present: ${JSON.stringify(group)}`);
  for (const s of expect.must_not_contain ?? [])
    if (lower.includes(s.toLowerCase())) failures.push(`forbidden substring present: ${JSON.stringify(s)}`);
  for (const r of expect.must_match ?? [])
    if (!new RegExp(r, "i").test(output)) failures.push(`regex did not match: ${r}`);
  if (expect.json) { try { JSON.parse(output); } catch { failures.push("output is not valid JSON"); } }
  return failures;
}

const capDirs = existsSync(CASES)
  ? readdirSync(CASES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
const targets = only ? capDirs.filter((c) => c === only) : capDirs;
if (targets.length === 0) unarmed(only ? `no case directory for ${only}` : "no case sets exist yet");

// ── The run ───────────────────────────────────────────────────────────────────
// ST-244: the first CI run of this gate went red and the message could not tell anybody
// WHY, because the loop below used to fold three different outcomes into one counter.
// A case can (a) fail its assertions — the prompt regressed, which is the only thing this
// gate exists to catch; (b) never reach the model at all — an unknown capability, a model
// the provider rejects, a network refusal; or (c) pass. Counting (b) as (a) produces the
// exact lie this repo refuses everywhere else: a red that says "the prompt regressed" when
// the truth is "nothing was evaluated". They are now separate, and the summary says which.
const CAP_STATUS = { REGRESSED: "regressed", UNEVALUATED: "unevaluated", OK: "ok" };
const results = [];

for (const cap of targets) {
  const entry = registry.get(cap);
  const threshold = thresholds[cap]?.pass_rate;

  if (!entry) {
    // An empty registry is the shape a FRESH database has: 0057 seeds capabilities per
    // tenant (`select app.seed_front_door_capabilities(t.id) from public.tenant t`), and a
    // database with migrations but no seeds has no tenants, so it has no capabilities
    // either. That is a harness-setup fact, never a prompt regression — hence UNEVALUATED
    // and a message that names the fix rather than blaming the prompt.
    results.push({ cap, status: CAP_STATUS.UNEVALUATED,
      why: "no registry row — the database has migrations but no seeded tenant, so " +
           "0057 registered nothing. Seed it (supabase db reset) before gating." });
    continue;
  }
  if (threshold === undefined) {
    results.push({ cap, status: CAP_STATUS.UNEVALUATED,
      why: "no threshold in thresholds.json — add one before this capability can gate" });
    continue;
  }

  const model = MODEL_OVERRIDE ?? entry.model;
  const files = readdirSync(join(CASES, cap)).filter((f) => f.endsWith(".json")).sort();
  let passed = 0, assertionFailures = 0, transportErrors = 0, firstError = null;

  for (const f of files) {
    const c = JSON.parse(readFileSync(join(CASES, cap, f), "utf8"));
    let output;
    try {
      output = await callModel(model, entry.prompt, c.input);
    } catch (e) {
      transportErrors += 1;
      firstError ??= String(e.message ?? e);
      continue;                       // never reached the model — not the prompt's fault
    }
    const failures = judge(output, c.expect ?? {});
    if (failures.length === 0) passed += 1;
    else {
      assertionFailures += 1;
      console.log(`  ✗ ${cap}/${c.name ?? f}\n      ${failures.join("\n      ")}`);
    }
  }

  const evaluated = passed + assertionFailures;
  if (evaluated === 0) {
    // Every call failed before the prompt was ever exercised. The overwhelmingly common
    // cause is a model id the provider does not serve: `ai_capability.model` pins CareOS's
    // OWN vocabulary (D-013), which is not guaranteed to be a provider-side model name.
    // CAREOS_EVALS_MODEL overrides the pin for evaluation only — it never touches the
    // registry, so what SHIPS stays exactly what the registry says.
    results.push({ cap, status: CAP_STATUS.UNEVALUATED, access: isProviderAccessError(firstError ?? ""),
      why: `all ${files.length} call(s) failed before any assertion ran, using model ` +
           `'${model}'. First error: ${firstError}. If the provider does not serve that ` +
           `model id, set CAREOS_EVALS_MODEL to one it does.` });
    continue;
  }

  const rate = passed / evaluated;
  const ok = rate >= threshold;
  const note = transportErrors ? ` — ${transportErrors} case(s) never reached the model` : "";
  console.log(`${ok ? "✓" : "✗"} ${cap}: ${passed}/${evaluated} evaluated passed ` +
    `(${(rate * 100).toFixed(1)}% vs ${threshold * 100}% required, model ${model})${note}`);
  results.push({ cap, status: ok ? CAP_STATUS.OK : CAP_STATUS.REGRESSED,
    detail: `${passed}/${evaluated} passed (${(rate * 100).toFixed(1)}% vs ${threshold * 100}% required, model ${model})` });
}

const regressed = results.filter((r) => r.status === CAP_STATUS.REGRESSED);
const unevaluated = results.filter((r) => r.status === CAP_STATUS.UNEVALUATED);

for (const r of unevaluated) {
  console.error(`! ${r.cap}: NOT EVALUATED — ${r.why}`);
  annotate("error", `Not evaluated: ${r.cap}`, r.why);
}

if (regressed.length) {
  const summary = regressed.map((r) => `${r.cap}: ${r.detail}`).join("\n");
  console.error(`\nGATE FAILED: ${regressed.length} capability(ies) regressed against their case set.`);
  annotate("error", "Prompt regression", summary);
  process.exit(1);
}
// Every capability blocked purely by provider ACCESS ⇒ the same standing as no key at all.
if (unevaluated.length && unevaluated.every((r) => r.access)) {
  const line =
    "PROVIDER UNAVAILABLE — every capability was refused by the provider before a single " +
    "assertion ran, so nothing was evaluated and nothing regressed. This is an account " +
    "problem, not a code one: " + (unevaluated[0].why.split("First error:")[1] ?? "").trim();
  console.error(`\n${line}`);
  annotate("warning", "Eval gate unarmed (provider refused)", line);
  process.exit(0);
}

if (unevaluated.length) {
  // Proving nothing must never read as green — the same rule the deadman workflow follows.
  // In CI (REQUIRED) that is fatal; locally it is a loud notice so unrelated work is not
  // blocked by a provider or seeding problem.
  console.error(`\n${unevaluated.length} capability(ies) could not be evaluated. ` +
    `No prompt regressed — but nothing was proven either.`);
  annotate(REQUIRED ? "error" : "warning", "Eval gate proved nothing",
    `${unevaluated.length} capability(ies) could not be evaluated:\n` +
    unevaluated.map((r) => `${r.cap} — ${r.why}`).join("\n"));
  process.exit(REQUIRED ? 1 : 0);
}
console.log(`\nGATE PASSED: ${results.length} capability(ies) held their case sets.`);
process.exit(0);
