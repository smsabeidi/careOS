-- ST-203 · Migration 0045 — the verified visit: four state axes, one honest ledger
-- Expand phase only. No table is created, no existing column changes meaning, and the
-- single CHECK that widens does so by drop-and-add — the 0023 precedent that widened
-- schedule_exception.kind for 'callout'. Nothing here is destructive, so no contraction
-- decision entry is owed (invariant 12).
--
-- WHY FOUR COLUMNS AND NOT ONE ENUM (D-024). Verification, approval, payroll and EVV are
-- orthogonal. "Verified but unapproved" and "approved but EVV-rejected" are ordinary
-- Tuesday states; a single lifecycle enum can only express them by multiplying out, and
-- every product that tried ended up with illegal states that were nonetheless
-- representable. Each of the four is a PROJECTION of an append-only ledger — visit_event
-- here, visit_exception (0047), approved_work_segment (0050), evv_submission (0049) — so
-- the ledger stays the fact and the column stays a cache that a definer RPC maintains and
-- can rebuild from the ledger. visit.status keeps its 0011 care-delivery meaning,
-- untouched.
--
-- WHY THE COLUMNS ATTACH HERE AND NOT TO A NEW TABLE (D-023). 0011's own header made
-- reconciling docs/07 §6's inverted `visit`/`shift` naming a required deliverable of "the
-- S4 EVV migration"; D-023 ratified 0011's vocabulary instead. The Lane-B scheduling RPCs
-- (0023), the outbox event names (0027: visit.assigned / visit.vacated), the credential
-- lapse sweep (0024) and the existing clock ledger (0013) all already speak it.
--
-- PRIVILEGE POSTURE — D-024 ASKS FOR LESS THAN THE TREE ALREADY HAS. docs/17 §3.5 was
-- written against the 0011 world, where `authenticated` held a table-wide UPDATE on
-- public.visit; it prescribes revoking that and re-granting ten scheduling columns one by
-- one. 0023 had already gone further: it dropped visit_update_scheduler AND
-- visit_insert_scheduler and revoked insert+update outright, making every scheduling
-- mutation a definer-RPC act. Issuing the column grants now would WIDEN the perimeter
-- rather than tighten it — and they would be inert anyway, because no UPDATE policy
-- survives for them to work through. So this file grants nothing, re-states the revoke as
-- a postcondition, and the pgTAP file asserts the stronger property directly: no UPDATE
-- grant AND no UPDATE policy on public.visit. Surfaced, not silently diverged.
--
-- DERIVATION OVER DENORMALISATION — why public.verified_visit is a view and not six more
-- columns on visit. visit_event is append-only and is the only place a clock fact is ever
-- written, so it cannot disagree with itself. A denormalised clock_in_at on visit would be
-- a second copy of that fact maintained by a different code path; the day the two drift
-- there is no way to tell which one lied, and the copy that feeds payroll is the one
-- nobody re-reads. A view can be slow; it cannot be stale. The four status columns are the
-- deliberate exception, and they project a state machine — cheap to recompute, safe to
-- repair — never a timestamp.
-- @trace: ST-203, D-014, D-022, D-023, D-024, D-025, D-030, docs/17 §3, §3.5, §3.6

