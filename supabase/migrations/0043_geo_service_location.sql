-- ST-201 · Migration 0043 — geo primitives + the versioned service-location spine
-- The first slice of the Verified Visit layer (docs/17 §3.1–3.3, §4.1, §6.1). Nothing
-- here clocks a visit; this migration answers the question every later slice asks —
-- "where is this client's care supposed to happen, and who says so?"
--
-- PostGIS finally lands. 0004 deferred client geo explicitly ("geo/geofence columns land
-- with the EVV migration") and 0011 deliberately kept the scheduling spine pure-Postgres
-- ("PostGIS is deliberately NOT introduced here"). This is the migration both of them
-- were pointing at. The extension is installed into `extensions` (the Supabase
-- convention, already granted USAGE in 0001), so the `geography` type is referenced
-- schema-qualified everywhere and no PostGIS object lands in `public`.
--
-- D-025 — no geocoding vendor, ever, on this boundary. Client addresses are PHI and
-- Google Maps Platform is not BAA-eligible, so the corpus buys the *seam* and not the
-- vendor: app.normalize_address() is deterministic in-database folding used for
-- comparison and dedupe (NEVER validation — it cannot tell you an address exists), and a
-- trusted coordinate arrives only from a human who attests it. The attestation is
-- structural, not procedural: chk_slv_verified_needs_human makes a 'verified' row
-- impossible without verified_by + verified_at, and verified_by FKs public.app_user, so
-- an AI capability can never satisfy it (the D-015 pattern). geo_source/geo_provider*
-- exist unused so that registering a BAA-eligible provider later is a row, not a DDL.
--
-- Versioning follows the form_template/form_version binding precedent (0005/0006, D-014):
-- service_location is the durable identity of a place, service_location_version [AO] is
-- the geographic source of truth, and a verified visit will bind the exact version it was
-- verified against — so correcting an address can never rewrite what a clock-in meant.
-- CONSEQUENCE, surfaced rather than smuggled: docs/17 §6.1 names verify_service_location
-- and set_service_location_geofence with a p_version parameter, which reads like an
-- in-place edit of that version. Invariant 1 forbids that and the table is [AO], so both
-- RPCs APPEND a new version carrying the change and supersedes_id = p_version. The
-- observable contract (same names, same parameters, same effect on "the current record")
-- is unchanged; the history is now honest.
--
-- D-030 — coordinates are PHI-by-linkage and their capture points are closed. No audit
-- payload, outbox payload or return value in this file carries a latitude, a longitude or
-- a distance: the audit trigger carries a `located` boolean and the precision enum, which
-- is what a surveyor actually needs to see. 0013 already excluded lat/lng from the
-- visit_event audit payload by instinct; this generalises it.
--
-- Write posture: service_location and service_location_version take the 0023 Lane-B
-- perimeter (zero write grants — the four §6.1 RPCs are the only way in), because version
-- numbering, current-version binding and the human attestation are all invariants that a
-- direct INSERT could violate. service_type keeps 0011's catalog posture (permission-gated
-- direct grants) because it is CFG, not PHI, and carries no ledger semantics.
--
-- DN-0043c — docs/17 §8 enumerates the visit/EVV/payroll outbox events and stops there;
-- it names none for locations. Rather than emit nothing (invariant 7's second half binds
-- every consequential act) or invent a parallel vocabulary, the four §6.1 RPCs emit
-- `location.created`, `location.revised`, `location.verified` and `location.geofence_set`
-- in the `<entity>.<past-tense>` shape 0027 established. Flagged so §8's table can absorb
-- them rather than a later slice inventing a second set.
-- @trace: ST-201, D-025, D-030, docs/17 §3.1, §3.2, §3.3, §4.1, §6.1

create extension if not exists postgis with schema extensions;

-- ── Permission catalog (docs/17 §5 — real config, so it belongs in the migration,
--    not the synthetic seed; per-tenant role grants are wired in the seed / 0031) ──────
insert into public.permission (key, description) values
  ('location.manage', 'Create and revise service locations, and attest their geocodes')
on conflict (key) do nothing;

-- ═══ §4.1 · Geo primitives — Engine 1 only (invariant 13: no LLM decides a fact) ══════

