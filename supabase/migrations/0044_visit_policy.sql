-- ST-202 · Migration 0044 — the visit policy engine: scopes, versions, resolution
-- The second slice of the Verified Visit layer (docs/17 §3.4, §4.2, §5, §6.2). 0043
-- answered "where is care supposed to happen"; this migration answers "and by whose
-- rules" — how close is close enough, how late is late, how long is too long, and what
-- a caregiver is allowed to do when the geography refuses to cooperate.
--
-- Everything here is Engine 1 (invariant 13). A geofence radius, a grace period and an
-- overtime threshold are agency policy evaluated in SQL; no model is ever asked whether
-- an arrival was late. The AI layer reads the OUTPUT of these rules and narrates it.
--
-- APPEND-ONLY, on purpose (invariant 1, the D-014 binding precedent). A policy is the
-- yardstick a visit was measured against, so editing it in place would silently restate
-- every verification decision ever made under it. Instead each change appends a new
-- version with supersedes_id, and 0045's `visit.policy_id` binds the exact row the clock
-- engine resolved at clock-in — the same shape as form_template→form_version (0005/0006)
-- and service_location→service_location_version (0043). Resolution therefore reads the
-- LATEST version in force at a given instant, while history keeps pointing at what it
-- always pointed at.
--
-- Resolution (§4.2) is a five-rung specificity ladder — client → service_type →
-- payer_kind → program → tenant — folded field by field, with the tenant row as the
-- floor. Two consequences are surfaced here rather than discovered later:
--
--   DN-0044a · Every setting column is NOT NULL with a default (the docs/17 §3.4 DDL is
--     pinned), so a narrower row can never be "unset" in a field, and the read-time fold
--     is in practice "the most specific applicable row wins". The coalesce chain is
--     still written out because it is what makes the tenant row a genuine FLOOR and what
--     keeps the resolver correct if a field ever becomes nullable. The real inheritance
--     happens at WRITE time: app.upsert_visit_policy merges the caller's delta over the
--     current row for that scope, or — when a scope is being created for the first time —
--     over the tenant floor, so authoring `{"late_threshold_minutes": 3}` for one service
--     type cannot silently reset that service type's geofence to the column default.
--     This also keeps the returned row honest: the composite carries the identity of the
--     most specific row on the ladder, and (given NOT NULL settings) its values too, so
--     visit.policy_id → visit_policy shows a surveyor exactly the rule that was applied.
--
--   DN-0044b · `program` is in the scope CHECK because docs/17 §3.4 pins the ladder, but
--     no program entity exists in the corpus yet. A program-scope row is therefore
--     storable and INERT: the resolver has nothing to join a client to a program with,
--     so it never becomes a candidate. When a program table lands, the rung is one union
--     branch in app.visit_policy_chain — not a migration of stored policy.
--
-- Tier metre-ranges are ENGINEERING DEFAULTS, NOT REGULATORY THRESHOLDS: strict
-- 75–150 m, standard 150–300 m, rural 300–750 m. No COMAR provision and no federal EVV
-- rule sets a geofence radius, a grace period, or a rounding increment — agencies do,
-- and they answer for them. Nothing in this file may be cited to a surveyor as a
-- regulatory requirement (the D-017 posture: an invented number is labelled as one).
--
-- Not PHI. A policy row contains no client, no caregiver and no coordinate, so it is
-- readable by any active tenant member at AAL1 — deliberately, because a caregiver
-- standing on a porch needs to know their own grace period, and gating that behind MFA
-- would make the field surface worse for no confidentiality gain (docs/17 §3.4). Writes
-- take the 0023/0043 Lane-B perimeter: zero write grants, one definer RPC.
-- @trace: ST-202, D-014, D-017, D-024, docs/17 §3.4, §4.2, §5, §6.2

-- ── Permission catalog (docs/17 §5 — real config, so it belongs in the migration, not
--    the synthetic seed; per-tenant role grants are wired in the seed / 0031) ──────────
insert into public.permission (key, description) values
  ('policy.manage', 'Author visit policies')
on conflict (key) do nothing;

