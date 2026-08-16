# Founder handoff — production-readiness closeout (updated 2026-08-16)

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

**One file now does all of it: `scripts/enable-all-features.sql`.** It resolves the
tenant's `platform.manage` holder, flips all nine dark flags through the audited RPC, and
enables the AI registry's kill switches. Read its header first: it states what it
deliberately does *not* touch (Maryland's ISAS adapter — the real outbound gate, which
stays off per D-026) and what changes the moment `onboarding.welcome` is on.

**Every flag was run enabled end-to-end locally on 2026-08-16, and that run found a real
defect** — see §7. Production is still dark: an agent cannot flip it, because the RPC
requires an AAL2 session for a `platform.manage` holder and that is a signed-in human by
design. Running the file above is the whole act.

Everything below explains what each flag buys.


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

`onboarding.welcome` now has its whole surface behind it as of `efea96b` (2026-08-16):
`/welcome` renders a per-role checklist, every step records a milestone (migration 0059,
live on hosted), and the a11y sweep walks the screen — 25 passed / 1 skipped / 0 failed
against a production build. It is dark, and flipping it is PD-5's ratification plus the
call below; nothing else about it is outstanding.

Each other flag has a surface behind it as of `b0eab14`: command bar + NL scheduling drafts,
note coach, attention queue, form import, family drafts, and the install page (public, no
flag). Flip them one at a time and watch the acceptance-rate metric per capability — a
capability whose drafts are mostly rejected is telling you its prompt is wrong, and the
kill switch is per-key precisely so one bad capability never takes the door down.

AI capabilities additionally need their registry kill switches enabled
(`ai_capability.enabled = true` per key — deliberately a separate, owner-level act).
Rollback of anything is the same call with `false` — instant, audited, data intact.

## 7 · What lighting every flag actually found (2026-08-16)

Enabling all eleven flags + all twenty-four AI capabilities on the local Meadowbrook stack
made the Front Door E2E specs **run instead of skip for the first time**. That run was
worth having: 6 journeys failed, and one was a real product defect.

**Fixed and shipped (`ec58bc5`).** The command bar's ⌘K shortcut did nothing during any
page load. `AppShell` mounts the bar and eleven `loading.tsx` skeletons render `AppShell`,
so while a route streamed there were *two* islands, each with a document keydown listener —
and since the chord toggles, one press opened the bar and closed it in the same tick. A DOM
probe confirmed two trigger nodes during streaming, one after settle. Skeletons no longer
mount it. That fixed the attention-queue journey and three of four command-bar journeys;
the fourth was a genuine pre-hydration race in the test and is fixed as one.

**Still open, stated plainly: 1 front-door journey fails.** `note-coach.spec.ts` — "recording
is stopped, and explained, when there is no connection". The Voice note control is *absent*
from the caregiver's first visit card (element not found, not merely disabled), so the
journey never reaches the offline state it exists to measure. Granting the harness a fake
microphone (`playwright.config.ts`) was necessary but did not resolve it; the cause is
upstream of the mic and is not yet diagnosed. **Plus the 3 pre-existing ST-221 failures**
(`approve-hours`, `payroll-close-export`, `visit-policy-version`) which predate this work.

Everything else is green with every feature lit: a11y **25 passed / 0 failed**, Front Door
desktop **12 passed / 1 failed**, pgTAP 43 files, 304 unit tests, all four CI checks.

## What is already live and verified (nothing to do)

Hosted `dabxajszjhfzivxxxamg` runs the full 59-migration chain: the entire Verified Visit
layer, the Front Door data plane (`alert_ack`, capability `config`, `evidence_summary`),
the five Front Door capabilities registered with eval-gated prompts, and the first-run
onboarding plane (0058 + 0059) — every kill switch off, every flag dark, advisors at zero
errors and zero warnings, health ok, the visit sweep green on its 5-minute cron. Vercel
prod serves the merged build; unauthenticated traffic fails closed to /login, `/welcome`
included. The pgTAP suite stands at 43 files / 1,800+ assertions green, matrix at 76
tables, drift gate clean, and the a11y sweep has been executed rather than merely wired
(25 passed / 1 skipped / 0 failed on a production build, all four personas).
