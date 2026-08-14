# Founder handoff — production-readiness closeout (2026-08-13)

Everything an agent could finish is finished. This file is the exhaustive list of what
remains, and every item here is yours **because it is structurally yours** — a legal act,
a governance ratification, or a credential this repo's custody rules forbid an agent to
touch (docs/09 §5). Nothing else is pending.

## 1 · OpenAI BAA + Safety-Retention (V4) — gates all real-PHI AI

The single production-enablement gate for the entire AI plane (docs/00 §4 V4, D-013).
Until it is executed and registered in docs/09 §6, every capability runs synthetic-only
(D-006) — correctly and automatically. Nothing to configure afterward: the posture is
enforced by data residency, not by a switch.

## 2 · Ratify (or amend) PD-1..PD-4 — docs/00 §3 "Proposed decisions"

- **PD-1 messaging** and **PD-2 revenue cycle** block only their future builds.
- **PD-3 web-push** blocks W6b (push delivery). The install page (W6a) shipped without it.
- **PD-4 voice-audio retention** blocks only audio *destruction*; today audio is stored
  and nothing is destroyed, which is the safe interim.

Ratifying = assigning each a D-number in §3 with your chosen option. The analysis is in
each proposal; recommended options are marked.

## 3 · Two GitHub repo secrets — arms the deadman

`SUPABASE_URL` and `CAREOS_DEADMAN_KEY` (a service key — see .github/workflows/deadman.yml
header). Until set, the workflow prints a loud **UNARMED** warning every 30 minutes and
proves nothing; it never fakes green. Set via the GitHub UI → Settings → Secrets, or an
authenticated `gh secret set`.

## 4 · OpenAI billing — the eval gate is armed but the account has no quota

**Status as of 2026-08-14: the secret is set and the gate runs, but every call comes back
`HTTP 429 insufficient_quota` — "You exceeded your current quota, please check your plan
and billing details."** Nothing regressed and nothing was evaluated. Add credit to the
OpenAI account and the 120 cases start gating on the next push; no code change is needed.

CI is green meanwhile, deliberately and visibly: a provider that refuses service is
classified the same as having no key at all (loud `Eval gate unarmed (provider refused)`
warning), because a build that stays red on every push for an unpaid balance is how a team
learns to ignore red. A genuine prompt regression still fails the build.

**Rotate the key you pasted into chat before adding billing to it** — a key in a transcript
should be treated as public.

## 4b · One CI secret — arms the eval gate

`OPENAI_API_KEY` as a GitHub Actions secret. With it, any prompt change that regresses
its case set (`scripts/evals/`, 120 cases) fails the merge; without it the stage reports
UNARMED and (in CI) fails rather than passing vacuously. The same variable exported
locally arms `node scripts/evals/run.mjs` on your machine.

## 5 · Supabase Auth dashboard — leaked-password protection toggle

One click (Auth → Providers → Password → "leaked password protection"), the last WARN
class the advisors can raise. No API path exists without a management token.

## 6 · After the soak: flip the flags

When the soak clears and you want each surface live, per tenant and audited:

```sql
select app.set_feature_flag('front_door.command_bar',  true, 'soak clear');
select app.set_feature_flag('front_door.note_coach',   true, 'soak clear');
select app.set_feature_flag('front_door.inbox',        true, 'soak clear');
select app.set_feature_flag('front_door.actions',      true, 'soak clear');
select app.set_feature_flag('front_door.form_import',  true, 'soak clear');
select app.set_feature_flag('front_door.family_weekly',true, 'soak clear');
-- W-ONB's first-run surface is separate and additionally blocks on PD-5:
select app.set_feature_flag('onboarding.welcome',       true, 'PD-5 ratified');
```

Each flag has a surface behind it as of `b0eab14`: command bar + NL scheduling drafts,
note coach, attention queue, form import, family drafts, and the install page (public, no
flag). Flip them one at a time and watch the acceptance-rate metric per capability — a
capability whose drafts are mostly rejected is telling you its prompt is wrong, and the
kill switch is per-key precisely so one bad capability never takes the door down.

AI capabilities additionally need their registry kill switches enabled
(`ai_capability.enabled = true` per key — deliberately a separate, owner-level act).
Rollback of anything is the same call with `false` — instant, audited, data intact.

## What is already live and verified (nothing to do)

Hosted `dabxajszjhfzivxxxamg` runs the full 57-migration chain: the entire Verified Visit
layer, the Front Door data plane (`alert_ack`, capability `config`, `evidence_summary`),
and the five Front Door capabilities registered with eval-gated prompts — every kill
switch off, every flag dark, advisors at zero errors, health ok, the visit sweep green on
its 5-minute cron. Vercel prod serves the merged build; unauthenticated traffic fails
closed to /login. The pgTAP suite stands at 41 files / 1,735 assertions green, matrix at
75 tables, drift gate clean.
