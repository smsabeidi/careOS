-- ST-206 · Migration 0048 — the visit trust score: arithmetic, not a verdict
-- D-028 ratified a per-visit trust score, and a score about a person is precisely the
-- artifact that erodes invariant 8 by accident. This migration therefore ships the score
-- as arithmetic, and as nothing else.
--
-- WHY THIS EXISTS AT ALL. When an agency disputes a caregiver's hours today, the
-- caregiver's only defence is their word against a spreadsheet. app.visit_trust_score
-- answers instead with a subtraction: six components, each starting at full marks, each
-- losing points only for a concrete, enumerable condition that is TRUE OF A ROW someone
-- can point at. Every deduction appends a machine-readable reason code plus the id of
-- the row that evidences it, so "your visit scored 62" decomposes into "the arrival had
-- no usable location fix (event a101) and you clocked in 41 minutes after the scheduled
-- start (event a101)". A caregiver can check that. A caregiver cannot check a model's
-- opinion, and neither can a wage-and-hour arbitrator. This is the left column of
-- docs/17 §1.1 and invariant 13 in full: no model touches any of it.
--
-- WHY THE WEIGHTS ARE VERSIONED. model_version pins the weight set ('trust.v1':
-- location 35, time 20, schedule 15, identity 15, device 10, consistency 5) that
-- produced a snapshot. A future trust.v2 with different weights never rewrites a v1
-- row, and a v1 assessment read three years from now still says which arithmetic
-- produced it — which is the only property that makes an old score defensible rather
-- than merely old. The band CHECK below is likewise scoped to trust.v1 so a new weight
-- set may ship new bands additively, without a contraction (invariant 12).
--
-- WHAT THIS MIGRATION MAY NEVER BECOME. Nothing here may drive an automated employment
-- action. There is deliberately no trigger that scores on write, no cron entry, no queue
-- consumer, no notification, no outbox event and no write path from a band to any
-- employment record — a band cannot reach `employee`, `offer` or `revocation_checklist`
-- because no code in this file writes anything but one append-only evidence row. The
-- only consumer that characterises an INDIVIDUAL is `visit.operational_profile`
-- (docs/17 §11): T2, a required Owner/HR disposer, a draft only, structurally barred
-- from writing an employment record (D-021 — the system never proposes termination).
-- If a future story wants this score to gate anything, that is a decision-log entry and
-- a human disposer, not a patch to this file.
--
-- A CONSEQUENCE OF THE RATIFIED WEIGHTS, NAMED RATHER THAN QUIETLY FIXED: consistency is
-- worth 5 of 100, so a live impossible_travel finding alone cannot push an otherwise
-- clean visit out of the 'verified' band. That is correct, not a bug. The score measures
-- how good THIS visit's evidence is; a cross-visit fraud finding is a `critical` row in
-- the 0047 queue, and it is the queue — not the score — that blocks approval
-- (CAREOS_APPROVAL_BLOCKED, docs/17 §4.7). Making the score the enforcement mechanism is
-- exactly the drift D-028 forbids.
--
-- PHI posture (invariant 5, D-030): reason codes are enum-like strings carrying row ids.
-- Never prose about a person, never a coordinate. The score is DERIVED FROM coordinates
-- and contains none — enforced twice, by the closed-vocabulary and no-coordinate CHECKs
-- on the table (the 0047 chk_visit_exception_evidence_no_coords precedent) and by the
-- audit emitter's four-key payload.
--
-- Precedents copied rather than re-invented: 0013 (append-only clock ledger; an audit
-- emitter that deliberately omits lat/lng), 0011 (definer audit trigger with the
-- null-tenant seed guard), 0023 (Lane-B idiom: gate → input sanity → existence → work →
-- return), 0047 (definer-only writers on an [AO] ledger a client may only read).
--
-- Forward bindings, every one pinned in the docs/17 build contract and landing earlier
-- in the chain: visit_event's capture columns (0045 §3.6), app.visit_policy_for
-- (0044 §4.2), visit_exception + visit_exception_disposition (0047 §3.7/§3.8).
-- @trace: ST-206, D-021, D-028, D-030, docs/17 §3.9, docs/17 §4.9