-- Deterministic normalisation for COMPARISON and DEDUPE — never validation. It answers
-- "are these two strings the same place as written?", never "does this place exist?"
-- (that question needs a geocoding vendor, which D-025 refuses). Folding is USPS
-- Publication 28 style: uppercase, strip punctuation, collapse whitespace, then fold
-- directionals and street-suffix/unit designators to their standard abbreviations.
-- Every fold is anchored with \m…\M (whole word), so 'NORTH AVENUE' → 'N AVE' while a
-- token that merely CONTAINS a keyword ('WESTMINSTER') is left alone.
create or replace function app.normalize_address(
  p_line1 text, p_line2 text, p_city text, p_state text,
  p_postal text, p_country text default 'US'
) returns text
language sql immutable set search_path = public as $$
  with joined as (
    -- Plain `||`, not array_to_string()/concat_ws(): both of those are declared STABLE
    -- (they reach for element output functions), and an IMMUTABLE wrapper around a
    -- STABLE callee is a lie the planner believes — the landmine that detonates the day
    -- someone indexes normalized_address for dedupe. `||`, coalesce, nullif and btrim
    -- are all immutable, so this function is immutable in FACT and not merely by
    -- declaration. A null or blank component contributes nothing to the join.
    select coalesce(nullif(btrim(coalesce(p_line1,   '')), '') || ' ', '')
        || coalesce(nullif(btrim(coalesce(p_line2,   '')), '') || ' ', '')
        || coalesce(nullif(btrim(coalesce(p_city,    '')), '') || ' ', '')
        || coalesce(nullif(btrim(coalesce(p_state,   '')), '') || ' ', '')
        || coalesce(nullif(btrim(coalesce(p_postal,  '')), '') || ' ', '')
        || coalesce(nullif(btrim(coalesce(p_country, 'US')), '') || ' ', '') as raw
  ), stripped as (
    -- '1600 N. Main St., Apt #2' and '1600 N Main St Apt 2' must converge here.
    select btrim(regexp_replace(
             regexp_replace(upper(raw), '[[:punct:]]+', ' ', 'g'),
             '\s+', ' ', 'g')) as s
      from joined
  ), dir as (   -- directionals first, so NORTH AVENUE becomes N AVENUE then N AVE
    select regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(regexp_replace(regexp_replace(regexp_replace(s,
             '\mNORTHEAST\M', 'NE', 'g'), '\mNORTHWEST\M', 'NW', 'g'),
             '\mSOUTHEAST\M', 'SE', 'g'), '\mSOUTHWEST\M', 'SW', 'g'),
             '\mNORTH\M',     'N',  'g'), '\mSOUTH\M',     'S',  'g'),
             '\mEAST\M',      'E',  'g'), '\mWEST\M',      'W',  'g') as s
      from stripped
  ), sfx as (   -- street suffixes + unit designators; no output token is a later pattern
    select regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(regexp_replace(s,
             '\mAVENUE\M',    'AVE',  'g'), '\mSTREET\M',    'ST',   'g'),
             '\mROAD\M',      'RD',   'g'), '\mDRIVE\M',     'DR',   'g'),
             '\mBOULEVARD\M', 'BLVD', 'g'), '\mCOURT\M',     'CT',   'g'),
             '\mLANE\M',      'LN',   'g'), '\mPLACE\M',     'PL',   'g'),
             '\mTERRACE\M',   'TER',  'g'), '\mCIRCLE\M',    'CIR',  'g'),
             '\mPARKWAY\M',   'PKWY', 'g'), '\mHIGHWAY\M',   'HWY',  'g'),
             '\mSUITE\M',     'STE',  'g'), '\mAPARTMENT\M', 'APT',  'g') as s
      from dir
  )
  select nullif(btrim(s), '') from sfx
$$;

-- A point, or nothing. Out-of-range input is not an error to raise at the caller — a
-- browser Geolocation reading can legitimately be garbage — it is an absent geocode,
-- which downstream evaluates as location_status='unavailable' (docs/17 §4.3).
create or replace function app.geo_point(
  p_lat double precision, p_lng double precision
) returns extensions.geography
language sql immutable set search_path = public, extensions as $$
  select case
           when p_lat is null or p_lng is null                 then null
           when p_lat < -90  or p_lat > 90                     then null
           when p_lng < -180 or p_lng > 180                    then null
           -- ST_MakePoint is (x, y) = (longitude, latitude): the order everyone gets
           -- wrong once. 4326 + geography ⇒ metres on a spheroid, not degrees.
           else extensions.ST_SetSRID(
                  extensions.ST_MakePoint(p_lng, p_lat), 4326)::extensions.geography
         end
$$;

