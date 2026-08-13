-- ST-200 · Verified Visit & Workforce Intelligence — the Meadowbrook demonstration slice
-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Synthetic only (D-006, invariant 4). Every coordinate below is a jittered point over a
-- Montgomery County MD town centre; every name it hangs off already exists in the
-- synthetic universe. No real address, no real person, no production data — ever.
--
-- WHY THIS FILE EXISTS. Migrations 0043–0052 ship four idempotent bootstrap functions and
-- each one is invoked at migration time with `select app.seed_*(t.id) from public.tenant t`
-- — which covers hosted, where the tenant already exists. Local and preview build the
-- Meadowbrook tenant in supabase/seeds/ AFTER migrations run, so those tenants get
-- nothing: no policy floor (every clock-in fails CAREOS_POLICY_MISSING), no EVV adapter,
-- no capability registry, no feature flags. 0044 §"TWO ENTRY POINTS" and 0052's closing
-- note both name the missing line explicitly. §B is that line for the adapter, the
-- capability registry and the flags; §E lays the policy floor by hand, for one tuned
-- field whose reasoning is written out there. Nothing here duplicates a row the migration
-- chain already created — every path is guarded or `on conflict do nothing`.
--
-- The same gap applies to the per-role permission wiring: 0047 grants its three keys
-- `where r.is_system`, which matches nothing at migration time locally. §A re-applies the
-- whole docs/17 §5 vocabulary against the Meadowbrook roles, idempotently.
--
-- ASK THE ENGINE, DO NOT RE-IMPLEMENT IT (the zz_evv_completeness precedent). Every
-- derived value here is computed by the shipped function that owns it:
--   · normalized_address ← app.normalize_address     · geo ← app.geo_point
--   · distance_m         ← app.distance_m            · location_status ← app.evaluate_location
--   · geofence + thresholds ← app.resolve_visit_policy / app.visit_policy_for
--   · the EVV record hash ← the 0049 canonical form, byte for byte
--   · verified_minutes, late_minutes, overlap_minutes ← read off the clock ledger
-- Nothing is hand-asserted that the product can derive, so the fixtures cannot drift from
-- the rules they are supposed to illustrate. Clock events are written directly rather than
-- through app.clock_visit() because the seed has no session and that RPC requires the
-- assigned caregiver's own AAL2 JWT; the four exception rows are likewise written directly
-- (see §F) but carry the detectors' own kind / severity / rule_key / evidence / dedupe_key,
-- so the universe this file leaves behind is one the real sweep has nothing to add to.
-- `select app.sweep_visit_exceptions(now())` against a freshly seeded database returns
-- `{"ok": true, "total": 0, …}` — which is the property to re-check if these rows change.
--
-- D-030 / invariant 5. Coordinates and metres live on RLS-gated PHI rows (visit_event,
-- service_location_version) exactly as the engines write them, and NOWHERE else: the
-- visit_exception evidence objects carry a distance BUCKET and the policy radius, never a
-- raw distance and never a point. The late_start and outside_geofence rows are shaped for
-- the clock→exception funnel that 0046's header defers to 0047 and 0047 has not yet wired
-- (DN-0046e) — when it lands, these rows are what it will produce.
--
-- IDEMPOTENT BY CONSTRUCTION. Every row is id-pinned with `on conflict do nothing`, every
-- projection UPDATE is guarded with `is distinct from`, every exception carries the
-- detectors' dedupe_key, and the caregivers and clients for the story are re-read from the
-- visits they already own rather than re-selected. `harness.sh seed` twice is a no-op the
-- second time (verified). A missing prerequisite degrades to `raise notice` + fewer rows,
-- never to an error.
--
-- TWO THINGS THIS FILE HAD TO WORK AROUND, both flagged in place (§E, §F, §G) and both
-- wanting a decision-log entry rather than silence: 0047's and 0049's pgTAP files assert
-- GLOBAL, unfiltered counts over public.visit_exception's detectors, audit.audit_event and
-- public.evv_submission. A seed that populates those tables for the synthetic tenant
-- changes numbers a test believes belong to its own fixture. That is why no detector is
-- invoked here, why the missed-visit threshold is what it is, and why no evv_submission
-- row exists.
--
-- Load order: glob-sorted last of supabase/seeds/*.sql, so the tenant, roles, personas,
-- 324 clients, care teams, shifts and the three scheduling visits all already exist.
-- @trace: ST-200, docs/17 §3.1–§3.13, §4.3, §4.5, §5, §7.2, D-006, D-025, D-026, D-030

-- ═══ §A · docs/17 §5 permission vocabulary, wired to the Meadowbrook system roles ══════
-- The keys themselves are real config and arrive with the migrations (0043/0044/0047–0051
-- insert them into public.permission). What lands here is only the per-tenant role wiring,
-- which is a seed concern because these roles are created by seed.sql after the migrations
-- have already run. Narrow on purpose: the owner and administrator hold the full back
-- office; the coordinator runs the day (queue, locations, readiness) but not the clock pen,
-- the money or the state file — the 0047 posture, extended over the rest of the layer; the
-- RN sees verification detail because a supervisory visit is judged on the same evidence.
insert into public.role_permission (role_id, permission_key)
select r.id, p.perm
from public.role r
join lateral (values
  ('owner',       'location.manage'),   ('owner',       'policy.manage'),
  ('owner',       'visit.verify.read'), ('owner',       'visit.verify.act'),
  ('owner',       'visit.correct'),     ('owner',       'visit.approve'),
  ('owner',       'payroll.read'),      ('owner',       'payroll.manage'),
  ('owner',       'evv.read'),          ('owner',       'evv.manage'),
  ('owner',       'workforce.read'),
  ('admin',       'location.manage'),   ('admin',       'policy.manage'),
  ('admin',       'visit.verify.read'), ('admin',       'visit.verify.act'),
  ('admin',       'visit.correct'),     ('admin',       'visit.approve'),
  ('admin',       'payroll.read'),      ('admin',       'payroll.manage'),
  ('admin',       'evv.read'),          ('admin',       'evv.manage'),
  ('admin',       'workforce.read'),
  ('coordinator', 'location.manage'),
  ('coordinator', 'visit.verify.read'), ('coordinator', 'visit.verify.act'),
  ('coordinator', 'payroll.read'),      ('coordinator', 'workforce.read'),
  ('rn',          'visit.verify.read')
) as p(role_key, perm) on p.role_key = r.key
where r.tenant_id = '11111111-1111-1111-1111-111111111111'
  -- A key the migration chain has not inserted would fail the FK; skip it loudly-quietly
  -- rather than take the whole seed down over a partial chain.
  and exists (select 1 from public.permission k where k.key = p.perm)
on conflict do nothing;

-- ═══ §B · The second entry point the migrations asked for ═════════════════════════════
-- Both are `on conflict do nothing` internally and return 0 when there is nothing to do,
-- so this is the same statement production already ran — not a duplicate of it.
--   0049 → the Maryland ISAS adapter, mode 'reconcile', enabled = false (D-026)
--   0052 → the four docs/17 §11 AI capabilities and the four feature flags
-- The third one 0044 asks for — app.seed_visit_policy — is NOT called here. The tenant
-- floor still gets laid, in §E below, but with one threshold tuned for a synthetic
-- universe; the reasoning is written out there rather than smuggled into a one-liner.
select app.seed_evv_adapters(t.id)          from public.tenant t;
select app.seed_visit_ai_capabilities(t.id) from public.tenant t;
select app.seed_visit_feature_flags(t.id)   from public.tenant t;
-- 0057's pair, same two-entry-point reasoning: local tenants are created after
-- migrations run, so the Front Door registry + dark flags need the seed lane too.
select app.seed_front_door_capabilities(t.id) from public.tenant t;
select app.seed_front_door_flags(t.id)        from public.tenant t;

do $vv$
declare
  v_tenant   uuid := '11111111-1111-1111-1111-111111111111';

  -- Catalog ids, pinned so a re-run is a no-op and a demo script can name them.
  v_st_pca   uuid := '11111111-1111-1111-1111-000000d17a01';
  v_st_cna   uuid := '11111111-1111-1111-1111-000000d17a02';
  v_st_rn    uuid := '11111111-1111-1111-1111-000000d17a03';
  v_st_comp  uuid := '11111111-1111-1111-1111-000000d17a04';

  -- The four named clients from seed.sql.
  v_eleanor  uuid := '11111111-1111-1111-1111-000000c10001';   -- Silver Spring, medicaid
  v_marcus   uuid := '11111111-1111-1111-1111-000000c10002';   -- Takoma Park, private
  v_rosa     uuid := '11111111-1111-1111-1111-000000c10003';   -- Rockville, medicaid
  v_harold   uuid := '11111111-1111-1111-1111-000000c10004';   -- Wheaton, on hold

  -- Yesterday's five visits.
  v_v1 uuid := '11111111-1111-1111-1111-000000d17c01';   -- late arrival
  v_v2 uuid := '11111111-1111-1111-1111-000000d17c02';   -- seen somewhere else
  v_v3 uuid := '11111111-1111-1111-1111-000000d17c03';   -- never closed
  v_v4 uuid := '11111111-1111-1111-1111-000000d17c04';   -- double-booked, first half
  v_v5 uuid := '11111111-1111-1111-1111-000000d17c05';   -- double-booked, second half

  v_owner    uuid;   -- attests geocodes, authors policy, opens the payroll period
  v_coord    uuid;   -- disposes exceptions, approves hours (never the caregiver — D-027)
  v_dee      uuid := '22222222-0000-0000-0000-000000000009';
  v_cg_b     uuid;
  v_cg_c     uuid;
  v_c4       uuid;
  v_c5       uuid;
  v_pair     uuid[];
  v_rural    uuid;

  v_day      timestamptz := date_trunc('day', now()) - interval '1 day';
  v_pol      public.visit_policy;
  v_period   uuid := '11111111-1111-1111-1111-000000d17f01';
  v_p_start  date;

  r          record;
  v_slv      uuid;
  v_lat      double precision;
  v_lng      double precision;
  v_cap_lat  double precision;
  v_dist     double precision;
  v_status   text;
  v_radius   int;

  v_in_at    timestamptz;
  v_out_at   timestamptz;
  v_minutes  int;
  v_late     int;
  v_canon    text;
  v_sha      text;
  v_elements jsonb;
  v_evv_rec  uuid := '11111111-1111-1111-1111-000000d17f03';
  v_n        int;
begin
  -- ── Principals ─────────────────────────────────────────────────────────────────────
  -- Resolved by ROLE, not by id, so the file survives a persona rename. The owner is the
  -- human whose attestation makes every geocode below 'verified' (D-025: an AI capability
  -- can never satisfy that CHECK, because verified_by FKs public.app_user).
  select u.id into v_owner
    from public.app_user u
    join public.user_role ur on ur.user_id = u.id
    join public.role r2 on r2.id = ur.role_id
   where u.tenant_id = v_tenant and u.status = 'active' and r2.key in ('owner','admin')
   order by (r2.key <> 'owner'), u.created_at, u.id
   limit 1;

  select u.id into v_coord
    from public.app_user u
    join public.user_role ur on ur.user_id = u.id
    join public.role r2 on r2.id = ur.role_id
   where u.tenant_id = v_tenant and u.status = 'active' and r2.key = 'coordinator'
   order by u.created_at, u.id
   limit 1;

  if v_owner is null then
    raise notice 'zz_verified_visit: no owner/admin principal — skipping the Verified Visit fixtures';
    return;
  end if;
  if not exists (select 1 from public.client c where c.id = v_eleanor) then
    raise notice 'zz_verified_visit: the named demo clients are absent — skipping';
    return;
  end if;

  -- ═══ §C · service_type — the "type of service" EVV element (docs/17 §3.1) ═══════════
  -- evv_required tracks the payer, not the task: Maryland Medicaid personal care is the
  -- EVV-bearing work, private-pay companionship is not, and an RN supervisory visit is a
  -- COMAR obligation the agency absorbs rather than a billable service line.
  insert into public.service_type
    (id, tenant_id, code, name, evv_required, payer_kind, billable, active)
  values
    (v_st_pca,  v_tenant, 'PCA',            'Personal Care Aide',           true,  'medicaid', true,  true),
    (v_st_cna,  v_tenant, 'CNA',            'Certified Nursing Assistant',  true,  'medicaid', true,  true),
    (v_st_rn,   v_tenant, 'RN_SUPERVISORY', 'RN Supervisory Visit',         false, 'medicaid', false, true),
    (v_st_comp, v_tenant, 'COMPANION',      'Companion Care',               false, 'private',  true,  true)
  on conflict do nothing;

  -- ═══ §D · A verified place of care for every client (docs/17 §3.2, §3.3) ════════════
  -- One primary residence per client, one version, attested by the owner. Ids are derived
  -- from the client id (md5 → uuid) so the mapping is stable across resets without a
  -- 324-row literal. Coordinates are the client's own town centre plus a deterministic
  -- ±0.02° jitter (~±2 km) — plausible Montgomery County points that resolve to nobody.
  insert into public.service_location
    (id, tenant_id, client_id, kind, label, is_primary, effective_from, active,
     created_by, created_at, updated_at)
  select md5('careos.seed.d17.location:' || c.id::text)::uuid,
         v_tenant, c.id, 'primary_residence', 'Home', true,
         coalesce(c.admitted_on, current_date - 30), true,
         v_owner, now() - interval '30 days', now() - interval '30 days'
    from public.client c
   where c.tenant_id = v_tenant
  on conflict do nothing;

  insert into public.service_location_version
    (id, tenant_id, service_location_id, created_by, version_no,
     original_address, normalized_address, address_line1, city, state, postal_code, country,
     geo, geo_precision, geo_source, verification, verified_by, verified_at,
     geofence_radius_m, change_reason, created_at)
  select md5('careos.seed.d17.location_version:' || c.id::text)::uuid,
         v_tenant, sl.id, v_owner, 1,
         concat_ws(', ', c.address_line1, c.city, concat_ws(' ', c.state, c.zip)),
         app.normalize_address(c.address_line1, null, c.city, c.state, c.zip, 'US'),
         c.address_line1, c.city, c.state, c.zip, 'US',
         app.geo_point(
           coalesce(g.lat, 38.9907)
             + ((('x' || substr(md5('careos.seed.d17.lat:' || c.id::text), 1, 4))
                 ::bit(16)::int % 401) / 20000.0)::double precision,
           coalesce(g.lng, -77.0261)
             + ((('x' || substr(md5('careos.seed.d17.lng:' || c.id::text), 1, 4))
                 ::bit(16)::int % 401) / 20000.0)::double precision),
         'manual', 'manual', 'verified', v_owner, now() - interval '29 days',
         -- NULL ⇒ inherit the resolved policy radius, which is the right default for
         -- almost every door. One per-location override so /clients/[id]/locations has a
         -- geofence to show: Harold Finch is on hold and carries no visit evidence, so
         -- widening his fence cannot change the verdict on any clock event seeded below.
         -- It is set HERE rather than by a later UPDATE because the table is [AO] — a
         -- revision is a new version, never an edit (invariant 1).
         case when c.id = v_harold then 350 end,
         'Address read back to the client at admission and pinned on the map by the office.',
         now() - interval '29 days'
    from public.client c
    join public.service_location sl
      on sl.id = md5('careos.seed.d17.location:' || c.id::text)::uuid
    left join (values
      ('Silver Spring', 38.9907, -77.0261), ('Takoma Park',   38.9779, -77.0075),
      ('Rockville',     39.0840, -77.1528), ('Wheaton',       39.0398, -77.0553),
      ('Bethesda',      38.9847, -77.0947), ('Gaithersburg',  39.1434, -77.2014),
      ('Laurel',        39.0993, -76.8483), ('Hyattsville',   38.9559, -76.9455),
      ('College Park',  38.9807, -76.9369), ('Olney',         39.1532, -77.0669)
    ) as g(city, lat, lng) on g.city = c.city
   where c.tenant_id = v_tenant
  on conflict do nothing;

  -- current_version_id is a projection of the ledger, maintained by the §6.1 RPCs in
  -- production and set here once, because the seed writes the ledger directly.
  update public.service_location sl
     set current_version_id = slv.id, updated_at = now()
    from public.service_location_version slv
   where slv.service_location_id = sl.id
     and sl.tenant_id = v_tenant
     and slv.version_no = 1
     and sl.current_version_id is distinct from slv.id;

  -- ═══ §E · The policy ladder: a tenant floor and one rung below it ═══════════════════
  -- THE FLOOR. app.resolve_visit_policy REQUIRES a tenant-scope row — without one it
  -- raises CAREOS_POLICY_MISSING and every clock-in, sweep, trust score and EVV build in
  -- the tenant is dead. 0044 seeds it at migration time, which covers hosted; local and
  -- preview create this tenant afterwards, so it has to be laid here.
  --
  -- Laid by hand rather than by app.seed_visit_policy, for ONE tuned field. The synthetic
  -- universe carries a rolling seven-day schedule that nobody ever clocks — 15-odd visits
  -- a day, every one of them permanently unattended. Against the product default
  -- (missed_visit_minutes = 60) the sweep would file a fresh batch of critical
  -- 'missed_visit' findings every afternoon, all of them artifacts of the seed rather than
  -- of the story, and the exception queue a demo is supposed to walk through would be
  -- buried under them. A day-long threshold keeps the synthetic schedule quiet without
  -- touching any other rule; a real tenant keeps the 60-minute default from 0044.
  --
  -- SURFACED, NOT SMUGGLED: this also happens to be what keeps
  -- supabase/tests/database/0047_exception_engine.sql green. That file asserts
  -- `app.detect_missed_visits(now() - interval '210 minutes') = 0` GLOBALLY — an
  -- unfiltered count from a detector that scans every tenant — and it only ever passed
  -- because this tenant had no policy at all and the detector skipped it. Once the floor
  -- exists, any unattended morning visit in the synthetic schedule makes that assertion
  -- fail after lunchtime and pass before it. The threshold above is defensible on its own
  -- merits, but the coupling is real and the assertion wants a tenant filter. Flagged for
  -- a decision-log entry rather than left for someone to rediscover at 2pm.
  if not exists (select 1 from public.visit_policy vp
                  where vp.tenant_id = v_tenant and vp.scope_kind = 'tenant') then
    insert into public.visit_policy
      (id, tenant_id, scope_kind, version_no, effective_from,
       missed_visit_minutes, change_reason, created_by, created_at)
    values
      ('11111111-1111-1111-1111-000000d17b00', v_tenant, 'tenant', 1,
       now() - interval '60 days', 1440,
       'Agency defaults established with the Verified Visit layer (docs/17 §3.4). '
       'Missed-visit threshold widened to a day for the synthetic universe, whose rolling '
       'schedule is never clocked.',
       v_owner, now() - interval '60 days')
    on conflict do nothing;
  end if;

  -- THE RUNG BELOW IT, so /settings/visit-policy has an inheritance chain to preview: a
  -- northern-county property where the phone signal is thin and the driveway is long. The
  -- resolver (docs/17 §4.2) walks client → service_type → payer_kind → program → tenant.
  -- The client is chosen from those carrying NO visits at all, so a client-scope policy
  -- can never change what any detector decides about seeded work.
  select c.id into v_rural
    from public.client c
   where c.tenant_id = v_tenant and c.status = 'active'
     and not exists (select 1 from public.visit v where v.client_id = c.id)
   order by (c.city <> 'Olney'), c.id
   limit 1;

  if v_rural is not null then
    insert into public.visit_policy
      (id, tenant_id, scope_kind, scope_id, version_no, effective_from,
       geofence_tier, geofence_radius_m, max_accuracy_m,
       late_threshold_minutes, missing_clock_out_minutes,
       change_reason, created_by, created_at)
    values
      ('11111111-1111-1111-1111-000000d17b01', v_tenant, 'client', v_rural, 1,
       now() - interval '30 days', 'rural', 750, 500, 15, 30,
       'Rural property at the northern edge of the county: long driveway, weak signal. '
       'Agreed with the family that a wider radius and a longer grace period are fair.',
       v_owner, now() - interval '30 days')
    on conflict do nothing;
    raise notice 'zz_verified_visit: rural policy override attached to client %', v_rural;
  end if;

  -- ═══ §F · Yesterday, in five visits ═════════════════════════════════════════════════
  -- The story a demo walks through, top to bottom:
  --   1. Dee ran late to Eleanor's — acknowledged, hours approved, EVV record built.
  --   2. Dee found Marcus at a family member's home — still open, top of the queue.
  --   3. A visit to Rosa was never closed out — a rule found it, not a person.
  --   4/5. One caregiver's afternoon double-booked — the conflict is filed on both sides.

  -- The two supporting caregivers. Re-read from the visits they already own so a re-run
  -- picks the same people; chosen on first run from caregivers carrying NO clock history,
  -- so the only overlapping pair of clocked windows in the whole universe is the one this
  -- file stages deliberately — and the real sweep, whenever it next runs, finds nothing
  -- it has not already been told about.
  select caregiver_id into v_cg_b from public.visit where id = v_v3;
  select caregiver_id into v_cg_c from public.visit where id = v_v4;
  if v_cg_b is null or v_cg_c is null then
    select array_agg(s.id order by s.id) into v_pair from (
      select u.id from public.app_user u
       where u.tenant_id = v_tenant and u.status = 'active' and u.kind = 'staff'
         and u.id <> v_dee
         and exists (select 1 from public.user_role ur join public.role r2 on r2.id = ur.role_id
                      where ur.user_id = u.id and r2.key = 'caregiver')
         and not exists (select 1 from public.visit_event e where e.caregiver_id = u.id)
       order by u.id limit 2) s;
    v_cg_b := coalesce(v_cg_b, v_pair[1]);
    v_cg_c := coalesce(v_cg_c, v_pair[2]);
  end if;

  -- The two clients for the double-booked afternoon: deterministic, neither one of the
  -- four named demo clients (so nobody's story gets two conflicting narratives), and both
  -- in the SAME town — one caregiver's afternoon route, and a pair of doors close enough
  -- that the impossible-travel rule has nothing to say about the drive between them.
  select coalesce(
           (select array_agg(x.client_id order by x.client_id)
              from (select client_id from public.visit where id in (v_v4, v_v5)) x),
           (select array_agg(s.id order by s.id) from (
              select c.id from public.client c
               where c.tenant_id = v_tenant and c.status = 'active'
                 and c.city = 'Silver Spring'
                 and c.id not in (v_eleanor, v_marcus, v_rosa, v_harold)
               order by c.id limit 2) s))
    into v_pair;
  v_c4 := v_pair[1];
  v_c5 := v_pair[2];

  if v_cg_b is null or v_cg_c is null or v_c4 is null or v_c5 is null then
    raise notice 'zz_verified_visit: not enough caregivers/clients for the operations story — skipping §F–§H';
    return;
  end if;

  -- Care-team assignments, so the people in the story can legitimately read the charts.
  insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case)
  select v_tenant, p.client, p.cg, 'caregiver'
    from (values (v_eleanor, v_dee), (v_marcus, v_dee),
                 (v_rosa, v_cg_b), (v_c4, v_cg_c), (v_c5, v_cg_c)) as p(client, cg)
   where not exists (select 1 from public.care_team_assignment a
                      where a.client_id = p.client and a.user_id = p.cg);

  -- The visits themselves. service_type/location/version are bound at scheduling time;
  -- policy_id is bound at CLOCK time by the engine, so it is set in the event loop below.
  insert into public.visit
    (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status, note,
     service_type_id, service_location_id, service_location_version_id)
  select p.id, v_tenant, p.client, p.cg,
         v_day + p.starts, v_day + p.ends, p.status, p.note,
         p.service_type, sl.id, sl.current_version_id
    from (values
      (v_v1, v_eleanor, v_dee,  interval '9 hours',  interval '11 hours', 'completed',
       'Personal care, breakfast and a medication reminder.', v_st_pca),
      (v_v2, v_marcus,  v_dee,  interval '12 hours', interval '14 hours', 'completed',
       'Companionship and light housekeeping.', v_st_comp),
      (v_v3, v_rosa,    v_cg_b, interval '15 hours', interval '17 hours', 'in_progress',
       'Afternoon personal care.', v_st_pca),
      (v_v4, v_c4,      v_cg_c, interval '13 hours', interval '15 hours', 'completed',
       'Personal care and a light meal.', v_st_pca),
      (v_v5, v_c5,      v_cg_c, interval '14 hours 30 minutes', interval '16 hours',
       'completed', 'Personal care.', v_st_pca)
    ) as p(id, client, cg, starts, ends, status, note, service_type)
    join public.service_location sl
      on sl.client_id = p.client and sl.tenant_id = v_tenant and sl.is_primary and sl.active
   where p.cg is not null
  on conflict do nothing;

  -- ── The clock ledger ────────────────────────────────────────────────────────────────
  -- offset_m is how far from the client's front door the phone reported. Everything the
  -- reviewer will read — the metres, and the verdict on them — is computed here by the
  -- shipped functions against the resolved policy, so a fixture can never claim a status
  -- the rule would not give it.
  for r in
    select * from (values
      -- (event id, visit, minute of day, offset metres, accuracy m, type, reason, note)
      ('11111111-1111-1111-1111-000000d17d01'::uuid, v_v1,  9*60+19,  35.0,  14.0, 'clock_in',  null::text, null::text),
      ('11111111-1111-1111-1111-000000d17d02'::uuid, v_v1, 11*60+ 4,  44.0,  16.0, 'clock_out', null, null),
      ('11111111-1111-1111-1111-000000d17d03'::uuid, v_v2, 12*60+ 3, 610.0,  18.0, 'clock_in',  null, null),
      ('11111111-1111-1111-1111-000000d17d04'::uuid, v_v2, 12*60+ 5, 610.0,  18.0, 'exception_requested',
       'alternate_location', 'Client asked to be seen at a family member''s home today.'),
      ('11111111-1111-1111-1111-000000d17d05'::uuid, v_v2, 14*60+ 2, 598.0,  17.0, 'clock_out',
       'alternate_location', null),
      ('11111111-1111-1111-1111-000000d17d06'::uuid, v_v3, 15*60+ 2,  26.0,  11.0, 'clock_in',  null, null),
      ('11111111-1111-1111-1111-000000d17d07'::uuid, v_v4, 13*60+ 1,  30.0,  13.0, 'clock_in',  null, null),
      ('11111111-1111-1111-1111-000000d17d08'::uuid, v_v4, 15*60+ 6,  40.0,  15.0, 'clock_out', null, null),
      ('11111111-1111-1111-1111-000000d17d09'::uuid, v_v5, 14*60+35,  55.0,  19.0, 'clock_in',  null, null),
      ('11111111-1111-1111-1111-000000d17d0a'::uuid, v_v5, 16*60+10,  65.0,  21.0, 'clock_out', null, null)
    ) as e(id, visit_id, minute, offset_m, accuracy_m, event_type, reason_code, note)
    where not exists (select 1 from public.visit_event ve where ve.id = e.id)
      and exists (select 1 from public.visit v where v.id = e.visit_id)
  loop
    select v.service_location_version_id,
           extensions.ST_Y(slv.geo::extensions.geometry),
           extensions.ST_X(slv.geo::extensions.geometry),
           slv.geofence_radius_m
      into v_slv, v_lat, v_lng, v_radius
      from public.visit v
      join public.service_location_version slv on slv.id = v.service_location_version_id
     where v.id = r.visit_id;

    v_pol     := app.visit_policy_for(r.visit_id);
    v_radius  := coalesce(v_radius, v_pol.geofence_radius_m);
    -- Walk north from the door by offset_m; one degree of latitude is ~111,320 m.
    v_cap_lat := v_lat + (r.offset_m / 111320.0);
    v_dist    := app.distance_m(
                   app.geo_point(v_lat, v_lng), v_cap_lat, v_lng);
    v_status  := case when r.event_type in ('clock_in','clock_out')
                      then app.evaluate_location(r.accuracy_m, v_dist,
                                                 v_pol.max_accuracy_m, v_radius)
                 end;

    insert into public.visit_event
      (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
       latitude, longitude, accuracy_m, method, note,
       received_at, service_location_version_id, policy_id, distance_m, location_status,
       capture_source, is_offline, device_session_id, reason_code, created_at)
    select r.id, v_tenant, r.visit_id, v.caregiver_id, r.event_type,
           v_day + make_interval(mins => r.minute),
           v_cap_lat, v_lng, r.accuracy_m, 'web', r.note,
           v_day + make_interval(mins => r.minute) + interval '2 seconds',
           v_slv, v_pol.id, v_dist, v_status,
           'web', false,
           -- Opaque, rotating, per-visit: correlates one session's events with each
           -- other and identifies no hardware (D-030's closed capture list).
           'sess-' || substr(md5('careos.seed.d17.session:' || r.visit_id::text), 1, 12),
           r.reason_code, v_day + make_interval(mins => r.minute)
      from public.visit v where v.id = r.visit_id
    on conflict do nothing;
  end loop;

  -- Bind the policy each visit was judged against (the engine does this at clock-in).
  update public.visit v
     set policy_id = e.policy_id, updated_at = now()
    from (select distinct on (visit_id) visit_id, policy_id
            from public.visit_event
           where visit_id in (v_v1, v_v2, v_v3, v_v4, v_v5) and policy_id is not null
           order by visit_id, occurred_at) e
   where v.id = e.visit_id and v.policy_id is distinct from e.policy_id;

  -- ── The two exceptions the clock funnel will raise once 0047 wires it (DN-0046e) ────
  -- Shaped exactly as app.raise_visit_exception_internal writes them: detected_by 'rule',
  -- created_by NULL (a rule found it, not a person), evidence of ids + numbers only.
  select occurred_at into v_in_at from public.visit_event
   where id = '11111111-1111-1111-1111-000000d17d01';
  select scheduled_start into v_out_at from public.visit where id = v_v1;
  v_pol  := app.visit_policy_for(v_v1);
  v_late := greatest(floor(extract(epoch from (v_in_at - v_out_at)) / 60), 0)::int;

  insert into public.visit_exception
    (id, tenant_id, visit_id, caregiver_id, kind, severity, detected_by, rule_key,
     dedupe_key, evidence, source_event_id, created_by, created_at)
  values
    ('11111111-1111-1111-1111-000000d17e01', v_tenant, v_v1, v_dee,
     'late_start', 'warning', 'rule', 'clock.late_start',
     'visit:' || v_v1::text,
     jsonb_build_object('scheduled_start', v_out_at,
                        'late_minutes', v_late,
                        'threshold_minutes', v_pol.late_threshold_minutes,
                        'clock_in_event_id', '11111111-1111-1111-1111-000000d17d01'),
     '11111111-1111-1111-1111-000000d17d01', null, v_in_at + interval '1 minute')
  on conflict do nothing;

  v_pol := app.visit_policy_for(v_v2);
  insert into public.visit_exception
    (id, tenant_id, visit_id, caregiver_id, kind, severity, detected_by, rule_key,
     dedupe_key, evidence, source_event_id, created_by, created_at)
  values
    ('11111111-1111-1111-1111-000000d17e02', v_tenant, v_v2, v_dee,
     'outside_geofence', 'critical', 'rule', 'clock.location',
     'event:11111111-1111-1111-1111-000000d17d03',
     -- D-030: a bucket and the rule it failed, never the metres and never the point.
     jsonb_build_object('clock_in_event_id', '11111111-1111-1111-1111-000000d17d03',
                        'distance_bucket', 'far',
                        'policy_radius_m', v_pol.geofence_radius_m,
                        'reason_code', 'alternate_location'),
     '11111111-1111-1111-1111-000000d17d03', null,
     v_day + interval '12 hours 4 minutes')
  on conflict do nothing;

  -- One closed finding, so the queue shows both halves of the workflow. A disposition is
  -- always a human act (D-020) — acted_by FKs app_user and app.guard_human_disposer keeps
  -- an agent identity out of this column.
  if v_coord is not null then
    insert into public.visit_exception_disposition
      (id, tenant_id, exception_id, disposition, reason, acted_by, created_at)
    select '11111111-1111-1111-1111-000000d17e03', v_tenant,
           '11111111-1111-1111-1111-000000d17e01', 'acknowledged',
           'Caregiver called ahead about a bus detour and stayed the full two hours. '
           'Hours approved as recorded; no impact on the client.',
           v_coord, v_day + interval '18 hours'
     where exists (select 1 from public.visit_exception x
                    where x.id = '11111111-1111-1111-1111-000000d17e01')
    on conflict do nothing;
  end if;

  -- ── The two findings the sweeps own, written in the sweeps' own shape ───────────────
  -- The 0047 detectors are NOT invoked from here, for one specific reason: a detector
  -- raises through app.raise_visit_exception_internal, which writes an
  -- `actor_kind = 'system'` row onto the audit ledger, and
  -- supabase/tests/database/0047_exception_engine.sql asserts that exactly ONE
  -- 'visit_exception.missing_clock_out' system audit row exists — globally, unfiltered.
  -- A seed that pre-ran the sweep would make that two. So the rows are written directly,
  -- byte-identical in kind / severity / detected_by / rule_key / evidence / dedupe_key to
  -- what app.detect_missing_clock_out and app.detect_overlapping_visits produce, with
  -- created_by NULL because a rule found them and no person did. The dedupe_keys are the
  -- detectors' own, so the next real sweep recognises these as already-filed and adds
  -- nothing — which is also why the pgTAP counts stay exact. Same flag as §E: the
  -- assertion wants a tenant filter, and until it has one a seed cannot run the engine
  -- it is illustrating.
  --
  -- app.detect_missed_visits is not run either, at any clock: today's scheduled visits
  -- belong to the /today demo and a seed must not decide they were no-shows.
  select scheduled_end into v_out_at from public.visit where id = v_v3;
  v_pol := app.visit_policy_for(v_v3);
  insert into public.visit_exception
    (id, tenant_id, visit_id, caregiver_id, kind, severity, detected_by, rule_key,
     dedupe_key, evidence, source_event_id, created_by, created_at)
  select '11111111-1111-1111-1111-000000d17e04', v_tenant, v_v3, v.caregiver_id,
         'missing_clock_out', 'warning', 'rule', 'sweep.missing_clock_out',
         'visit:' || v_v3::text,
         jsonb_build_object('scheduled_end', v_out_at,
                            'threshold_minutes', v_pol.missing_clock_out_minutes,
                            'clock_in_event_id', '11111111-1111-1111-1111-000000d17d06'),
         '11111111-1111-1111-1111-000000d17d06', null,
         v_out_at + make_interval(mins => v_pol.missing_clock_out_minutes)
    from public.visit v where v.id = v_v3
  on conflict do nothing;

  -- Raised on BOTH sides of the pair (docs/17 §4.5): each visit's own record has to show
  -- the conflict, and each dedupe_key names the other side. The overlap is measured off
  -- the ledger, not asserted.
  select round(extract(epoch from (
           least((select max(occurred_at) from public.visit_event where visit_id = v_v4),
                 (select max(occurred_at) from public.visit_event where visit_id = v_v5))
         - greatest((select min(occurred_at) from public.visit_event where visit_id = v_v4),
                    (select min(occurred_at) from public.visit_event where visit_id = v_v5))
         )) / 60.0)::int
    into v_n;

  insert into public.visit_exception
    (id, tenant_id, visit_id, caregiver_id, kind, severity, detected_by, rule_key,
     dedupe_key, evidence, created_by, created_at)
  select p.id, v_tenant, p.visit, v_cg_c, 'overlapping_visits', 'critical', 'rule',
         'sweep.overlapping_visits', 'visit:' || p.other::text,
         jsonb_build_object('other_visit_id', p.other, 'overlap_minutes', v_n),
         null, v_day + interval '16 hours 15 minutes'
    from (values
      ('11111111-1111-1111-1111-000000d17e05'::uuid, v_v4, v_v5),
      ('11111111-1111-1111-1111-000000d17e06'::uuid, v_v5, v_v4)
    ) as p(id, visit, other)
   where v_n is not null
  on conflict do nothing;

  -- ── Verification axis (D-024): what the evidence says about each visit ──────────────
  update public.visit v
     set verification_status = s.status, updated_at = now()
    from (values (v_v1, 'exception'), (v_v2, 'exception'), (v_v3, 'exception'),
                 (v_v4, 'verified'),  (v_v5, 'exception')) as s(id, status)
   where v.id = s.id and v.verification_status is distinct from s.status;

  -- ═══ §G · One canonical EVV record, and nothing submitted (docs/17 §3.12, D-026) ═════
  -- Eleanor's visit is the EVV-bearing one: PCA, Medicaid, all six elements present. The
  -- hash is the 0049 canonical form byte for byte — six elements, sorted by key, pipe
  -- delimited, times in UTC to the second — so app.build_evv_record re-running against
  -- this visit returns `unchanged` instead of forking the supersession chain.
  select min(occurred_at) filter (where event_type = 'clock_in'),
         max(occurred_at) filter (where event_type = 'clock_out')
    into v_in_at, v_out_at
    from public.visit_event where visit_id = v_v1;

  select v.service_location_version_id into v_slv from public.visit v where v.id = v_v1;

  if v_in_at is not null and v_out_at is not null then
    v_canon :=
         'caregiver='                 || v_dee::text
      || '|client='                   || v_eleanor::text
      || '|service_date='             || to_char((v_in_at at time zone 'UTC')::date, 'YYYY-MM-DD')
      || '|service_location_version=' || coalesce(v_slv::text, '')
      || '|service_times='
      || to_char(v_in_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      || '~'
      || to_char(v_out_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      || '|service_type='             || v_st_pca::text;
    v_sha := encode(extensions.digest(convert_to(v_canon, 'utf8'), 'sha256'), 'hex');
    v_elements := jsonb_build_object(
      'service_type', true, 'individual_receiving', true, 'service_date', true,
      'service_location', v_slv is not null, 'individual_providing', true,
      'service_times', true);

    insert into public.evv_record
      (id, tenant_id, source_visit_id, service_type_id, client_id, service_date,
       service_location_version_id, caregiver_id, start_at, end_at, capture_method,
       payer_kind, element_completeness, is_complete, record_sha256, created_at)
    values
      (v_evv_rec, v_tenant, v_v1, v_st_pca, v_eleanor,
       (v_in_at at time zone 'UTC')::date, v_slv, v_dee, v_in_at, v_out_at, 'web_gps',
       'medicaid', v_elements,
       (v_elements ->> 'service_type')::boolean and (v_elements ->> 'individual_receiving')::boolean
       and (v_elements ->> 'service_date')::boolean and (v_elements ->> 'service_location')::boolean
       and (v_elements ->> 'individual_providing')::boolean and (v_elements ->> 'service_times')::boolean,
       v_sha, v_out_at + interval '5 minutes')
    on conflict do nothing;

    -- NO evv_submission ROW IS SEEDED, and this is the one item of the brief that could
    -- not be delivered. supabase/tests/database/0049_evv_canonical.sql asserts
    -- `(select count(*) from public.evv_submission) = 0`, then `= 1`, then
    -- `(select status from public.evv_submission) = 'pending'` — three GLOBAL, unfiltered
    -- statements, the last of them a scalar subquery that errors outright on a second row.
    -- Any seeded attempt, in any tenant, breaks all three. Assertions on evv_record are
    -- filtered by source_visit_id, which is why the canonical record above is safe.
    --
    -- It is also, as it happens, the state the product is actually in: D-026 ships the
    -- Maryland ISAS adapter DISABLED, and app.submit_evv against a disabled adapter
    -- returns {skipped: true, reason: 'adapter_disabled'} and deliberately writes no
    -- ledger row. So "a canonical record with nothing submitted behind it" is exactly
    -- what an agency running this build would see today. Whoever gives 0049 a tenant
    -- filter should add the pending attempt back here in the same change.
    --
    -- evv_status = 'pending' is what app.build_evv_record projects onto an EVV-required
    -- visit once the record exists (step 13). Nothing has been submitted, and the axis
    -- says so.
    update public.visit set evv_status = 'pending', updated_at = now()
     where id = v_v1 and evv_status is distinct from 'pending';
  end if;

  -- ═══ §H · The payroll boundary (docs/17 §3.10, §3.11) ═══════════════════════════════
  -- A fortnight that always contains both yesterday and today, so the open period is the
  -- one the seeded work falls into whatever day the demo runs.
  v_p_start := (date_trunc('week', current_date - interval '7 days'))::date;
  insert into public.payroll_period
    (id, tenant_id, starts_on, ends_on, status, created_by, created_at, updated_at)
  values
    (v_period, v_tenant, v_p_start, v_p_start + 13, 'open', v_owner,
     now() - interval '7 days', now() - interval '7 days')
  on conflict do nothing;

  -- One approved segment: the late visit, approved as recorded once the coordinator had
  -- acknowledged why it started late. verified_minutes is read off the ledger rather than
  -- asserted, and approved_by can never be the caregiver (D-027, enforced by CHECK).
  select floor(extract(epoch from (
           (select max(occurred_at) from public.visit_event
             where visit_id = v_v1 and event_type = 'clock_out')
         - (select min(occurred_at) from public.visit_event
             where visit_id = v_v1 and event_type = 'clock_in'))) / 60)::int
    into v_minutes;

  if v_coord is not null and v_minutes is not null and v_coord <> v_dee then
    insert into public.approved_work_segment
      (id, tenant_id, visit_id, caregiver_id, work_date, verified_minutes,
       approved_minutes, rounding_applied, pay_code, decision, approval_note,
       approved_by, created_at)
    values
      ('11111111-1111-1111-1111-000000d17f02', v_tenant, v_v1, v_dee, v_day::date,
       v_minutes, v_minutes, 'none', 'regular', 'approved',
       'Late arrival was explained and acknowledged. Paying the time actually worked.',
       v_coord, v_day + interval '18 hours 5 minutes')
    on conflict do nothing;

    update public.visit
       set approval_status = 'approved', payroll_status = 'ready', updated_at = now()
     where id = v_v1
       and (approval_status is distinct from 'approved'
            or payroll_status is distinct from 'ready');
  end if;

  -- ═══ §I · Backfill: every other visit in the universe gets a type and a place ═══════
  -- Runs last so the five staged visits keep the bindings set above. Medicaid and VA work
  -- is the EVV-bearing personal care line; private pay and LTC insurance is companionship.
  update public.visit v
     set service_type_id = coalesce(v.service_type_id, st.id),
         service_location_id = coalesce(v.service_location_id, sl.id),
         service_location_version_id =
           coalesce(v.service_location_version_id, sl.current_version_id),
         updated_at = now()
    from public.client c
    join public.service_location sl
      on sl.client_id = c.id and sl.is_primary and sl.active
    join public.service_type st
      on st.tenant_id = c.tenant_id
     and st.code = case when c.payer_type in ('medicaid','va') then 'PCA' else 'COMPANION' end
   where v.tenant_id = v_tenant
     and v.client_id = c.id
     and (v.service_type_id is null or v.service_location_id is null
          or v.service_location_version_id is null);
end $vv$;
