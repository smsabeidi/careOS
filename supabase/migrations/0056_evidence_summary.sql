-- ST-242 · Migration 0056 — app.evidence_summary: the "Show me" screen's one read
-- The Front Door program's W8 (docs/designs/intelligent-front-door.md). The screen's
-- whole premise is that CareOS can PROVE its enforcement posture live, on demand, to a
-- surveyor or a buyer — policies from pg_catalog (never a doc), the audit chain verified
-- by recomputation, the AI registry with its structural tier constraint, append-only
-- coverage counted from real triggers. One definer function, because pg_policies and
-- pg_trigger are not readable by `authenticated` and must not become so; the exception is
-- earned the 0051 way: OUTPUT IS COUNTS, NAMES OF DATABASE OBJECTS AND ENUMS ONLY — no
-- tenant row, no person, no PHI can appear in the return value by construction.
--
-- Gate: AAL2 + audit.read (0025's key for "show me the evidence"). The screen additionally
-- renders the COMMITTED artifacts (db/policies.md counts, pgTAP/gate counts) from the
-- repo bundle and cross-checks them against this function's live numbers — a mismatch
-- renders as a visible warning, never silently (review finding CL3): drift on an evidence
-- screen is the one unacceptable outcome.
-- @trace: ST-242, docs/designs/intelligent-front-door.md W8, CL3, invariant 2, D-028
create or replace function app.evidence_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_chain jsonb;
  v_out jsonb;
begin
  if app.current_tenant_id() is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: an active principal is required'
      using errcode = 'P0001';
  end if;
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to read the evidence summary'
      using errcode = '42501';
  end if;
  if not app.has_perm('audit.read') then
    raise exception 'CAREOS_FORBIDDEN: audit.read is required' using errcode = '42501';
  end if;

  -- The audit chain, verified by recomputation right now — not a stored claim.
  -- verify_audit_chain is 0025's own surface (returns jsonb); reusing it keeps one
  -- definition of "intact".
  v_chain := app.verify_audit_chain();

  select jsonb_build_object(
    'ok', true,
    'generated_at', now(),
    -- Live policy catalog: per-table policy counts straight from pg_catalog. Object
    -- names and integers only.
    'rls', jsonb_build_object(
      'tables_with_rls', (
        select count(*) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public','audit') and c.relkind = 'r' and c.relrowsecurity),
      'tables_forced', (
        select count(*) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public','audit') and c.relkind = 'r' and c.relforcerowsecurity),
      'tables_total', (
        select count(*) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public','audit') and c.relkind = 'r'),
      'policy_count', (
        select count(*) from pg_policies p where p.schemaname in ('public','audit')),
      'policies_by_table', (
        select coalesce(jsonb_object_agg(t.tab, t.n), '{}'::jsonb)
          from (select p.schemaname || '.' || p.tablename as tab, count(*)::int as n
                  from pg_policies p where p.schemaname in ('public','audit')
                 group by 1) t)),
    -- Append-only coverage counted from the REAL triggers, not from the manifest: a
    -- forbid_mutation trigger on before update-or-delete is the enforcement itself.
    'append_only_tables', (
      select count(distinct tg.tgrelid) from pg_trigger tg
        join pg_proc pr on pr.oid = tg.tgfoid
       where pr.proname = 'forbid_mutation' and not tg.tgisinternal),
    'audit_chain', v_chain,
    -- The AI registry, exactly as governed: key, tier, human requirement, kill switch,
    -- budget, and whether an active registry prompt exists. The caller's own tenant only.
    'ai_capabilities', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', c.key, 'tier', c.tier, 'requires_human', c.requires_human,
               'enabled', c.enabled, 'monthly_budget_usd', c.monthly_budget_usd,
               'has_active_prompt', exists (
                 select 1 from public.ai_prompt_template t
                  where t.capability_key = c.key and t.tenant_id = c.tenant_id and t.active))
             order by c.key), '[]'::jsonb)
        from public.ai_capability c
       where c.tenant_id = app.current_tenant_id()),
    -- The structural claim a buyer can check: the CHECK constraint that makes a T2/T3
    -- capability without a human disposer unrepresentable, quoted from the catalog.
    'tier_constraint', (
      select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'ai_capability_tier_human'),
    'feature_flags', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', f.key, 'enabled', f.enabled,
               'disabled_reason', f.disabled_reason) order by f.key), '[]'::jsonb)
        from public.feature_flag f
       where f.tenant_id = app.current_tenant_id()))
  into v_out;
  return v_out;
end $$;
revoke all on function app.evidence_summary() from public, anon;
grant execute on function app.evidence_summary() to authenticated;
