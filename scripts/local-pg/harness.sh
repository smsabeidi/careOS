#!/usr/bin/env bash
# careOS · local-pg harness — a Docker-free Postgres for the migration chain + pgTAP
# ==============================================================================
# Docker on this machine is an x86_64 binary with no Rosetta, so `supabase db
# start` / `supabase test db` cannot run. This script drives a private
# Postgres.app 18 cluster instead, bootstrapped with a Supabase-compatible shim
# (bootstrap.sql) so the unmodified migration chain and pgTAP suite both apply.
#
#   bash scripts/local-pg/harness.sh init     # build pgTAP, initdb, configure, start
#   bash scripts/local-pg/harness.sh start    # start an already-initialised cluster
#   bash scripts/local-pg/harness.sh stop     # stop it
#   bash scripts/local-pg/harness.sh status   # is it up? what's applied?
#   bash scripts/local-pg/harness.sh reset    # drop+recreate db, bootstrap + all migrations
#   bash scripts/local-pg/harness.sh seed     # apply supabase/seed.sql + supabase/seeds/*.sql
#   bash scripts/local-pg/harness.sh test     # run every supabase/tests/database/*.sql
#   bash scripts/local-pg/harness.sh psql     # interactive shell (extra args passed through)
#   bash scripts/local-pg/harness.sh nuke     # stop + delete the cluster entirely
#
# Every command is idempotent and safe to re-run. See README.md for the
# fidelity gaps between this and a real Supabase stack.
# ==============================================================================
set -euo pipefail

# ── Paths & configuration ─────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="$REPO_ROOT/scripts/local-pg"

# Postgres.app 18 (native arm64). Override with CAREOS_PGBIN if installed elsewhere.
PGBIN="${CAREOS_PGBIN:-/Applications/Postgres.app/Contents/Versions/18/bin}"

# Cluster state lives OUTSIDE the repo. Override with CAREOS_PG_ROOT.
PG_ROOT="${CAREOS_PG_ROOT:-${TMPDIR:-/tmp}/careos-local-pg}"
PGDATA="$PG_ROOT/pgdata"
BUILD_DIR="$PG_ROOT/build"
EXT_DIR="$PG_ROOT/ext"            # pgTAP is staged here (generated, ~500KB — not committed)
REPO_EXT_DIR="$HARNESS_DIR/ext"   # committed marker .control files for pgmq/pg_cron/pg_net
LOG_DIR="$PG_ROOT/log"

# The unix socket path must stay under ~103 bytes, which rules out most TMPDIRs
# on macOS. TCP on 127.0.0.1 is what we actually connect over; this is only for
# postmaster startup.
SOCKET_DIR="${CAREOS_PG_SOCKET_DIR:-/tmp/careos-lpg}"

PGPORT="${CAREOS_PG_PORT:-55433}"
PGHOST=127.0.0.1
PGUSER="${CAREOS_PG_SUPERUSER:-postgres}"
DBNAME="${CAREOS_PG_DB:-careos}"

PGTAP_VERSION="${CAREOS_PGTAP_VERSION:-v1.3.3}"
PGTAP_REPO="https://github.com/theory/pgtap"

MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
TESTS_DIR="$REPO_ROOT/supabase/tests/database"
SEED_FILE="$REPO_ROOT/supabase/seed.sql"
SEEDS_DIR="$REPO_ROOT/supabase/seeds"

export PGHOST PGPORT PGUSER

# ── Output helpers ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_OK=; C_ERR=; C_DIM=; C_B=; C_0=
fi
say()  { printf '%s\n' "$*" >&2; }
step() { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*" >&2; }
ok()   { printf '%s  ok%s %s\n' "$C_OK" "$C_0" "$*" >&2; }
err()  { printf '%sFAIL%s %s\n' "$C_ERR" "$C_0" "$*" >&2; }
die()  { err "$*"; exit 1; }

psql_bin()   { "$PGBIN/psql" "$@"; }
psql_db()    { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -d "$DBNAME" "$@"; }
psql_maint() { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -d postgres "$@"; }

require_bins() {
  [[ -x "$PGBIN/postgres" ]] || die "Postgres.app 18 not found at $PGBIN (set CAREOS_PGBIN)"
  local v; v="$("$PGBIN/pg_config" --version)"
  case "$v" in
    "PostgreSQL 18"*) : ;;
    *) say "${C_DIM}note: expected PostgreSQL 18, found: $v${C_0}" ;;
  esac
}