-- ── Audit trigger (definer; IDs + enums only, invariant 5) ────────────────────────────
-- Append-only ⇒ INSERT is the only event there is. change_reason is staff free text and
-- stays OUT of the payload (the 0011/0043 posture); the ledger records WHICH scope moved
-- to WHICH version superseding WHICH row, which is the question a surveyor actually
-- asks. Seed guard first: migrations and synthetic seeding run with no session tenant
-- and must never fork the audit chain (0011 precedent).
create or replace function app.audit_visit_policy() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('visit_policy.version_created', 'visit_policy', new.id,
    jsonb_build_object('scope_kind', new.scope_kind,
                       'scope_id', new.scope_id,
                       'scope_value', new.scope_value,
                       'version_no', new.version_no,
                       'supersedes_id', new.supersedes_id,
                       'geofence_tier', new.geofence_tier,
                       'signature_requirement', new.signature_requirement,
                       'rounding_policy', new.rounding_policy));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_visit_policy() from public;

-- ═══ §3.4 · visit_policy — the rules a visit is measured against ═════════ [AO] CFG
create table public.visit_policy (                                       -- [AO] CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  -- Scope identity. scope_id is the client/service_type/program row the policy attaches
  -- to; scope_value carries the payer_kind literal (there is no payer table to point at).
  scope_kind text not null check (scope_kind in
    ('tenant','program','payer_kind','service_type','client')),
  scope_id uuid,                                  -- NULL for tenant / payer_kind scopes
  scope_value text,                               -- payer_kind literal, else NULL
  version_no int not null,                        -- server-assigned by §6.2, 1-based
  -- A version may be scheduled ahead ("the new grace period starts Monday"): it simply
  -- is not a resolution candidate until effective_from arrives. Superseded versions are
  -- never closed off with an UPDATE — they cannot be — so resolution takes the highest
  -- version_no among the rows actually in force at the instant asked about (§4.2).
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  -- ── geofence ──
  geofence_tier text not null default 'standard'
    check (geofence_tier in ('strict','standard','rural','custom')),
  geofence_radius_m int not null default 200
    check (geofence_radius_m between 25 and 5000),
  max_accuracy_m int not null default 250
    check (max_accuracy_m between 10 and 5000),
  require_clock_in_location boolean not null default true,
  require_clock_out_location boolean not null default true,
  allow_location_exception boolean not null default true,
  -- ── time ──
  early_clock_in_minutes int not null default 15,
  late_threshold_minutes int not null default 7,
  clock_out_grace_minutes int not null default 10,
  missing_clock_out_minutes int not null default 20,
  missed_visit_minutes int not null default 60,
  max_visit_minutes int not null default 900,
  -- ── documentation ──
  require_visit_note boolean not null default false,
  require_task_completion boolean not null default false,
  signature_requirement text not null default 'none' check (signature_requirement in
    ('none','optional','required_for_service','required_for_payer')),
  -- ── money ──
  rounding_policy text not null default 'none' check (rounding_policy in
    ('none','nearest_1','nearest_5','nearest_6','nearest_15')),
  overtime_weekly_minutes int not null default 2400,         -- 40h
  -- ── fraud ──
  impossible_travel_kmh int not null default 120,
  supersedes_id uuid references public.visit_policy(id),
  change_reason text,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT is load-bearing, not decoration: scope_id and scope_value are
  -- NULL for every tenant-scope row, and under the default NULL semantics a unique
  -- constraint would treat each of them as distinct — i.e. it would enforce nothing at
  -- all on exactly the scope that matters most.
  constraint uq_visit_policy_scope_version unique nulls not distinct
    (tenant_id, scope_kind, scope_id, scope_value, version_no),
  -- Scope shape, enforced at the constraint layer so a direct INSERT (seeds, fixtures,
  -- a future importer) cannot create a row the resolver can never match.
  constraint chk_visit_policy_scope_id
    check ((scope_id is null) = (scope_kind in ('tenant','payer_kind'))),
  constraint chk_visit_policy_scope_value
    check (case when scope_kind = 'payer_kind'
                then scope_value in ('medicaid','medicare','private','waiver','other')
                else scope_value is null end),
  constraint chk_visit_policy_effective_window
    check (effective_until is null or effective_until > effective_from),
  -- Additive hardening over the docs/17 DDL: a negative grace period or a zero speed
  -- ceiling is not a policy, it is a data-entry accident that would silently disable a
  -- detector in 0047.
  constraint chk_visit_policy_durations check (
    early_clock_in_minutes >= 0 and late_threshold_minutes >= 0
    and clock_out_grace_minutes >= 0 and missing_clock_out_minutes >= 0
    and missed_visit_minutes >= 0 and max_visit_minutes > 0
    and overtime_weekly_minutes >= 0 and impossible_travel_kmh > 0)
);
create index idx_visit_policy_tenant on public.visit_policy (tenant_id);
-- No separate resolver index: uq_visit_policy_scope_version already indexes
-- (tenant_id, scope_kind, scope_id, scope_value, version_no), which is exactly the
-- chain query's access path — and a partial "still in force" index is impossible
-- anyway, because the predicate would have to call now() (not IMMUTABLE).