-- Metres between a stored location and a captured reading. NULL in ⇒ NULL out (strict
-- by construction), which the clock engine reads as "no distance known".
create or replace function app.distance_m(
  p_geo extensions.geography, p_lat double precision, p_lng double precision
) returns double precision
language sql immutable set search_path = public, extensions as $$
  select case when p_geo is null then null
              else extensions.ST_Distance(p_geo, app.geo_point(p_lat, p_lng)) end
$$;

-- Internal plumbing: called from the definer RPC bodies below and from the 0046 clock
-- engine, never by a client. No grant to any client-facing role (0007 posture).
revoke all on function
  app.normalize_address(text, text, text, text, text, text),
  app.geo_point(double precision, double precision),
  app.distance_m(extensions.geography, double precision, double precision)
from public, anon, authenticated;

-- ═══ Audit emitters (definer; IDs + enums only — never an address, never a point) ═════

create or replace function app.audit_service_type() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('service_type.created', 'service_type', new.id,
      jsonb_build_object('code', new.code,        -- catalog code, not client content
                         'payer_kind', new.payer_kind,
                         'evv_required', new.evv_required));
  elsif tg_op = 'UPDATE' then
    -- Only the compliance-bearing flags are worth a ledger row; renaming a catalog
    -- entry is not a consequential act.
    if new.evv_required is distinct from old.evv_required
       or new.billable is distinct from old.billable
       or new.payer_kind is distinct from old.payer_kind
       or new.active is distinct from old.active then
      perform app.emit_audit('service_type.updated', 'service_type', new.id,
        jsonb_build_object('code', new.code,
                           'from', jsonb_build_object('evv_required', old.evv_required,
                                                      'billable', old.billable,
                                                      'payer_kind', old.payer_kind,
                                                      'active', old.active),
                           'to',   jsonb_build_object('evv_required', new.evv_required,
                                                      'billable', new.billable,
                                                      'payer_kind', new.payer_kind,
                                                      'active', new.active)));
    end if;
  end if;
  return null;                                    -- AFTER trigger: result ignored
end $$;

-- `label` is free text a coordinator typed ("Daughter's house") and is therefore PHI-
-- adjacent; it never enters a payload. Nor does any address component (invariant 5).
create or replace function app.audit_service_location() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('service_location.created', 'service_location', new.id,
      jsonb_build_object('client_id', new.client_id, 'kind', new.kind,
                         'is_primary', new.is_primary));
  elsif tg_op = 'UPDATE' then
    -- The FIRST binding of current_version_id is the tail of creation (the version row
    -- cannot exist before its parent), so it is not a second, confusing ledger entry.
    if new.current_version_id is distinct from old.current_version_id
       and old.current_version_id is not null then
      perform app.emit_audit('service_location.version_bound', 'service_location', new.id,
        jsonb_build_object('client_id', new.client_id,
                           'from_version', old.current_version_id,
                           'to_version', new.current_version_id));
    end if;
    if new.is_primary is distinct from old.is_primary then
      perform app.emit_audit('service_location.primary_changed', 'service_location', new.id,
        jsonb_build_object('client_id', new.client_id,
                           'from', old.is_primary, 'to', new.is_primary));
    end if;
    if new.active is distinct from old.active then
      perform app.emit_audit('service_location.active_changed', 'service_location', new.id,
        jsonb_build_object('client_id', new.client_id,
                           'from', old.active, 'to', new.active));
    end if;
  end if;
  return null;                                    -- AFTER trigger: result ignored
end $$;

-- `located` is a boolean, not a coordinate: a surveyor asking "was this address ever
-- pinned, by whom, and how precisely?" gets a complete answer with zero geo leakage
-- (D-030). normalized_address is likewise absent — it is still the client's home.
create or replace function app.audit_service_location_version() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('service_location_version.created',
    'service_location_version', new.id,
    jsonb_build_object('service_location_id', new.service_location_id,
                       'version_no', new.version_no,
                       'supersedes_id', new.supersedes_id,
                       'geo_precision', new.geo_precision,
                       'geo_source', new.geo_source,
                       'verification', new.verification,
                       'verified_by', new.verified_by,
                       'located', new.geo is not null));   -- never the point itself
  return null;                                    -- AFTER trigger: result ignored
end $$;

revoke all on function app.audit_service_type()             from public;
revoke all on function app.audit_service_location()         from public;
revoke all on function app.audit_service_location_version() from public;

