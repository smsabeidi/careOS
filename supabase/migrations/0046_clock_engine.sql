-- ST-204 · Migration 0046 — the clock engine: one deterministic rule, one honest RPC
-- The verified visit stops being a promise here. 0013 shipped a working browser clock
-- (assigned-caregiver gate, AAL2 gate, append-only ledger, coordinates deliberately kept
-- out of the audit payload) but had no notion of WHERE the care was supposed to happen:
-- it stored latitude/longitude and evaluated nothing. 0043 gave us a trusted coordinate
-- (service_location_version.geo, human-attested per D-025), 0044 gave us the rule set
-- (visit_policy), 0045 gave the ledger its capture columns and the visit its four
-- orthogonal projections (D-024). This migration is the join: it decides, in SQL, whether
-- a clock event was where it claimed to be.
--
-- What lands:
--   * app.evaluate_location — invariant 13 in its purest form. Four numbers in, one enum
--     out, IMMUTABLE, no table access, no clock, no model. A geofence verdict is a
--     predicate, not a judgement, and it is unit-testable as a truth table (docs/12 §4).
--   * app.clock_visit, re-signed per D-029 — DROP + CREATE with six defaulted parameters
--     rather than `create or replace` with a new signature, which would OVERLOAD and
--     re-create the D-016 PostgREST named-argument ambiguity that broke the ops cron.
--     apps/web/src/app/today/actions.ts calls it with five named arguments and keeps
--     resolving, unchanged, to the new function.
-- What does NOT land here: the visit_event audit emitter. 0045 already replaced
-- app.audit_visit_event with a payload carrying visit_id, method, capture_source,
-- location_status and is_offline — every field this engine needs a surveyor to see, with
-- event_type already borne by the audit ACTION ('visit.clock_in_rejected' and friends).
-- Replacing it a second time here would give one function two owners in two migrations,
-- which is the drift the corpus exists to prevent, and would silently drop 0045's
-- capture_source/is_offline. The audit stays trigger-driven (the 0027 posture: a future
-- write path cannot forget the ledger), so the RPC body below never emits audit itself.
--
-- Design notes:
--   * DN-0046a — BINDING ON FIRST CLOCK-IN. service_location_version_id and policy_id are
--     the two RPC-only columns from 0045: a verified visit binds to the exact address
--     version and the exact policy version it was verified against, so revising an address
--     or tightening a radius tomorrow can never rewrite what happened today. Same
--     form_template/form_version precedent as D-014. On clock-out the RPC reuses the bound
--     pair rather than re-resolving, for the same reason.
--   * DN-0046b — MISSING CONFIG NEVER BLOCKS CARE. A client with no service location
--     yields a NULL distance, which app.evaluate_location reports as 'unavailable'. That
--     is a location status, not an error: an agency that has not finished geocoding its
--     roster must still be able to deliver and record care, and the gap surfaces as a
--     reviewable exception rather than a caregiver standing on a porch with a dead button.
--     Resolution is also NARROW, not best-effort: if the scheduler named a place of care
--     that has no current version, the engine reports 'unavailable' rather than quietly
--     measuring against the client's primary residence. Falling back would manufacture a
--     false outside_geofence for a legitimate visit at a daughter's house — an exception
--     with a caregiver's name on it, produced by a config gap. Honest silence beats a
--     confident wrong answer when the output is evidence about a person.
--   * DN-0046c — METRES NEVER LEAVE THE DATABASE. The caller gets distance_bucket
--     ('inside' | 'near' | 'far' | null), never the raw distance. D-030: telling a
--     caregiver they are "312 m away" is surveillance-grade precision serving no
--     operational purpose. distance_m is written to the ledger, where RLS and AAL2 gate it.
--   * DN-0046d — CAREOS_GEOFENCE_UNVERIFIED WRITES NOTHING. docs/17 §4.4 step 7 reads
--     "append *_rejected, raise CAREOS_GEOFENCE_UNVERIFIED". Those two clauses are
--     mutually exclusive under transactional semantics: the raise rolls the append back,
--     so an INSERT on that path would be code that provably never persists. This migration
--     raises without appending and says so out loud. The durable evidence of a
--     policy-forbidden attempt is the ABSENCE of a clock-in, which 0047's
--     app.detect_missed_visits raises as a missed_visit exception. The soft path
--     (needs_reason) does not raise, so its clock_in_rejected row persists exactly as
--     specified. Surfaced, not silently diverged.
--   * DN-0046e — HAND-OFF TO 0047, AND THE ONE THING THIS FILE CANNOT DO. §4.4 step 7
--     says the reason-code path should also "raise the matching visit_exception", and
--     §6.3 places app.request_location_exception beside it. Both need
--     public.visit_exception, which does not exist until 0047, and a migration must never
--     carry a forward dependency — so both belong to 0047, which owns that table:
--       (a) app.request_location_exception(p_visit, p_event, p_reason_code, p_note) is
--           implemented there. It records the caregiver's stated reason as an
--           `exception_requested` event and then re-enters THIS RPC carrying the reason
--           and the position the rejected attempt already captured, with a deterministic
--           client_event_id so a double-tap replays through step 3 instead of
--           double-clocking. Its call site is the contract this signature must satisfy.
--       (b) the exception ROW for a reason-supplied clock is 0047's to raise, through its
--           single funnel app.raise_visit_exception_internal(tenant, visit, caregiver,
--           kind, severity, detected_by, rule_key, evidence, dedupe_key, source_event,
--           actor) — kind mapping outside_geofence/low_accuracy/unavailable →
--           'outside_geofence'/'low_accuracy'/'location_unavailable', source_event = the
--           event id this RPC returns. 0046 cannot call it without referencing a table
--           that does not yet exist, so it stops at the ledger row, the D-024 projection
--           (verification_status='exception') and the outbox event, and 0047 attaches the
--           exception on top. INTEGRATION NOTE, surfaced rather than assumed: 0047's
--           header states the clock engine funnels through that emitter, which it cannot
--           do from here — the join must be made in 0047 (a trigger on visit_event, or a
--           create-or-replace of this body once the table exists), not in this file.
--   * DN-0046f — AN UNCONFIGURED TENANT STILL CLOCKS IN. docs/17 §4.2 pins
--     CAREOS_POLICY_MISSING as app.resolve_visit_policy's contract when no tenant-scope
--     row exists, and that contract is preserved untouched. What this engine does with it
--     is a separate question, and §4.4's enumerated failures (AAL2, NOT_FOUND, FORBIDDEN,
--     ALREADY_CLOCKED_IN, NOT_CLOCKED_IN, GEOFENCE_UNVERIFIED) deliberately do not include
--     it. Letting the resolver's error escape would mean an agency that has not yet
--     authored a visit policy has an entire workforce that cannot clock in — the exact
--     failure DN-0046b exists to prevent, multiplied by every caregiver. So the raise is
--     caught here and the engine degrades to the docs/17 §3.4 COLUMN DEFAULTS (radius 200,
--     max accuracy 250, location required, exceptions allowed) — the same documented floor
--     0048's trust score coalesces to, not invented numbers. The degradation is recorded,
--     not hidden: policy_id stays NULL on both the event and the visit, so the ledger says
--     "no policy was in force" and 0047/0048 can see it. Surfaced here and in the ST-204
--     result rather than silently diverged; if the corpus would rather block, this is one
--     `raise` away.
--   * Concurrency: the visit row is taken FOR UPDATE before the replay probe and the
--     sequence guard, so two browser tabs racing a double clock-in — or a PWA queue
--     flushing the same client_event_id twice — serialise into one accepted event and one
--     refusal, and the partial unique index on client_event_id is a backstop rather than
--     the mechanism. No advisory lock is needed: unlike assignment (0023), nothing here
--     spans two rows in a caregiver's scope.
--   * No new permission keys: a caregiver needs none to clock their own visit (docs/17 §5)
--     — the RPC authorises on assignment, exactly as 0013 did. The §5 catalog rows belong
--     to the migrations that first enforce them (0043 location.manage, 0044 policy.manage,
--     0047 visit.correct, 0050 visit.approve).
-- @trace: ST-204, D-014, D-016, D-022, D-024, D-025, D-029, D-030, docs/17 §4.3, §4.4

