#!/usr/bin/env bash
# careOS · db/policies.md generator — the RLS catalog, introspected from a live database
# =============================================================================
# docs/07 §11 has claimed since v1.0 that "the catalog is generated into
# db/policies.md from the migrations so the documented and deployed policy sets
# cannot drift — drift fails the build", and CLAUDE.md forbids hand-editing
# db/policies.md "except through their generators". Neither the file nor the
# generator existed: the claim guarded nothing, and the one number it published
# (63 policies) was stale by dozens.
#
# This is that generator. It reads pg_policies from a REAL database — after the
# migration chain has been applied — rather than grepping SQL, because what
# matters is the policy set Postgres actually enforces, not the statements that
# appear in migration text. `create policy` counts lie: 0023 drops four policies
# it did not create, and a grep cannot see that.
#
#   bash scripts/gen-policies.sh            # write db/policies.md
#   bash scripts/gen-policies.sh --check    # fail if the committed file has drifted
#
# Connection: defaults to the Docker-free local harness (scripts/local-pg). Set
# CAREOS_PSQL to override with any psql invocation, e.g. in CI:
#   CAREOS_PSQL="psql postgresql://postgres:postgres@localhost:54322/postgres"
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/db/policies.md"
PGBIN="${CAREOS_PGBIN:-/Applications/Postgres.app/Contents/Versions/18/bin}"
PG_ROOT="${CAREOS_PG_ROOT:-${TMPDIR:-/tmp}/careos-local-pg}"
DEFAULT_PSQL="$PGBIN/psql -h 127.0.0.1 -p 55433 -U postgres -d careos"
PSQL="${CAREOS_PSQL:-$DEFAULT_PSQL}"

mode="${1:-write}"

if ! $PSQL -tAc 'select 1' >/dev/null 2>&1; then
  echo "GEN-POLICIES FAIL: no database reachable."
  echo "  Local:  bash scripts/local-pg/harness.sh start && bash scripts/local-pg/harness.sh reset"
  echo "  Or set CAREOS_PSQL to a psql invocation against a migrated database."
  exit 1
fi

# One row per policy. Ordered deterministically so the file is stable across runs
# and a diff means a real change, never a planner mood.
read -r -d '' QUERY <<'SQL' || true
select
  p.schemaname || '.' || p.tablename                                      as tbl,
  p.policyname                                                            as pol,
  p.cmd                                                                   as cmd,
  coalesce(array_to_string(p.roles, ', '), '-')                           as roles,
  case when p.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end as kind,
  coalesce(replace(replace(p.qual, E'\n', ' '), '  ', ' '), '-')          as using_expr,
  coalesce(replace(replace(p.with_check, E'\n', ' '), '  ', ' '), '-')    as check_expr
from pg_policies p
where p.schemaname in ('public', 'audit')
order by p.schemaname, p.tablename, p.policyname;
SQL

rows="$($PSQL -tAF $'\t' -c "$QUERY")"
total="$(printf '%s\n' "$rows" | grep -c . || true)"
tables="$(printf '%s\n' "$rows" | cut -f1 | sort -u | grep -c . || true)"

# Tables with RLS enabled but ZERO policies. Deny-by-default is a legitimate and
# common posture here (definer-only tables), so this is an inventory, not an
# error — but it must be visible, because "no policy" and "policy I forgot to
# write" look identical from the outside.
nopol="$($PSQL -tAc "
  select c.relnamespace::regnamespace || '.' || c.relname
    from pg_class c
   where c.relkind = 'r'
     and c.relnamespace::regnamespace::text in ('public','audit')
     and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname = c.relnamespace::regnamespace::text
                        and p.tablename = c.relname)
   order by 1;")"
nopol_count="$(printf '%s\n' "$nopol" | grep -c . || true)"

tmp="$(mktemp)"
{
  echo "# CareOS — RLS policy catalog"
  echo
  echo "**GENERATED FILE — do not edit by hand.** Regenerate with \`bash scripts/gen-policies.sh\`."
  echo "Introspected from \`pg_policies\` on a database with the full migration chain applied,"
  echo "so this is the policy set Postgres *enforces*, not the one the migration text implies."
  echo
  echo "\`$total\` policies across \`$tables\` tables. \`$nopol_count\` further RLS-enabled tables"
  echo "carry no policy at all and are therefore deny-by-default (listed at the end)."
  echo
  echo "RLS is the perimeter (invariant 2): app code is convenience, Postgres authorizes."
  echo "Every PHI policy must carry \`app.is_aal2()\` (invariant 3) and pin"
  echo "\`tenant_id = app.current_tenant_id()\` as a top-level conjunct."
  echo

  current=""
  while IFS=$'\t' read -r tbl pol cmd roles kind using_expr check_expr; do
    [ -z "${tbl:-}" ] && continue
    if [ "$tbl" != "$current" ]; then
      [ -n "$current" ] && echo
      echo "## $tbl"
      echo
      current="$tbl"
    fi
    echo "### \`$pol\`"
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| operation | \`$cmd\` |"
    echo "| roles | \`$roles\` |"
    echo "| kind | $kind |"
    echo "| USING | \`$using_expr\` |"
    echo "| WITH CHECK | \`$check_expr\` |"
    echo
  done <<< "$rows"

  if [ "$nopol_count" -gt 0 ]; then
    echo "## Deny-by-default tables (RLS enabled, no policy)"
    echo
    echo "Reachable only through \`security definer\` functions. A table appearing here by"
    echo "accident rather than by design is a bug — the matrix manifest records the intent."
    echo
    printf '%s\n' "$nopol" | while read -r t; do [ -n "$t" ] && echo "- \`$t\`"; done
  fi
} > "$tmp"

if [ "$mode" = "--check" ]; then
  if [ ! -f "$OUT" ]; then
    echo "GEN-POLICIES FAIL: $OUT does not exist. Run: bash scripts/gen-policies.sh"
    rm -f "$tmp"; exit 1
  fi
  if ! diff -q "$OUT" "$tmp" >/dev/null; then
    echo "GEN-POLICIES FAIL: db/policies.md has drifted from the deployed policy set."
    echo "  The documented and enforced policies disagree. Regenerate and review the diff:"
    echo "    bash scripts/gen-policies.sh"
    diff "$OUT" "$tmp" | head -40 || true
    rm -f "$tmp"; exit 1
  fi
  rm -f "$tmp"
  echo "GEN-POLICIES PASS ($total policies across $tables tables; no drift)"
else
  mv "$tmp" "$OUT"
  echo "GEN-POLICIES PASS (wrote db/policies.md — $total policies across $tables tables, plus $nopol_count deny-by-default)"
fi
