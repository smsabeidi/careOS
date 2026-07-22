# CareOS

HIPAA-grade, AI-native care-operations platform for a Maryland Residential Service Agency (COMAR 10.07.05). Built by OCTSERVICES on Supabase + Vercel. The full specification lives in [`docs/`](docs/) — start at [`docs/00`](docs/00_CareOS_Master_Index_and_Decision_Log.md) (master index + authoritative decision log). The agent operating constitution is [`CLAUDE.md`](CLAUDE.md).

## Status

Sprint 0 (records-spine resequence per **D-009**). Shipped so far:

- **Schema core** (`supabase/migrations/0001–0006`): tenancy, identity, RBAC + assignment scoping, the append-only + hash-chained audit spine, client records, and the forms engine (templates → instances → append-only versions → hash-bound signatures) with the Lane-B RPC catalog (`app.create_form`, `save_draft` with keep-both conflict detection, `finalize_form`, `correct_form`, `sign_version`).
- **Hardening per D-011** (from the 11-section deep review): per-tenant serialized audit chain, function-privilege baseline (no forgeable ledger), constraint-true e-sign binding, transition-guard-by-privilege.
- **pgTAP compliance suite** (`supabase/tests/database/`): RLS matrix, append-only probes, chain verification incl. simulated insider tamper, RPC guards with exact `CAREOS_*` codes.
- **CI** (`.github/workflows/ci.yml`): migrations + pgTAP on every PR, plus the spec-corpus drift gate (**D-010**/ST-103).

## Quickstart

```bash
supabase db start     # local Postgres on port 54422 (careOS-specific port block)
supabase db reset     # apply migrations + Meadowbrook seed (synthetic only — D-006)
supabase test db      # run the pgTAP compliance suite
bash scripts/spec-drift-gate.sh   # what CI runs on your commits
```

`db/migrations` and `db/tests` are symlinks into `supabase/` so the docs' paths and the CLI's paths agree.

## Non-negotiables

PHI exists only in production (**D-006**). Every table: RLS enabled + forced, explicit grants only. Records of consequence are never updated or deleted — there is no overwrite path anywhere. Every consequential action lands on the hash-chained audit ledger. See `CLAUDE.md` for all fourteen invariants.
