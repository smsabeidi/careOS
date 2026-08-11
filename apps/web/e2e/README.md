# CareOS E2E — Verified Visit & Workforce Intelligence journeys

## Read this first

**These journeys have never been executed. Not once.**

They are specified and wired — every selector was written against the actual page and
component source in `apps/web/src/app/**`, every assertion traces to a doc section or a
ratified decision, and `playwright test --list` enumerates all of them without error. That
is the entire extent of what has been verified.

What has **not** happened: no browser has ever driven them, no assertion has ever been
evaluated against a running CareOS, and no result — pass or fail — has ever been observed.
Nothing in this directory is evidence of anything about the product yet.

The reason is stated plainly rather than buried: the machine they were authored on runs a
bare Postgres harness (`scripts/local-pg`) and nothing else. There is no Supabase Auth, no
GoTrue, no PostgREST. **The web app cannot talk to it.** It cannot sign a persona in, cannot
read a row, and cannot render a single one of the surfaces below. A test that needs a live
authenticated app needs a live Supabase, and there was none.

So the suite skips. Every journey calls `test.skip(callback, reason)` with a sentence
naming the missing environment variables and stating that it asserted nothing. Never a
silent pass — a green tick over an empty run is a lie told to whoever ships on it. Never a
hard failure either, because "somebody forgot a variable" and "the product is broken" must
not produce the same red light.

When you first run these against a real environment, **expect failures.** Selectors written
from source and never exercised are a hypothesis, not a fact. Fix them, then delete this
paragraph and record the first real pass in the commit message.

---

## What is covered

| Spec | Journey | Traces to |
|---|---|---|
| `specs/caregiver/clock-in.spec.ts` | In-fence clock-in → visit in progress → complete visit | docs/12 §4, docs/17 §7.1 §12 |
| `specs/caregiver/unverifiable-location.spec.ts` | Unverifiable location → Try again → Request exception → reason → visit proceeds | docs/12 §4, docs/17 §7.1, D-030 |
| `specs/caregiver/offline-capture.spec.ts` | Offline capture → honest queued indicator → replay on reconnect, no double clock | docs/12 §4 airplane-mode, docs/17 §7.6, D-022 |
| `specs/operations/exception-inbox.spec.ts` | Deterministic ranking + disposing a finding with a mandatory reason | docs/17 §7.2 §11, invariants 1 & 13 |
| `specs/operations/approve-hours.spec.ts` | Approve hours · self-approval refusal · blocked-by-critical-exception refusal | docs/17 §4.7, D-024, D-027 |
| `specs/operations/payroll-close-export.spec.ts` | Period open → close → export → content hash shown → re-run reproduces it | docs/17 §4.7 §7.2 |
| `specs/operations/location-attestation.spec.ts` | Geocode attestation records a named human | D-025, invariant 1 |
| `specs/settings/visit-policy-version.spec.ts` | Policy save appends a NEW VERSION; no control says "edit" | invariant 1, docs/17 §3.4 |
| `specs/a11y/axe-sweep.spec.ts` | axe (WCAG 2.0/2.1 A + AA) on every new route, zero serious/critical | docs/12 §4, docs/17 §12 |
| `specs/a11y/status-not-colour-alone.spec.ts` | Status is colour + icon + **label**, never colour alone | D-012 ratification condition |

The route list the a11y specs walk lives in `support/routes.ts`. Add a screen there and it
is swept the day it lands.

---

## Running them

```bash
# From apps/web — one-time browser download (~150 MB, needs network)
pnpm e2e:install

# Enumerate every spec without running anything. Needs no environment at all.
pnpm e2e:list

# Run everything. Without the variables below, every journey skips with its reason.
pnpm e2e

# Just the accessibility sweep
pnpm e2e:a11y

# Open the HTML report from the last CI-style run
pnpm e2e:report
```

By default Playwright starts the app itself with `next start` on port **3100** — a
production build, which is what a release gate should exercise (docs/12 §9), and a port
that deliberately avoids 3000 so it cannot quietly drive somebody's `next dev`. Build
first:

```bash
pnpm --filter @careos/web build
```

Or point at something already running, and Playwright will not start a server:

```bash
CAREOS_E2E_BASE_URL=https://careos-preview.example pnpm e2e
```

Or drive a dev server instead:

```bash
CAREOS_E2E_WEB_SERVER_CMD="pnpm exec next dev --port 3100" pnpm e2e
```

---

## Environment

Nothing here is read from a file in the repo. Supply it however your environment does —
`.env.local`, a shell export, CI secrets.

### The platform (without these, everything skips)

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | The Supabase project the app under test talks to |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Its anon key |

### The personas

Four roles, because the journeys prove things about permission boundaries that a single
superuser account would hide.

| Variable pair | Needs | Used by |
|---|---|---|
| `CAREOS_E2E_CAREGIVER_EMAIL` / `_PASSWORD` | A caregiver with visits on today's schedule | the three caregiver journeys, `/today` a11y |
| `CAREOS_E2E_COORDINATOR_EMAIL` / `_PASSWORD` | `visit.verify.read` **and** `visit.verify.act`, plus `evv.read` and `workforce.read` | exception inbox, board/attendance/EVV/workforce a11y |
| `CAREOS_E2E_PAYROLL_EMAIL` / `_PASSWORD` | `payroll.read`, `visit.approve`, `payroll.manage` | approvals, period close/export |
| `CAREOS_E2E_ADMIN_EMAIL` / `_PASSWORD` | `policy.manage` and `location.manage` | visit policy, place-of-care attestation |