-- ── app.evaluate_location — the whole geofence rule, and nothing else ─────────────────
-- Invariant 13 in its purest form: a deterministic geospatial predicate, never an LLM
-- judgement. Four numbers in, one enum out. No table access, no now(), no I/O — which is
-- what makes it IMMUTABLE and what makes the docs/12 §4 truth table an exhaustive proof
-- rather than a sample. The clause ORDER is the contract, not an implementation detail:
-- accuracy is judged BEFORE distance, because a 900 m accuracy circle that happens to
-- centre inside the geofence has not verified anything.
--
-- It can never return 'suspicious'. That value exists in the visit_event CHECK (0045) for
-- the §4.5 fraud rules, which reach their verdict from impossible travel and overlap
-- evidence across events — a conclusion no single point can support. A point-in-time
-- predicate that could brand a caregiver "suspicious" is exactly the continuous-scoring
-- design docs/17 §2.1 overrode.
create or replace function app.evaluate_location(
  p_accuracy_m double precision, p_distance_m double precision,
  p_max_accuracy_m int, p_radius_m int
) returns text
language sql immutable set search_path = public as $$
  select case
    when p_distance_m is null or p_accuracy_m is null then 'unavailable'
    when p_accuracy_m > p_max_accuracy_m              then 'low_accuracy'
    when p_distance_m <= p_radius_m                   then 'verified'
    else                                                   'outside_geofence'
  end