-- ═══ §3.1 · service_type — the "type of service" EVV element ══════════════════════════
create table public.service_type (                                                -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  code text not null,                             -- 'PCA','CNA','RN_SUPERVISORY',…
  name text not null,
  evv_required boolean not null default false,
  payer_kind text not null default 'private'
    check (payer_kind in ('medicaid','medicare','private','waiver','other')),
  billable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint uq_service_type_tenant_code unique (tenant_id, code)
);
create index idx_service_type_tenant on public.service_type (tenant_id);

create trigger trg_service_type_audit after insert or update on public.service_type
  for each row execute function app.audit_service_type();

alter table public.service_type enable row level security;
alter table public.service_type force row level security;

-- A catalog, not PHI: every tenant member reads it (a caregiver's own visit names a
-- service type), and schedule.write authors it — the 0011 grant posture, not the 0023
-- RPC posture, because no ledger or version semantics ride on these rows.
create policy service_type_select_member on public.service_type for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy service_type_insert_scheduler on public.service_type for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_perm('schedule.write'));
create policy service_type_update_scheduler on public.service_type for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('schedule.write'))
  with check (tenant_id = app.current_tenant_id());

grant select, insert, update on public.service_type to authenticated;   -- RLS gates rows

-- ═══ §3.2 · service_location — the durable identity of a place of care ════════════════
create table public.service_location (                                            -- PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  current_version_id uuid,                        -- → service_location_version(id) below
  kind text not null check (kind in
    ('primary_residence','temporary_residence','family_residence',
     'community','facility','alternate')),
  label text,                                     -- 'Home', 'Daughter''s house' — PHI-adjacent
  is_primary boolean not null default false,
  effective_from date not null default current_date,
  effective_until date,
  active boolean not null default true,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint chk_service_location_effective_window
    check (effective_until is null or effective_until >= effective_from)
);
create index idx_service_location_tenant on public.service_location (tenant_id);
create index idx_service_location_client on public.service_location (client_id, kind);
-- The clock engine (0046) resolves "the client's primary place" on every clock-in, and
-- two live primaries would make that resolution ambiguous. DN-0043a: docs/17 §3.2 leaves
-- is_primary unconstrained; uniqueness is enforced here and maintained by
-- app.create_service_location, which demotes the incumbent in the same transaction.
create unique index uq_service_location_primary
  on public.service_location (tenant_id, client_id)
  where is_primary and active;

create trigger trg_service_location_audit after insert or update on public.service_location
  for each row execute function app.audit_service_location();

alter table public.service_location enable row level security;
alter table public.service_location force row level security;

-- PHI (a client's home address) ⇒ AAL2, per docs/17 §3.2. Three lawful readers: the
-- location administrator, the client's care team, and the caregiver actually sent there.
-- DN-0043b: §3.2 words the third as "assigned caregiver on a visit AT THIS LOCATION",
-- which needs visit.service_location_id — a column 0045 adds. Until then the disjunct is
-- scoped to the client (a caregiver assigned to a visit for this client), which is the
-- narrowest predicate expressible today and is exactly what they need to find the door.
-- 0045 tightens it to the bound location.
create policy service_location_select_scoped on public.service_location
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('location.manage')
      or app.on_care_team(client_id)
      or exists (select 1 from public.visit v
                  where v.client_id = service_location.client_id
                    and v.caregiver_id = auth.uid()
                    and v.tenant_id = app.current_tenant_id())
    ));

grant select on public.service_location to authenticated;   -- §6.1 RPCs are the only writers

-- ═══ §3.3 · service_location_version — [AO] the geographic source of truth ════════════
create table public.service_location_version (                              -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  service_location_id uuid not null references public.service_location(id),
  supersedes_id uuid references public.service_location_version(id),
  created_by uuid not null references public.app_user(id),
  version_no int not null,                        -- server-assigned, 1-based, never client
  original_address text not null,                 -- exactly as entered
  normalized_address text not null,               -- app.normalize_address()
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text not null default 'US',
  geo extensions.geography(Point,4326),           -- NULL ⇒ unlocatable; see geo_precision
  geo_precision text not null default 'unknown' check (geo_precision in
    ('rooftop','parcel','interpolated','street','locality','manual','unknown')),
  geo_source text not null default 'manual' check (geo_source in
    ('manual','import','provider','derived')),
  geo_provider text,                              -- NULL unless an adapter supplied it
  geo_provider_place_id text,
  geo_provider_response_sha256 text,              -- provenance, never the raw response
  verification text not null default 'unverified'
    check (verification in ('unverified','verified','rejected')),
  verified_by uuid references public.app_user(id),          -- human attestation (D-025)
  verified_at timestamptz,
  geofence_radius_m int check (geofence_radius_m between 25 and 5000),  -- NULL ⇒ policy
  change_reason text,
  created_at timestamptz not null default now(),
  constraint uq_slv_location_version unique (service_location_id, version_no),
  -- D-025 made structural: 'verified' is unreachable without a named human and a time.
  constraint chk_slv_verified_needs_human
    check (verification <> 'verified'
           or (verified_by is not null and verified_at is not null))
);
create index idx_slv_tenant on public.service_location_version (tenant_id);
create index idx_slv_location on public.service_location_version
  (service_location_id, version_no desc);
