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

function unarmed(reason) {
  console.log(`UNARMED — ${reason}. This run proved nothing about any prompt.`);
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

let gateFailed = false;
for (const cap of targets) {
  const entry = registry.get(cap);
  const threshold = thresholds[cap]?.pass_rate;
  if (!entry) { console.error(`✗ ${cap}: not in the registry — a case set for an unregistered capability`); gateFailed = true; continue; }
  if (threshold === undefined) { console.error(`✗ ${cap}: no threshold in thresholds.json — unlisted capabilities fail by design`); gateFailed = true; continue; }

  const files = readdirSync(join(CASES, cap)).filter((f) => f.endsWith(".json")).sort();
  let passed = 0;
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(CASES, cap, f), "utf8"));
    let failures;
    try {
      const output = await callModel(entry.model, entry.prompt, c.input);
      failures = judge(output, c.expect ?? {});
    } catch (e) { failures = [String(e.message ?? e)]; }
    if (failures.length === 0) passed += 1;
    else console.log(`  ✗ ${cap}/${c.name ?? f}\n      ${failures.join("\n      ")}`);
  }
  const rate = files.length ? passed / files.length : 0;
  const ok = rate >= threshold;
  console.log(`${ok ? "✓" : "✗"} ${cap}: ${passed}/${files.length} passed (${(rate * 100).toFixed(1)}% vs ${threshold * 100}% required, model ${entry.model})`);
  if (!ok) gateFailed = true;
}
process.exit(gateFailed ? 1 : 0);