-- ═══ 1 · public.visit — four state axes and four binding columns (§3.5) ══════════ PHI
-- Every default is non-volatile (now() is stable, and the four status defaults are
-- literals), so PG stores each as a catalog missing-value instead of rewriting the heap:
-- metadata-only, no lock beyond the DDL itself.
--
-- The binding columns follow the form_template/form_version precedent (D-014): a verified
-- visit binds to the exact service-location VERSION and the exact policy row it was
-- verified against, at first clock-in, so revising an address or loosening a grace period
-- tomorrow can never rewrite what was already verified. service_location_id is the mutable
-- identity pointer (which place); service_location_version_id is the immutable fact (which
-- geography). Both are written by the clock engine (0046), never by a client.
alter table public.visit
  add column service_type_id uuid references public.service_type(id),
  add column service_location_id uuid references public.service_location(id),
  add column service_location_version_id uuid
    references public.service_location_version(id),
  add column policy_id uuid references public.visit_policy(id),
  -- Axis 1 — did the evidence hold up? (projects visit_event + visit_exception)
  add column verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','exception','manual_review')),
  -- Axis 2 — did a human sign off on the hours? (projects approved_work_segment)
  add column approval_status text not null default 'pending'
    check (approval_status in ('pending','approved','rejected')),
  -- Axis 3 — has it left for payroll? (projects payroll_export)
  add column payroll_status text not null default 'not_ready'
    check (payroll_status in ('not_ready','ready','exported')),
  -- Axis 4 — what does the state say? (projects evv_submission). 'not_required' is the
  -- correct default: most private-pay work carries no EVV obligation at all, and a
  -- default of 'pending' would manufacture a backlog out of nothing.
  add column evv_status text not null default 'not_required'
    check (evv_status in
      ('not_required','pending','submitted','accepted','rejected','reconciled'));

-- The /operations exceptions lane: the small tail of visits a human must actually look
-- at. Partial, because 'pending' and 'verified' are the overwhelming majority and an
-- index over them would be a sequential scan wearing a costume.
create index idx_visit_verification_open on public.visit (tenant_id, scheduled_start)
  where verification_status in ('exception','manual_review');
-- The /operations/timesheets lane: delivered work still waiting on a human approval.
create index idx_visit_approval_pending on public.visit (tenant_id, scheduled_start)
  where status = 'completed' and approval_status = 'pending';
-- No index is added for the four new FK columns: nothing ever deletes from service_type,
-- service_location, service_location_version or visit_policy (append-only, or no delete
-- grant anywhere), so there is no referential-integrity scan to accelerate, and no surface
-- lists visits BY policy or BY location version.

-- D-024's tightening, already satisfied more strongly by 0023 (see the header). The
-- revoke is a no-op against today's catalog; it is stated so this file's postcondition
-- stands on its own, and so that any future re-grant has to argue with a line of SQL
-- rather than with a paragraph in a doc. The four projection columns and the two binding
-- columns are writable only by the definer RPCs in 0046/0047/0049/0050 — which is the
-- entire point of D-024.
revoke update on public.visit from authenticated;

-- ═══ 2 · public.visit_event — the clock ledger grows up (§3.6) ═══════════ [AO] PHI
-- Expand-safe CHECK widening, exactly as 0023 widened schedule_exception.kind: drop the
-- inline-named constraint (an inline CHECK is named <table>_<column>_check), add it back
-- carrying the superset. Every existing row already satisfies the new predicate, so the
-- validation scan cannot fail and no row is rewritten. The four new types are all events
-- of consequence in their own right: a *_rejected row is the durable evidence that
-- somebody tried and the geofence said no (§4.4 step 7) — the thing an agency running on
-- paper has no record of at all.
alter table public.visit_event drop constraint visit_event_event_type_check;
alter table public.visit_event add constraint visit_event_event_type_check
  check (event_type in ('clock_in','clock_out','clock_in_rejected','clock_out_rejected',
                        'exception_requested','correction'));