-- Spatial lookups (0047 impossible-travel, future proximity search) only ever touch
-- located versions; the partial index keeps the unlocatable backlog out of the tree.
create index idx_slv_geo on public.service_location_version using gist (geo)
  where geo is not null;

-- Immutable history: an address is corrected by appending a version, never by editing
-- one — otherwise a verified visit's geofence could be rewritten after the fact.
create trigger trg_slv_ao before update or delete on public.service_location_version
  for each row execute function app.forbid_mutation();
create trigger trg_slv_audit after insert on public.service_location_version
  for each row execute function app.audit_service_location_version();

alter table public.service_location_version enable row level security;
alter table public.service_location_version force row level security;

-- Read follows the parent, literally: the EXISTS subquery is itself evaluated under
-- service_location_select_scoped (RLS applies inside policy subqueries), so the read rule
-- has exactly ONE definition and cannot drift from the parent's. The tenant predicate and
-- the AAL2 gate stay top-level so this policy is legible on its own.
create policy service_location_version_select_parent on public.service_location_version
  for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2()
    and exists (select 1 from public.service_location sl
                 where sl.id = service_location_version.service_location_id));

-- Append-only, and RPC-only on the way in: no insert/update/delete grant, ever.
grant select on public.service_location_version to authenticated;

-- The circular reference, closed now that both tables exist (the 0004 fk_cta_client
-- idiom). current_version_id is a projection of the ledger, maintained by RPCs only.
alter table public.service_location
  add constraint fk_service_location_current_version
  foreign key (current_version_id) references public.service_location_version(id);

-- ═══ §6.1 · Lane-B write paths — the only way into a location or a version ════════════

-- Shared gate. Every §6.1 RPC is an administrative act on PHI: AAL2 (invariant 3) plus
-- location.manage (docs/17 §5). Mirrors app.assert_scheduler (0023).
create or replace function app.assert_location_manager() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to change a service location'
      using errcode = '42501';
  end if;
  if not app.has_perm('location.manage') then
    raise exception 'CAREOS_FORBIDDEN: location.manage is required' using errcode = '42501';
  end if;
end $$;

