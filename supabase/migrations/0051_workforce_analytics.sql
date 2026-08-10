-- ST-209 · Migration 0051 — workforce analytics: the only lawful AI input, and the
-- EVV observability surface. Two read functions and two supporting views. No table is
-- created, no existing object changes meaning, nothing is destructive — so no matrix.yaml
-- entry and no contraction decision are owed (invariant 12).
--
-- WHY A DEFINER AGGREGATE IS ALLOWED TO EXIST AT ALL (invariant 9). Invariant 9 says
-- retrieval runs as the user, and a SECURITY DEFINER function bypasses RLS by
-- construction — so this file has to earn its exception rather than assume it. It earns
-- it three ways, all of them structural:
--   1. The OUTPUT is IDs, enums and counts. No name, no address, no coordinate, no note,
--      no diagnosis, no free text of any kind reaches the return value. A row-level
--      retrieval path leaks a person; a counting path leaks a number about a population
--      the caller is already authorised to manage.
--   2. Every query is PINNED to app.current_tenant_id(). The tenant filter is not an
--      optimisation, it is the RLS predicate re-stated by hand — because the view the
--      function reads (public.verified_visit, security_invoker) evaluates its base-table
--      policies against the FUNCTION OWNER inside a definer body, and the owner bypasses
--      RLS. Delete the tenant filter and this becomes a cross-tenant read. That is why it
--      appears on every single statement below, and why the pgTAP file proves it with a
--      tenant-B principal rather than trusting the comment.
--   3. It is PERMISSION-GATED on an AAL2 session holding workforce.read. The precedent is
--      app.read_audit_trail (0025): stable + definer + AAL2 + has_perm, granted to
--      authenticated, auditing nothing because a STABLE function cannot write. The
--      calling surface owns the access audit; the function owns the refusal.
-- The honest summary: this is not "retrieval as the user", it is "an aggregate a user with
-- workforce.read could have computed themselves from rows their own RLS already admits".
-- Anything that wanted rows back would have to be a view, and §Views below is where those
-- live — security_invoker, RLS composing through, no exception needed.
--
-- WHY THIS FUNCTION IS THE AI's ONLY DOOR (docs/17 §10, invariant 13). Every capability in
-- docs/17 §11 reads app.workforce_features and nothing else for workforce analysis. The
-- deterministic half of invariant 13 lives here in SQL — who was late, by how many
-- minutes, on which weekday — and the model gets the finished numbers. That is what makes
-- "his Monday mornings are the problem" a FINDING rather than a guess: day_of_week_lateness
-- is arithmetic over the clock ledger, and the model's only job is to say it in English.
-- A capability that could see raw GPS could invent a pattern; a capability that can only
-- see a 7-element array of averages cannot.
--
-- WHY NO GEOGRAPHIC DIMENSION IN §13 (D-030). app.evv_observability deliberately has no
-- breakdown by place. A geographic distribution of where caregivers clock in is
-- surveillance telemetry about employees wearing an operations-metric costume: it answers
-- no question about whether EVV capture is working, and it creates a location history of
-- named people in a surface built for dashboards and exports. D-030 closes the coordinate
-- capture list; this file does not reopen it. Accuracy is reported in BUCKETS for the same
-- reason — a raw accuracy radius next to a timestamp and a caregiver is a fingerprint, and
-- "how well is GPS working" is fully answered by six buckets.
--
-- WHAT §13 ASKS FOR AND THIS FILE CANNOT GIVE (surfaced, not invented). §13 wants a
-- breakdown "by browser family". There is no user-agent column anywhere in the schema:
-- visit_event carries device_session_id, which 0045 defines as opaque and rotating and
-- explicitly NOT a device fingerprint. Deriving a browser family would mean inventing a
-- capture column this layer never agreed to capture. The dimension is omitted, and the
-- return value SAYS SO in `dimensions_omitted` so a consumer sees an honest gap rather
-- than an absent key. §13's "org" dimension collapses to the caller's own tenant: CareOS
-- has no sub-org unit table, and a cross-tenant breakdown would be exactly the privileged
-- retrieval invariant 9 forbids — so `org_id` is reported once, at the top, and is always
-- app.current_tenant_id().
--
-- FORWARD SLICES ARE NOT DEPENDED ON (DN-0051a). overtime_minutes is computed here from
-- the clock ledger and visit_policy.overtime_weekly_minutes rather than from 0050's
-- app.compute_overtime / approved_work_segment, and EVV acceptance is read from
-- visit.evv_status rather than from 0049's evv_submission. Both are deliberate: D-024
-- makes the four status columns the sanctioned PROJECTIONS of their ledgers, so reading
-- the projection is reading the ledger's own answer, and it keeps this file applicable and
-- testable without binding to a sibling slice's column names before they exist. When 0050
-- lands, app.compute_overtime becomes the authority for PAY; this stays the authority for
-- ANALYSIS, and the two are allowed to differ because one applies a rounding policy and a
-- human approval and the other does not.
-- @trace: ST-209, D-024, D-028, D-030, docs/17 §10, §13