alter table public.visit_event
  -- Caller-supplied idempotency key (D-022): a PWA queue replaying an offline clock action
  -- may deliver the same intent any number of times. §4.4 step 3 makes replay a RETURN
  -- VALUE, never an error — this column plus the partial unique index below is what makes
  -- that safe by construction rather than by hoping the network behaves.
  add column client_event_id text,
  -- DEVICE time. Diagnostics only, never authoritative: it is surfaced to an
  -- administrator as drift evidence and is barred from payroll and EVV arithmetic (§3.6).
  -- A phone with a wrong clock must not be able to move money.
  add column client_captured_at timestamptz,
  -- When the SERVER learned of the event. occurred_at stays the asserted time of the
  -- event itself, which is what lets a 0047 correction assert a past time honestly.
  -- NOTE: rows written before this migration carry the migration's own timestamp here.
  -- The append-only trigger makes a backfill impossible by construction (invariant 1 is
  -- not negotiable for one column's cosmetics), so the artifact is documented rather than
  -- laundered.
  add column received_at timestamptz not null default now(),
  -- What geography and which rules this event was judged against — bound at capture, not
  -- looked up later, so the verdict stays reproducible after an address revision or a
  -- policy change (D-014 / D-025).
  add column service_location_version_id uuid
    references public.service_location_version(id),
  add column policy_id uuid references public.visit_policy(id),
  -- Metres to the bound service location. Coordinate-DERIVED evidence, not a coordinate:
  -- safe on an RLS-gated administrator surface, and barred from audit payloads, outbox
  -- payloads, notifications, telemetry and prompts. The caregiver-facing RPC returns a
  -- bucket instead (D-030, §4.4).
  add column distance_m double precision,
  -- The §4.3 rule's verdict, stored as evidence rather than recomputed later against
  -- whatever the policy says by then. 'suspicious' is never produced by
  -- app.evaluate_location — only a §4.5 rule holding evidence may set it.
  add column location_status text check (location_status in
    ('verified','low_accuracy','outside_geofence','unavailable','suspicious',
     'not_required')),
  -- The finer-grained capture lane. `method` keeps its 0013 ('web','manual') CHECK;
  -- capture_source is what tells an offline replay apart from a live capture, which §7.6
  -- requires ("offline events are never presented as ordinarily verified").
  add column capture_source text not null default 'web'
    check (capture_source in ('web','offline','manual','system')),
  add column is_offline boolean not null default false,
  -- Opaque and rotating. Deliberately NOT a device fingerprint: it exists to correlate one
  -- session's events with each other, never to identify a person's hardware across
  -- sessions (docs/09 §6 posture, and D-030's closed capture list).
  add column device_session_id text,
  add column reason_code text check (reason_code in
    ('alternate_location','gps_unavailable','address_incorrect','emergency_visit',
     'device_issue','network_failure','other')),
  -- Corrections REFERENCE what they correct; the original is never touched (invariant 1,
  -- and the 0005 form_version pattern). 0047 owns app.correct_visit_event.
  add column corrects_event_id uuid references public.visit_event(id);

-- Idempotent replay (§4.4 step 3): the same queued client_event_id may arrive any number
-- of times and must land at most one row. Partial, because a live online clock event
-- carries no key at all and many NULLs have to coexist on one visit. tenant_id leads the
-- key even though visit_id already implies it — a unique index is the one place where
-- restating the tenancy is cheap insurance against a cross-tenant visit_id collision.
create unique index uq_visit_event_client_event
  on public.visit_event (tenant_id, visit_id, client_event_id)
  where client_event_id is not null;
-- The exception engine (0047) walks one visit's ledger by type in time order — "is there
-- an open clock_in with no clock_out yet?" is its hot question, and it asks it about every
-- in-progress visit every five minutes. It is also the access path public.verified_visit's
-- two lateral joins take, once per visit row.
create index idx_visit_event_visit_type
  on public.visit_event (visit_id, event_type, occurred_at);

-- ── The audit payload catches up with the ledger (invariant 7, D-030) ─────────────────
-- 0013's payload carried {visit_id, method}. With capture_source landing above, `method`
-- alone would audit an offline replay as an ordinary web capture — a defect this migration
-- would otherwise have introduced. The payload gains the three enums that make a clock
-- event legible after the fact and gains nothing else: no coordinates, no distance_m
-- (coordinate-derived evidence belongs on the RLS-gated read surfaces, not on a ledger
-- that feeds exports), no note, no device_session_id. Invariant 5 + D-030. event_type is
-- already borne by the audit ACTION ('visit.clock_in_rejected' and friends), so it is not
-- repeated in the payload. The seed guard is restated in the 0011/0023/0027 early-return
-- form rather than 0013's wrapping `if`, so the shape matches every other emitter.
create or replace function app.audit_visit_event() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('visit.' || new.event_type, 'visit_event', new.id,
    jsonb_build_object('visit_id', new.visit_id,
                       'method', new.method,
                       'capture_source', new.capture_source,
                       'location_status', new.location_status,
                       'is_offline', new.is_offline));   -- never lat/lng, never distance
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_visit_event() from public;

-- No outbox trigger is attached to visit_event here. §4.4 step 9 pins domain-event
-- emission (visit.clock_in.verified / .exception / visit.clock_out.completed) to the clock
-- RPC in 0046, because the event NAME depends on the decision the RPC has just made; a
-- row-level trigger would either duplicate what the RPC emits or have to re-derive that
-- decision from the row. Flagged rather than assumed — 0027's "triggers, so a future write
-- path cannot forget the ledger" posture still governs the visit row itself
-- (trg_visit_domain_events), which is where the visit lifecycle events come from.

-- ═══ 3 · public.verified_visit — the derived operational read model (§3) ═════════ PHI
-- security_invoker is load-bearing, not decoration: without it the view executes as its
-- owner (postgres, who bypasses RLS) and would hand every authenticated caller every
-- tenant's clock ledger — a privilege-escalation hole wearing a convenience mask. With it,
-- RLS on BOTH base tables composes through, so a caregiver sees their own visits, a
-- care-team member sees their client's, a schedule.read holder sees the org, AAL1 sees
-- nothing, and tenant B sees nothing. Same idiom as public.credential_expiry (0008),
-- public.cadence_obligation_status (0009) and public.employee_file_status (0033).
--
-- MINUTES ARE WHOLE MINUTES, FLOORED. A visit worked 125 seconds short of two hours is
-- 119 minutes, not 120: the conservative direction is the one that survives a
-- wage-and-hour challenge, and rounding up silently invents paid time. Any rounding policy
-- (visit_policy.rounding_policy, §3.4) is applied ON TOP of these raw values by
-- app.compute_visit_minutes (0050) — this view never rounds, so the unrounded truth stays
-- retrievable.
--
-- verified_minutes is deliberately NOT clamped at zero. A clock-out that precedes its
-- clock-in is an incoherent ledger, and a negative number says so; clamping would launder
-- it into "worked nothing", which reads like an ordinary no-show. approved_work_segment
-- (§3.10) CHECKs verified_minutes >= 0, so the incoherence refuses to become money on its
-- own — exactly the right failure direction.
--
-- late_minutes and overrun_minutes are NULL when the corresponding clock event is missing,
-- never 0. This needs the explicit CASE: greatest() IGNORES nulls in Postgres, so
-- greatest(null, 0) is 0 — which would report a visit nobody ever showed up for as "on
-- time". That is the most expensive silent bug available in this file. Both are clamped at
-- zero on the other side: arriving early is not negative lateness, it is earliness, and
-- §10 counts it separately (early_count).
--
-- CORRECTIONS ARE NOT FOLDED IN HERE. actual_start/actual_end read the literal
-- clock_in/clock_out events per §3, and a 0047 `correction` event (which carries its
-- asserted time in occurred_at and points at what it corrects via corrects_event_id) does
-- not move them yet. That reconciliation belongs to 0047, where the semantics of a
-- correction row are actually defined; folding it in from here would be guessing at
-- another slice's contract inside a column that feeds payroll. Surfaced in the ST-203
-- result so it cannot be lost.
--
-- COMPOSITION IS PER-TABLE, AND THAT IS A FEATURE. Because RLS is evaluated on visit AND
-- on visit_event independently, a principal who can see a visit but not one of its events
-- gets the visit row with NULL derived columns rather than someone else's clock data.
-- The one case where the two policies differ today is a co-worker's event on a visit you
-- are assigned to (visit_event_select_scoped, 0013, admits your own events, schedule.read,
-- or the client's care team). Failing closed to NULL is the right direction; 0047's
-- exception surfaces run under schedule.read / visit.verify.read, which see both.
--
-- D-030: no coordinate is selected anywhere in this definition. Distance in metres is
-- administrator evidence and stays inside this RLS-gated surface; the caregiver-facing RPC
-- returns 'inside'/'near'/'far'. The pgTAP file greps this view's own catalog definition
-- for 'latitude' and 'longitude', so the property stays true rather than merely intended.
create or replace view public.verified_visit
with (security_invoker = true) as
select
  v.id                                as visit_id,
  v.tenant_id,
  v.client_id,
  v.caregiver_id,
  v.service_type_id,
  v.service_location_id,
  v.service_location_version_id,
  v.policy_id,
  v.status,
  v.scheduled_start,
  v.scheduled_end,
  ci.occurred_at                      as actual_start,
  co.occurred_at                      as actual_end,
  floor(extract(epoch from (v.scheduled_end - v.scheduled_start)) / 60)::int
                                      as scheduled_minutes,
  floor(extract(epoch from (co.occurred_at - ci.occurred_at)) / 60)::int
                                      as verified_minutes,
  case when ci.occurred_at is null then null else
    greatest(floor(extract(epoch from (ci.occurred_at - v.scheduled_start)) / 60), 0)::int
  end                                 as late_minutes,
  case when co.occurred_at is null then null else
    greatest(floor(extract(epoch from (co.occurred_at - v.scheduled_end)) / 60), 0)::int
  end                                 as overrun_minutes,
  v.verification_status,
  v.approval_status,
  v.payroll_status,
  v.evv_status,
  ci.location_status                  as clock_in_location_status,
  co.location_status                  as clock_out_location_status,
  ci.distance_m                       as clock_in_distance_m,
  co.distance_m                       as clock_out_distance_m,
  ci.capture_source                   as clock_in_capture_source,
  co.capture_source                   as clock_out_capture_source,
  -- §7.6: an offline replay is never presented as ordinarily verified. One boolean here
  -- beats teaching every consumer surface the rule and hoping they all remember it.
  (coalesce(ci.is_offline, false) or coalesce(co.is_offline, false))
                                      as had_offline_capture,
  -- IDs travel, content is refetched under RLS (invariant 5): the exception inbox links to
  -- its evidence by id rather than carrying the event row around.
  ci.id                               as clock_in_event_id,
  co.id                               as clock_out_event_id
from public.visit v
-- Earliest clock_in wins: a caregiver who taps twice has one arrival, and the first tap is
-- the one that happened. created_at breaks a same-instant tie deterministically.
left join lateral (
  select e.id, e.occurred_at, e.location_status, e.distance_m,
         e.capture_source, e.is_offline
    from public.visit_event e
   where e.visit_id = v.id and e.event_type = 'clock_in'
   order by e.occurred_at, e.created_at
   limit 1
) ci on true
-- Latest clock_out wins: the last departure is the one that ended the visit. Note both
-- laterals filter on the literal clock types, so a *_rejected attempt never becomes an
-- arrival — which is the entire reason those event types exist.
left join lateral (
  select e.id, e.occurred_at, e.location_status, e.distance_m,
         e.capture_source, e.is_offline
    from public.visit_event e
   where e.visit_id = v.id and e.event_type = 'clock_out'
   order by e.occurred_at desc, e.created_at desc
   limit 1
) co on true;

grant select on public.verified_visit to authenticated;   -- reads compose through RLS

-- No permission key is inserted by this migration. The view adds no authorization surface
-- of its own — everything it exposes is derivable by any principal that can already read
-- the visit and its events — so gating it separately would be theatre. docs/17 §5's keys
-- land with the engines that actually enforce them: visit.verify.* and visit.correct with
-- 0047, visit.approve and payroll.* with 0050, evv.* with 0049.
