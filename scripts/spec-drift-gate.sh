#!/usr/bin/env bash
# ST-103 (E4) · Spec-corpus drift gate — D-010
# 1. Any commit touching db/ or supabase/migrations must cite a story (ST-nnn) or
#    decision (D-nnn) in its message.
# 2. Every decision ID cited inside a migration file must exist in the decision
#    log (docs/00 §3).
# Runs in CI over the pushed range; locally over HEAD.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RANGE="${1:-HEAD~1..HEAD}"
if ! git rev-parse "${RANGE%%..*}" >/dev/null 2>&1; then
  RANGE="HEAD"  # shallow clone / first commit
fi

fail=0

# --- Rule 1: story/decision citation on migration-touching commits -----------
for c in $(git rev-list "$RANGE" 2>/dev/null || git rev-list -1 HEAD); do
  files=$(git diff-tree --no-commit-id --name-only -r "$c")
  if echo "$files" | grep -qE '^(db/|supabase/migrations/)'; then
    msg=$(git log -1 --format=%B "$c")
    if ! echo "$msg" | grep -qE '(ST-[0-9]+|D-[0-9]{3})'; then
      echo "DRIFT-GATE FAIL: commit $c touches migrations without citing a story (ST-nnn) or decision (D-nnn)."
      fail=1
    fi
  fi
done

# --- Rule 2: decision IDs cited in migrations must exist in docs/00 ----------
DECISION_LOG="docs/00_CareOS_Master_Index_and_Decision_Log.md"
if [ -f "$DECISION_LOG" ]; then
  cited=$(grep -rhoE 'D-[0-9]{3}' supabase/migrations/ 2>/dev/null | sort -u || true)
  for d in $cited; do
    if ! grep -q "$d" "$DECISION_LOG"; then
      echo "DRIFT-GATE FAIL: migration cites $d but $d is not in the decision log ($DECISION_LOG)."
      fail=1
    fi
  done
else
  echo "DRIFT-GATE WARN: $DECISION_LOG not found; decision-ID check skipped."
fi

# --- Rule 3: every table appears in the pgTAP matrix manifest ----------------
MATRIX="supabase/tests/database/matrix.yaml"
if [ -f "$MATRIX" ]; then
  tables=$(grep -hoE 'create table (public|audit)\.[a-z_]+' supabase/migrations/*.sql \
           | sed 's/create table //' | sort -u)
  for t in $tables; do
    if ! grep -q "$t:" "$MATRIX"; then
      echo "DRIFT-GATE FAIL: table $t has no entry in $MATRIX (pgTAP matrix coverage is mandatory)."
      fail=1
    fi
  done
fi

if [ "$fail" -eq 0 ]; then
  echo "DRIFT-GATE PASS"
fi
exit "$fail"
