# CareOS eval harness (WE / ST-245 — docs/16 §3.1)

The merge gate for every registry prompt. Each AI capability ships **with** a case set;
a prompt change that regresses its cases fails CI before it reaches a human.

## How it runs

```bash
node scripts/evals/run.mjs                 # all capabilities
node scripts/evals/run.mjs note.quality_coach   # one capability
```

Requirements, checked at startup and **skipped honestly** (never vacuously green) when
absent — the run prints `UNARMED` naming what is missing and exits 0 locally / non-zero
in CI when `CAREOS_EVALS_REQUIRED=1`:

- The local Supabase stack (the runner reads each capability's ACTIVE registry prompt
  from the database — prompts are rows, never literals; invariant 10's registry is the
  single source).
- `OPENAI_API_KEY` in the environment (D-013 provider). Every case input is synthetic
  (Meadowbrook universe, D-006); no PHI can enter a prompt from here by construction.

## Case format — `scripts/evals/cases/<capability_key>/*.json`

```json
{
  "name": "vague-language-flagged",
  "input": "…the user/system content handed to the model…",
  "expect": {
    "must_contain": ["substring", "…"],
    "must_contain_any": [["either this", "or this"]],
    "must_not_contain": ["substring the output may never carry"],
    "must_match": ["case-insensitive regex", "…"],
    "json": false
  }
}
```

Assertions are **deterministic** (substrings and regexes over the model output — no
LLM judge in v1; a judge is itself a model call whose drift nobody gates). `json: true`
additionally requires the output to parse as JSON. `must_not_contain` is the PHI/D-030
teeth: coordinate-looking strings, names, and employment-action verbs live there.

## Thresholds — `scripts/evals/thresholds.json`

Per capability: `{"pass_rate": 0.9}` — the fraction of cases that must pass. The gate
fails if the capability's rate drops below its threshold. New capabilities MUST appear
here before their first case runs (an unlisted capability fails the gate by design).

## CI

`CAREOS_EVALS_REQUIRED=1 node scripts/evals/run.mjs` in the eval stage: with the stack
and key present it gates; with either absent it fails loudly rather than passing
vacuously. Local runs without the key print UNARMED and exit 0 so unrelated work is
never blocked by a missing secret.

## When the gate is red, read the annotation first

Job logs need admin rights; annotations do not. Every outcome that matters is emitted as
one, so anybody who can see the run can tell these four apart without asking:

| Annotation | Meaning | Who fixes it |
|---|---|---|
| `Prompt regression` | A capability fell below its threshold on cases that really ran. **This is the only thing this gate exists to catch.** | Whoever changed the prompt — with a new `ai_prompt_template` VERSION, never an edit to v1 |
| `Not evaluated: <cap>` | Cases never reached the model — no registry row (an unseeded database registers nothing, since 0057 seeds per tenant), or no threshold | Repo config; fails the build under `CAREOS_EVALS_REQUIRED` |
| `Eval gate unarmed (provider refused)` | 401/403/429 — the account cannot call the model at all. Same standing as having no key: **warns, does not fail** | Billing/credentials on the provider account |
| `Eval gate unarmed` | No `OPENAI_API_KEY`, or the local registry is unreachable | Set the secret (CI) or export the key (local) |

`CAREOS_EVALS_MODEL` overrides `ai_capability.model` for EVALUATION ONLY — the registry pin
is still what ships. Use it when the provider does not serve CareOS's own model vocabulary.
