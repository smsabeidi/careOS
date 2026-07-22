---
name: careos-db-schema-rls
description: The binding playbook for ALL database work in CareOS — creating or altering tables, writing migrations, RLS policies, grants, triggers, Postgres functions/RPCs, indexes, or queues. Use this skill every time you touch anything under db/, write SQL, add a column, create a policy, or build an RPC — even for "small" schema tweaks, because every table has compliance obligations (tenancy, RLS, append-only, audit, pgTAP) that are easy to miss.
---

# CareOS DB, Schema & RLS Playbook

Authoritative deep spec: `docs/07` (conventions §1 are binding). This skill is the working checklist + templates.

## New-table checklist (all of it, every time)

1. `tenant_id uuid not null` + FK; `created_at`; mutable tables add `updated_at` + `row_version int default 1`.
2. Classify: **PHI / PII / OPS / CFG** (comment on the table) and **[AO]?** (append-only).
3. `alter table X enable row level security; alter table X force row level security;`
4. **Explicit grants only** — nothing is exposed by default. Grant the minimum ops to `authenticated`; RLS gates rows.
5. Policies per operation, named `<table>_<action>_<who>`, built from helpers (below). PHI tables include `app.is_aal2()`.
6. Index the policy predicate columns (tenant_id, assignment FKs, partial indexes for hot filters).
7. Add the table to the **pgTAP matrix manifest** (`db/tests/matrix.yaml`) with expected allow/deny per role — CI fails without it.
8. Add a data-dictionary row (docs/07 §10) in the same PR. Regenerate types + policy catalog: `pnpm db:gen`.

## Helper functions — always use, never inline-reimplement

`app.current_user_id()` · `app.current_tenant_id()` · `app.is_aal2()` · `app.has_perm('x.y')` · `app.on_care_team(client_id)` — all `stable`; cross-table ones are `security definer` with `set search_path = public` (mandatory on ANY security-definer function you write).

## Policy templates

```sql
-- Read: org-wide permission OR care-team assignment; PHI ⇒ AAL2
create policy client_select_scoped on public.client for select to authenticated
using (
  tenant_id = app.current_tenant_id() and app.is_aal2()
  and (app.has_perm('client.read.all') or app.on_care_team(id))
);

-- Write: permission-gated; WITH CHECK pins tenant
create policy client_update_admin on public.client for update to authenticated
using (tenant_id = app.current_tenant_id() and app.is_aal2() and app.has_perm('client.write'))
with check (tenant_id = app.current_tenant_id());
```

## Append-only [AO] recipe (form_version, signature, mar_entry, visit_event, audit, agent_step…)

```sql
revoke update, delete on public.<t> from authenticated;
create trigger trg_<t>_ao before update or delete on public.<t>
  for each row execute function app.forbid_mutation();
```
Corrections = new rows with `kind='correction'` + reference + reason (enforced in the RPC, reason non-null). Never add an UPDATE path "just for admins."

## RPC skeleton (the only way consequential state changes)

```sql
create or replace function app.<verb>_<noun>(…)
returns … language plpgsql security definer set search_path = public as $$
begin
  if not app.is_aal2() then raise exception 'CAREOS_AAL2_REQUIRED'; end if;
  if not app.has_perm('<perm>') then raise exception 'CAREOS_FORBIDDEN'; end if;
  -- row locks (for update) before invariant checks; idempotency via natural key
  -- … domain writes …
  perform app.emit_audit('<action>','<entity>', v_id, jsonb_build_object(...)); -- IDs/deltas only
  perform pgmq.send('q_events', jsonb_build_object('type','<action>','id',v_id)); -- same txn
end $$;
```
Raise `CAREOS_*` codes (docs/08 §2) — the API layer maps them 1:1. Grant execute explicitly; revoke from public.

## Migration rules

- Sequential SQL in `db/migrations/`; **expand → migrate (backfill job) → contract (later release)**. Contractions and destructive DDL need a `docs/00 §3` decision entry first.
- Every migration PR runs fresh-migrate + full pgTAP + policy-catalog regen; catalog drift fails CI — never hand-edit `db/policies.md`.
- New enum-ish values: `text + CHECK`; widen CHECK in expand phase.
- Backfills are idempotent scripts run via queue workers, never inline in the migration.
- PowerSync compatibility: sync-rule-visible tables evolve additively; coordinate contractions with the mobile skill.

## Traps that have burned people

`security definer` without pinned `search_path` · policies calling volatile functions · forgetting `force row level security` (owner bypass) · granting on `all tables in schema` · sequences/grants forgotten on identity columns · RLS on the table but not on its Storage bucket policy twin · time math in `timestamp` instead of `timestamptz` · cadence intervals computed in app code instead of `app.evaluate_compliance()`.

**Definition of done for any DB change:** pgTAP green (matrix + AO probes + RPC guards), catalog regenerated, dictionary updated, types regenerated, story AC mapped.
