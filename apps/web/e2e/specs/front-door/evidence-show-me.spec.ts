/**
 * JOURNEY — the "Show me" enforcement panel proves its claims live, and its one
 * cross-check is never silent (ST-242, Front Door W8).
 *
 * ⚠ NEVER EXECUTED. Specified and wired against the real page source; not proven.
 * See apps/web/e2e/README.md.
 *
 * WHAT THIS PROVES (docs/designs/intelligent-front-door.md W8, invariant 2, D-012):
 *   1. THE PANEL IS LIVE, NOT A CLAIM. /office/evidence renders counts read from the
 *      running database — tables under forced RLS as "x of y", the policy total from
 *      pg_policies, append-only coverage from real triggers — and the AI registry with
 *      the tier CHECK constraint quoted verbatim from the catalog. A surveyor is shown
 *      the enforcement, not a slide about it.
 *   2. THE CHAIN VERDICT IS CONSISTENT AND IN WORDS (D-012). The audit-chain tile says
 *      "Intact" or "Not verified" — words, never a colour alone — and the red banner
 *      with the verifier's raw answer appears exactly when the tile does NOT say Intact.
 *      A tile claiming intact above a banner claiming broken would be the screen lying
 *      in one direction or the other.
 *   3. THE CROSS-CHECK IS NEVER SILENT (review finding CL3). The committed db/policies.md
 *      is compared against the live policy count on every load, and exactly one of three
 *      sentences renders: they agree, they disagree (amber, naming the regeneration
 *      command), or the catalog couldn't be read (amber, saying the check did not run).
 *      Silence — no sentence at all — is the one unacceptable outcome, and it fails here.
 *
 * The admin persona is the reader: `admin` holds audit.read (0026), so the guarded RPC
 * answers. There is deliberately no feature flag on this surface — access is enforced by
 * Postgres, and this journey rides that enforcement rather than any client-side gate.
 */

import { expect, test } from "@playwright/test";
import { skipReason, unavailable } from "../../support/env";
import { signIn, gotoVerified } from "../../support/session";

const REQUIREMENT = { personas: ["admin" as const] };

test.describe("Front Door · evidence — the Show me enforcement panel", () => {
  test.skip(unavailable(REQUIREMENT), skipReason(REQUIREMENT));

  test.beforeEach(async ({ page }) => {
    await signIn(page, "admin");
    await gotoVerified(page, "/office/evidence");
    await expect(page.getByRole("heading", { name: "Evidence", level: 1 })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Enforcement — live from the database/ }),
      "The enforcement panel must render for a reader who holds audit.read — it has no " +
        "feature flag by design, so its absence means the RPC refused or the page broke."
    ).toBeVisible();
  });

  test("renders live enforcement counts in words, with the tier constraint quoted from the catalog", async ({
    page,
  }) => {
    /* ── Headline tiles: values with words, never a bare colour ─────────────── */
    const forced = page.locator("div.card").filter({ hasText: "Tables under forced RLS" }).first();
    await expect(
      forced,
      "Forced-RLS coverage renders as 'x of y' — a checkable fraction, not a vibe."
    ).toContainText(/\d+ of \d+/);

    const policies = page.locator("div.card").filter({ hasText: "Policies in force" }).first();
    await expect(
      policies,
      "The policy total is a live number from pg_policies."
    ).toContainText(/\d/);

    await expect(
      page.locator("div.card").filter({ hasText: "Append-only tables" }).first(),
      "Append-only coverage is counted from the real forbid_mutation triggers."
    ).toContainText(/\d/);

    /* ── The chain verdict: words, and internally consistent (D-012) ────────── */
    const chainTile = page.locator("div.card").filter({ hasText: "Audit chain" }).first();
    const verdict = await chainTile.innerText();
    expect(
      /Intact|Not verified/.test(verdict),
      "The audit-chain tile must carry its verdict in words — 'Intact' or 'Not verified' — " +
        "never a colour alone."
    ).toBe(true);

    const banner = page.getByText("The audit chain did not verify");
    if (/Intact/.test(verdict)) {
      await expect(
        banner,
        "A tile saying Intact above a banner saying broken would be the screen contradicting " +
          "itself; the banner exists only when verification did not pass."
      ).toHaveCount(0);
    } else {
      await expect(
        banner,
        "When the tile does not say Intact, the verifier's raw answer must be shown — a red " +
          "banner with the unedited jsonb, treated as an incident."
      ).toBeVisible();
    }

    /* ── The AI registry, exactly as governed ───────────────────────────────── */
    const registry = page.getByRole("region", {
      name: /AI capability registry/,
    });
    await expect(registry).toBeVisible();
    expect(
      await registry.locator("tbody tr").count(),
      "A seeded tenant carries a governed registry (0052 + 0057). An empty table here means " +
        "the seed or the registration migrations regressed."
    ).toBeGreaterThan(0);

    /* ── The structural claim, quoted live from the catalog ─────────────────── */
    await expect(
      page.locator("code", { hasText: "requires_human" }).first(),
      "The tier CHECK constraint is quoted verbatim from pg_constraint — the panel shows the " +
        "enforcement itself, not a paraphrase of it."
    ).toBeVisible();
    await expect(
      page.getByText(/this is the constraint, live from the catalog/),
      "The constraint carries its plain-language caption, so a non-engineer knows what the " +
        "SQL in front of them refuses."
    ).toBeVisible();

    /* ── Feature flags with reasons ─────────────────────────────────────────── */
    await expect(page.getByRole("heading", { name: "Feature flags" })).toBeVisible();
  });

  test("the committed-vs-live cross-check always says something", async ({ page }) => {
    const agree = page.getByText(/committed catalog and the live database agree/);
    const disagree = page.getByText(/committed catalog and the live database disagree/);
    const unreadable = page.getByText(/committed catalog couldn.t be read/);

    const states = [await agree.count(), await disagree.count(), await unreadable.count()];
    expect(
      states.filter((n) => n > 0).length,
      "Exactly one cross-check sentence must render: agreement, an amber mismatch warning, " +
        "or an amber 'the check did not run'. Zero sentences is drift hidden on an evidence " +
        "screen — the one unacceptable outcome (CL3)."
    ).toBe(1);

    if ((await disagree.count()) > 0) {
      await expect(
        page.getByText(/regenerate db\/policies\.md/),
        "The mismatch warning must name the fix, not just the fact: regenerate the committed " +
          "catalog against the migrated database."
      ).toBeVisible();
      // Amber is the tone, but the words carry the status (D-012): the warning is an alert
      // region whose text names both numbers' source of truth.
      await expect(disagree.first()).toBeVisible();
    }
  });
});