-- ══ 1 · Permission vocabulary ═════════════════════════════════════════════════════════
-- 0048 introduces no new key: docs/17 §5 gives the verification surface two, and 0047
-- owns them. They are restated verbatim (same descriptions, so an out-of-order landing
-- cannot install a competing wording) with on-conflict-do-nothing, so this file is
-- self-sufficient. Real config belongs in the migration, never in the synthetic seed —
-- the 0011 precedent.
insert into public.permission (key, description) values
  ('visit.verify.read', 'See the visit exception queue and verification detail'),
  ('visit.verify.act',  'Dispose visit exceptions — acknowledge, resolve, dismiss, escalate')
on conflict (key) do nothing;

-- ══ 2 · Audit emitter (definer; ids, one enum and one integer — nothing else) ═════════
-- Mirrors app.audit_visit_event (0013/0045): the narrowest payload that answers "what
-- happened". The reason codes are deliberately NOT copied into the ledger — they are
-- already immutable on the assessment row, and duplicating a growing array into the
-- tamper-evident hash chain buys bytes and no evidence. Seed guard in the 0011/0027
-- early-return form: the cron/seed path has no tenant context and is not a user action.
create or replace function app.audit_visit_trust_assessment() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('visit.trust_assessed', 'visit_trust_assessment', new.id,
    jsonb_build_object('visit_id', new.visit_id,
                       'band', new.band,
                       'score', new.score,
                       'model_version', new.model_version));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_visit_trust_assessment() from public;

-- ══ 3 · visit_trust_assessment — append-only score snapshots (§3.9) ═══ [AO] PHI ══════
-- docs/17 §3.9 pins `computed_at` and no `created_at`: the moment the arithmetic ran IS
-- this row's creation, and a second always-equal timestamp would be noise a reader has
-- to reconcile. Append-only, so no updated_at and no row_version (invariant 1): a score
-- is evidence, and evidence is never edited. A re-score is a NEW snapshot — "what we
-- knew at 14:00" and "what we knew at 17:00" are different evidentiary facts and both
-- have to survive.
create table public.visit_trust_assessment (                            -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  score int not null check (score between 0 and 100),
  band text not null check (band in
    ('verified','verified_with_exception','requires_review','high_risk')),
  components jsonb not null,     -- points EARNED per component, e.g. {"location":25,…}
  reasons jsonb not null,        -- [{code,component,points,detail_id}] — codes + ids only
  model_version text not null,   -- 'trust.v1' — the weight set that produced this row
  computed_at timestamptz not null default now(),
  constraint chk_visit_trust_assessment_shape
    check (jsonb_typeof(components) = 'object' and jsonb_typeof(reasons) = 'array'),
  -- The band can never disagree with its own arithmetic — a snapshot whose band was
  -- hand-set would be the exact artifact D-028 forbids. Scoped to trust.v1 so a future
  -- weight set ships its own banding additively.
  constraint chk_visit_trust_assessment_band_v1
    check (model_version <> 'trust.v1' or band = case
             when score >= 90 then 'verified'
             when score >= 75 then 'verified_with_exception'
             when score >= 50 then 'requires_review'
             else 'high_risk' end),
  -- D-030 made structural, the 0047 evidence-CHECK precedent carried onto an array of
  -- objects: a coordinate may never reach a row that the verification queue reads,
  -- exports, or hands to a capability. jsonb_path_exists is immutable, so it is legal
  -- in a CHECK; @? suppresses type errors, so a malformed element cannot throw here.
  constraint chk_visit_trust_assessment_no_coords
    check (not (components ?| array['lat','lng','latitude','longitude',
                                    'coordinates','geo','point']::text[])
       and not (reasons @? '$[*].keyvalue() ? (@.key == "lat" || @.key == "lng" ||
                  @.key == "latitude" || @.key == "longitude" ||
                  @.key == "coordinates" || @.key == "geo" || @.key == "point")')),
  -- The closed trust.v1 reason vocabulary (D-028: codes, never prose about a person).
  -- A CHECK rather than a convention, because the failure mode this guards against is a
  -- future caller writing a sentence into `code` — which is how a deterministic score
  -- quietly becomes a character assessment. Every element must carry a `code`, and every
  -- `code` must be one of the twelve.
  constraint chk_visit_trust_assessment_reason_vocabulary
    check (model_version <> 'trust.v1' or not (reasons @? '$[*] ? (!exists(@.code) || !(
             @.code == "location.outside_geofence" ||
             @.code == "location.low_accuracy" ||
             @.code == "location.unavailable" ||
             @.code == "time.late_start" ||
             @.code == "time.no_clock_out" ||
             @.code == "schedule.unscheduled" ||
             @.code == "identity.unassigned_caregiver" ||
             @.code == "device.offline_capture" ||
             @.code == "device.session_missing" ||
             @.code == "consistency.impossible_travel" ||
             @.code == "consistency.overlap" ||
             @.code == "consistency.repeated_coordinates"))'))
);
create index idx_visit_trust_assessment_tenant
  on public.visit_trust_assessment (tenant_id, computed_at desc);
create index idx_visit_trust_assessment_visit
  on public.visit_trust_assessment (visit_id, computed_at desc);
-- The verification queue's hot filter: only the two lower bands are ever worked, and
-- 'verified' is the overwhelming majority of rows.
create index idx_visit_trust_assessment_review
  on public.visit_trust_assessment (tenant_id, computed_at desc)
  where band in ('requires_review','high_risk');

-- One line on purpose, at the cost of the 88-column wrap: scripts/check-matrix.sh
-- detects append-only tables by grepping `create trigger … before update or delete on
-- public.<table>` per LINE, so a wrapped declaration is an invisible table to the gate.
create trigger trg_visit_trust_assessment_ao before update or delete on public.visit_trust_assessment
  for each row execute function app.forbid_mutation();
create trigger trg_visit_trust_assessment_audit after insert
  on public.visit_trust_assessment
  for each row execute function app.audit_visit_trust_assessment();

alter table public.visit_trust_assessment enable row level security;
alter table public.visit_trust_assessment force row level security;

-- Read: the verification surface (visit.verify.read) or a principal already entitled to
-- the whole schedule (schedule.read). PHI-by-linkage ⇒ AAL2 (invariant 3).
-- Care-team membership alone is deliberately NOT sufficient and neither is being the
-- scored visit's caregiver: an assessment characterises the CAREGIVER, so it is an
-- operations artifact, not a clinical one, and D-028's promise that a disputing
-- caregiver gets an arithmetic answer is kept by disclosing the subtraction through the
-- verification surface — with a human in the loop — rather than by opening every
-- snapshot to probing. Flagged in the ST-206 result as a deliberate divergence from
-- 0047, where the caregiver DOES read their own exceptions.
create policy visit_trust_assessment_select_verifier on public.visit_trust_assessment
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and (app.has_perm('visit.verify.read') or app.has_perm('schedule.read')));