-- ═══ 1 · Permission vocabulary (docs/17 §5) ═══════════════════════════════════════════
-- Real config belongs in the migration, never in the synthetic seed — the 0011 precedent.
-- One key, and it is the gate on both functions below. evv.read (0049) is deliberately NOT
-- accepted as an alternative: that key admits a reader to EVV RECORDS, which is a
-- row-level PHI surface; this is the analytics surface, and docs/17 §5 gives it its own
-- key precisely so the two can be granted to different people.
insert into public.permission (key, description) values
  ('workforce.read',
   'Read workforce analytics — aggregate visit performance and EVV observability')
on conflict (key) do nothing;

-- ═══ 2 · public.workforce_visit_fact — the per-visit read model ══════════════════ PHI
-- security_invoker is load-bearing, not decoration (the 0045 verified_visit note applies
-- verbatim): without it the view executes as its owner, who bypasses RLS, and hands every
-- authenticated caller every tenant's schedule. With it, RLS on visit, visit_event and
-- visit_policy all compose through, so /operations/attendance and /operations/workforce
-- read ROWS under the caller's own policies and only the AGGREGATE goes through a definer.
--
-- Everything here is a pure derivation of public.verified_visit (0045) plus the two policy
-- numbers a workforce question needs. Nothing is recomputed that 0045 already computed:
-- late_minutes and overrun_minutes keep their careful null semantics (NULL when the clock
-- event is missing, never 0 — 0045's most expensive-bug-avoided note), and this view does
-- not second-guess them.
--
-- work_date, day_of_week and week_start are evaluated in the DATABASE SESSION TIME ZONE.
-- CareOS has no per-tenant time zone column (public.tenant is id/name/status/created_at),
-- so there is nothing to evaluate them in except the session, and a surface that needs
-- Eastern weekday buckets sets `set local time zone` for the request. Inventing a
-- tenant.time_zone column here would be a schema decision this slice has no mandate to
-- make; it is surfaced in the ST-209 result as the correct follow-up instead.
create view public.workforce_visit_fact
with (security_invoker = true) as
select
  vv.visit_id,
  vv.tenant_id,
  vv.caregiver_id,
  vv.client_id,
  vv.service_type_id,
  vv.status,
  vv.verification_status,
  vv.approval_status,
  vv.evv_status,
  vv.scheduled_start,
  vv.scheduled_end,
  vv.actual_start,
  vv.actual_end,
  vv.scheduled_minutes,
  vv.verified_minutes,
  vv.late_minutes,
  vv.overrun_minutes,
  vv.scheduled_start::date                            as work_date,
  -- 0 = Sunday … 6 = Saturday, which is the index order docs/17 §10 pins for
  -- day_of_week_lateness. Stated once, here, so the array and the row agree by
  -- construction rather than by two functions happening to use the same convention.
  extract(dow from vv.scheduled_start)::int           as day_of_week,
  date_trunc('week', vv.scheduled_start)::date        as week_start,   -- ISO Monday
  -- Arrival earliness. 0045 clamps late_minutes at zero (arriving early is earliness, not
  -- negative lateness), so the early side is not recoverable from it and is derived from
  -- the timestamps directly.
  (vv.actual_start is not null and vv.actual_start < vv.scheduled_start)
                                                      as arrived_early,
  -- Time short of the scheduled window. NULL — not 0 — when the visit has no coherent
  -- worked duration: unclocked (verified_minutes null) or incoherent (clock-out before
  -- clock-in, which 0045 deliberately reports as a negative rather than laundering it).
  -- "Cannot be computed" and "worked the full window" are different facts and must not
  -- collapse into the same number on a surface that feeds pay conversations.
  case when vv.verified_minutes is null or vv.verified_minutes < 0 then null
       else greatest(vv.scheduled_minutes - vv.verified_minutes, 0)
  end                                                 as undertime_minutes,
  -- The rules this visit was actually judged against (D-014 binding, bound at first
  -- clock-in by 0046). NULL for a visit nobody ever clocked; the aggregate below falls
  -- back to the tenant floor and never to a hard-coded number.
  vp.late_threshold_minutes,
  vp.overtime_weekly_minutes
from public.verified_visit vv
left join public.visit_policy vp on vp.id = vv.policy_id;

grant select on public.workforce_visit_fact to authenticated;   -- RLS composes through

-- ═══ 3 · public.evv_capture_fact — the per-event read model ══════════════════════ PHI
-- One place where the accuracy bucket boundaries live. The alternative — bucketing inline
-- in app.evv_observability and again in whatever the /operations/evv screen does — is how
-- "never raw values" (docs/17 §13, D-030) becomes true in one place and false in another.
--
-- D-030, made structural rather than intended: latitude, longitude and distance_m are NOT
-- selected here. accuracy_m is not selected either — only its bucket. A caller who holds
-- schedule.read can still read visit_event directly and see the raw radius, which is
-- correct (it is evidence on an RLS-gated administrator surface); what must never happen
-- is a TELEMETRY surface carrying it, because telemetry is the thing that gets exported,
-- charted and pasted into a ticket. The pgTAP file greps this view's own catalog
-- definition for the coordinate columns, so the property stays true rather than remembered.
create view public.evv_capture_fact
with (security_invoker = true) as
select
  e.id                                                as event_id,
  e.tenant_id,
  e.visit_id,
  e.caregiver_id,
  e.event_type,
  e.occurred_at,
  e.location_status,
  e.capture_source,
  e.is_offline,
  e.reason_code,
  v.service_type_id,
  v.client_id,
  -- The docs/17 §13 histogram, half-open buckets in metres. 'unknown' is its own bucket
  -- rather than folded into 0-25: a device that reported no accuracy at all is an
  -- operationally different event from a device that reported an excellent fix, and
  -- collapsing them would flatter the metric.
  case
    when e.accuracy_m is null   then 'unknown'
    when e.accuracy_m <   25    then '0-25'
    when e.accuracy_m <   50    then '25-50'
    when e.accuracy_m <  100    then '50-100'
    when e.accuracy_m <  250    then '100-250'
    when e.accuracy_m < 1000    then '250-1000'
    else                             '1000+'
  end                                                 as accuracy_bucket
from public.visit_event e
join public.visit v on v.id = e.visit_id;

grant select on public.evv_capture_fact to authenticated;       -- RLS composes through

-- ═══ 4 · app.workforce_features — docs/17 §10 ═════════════════════════════════════════
-- The ONLY input any workforce AI capability may read (docs/17 §10/§11). One object per
-- caregiver who has at least one non-cancelled visit in the window, carrying exactly the
-- twenty metrics §10 pins and a caregiver_id — no names, no coordinates, no free text.
--
-- Metric definitions docs/17 §10 NAMES but does not DEFINE are fixed here, deliberately
-- and in one place, because an undefined metric is a metric two surfaces will compute two
-- ways (each is restated at its call site below):
--   late_count            visits whose late_minutes exceed the visit's own bound policy
--                         threshold, falling back to the tenant floor for unclocked visits
--   avg_late_minutes      mean lateness among the LATE visits only (null when none)
--   early_count           EARLY ARRIVALS. §10 lists it next to late_count, so it is the
--                         arrival-side counterpart; the end-side lives in overrun_minutes
--                         and undertime_minutes
--   verified_rate         a FRACTION 0..1 (the `_rate` suffix), verified over completed
--   schedule_adherence_pct  a PERCENTAGE 0..100 (the `_pct` suffix), completed-and-on-time
--                         over scheduled
--   client_continuity_pct  share of the caregiver's visits that went to a client they saw
--                         two or more times in the window — "is this caregiver holding
--                         relationships, or bouncing between strangers?"
--   manual_override_count  clock events that a human typed or corrected rather than
--                         captured (capture_source='manual' or a 0047 correction event)
--   overtime_minutes      per ISO week, minutes worked above the week's policy ceiling,
--                         summed. Weeks are truncated by the window (DN-0051a).
--   day_of_week_lateness  7 elements, index 0 = Sunday, mean late_minutes over ALL clocked
--                         visits that weekday including on-time ones — a null element
--                         means "no clocked visit that weekday", never "perfect".
create or replace function app.workforce_features(
  p_from date, p_to date, p_caregiver uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_late_floor int;
  v_ot_floor int;
  v_rows jsonb;
begin
  -- ── Gate. Three refusals, in escalating specificity (the 0025 read_audit_trail shape).
  if v_tenant is null then
    raise exception
      'CAREOS_NO_TENANT_CONTEXT: workforce analytics need an active principal'
      using errcode = 'P0001';
  end if;
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to read workforce analytics'
      using errcode = '42501';
  end if;
  -- The gate that stands in for RLS (see the header). Without it a definer aggregate over
  -- PHI-derived rows would be readable by every authenticated principal in the tenant.
  if not app.has_perm('workforce.read') then
    raise exception
      'CAREOS_FORBIDDEN: workforce.read is required to read workforce analytics'
      using errcode = '42501';
  end if;

  -- ── Input sanity. The 366-day ceiling is a cost bound, not a policy: this scans a
  -- tenant's whole clock ledger, and an unbounded window is how an analytics read becomes
  -- an availability incident. A year plus a leap day covers every reporting period the
  -- surfaces in docs/17 §7.2 offer.
  if p_from is null or p_to is null or p_to < p_from then
    raise exception
      'CAREOS_BAD_WINDOW: the analysis window must end on or after it starts'
      using errcode = 'P0001';
  end if;
  if p_to - p_from > 366 then
    raise exception
      'CAREOS_BAD_WINDOW: the analysis window may not exceed 366 days'
      using errcode = 'P0001';
  end if;

  -- ── Existence. Tenant-pinned, so probing a caregiver id from another agency is
  -- indistinguishable from probing one that does not exist.
  if p_caregiver is not null and not exists (
       select 1 from public.app_user u
        where u.id = p_caregiver and u.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: caregiver' using errcode = 'P0001';
  end if;

  -- ── The tenant floor, read once. A visit that was never clocked has no bound policy
  -- (0046 binds at first clock-in), and lateness still has to be measured against
  -- something. That something is the tenant-scope row — never a literal: 0044 put every
  -- default in the table definition so there is exactly one place the number lives. No
  -- tenant row at all is the documented §4.2 failure, not a degraded answer.
  select vp.late_threshold_minutes, vp.overtime_weekly_minutes
    into v_late_floor, v_ot_floor
    from public.visit_policy vp
   where vp.tenant_id = v_tenant
     and vp.scope_kind = 'tenant'
     and vp.effective_from <= now()
     and (vp.effective_until is null or vp.effective_until > now())
   order by vp.version_no desc
   limit 1;
  if v_late_floor is null then
    raise exception
      'CAREOS_POLICY_MISSING: this agency has no visit policy — set the defaults first'
      using errcode = 'P0001';
  end if;

  -- ── The aggregate. Window predicates are stated on scheduled_start as a half-open
  -- TIMESTAMP range rather than on work_date, so idx_visit_caregiver_start is usable; the
  -- two are the same set, because work_date is scheduled_start::date in the same session
  -- time zone the cast below uses.
  with f as (
    select wf.visit_id, wf.caregiver_id, wf.client_id, wf.status,
           wf.verification_status, wf.actual_start, wf.scheduled_minutes,
           wf.verified_minutes, wf.late_minutes, wf.overrun_minutes,
           wf.undertime_minutes, wf.day_of_week, wf.week_start, wf.arrived_early,
           (wf.late_minutes is not null
            and wf.late_minutes
                > coalesce(wf.late_threshold_minutes, v_late_floor))    as is_late,
           coalesce(wf.overtime_weekly_minutes, v_ot_floor)             as ot_ceiling
      from public.workforce_visit_fact wf
     -- The RLS predicate, re-stated by hand. See the header: this is the only thing
     -- standing between a definer body and every tenant's schedule.
     where wf.tenant_id = v_tenant
       and wf.caregiver_id is not null
       and (p_caregiver is null or wf.caregiver_id = p_caregiver)
       and wf.scheduled_start >= p_from::timestamptz
       and wf.scheduled_start <  (p_to + 1)::timestamptz
       -- A cancelled visit was never work and must not dilute an adherence percentage.
       and wf.status <> 'cancelled'
  ),
  agg as (
    select f.caregiver_id,
           count(*)::int                                          as visits_scheduled,
           count(*) filter (where f.status = 'completed')::int     as visits_completed,
           count(*) filter (where f.status = 'missed')::int        as visits_missed,
           count(*) filter (where f.is_late)::int                  as late_count,
           round(avg(f.late_minutes) filter (where f.is_late), 1)  as avg_late_minutes,
           count(*) filter (where f.arrived_early)::int            as early_count,
           coalesce(sum(f.overrun_minutes), 0)::int                as overrun_minutes,
           coalesce(sum(f.undertime_minutes), 0)::int              as undertime_minutes,
           count(*) filter (where f.status = 'completed'
                              and f.verification_status = 'verified')::int
                                                                   as verified_completed,
           count(*) filter (where f.status = 'completed'
                              and f.actual_start is not null
                              and not f.is_late)::int              as on_time_completed
      from f
     group by f.caregiver_id
  ),
  -- Exceptions are counted through f, so the window and the caregiver scope are defined
  -- exactly once and cannot drift between the two halves of the query.
  exc as (
    select f.caregiver_id, e.kind, count(*)::int as n
      from f
      join public.visit_exception e on e.visit_id = f.visit_id
     where e.tenant_id = v_tenant
     group by f.caregiver_id, e.kind
  ),
  exc_p as (
    select exc.caregiver_id,
           coalesce(sum(exc.n) filter (where exc.kind in
             ('location_unverified','low_accuracy','outside_geofence',
              'location_unavailable')), 0)::int      as location_exception_count,
           coalesce(sum(exc.n) filter (where exc.kind = 'missing_clock_out'), 0)::int
                                                     as missing_clock_out_count,
           coalesce(sum(exc.n) filter (where exc.kind = 'overlapping_visits'), 0)::int
                                                     as overlap_count,
           coalesce(sum(exc.n) filter (where exc.kind = 'impossible_travel'), 0)::int
                                                     as impossible_travel_count,
           coalesce(sum(exc.n) filter (where exc.kind = 'documentation_missing'), 0)::int
                                                     as documentation_missing_count
      from exc
     group by exc.caregiver_id
  ),
  -- A clock event a human typed, or a 0047 correction to one. Both are the same
  -- operational fact — "the ledger says what a person said, not what a device captured" —
  -- and both are what an auditor counts.
  overrides as (
    select f.caregiver_id, count(*)::int as manual_override_count
      from f
      join public.visit_event e on e.visit_id = f.visit_id
     where e.tenant_id = v_tenant
       and (e.capture_source = 'manual' or e.event_type = 'correction')
     group by f.caregiver_id
  ),
  -- Latest assessment per visit (0048 appends a new snapshot per re-score, so "the score"
  -- is always the most recent one).
  trust as (
    select f.caregiver_id, t.band, count(*)::int as n
      from f
      join lateral (
        select a.band
          from public.visit_trust_assessment a
         where a.visit_id = f.visit_id and a.tenant_id = v_tenant
         order by a.computed_at desc, a.id desc
         limit 1
      ) t on true
     group by f.caregiver_id, t.band
  ),
  trust_h as (
    select trust.caregiver_id, jsonb_object_agg(trust.band, trust.n) as bands
      from trust
     group by trust.caregiver_id
  ),
  -- Weekly overtime. greatest(verified_minutes, 0) keeps an incoherent ledger (0045's
  -- deliberate negative) from CREDITING a week; the incoherence is already visible as its
  -- own exception and must not silently buy back overtime here.
  weekly as (
    select f.caregiver_id, f.week_start,
           coalesce(sum(greatest(f.verified_minutes, 0)), 0)::int as worked,
           max(f.ot_ceiling)::int                                 as ceiling
      from f
     where f.verified_minutes is not null
     group by f.caregiver_id, f.week_start
  ),
  overtime as (
    select weekly.caregiver_id,
           coalesce(sum(greatest(weekly.worked - weekly.ceiling, 0)), 0)::int
             as overtime_minutes
      from weekly
     group by weekly.caregiver_id
  ),
  client_freq as (
    select f.caregiver_id, f.client_id, count(*)::int as n
      from f
     group by f.caregiver_id, f.client_id
  ),
  continuity as (
    select client_freq.caregiver_id,
           coalesce(sum(client_freq.n) filter (where client_freq.n >= 2), 0)::int
             as repeat_visits,
           sum(client_freq.n)::int as total_visits
      from client_freq
     group by client_freq.caregiver_id
  ),
  -- The 7-element weekday array. The cross join to generate_series is what guarantees
  -- SEVEN elements in Sunday..Saturday order even for a caregiver who only ever works
  -- Tuesdays; jsonb_agg keeps a NULL input as a JSON null, which is the honest value for
  -- "no clocked visit that weekday".
  dow as (
    select f.caregiver_id, f.day_of_week, avg(f.late_minutes) as avg_late
      from f
     where f.late_minutes is not null
     group by f.caregiver_id, f.day_of_week
  ),
  dow_arr as (
    select cg.caregiver_id,
           jsonb_agg(round(dow.avg_late, 1) order by g.dow) as day_of_week_lateness
      from (select distinct f.caregiver_id from f) cg
      cross join generate_series(0, 6) as g(dow)
      left join dow on dow.caregiver_id = cg.caregiver_id and dow.day_of_week = g.dow
     group by cg.caregiver_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'caregiver_id',                a.caregiver_id,
           'visits_scheduled',            a.visits_scheduled,
           'visits_completed',            a.visits_completed,
           'visits_missed',               a.visits_missed,
           'late_count',                  a.late_count,
           'avg_late_minutes',            a.avg_late_minutes,
           'early_count',                 a.early_count,
           'overrun_minutes',             a.overrun_minutes,
           'undertime_minutes',           a.undertime_minutes,
           'verified_rate',
             case when a.visits_completed = 0 then null
                  else round(a.verified_completed::numeric / a.visits_completed, 4) end,
           'location_exception_count',    coalesce(x.location_exception_count, 0),
           'manual_override_count',       coalesce(o.manual_override_count, 0),
           'missing_clock_out_count',     coalesce(x.missing_clock_out_count, 0),
           'overlap_count',               coalesce(x.overlap_count, 0),
           'impossible_travel_count',     coalesce(x.impossible_travel_count, 0),
           'documentation_missing_count', coalesce(x.documentation_missing_count, 0),
           'schedule_adherence_pct',
             round(100.0 * a.on_time_completed / a.visits_scheduled, 1),
           'overtime_minutes',            coalesce(ot.overtime_minutes, 0),
           'client_continuity_pct',
             round(100.0 * c.repeat_visits / c.total_visits, 1),
           'trust_band_histogram',
             jsonb_build_object('verified', 0, 'verified_with_exception', 0,
                                'requires_review', 0, 'high_risk', 0)
             || coalesce(th.bands, '{}'::jsonb),
           'day_of_week_lateness',        d.day_of_week_lateness
         ) order by a.caregiver_id), '[]'::jsonb)
    into v_rows
    from agg a
    left join exc_p x   on x.caregiver_id  = a.caregiver_id
    left join overrides o on o.caregiver_id = a.caregiver_id
    left join trust_h th on th.caregiver_id = a.caregiver_id
    left join overtime ot on ot.caregiver_id = a.caregiver_id
    left join continuity c on c.caregiver_id = a.caregiver_id
    left join dow_arr d  on d.caregiver_id  = a.caregiver_id;

  return jsonb_build_object(
    'ok', true,
    'org_id', v_tenant,
    'from', p_from,
    'to', p_to,
    'generated_at', now(),
    'caregivers', v_rows);
end $$;

revoke all on function app.workforce_features(date, date, uuid) from public, anon;
grant execute on function app.workforce_features(date, date, uuid) to authenticated;

-- ═══ 5 · app.evv_observability — docs/17 §13 ══════════════════════════════════════════
-- Operations telemetry for the EVV capture path: is clock-in working, how good are the
-- fixes, what is failing and how often, is the sweep alive. Same gate, same tenant pin,
-- same reason (see the header) — and the same output discipline: counts, enums, rates and
-- bucket labels, never a coordinate, never an accuracy radius, never a person's name.
--
-- The unit of most rates is the VISIT, not the event, because "how often does this go
-- wrong" is a question about care delivered, not about taps. The two event-level metrics
-- (clock-in success, accuracy histogram) are event-level on purpose: a rejected attempt is
-- an event that has no visit-level trace, and it is the single most useful number here.
create or replace function app.evv_observability(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_visits int;
  v_ci_attempts int;
  v_ci_ok int;
  v_clocked int;
  v_no_out int;
  v_evv_ok int;
  v_evv_rejected int;
  v_evv_open int;
  v_location jsonb;
  v_accuracy jsonb;
  v_exceptions jsonb;
  v_by_service_type jsonb;
  v_sweep jsonb;
begin
  if v_tenant is null then
    raise exception
      'CAREOS_NO_TENANT_CONTEXT: EVV observability needs an active principal'
      using errcode = 'P0001';
  end if;
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to read EVV observability'
      using errcode = '42501';
  end if;
  if not app.has_perm('workforce.read') then
    raise exception
      'CAREOS_FORBIDDEN: workforce.read is required to read EVV observability'
      using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception
      'CAREOS_BAD_WINDOW: the analysis window must end on or after it starts'
      using errcode = 'P0001';
  end if;
  if p_to - p_from > 366 then
    raise exception
      'CAREOS_BAD_WINDOW: the analysis window may not exceed 366 days'
      using errcode = 'P0001';
  end if;

  -- ── Visit-level denominators, and the two visit-level rates.
  select count(*)::int,
         count(*) filter (where vv.actual_start is not null)::int,
         count(*) filter (where vv.actual_start is not null
                            and vv.actual_end is null)::int
    into v_visits, v_clocked, v_no_out
    from public.verified_visit vv
   where vv.tenant_id = v_tenant                       -- the hand-stated RLS predicate
     and vv.scheduled_start >= p_from::timestamptz
     and vv.scheduled_start <  (p_to + 1)::timestamptz
     and vv.status <> 'cancelled';

  -- ── EVV acceptance, read from the D-024 projection (DN-0051a in the header).
  -- 'reconciled' counts as accepted: under the Maryland reconcile posture (D-026) a
  -- reconciled record IS the accepted outcome, and treating it as undecided would report
  -- an acceptance rate of zero for the only mode the agency actually ships in.
  select count(*) filter (where vv.evv_status in ('accepted','reconciled'))::int,
         count(*) filter (where vv.evv_status = 'rejected')::int,
         count(*) filter (where vv.evv_status in ('pending','submitted'))::int
    into v_evv_ok, v_evv_rejected, v_evv_open
    from public.verified_visit vv
   where vv.tenant_id = v_tenant
     and vv.scheduled_start >= p_from::timestamptz
     and vv.scheduled_start <  (p_to + 1)::timestamptz
     and vv.status <> 'cancelled'
     and vv.evv_status <> 'not_required';

  -- ── Event-level: clock-in success, the location verdict distribution, and the bucketed
  -- accuracy histogram. A *_rejected row is the durable evidence that somebody tried and
  -- the rule said no (0045), which is exactly what makes a success RATE computable at all.
  select count(*) filter (where ec.event_type in ('clock_in','clock_in_rejected'))::int,
         count(*) filter (where ec.event_type = 'clock_in')::int,
         jsonb_build_object(
           'verified',         count(*) filter (where ec.location_status = 'verified'),
           'low_accuracy',     count(*) filter (where ec.location_status = 'low_accuracy'),
           'outside_geofence', count(*) filter (where ec.location_status
                                                      = 'outside_geofence'),
           'unavailable',      count(*) filter (where ec.location_status = 'unavailable'),
           'suspicious',       count(*) filter (where ec.location_status = 'suspicious'),
           'not_required',     count(*) filter (where ec.location_status = 'not_required'),
           'unrecorded',       count(*) filter (where ec.location_status is null)),
         jsonb_build_object(
           '0-25',      count(*) filter (where ec.accuracy_bucket = '0-25'),
           '25-50',     count(*) filter (where ec.accuracy_bucket = '25-50'),
           '50-100',    count(*) filter (where ec.accuracy_bucket = '50-100'),
           '100-250',   count(*) filter (where ec.accuracy_bucket = '100-250'),
           '250-1000',  count(*) filter (where ec.accuracy_bucket = '250-1000'),
           '1000+',     count(*) filter (where ec.accuracy_bucket = '1000+'),
           'unknown',   count(*) filter (where ec.accuracy_bucket = 'unknown'))
    into v_ci_attempts, v_ci_ok, v_location, v_accuracy
    from public.evv_capture_fact ec
   where ec.tenant_id = v_tenant
     and ec.occurred_at >= p_from::timestamptz
     and ec.occurred_at <  (p_to + 1)::timestamptz;

  -- ── Exception rate by kind. Rate is per visit in the window, so 0.02 reads as "two
  -- visits in a hundred hit this", which is the number an administrator can act on.
  select coalesce(jsonb_object_agg(k.kind, jsonb_build_object(
           'count', k.n,
           'rate_per_visit',
             case when v_visits = 0 then null
                  else round(k.n::numeric / v_visits, 4) end)), '{}'::jsonb)
    into v_exceptions
    from (select e.kind, count(*)::int as n
            from public.visit_exception e
            join public.visit vi on vi.id = e.visit_id
           where e.tenant_id = v_tenant
             and vi.scheduled_start >= p_from::timestamptz
             and vi.scheduled_start <  (p_to + 1)::timestamptz
             and vi.status <> 'cancelled'
           group by e.kind) k;

  -- ── The one lawful breakdown dimension (§13 minus browser and minus geography).
  -- service_type is catalog config, not PHI, so its code travels; 'unassigned' is a real
  -- bucket rather than a silent drop, because a visit with no service type is itself an
  -- EVV completeness problem worth seeing.
  select coalesce(jsonb_agg(jsonb_build_object(
           'service_type_id', t.service_type_id,
           'code',            t.code,
           'visits',          t.visits,
           'clock_in_success_rate',
             case when t.attempts = 0 then null
                  else round(t.oks::numeric / t.attempts, 4) end,
           'missing_clock_out_rate',
             case when t.clocked = 0 then null
                  else round(t.no_out::numeric / t.clocked, 4) end)
           order by t.code), '[]'::jsonb)
    into v_by_service_type
    from (
      select vv.service_type_id,
             coalesce(st.code, 'unassigned')                            as code,
             count(*)::int                                              as visits,
             count(*) filter (where vv.actual_start is not null)::int    as clocked,
             count(*) filter (where vv.actual_start is not null
                                and vv.actual_end is null)::int          as no_out,
             coalesce(sum(ev.attempts), 0)::int                          as attempts,
             coalesce(sum(ev.oks), 0)::int                               as oks
        from public.verified_visit vv
        left join public.service_type st on st.id = vv.service_type_id
        left join lateral (
          select count(*) filter (where e.event_type
                                        in ('clock_in','clock_in_rejected'))::int
                   as attempts,
                 count(*) filter (where e.event_type = 'clock_in')::int as oks
            from public.visit_event e
           where e.visit_id = vv.visit_id
        ) ev on true
       where vv.tenant_id = v_tenant
         and vv.scheduled_start >= p_from::timestamptz
         and vv.scheduled_start <  (p_to + 1)::timestamptz
         and vv.status <> 'cancelled'
       group by vv.service_type_id, coalesce(st.code, 'unassigned')
    ) t;

  -- ── Sweep latency. job_heartbeat is platform telemetry with zero tenant data (0034), so
  -- the same freshness number is correct for every tenant and none of it is anyone's
  -- health information. A sweep that has never run is STALE, not unknown — the 0039 H1
  -- posture: health is earned, never assumed.
  select jsonb_build_object(
           'job_key', h.job_key,
           'expected_interval_seconds', h.expected_interval_seconds,
           'last_ok_at', h.last_ok_at,
           'seconds_since_last_ok',
             case when h.last_ok_at is null then null
                  else floor(extract(epoch from (now() - h.last_ok_at)))::int end,
           'stale', h.last_ok_at is null
                    or now() - h.last_ok_at
                       > make_interval(secs => 2 * h.expected_interval_seconds))
    into v_sweep
    from public.job_heartbeat h
   where h.job_key = 'visit_sweep';
  v_sweep := coalesce(v_sweep,
    jsonb_build_object('job_key', 'visit_sweep', 'registered', false, 'stale', true));

  return jsonb_build_object(
    'ok', true,
    -- §13's "org" dimension. It is the caller's own tenant and nothing else: CareOS has no
    -- sub-org unit, and a cross-tenant breakdown would be the privileged retrieval
    -- invariant 9 forbids.
    'org_id', v_tenant,
    'from', p_from,
    'to', p_to,
    'generated_at', now(),
    'visits', v_visits,
    'clock_in', jsonb_build_object(
      'attempts', v_ci_attempts,
      'succeeded', v_ci_ok,
      'rejected', v_ci_attempts - v_ci_ok,
      'success_rate', case when v_ci_attempts = 0 then null
                          else round(v_ci_ok::numeric / v_ci_attempts, 4) end),
    'location_status', v_location,
    'accuracy_histogram_m', v_accuracy,
    'exception_rate_by_kind', v_exceptions,
    'missing_clock_out', jsonb_build_object(
      'clocked_in', v_clocked,
      'missing', v_no_out,
      'rate', case when v_clocked = 0 then null
                  else round(v_no_out::numeric / v_clocked, 4) end),
    'evv', jsonb_build_object(
      'accepted', v_evv_ok,
      'rejected', v_evv_rejected,
      'open', v_evv_open,
      'acceptance_rate', case when v_evv_ok + v_evv_rejected = 0 then null
                             else round(v_evv_ok::numeric
                                        / (v_evv_ok + v_evv_rejected), 4) end),
    'sweep', v_sweep,
    'by_service_type', v_by_service_type,
    -- Named gaps beat absent keys: a consumer that charts these dimensions learns WHY the
    -- data is not here instead of assuming the query failed. browser_family has no source
    -- column (see the header); geography is refused outright (D-030).
    'dimensions_omitted', jsonb_build_array('browser_family', 'geography'));
end $$;

revoke all on function app.evv_observability(date, date) from public, anon;
grant execute on function app.evv_observability(date, date) to authenticated;