-- app.create_service_location — a new place of care, at version 1, unverified.
-- Version 1 never carries a geocode: D-025 says a coordinate arrives only by human
-- attestation, so the pin is a separate, deliberate act (verify_service_location).
create or replace function app.create_service_location(
  p_client uuid, p_kind text, p_label text, p_address jsonb,
  p_is_primary boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_line1 text; v_line2 text; v_city text;
  v_state text; v_postal text; v_country text;
  v_original text;
  v_normalized text;
  v_location uuid;
  v_version uuid;
begin
  perform app.assert_location_manager();
  if p_kind is null or p_kind not in
     ('primary_residence','temporary_residence','family_residence',
      'community','facility','alternate') then
    raise exception 'CAREOS_BAD_KIND: % is not a service-location kind', p_kind
      using errcode = 'P0001';
  end if;
  v_line1   := nullif(btrim(coalesce(p_address ->> 'line1',   '')), '');
  v_line2   := nullif(btrim(coalesce(p_address ->> 'line2',   '')), '');
  v_city    := nullif(btrim(coalesce(p_address ->> 'city',    '')), '');
  v_state   := nullif(btrim(coalesce(p_address ->> 'state',   '')), '');
  v_postal  := nullif(btrim(coalesce(p_address ->> 'postal_code', '')), '');
  v_country := coalesce(nullif(btrim(coalesce(p_address ->> 'country', '')), ''), 'US');
  if v_line1 is null then
    raise exception 'CAREOS_BAD_ADDRESS: a street line is required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.client c
                  where c.id = p_client and c.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
  end if;

  -- Per-client advisory lock: two coordinators adding a primary residence at the same
  -- moment must serialize, or uq_service_location_primary decides the winner by
  -- deadlock instead of by order. Same key shape as the 0023/0024 scheduling lock.
  perform pg_advisory_xact_lock(hashtextextended('careos_svcloc:' || p_client::text, 0));

  v_original := array_to_string(array[
                  v_line1, v_line2, v_city,
                  nullif(btrim(concat_ws(' ', v_state, v_postal)), ''),
                  v_country], ', ');
  v_normalized := app.normalize_address(v_line1, v_line2, v_city, v_state,
                                        v_postal, v_country);

  if p_is_primary then
    -- A single live primary per client (uq_service_location_primary); the incumbent is
    -- demoted, never deleted, and the demotion lands on the ledger via the trigger.
    update public.service_location
       set is_primary = false, updated_at = now(), row_version = row_version + 1
     where tenant_id = v_tenant and client_id = p_client
       and is_primary and active;
  end if;

  insert into public.service_location
    (tenant_id, client_id, kind, label, is_primary, created_by)
  values (v_tenant, p_client, p_kind, p_label, coalesce(p_is_primary, false), auth.uid())
  returning id into v_location;

  insert into public.service_location_version
    (tenant_id, service_location_id, created_by, version_no,
     original_address, normalized_address,
     address_line1, address_line2, city, state, postal_code, country)
  values (v_tenant, v_location, auth.uid(), 1,
          v_original, v_normalized,
          v_line1, v_line2, v_city, v_state, v_postal, v_country)
  returning id into v_version;

  -- Initial binding is the tail of creation, not a second event (see the audit trigger).
  update public.service_location set current_version_id = v_version where id = v_location;

  perform app.emit_event_internal(v_tenant, auth.uid(), 'location.created',
    'service_location', v_location,
    jsonb_build_object('client_id', p_client, 'version_id', v_version,
                       'kind', p_kind));   -- IDs + enums only (invariant 5)

  return jsonb_build_object('ok', true, 'location_id', v_location,
                            'version_id', v_version, 'version_no', 1,
                            'verification', 'unverified');
end $$;

-- app.revise_service_location — the address changed. ALWAYS a new version; the previous
-- one keeps its geocode and its attestation so any visit bound to it still means what it
-- meant. The new version starts unverified with no geo, because a human attested the OLD
-- pin, not this one (D-025). The geofence radius is a policy setting about the place, not
-- the string, so it carries forward.
create or replace function app.revise_service_location(
  p_location uuid, p_address jsonb, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_loc public.service_location;
  v_cur public.service_location_version;
  v_line1 text; v_line2 text; v_city text;
  v_state text; v_postal text; v_country text;
  v_original text;
  v_normalized text;
  v_no int;
  v_version uuid;
begin
  perform app.assert_location_manager();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: revising an address needs a reason'
      using errcode = 'P0001';
  end if;
  v_line1   := nullif(btrim(coalesce(p_address ->> 'line1',   '')), '');
  v_line2   := nullif(btrim(coalesce(p_address ->> 'line2',   '')), '');
  v_city    := nullif(btrim(coalesce(p_address ->> 'city',    '')), '');
  v_state   := nullif(btrim(coalesce(p_address ->> 'state',   '')), '');
  v_postal  := nullif(btrim(coalesce(p_address ->> 'postal_code', '')), '');
  v_country := coalesce(nullif(btrim(coalesce(p_address ->> 'country', '')), ''), 'US');
  if v_line1 is null then
    raise exception 'CAREOS_BAD_ADDRESS: a street line is required' using errcode = 'P0001';
  end if;

  -- The parent row lock serializes version_no assignment (the 0006 save_draft idiom).
  select * into v_loc from public.service_location
   where id = p_location and tenant_id = v_tenant
   for update;
  if v_loc.id is null then
    raise exception 'CAREOS_NOT_FOUND: service location' using errcode = 'P0001';
  end if;
  if not v_loc.active then
    raise exception 'CAREOS_BAD_STATE: an inactive service location cannot be revised'
      using errcode = 'P0001';
  end if;

  select * into v_cur from public.service_location_version
   where service_location_id = v_loc.id
   order by version_no desc limit 1;

  v_normalized := app.normalize_address(v_line1, v_line2, v_city, v_state,
                                        v_postal, v_country);
  if v_cur.id is not null and v_cur.normalized_address = v_normalized then
    -- Same place as written ⇒ nothing to record. Idempotency is a return value, never
    -- an error (a retried save must not manufacture version churn).
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'location_id', v_loc.id, 'version_id', v_cur.id,
                              'version_no', v_cur.version_no);
  end if;

  v_original := array_to_string(array[
                  v_line1, v_line2, v_city,
                  nullif(btrim(concat_ws(' ', v_state, v_postal)), ''),
                  v_country], ', ');
  v_no := coalesce(v_cur.version_no, 0) + 1;

  insert into public.service_location_version
    (tenant_id, service_location_id, supersedes_id, created_by, version_no,
     original_address, normalized_address,
     address_line1, address_line2, city, state, postal_code, country,
     geofence_radius_m, change_reason)
  values (v_tenant, v_loc.id, v_cur.id, auth.uid(), v_no,
          v_original, v_normalized,
          v_line1, v_line2, v_city, v_state, v_postal, v_country,
          v_cur.geofence_radius_m, p_reason)
  returning id into v_version;

  update public.service_location
     set current_version_id = v_version, updated_at = now(),
         row_version = row_version + 1
   where id = v_loc.id;

  perform app.emit_event_internal(v_tenant, auth.uid(), 'location.revised',
    'service_location', v_loc.id,
    jsonb_build_object('client_id', v_loc.client_id, 'version_id', v_version,
                       'version_no', v_no, 'supersedes_id', v_cur.id));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'location_id', v_loc.id, 'version_id', v_version,
                            'version_no', v_no, 'verification', 'unverified');