$$;
-- Internal plumbing: reachable only from the definer bodies below (which run as the
-- function owner) and from pgTAP. No client ever needs it — D-030 forbids showing the
-- caregiver metres, so there is nothing for a browser to preview.
revoke all on function app.evaluate_location(double precision, double precision, int, int)
  from public, anon, authenticated;

-- ── app.clock_visit — re-signed (D-029: drop + create, never an overload) ─────────────
drop function if exists app.clock_visit(
  uuid, text, double precision, double precision, double precision);

-- Six defaulted parameters are appended to the 0013 signature. Every existing five-argument
-- call site — including the PostgREST named-argument call in apps/web today/actions.ts —
-- resolves here unchanged.
create or replace function app.clock_visit(
  p_visit uuid,
  p_event text,
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy double precision default null,
  p_client_event_id text default null,
  p_captured_at timestamptz default null,        -- DEVICE time: diagnostics, never maths
  p_offline boolean default false,
  p_reason_code text default null,
  p_note text default null,
  p_device_session_id text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v                public.visit;
  v_prior          public.visit_event;
  v_policy         public.visit_policy;
  v_location_id    uuid;
  v_version_id     uuid;
  v_radius_m       int;
  v_max_accuracy_m int;
  v_allow_exc      boolean;
  v_distance_m     double precision;
  v_required       boolean;
  v_location       text;                         -- the location_status verdict
  v_bucket         text;
  v_last           text;
  v_open           boolean;
  v_event_type     text;
  v_event_id       uuid;
  v_occurred_at    timestamptz;
  v_visit_status   text;
  v_verification   text;
  v_accepted       boolean;
  v_has_fence      boolean;                      -- is there anything to verify AGAINST?
begin
  -- ── 0. Input sanity (before any gate: a malformed call is not an authz question) ────
  if p_event not in ('clock_in','clock_out') then
    raise exception 'CAREOS_BAD_EVENT: event must be clock_in or clock_out'
      using errcode = 'P0001';
  end if;
  if p_reason_code is not null and p_reason_code not in
     ('alternate_location','gps_unavailable','address_incorrect','emergency_visit',
      'device_issue','network_failure','other') then
    raise exception 'CAREOS_BAD_REASON_CODE: % is not a location exception reason',
      p_reason_code using errcode = 'P0001';
  end if;

  -- ── 1. AAL2 (invariant 3): a clock event is a PHI write about a named client ────────
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to clock a visit'
      using errcode = '42501';
  end if;

  -- ── 2. Existence + assignment. FOR UPDATE serialises two tabs racing the same visit;
  --       the tenant predicate makes a cross-tenant id indistinguishable from a typo. ──
  select * into v from public.visit
   where id = p_visit and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v.caregiver_id is distinct from auth.uid() then
    raise exception 'CAREOS_FORBIDDEN: only the assigned caregiver can clock this visit'
      using errcode = '42501';
  end if;

  -- ── 3. Idempotent replay. The PWA queue (D-022, §7.6) replays a queued action through
  --       this RPC on reconnect; the client_event_id makes that safe BY CONSTRUCTION.
  --       A replay is a RETURN VALUE, never an error and never a second row — the
  --       0023 assign_visit 'unchanged' posture, restated for the offline lane. ────────
  if p_client_event_id is not null then
    select * into v_prior from public.visit_event ve
     where ve.tenant_id = v.tenant_id and ve.visit_id = v.id
       and ve.client_event_id = p_client_event_id
     order by ve.created_at
     limit 1;
    if v_prior.id is not null then
      -- Recompute the bucket from what was BOUND at capture time, not from today's
      -- config: a replay must report the decision that was made, not re-litigate it.
      -- Per-location override first, then the bound policy, then the §3.4 floor for a
      -- capture taken under DN-0046f. Two scalar subqueries rather than a join, because
      -- either side may legitimately be absent and an outer join here reads like a puzzle.
      v_radius_m := coalesce(
        (select slv.geofence_radius_m from public.service_location_version slv
          where slv.id = v_prior.service_location_version_id),
        (select vp.geofence_radius_m from public.visit_policy vp
          where vp.id = v_prior.policy_id),
        200);
      return jsonb_build_object(
        'ok',                  v_prior.event_type in ('clock_in','clock_out'),
        'replayed',            true,
        'event_id',            v_prior.id,
        'status',              v.status,
        'verification_status', v.verification_status,
        'location_status',     v_prior.location_status,
        'occurred_at',         v_prior.occurred_at,
        'needs_reason',        v_prior.event_type not in ('clock_in','clock_out'),
        'distance_bucket',     case
            when v_prior.distance_m is null or v_radius_m is null then null
            when v_prior.distance_m <= v_radius_m                 then 'inside'
            when v_prior.distance_m <= v_radius_m * 3             then 'near'
            else                                                       'far' end);
    end if;
  end if;

  -- ── 4. Sequence guard, read from the ledger (the projection is never the authority).
  --       Only accepted events open or close a shift: a *_rejected row is a record of a
  --       refused attempt, so a caregiver who was pushed back can still clock in. ──────
  select ve.event_type into v_last
    from public.visit_event ve
   where ve.visit_id = v.id and ve.event_type in ('clock_in','clock_out')
   order by ve.occurred_at desc, ve.created_at desc
   limit 1;
  v_open := coalesce(v_last = 'clock_in', false);
  if p_event = 'clock_in' and v_open then
    raise exception 'CAREOS_ALREADY_CLOCKED_IN: this visit already has an open clock-in'
      using errcode = 'P0001';
  end if;
  if p_event = 'clock_out' and not v_open then
    raise exception 'CAREOS_NOT_CLOCKED_IN: this visit has no open clock-in to close'
      using errcode = 'P0001';
  end if;

  -- ── 5. Resolve policy + service location version, and BIND them (DN-0046a). Already
  --       bound (clock-out, or a second attempt) ⇒ reuse: the visit is measured against
  --       the version it was verified against, forever. ───────────────────────────────
  if v.policy_id is not null then
    select vp.* into v_policy from public.visit_policy vp where vp.id = v.policy_id;
  end if;
  if v_policy.id is null then
    begin
      v_policy := app.visit_policy_for(v.id);     -- 0044, §4.2
    exception when sqlstate 'P0001' then
      -- Only the missing-policy case degrades (DN-0046f); anything else the resolver
      -- says is a real failure and belongs to the caller, unedited.
      if sqlerrm not like 'CAREOS_POLICY_MISSING%' then
        raise;
      end if;
      -- v_policy is left unassigned: every field reads NULL, and the coalesces below
      -- substitute the docs/17 §3.4 documented floor. policy_id therefore stays NULL on
      -- the ledger row and on the visit, which is the honest record of "unconfigured".
    end;
  end if;
  v_max_accuracy_m := coalesce(v_policy.max_accuracy_m, 250);          -- §3.4 default
  v_allow_exc      := coalesce(v_policy.allow_location_exception, true);
  v_required       := coalesce(case when p_event = 'clock_in'
                                    then v_policy.require_clock_in_location
                                    else v_policy.require_clock_out_location end, true);

  if v.service_location_version_id is not null then
    -- Already bound by an earlier accepted clock: nothing re-resolves, ever (D-014).
    v_location_id := v.service_location_id;
    v_version_id  := v.service_location_version_id;
  elsif v.service_location_id is not null then
    -- The scheduler named a place of care. That one, or nothing — never a substitute
    -- address the scheduler did not choose (DN-0046b).
    v_location_id := v.service_location_id;
    select sl.current_version_id into v_version_id
      from public.service_location sl
     where sl.id = v_location_id and sl.tenant_id = v.tenant_id and sl.active;
  else
    -- Otherwise the client's primary, active, in-effect location. None ⇒ v_version_id
    -- stays null ⇒ distance null ⇒ 'unavailable'. Care is not blocked (DN-0046b).
    select sl.id, sl.current_version_id into v_location_id, v_version_id
      from public.service_location sl
     where sl.tenant_id = v.tenant_id and sl.client_id = v.client_id
       and sl.active and sl.is_primary
       and sl.effective_from <= current_date
       and (sl.effective_until is null or sl.effective_until >= current_date)
     order by sl.created_at
     limit 1;
  end if;

  -- ── 6. Distance + verdict. Per-location radius overrides the policy default (§3.3). ─
  if v_version_id is not null then
    select slv.geo is not null,
           case
             when slv.geo is null or p_lat is null or p_lng is null then null
             else app.distance_m(slv.geo, p_lat, p_lng)
           end,
           slv.geofence_radius_m
      into v_has_fence, v_distance_m, v_radius_m
      from public.service_location_version slv
     where slv.id = v_version_id;
  end if;
  v_has_fence := coalesce(v_has_fence, false);
  v_radius_m := coalesce(v_radius_m, v_policy.geofence_radius_m, 200);  -- §3.4 default

  if not v_required then
    v_location := 'not_required';                 -- the policy asked for no location here
  else
    v_location := app.evaluate_location(p_accuracy, v_distance_m,
                                        v_max_accuracy_m, v_radius_m);
  end if;

  -- Buckets, never metres (DN-0046c). 'near' is 3× the radius: close enough that "you may
  -- be at the wrong door", far enough that "you are not at this address" is honest.
  v_bucket := case
      when v_distance_m is null or v_radius_m is null then null
      when v_distance_m <= v_radius_m                 then 'inside'
      when v_distance_m <= v_radius_m * 3             then 'near'
      else                                                 'far' end;

  -- ── 7. Decide (§4.4 step 7, in order) ──────────────────────────────────────────────
  if v_location in ('verified','not_required') then
    v_accepted   := true;
    v_event_type := p_event;
  elsif not v_has_fence then
    -- DN-0046b, made real. There is no geofence to verify against: the client has no
    -- service location, or the current version was never given a verified pin (D-025
    -- requires a human to attest one, and nobody has yet). That is an AGENCY CONFIG gap,
    -- and the caregiver standing at the door cannot remedy it — demanding a "reason" for
    -- it would be asking them to apologise for a record they cannot see or edit.
    -- So the clock stands. The event keeps its honest 'unavailable' status, the visit
    -- lands in verification_status='exception', and 0047's sweep surfaces it to the
    -- coordinator who CAN fix it. Care is never blocked by missing configuration
    -- (board proposal Rule 8; docs/17 §4.4 step 7).
    v_accepted   := true;
    v_event_type := p_event;
  elsif not v_allow_exc then
    -- Hard refusal. Nothing is appended: the raise would roll the append back anyway, and
    -- code that provably never persists is a lie in the ledger's shape (DN-0046d).
    raise exception
      'CAREOS_GEOFENCE_UNVERIFIED: this visit''s policy does not allow an unverified location'
      using errcode = 'P0001';
  elsif p_reason_code is null then
    -- Soft refusal. The attempt IS recorded, and the caregiver gets "Try again" /
    -- "Request exception" (docs/17 §7.1). No exception is raised for a retry.
    v_accepted   := false;
    v_event_type := p_event || '_rejected';
  else
    -- The caregiver told us why. The event stands, carrying its unverified status, and
    -- 0047 turns that status into a reviewable visit_exception (DN-0046e).
    v_accepted   := true;
    v_event_type := p_event;
  end if;

  -- ── 8. Append the ledger row. Server time is authoritative: occurred_at defaults to
  --       now() and no caller-supplied value ever reaches it (§3.6). p_captured_at is
  --       kept beside it for drift diagnostics only. ─────────────────────────────────
  insert into public.visit_event (
    tenant_id, visit_id, caregiver_id, event_type,
    latitude, longitude, accuracy_m, method, note,
    client_event_id, client_captured_at,
    service_location_version_id, policy_id, distance_m, location_status,
    capture_source, is_offline, device_session_id, reason_code)
  values (
    v.tenant_id, v.id, auth.uid(), v_event_type,
    p_lat, p_lng, p_accuracy, 'web', p_note,
    p_client_event_id, p_captured_at,
    v_version_id, v_policy.id, v_distance_m, v_location,
    case when coalesce(p_offline, false) then 'offline' else 'web' end,
    coalesce(p_offline, false), p_device_session_id, p_reason_code)
  returning id, occurred_at into v_event_id, v_occurred_at;

  -- ── 9. Advance the projections (D-024) and bind. A refused attempt changes nothing
  --       about the visit — it did not start, and it is not an exception yet. ─────────
  v_visit_status := v.status;
  v_verification := v.verification_status;
  if v_accepted then
    v_visit_status := case when p_event = 'clock_in' then 'in_progress' else 'completed' end;
    -- An exception already recorded on this visit is never downgraded by a later clean
    -- event: the visit HAD a problem, and the record says so until a human disposes it.
    v_verification := case
        when v_location not in ('verified','not_required')            then 'exception'
        when v.verification_status in ('exception','manual_review') then v.verification_status
        else                                                               'verified' end;
    update public.visit
       set status                      = v_visit_status,
           verification_status         = v_verification,
           service_location_id         = coalesce(service_location_id, v_location_id),
           service_location_version_id = coalesce(service_location_version_id, v_version_id),
           policy_id                   = coalesce(policy_id, v_policy.id),
           updated_at                  = now(),
           row_version                 = row_version + 1
     where id = v.id;   -- definer bypasses the visit RLS; the caller is already proven

    -- Outbox (invariant 7, second half) — IDs and enums only; consumers refetch under
    -- their own RLS. The visit.started / visit.completed lifecycle events are emitted in
    -- parallel by trg_visit_domain_events (0027) off the status delta above; these three
    -- carry the VERIFICATION story, which no single row delta expresses.
    perform app.emit_event_internal(v.tenant_id, auth.uid(),
      case when p_event = 'clock_out'                      then 'visit.clock_out.completed'
           when v_location in ('verified','not_required')  then 'visit.clock_in.verified'
           else                                            'visit.clock_in.exception' end,
      'visit', v.id,
      jsonb_build_object('visit_id', v.id,
                         'event_id', v_event_id,
                         'event_type', v_event_type,
                         'caregiver_id', v.caregiver_id,
                         'client_id', v.client_id,
                         'location_status', v_location));   -- no coordinates (D-030)
  end if;

  return jsonb_build_object(
    'ok',                  v_accepted,
    'replayed',            false,
    'event_id',            v_event_id,
    'status',              v_visit_status,
    'verification_status', v_verification,
    'location_status',     v_location,
    'occurred_at',         v_occurred_at,
    'needs_reason',        not v_accepted,
    'distance_bucket',     v_bucket);
end $$;

revoke all on function app.clock_visit(uuid, text, double precision, double precision,
  double precision, text, timestamptz, boolean, text, text, text) from public, anon;
grant execute on function app.clock_visit(uuid, text, double precision, double precision,
  double precision, text, timestamptz, boolean, text, text, text) to authenticated;
