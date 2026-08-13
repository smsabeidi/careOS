-- ST-233 · Migration 0055 — ai_capability.config: where an action capability's contract lives
-- The Front Door program's W2 (docs/designs/intelligent-front-door.md, review finding CO3).
-- The NL scheduling pipeline drafts ai_proposal rows whose parameters target Lane-B RPCs,
-- and the ALLOWLIST of draftable RPCs plus their parameter schemas must live in the
-- database — in the same row that carries the capability's tier, kill switch and budget —
-- not in application code, or the registry stops being the single unit of governance
-- (the exact "tier laundering" failure the CEO review's outside voice named). Expand-only:
-- one nullable JSONB column, no rewrite, no lock beyond the DDL.
--
-- Shape of config for an action-drafting capability (v1, command.schedule_draft):
--   {"actions": {
--      "app.schedule_visit": {"params": {...json-schema...}},
--      "app.assign_visit":   {"params": {...json-schema...}}}}
-- The pipeline refuses to draft any action absent from its capability's allowlist, and
-- adverse-class RPCs (separation, suspension, credential adverse action) are simply never
-- present — structural exclusion, not a runtime check that can drift.
--
-- The CHECK is deliberately minimal (an object or null): the SHAPE of config varies by
-- capability kind, and the registry loader (apps/web/src/lib/ai/registry.ts) validates the
-- kind-specific shape at read time where it can produce a legible error. What the CHECK
-- does refuse is the secret-bearing keys — the 0049 evv_adapter posture — because a
-- config column on a widely-read table must never become a credential sink.
-- @trace: ST-233, docs/designs/intelligent-front-door.md W2, CO3, docs/16 §4

alter table public.ai_capability
  add column config jsonb
  check (config is null or (
    jsonb_typeof(config) = 'object'
    and not jsonb_exists_any(config,
      array['api_key','apikey','secret','client_secret','password','token','bearer'])));

comment on column public.ai_capability.config is
  'Kind-specific capability contract (e.g. the action allowlist + parameter schemas for '
  'an NL action-drafting capability). Object or null; never credentials (docs/09 §5). '
  'Kind-specific shape is validated by the registry loader at read time.';