end $$;

-- app.verify_service_location — a human puts the pin on the map and signs for it.
-- Appends a version identical in address to p_version but carrying geo, precision, and
-- the attestation (verified_by = the caller, verified_at = now). p_version must be the
-- location's CURRENT version, so an attestation can never be attached to superseded text.
create or replace function app.verify_service_location(
  p_version uuid, p_lat double precision, p_lng double precision,
  p_precision text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_cur public.service_location_version;
  v_loc public.service_location;
  v_geo extensions.geography;
  v_no int;
  v_version uuid;
begin
  perform app.assert_location_manager();
  if p_precision is null or p_precision not in
     ('rooftop','parcel','interpolated','street','locality','manual','unknown') then
    raise exception 'CAREOS_BAD_PRECISION: % is not a geocode precision', p_precision
      using errcode = 'P0001';
  end if;
  v_geo := app.geo_point(p_lat, p_lng);
  if v_geo is null then
    -- Deliberately no coordinates in the message: errors travel further than rows.
    raise exception
      'CAREOS_BAD_COORDINATES: latitude and longitude are missing or out of range'
      using errcode = 'P0001';
  end if;

  select * into v_cur from public.service_location_version
   where id = p_version and tenant_id = v_tenant;
  if v_cur.id is null then
    raise exception 'CAREOS_NOT_FOUND: service location version' using errcode = 'P0001';
  end if;
  select * into v_loc from public.service_location
   where id = v_cur.service_location_id and tenant_id = v_tenant
   for update;                                    -- serializes version_no assignment
  if v_loc.current_version_id is distinct from p_version then
    raise exception 'CAREOS_STALE_VERSION: a newer version of this location exists'
      using errcode = 'P0001';
  end if;
  if v_cur.verification = 'verified'
     and v_cur.geo_precision = p_precision
     and v_cur.geo is not distinct from v_geo then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'location_id', v_loc.id, 'version_id', v_cur.id,
                              'version_no', v_cur.version_no,
                              'verification', 'verified');
  end if;

  v_no := v_cur.version_no + 1;
  insert into public.service_location_version
    (tenant_id, service_location_id, supersedes_id, created_by, version_no,
     original_address, normalized_address,
     address_line1, address_line2, city, state, postal_code, country,
     geo, geo_precision, geo_source, verification, verified_by, verified_at,
     geofence_radius_m, change_reason)
  values (v_tenant, v_loc.id, v_cur.id, auth.uid(), v_no,
          v_cur.original_address, v_cur.normalized_address,
          v_cur.address_line1, v_cur.address_line2, v_cur.city, v_cur.state,
          v_cur.postal_code, v_cur.country,
          v_geo, p_precision, 'manual', 'verified', auth.uid(), now(),
          v_cur.geofence_radius_m, p_note)
  returning id into v_version;

  update public.service_location
     set current_version_id = v_version, updated_at = now(),
         row_version = row_version + 1
   where id = v_loc.id;

  perform app.emit_event_internal(v_tenant, auth.uid(), 'location.verified',
    'service_location', v_loc.id,
    jsonb_build_object('client_id', v_loc.client_id, 'version_id', v_version,
                       'version_no', v_no,
                       'geo_precision', p_precision));   -- enum, never the point (D-030)

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'location_id', v_loc.id, 'version_id', v_version,
                            'version_no', v_no, 'verification', 'verified',
                            'geo_precision', p_precision);