### The self-approval refusal (D-027)

| Variable | What it is |
|---|---|
| `CAREOS_E2E_SELF_APPROVER_EMAIL` / `_PASSWORD` | A principal who **worked a shift** and also holds `visit.approve` |
| `CAREOS_E2E_SELF_APPROVER_NAME` | Their `app_user.full_name`, so the spec can find their own row in the queue |

Absent these, that one test skips and the rest of the approvals suite still runs.

### MFA

| Variable | What it is |
|---|---|
| `CAREOS_E2E_TOTP_SECRET` | The base32 TOTP secret seeded for the E2E personas |

**AAL2 is never bypassed.** Invariant 3 is enforced in Postgres by `app.is_aal2()`, and no
browser argues with it. The suite completes the genuine TOTP challenge using the app's own
RFC 6238 implementation (`src/lib/demo-totp.ts`) — the same code path the persona switcher
uses. A tenant running with `CAREOS_DEMO_MODE=true` elevates at sign-in on its own and the
suite never sees `/mfa`; either way the session that reads PHI is a verified one.

### Geographic anchors (the clock journeys)

| Variable | What it is |
|---|---|
| `CAREOS_E2E_INFENCE_LAT` / `_LNG` | A point **inside** the attested pin + radius of the caregiver's first visit |
| `CAREOS_E2E_FAR_LAT` / `_LNG` | Optional. A point outside it. Defaults to +0.75° on both axes — comfortably beyond even the `rural` tier's 750 m ceiling |

These are supplied rather than derived on purpose. Deriving them would mean reading the
pin, and a coordinate never leaves the database (D-030). They are Meadowbrook coordinates —
synthetic, like everything outside production (invariant 4).

---

## Seeding the tenant

The journeys need the synthetic Meadowbrook universe (docs/12 §7), plus these specific
states. Where one is missing, the affected test skips with a message saying exactly what to
seed rather than failing on an empty page.

1. **A caregiver with at least one visit today that has not been clocked in.** All three
   caregiver journeys start here.
2. **An attested service location** for that visit's client — a pin someone confirmed
   (D-025), with a geofence radius. Without the pin there is no arrival check and the
   in-fence journey has nothing to prove.
3. **At least one open finding** in `visit_exception`, and a coordinator holding
   `visit.verify.act`. A missing clock-out is the easiest to seed.
4. **A completed visit awaiting approval**, worked by somebody other than the payroll
   persona, inside an open pay period, with **no** unresolved critical exception.
5. **A second completed visit that does carry an unresolved critical exception**, for the
   payroll block.
6. **A completed visit worked by the self-approver persona**, awaiting approval.
7. **A visit policy at tenant scope**, so `/settings/visit-policy` has a chain to append to.

Prod-to-staging data flow is prohibited (docs/12 §7, invariant 4). Seed, never copy.

---

## Conventions

**Selectors are role- and label-first.** `getByRole("button", { name: "Clock in" })`, not a
class. The accessible names were read out of `src/lib/i18n/dictionaries.ts` and the page
source — not guessed. Where a card had to be isolated (a caregiver with four visits renders
four `Clock in` buttons), a structural `.card` or `article.card` scope is used and said so
in a comment. **No `data-testid` was added to the product.** A test hook is not an
improvement to a caregiver's screen.

**No PHI reaches a report.** Failures carry rule ids, CSS selectors, tag names and class
lists. Never axe's `html` snippet, never a chip's text, never a name. CI logs are forever
(invariant 5).

**One worker.** The journeys mutate shared agency state — a pay period, a policy chain, a
visit's clock ledger. Parallel workers racing one seeded tenant produce failures about the
harness rather than the product. Raise `workers` only alongside per-worker tenant isolation.

**The policy journey hands the rules back** by saving the original value again. That is not
cleanup, it is the same append a second time: both versions stay on the record, which is
the invariant the journey exists to prove.

---

## What this suite does not cover

- **The database's own guarantees.** Append-only, RLS, idempotent replay, the
  `evaluate_location` truth table, self-approval enforcement, sweep idempotence — all of it
  is pgTAP's, tested where it is enforced (docs/12 §3, migrations 0043–0052). A browser test
  that duplicated those would be slower, weaker and would drift.
- **The canary-PHI suite.** docs/17 §12 owes an assertion that a latitude never appears in
  `audit_event.payload`, a notification, an outbox row or an AI prompt. That is a data-layer
  grep, not a page.
- **Manual accessibility.** docs/12 §4 requires a screen-reader pass on the caregiver loop
  and the approvals inbox every release. Automated axe finds perhaps a third of what is
  wrong. This suite does not discharge that obligation and should not be cited as if it did.
- **Mobile.** docs/12 §4's device-farm suite (Maestro, mid-tier Android) is separate. The
  caregiver journeys here run in a Pixel 5 viewport in desktop Chromium, which is a useful
  approximation and not the same thing.