is_running() {
  "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

require_running() {
  is_running || die "cluster is not running — run: bash scripts/local-pg/harness.sh start"
}

# ── pgTAP ─────────────────────────────────────────────────────────────────────
# pgTAP is pure SQL, so it needs no compiled module — but the extension directory
# inside /Applications/Postgres.app is NOT writable (App Translocation / bundle
# protection) and this harness must not use sudo. PostgreSQL 18's
# `extension_control_path` GUC solves it: we `make` pgTAP (which only generates
# SQL), copy the .control + .sql artefacts into a user-writable directory, and
# point the cluster at it.
install_pgtap() {
  if [[ -f "$EXT_DIR/extension/pgtap.control" ]]; then
    ok "pgTAP already staged in $EXT_DIR/extension"
    return
  fi
  step "building pgTAP $PGTAP_VERSION (pure SQL — no compilation, no sudo)"
  mkdir -p "$BUILD_DIR" "$EXT_DIR/extension"
  rm -rf "$BUILD_DIR/pgtap"
  git clone --depth 1 --branch "$PGTAP_VERSION" "$PGTAP_REPO" "$BUILD_DIR/pgtap" >/dev/null 2>&1 \
    || die "could not clone $PGTAP_REPO@$PGTAP_VERSION (network required for 'init' only)"
  ( cd "$BUILD_DIR/pgtap" && make PG_CONFIG="$PGBIN/pg_config" >/dev/null ) \
    || die "pgTAP build failed — see $BUILD_DIR/pgtap"
  cp "$BUILD_DIR/pgtap"/*.control            "$EXT_DIR/extension/"
  cp "$BUILD_DIR/pgtap"/sql/pgtap*--*.sql    "$EXT_DIR/extension/"
  ok "pgTAP staged in $EXT_DIR/extension"
}

# ── init / start / stop ───────────────────────────────────────────────────────
cmd_init() {
  require_bins
  if [[ -f "$PGDATA/PG_VERSION" ]]; then
    ok "cluster already initialised at $PGDATA"
  else
    step "initdb → $PGDATA"
    mkdir -p "$PGDATA" "$LOG_DIR" "$SOCKET_DIR"
    "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER" --encoding=UTF8 --locale=C \
      --auth-local=trust --auth-host=trust >/dev/null
    ok "cluster initialised"
  fi
  install_pgtap
  step "configuring postgresql.conf"
  # Strip any previous harness block so re-running init is idempotent.
  local conf="$PGDATA/postgresql.conf"
  if grep -q '# >>> careOS local-pg harness' "$conf" 2>/dev/null; then
    perl -0pi -e 's/# >>> careOS local-pg harness.*?# <<< careOS local-pg harness\n//s' "$conf"
  fi
  cat >> "$conf" <<EOF
# >>> careOS local-pg harness
port = $PGPORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$SOCKET_DIR'
extension_control_path = '\$system:$REPO_EXT_DIR:$EXT_DIR'
# Migrations create a lot of objects in one transaction; keep the log readable.
log_min_messages = warning
client_min_messages = warning
# <<< careOS local-pg harness
EOF
  ok "postgresql.conf configured (port $PGPORT, extension_control_path → $REPO_EXT_DIR + $EXT_DIR)"
  cmd_start
}

cmd_start() {
  require_bins
  [[ -f "$PGDATA/PG_VERSION" ]] || die "no cluster at $PGDATA — run: harness.sh init"
  mkdir -p "$SOCKET_DIR" "$LOG_DIR"
  if is_running; then
    ok "cluster already running on port $PGPORT"
  else
    step "starting cluster on port $PGPORT"
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOG_DIR/postgres.log" -w start >/dev/null \
      || { tail -30 "$LOG_DIR/postgres.log" >&2; die "cluster failed to start"; }
    ok "cluster running (log: $LOG_DIR/postgres.log)"
  fi
}

cmd_stop() {
  if is_running; then
    step "stopping cluster"
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
    ok "cluster stopped"
  else
    ok "cluster already stopped"
  fi
}

cmd_nuke() {
  cmd_stop || true
  step "deleting $PG_ROOT"
  rm -rf "$PG_ROOT"
  ok "gone. run 'init' to rebuild from scratch."
}

cmd_status() {
  require_bins
  if is_running; then
    ok "cluster running on $PGHOST:$PGPORT (data: $PGDATA)"
  else
    err "cluster not running (data: $PGDATA)"
    return 1
  fi
  psql_maint -tAc "select 1 from pg_database where datname = '$DBNAME'" | grep -q 1 \
    && ok "database '$DBNAME' exists" || err "database '$DBNAME' does not exist — run 'reset'"
  psql_db -tAc "select count(*) || ' relations in public' from pg_class c
                join pg_namespace n on n.oid=c.relnamespace
                where n.nspname='public' and c.relkind='r'" 2>/dev/null | sed 's/^/     /' >&2 || true
}

# ── reset: bootstrap + the whole migration chain ──────────────────────────────
cmd_reset() {
  require_running
  step "dropping and recreating database '$DBNAME'"
  psql_maint -c "drop database if exists $DBNAME with (force)" >/dev/null
  psql_maint -c "create database $DBNAME owner $PGUSER" >/dev/null
  # Supabase puts `extensions` on the search_path of every session (config.toml
  # api.extra_search_path); pgTAP is installed there and its internal calls are
  # unqualified, so this is load-bearing for the test suite.
  psql_maint -c "alter database $DBNAME set search_path = \"\$user\", public, extensions" >/dev/null
  ok "database '$DBNAME' recreated"

  step "applying bootstrap.sql (Supabase-compatible shim)"
  if ! psql_db -q -f "$HARNESS_DIR/bootstrap.sql" 2>&1 | sed 's/^/     /' >&2; then
    die "bootstrap.sql failed"
  fi
  ok "bootstrap applied"

  step "applying migrations from supabase/migrations"
  local applied=0 file base
  shopt -s nullglob
  for file in "$MIGRATIONS_DIR"/*.sql; do
    base="$(basename "$file")"
    if ! psql_db -q -f "$file" > "$LOG_DIR/last-migration.out" 2>&1; then
      err "migration failed: supabase/migrations/$base"
      sed 's/^/     /' "$LOG_DIR/last-migration.out" >&2
      exit 1
    fi
    # psql -v ON_ERROR_STOP=1 exits non-zero on error, but surface warnings too.
    if grep -qE '^(psql:|ERROR|FATAL)' "$LOG_DIR/last-migration.out"; then
      err "migration reported errors: supabase/migrations/$base"
      sed 's/^/     /' "$LOG_DIR/last-migration.out" >&2
      exit 1
    fi
    applied=$((applied + 1))
    printf '%s     %-46s ok%s\n' "$C_DIM" "$base" "$C_0" >&2
  done
  shopt -u nullglob
  [[ $applied -gt 0 ]] || die "no migrations found in $MIGRATIONS_DIR"
  ok "$applied migrations applied with zero errors"
  echo "$applied" > "$LOG_DIR/migrations-applied.count"
}

# ── seed ──────────────────────────────────────────────────────────────────────
# Order mirrors config.toml [db.seed] sql_paths = ["./seed.sql", "./seeds/*.sql"].
cmd_seed() {
  require_running
  step "seeding (synthetic universe only — invariant 4)"
  local files=() f base failed=0
  [[ -f "$SEED_FILE" ]] && files+=("$SEED_FILE")
  shopt -s nullglob
  for f in "$SEEDS_DIR"/*.sql; do files+=("$f"); done
  shopt -u nullglob
  for f in "${files[@]}"; do
    base="${f#$REPO_ROOT/}"
    if psql_db -q -f "$f" > "$LOG_DIR/last-seed.out" 2>&1; then
      printf '%s     %-46s ok%s\n' "$C_DIM" "$(basename "$f")" "$C_0" >&2
    else
      err "seed failed: $base"
      sed 's/^/     /' "$LOG_DIR/last-seed.out" >&2
      failed=1
    fi
  done
  [[ $failed -eq 0 ]] || die "one or more seed files failed"
  ok "${#files[@]} seed files applied"
}

# ── test: run the pgTAP suite ─────────────────────────────────────────────────
# Each test file is a self-contained transaction (begin; … select * from finish();
# rollback;) so files are independent and order does not matter. We do not use
# pg_prove (a Perl/TAP::Harness dependency that is not installed and is not worth
# adding); the TAP stream is parsed directly.
cmd_test() {
  require_running
  local filter="${1:-}"
  local files=() f base total=0 passed=0 failed=0
  shopt -s nullglob
  for f in "$TESTS_DIR"/*.sql; do
    [[ -n "$filter" && "$(basename "$f")" != *"$filter"* ]] && continue
    files+=("$f")
  done
  shopt -u nullglob
  [[ ${#files[@]} -gt 0 ]] || die "no test files matched in $TESTS_DIR"

  mkdir -p "$LOG_DIR/tests"
  step "running ${#files[@]} pgTAP files from supabase/tests/database"
  say ""
  local failed_files=()
  for f in "${files[@]}"; do
    base="$(basename "$f")"
    local out="$LOG_DIR/tests/${base%.sql}.tap"
    total=$((total + 1))
    # psql without ON_ERROR_STOP: a SQL error mid-file must still let us show the
    # TAP produced so far plus the error, which is far more useful than a bare
    # exit code. Failure is detected from the TAP stream and stderr.
    "$PGBIN/psql" -X -q -t -A -d "$DBNAME" -f "$f" > "$out" 2> "$out.err" || true

    local n_ok n_not_ok n_err
    n_ok=$(grep -cE '^ok [0-9]+' "$out" || true)
    n_not_ok=$(grep -cE '^not ok [0-9]+' "$out" || true)
    # Hard SQL errors (as opposed to failed assertions) can appear on either
    # stream; `set -o pipefail` means every one of these needs its own `|| true`.
    n_err=$( { cat "$out" "$out.err" 2>/dev/null || true; } \
             | grep -cE '^(psql:|ERROR:|FATAL:)' || true )

    if [[ "$n_not_ok" -eq 0 && "$n_err" -eq 0 && "$n_ok" -gt 0 ]]; then
      passed=$((passed + 1))
      printf '%s  PASS%s  %-38s %s assertions\n' "$C_OK" "$C_0" "$base" "$n_ok"
    else
      failed=$((failed + 1))
      failed_files+=("$base")
      printf '%s  FAIL%s  %-38s %s ok / %s not ok / %s errors\n' \
        "$C_ERR" "$C_0" "$base" "$n_ok" "$n_not_ok" "$n_err"
      # First failing assertions + first hard errors, with file+line context.
      # NB: the whole block is `|| true`-guarded because `set -o pipefail` turns
      # a grep-with-no-matches anywhere in these pipelines into a script exit.
      {
        grep -E '^not ok [0-9]+' "$out" | head -3 | sed 's/^/          /'
        grep -hE '^(psql:|ERROR:|FATAL:)' "$out" "$out.err" 2>/dev/null \
          | grep -v 'current transaction is aborted' | head -3 | sed 's/^/          /'
      } || true
      printf '          full TAP: %s\n' "$out"
    fi
  done

  say ""
  step "summary"
  printf '  %s test files run · %s%s passed%s · %s%s failed%s\n' \
    "$total" "$C_OK" "$passed" "$C_0" \
    "$( [[ $failed -gt 0 ]] && echo "$C_ERR" || echo "$C_OK" )" "$failed" "$C_0"
  if [[ $failed -gt 0 ]]; then
    printf '  failing: %s\n' "${failed_files[*]}"
    return 1
  fi
}

cmd_psql() {
  require_running
  psql_bin -d "$DBNAME" "$@"
}

# ── dispatch ──────────────────────────────────────────────────────────────────
usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

case "${1:-}" in
  init)   shift; cmd_init "$@" ;;
  start)  shift; cmd_start "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  reset)  shift; cmd_reset "$@" ;;
  seed)   shift; cmd_seed "$@" ;;
  test)   shift; cmd_test "$@" ;;
  psql)   shift; cmd_psql "$@" ;;
  nuke)   shift; cmd_nuke "$@" ;;
  ""|-h|--help|help) usage; exit 1 ;;
  *) err "unknown command: $1"; usage; exit 1 ;;
esac
