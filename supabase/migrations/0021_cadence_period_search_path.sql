-- ST-114 · Migration 0021 — pin search_path on app.cadence_period (D-016)
--
-- Supabase's security advisor flagged `function_search_path_mutable` on
-- app.cadence_period after 0019 shipped. A function without an explicit search_path
-- resolves unqualified names against the caller's, which is the search-path-hijack shape
-- migration 0007 exists to close for the rest of the function surface.
--
-- cadence_period is IMMUTABLE and calls only make_interval (pg_catalog, always searched),
-- so exploitability here is essentially nil — but "essentially nil" is not the standard the
-- rest of this schema is held to, and leaving a known advisor warning on a function shipped
-- three migrations ago is how a lockdown posture erodes.
--
-- PRE-EXISTING, NOT FIXED HERE (each needs its own change + pgTAP pass, and none was
-- introduced by ST-114): app.guard_visit, app.guard_supervisory_visit, app.forbid_mutation,
-- app.current_user_id, app.is_aal2, app.credential_expiry_bucket, app.cadence_status,
-- app.guard_columns_only, audit.compute_chain. Tracked as a hardening story rather than
-- folded in silently — app.forbid_mutation and app.is_aal2 in particular are load-bearing
-- for invariants 1 and 3 and should not be altered as a drive-by.
--
-- Note the two INFO-level `rls_enabled_no_policy` findings on audit.audit_event and
-- audit.audit_anchor are BY DESIGN (matrix.yaml: `authenticated: none, writes:
-- definer-only`) — the hash-chained ledger deliberately has no client read path. They are
-- correct as-is and must not be "fixed" by adding a policy.
-- @trace: ST-114, D-016

create or replace function app.cadence_period(p_days int, p_months int)
returns interval language sql immutable
set search_path = ''
as $$
  select case
    when p_months is not null then pg_catalog.make_interval(months => p_months)
    when p_days   is not null then pg_catalog.make_interval(days   => p_days)
    else null
  end
$$;