-- No INSERT grant and no INSERT policy, which is stricter than [AO]'s usual
-- select+insert: a client that could insert a score could forge one, and a forged score
-- is worse than no score. app.record_trust_assessment (definer) is the only writer.
grant select on public.visit_trust_assessment to authenticated;
  -- no insert/update/delete: append-only, and definer-written only

-- ══ 4 · app.visit_trust_score — computes, stores nothing (§4.9) ═══════════════════════
-- Six components, each floored at zero, summed to 0..100. Deductions fire only on
-- conditions that are true of the LEDGER, and the function never re-derives a fact
-- another engine owns: impossible travel and overlap are READ from visit_exception,
-- which 0047 computes. Invariant 13 means exactly one place decides each fact.
--
-- DN-0048a: the deduction table below is agency policy expressed as numbers, not a
-- measurement. It is pinned in constants so that any snapshot's arithmetic is
-- reconstructible from its model_version alone — that is what makes 'trust.v1' a
-- promise rather than a label.
create or replace function app.visit_trust_score(p_visit uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  -- trust.v1 component weights (docs/17 §4.9) — the component maxima.
  c_w_location    constant int := 35;
  c_w_time        constant int := 20;
  c_w_schedule    constant int := 15;
  c_w_identity    constant int := 15;
  c_w_device      constant int := 10;
  c_w_consistency constant int := 5;
  -- trust.v1 deduction table. Full-component failures reuse the weights above.
  c_d_loc_outside  constant int := 25;   -- the wrong place, positively evidenced
  c_d_loc_unavail  constant int := 20;   -- no usable location evidence at all
  c_d_loc_accuracy constant int := 10;   -- right place, weak fix
  c_d_time_late    constant int := 8;
  c_d_dev_offline  constant int := 6;
  c_d_dev_session  constant int := 4;
  c_d_con_travel   constant int := 5;    -- physically impossible: the strongest signal
  c_d_con_repeat   constant int := 3;
  c_d_con_overlap  constant int := 2;    -- most often a rostering error, not a field one

  v_tenant      uuid;
  v_client      uuid;
  v_caregiver   uuid;
  v_version_id  uuid;
  v_sched_start timestamptz;
  v_created_at  timestamptz;

  v_policy      public.visit_policy;
  v_late_min    int;
  v_missing_min int;
  v_early_min   int;
  v_missed_min  int;

  v_in_id   uuid;
  v_in_at   timestamptz;
  v_out_id  uuid;
  v_dup_id  uuid;

  v_location    int := c_w_location;
  v_time        int := c_w_time;
  v_schedule    int := c_w_schedule;
  v_identity    int := c_w_identity;
  v_device      int := c_w_device;
  v_consistency int := c_w_consistency;

  v_identity_flagged boolean := false;
  v_offline_flagged  boolean := false;
  v_session_flagged  boolean := false;

  v_reasons jsonb := '[]'::jsonb;
  v_score   int;
  v_band    text;
  r         record;
begin
  -- ── 1. Gate. Deliberately the same shape as the table's read policy, so this
  --       definer function can never be used to compute a score its caller could not
  --       have read. visit.verify.act is additionally accepted because acting on
  --       verification necessarily includes seeing the evidence — and because
  --       app.record_trust_assessment calls this function under exactly that
  --       permission. ───────────────────────────────────────────────────────────────
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to score a visit'
      using errcode = '42501';
  end if;
  if not (app.has_perm('visit.verify.read') or app.has_perm('visit.verify.act')
          or app.has_perm('schedule.read')) then
    raise exception
      'CAREOS_FORBIDDEN: visit.verify.read or schedule.read is required to score a visit'
      using errcode = '42501';
  end if;

  -- ── 2. Existence, inside the caller's tenant. A cross-tenant id is indistinguishable
  --       from a typo, which is the point (the 0023/0046 posture). ───────────────────
  select v.tenant_id, v.client_id, v.caregiver_id, v.service_location_version_id,
         v.scheduled_start, v.created_at
    into v_tenant, v_client, v_caregiver, v_version_id, v_sched_start, v_created_at
    from public.visit v
   where v.id = p_visit and v.tenant_id = app.current_tenant_id();
  if v_tenant is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;

  -- ── 3. Thresholds come from the resolved policy (0044 owns the merge order). An
  --       unconfigured tenant raises CAREOS_POLICY_MISSING and is NOT silently scored
  --       against someone else's numbers — 0047's "skipped, visibly, rather than judged
  --       against a threshold nobody set", restated for a function that cannot skip. ─
  v_policy      := app.visit_policy_for(p_visit);
  v_late_min    := v_policy.late_threshold_minutes;
  v_missing_min := v_policy.missing_clock_out_minutes;
  v_early_min   := v_policy.early_clock_in_minutes;
  v_missed_min  := v_policy.missed_visit_minutes;

  -- ── 4. One pass over the clock ledger. Rejected captures ('clock_in_rejected', …)
  --       are refused attempts, not clocks, and are excluded; a `correction` is already
  --       visible to a reviewer as a 0047 manual_correction exception and carries no
  --       trust.v1 code of its own. ─────────────────────────────────────────────────
  for r in
    select e.id, e.event_type, e.occurred_at, e.caregiver_id, e.location_status,
           e.capture_source, e.is_offline, e.device_session_id
      from public.visit_event e
     where e.visit_id = p_visit and e.tenant_id = v_tenant
       and e.event_type in ('clock_in','clock_out')
     order by e.occurred_at, e.created_at
  loop
    if r.event_type = 'clock_in' then
      if v_in_id is null then                     -- earliest clock-in is the arrival
        v_in_id := r.id;
        v_in_at := r.occurred_at;
      end if;
    else
      v_out_id := r.id;                           -- latest clock-out is the departure
    end if;

    -- Location deducts PER EVENT: two unverifiable captures are two failures, and a
    -- visit whose arrival AND departure are both unlocatable must not score the same as
    -- one that merely lost its fix on the way out. 'verified' and 'not_required' cost
    -- nothing — the second because the policy asked for no location here at all. A NULL
    -- status is a pre-0045 row: absence of evidence, scored as absence of evidence.
    if r.location_status is null or r.location_status = 'unavailable' then
      v_location := v_location - c_d_loc_unavail;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'location.unavailable', 'component', 'location',
        'points', -c_d_loc_unavail, 'detail_id', r.id));
    elsif r.location_status = 'low_accuracy' then
      v_location := v_location - c_d_loc_accuracy;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'location.low_accuracy', 'component', 'location',
        'points', -c_d_loc_accuracy, 'detail_id', r.id));
    elsif r.location_status in ('outside_geofence','suspicious') then
      -- 'suspicious' has no writer today (app.evaluate_location never returns it, §4.3)
      -- and visit_event is append-only, so it is folded into the strongest location
      -- failure rather than given a thirteenth code outside the closed vocabulary.
      v_location := v_location - c_d_loc_outside;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'location.outside_geofence', 'component', 'location',
        'points', -c_d_loc_outside, 'detail_id', r.id));
    end if;

    -- Identity: the person who clocked is not the person the visit was assigned to.
    -- Fires once; the first offending event is the evidence a reviewer opens.
    if not v_identity_flagged and r.caregiver_id is distinct from v_caregiver then
      v_identity := v_identity - c_w_identity;
      v_identity_flagged := true;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'identity.unassigned_caregiver', 'component', 'identity',
        'points', -c_w_identity, 'detail_id', r.id));
    end if;

    -- Device: an offline replay is real work with a weaker chain of custody (§7.6 — an
    -- offline event is never presented as ordinarily verified), and a capture with no
    -- device session has no device evidence at all. Neither is an accusation; both are
    -- reasons the evidence is thinner than a live web capture's.
    if not v_offline_flagged
       and (coalesce(r.is_offline, false) or r.capture_source = 'offline') then
      v_device := v_device - c_d_dev_offline;
      v_offline_flagged := true;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'device.offline_capture', 'component', 'device',
        'points', -c_d_dev_offline, 'detail_id', r.id));
    end if;
    if not v_session_flagged
       and (r.device_session_id is null or btrim(r.device_session_id) = '') then
      v_device := v_device - c_d_dev_session;
      v_session_flagged := true;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'device.session_missing', 'component', 'device',
        'points', -c_d_dev_session, 'detail_id', r.id));
    end if;
  end loop;

  -- ── 5. No clock ledger at all ⇒ no location and no device evidence EXISTS to weigh.
  --       Both components go to zero with one reason each; detail_id is null because
  --       the evidence is the absence of a row, and pointing at nothing honestly beats
  --       pointing at something irrelevant. ──────────────────────────────────────────
  if v_in_id is null and v_out_id is null then
    v_location := 0;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'location.unavailable', 'component', 'location',
      'points', -c_w_location, 'detail_id', null::uuid));
    v_device := 0;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'device.session_missing', 'component', 'device',
      'points', -c_w_device, 'detail_id', null::uuid));
  end if;

  -- ── 6. Identity, the unassigned case: nobody was ever on this visit, so nothing
  --       identifies who delivered the care. ─────────────────────────────────────────
  if not v_identity_flagged and v_caregiver is null then
    v_identity := v_identity - c_w_identity;
    v_identity_flagged := true;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'identity.unassigned_caregiver', 'component', 'identity',
      'points', -c_w_identity, 'detail_id', null::uuid));
  end if;

  -- ── 7. Time. Lateness is measured against the POLICY's own grace, so an agency
  --       running a 15-minute threshold does not inherit someone else's 7. Flat, not
  --       proportional: "how late" is a number the timesheet already carries, and a
  --       sliding penalty would be a curve nobody can check. ─────────────────────────
  if v_in_id is not null
     and v_in_at > v_sched_start + make_interval(mins => v_late_min) then
    v_time := v_time - c_d_time_late;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'time.late_start', 'component', 'time',
      'points', -c_d_time_late, 'detail_id', v_in_id));
  end if;
  -- A visit still inside its clock-out window is not missing anything yet; only once
  -- the policy's missing_clock_out grace has passed does the absence become a fact.
  -- Costs the whole component: an unclosed visit has no verified duration at all, which
  -- is the single most expensive defect a timesheet can carry.
  if v_out_id is null
     and now() > v_sched_start + make_interval(mins => v_missed_min + v_missing_min) then
    v_time := v_time - c_w_time;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'time.no_clock_out', 'component', 'time',
      'points', -c_w_time, 'detail_id', v_in_id));
  end if;

  -- ── 8. Schedule. Not "was it late" (that is §7) but "was this work scheduled at
  --       all". Three enumerable ways the answer is no: the visit ROW was created at or
  --       after its own clock-in (a back-fill — someone wrote the schedule around the
  --       work), the arrival predates the policy's early-clock-in window, or the
  --       arrival lands after the visit was already a no-show by policy. ─────────────
  if v_in_id is not null and (
       v_created_at >= v_in_at
       or v_in_at < v_sched_start - make_interval(mins => v_early_min)
       or v_in_at > v_sched_start + make_interval(mins => v_missed_min)) then
    v_schedule := v_schedule - c_w_schedule;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'schedule.unscheduled', 'component', 'schedule',
      'points', -c_w_schedule, 'detail_id', v_in_id));
  end if;

  -- ── 9. Consistency, part one: findings 0047 already decided. One deduction per KIND,
  --       so a sweep that raised the same finding under two dedupe keys cannot
  --       double-charge. A DISMISSED exception is a human saying "this was not a real
  --       problem" — a deterministic input, not a judgement call — so it stops costing
  --       points; acknowledged / resolved / escalated leave the fact standing, because
  --       a fixed problem still happened. ─────────────────────────────────────────────
  for r in
    select distinct on (e.kind) e.kind, e.id as detail_id
      from public.visit_exception e
     where e.tenant_id = v_tenant and e.visit_id = p_visit
       and e.kind in ('impossible_travel','overlapping_visits')
       and coalesce((select d.disposition
                       from public.visit_exception_disposition d
                      where d.exception_id = e.id
                      order by d.created_at desc, d.id desc
                      limit 1), '') <> 'dismissed'
     order by e.kind, e.created_at, e.id     -- the earliest of each kind is the evidence
  loop
    if r.kind = 'impossible_travel' then
      v_consistency := v_consistency - c_d_con_travel;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'consistency.impossible_travel', 'component', 'consistency',
        'points', -c_d_con_travel, 'detail_id', r.detail_id));
    else
      v_consistency := v_consistency - c_d_con_overlap;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'consistency.overlap', 'component', 'consistency',
        'points', -c_d_con_overlap, 'detail_id', r.detail_id));
    end if;
  end loop;

  -- ── 10. Consistency, part two: byte-identical coordinates. Two genuine satellite
  --        fixes are never bit-for-bit equal, even from the same doorstep on the same
  --        phone — so an exact repeat across two different clients is a replayed or
  --        synthesised fix rather than a coincidence.
  --
  --        WHAT IS DELIBERATELY NOT FLAGGED, because each of these is ordinary:
  --          · the same client's address — repeats there are the entire point of a
  --            geofence, and this is the false positive that would make the signal
  --            useless. Excluded by v2.client_id <> this visit's client;
  --          · this visit's own arrival and departure (ve2.visit_id <> ve1.visit_id);
  --          · another caregiver's captures (the signal is about one person's device);
  --          · two clients who genuinely share a residence or facility, WHERE THE
  --            SYSTEM KNOWS IT — both visits bound to the same service_location_version
  --            is structural proof of a shared place of care, so it is excluded rather
  --            than merely apologised for;
  --          · anything older than 90 days.
  --        The residual false positive — two clients at one address that has never been
  --        modelled as one service location — is accepted and costs 3 of 100. It is a
  --        signal for a human queue, never a finding: a disposer resolves it through
  --        0047 (D-028 — nothing here drives an action on its own).
  --
  --        detail_id is THIS visit's event. The other visit's ids belong to another
  --        client's record and do not travel into this assessment (invariant 5). ─────
  select ve1.id into v_dup_id
    from public.visit_event ve1
   where ve1.visit_id = p_visit
     and ve1.tenant_id = v_tenant
     and ve1.event_type in ('clock_in','clock_out')
     and ve1.latitude is not null and ve1.longitude is not null
     and exists (
       select 1
         from public.visit_event ve2
         join public.visit v2 on v2.id = ve2.visit_id and v2.tenant_id = ve2.tenant_id
        where ve2.tenant_id = ve1.tenant_id
          and ve2.caregiver_id = ve1.caregiver_id
          and ve2.visit_id <> ve1.visit_id
          and ve2.event_type in ('clock_in','clock_out')
          and ve2.latitude = ve1.latitude
          and ve2.longitude = ve1.longitude
          and ve2.occurred_at <= ve1.occurred_at
          and ve2.occurred_at >= ve1.occurred_at - interval '90 days'
          and v2.client_id <> v_client
          and (v_version_id is null
               or v2.service_location_version_id is distinct from v_version_id))
   order by ve1.occurred_at, ve1.created_at
   limit 1;
  if v_dup_id is not null then
    v_consistency := v_consistency - c_d_con_repeat;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'consistency.repeated_coordinates', 'component', 'consistency',
      'points', -c_d_con_repeat, 'detail_id', v_dup_id));
  end if;

  -- ── 11. Floor each component at zero, then sum. No component may go negative and
  --        drag another one down: each answers its own question, and a visit with two
  --        catastrophic location failures is not also worse at timekeeping. ──────────
  v_location    := greatest(v_location, 0);
  v_time        := greatest(v_time, 0);
  v_schedule    := greatest(v_schedule, 0);
  v_identity    := greatest(v_identity, 0);
  v_device      := greatest(v_device, 0);
  v_consistency := greatest(v_consistency, 0);
  v_score := v_location + v_time + v_schedule + v_identity + v_device + v_consistency;
  v_band  := case
               when v_score >= 90 then 'verified'
               when v_score >= 75 then 'verified_with_exception'
               when v_score >= 50 then 'requires_review'
               else                    'high_risk' end;

  return jsonb_build_object(
    'ok', true,
    'visit_id', p_visit,
    'model_version', 'trust.v1',
    'score', v_score,
    'band', v_band,
    'components', jsonb_build_object(
      'location', v_location, 'time', v_time, 'schedule', v_schedule,
      'identity', v_identity, 'device', v_device, 'consistency', v_consistency),
    -- The maxima ride along so a caller can render "25 of 35" without knowing this
    -- migration. Only `components` is persisted; `model_version` is what makes an old
    -- snapshot interpretable without them.
    'weights', jsonb_build_object(
      'location', c_w_location, 'time', c_w_time, 'schedule', c_w_schedule,
      'identity', c_w_identity, 'device', c_w_device, 'consistency', c_w_consistency),
    'reasons', v_reasons,
    'computed_at', now());