end $$;

-- app.set_service_location_geofence — a per-location radius override of the policy
-- default (docs/17 §3.4 resolves the default). Also an append: the radius is part of the
-- geographic record a clock-in binds to, so changing it must not rewrite past bindings.
-- The human attestation carries forward untouched — the address did not change, so the
-- signature on it still stands.
create or replace function app.set_service_location_geofence(
  p_version uuid, p_radius_m int, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_cur public.service_location_version;
  v_loc public.service_location;
  v_no int;
  v_version uuid;
begin
  perform app.assert_location_manager();
  if p_radius_m is null or p_radius_m < 25 or p_radius_m > 5000 then
    raise exception 'CAREOS_BAD_RADIUS: a geofence radius must be between 25 and 5000 metres'
      using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: changing a geofence needs a reason'
      using errcode = 'P0001';
  end if;

  select * into v_cur from public.service_location_version
   where id = p_version and tenant_id = v_tenant;
  if v_cur.id is null then
    raise exception 'CAREOS_NOT_FOUND: service location version' using errcode = 'P0001';
  end if;
  select * into v_loc from public.service_location
   where id = v_cur.service_location_id and tenant_id = v_tenant
   for update;
  if v_loc.current_version_id is distinct from p_version then
    raise exception 'CAREOS_STALE_VERSION: a newer version of this location exists'
      using errcode = 'P0001';
  end if;
  if v_cur.geofence_radius_m is not distinct from p_radius_m then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'location_id', v_loc.id, 'version_id', v_cur.id,
                              'version_no', v_cur.version_no,
                              'geofence_radius_m', p_radius_m);
  end if;

  v_no := v_cur.version_no + 1;
  insert into public.service_location_version
    (tenant_id, service_location_id, supersedes_id, created_by, version_no,
     original_address, normalized_address,
     address_line1, address_line2, city, state, postal_code, country,
     geo, geo_precision, geo_source, geo_provider, geo_provider_place_id,
     geo_provider_response_sha256,
     verification, verified_by, verified_at, geofence_radius_m, change_reason)
  values (v_tenant, v_loc.id, v_cur.id, auth.uid(), v_no,
          v_cur.original_address, v_cur.normalized_address,
          v_cur.address_line1, v_cur.address_line2, v_cur.city, v_cur.state,
          v_cur.postal_code, v_cur.country,
          v_cur.geo, v_cur.geo_precision, v_cur.geo_source, v_cur.geo_provider,
          v_cur.geo_provider_place_id, v_cur.geo_provider_response_sha256,
          v_cur.verification, v_cur.verified_by, v_cur.verified_at,
          p_radius_m, p_reason)
  returning id into v_version;

  update public.service_location
     set current_version_id = v_version, updated_at = now(),
         row_version = row_version + 1
   where id = v_loc.id;

  perform app.emit_event_internal(v_tenant, auth.uid(), 'location.geofence_set',
    'service_location', v_loc.id,
    jsonb_build_object('client_id', v_loc.client_id, 'version_id', v_version,
                       'version_no', v_no, 'radius_m', p_radius_m));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'location_id', v_loc.id, 'version_id', v_version,
                            'version_no', v_no, 'geofence_radius_m', p_radius_m);
end $$;

-- ── Grants: the four §6.1 RPCs in, everything else out (invariant 6 — user-scoped
--    callers only; no service_role anywhere on this request path) ──────────────────────
revoke all on function app.assert_location_manager() from public, anon;
grant execute on function app.assert_location_manager() to authenticated;

revoke all on function
  app.create_service_location(uuid, text, text, jsonb, boolean),
  app.revise_service_location(uuid, jsonb, text),
  app.verify_service_location(uuid, double precision, double precision, text, text),
  app.set_service_location_geofence(uuid, int, text)
from public, anon;
grant execute on function
  app.create_service_location(uuid, text, text, jsonb, boolean),
  app.revise_service_location(uuid, jsonb, text),
  app.verify_service_location(uuid, double precision, double precision, text, text),
  app.set_service_location_geofence(uuid, int, text)
to authenticated;