create trigger trg_visit_policy_ao before update or delete on public.visit_policy
  for each row execute function app.forbid_mutation();
create trigger trg_visit_policy_audit after insert on public.visit_policy
  for each row execute function app.audit_visit_policy();

alter table public.visit_policy enable row level security;
alter table public.visit_policy force row level security;

-- Read: any active tenant member, no AAL2 (see the header — a policy row is not PHI and
-- the caregiver surface needs it). app.current_tenant_id() already fails closed for a
-- suspended tenant or a separated principal (0022).
create policy visit_policy_select_member on public.visit_policy for select to authenticated
  using (tenant_id = app.current_tenant_id());

grant select on public.visit_policy to authenticated;   -- no update/delete: append-only
-- No INSERT grant either: version_no assignment, scope inheritance and the supersedes
-- chain are invariants a direct write could violate — §6.2 is the only way in.

-- ═══ §3.4 defaults · the tenant floor, from one source of truth ═══════════════════════
-- Every column above already carries its docs/17 §3.4 default, so this seeder inserts
-- ONLY the identity columns and lets the DDL supply the values. There is exactly one
-- place the number 200 lives, and it is the table definition.
--
-- Idempotent (the 0038 `select app.<seed>(t.id) from public.tenant t` pattern): a tenant
-- that already has a tenant-scope row is left alone, so this is safe from a migration,
-- from the synthetic seed system, and from the bootstrap branch of §6.2.
--
-- TWO ENTRY POINTS, one source — and the second one is still owed (0038's own note, made
-- concrete here): this migration seeds the tenants that exist WHEN IT RUNS, which covers
-- hosted. Local and preview run seeds AFTER migrations, so the Meadowbrook universe's
-- tenants are created later and need `select app.seed_visit_policy(t.id) from
-- public.tenant t;` in supabase/seeds/. Until that line lands, a synthetic tenant
-- resolves to CAREOS_POLICY_MISSING at its first clock-in — loudly, which is the
-- intended failure. A real agency is never stuck: the first save on
-- /settings/visit-policy takes the bootstrap branch of §6.2 below and lays the floor.
--
-- created_by is NOT NULL and FKs a real principal, which is correct (a policy is
-- authored by somebody) and awkward at seed time. Resolution order: the caller's actor
-- if it belongs to the tenant, else the tenant's system principal (0035 agent identity),
-- else its earliest active member. A tenant with no principals at all is skipped and
-- returns 0 rather than inventing an author — visible as CAREOS_POLICY_MISSING at the
-- first clock-in, which is a far better failure than a fabricated attribution.
create or replace function app.seed_visit_policy(p_tenant uuid, p_actor uuid default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := p_actor;
  v_count int;
begin
  if exists (select 1 from public.visit_policy vp
              where vp.tenant_id = p_tenant and vp.scope_kind = 'tenant') then
    return 0;                                     -- the floor is already laid
  end if;
  if v_actor is null or not exists (select 1 from public.app_user u
                                     where u.id = v_actor and u.tenant_id = p_tenant) then
    select u.id into v_actor
      from public.app_user u
     where u.tenant_id = p_tenant and u.status = 'active'
     order by (u.kind <> 'system'), u.created_at, u.id
     limit 1;
  end if;
  if v_actor is null then
    return 0;                                     -- no principal to attribute it to
  end if;
  insert into public.visit_policy
    (tenant_id, scope_kind, version_no, created_by, change_reason)
  values (p_tenant, 'tenant', 1, v_actor,
          'Agency defaults established with the Verified Visit layer (docs/17 §3.4).');
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.seed_visit_policy(uuid, uuid) from public, anon, authenticated;

select app.seed_visit_policy(t.id) from public.tenant t;

-- ═══ §4.2 · Resolution — deterministic, stable, and explainable ═══════════════════════

-- The candidate ladder: at most one row per rung, each the highest version actually in
-- force at p_at. Internal plumbing — the two public entry points below are the only
-- callers, so it carries no grants at all (the 0027 emit_event_internal posture).
--
-- The payer_kind rung derives its literal from the service type rather than from a
-- payer column on the visit, because payer_kind is a property of the SERVICE (0043
-- §3.1) — a Medicaid PCA hour and a private-pay companion hour can be the same client
-- on the same day. No p_service_type ⇒ no payer rung, which is correct: an unspecified
-- service has no payer to inherit from. The `program` rung is absent by construction
-- (DN-0044b).
create or replace function app.visit_policy_chain(
  p_tenant uuid, p_client uuid, p_service_type uuid, p_at timestamptz
) returns setof public.visit_policy
language sql stable security definer set search_path = public as $$
  with scope as (
    select 'client'::text as scope_kind, p_client as scope_id, null::text as scope_value
    union all
    select 'service_type', p_service_type, null::text
     where p_service_type is not null
    union all
    select 'payer_kind', null::uuid, st.payer_kind
      from public.service_type st
     where st.id = p_service_type and st.tenant_id = p_tenant
    union all
    select 'tenant', null::uuid, null::text
  )
  -- DISTINCT ON treats NULL scope keys as equal, which is exactly the grouping wanted:
  -- one winner per rung. The window filter runs first, so a version that has been
  -- superseded by a scheduled-ahead one still governs until that one starts.
  select distinct on (vp.scope_kind, vp.scope_id, vp.scope_value) vp.*
    from scope s
    join public.visit_policy vp
      on vp.tenant_id = p_tenant
     and vp.scope_kind = s.scope_kind
     and vp.scope_id is not distinct from s.scope_id
     and vp.scope_value is not distinct from s.scope_value
   where vp.effective_from <= p_at
     and (vp.effective_until is null or vp.effective_until > p_at)
   order by vp.scope_kind, vp.scope_id, vp.scope_value,
            vp.version_no desc, vp.created_at desc
$$;
revoke all on function app.visit_policy_chain(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;

-- app.resolve_visit_policy — fold the ladder into one row (§4.2).
--
-- The fold: the most specific rung seeds the result (identity AND values), then each
-- less specific rung fills anything still null. With the pinned NOT NULL DDL nothing is
-- ever null, so this is "most specific wins" with a structural safety net (DN-0044a) —
-- and the tenant rung is a hard requirement, not a fallback of last resort: without it
-- there is no guarantee every field has a value, so its absence is an error, not a
-- degraded answer.
--
-- Tenancy: the tenant comes from the client row, and when there IS a session principal
-- it must match. Workers and cron (0047's sweeps) call this with no session and are
-- unaffected; a request-path caller can only resolve inside their own tenant.
create or replace function app.resolve_visit_policy(
  p_client uuid, p_service_type uuid default null, p_at timestamptz default now()
) returns public.visit_policy
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_session uuid := app.current_tenant_id();
  v_out public.visit_policy;
  r public.visit_policy;
  v_floor boolean := false;
begin
  select c.tenant_id into v_tenant from public.client c where c.id = p_client;
  if v_tenant is null or (v_session is not null and v_session <> v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
  end if;

  for r in
    select c.* from app.visit_policy_chain(v_tenant, p_client, p_service_type, p_at) c
     -- The specificity ladder, stated where a reader looks for it (docs/17 §3.4).
     order by case c.scope_kind
                when 'client'       then 1
                when 'service_type' then 2
                when 'payer_kind'   then 3
                when 'program'      then 4
                else                     5 end
  loop
    if v_out.id is null then
      v_out := r;                                 -- the head: whose rule this is
    else
      v_out.geofence_tier :=
        coalesce(v_out.geofence_tier, r.geofence_tier);
      v_out.geofence_radius_m :=
        coalesce(v_out.geofence_radius_m, r.geofence_radius_m);
      v_out.max_accuracy_m :=
        coalesce(v_out.max_accuracy_m, r.max_accuracy_m);
      v_out.require_clock_in_location :=
        coalesce(v_out.require_clock_in_location, r.require_clock_in_location);
      v_out.require_clock_out_location :=
        coalesce(v_out.require_clock_out_location, r.require_clock_out_location);
      v_out.allow_location_exception :=
        coalesce(v_out.allow_location_exception, r.allow_location_exception);
      v_out.early_clock_in_minutes :=
        coalesce(v_out.early_clock_in_minutes, r.early_clock_in_minutes);
      v_out.late_threshold_minutes :=
        coalesce(v_out.late_threshold_minutes, r.late_threshold_minutes);
      v_out.clock_out_grace_minutes :=
        coalesce(v_out.clock_out_grace_minutes, r.clock_out_grace_minutes);
      v_out.missing_clock_out_minutes :=
        coalesce(v_out.missing_clock_out_minutes, r.missing_clock_out_minutes);
      v_out.missed_visit_minutes :=
        coalesce(v_out.missed_visit_minutes, r.missed_visit_minutes);
      v_out.max_visit_minutes :=
        coalesce(v_out.max_visit_minutes, r.max_visit_minutes);
      v_out.require_visit_note :=
        coalesce(v_out.require_visit_note, r.require_visit_note);
      v_out.require_task_completion :=
        coalesce(v_out.require_task_completion, r.require_task_completion);
      v_out.signature_requirement :=
        coalesce(v_out.signature_requirement, r.signature_requirement);
      v_out.rounding_policy :=
        coalesce(v_out.rounding_policy, r.rounding_policy);
      v_out.overtime_weekly_minutes :=
        coalesce(v_out.overtime_weekly_minutes, r.overtime_weekly_minutes);
      v_out.impossible_travel_kmh :=
        coalesce(v_out.impossible_travel_kmh, r.impossible_travel_kmh);
    end if;
    v_floor := v_floor or r.scope_kind = 'tenant';
  end loop;

  if not v_floor then
    raise exception
      'CAREOS_POLICY_MISSING: this agency has no visit policy — set the defaults first'
      using errcode = 'P0001';
  end if;
  return v_out;
end $$;

-- app.visit_policy_for — the same resolution, keyed by the visit (§4.2).
-- FORWARD REFERENCE, deliberate and surfaced: `visit.service_type_id` lands in 0045
-- (docs/17 §3.5, the same migration that adds the visit.policy_id this resolution
-- fills). PL/pgSQL resolves column names at execution, not at CREATE, and the first
-- caller is 0046's clock engine — so the chain applies cleanly in order. Splitting the
-- function across two migrations to avoid the reference would have hidden the
-- dependency instead of naming it.
--
-- Resolution is at now(), not at the visit's scheduled time: the rule that governs a
-- clock event is the rule in force when it happens. What was in force at verification
-- time stays readable forever through visit.policy_id (D-014 binding, D-024).
create or replace function app.visit_policy_for(p_visit uuid) returns public.visit_policy
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_client uuid;
  v_service_type uuid;
  v_session uuid := app.current_tenant_id();
begin
  select v.tenant_id, v.client_id, v.service_type_id
    into v_tenant, v_client, v_service_type
    from public.visit v
   where v.id = p_visit;
  if v_client is null or (v_session is not null and v_session <> v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  return app.resolve_visit_policy(v_client, v_service_type, now());
end $$;

revoke all on function
  app.resolve_visit_policy(uuid, uuid, timestamptz),
  app.visit_policy_for(uuid)
from public, anon;
grant execute on function
  app.resolve_visit_policy(uuid, uuid, timestamptz),
  app.visit_policy_for(uuid)
to authenticated;

-- ═══ §6.2 · Lane-B write path — the only way into a policy ════════════════════════════
-- app.upsert_visit_policy — "upsert" in the docs/17 §6.2 sense: the caller states the
-- scope and the fields they want changed, and the engine APPENDS the next version of
-- that scope. Nothing is ever edited (invariant 1); the observable contract of §6.2 is
-- unchanged, the history is honest.
--
-- p_settings is a partial delta merged over a base (DN-0044a):
--   * the current version of this exact scope, when one exists — so changing one field
--     leaves the other seventeen exactly where the last author put them; or
--   * the tenant floor, when this scope is being authored for the first time — so a new
--     client-scope row inherits the agency's rules instead of the column defaults; or
--   * for the tenant scope itself with no floor yet, app.seed_visit_policy lays version 1
--     at the DDL defaults first and this call becomes version 2. The ledger then reads
--     "defaults established, then changed", which is what happened.
-- 'effective_from' / 'effective_until' are accepted so a change can be scheduled ahead
-- or time-boxed; effective_from defaults to now() and effective_until is never inherited
-- (a new version is open-ended unless the author says otherwise).
--
-- AAL2 is required even though a policy row is not PHI: this write reconfigures
-- geofence enforcement, missed-visit detection and overtime for the whole agency, which
-- is the strongest administrative act in this layer. Every other Lane-B writer in the
-- corpus (0023, 0043) gates the same way; being the one exception would be the surprise.
create or replace function app.upsert_visit_policy(
  p_scope_kind text, p_scope_id uuid, p_scope_value text,
  p_settings jsonb, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_allowed text[] := array[
    'geofence_tier','geofence_radius_m','max_accuracy_m',
    'require_clock_in_location','require_clock_out_location','allow_location_exception',
    'early_clock_in_minutes','late_threshold_minutes','clock_out_grace_minutes',
    'missing_clock_out_minutes','missed_visit_minutes','max_visit_minutes',
    'require_visit_note','require_task_completion','signature_requirement',
    'rounding_policy','overtime_weekly_minutes','impossible_travel_kmh',
    'effective_from','effective_until'];
  v_unknown text;
  v_base public.visit_policy;
  v_new public.visit_policy;
  v_same_scope boolean := false;
  v_scheduled boolean := coalesce(p_settings ? 'effective_from', false);
  v_ignored text[] := array['id','tenant_id','scope_kind','scope_id','scope_value',
                            'version_no','effective_from','supersedes_id',
                            'change_reason','created_by','created_at'];
  v_id uuid;
  v_version int;
begin
  -- ── Gate (invariant 3 + docs/17 §5) ────────────────────────────────────────────────
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to change visit policy'
      using errcode = '42501';
  end if;
  if not app.has_perm('policy.manage') then
    raise exception 'CAREOS_FORBIDDEN: policy.manage is required' using errcode = '42501';
  end if;

  -- ── Input sanity ───────────────────────────────────────────────────────────────────
  if p_scope_kind is null or p_scope_kind not in
     ('tenant','program','payer_kind','service_type','client') then
    raise exception 'CAREOS_BAD_SCOPE: % is not a policy scope', p_scope_kind
      using errcode = 'P0001';
  end if;
  -- tenant and payer_kind name no row; the other three must.
  if (p_scope_id is null) <> (p_scope_kind in ('tenant','payer_kind')) then
    raise exception 'CAREOS_BAD_SCOPE: %',
      case when p_scope_kind in ('tenant','payer_kind')
           then 'a tenant or payer_kind policy takes no scope id'
           else 'a ' || p_scope_kind || ' policy needs a scope id' end
      using errcode = 'P0001';
  end if;
  if p_scope_kind = 'payer_kind' then
    if coalesce(p_scope_value, '') not in
       ('medicaid','medicare','private','waiver','other') then
      raise exception 'CAREOS_BAD_SCOPE: % is not a payer kind', p_scope_value
        using errcode = 'P0001';
    end if;
  elsif p_scope_value is not null then
    raise exception 'CAREOS_BAD_SCOPE: only a payer_kind policy carries a scope value'
      using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a policy change needs a reason'
      using errcode = 'P0001';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'CAREOS_BAD_SETTING: settings must be a json object'
      using errcode = 'P0001';
  end if;
  -- An unknown key is a typo that would otherwise be silently discarded, leaving the
  -- author certain they changed something they did not.
  select string_agg(k, ', ' order by k) into v_unknown
    from jsonb_object_keys(p_settings) k
   where k <> all (v_allowed);
  if v_unknown is not null then
    raise exception 'CAREOS_BAD_SETTING: unknown policy setting(s): %', v_unknown
      using errcode = 'P0001';
  end if;

  -- ── Existence: the scope must name something real in this tenant ───────────────────
  if p_scope_kind = 'client'
     and not exists (select 1 from public.client c
                      where c.id = p_scope_id and c.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
  end if;
  if p_scope_kind = 'service_type'
     and not exists (select 1 from public.service_type st
                      where st.id = p_scope_id and st.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: service type' using errcode = 'P0001';
  end if;
  -- 'program' has nothing to check against yet and is stored inert (DN-0044b).

  -- ── Serialize version assignment for this scope (the 0023/0043 lock idiom). The
  --    table is append-only, so there is no row to SELECT ... FOR UPDATE: the advisory
  --    lock IS the concurrency control, and it is what stops two authors from both
  --    computing "version 3". ───────────────────────────────────────────────────────
  perform pg_advisory_xact_lock(hashtextextended(
    'careos_vpolicy:' || v_tenant::text || ':' || p_scope_kind || ':'
    || coalesce(p_scope_id::text, '-') || ':' || coalesce(p_scope_value, '-'), 0));

  -- ── The base to merge over. For this exact scope the base is the LATEST authored
  --    version, in force or scheduled ahead — edits stack on what the last author
  --    wrote, never on a version they already replaced. ────────────────────────────
  select vp.* into v_base
    from public.visit_policy vp
   where vp.tenant_id = v_tenant
     and vp.scope_kind = p_scope_kind
     and vp.scope_id is not distinct from p_scope_id
     and vp.scope_value is not distinct from p_scope_value
   order by vp.version_no desc
   limit 1;
  v_same_scope := v_base.id is not null;

  if not v_same_scope then
    if p_scope_kind = 'tenant' then
      perform app.seed_visit_policy(v_tenant, auth.uid());   -- lay the floor first
    end if;
    select vp.* into v_base
      from public.visit_policy vp
     where vp.tenant_id = v_tenant and vp.scope_kind = 'tenant'
       and vp.effective_from <= now()
       and (vp.effective_until is null or vp.effective_until > now())
     order by vp.version_no desc
     limit 1;
    if v_base.id is null then
      raise exception
        'CAREOS_POLICY_MISSING: this agency has no visit policy — set the defaults first'
        using errcode = 'P0001';
    end if;
    v_same_scope := (p_scope_kind = 'tenant');   -- the floor we just laid IS this scope
  end if;

  -- ── The delta, applied field by field over the base ────────────────────────────────
  v_new := v_base;
  v_new.geofence_tier := coalesce(
    p_settings ->> 'geofence_tier', v_base.geofence_tier);
  v_new.geofence_radius_m := coalesce(
    (p_settings ->> 'geofence_radius_m')::int, v_base.geofence_radius_m);
  v_new.max_accuracy_m := coalesce(
    (p_settings ->> 'max_accuracy_m')::int, v_base.max_accuracy_m);
  v_new.require_clock_in_location := coalesce(
    (p_settings ->> 'require_clock_in_location')::boolean,
    v_base.require_clock_in_location);
  v_new.require_clock_out_location := coalesce(
    (p_settings ->> 'require_clock_out_location')::boolean,
    v_base.require_clock_out_location);
  v_new.allow_location_exception := coalesce(
    (p_settings ->> 'allow_location_exception')::boolean,
    v_base.allow_location_exception);
  v_new.early_clock_in_minutes := coalesce(
    (p_settings ->> 'early_clock_in_minutes')::int, v_base.early_clock_in_minutes);
  v_new.late_threshold_minutes := coalesce(
    (p_settings ->> 'late_threshold_minutes')::int, v_base.late_threshold_minutes);
  v_new.clock_out_grace_minutes := coalesce(
    (p_settings ->> 'clock_out_grace_minutes')::int, v_base.clock_out_grace_minutes);
  v_new.missing_clock_out_minutes := coalesce(
    (p_settings ->> 'missing_clock_out_minutes')::int, v_base.missing_clock_out_minutes);
  v_new.missed_visit_minutes := coalesce(
    (p_settings ->> 'missed_visit_minutes')::int, v_base.missed_visit_minutes);
  v_new.max_visit_minutes := coalesce(
    (p_settings ->> 'max_visit_minutes')::int, v_base.max_visit_minutes);
  v_new.require_visit_note := coalesce(
    (p_settings ->> 'require_visit_note')::boolean, v_base.require_visit_note);
  v_new.require_task_completion := coalesce(
    (p_settings ->> 'require_task_completion')::boolean, v_base.require_task_completion);
  v_new.signature_requirement := coalesce(
    p_settings ->> 'signature_requirement', v_base.signature_requirement);
  v_new.rounding_policy := coalesce(
    p_settings ->> 'rounding_policy', v_base.rounding_policy);
  v_new.overtime_weekly_minutes := coalesce(
    (p_settings ->> 'overtime_weekly_minutes')::int, v_base.overtime_weekly_minutes);
  v_new.impossible_travel_kmh := coalesce(
    (p_settings ->> 'impossible_travel_kmh')::int, v_base.impossible_travel_kmh);
  v_new.effective_from := coalesce(
    (p_settings ->> 'effective_from')::timestamptz, now());
  v_new.effective_until := (p_settings ->> 'effective_until')::timestamptz;
  if v_new.effective_until is not null
     and v_new.effective_until <= v_new.effective_from then
    raise exception 'CAREOS_BAD_WINDOW: a policy must end after it starts'
      using errcode = 'P0001';
  end if;

  -- Idempotence is a RETURN VALUE, never an error (the 0023 assign_visit posture): a
  -- save button pressed twice must not spawn a second identical version. A scheduled
  -- change (an explicit effective_from) is never "unchanged" — the schedule is the
  -- change.
  if v_same_scope and not v_scheduled
     and (to_jsonb(v_new) - v_ignored) = (to_jsonb(v_base) - v_ignored) then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'policy_id', v_base.id,
                              'scope_kind', v_base.scope_kind,
                              'scope_id', v_base.scope_id,
                              'scope_value', v_base.scope_value,
                              'version_no', v_base.version_no);
  end if;

  insert into public.visit_policy (
    tenant_id, scope_kind, scope_id, scope_value, version_no,
    effective_from, effective_until,
    geofence_tier, geofence_radius_m, max_accuracy_m,
    require_clock_in_location, require_clock_out_location, allow_location_exception,
    early_clock_in_minutes, late_threshold_minutes, clock_out_grace_minutes,
    missing_clock_out_minutes, missed_visit_minutes, max_visit_minutes,
    require_visit_note, require_task_completion, signature_requirement,
    rounding_policy, overtime_weekly_minutes, impossible_travel_kmh,
    supersedes_id, change_reason, created_by)
  values (
    v_tenant, p_scope_kind, p_scope_id, p_scope_value,
    case when v_same_scope then v_base.version_no + 1 else 1 end,
    v_new.effective_from, v_new.effective_until,
    v_new.geofence_tier, v_new.geofence_radius_m, v_new.max_accuracy_m,
    v_new.require_clock_in_location, v_new.require_clock_out_location,
    v_new.allow_location_exception,
    v_new.early_clock_in_minutes, v_new.late_threshold_minutes,
    v_new.clock_out_grace_minutes, v_new.missing_clock_out_minutes,
    v_new.missed_visit_minutes, v_new.max_visit_minutes,
    v_new.require_visit_note, v_new.require_task_completion,
    v_new.signature_requirement,
    v_new.rounding_policy, v_new.overtime_weekly_minutes, v_new.impossible_travel_kmh,
    -- A new scope inherits VALUES from the floor but supersedes nothing: it starts its
    -- own chain. Only a same-scope append carries supersedes_id.
    case when v_same_scope then v_base.id else null end,
    btrim(p_reason), auth.uid())
  returning id, version_no into v_id, v_version;

  -- Audit lands on the ledger through trg_visit_policy_audit; the outbox is the RPC's
  -- job (the 0043 posture for RPC-only tables). IDs + enums only — the reason text is
  -- deliberately absent from both (invariant 5).
  perform app.emit_event_internal(v_tenant, auth.uid(), 'policy.updated',
    'visit_policy', v_id,
    jsonb_build_object('scope_kind', p_scope_kind, 'scope_id', p_scope_id,
                       'scope_value', p_scope_value, 'version_no', v_version));

  return jsonb_build_object('ok', true, 'policy_id', v_id,
                            'scope_kind', p_scope_kind,
                            'scope_id', p_scope_id,
                            'scope_value', p_scope_value,
                            'version_no', v_version,
                            'supersedes_id',
                            case when v_same_scope then v_base.id else null end);
end $$;

revoke all on function app.upsert_visit_policy(text, uuid, text, jsonb, text)
  from public, anon;
grant execute on function app.upsert_visit_policy(text, uuid, text, jsonb, text)
  to authenticated;
