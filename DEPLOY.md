# Deploying the CareOS demo to Vercel

This deploys the **synthetic Meadowbrook demo** (no real PHI) to a public Vercel URL.
It is a real full-stack deploy: Next.js on Vercel + a **hosted** Supabase backend (Vercel
cannot reach the Supabase running on your Mac). Budget ~15–20 minutes the first time.

> **Boundaries (do not skip):** Synthetic data only. Real PHI still requires the signed
> BAAs (Supabase + Vercel + OpenAI) per docs/09 §6 — this demo does not change that. Your
> design doc says the real product is invite-only / no public distribution; a public demo
> is fine for showing the product, but add Vercel Deployment Protection (a password) if you
> don't want it fully open. `CAREOS_DEMO_MODE=true` enables the persona switcher, which can
> **only** impersonate the seeded synthetic accounts — never set it on a real-PHI deploy.

## 1 — Hosted Supabase backend

1. Create a project at supabase.com (note the project ref, DB password, and region).
2. From this repo, link and push the schema (migrations 0001–0019):

   > **Already deployed once?** `supabase db push` is also how you ship *new* migrations to
   > an existing hosted project — it applies only what the remote has not seen. 0017–0019
   > (definition binding, legal authority, COMAR fidelity) are additive and expand-only, but
   > 0017 does run a one-time backfill `UPDATE` over `form_version` to populate the new
   > template binding. Take a PITR bookmark first on anything you care about (docs/13 §3).
   ```bash
   cd ~/careos-work
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
3. Seed the synthetic universe into the hosted DB. Get the connection string from the
   Supabase dashboard (Project Settings → Database → Connection string → URI), then:
   ```bash
   HOSTED="postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres"
   for f in seed.sql seeds/cadence.sql seeds/careplan.sql seeds/credentials.sql \
            seeds/demo_users.sql seeds/meadowbrook_universe.sql seeds/scheduling.sql \
            seeds/zz_ai.sql seeds/zz_enrichment.sql seeds/zz_family.sql; do
     echo ">> $f"; psql "$HOSTED" -f "supabase/$f" || break
   done
   ```
4. From the dashboard: **Project Settings → API** → copy the **Project URL** and the
   **anon public** key (you'll paste these into Vercel).
5. Auth hardening (ST-123): **Authentication → Providers → Email** — enable **leaked
   password protection** (HaveIBeenPwned check). The security advisor flags any hosted
   project without it; the local stack has no equivalent toggle, so this is a
   per-project dashboard step.

> **Known gotcha — demo MFA on hosted Supabase.** The persona auto-login reaches AAL2 by
> completing a real TOTP challenge against a seeded factor (`seeds/demo_users.sql`) whose
> secret is stored in plaintext. If your hosted project encrypts MFA secrets, that seed
> won't validate and demo logins will stall at `/mfa`. If that happens, either (a) enroll a
> factor through the UI for one account, or (b) tell me and I'll switch the demo to a
> DB-function AAL2 shim scoped to the synthetic tenant. Local dev is unaffected.

## 2 — Vercel

1. Push is already done — the repo is at `github.com/smsabeidi/careOS`, branch
   `st-013-apple-2026-rebrand`.
2. In Vercel: **Add New → Project → Import** that GitHub repo.
3. **Root Directory: `apps/web`** (this is a monorepo — Vercel must build the web app, not
   the repo root). Framework preset: Next.js. Build/install commands: leave as detected
   (pnpm).
4. **Environment Variables** (Production + Preview):

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` (from step 1.4) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon public key (from step 1.4) |
   | `CAREOS_DEMO_MODE` | `true` |
   | `NEXT_PUBLIC_CAREOS_DEMO_MODE` | `true` |
   | `CAREOS_DEMO_PASSWORD` | `Meadowbrook!demo1` |
   | `OPENAI_API_KEY` | your key (optional — without it the Brain uses the mock) |
   | `OPENAI_MODEL` | `gpt-4o-mini` (optional) |

5. **Deploy.** When it's live, open the URL and sign in as `sarah@meadowbrook.demo` /
   `Meadowbrook!demo1`, then use "View as" to walk every role.

## Notes

- The production build is verified green (`next build`, 0 errors) and the demo is
  flag-gated so it works on Vercel without weakening AAL2 (the switcher uses the real MFA
  step-up, not a bypass; the middleware AAL2 bypass stays permanently inert in production).
- The OpenAI account currently returns HTTP 429 (no quota) — add billing at
  platform.openai.com for live Brain answers; until then it gracefully falls back to the mock.
- Supabase's local `.env.local` values are for your Mac only. Vercel uses the hosted values
  above. Never commit any of them (they're gitignored).
