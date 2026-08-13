import Link from "next/link";
import fs from "node:fs";
import path from "node:path";
import { Badge, DataTable, EmptyState, ErrorState, MetricTile, SectionTitle } from "@/components/ui";
import { IconAlert, IconCheck, IconLock, IconShield } from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The "Show me" enforcement panel (ST-242, Front Door W8).
 *
 * The claim this panel makes is narrow and checkable: everything on it is read from the
 * RUNNING database at the moment the page loads. Policy counts come from `pg_policies`,
 * append-only coverage from the real `forbid_mutation` triggers, the audit chain from
 * re-verification by recomputation, and the AI registry exactly as governed — via one
 * definer RPC (`app.evidence_summary`, migration 0056) whose output is counts, object
 * names and enum values only. No tenant row, no person, no PHI can appear here by
 * construction.
 *
 * The one thing the panel reads from the repo instead of the database is `db/policies.md`
 * — the COMMITTED policy catalog — precisely so the two can disagree in public. Drift on
 * an evidence screen is the one unacceptable outcome (design review CL3), so a mismatch
 * renders as a visible amber warning and an unreadable catalog says so out loud. Nothing
 * about this cross-check is ever silent.
 *
 * There is no feature flag on this surface: it is read-only evidence, and access is
 * enforced where access is always enforced — in Postgres. The RPC refuses without AAL2
 * and `audit.read`, and those refusals render as the standard denied states below.
 */

/* ── The RPC's return shape (0056: counts, names and enums only) ─────────────── */

type AiCapabilityRow = {
  key: string;
  tier: string;
  requires_human: boolean;
  enabled: boolean;
  monthly_budget_usd: number | string | null;
  has_active_prompt: boolean;
};

type FeatureFlagRow = {
  key: string;
  enabled: boolean;
  disabled_reason: string | null;
};

type EvidenceSummary = {
  ok: boolean;
  generated_at: string;
  rls: {
    tables_with_rls: number;
    tables_forced: number;
    tables_total: number;
    policy_count: number;
    policies_by_table: Record<string, number>;
  };
  append_only_tables: number;
  audit_chain: Record<string, unknown> | null;
  ai_capabilities: AiCapabilityRow[];
  tier_constraint: string | null;
  feature_flags: FeatureFlagRow[];
};

/* ── The committed catalog (db/policies.md), read from the repo at render time ──
 * process.cwd() is `apps/web` under `next dev`/`next start` and the repo root in CI, so
 * the root is found by walking upward until `db/policies.md` exists. A deployment that
 * did not bundle the file gets an honest "the check did not run" — never a silent pass. */

type CatalogCheck =
  | { state: "match"; committed: number }
  | { state: "mismatch"; committed: number }
  | { state: "unreadable" };

function committedPolicyCount(): number | null {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const text = fs.readFileSync(path.join(dir, "db", "policies.md"), "utf8");
      // The generated header reads: `104` policies across `69` tables.
      const match = /`(\d+)`\s+policies across/.exec(text);
      return match ? Number.parseInt(match[1], 10) : null;
    } catch {
      // Not at this level — keep walking toward the filesystem root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function crossCheck(livePolicyCount: number): CatalogCheck {
  const committed = committedPolicyCount();
  if (committed === null) return { state: "unreadable" };
  return committed === livePolicyCount
    ? { state: "match", committed }
    : { state: "mismatch", committed };
}

/* ── Small render helpers ────────────────────────────────────────────────────── */

function budgetLabel(value: number | string | null): string {
  if (value === null || value === undefined) return "No cap set";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `$${n.toFixed(2)} / month`;
}

/** `ok: true` is the only verified outcome; anything else renders as not verified. */
function chainVerified(chain: Record<string, unknown> | null): boolean {
  if (!chain) return false;
  if (chain.ok === true) return true;
  // Older or future shapes may say `intact` instead of `ok`; only when `ok` is absent.
  return chain.ok === undefined && chain.intact === true;
}

/* ── The panel ───────────────────────────────────────────────────────────────── */