end $$;

-- ══ 5 · app.record_trust_assessment — compute + append a snapshot (§4.9) ══════════════
-- Returns the snapshot id: §4.9 pins `returns uuid` and the build contract wins over the
-- layer's usual jsonb convention. Deliberately NOT idempotent — a second call is a
-- second snapshot, because the append-only table exists precisely to keep both readings.
-- Recording pins evidence to the record, which is a verification ACT, not a read, so it
-- takes visit.verify.act rather than visit.verify.read.
create or replace function app.record_trust_assessment(p_visit uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_score  jsonb;
  v_id     uuid;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to record a trust assessment'
      using errcode = '42501';
  end if;
  if not app.has_perm('visit.verify.act') then
    raise exception 'CAREOS_FORBIDDEN: visit.verify.act is required to record evidence'
      using errcode = '42501';
  end if;

  select v.tenant_id into v_tenant
    from public.visit v
   where v.id = p_visit and v.tenant_id = app.current_tenant_id();
  if v_tenant is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;

  -- The scorer re-runs its own gate; that is intentional duplication, not redundancy —
  -- it keeps app.visit_trust_score safe to call from anywhere else in the layer.
  v_score := app.visit_trust_score(p_visit);
  insert into public.visit_trust_assessment
    (tenant_id, visit_id, score, band, components, reasons, model_version)
  values
    (v_tenant, p_visit, (v_score ->> 'score')::int, v_score ->> 'band',
     v_score -> 'components', v_score -> 'reasons', v_score ->> 'model_version')
  returning id into v_id;

  -- Audit rides trg_visit_trust_assessment_audit (invariant 7, first half). No outbox
  -- event: docs/17 §8 enumerates this layer's outbox surface and there is no trust
  -- event on it, because appending evidence has no side effect outside this row and no
  -- consumer subscribes to it. When one appears it gets an event AND a decision-log
  -- line — never a silent addition.
  return v_id;
end $$;

-- ══ 6 · Grants: the verification surface in, everyone else out ════════════════════════
revoke all on function app.visit_trust_score(uuid) from public, anon;
grant execute on function app.visit_trust_score(uuid) to authenticated;
revoke all on function app.record_trust_assessment(uuid) from public, anon;
grant execute on function app.record_trust_assessment(uuid) to authenticated;
