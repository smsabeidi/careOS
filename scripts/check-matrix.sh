#!/usr/bin/env bash
# ST-110 · pgTAP matrix-manifest completeness gate
#
# matrix.yaml has always CLAIMED this script exists ("scripts/check-matrix.sh fails
# CI on any table missing from this file") — it did not, and the manifest had drifted
# to 14 entries against 25 tables. This is that gate, made real.
#
# Rules:
#   1. Every `create table (public|audit).x` in migrations has a matrix.yaml entry.
#   2. Every matrix.yaml entry corresponds to a real table (catches renames/typos).
#   3. Every entry declares `scope:` — tenant or global. 001_schema_invariants
#      asserts RLS enabled+forced but never asserts tenant_id presence, so without an
#      explicit scope a table missing tenant_id by ACCIDENT is indistinguishable from
#      a deliberate global catalog. This rule closes that hole (D-018).
#   4. Every table carrying an `app.forbid_mutation()` trigger is marked
#      `append_only: true`, and vice versa — the manifest cannot lie about immutability.
#   5. Every test file listed under `tests:` exists on disk.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MATRIX="supabase/tests/database/matrix.yaml"
MIGRATIONS="supabase/migrations"
TESTDIR="supabase/tests/database"
fail=0

if [ ! -f "$MATRIX" ]; then
  echo "CHECK-MATRIX FAIL: $MATRIX not found."
  exit 1
fi

tables=$(grep -hoE 'create table (public|audit)\.[a-z_]+' "$MIGRATIONS"/*.sql \
         | sed 's/create table //' | sort -u)
entries=$(grep -oE '^  (public|audit)\.[a-z_]+:' "$MATRIX" | tr -d ' :' | sort -u)

# --- Rule 1: no table missing from the manifest -----------------------------
for t in $tables; do
  if ! grep -qE "^  $t:" "$MATRIX"; then
    echo "CHECK-MATRIX FAIL: table $t has no entry in $MATRIX."
    fail=1
  fi
done

# --- Rule 2: no manifest entry without a table ------------------------------
for e in $entries; do
  if ! echo "$tables" | grep -qx "$e"; then
    echo "CHECK-MATRIX FAIL: $MATRIX lists $e but no migration creates it."
    fail=1
  fi
done

# --- Rule 3: every entry declares scope -------------------------------------
for t in $tables; do
  line=$(grep -E "^  $t:" "$MATRIX" || true)
  [ -z "$line" ] && continue   # already reported by Rule 1
  if ! echo "$line" | grep -qE 'scope: *(tenant|global)'; then
    echo "CHECK-MATRIX FAIL: $t has no 'scope: tenant|global' in $MATRIX."
    echo "                   Declare it explicitly — a missing tenant_id must never"
    echo "                   be mistaken for a deliberate global catalog (D-018)."
    fail=1
  fi
done

# --- Rule 4: append_only claims match the actual triggers -------------------
# The statement is matched on a WHITESPACE-NORMALISED stream, not line by line. A trigger
# like `trg_visit_exception_disposition_ao before update or delete on
# public.visit_exception_disposition` is 95 characters and cannot be written on one line
# without breaking the repo's ~88-column wrap convention, so a line-oriented grep silently
# scored a correctly-guarded table as unguarded — a false PASS direction on an invariant-1
# check, which is the worst way for this gate to be wrong.
ao_tables=$(cat "$MIGRATIONS"/*.sql | tr '\n' ' ' | tr -s ' ' \
            | grep -oE 'create trigger [a-z_]+ before update or delete on (public|audit)\.[a-z_]+' \
            | sed -E 's/.* on //' | sort -u)
for t in $ao_tables; do
  line=$(grep -E "^  $t:" "$MATRIX" || true)
  [ -z "$line" ] && continue
  if ! echo "$line" | grep -q 'append_only: true'; then
    echo "CHECK-MATRIX FAIL: $t has a forbid_mutation trigger but is not marked"
    echo "                   'append_only: true' in $MATRIX."
    fail=1
  fi
done
for t in $(grep -E '^  (public|audit)\.[a-z_]+:.*append_only: true' "$MATRIX" \
           | grep -oE '^  (public|audit)\.[a-z_]+' | tr -d ' '); do
  if ! echo "$ao_tables" | grep -qx "$t"; then
    echo "CHECK-MATRIX FAIL: $MATRIX marks $t append_only but no migration attaches"
    echo "                   a 'before update or delete' trigger to it."
    fail=1
  fi
done

# --- Rule 5: listed test files exist ----------------------------------------
# Take the whole list item after "- ", not a regex substring of it: the old pattern
# extracted `0037_actuator.sql` out of the real file `0036_0037_actuator.sql` (one test
# file covering two migrations) and then failed because that name does not exist.
for f in $(sed -n '/^tests:/,$p' "$MATRIX" | sed -nE 's/^[[:space:]]*-[[:space:]]+([A-Za-z0-9_.]+\.sql)[[:space:]]*$/\1/p'); do
  if [ ! -f "$TESTDIR/$f" ]; then
    echo "CHECK-MATRIX FAIL: $MATRIX lists test $f but $TESTDIR/$f does not exist."
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "CHECK-MATRIX PASS ($(echo "$tables" | wc -l | tr -d ' ') tables covered)"
fi
exit "$fail"