export async function EnforcementPanel() {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.schema("app").rpc("evidence_summary");

  const heading = (
    <SectionTitle icon={<IconShield />}>Enforcement — live from the database</SectionTitle>
  );

  // ── Refused or failed: say which, in words that name the next step ──────────
  if (error || !data) {
    const message = error?.message ?? "";
    if (message.includes("CAREOS_FORBIDDEN")) {
      return (
        <section aria-label="Live enforcement summary">
          {heading}
          <EmptyState
            icon={<IconShield />}
            title="This section needs the audit permission"
            body="The live enforcement summary is read through a guarded database function that requires the audit.read permission, and the database refused this account. Nothing here loaded and nothing was changed. If reading enforcement evidence is part of your role, ask an owner to grant it."
          />
        </section>
      );
    }
    if (message.includes("CAREOS_AAL2_REQUIRED")) {
      return (
        <section aria-label="Live enforcement summary">
          {heading}
          <EmptyState
            icon={<IconLock />}
            title="Verify your session to see the live summary"
            body="This summary re-verifies the audit chain, which opens only to an MFA-verified session. Verify with your authenticator and it loads. Nothing was changed."
            action={
              <Link href="/mfa" className="btn btn-primary btn-sm">
                Verify session
              </Link>
            }
          />
        </section>
      );
    }
    return (
      <section aria-label="Live enforcement summary">
        {heading}
        <ErrorState
          title="Couldn't read the live summary"
          body="The database function that assembles this summary didn't answer. Nothing in this section is cached, so refresh to ask the database again. The packet tools above are unaffected."
        />
      </section>
    );
  }

  const summary = data as EvidenceSummary;
  const chain = summary.audit_chain ?? null;
  const verified = chainVerified(chain);
  const catalog = crossCheck(summary.rls.policy_count);

  return (
    <section aria-label="Live enforcement summary" className="flex flex-col gap-6">
      <div>
        {heading}
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Everything below is read from the running database at the moment this page loads:
          the policy catalog from <code className="text-[12px]">pg_policies</code>, append-only
          coverage from the real triggers, the audit chain re-verified by recomputation, and
          the AI registry exactly as governed. None of it is a screenshot or a claim from a
          document.
        </p>
      </div>

      {/* ── Headline tiles ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile
          label="Tables under forced RLS"
          value={`${summary.rls.tables_forced} of ${summary.rls.tables_total}`}
          hint={`${summary.rls.tables_with_rls} have row security enabled`}
        />
        <MetricTile
          label="Policies in force"
          value={summary.rls.policy_count}
          hint="Counted live from pg_policies"
        />
        <MetricTile
          label="Append-only tables"
          value={summary.append_only_tables}
          hint="A trigger refuses UPDATE and DELETE"
        />
        <MetricTile
          label="Audit chain"
          value={verified ? "Intact" : "Not verified"}
          tone={verified ? "success" : "danger"}
          hint={
            verified
              ? "Re-verified by recomputation just now"
              : "Verification did not pass — details below"
          }
        />
      </div>

      {/* ── The chain result, honestly: a red banner with the raw verdict ───── */}
      {!verified && (
        <div
          className="card px-6 py-5"
          role="alert"
          style={{ borderColor: "var(--color-danger-700)" }}
        >
          <p
            className="flex items-center gap-2 text-[15px] font-semibold"
            style={{ color: "var(--color-danger-700)" }}
          >
            <IconAlert width={16} height={16} className="shrink-0" />
            The audit chain did not verify
          </p>
          <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            The database recomputed the hash chain for this tenant and could not confirm it end
            to end. This is the verifier&rsquo;s raw answer, unedited — it identifies rows by
            number only. Treat it as an incident: nothing on this page can explain it away.
          </p>
          <pre
            className="card-inset mt-3 overflow-x-auto px-4 py-3 text-[12px] leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {JSON.stringify(chain, null, 2)}
          </pre>
        </div>
      )}

      {/* ── AI governance, exactly as registered ────────────────────────────── */}
      <div>
        <SectionTitle icon={<IconLock />}>AI capabilities, exactly as governed</SectionTitle>
        <DataTable
          caption="AI capability registry: tier, human requirement, kill switch, budget and prompt state"
          columns={[
            { header: "Capability" },
            { header: "Tier" },
            { header: "Human disposer" },
            { header: "Kill switch" },
            { header: "Monthly budget", align: "right" },
            { header: "Prompt" },
          ]}
          rows={summary.ai_capabilities.map((c) => ({
            key: c.key,
            cells: [
              <code key="k" className="text-[13px] font-medium">
                {c.key}
              </code>,
              <Badge key="t" tone="neutral">
                {c.tier}
              </Badge>,
              c.requires_human ? (
                <Badge key="h" tone="accent">
                  Required
                </Badge>
              ) : (
                <Badge key="h" tone="neutral">
                  Advisory only
                </Badge>
              ),
              c.enabled ? (
                <Badge key="s" tone="success" icon={<IconCheck />}>
                  On
                </Badge>
              ) : (
                <Badge key="s" tone="neutral">
                  Off
                </Badge>
              ),
              <span key="b" className="tabular text-[13px]">
                {budgetLabel(c.monthly_budget_usd)}
              </span>,
              c.has_active_prompt ? (
                <Badge key="p" tone="success" icon={<IconCheck />}>
                  Active prompt
                </Badge>
              ) : (
                <Badge key="p" tone="warning" icon={<IconAlert />}>
                  No active prompt
                </Badge>
              ),
            ],
          }))}
          empty={
            <div className="card px-6 py-8 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
              No AI capabilities are registered for this tenant. The registry is the only place a
              capability can exist, so none can run.
            </div>
          }
        />

        {summary.tier_constraint ? (
          <div className="card-inset mt-3 px-4 py-3">
            <code className="block overflow-x-auto whitespace-pre text-[12px] leading-relaxed">
              {summary.tier_constraint}
            </code>
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              The database refuses a T2 capability without a human disposer — this is the
              constraint, live from the catalog.
            </p>
          </div>
        ) : (
          <p
            className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed"
            role="alert"
            style={{ color: "var(--color-warning-700)" }}
          >
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" />
            The tier constraint was not found in the catalog. That constraint is what makes a
            T2 capability without a human disposer unrepresentable — its absence is a finding,
            not a formatting problem.
          </p>
        )}
      </div>

      {/* ── Feature flags with their stated reasons ─────────────────────────── */}
      <div>
        <SectionTitle icon={<IconCheck />}>Feature flags</SectionTitle>
        <DataTable
          caption="Feature flags for this tenant, with the reason each disabled one is off"
          columns={[{ header: "Flag" }, { header: "State" }, { header: "Reason" }]}
          rows={summary.feature_flags.map((f) => ({
            key: f.key,
            cells: [
              <code key="k" className="text-[13px] font-medium">
                {f.key}
              </code>,
              f.enabled ? (
                <Badge key="s" tone="success" icon={<IconCheck />}>
                  On
                </Badge>
              ) : (
                <Badge key="s" tone="neutral">
                  Off
                </Badge>
              ),
              <span key="r" className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {f.enabled ? "—" : (f.disabled_reason ?? "No reason recorded")}
              </span>,
            ],
          }))}
          empty={
            <div className="card px-6 py-8 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
              No feature flags exist for this tenant yet.
            </div>
          }
        />
      </div>

      {/* ── Committed catalog vs live database — never silent ───────────────── */}
      {catalog.state === "match" ? (
        <p
          className="card flex items-start gap-2 px-5 py-4 text-[13px] leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          <IconCheck
            width={15}
            height={15}
            className="mt-0.5 shrink-0"
            style={{ color: "var(--color-success-700)" }}
          />
          The committed catalog and the live database agree: {catalog.committed} policies. The
          repo&rsquo;s db/policies.md is current with what Postgres enforces right now.
        </p>
      ) : catalog.state === "mismatch" ? (
        <div
          className="card px-5 py-4"
          role="alert"
          style={{ background: "var(--color-warning-50)", borderColor: "var(--chip-warning-border)" }}
        >
          <p
            className="flex items-start gap-2 text-[14px] font-semibold"
            style={{ color: "var(--color-warning-700)" }}
          >
            <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
            The committed catalog and the live database disagree — regenerate db/policies.md.
          </p>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--color-warning-700)" }}>
            The committed catalog records {catalog.committed} policies; the live database
            enforces {summary.rls.policy_count} right now. The live number above is the real
            one — the artifact is behind. Run <code className="text-[12px]">bash scripts/gen-policies.sh</code>{" "}
            against the migrated database and commit the result.
          </p>
        </div>
      ) : (
        <div
          className="card px-5 py-4"
          role="alert"
          style={{ background: "var(--color-warning-50)", borderColor: "var(--chip-warning-border)" }}
        >
          <p
            className="flex items-start gap-2 text-[14px] font-semibold"
            style={{ color: "var(--color-warning-700)" }}
          >
            <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
            The committed catalog couldn&rsquo;t be read, so the cross-check did not run.
          </p>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--color-warning-700)" }}>
            db/policies.md was not found in this deployment&rsquo;s files. The live counts above
            are still real — they come from the database — but the live-vs-committed comparison
            is one of this screen&rsquo;s claims, so its absence is stated rather than skipped.
          </p>
        </div>
      )}

      <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Summary read{" "}
        {new Date(summary.generated_at).toLocaleString(undefined, {
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
        , under this account&rsquo;s own session. The reading function returns counts, database
        object names and enum values only — no client, staff or note content can appear on this
        panel by construction.
      </p>
    </section>
  );
}
