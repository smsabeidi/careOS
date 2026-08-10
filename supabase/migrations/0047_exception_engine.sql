-- ST-205 · Migration 0047 — the exception engine: detection, disposition, correction
-- The verified-visit spine (0043–0046) produces facts. This migration produces the
-- OPERATIONAL CONSEQUENCE of those facts: an append-only exception ledger, a human
-- disposition ledger on top of it, five deterministic detectors, the cron sweep that
-- runs them, and the correction path that lets a supervisor fix a clock time without
-- ever rewriting one.
--
-- Shape and precedent (nothing here is a new idea, only a new subject):
--   * public.visit_exception [AO] + public.visit_exception_disposition [AO] follow the
--     0011 schedule_exception pattern — immutable domain history, definer-audited,
--     read-scoped to the people who can already see the parent visit. The current
--     state of an exception is the LATEST disposition, exposed through the
--     security_invoker view public.visit_exception_state (the 0009 / 0016 / 0033 view
--     idiom, so RLS composes through it instead of around it).
--   * `unique (tenant_id, visit_id, kind, dedupe_key)` is what makes a sweep safe to
--     run every five minutes forever: a detector re-raising the same finding is an
--     ON CONFLICT DO NOTHING, not a duplicate row and not an error (idempotency is a
--     return value, never an exception — the 0023 app.assign_visit posture).
--   * Every detector takes an injectable clock (`p_now`) — the D-016 precedent.
--     Temporal correctness that cannot be tested is temporal correctness that is not
--     known to be correct, and every rule here is a deadline rule.
--   * app.sweep_visit_exceptions is registered on pg_cron through app.run_job, the
--     0034 idiom, with a pre-seeded RED heartbeat (the 0039 H1 posture: a sweep that
--     never came up is a failure, not an unknown).
--   * Detection is Engine 1 — pure SQL over the ledger (invariant 13). No model
--     decides whether a visit was missed, whether two visits overlap, or whether a
--     journey was physically possible. The AI layer (docs/17 §11) ranks and narrates
--     what this file computes; it never computes it.
--
-- One addition to the docs/17 §3.8 shape, surfaced rather than slipped in (DN-0047e):
-- visit_exception_disposition carries a `seq bigint generated always as identity`.
-- "Current state = the latest disposition" is undecidable without it, because now() is
-- the TRANSACTION timestamp and two dispositions written in one transaction tie exactly
-- — leaving a random uuid to choose the state. audit.audit_event (0003) already solves
-- this with the same instrument. Full rationale at the column.
--
-- Two deliberate consequences worth naming:
--   * detect_missed_visits is the FIRST caller of the scheduled→missed transition that
--     0026 whitelisted in public.state_transition and that nothing has ever invoked.
--     Until now a visit nobody attended stayed 'scheduled' forever.
--   * Raising any exception on a visit projects verification_status='exception'
--     (D-024: the four axes are projections of append-only ledgers, and the ledger is
--     the truth). The column is definer-writable only, per the 0045 tightening.
--
-- PHI posture (invariant 5, D-030): visit_exception.evidence carries IDs, enums,
-- timestamps and NUMBERS only. Coordinates never enter it — enforced twice, by an
-- explicit CAREOS_PHI_LEAK guard in the raiser and by a CHECK constraint underneath it,
-- because the impossible-travel detector is the one rule in this file that reads
-- coordinates and it must be structurally unable to write them back out. Audit,
-- outbox and notification payloads carry IDs and enums only; free-text reasons live in
-- the PHI tables where RLS governs them and are excluded from every payload (the 0011
-- schedule_exception.note precedent).
--
-- Notification templates: app.queue_notification validates template_key against a
-- CLOSED map inside the function body (0039 finding M4 — PHI-free titles by
-- construction). A closed map in a function body can only be extended by re-declaring
-- the function, and 0039 must not be edited (expand-phase only), so this migration
-- re-declares app.queue_notification with all six existing keys preserved verbatim
-- plus three new visit keys. DN-0047a: the map wants to be a table
-- (public.notification_template) so that adding a nudge stops being a function
-- rewrite; that contraction needs its own story and its own decision-log entry.
-- @trace: ST-205, D-016, D-020, D-024, D-030, docs/17 §3.7, §3.8, §4.5, §4.6, §6.3

-- ══ 1 · Permission vocabulary ═════════════════════════════════════════════════════════
-- Real config, so production has the keys (the 0011 / 0026 precedent — permissions
-- belong in the migration, per-tenant role wiring in the same breath so no key ships
-- orphaned the way family.manage did until 0026 §A).
insert into public.permission (key, description) values
  ('visit.verify.read', 'See the visit exception queue and verification detail'),
  ('visit.verify.act',  'Dispose visit exceptions — acknowledge, resolve, dismiss, escalate'),
  ('visit.correct',     'Append a correction to a recorded clock event')
on conflict (key) do nothing;

-- Grant wiring by role KEY across every tenant's system roles, idempotent (0026 §A).
-- Owner and admin get the full verification surface; the coordinator runs the day and
-- holds the queue but does not get the clock pen — a correction is an evidentiary act
-- on a payroll record and stays with the administrator.
insert into public.role_permission (role_id, permission_key)
select r.id, v.perm
from public.role r
join lateral (values
  ('owner',       'visit.verify.read'), ('owner', 'visit.verify.act'),
  ('owner',       'visit.correct'),
  ('admin',       'visit.verify.read'), ('admin', 'visit.verify.act'),
  ('admin',       'visit.correct'),
  ('coordinator', 'visit.verify.read'), ('coordinator', 'visit.verify.act')
) as v(role_key, perm) on v.role_key = r.key
where r.is_system
on conflict do nothing;

-- ══ 2 · Audit emitters (definer; IDs + enums only — never evidence, never reasons) ════
create or replace function app.audit_visit_exception() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  -- Mirrors app.audit_schedule_exception (0011): the action names the kind, which is a
  -- bounded enum. evidence is deliberately NOT in the payload — it is safe by CHECK but
  -- the audit ledger keeps the narrowest payload that answers "what happened".
  perform app.emit_audit('visit_exception.' || new.kind, 'visit_exception', new.id,
    jsonb_build_object('visit_id', new.visit_id,
                       'caregiver_id', new.caregiver_id,   -- id only; never PHI content
                       'kind', new.kind,
                       'severity', new.severity,
                       'detected_by', new.detected_by));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_visit_exception() from public;

create or replace function app.audit_visit_exception_disposition() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  -- reason is free text a human typed about a care event: it can carry PHI and is
  -- excluded from the payload (the 0011 note precedent). acted_by is the accountability.
  perform app.emit_audit('visit_exception.' || new.disposition,
    'visit_exception_disposition', new.id,
    jsonb_build_object('exception_id', new.exception_id,
                       'disposition', new.disposition,
                       'acted_by', new.acted_by));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_visit_exception_disposition() from public;

-- ══ 3 · visit_exception — the detected-exception ledger ═══════════════ [AO] PHI ══════
create table public.visit_exception (                               -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  caregiver_id uuid references public.app_user(id),   -- NULL ⇒ nobody was on the visit
  kind text not null check (kind in (
    'location_unverified','low_accuracy','outside_geofence','location_unavailable',
    'late_start','early_end','long_visit','short_visit','missing_clock_out','missed_visit',
    'overlapping_visits','impossible_travel','manual_correction','duplicate_visit',
    'evv_rejected','payroll_mismatch','documentation_missing')),
  severity text not null default 'info'
    check (severity in ('info','warning','critical')),
  detected_by text not null default 'rule'
    check (detected_by in ('rule','human','agent')),
  rule_key text,                                     -- 'sweep.missing_clock_out'
  dedupe_key text not null,                          -- what makes the sweeps idempotent
  evidence jsonb not null default '{}'::jsonb,       -- IDs + numbers ONLY (invariant 5)
  source_event_id uuid references public.visit_event(id),
  created_by uuid references public.app_user(id),    -- NULL ⇒ the sweep, not a person
  created_at timestamptz not null default now(),
  -- One finding per (visit, kind, dedupe_key), forever: a detector re-running is an
  -- ON CONFLICT DO NOTHING, so the five-minute sweep can never duplicate a finding.
  constraint uq_visit_exception_dedupe
    unique (tenant_id, visit_id, kind, dedupe_key),
  -- D-030 made structural: coordinates are PHI-by-linkage and must never reach a
  -- surface that is read by the exception queue, exported, or fed to a model. The
  -- impossible-travel rule reads coordinates and writes only a speed — this constraint
  -- is what keeps that true for every future detector as well. Top-level keys only;
  -- the raiser's CAREOS_PHI_LEAK guard is the legible error above it.
  constraint chk_visit_exception_evidence_no_coords
    check (not (evidence ?| array['lat','lng','latitude','longitude',
                                  'coordinates','geo','point']::text[]))
);
create index idx_visit_exception_tenant on public.visit_exception (tenant_id, created_at desc);
create index idx_visit_exception_visit on public.visit_exception (visit_id, created_at);
create index idx_visit_exception_caregiver
  on public.visit_exception (caregiver_id, created_at desc);
create index idx_visit_exception_tenant_kind
  on public.visit_exception (tenant_id, kind, created_at desc);
-- The triage queue's hot path: an operations lead opens the day on the critical rows.
create index idx_visit_exception_critical on public.visit_exception (tenant_id, created_at desc)
  where severity = 'critical';

create trigger trg_visit_exception_ao before update or delete on public.visit_exception
  for each row execute function app.forbid_mutation();
create trigger trg_visit_exception_audit after insert on public.visit_exception
  for each row execute function app.audit_visit_exception();

alter table public.visit_exception enable row level security;
alter table public.visit_exception force row level security;

-- Read: the caregiver the exception is about (they are told what went wrong on their
-- own visit — docs/10 voice, and a workforce record about a person is a record that
-- person may read), the exception queue (visit.verify.read), or a care-team member on
-- the visit's client. PHI by reference ⇒ AAL2 (invariant 3). schedule.read is
-- deliberately NOT included: seeing the roster is not seeing the fraud queue.
create policy visit_exception_select_scoped on public.visit_exception
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    caregiver_id = auth.uid()
    or app.has_perm('visit.verify.read')
    or exists (select 1 from public.visit v
                where v.id = visit_id and app.on_care_team(v.client_id))));

grant select on public.visit_exception to authenticated;
  -- no insert/update/delete: append-only, and every raise is a definer path

-- ══ 4 · visit_exception_disposition — how a human resolved it ═════════ [AO] PHI ══════
create table public.visit_exception_disposition (                   -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  exception_id uuid not null references public.visit_exception(id),
  disposition text not null check (disposition in
    ('acknowledged','resolved','dismissed','escalated','reopened')),
  reason text not null,
  acted_by uuid not null references public.app_user(id),   -- ALWAYS a human (D-020)
  created_at timestamptz not null default now(),
  -- APPEND ORDER, and the reason this column exists at all (DN-0047e, an addition to
  -- docs/17 §3.8's shape). The current state of a finding is "the LATEST disposition",
  -- and created_at cannot decide that on its own: now() is the TRANSACTION timestamp,
  -- so two dispositions written in one transaction — a resolve immediately reopened by
  -- the same RPC batch, a correction flow that closes and re-raises — carry the
  -- identical instant, and the tiebreak then falls to a random uuid. That is a state
  -- machine whose current state is decided by gen_random_uuid(), which is not a state
  -- machine. An identity column is the same instrument audit.audit_event (0003) uses to
  -- order its chain, for the same reason. Ordering only: it is never an FK target, never
  -- surfaced, and the uuid stays the identity.
  seq bigint generated always as identity,
  constraint chk_visit_exception_disposition_reason check (btrim(reason) <> '')
);
create index idx_visit_exception_disposition_tenant
  on public.visit_exception_disposition (tenant_id, created_at desc);
-- Carries seq so the "latest disposition" lookup — the hottest read in the queue, run
-- once per exception per page — is an index-order scan and not a sort.
create index idx_visit_exception_disposition_exception
  on public.visit_exception_disposition (exception_id, created_at desc, seq desc);

create trigger trg_visit_exception_disposition_ao
  before update or delete on public.visit_exception_disposition
  for each row execute function app.forbid_mutation();
create trigger trg_visit_exception_disposition_audit
  after insert on public.visit_exception_disposition
  for each row execute function app.audit_visit_exception_disposition();

alter table public.visit_exception_disposition enable row level security;
alter table public.visit_exception_disposition force row level security;

-- Read follows the parent exception exactly (the 0011 schedule_exception → visit
-- pattern): if you can see the finding, you can see how it was closed and by whom.
create policy visit_exception_disposition_select_scoped
  on public.visit_exception_disposition for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.visit_exception e
    where e.id = exception_id and (
      e.caregiver_id = auth.uid()
      or app.has_perm('visit.verify.read')
      or exists (select 1 from public.visit v
                  where v.id = e.visit_id and app.on_care_team(v.client_id)))));

grant select on public.visit_exception_disposition to authenticated;
  -- no insert/update/delete: append-only, disposition only via app.dispose_visit_exception

-- ══ 5 · visit_exception_state — current state = the latest disposition ════════════════
-- security_invoker so RLS on both ledgers composes THROUGH the view rather than around
-- it (the 0008 / 0009 / 0016 / 0033 idiom — a definer view would be a privileged
-- retrieval path, which invariant 9 forbids).
-- `open` is the operational question every surface asks: no disposition yet, or the
-- latest disposition reopened it. Everything else (acknowledged/resolved/dismissed/
-- escalated) is closed for queue purposes; escalation is closed HERE and open on the
-- escalation surface, which is a different queue.
create view public.visit_exception_state
with (security_invoker = true) as
select e.id                as exception_id,
       e.tenant_id         as tenant_id,
       e.visit_id          as visit_id,
       e.caregiver_id      as caregiver_id,
       e.kind              as kind,
       e.severity          as severity,
       e.detected_by       as detected_by,
       e.rule_key          as rule_key,
       e.dedupe_key        as dedupe_key,
       e.evidence          as evidence,
       e.source_event_id   as source_event_id,
       e.created_at        as detected_at,
       d.id                as latest_disposition_id,
       d.disposition       as latest_disposition,
       d.acted_by          as disposed_by,
       d.created_at        as disposed_at,
       (d.id is null or d.disposition = 'reopened') as open
  from public.visit_exception e
  left join lateral (
    select x.id, x.disposition, x.acted_by, x.created_at
      from public.visit_exception_disposition x
     where x.exception_id = e.id
     -- seq, not id: same-transaction dispositions share created_at, and a uuid
     -- tiebreak would make `open` non-deterministic (see the column's note).
     order by x.created_at desc, x.seq desc
     limit 1
  ) d on true;

grant select on public.visit_exception_state to authenticated;

-- ══ 6 · Internal plumbing: the supervisor fan-out, and the one raiser ═════════════════
-- Supervisor fan-out. Same shape as app.note_fill_exhaustion (0039 L3): resolve the
-- audience from the permission catalog, one deduped in-app nudge each, IDs only.
-- kind='staff' is asserted so an agent principal holding visit.verify.act is never
-- paged — machines do not read inboxes (D-020).
create or replace function app.notify_visit_verifiers(
  p_tenant uuid, p_template_key text, p_visit uuid, p_dedupe_scope text
) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_sent int := 0;
begin
  for r in
    select distinct ur.user_id
      from public.user_role ur
      join public.role_permission rp on rp.role_id = ur.role_id
      join public.role ro on ro.id = ur.role_id
      join public.app_user u on u.id = ur.user_id
     where rp.permission_key = 'visit.verify.act'
       and ro.tenant_id = p_tenant
       and u.tenant_id = p_tenant
       and u.kind = 'staff'
       and u.status = 'active'
  loop
    if app.queue_notification(r.user_id, p_template_key, null, 'visit', p_visit,
         'in_app',
         p_template_key || ':' || p_dedupe_scope || ':' || r.user_id::text) is not null
    then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;
revoke all on function app.notify_visit_verifiers(uuid, text, uuid, text)
from public, anon, authenticated;

-- Every exception in the product is born here — the detectors below, the clock engine
-- (0046) and app.raise_visit_exception all funnel through this one body, so audit,
-- outbox, the D-024 projection and the PHI guard cannot be forgotten by a future
-- caller. Mirrors app.emit_event_internal (0027): no grants of any kind.
create or replace function app.raise_visit_exception_internal(
  p_tenant uuid, p_visit uuid, p_caregiver uuid, p_kind text, p_severity text,
  p_detected_by text, p_rule_key text, p_evidence jsonb, p_dedupe_key text,
  p_source_event uuid, p_actor uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  -- No session tenant ⇒ this is the cron sweep, where the audit/outbox triggers no-op
  -- by design (the 0011 seed-guard). The system emitters carry those paths instead, so
  -- invariant 7 holds for a machine-detected exception exactly as for a human act.
  v_system boolean := app.current_tenant_id() is null;
begin
  -- Invariant 5 / D-030, stated legibly before the CHECK states it structurally.
  -- Two clauses because they catch different mistakes: the `?|` test is the exact
  -- predicate the CHECK enforces (top-level keys), and the regex reaches keys nested
  -- inside an evidence object, which a CHECK cannot express cheaply. The regex matches
  -- a QUOTED key, so 'latency' and 'geofence_radius_m' are unaffected.
  if p_evidence ?| array['lat','lng','latitude','longitude',
                         'coordinates','geo','point']::text[]
     or p_evidence::text ~ '"(lat|lng|latitude|longitude|coordinates|geo|point)"[[:space:]]*:'
  then
    raise exception
      'CAREOS_PHI_LEAK: exception evidence carries IDs and numbers, never coordinates'
      using errcode = 'P0001';
  end if;

  insert into public.visit_exception
    (tenant_id, visit_id, caregiver_id, kind, severity, detected_by, rule_key,
     dedupe_key, evidence, source_event_id, created_by)
  values
    (p_tenant, p_visit, p_caregiver, p_kind, p_severity, p_detected_by, p_rule_key,
     coalesce(p_dedupe_key, 'visit:' || p_visit::text), coalesce(p_evidence, '{}'::jsonb),
     p_source_event, p_actor)
  on conflict on constraint uq_visit_exception_dedupe do nothing
  returning id into v_id;

  if v_id is null then
    return null;                        -- already raised: the sweep is idempotent
  end if;

  -- D-024: the projection follows the ledger. Promote from pending/verified only —
  -- a visit already under manual_review is not demoted by a second finding, and the
  -- column is definer-writable only (the 0045 column-grant tightening).
  update public.visit
     set verification_status = 'exception',
         updated_at = now(), row_version = row_version + 1
   where id = p_visit and verification_status in ('pending','verified');

  if v_system then
    perform app.emit_audit_system(p_tenant, 'system', 'visit_exception.' || p_kind,
      'visit_exception', v_id,
      jsonb_build_object('visit_id', p_visit, 'caregiver_id', p_caregiver,
                         'kind', p_kind, 'severity', p_severity));
  end if;                               -- session path: trg_visit_exception_audit fired

  perform app.emit_event_internal(p_tenant, p_actor, 'visit.exception.raised',
    'visit_exception', v_id,
    jsonb_build_object('visit_id', p_visit, 'kind', p_kind, 'severity', p_severity));

  -- docs/17 §9, management by exception: a location that could not be verified is the
  -- one raise that pages the desk from here. missing_clock_out and missed_visit are
  -- notified by their own detectors (caregiver first, then the desk), so notifying
  -- again here would double-page. DN-0047b: §9 also asks for overlap and
  -- impossible-travel nudges; those need their own registered template keys and are
  -- deferred with the rest of the §9 catalog — both kinds are 'critical' and surface at
  -- the top of the queue meanwhile.
  if p_kind in ('location_unverified','low_accuracy','outside_geofence',
                'location_unavailable') then
    perform app.notify_visit_verifiers(p_tenant, 'visit.location_unverified', p_visit,
      p_kind || ':' || v_id::text);
  end if;

  return v_id;
end $$;
revoke all on function app.raise_visit_exception_internal(
  uuid, uuid, uuid, text, text, text, text, jsonb, text, uuid, uuid)
from public, anon, authenticated;

-- ══ 7 · The detectors (Engine 1 — pure SQL, injectable clock, idempotent) ═════════════
-- Contract for all five (docs/17 §4.5): return the count of NEW exceptions, never
-- raise on a finding, safe to run concurrently, safe to run every five minutes forever.
-- The p_now parameter is additive to the §4.5 signatures so both call styles resolve
-- (the D-029 defaulted-parameter posture) — temporal correctness must be testable
-- without waiting for the wall clock (D-016).
--
-- Policy resolution is per-visit and defensive: a tenant with no tenant-scope policy
-- row makes app.visit_policy_for raise CAREOS_POLICY_MISSING, and one unconfigured
-- tenant must never take down the sweep for every other tenant. Such a visit is
-- skipped, visibly, rather than judged against a threshold nobody set.
--
-- The handler is NARROW on purpose. `exception when others then skip` would turn every
-- future fault in the resolver — a renamed column, a permission slip, a bad merge — into
-- a silently unswept tenant, which is the most expensive shape of bug available in a
-- compliance engine: the queue looks calm because the detector stopped looking. So the
-- handler re-raises anything that is not the one gap it is allowed to absorb. It matches
-- on the message rather than the SQLSTATE because CAREOS_POLICY_MISSING is a docs/17 §4.2
-- contract term while its errcode is 0044's implementation detail.

create or replace function app.detect_missing_clock_out(p_now timestamptz default now())
returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_pol public.visit_policy;
  v_have_policy boolean;
  v_new int := 0;
  v_id uuid;
begin
  for r in
    select v.id, v.tenant_id, v.caregiver_id, v.scheduled_end,
           (select e.id from public.visit_event e
             where e.visit_id = v.id and e.event_type = 'clock_in'
             order by e.occurred_at desc, e.id desc limit 1) as clock_in_id
      from public.visit v
     where v.status = 'in_progress'
       and v.caregiver_id is not null
       and v.scheduled_end < p_now          -- widest possible prefilter; policy narrows
       and exists (select 1 from public.visit_event e
                    where e.visit_id = v.id and e.event_type = 'clock_in')
       and not exists (select 1 from public.visit_event e
                        where e.visit_id = v.id and e.event_type = 'clock_out')
  loop
    begin
      v_pol := app.visit_policy_for(r.id);
      v_have_policy := true;
    exception when others then
      if sqlerrm not like 'CAREOS_POLICY_MISSING%' then
        raise;                             -- a real fault must never look like a config gap
      end if;
      v_have_policy := false;
    end;
    if not v_have_policy then
      continue;                            -- unconfigured tenant: 0044's gap, not a finding
    end if;
    if r.scheduled_end + make_interval(mins => v_pol.missing_clock_out_minutes) >= p_now then
      continue;                            -- still inside the grace window
    end if;

    v_id := app.raise_visit_exception_internal(
      r.tenant_id, r.id, r.caregiver_id, 'missing_clock_out', 'warning', 'rule',
      'sweep.missing_clock_out',
      jsonb_build_object('scheduled_end', r.scheduled_end,
                         'threshold_minutes', v_pol.missing_clock_out_minutes,
                         'clock_in_event_id', r.clock_in_id),
      'visit:' || r.id::text, r.clock_in_id, null);
    if v_id is not null then
      v_new := v_new + 1;
      -- Caregiver first (docs/17 §9): the person who can still close the visit
      -- themselves hears about it before anybody escalates it.
      perform app.queue_notification(r.caregiver_id, 'visit.missing_clock_out', null,
        'visit', r.id, 'in_app', 'visit.missing_clock_out:cg:' || r.id::text);
    end if;

    -- Escalation, deduped per (visit, supervisor): still open at twice the threshold
    -- and the desk hears about it. Every later sweep pass is a no-op by dedupe_key.
    -- Openness is read THROUGH the state view rather than re-derived here, so the rule
    -- "no disposition, or the latest is reopened" has exactly one definition in the
    -- product. The view is security_invoker, but this body runs as its owner, which
    -- carries BYPASSRLS — and FORCE ROW LEVEL SECURITY does not revoke BYPASSRLS — so
    -- the sweep sees every tenant's ledger, which is precisely its job. This function
    -- has no grants, so no client identity can ever reach the view through it.
    if r.scheduled_end + make_interval(mins => 2 * v_pol.missing_clock_out_minutes) < p_now
       and exists (select 1 from public.visit_exception_state s
                    where s.visit_id = r.id and s.kind = 'missing_clock_out' and s.open)
    then
      perform app.notify_visit_verifiers(r.tenant_id, 'visit.missing_clock_out', r.id,
        'sup:' || r.id::text);
    end if;
  end loop;
  return v_new;
end $$;
revoke all on function app.detect_missing_clock_out(timestamptz)
from public, anon, authenticated;

-- The visit nobody attended. This is the FIRST caller of ('visit','scheduled','missed')
-- — 0026 whitelisted the transition in public.state_transition and, until this
-- migration, no code path in the product ever invoked it, so a no-show simply stayed
-- 'scheduled' forever and silently polluted every schedule-adherence number.
create or replace function app.detect_missed_visits(p_now timestamptz default now())
returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v public.visit;
  v_pol public.visit_policy;
  v_have_policy boolean;
  v_new int := 0;
  v_id uuid;
  v_system boolean := app.current_tenant_id() is null;
begin
  for r in
    select v2.id, v2.tenant_id, v2.caregiver_id, v2.client_id, v2.scheduled_start
      from public.visit v2
     where v2.status = 'scheduled'
       and v2.scheduled_start < p_now       -- widest possible prefilter; policy narrows
       and not exists (select 1 from public.visit_event e
                        where e.visit_id = v2.id and e.event_type = 'clock_in')
  loop
    begin
      v_pol := app.visit_policy_for(r.id);
      v_have_policy := true;
    exception when others then
      if sqlerrm not like 'CAREOS_POLICY_MISSING%' then
        raise;                             -- a real fault must never look like a config gap
      end if;
      v_have_policy := false;
    end;
    if not v_have_policy then
      continue;                            -- unconfigured tenant: 0044's gap, not a finding
    end if;
    if r.scheduled_start + make_interval(mins => v_pol.missed_visit_minutes) >= p_now then
      continue;                            -- the caregiver still has time to arrive
    end if;

    -- app.assign_visit (0023) locks the visit row and re-checks status='scheduled', so
    -- the row lock alone serializes a concurrent assignment against this transition —
    -- no advisory lock is taken here, and none is needed: this path takes exactly one
    -- lock, so it cannot participate in a cycle with the two-lock assignment path.
    select * into v from public.visit where id = r.id for update;
    if v.status <> 'scheduled' then
      continue;                            -- somebody clocked in or cancelled meanwhile
    end if;
    if exists (select 1 from public.visit_event e
                where e.visit_id = v.id and e.event_type = 'clock_in') then
      continue;                            -- a clock-in landed inside the race window
    end if;

    perform app.assert_transition('visit', v.status, 'missed');
    update public.visit
       set status = 'missed',
           verification_status = 'exception',    -- D-024 projection, definer-only column
           updated_at = now(), row_version = row_version + 1
     where id = v.id;

    v_id := app.raise_visit_exception_internal(
      v.tenant_id, v.id, v.caregiver_id, 'missed_visit', 'critical', 'rule',
      'sweep.missed_visit',
      jsonb_build_object('scheduled_start', r.scheduled_start,
                         'threshold_minutes', v_pol.missed_visit_minutes,
                         'client_id', v.client_id),
      'visit:' || v.id::text, null, null);
    if v_id is not null then
      v_new := v_new + 1;
    end if;

    if v_system then
      -- The 0011 audit trigger and the 0027 outbox trigger both no-op without a session
      -- tenant, so the sweep carries its own status-change ledger entries. In a session
      -- path the triggers already emitted both and this branch stays shut — one event,
      -- never two.
      perform app.emit_audit_system(v.tenant_id, 'system', 'visit.status_change',
        'visit', v.id, jsonb_build_object('client_id', v.client_id,
                                          'from', 'scheduled', 'to', 'missed'));
      perform app.emit_event_system(v.tenant_id, 'visit.missed', 'visit', v.id,
        jsonb_build_object('client_id', v.client_id, 'caregiver_id', v.caregiver_id));
    end if;

    -- docs/17 §9: the desk is told after missed_visit_minutes. The caregiver's own
    -- earlier nudge is the late_threshold rule, which is not part of this slice.
    perform app.notify_visit_verifiers(v.tenant_id, 'visit.missed', v.id,
      'missed:' || v.id::text);
  end loop;
  return v_new;
end $$;
revoke all on function app.detect_missed_visits(timestamptz)
from public, anon, authenticated;

-- Two visits, one caregiver, one body. Compared on ACTUAL windows from the ledger, not
-- on the schedule: a scheduling conflict is a scheduling problem, but two overlapping
-- CLOCKED windows is either a fraud signal or a data-entry error, and both need a human.
-- An open visit (clocked in, not yet out) is bounded at p_now so the live double-clock
-- — the case that actually matters — is caught while it is still happening.
-- DN-0047c: docs/17 §4.5 also asks for a per-CLIENT overlap pass. It is deliberately
-- not implemented here: two caregivers on one client at once is ordinary (a two-person
-- transfer, an overlapping handoff), so the same rule would be mostly false positives.
-- It needs its own kind and its own policy switch before it earns a place in the queue.
create or replace function app.detect_overlapping_visits(
  p_visit uuid default null, p_now timestamptz default now()
) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_new int := 0;
  v_id uuid;
begin
  for r in
    with actual as (
      select e.visit_id,
             e.tenant_id,
             e.caregiver_id,
             min(e.occurred_at) filter (where e.event_type = 'clock_in')  as started_at,
             max(e.occurred_at) filter (where e.event_type = 'clock_out') as ended_at
        from public.visit_event e
       where e.event_type in ('clock_in','clock_out')
         and e.occurred_at > p_now - interval '30 days'   -- bounded: sweeps run hot
       group by e.visit_id, e.tenant_id, e.caregiver_id
      having min(e.occurred_at) filter (where e.event_type = 'clock_in') is not null
    ),
    windowed as (
      select a.visit_id, a.tenant_id, a.caregiver_id, a.started_at,
             coalesce(a.ended_at, greatest(a.started_at, p_now)) as ended_at
        from actual a
    )
    select x.visit_id as visit_a, y.visit_id as visit_b,
           x.tenant_id, x.caregiver_id,
           greatest(x.started_at, y.started_at) as overlap_from,
           least(x.ended_at, y.ended_at)        as overlap_to
      from windowed x
      join windowed y
        on y.caregiver_id = x.caregiver_id
       and y.tenant_id = x.tenant_id
       and y.visit_id > x.visit_id              -- each pair enumerated exactly once
       and tstzrange(x.started_at, x.ended_at) && tstzrange(y.started_at, y.ended_at)
     where p_visit is null or x.visit_id = p_visit or y.visit_id = p_visit
  loop
    -- Raised on BOTH visits (docs/17 §4.5): each visit's own record must show the
    -- conflict, and each dedupe_key names the other side so a re-run is a no-op.
    v_id := app.raise_visit_exception_internal(
      r.tenant_id, r.visit_a, r.caregiver_id, 'overlapping_visits', 'critical', 'rule',
      'sweep.overlapping_visits',
      jsonb_build_object('other_visit_id', r.visit_b,
                         'overlap_minutes',
                         round(extract(epoch from (r.overlap_to - r.overlap_from))
                               / 60.0)::int),
      'visit:' || r.visit_b::text, null, null);
    if v_id is not null then v_new := v_new + 1; end if;

    v_id := app.raise_visit_exception_internal(
      r.tenant_id, r.visit_b, r.caregiver_id, 'overlapping_visits', 'critical', 'rule',
      'sweep.overlapping_visits',
      jsonb_build_object('other_visit_id', r.visit_a,
                         'overlap_minutes',
                         round(extract(epoch from (r.overlap_to - r.overlap_from))
                               / 60.0)::int),
      'visit:' || r.visit_a::text, null, null);
    if v_id is not null then v_new := v_new + 1; end if;
  end loop;
  return v_new;
end $$;
revoke all on function app.detect_overlapping_visits(uuid, timestamptz)
from public, anon, authenticated;

-- Physically impossible travel between two consecutive captured clock points. This is
-- the ONE rule in the product that reads coordinates, and it writes back only a speed,
-- two event IDs and a threshold (D-030 / invariant 5) — the raiser's guard and the
-- evidence CHECK make that structural rather than careful.
-- The > 60 s gate is arithmetic hygiene, not leniency: two events in the same minute
-- divide a real distance by ~zero hours and produce a meaningless number, so the rule
-- would fire on GPS jitter at a single address instead of on travel.
create or replace function app.detect_impossible_travel(
  p_visit uuid default null, p_now timestamptz default now()
) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_pol public.visit_policy;
  v_have_policy boolean;
  v_speed double precision;
  v_new int := 0;
  v_id uuid;
begin
  for r in
    with points as (
      select e.id, e.tenant_id, e.visit_id, e.caregiver_id, e.occurred_at,
             app.geo_point(e.latitude, e.longitude) as g
        from public.visit_event e
       where e.event_type in ('clock_in','clock_out')
         and e.latitude is not null and e.longitude is not null
         and e.caregiver_id is not null
         and e.occurred_at > p_now - interval '7 days'    -- bounded: sweeps run hot
         -- Scoped to ONE caregiver's whole recent trail when a visit is named: the
         -- journey being judged is between visits, so filtering the trail by visit
         -- first would make every cross-visit hop invisible.
         and (p_visit is null or e.caregiver_id = (select v.caregiver_id
                                                     from public.visit v
                                                    where v.id = p_visit))
    ),
    hops as (
      select p.id, p.tenant_id, p.visit_id, p.caregiver_id, p.occurred_at, p.g,
             lag(p.id)         over w as from_event_id,
             lag(p.visit_id)   over w as from_visit_id,
             lag(p.occurred_at) over w as from_at,
             lag(p.g)          over w as from_g
        from points p
      window w as (partition by p.caregiver_id order by p.occurred_at, p.id)
    )
    select h.id as to_event_id, h.tenant_id, h.visit_id, h.caregiver_id,
           h.from_event_id, h.from_visit_id,
           extensions.ST_Distance(h.from_g, h.g) as metres,
           extract(epoch from (h.occurred_at - h.from_at))::double precision
             as gap_seconds
      from hops h
     where h.from_event_id is not null
       and h.g is not null and h.from_g is not null
       and extract(epoch from (h.occurred_at - h.from_at)) > 60
       and (p_visit is null or h.visit_id = p_visit or h.from_visit_id = p_visit)
  loop
    begin
      v_pol := app.visit_policy_for(r.visit_id);
      v_have_policy := true;
    exception when others then
      if sqlerrm not like 'CAREOS_POLICY_MISSING%' then
        raise;                             -- a real fault must never look like a config gap
      end if;
      v_have_policy := false;
    end;
    if not v_have_policy then
      continue;                            -- unconfigured tenant: 0044's gap, not a finding
    end if;

    v_speed := (r.metres / 1000.0) / (r.gap_seconds / 3600.0);
    if v_speed <= v_pol.impossible_travel_kmh then
      continue;
    end if;

    v_id := app.raise_visit_exception_internal(
      r.tenant_id, r.visit_id, r.caregiver_id, 'impossible_travel', 'critical', 'rule',
      'sweep.impossible_travel',
      -- Numbers and IDs only. Distance is rounded to whole metres and speed to one
      -- decimal: the finding is "this journey was not possible", not a track.
      jsonb_build_object('speed_kmh', round(v_speed::numeric, 1),
                         'threshold_kmh', v_pol.impossible_travel_kmh,
                         'distance_m', round(r.metres::numeric),
                         'gap_seconds', round(r.gap_seconds::numeric),
                         'from_event_id', r.from_event_id,
                         'to_event_id', r.to_event_id,
                         'from_visit_id', r.from_visit_id),
      'hop:' || r.from_event_id::text, r.to_event_id, null);
    if v_id is not null then v_new := v_new + 1; end if;
  end loop;
  return v_new;
end $$;
revoke all on function app.detect_impossible_travel(uuid, timestamptz)
from public, anon, authenticated;

-- A completed visit with nothing written down, where policy requires a note.
-- DN-0047d: docs/17 §4.5 says "no note exists" without naming where a visit note
-- lives, and three surfaces can hold one today — visit.note (the scheduler's field),
-- visit_event.note (what the caregiver typed at the clock), and a finalised
-- form_instance bound to the visit (the clinical documentation lane, 0005). All three
-- count. A detector that flagged a caregiver who documented in the "wrong" place would
-- be a false accusation, and false accusations are how an exception queue dies.
create or replace function app.detect_documentation_gaps(
  p_visit uuid default null, p_now timestamptz default now()
) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_pol public.visit_policy;
  v_have_policy boolean;
  v_new int := 0;
  v_id uuid;
begin
  for r in
    select v.id, v.tenant_id, v.caregiver_id, v.scheduled_end
      from public.visit v
     where v.status = 'completed'
       and v.scheduled_end > p_now - interval '30 days'   -- older visits are settled
       and (p_visit is null or v.id = p_visit)
       and coalesce(btrim(v.note), '') = ''
       and not exists (select 1 from public.visit_event e
                        where e.visit_id = v.id and coalesce(btrim(e.note), '') <> '')
       and not exists (select 1 from public.form_instance fi
                        where fi.visit_id = v.id and fi.status = 'final')
  loop
    begin
      v_pol := app.visit_policy_for(r.id);
      v_have_policy := true;
    exception when others then
      if sqlerrm not like 'CAREOS_POLICY_MISSING%' then
        raise;                             -- a real fault must never look like a config gap
      end if;
      v_have_policy := false;
    end;
    if not v_have_policy or not v_pol.require_visit_note then
      continue;                            -- the agency does not require a note here
    end if;

    v_id := app.raise_visit_exception_internal(
      r.tenant_id, r.id, r.caregiver_id, 'documentation_missing', 'warning', 'rule',
      'sweep.documentation_missing',
      jsonb_build_object('scheduled_end', r.scheduled_end, 'requires_note', true),
      'visit:' || r.id::text, null, null);
    if v_id is not null then v_new := v_new + 1; end if;
  end loop;
  return v_new;
end $$;
revoke all on function app.detect_documentation_gaps(uuid, timestamptz)
from public, anon, authenticated;

-- ══ 8 · The sweep + its cron registration (0034 idiom) ════════════════════════════════
-- Sequential, not a single jsonb_build_object call, because the order matters: marking
-- a visit missed changes what the later rules see, and a sweep whose result depends on
-- argument evaluation order is not a deterministic engine.
create or replace function app.sweep_visit_exceptions(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_missing_clock_out int;
  v_missed int;
  v_overlap int;
  v_travel int;
  v_docs int;
begin
  v_missing_clock_out := app.detect_missing_clock_out(p_now);
  v_missed            := app.detect_missed_visits(p_now);
  v_overlap           := app.detect_overlapping_visits(null, p_now);
  v_travel            := app.detect_impossible_travel(null, p_now);
  v_docs              := app.detect_documentation_gaps(null, p_now);
  return jsonb_build_object(
    'ok', true,
    'swept_at', p_now,
    'missing_clock_out', v_missing_clock_out,
    'missed_visit', v_missed,
    'overlapping_visits', v_overlap,
    'impossible_travel', v_travel,
    'documentation_missing', v_docs,
    'total', v_missing_clock_out + v_missed + v_overlap + v_travel + v_docs);
end $$;
revoke all on function app.sweep_visit_exceptions(timestamptz)
from public, anon, authenticated;
-- No grant at all: the only caller is app.run_job under pg_cron, which executes as the
-- job owner. A client that wants a fresh queue reads the tables; it does not drive the
-- engine (invariant 6 — service_role never appears in a request path either).

select cron.schedule('careos_visit_sweep', '*/5 * * * *',
  $$select app.run_job('visit_sweep', 300, 'select app.sweep_visit_exceptions()')$$);

-- 0039 H1: a sweep that has never run is RED, not unknown. app.check_heartbeats flags
-- the null last_ok_at until the first green pass, so health is earned, not assumed.
insert into public.job_heartbeat (job_key, expected_interval_seconds)
values ('visit_sweep', 300)
on conflict (job_key) do nothing;

-- ══ 9 · Corrections — docs/17 §4.6 ════════════════════════════════════════════════════
-- The original event is never touched (invariant 1). A correction is a NEW append-only
-- row pointing at what it corrects, and it raises its own manual_correction exception
-- so that the act of changing a payroll-relevant timestamp is itself reviewable by a
-- second human. This is the app.correct_form (0006) shape, one domain over.
create or replace function app.correct_visit_event(
  p_event uuid, p_occurred_at timestamptz, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ev public.visit_event;
  v_new_id uuid;
  v_exception uuid;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to correct a clock event'
      using errcode = '42501';
  end if;
  if not app.has_perm('visit.correct') then
    raise exception 'CAREOS_FORBIDDEN: visit.correct is required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a correction needs a reason'
      using errcode = 'P0001';
  end if;
  if p_occurred_at is null then
    raise exception 'CAREOS_BAD_TIMESTAMP: a correction needs a corrected time'
      using errcode = 'P0001';
  end if;
  if p_occurred_at > now() then
    raise exception 'CAREOS_BAD_TIMESTAMP: a clock event cannot be moved into the future'
      using errcode = 'P0001';
  end if;

  select * into v_ev from public.visit_event
   where id = p_event and tenant_id = app.current_tenant_id();
  if v_ev.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit event' using errcode = 'P0001';
  end if;
  -- Only a clock reading can be corrected. A rejection or an exception request is a
  -- record of what the device reported at that moment; re-timing it would be fiction.
  if v_ev.event_type not in ('clock_in','clock_out','correction') then
    raise exception 'CAREOS_BAD_EVENT: only a clock event can be corrected (is %)',
      v_ev.event_type using errcode = 'P0001';
  end if;
  if v_ev.occurred_at = p_occurred_at then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'event_id', v_ev.id, 'occurred_at', v_ev.occurred_at);
  end if;

  -- The correction carries the caregiver and visit of what it corrects, never new
  -- coordinates: a supervisor at a desk has no location to contribute (D-030).
  insert into public.visit_event
    (tenant_id, visit_id, caregiver_id, event_type, occurred_at, method, note,
     capture_source, corrects_event_id)
  values
    (v_ev.tenant_id, v_ev.visit_id, v_ev.caregiver_id, 'correction', p_occurred_at,
     'manual', p_reason, 'manual', v_ev.id)
  returning id into v_new_id;

  -- Reviewable by construction: the correction lands on the same queue the fraud rules
  -- feed. dedupe_key is the new event, so each correction is exactly one finding.
  v_exception := app.raise_visit_exception_internal(
    v_ev.tenant_id, v_ev.visit_id, v_ev.caregiver_id, 'manual_correction', 'warning',
    'human', 'rpc.correct_visit_event',
    jsonb_build_object('corrects_event_id', v_ev.id,
                       'correction_event_id', v_new_id,
                       'event_type', v_ev.event_type,
                       'from_occurred_at', v_ev.occurred_at,
                       'to_occurred_at', p_occurred_at,
                       'shift_seconds',
                       round(extract(epoch from (p_occurred_at - v_ev.occurred_at))
                             ::numeric)),
    'event:' || v_new_id::text, v_new_id, auth.uid());

  -- Timestamps are not PHI (docs/17 §4.6); the reason is free text and is not carried.
  -- trg_visit_event_audit (0013) has already logged the bare visit.correction row —
  -- this is the delta a surveyor actually asks for: what it was, what it became.
  perform app.emit_audit('visit.event_corrected', 'visit_event', v_new_id,
    jsonb_build_object('visit_id', v_ev.visit_id,
                       'corrects_event_id', v_ev.id,
                       'event_type', v_ev.event_type,
                       'from', v_ev.occurred_at,
                       'to', p_occurred_at));
  perform app.emit_event('visit.corrected', 'visit_event', v_new_id,
    jsonb_build_object('visit_id', v_ev.visit_id, 'corrects_event_id', v_ev.id));

  return jsonb_build_object('ok', true, 'event_id', v_new_id,
                            'corrects_event_id', v_ev.id,
                            'occurred_at', p_occurred_at,
                            'exception_id', v_exception);
end $$;
revoke all on function app.correct_visit_event(uuid, timestamptz, text) from public, anon;
grant execute on function app.correct_visit_event(uuid, timestamptz, text) to authenticated;

-- ══ 10 · The three exception RPCs — docs/17 §6.3 ══════════════════════════════════════

-- app.raise_visit_exception — the system/internal entry point. No grants: the callers
-- are definer bodies (the 0046 clock engine, the detectors above, the correction path).
-- detected_by is pinned to 'rule' because this IS the rule lane; a human-flagged
-- exception would arrive through a surface that does not exist yet, and letting a
-- caller choose its own provenance is how an audit trail becomes decorative.
create or replace function app.raise_visit_exception(
  p_visit uuid, p_kind text, p_severity text, p_evidence jsonb, p_dedupe_key text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.visit;
  v_id uuid;
begin
  if p_severity is null or p_severity not in ('info','warning','critical') then
    raise exception 'CAREOS_BAD_SEVERITY: % is not a severity', p_severity
      using errcode = 'P0001';
  end if;
  -- Tenant comes from the VISIT, not the session: the sweep has no session and the
  -- clock engine has one, and both must raise identically.
  select * into v from public.visit where id = p_visit;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;

  v_id := app.raise_visit_exception_internal(
    v.tenant_id, v.id, v.caregiver_id, p_kind, p_severity, 'rule', null,
    p_evidence, p_dedupe_key, null, auth.uid());

  if v_id is null then
    return jsonb_build_object('ok', true, 'unchanged', true, 'visit_id', v.id,
                              'kind', p_kind);   -- already raised: idempotent, not an error
  end if;
  return jsonb_build_object('ok', true, 'exception_id', v_id, 'visit_id', v.id,
                            'kind', p_kind, 'severity', p_severity);
end $$;
revoke all on function app.raise_visit_exception(uuid, text, text, jsonb, text)
from public, anon, authenticated;

-- app.request_location_exception — the caregiver's escape hatch (docs/17 §4.4 step 7,
-- §7.1). The UI has already shown "We couldn't verify your location yet." with
-- Try again / Request exception; this is Request exception.
--
-- It deliberately does NOT append the clock event itself. app.clock_visit (0046) is the
-- single writer of clock events and the single mover of visit.status, and it already
-- implements the reason-supplied branch: given a reason_code it appends the event with
-- the unverified status and raises the matching exception. This function's whole job is
-- to (1) prove the caregiver may do this at all, (2) record the REQUEST itself as an
-- exception_requested event carrying what the caregiver said, and (3) replay the clock
-- through the one engine, carrying the position the rejected attempt already captured.
-- The client_event_id is deterministic per (visit, event), so a double-tap replays
-- through 0046's idempotency instead of double-clocking.
create or replace function app.request_location_exception(
  p_visit uuid, p_event text, p_reason_code text, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.visit;
  v_pol public.visit_policy;
  v_rejected public.visit_event;
  v_request_id uuid;
  v_clock jsonb;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to clock a visit'
      using errcode = '42501';
  end if;
  if p_event not in ('clock_in','clock_out') then
    raise exception 'CAREOS_BAD_EVENT: event must be clock_in or clock_out'
      using errcode = 'P0001';
  end if;
  if p_reason_code is null or p_reason_code not in
     ('alternate_location','gps_unavailable','address_incorrect','emergency_visit',
      'device_issue','network_failure','other') then
    raise exception 'CAREOS_BAD_REASON_CODE: % is not a recorded reason', p_reason_code
      using errcode = 'P0001';
  end if;

  select * into v from public.visit
   where id = p_visit and tenant_id = app.current_tenant_id();
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  -- Only the assigned caregiver, exactly as app.clock_visit gates it (0013).
  if v.caregiver_id is distinct from auth.uid() then
    raise exception
      'CAREOS_FORBIDDEN: only the assigned caregiver can clock this visit'
      using errcode = '42501';
  end if;

  v_pol := app.visit_policy_for(v.id);
  if not v_pol.allow_location_exception then
    raise exception
      'CAREOS_EXCEPTION_NOT_ALLOWED: this visit''s policy does not allow a location exception'
      using errcode = 'P0001';
  end if;

  -- The position the failed attempt already captured. There may be none — a caregiver
  -- whose device never produced a fix goes straight from the error to this button —
  -- and that is a lawful path, not a dead end: the clock lands with location_status
  -- 'unavailable' and the exception says exactly that.
  select * into v_rejected from public.visit_event e
   where e.visit_id = v.id
     and e.caregiver_id = auth.uid()
     and e.event_type = p_event || '_rejected'
   order by e.occurred_at desc, e.id desc
   limit 1;

  -- The request itself is a record of consequence: this is where the caregiver's stated
  -- reason lives, in a PHI table under RLS, and it is what a surveyor reads next to the
  -- clock event. It is not the clock event.
  insert into public.visit_event
    (tenant_id, visit_id, caregiver_id, event_type, latitude, longitude, accuracy_m,
     method, note, capture_source, reason_code, location_status)
  values
    (v.tenant_id, v.id, auth.uid(), 'exception_requested',
     v_rejected.latitude, v_rejected.longitude, v_rejected.accuracy_m,
     'manual', p_note, 'manual', p_reason_code, v_rejected.location_status)
  returning id into v_request_id;

  v_clock := app.clock_visit(
    p_visit             => v.id,
    p_event             => p_event,
    p_lat               => v_rejected.latitude,
    p_lng               => v_rejected.longitude,
    p_accuracy          => v_rejected.accuracy_m,
    p_client_event_id   => 'locexc:' || v.id::text || ':' || p_event,
    p_captured_at       => v_rejected.client_captured_at,
    p_offline           => coalesce(v_rejected.is_offline, false),
    p_reason_code       => p_reason_code,
    p_note              => p_note,
    p_device_session_id => v_rejected.device_session_id);

  perform app.emit_audit('visit.location_exception_requested', 'visit_event',
    v_request_id,
    jsonb_build_object('visit_id', v.id, 'event', p_event,
                       'reason_code', p_reason_code));   -- never the note, never a point

  return jsonb_build_object('ok', true, 'request_event_id', v_request_id,
                            'reason_code', p_reason_code, 'clock', v_clock);
end $$;
revoke all on function app.request_location_exception(uuid, text, text, text)
from public, anon;
grant execute on function app.request_location_exception(uuid, text, text, text)
to authenticated;

-- app.dispose_visit_exception — a person closes a finding, with a reason, on the record.
-- The kind='staff' assertion is the D-020 pattern (0035's trg_proposal_human_disposer,
-- 0033's human verifier): an agent may hold visit.verify.act to READ the queue and
-- draft a narrative, and can still never close a finding. Agents propose; humans
-- dispose (invariant 8), enforced in Postgres rather than asserted in a prompt.
create or replace function app.dispose_visit_exception(
  p_exception uuid, p_disposition text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ex public.visit_exception;
  v_latest text;
  v_id uuid;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to dispose an exception'
      using errcode = '42501';
  end if;
  if not app.has_perm('visit.verify.act') then
    raise exception 'CAREOS_FORBIDDEN: visit.verify.act is required'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                  where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: exceptions are disposed by people — agents only propose'
      using errcode = '42501';
  end if;
  if p_disposition not in
     ('acknowledged','resolved','dismissed','escalated','reopened') then
    raise exception 'CAREOS_BAD_DISPOSITION: % is not a disposition', p_disposition
      using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a disposition needs a reason'
      using errcode = 'P0001';
  end if;

  select * into v_ex from public.visit_exception
   where id = p_exception and tenant_id = app.current_tenant_id();
  if v_ex.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit exception' using errcode = 'P0001';
  end if;

  -- Idempotency is a return value, never an error (the 0023 assign_visit posture):
  -- a double-submitted "resolved" is the same resolution, not a second one.
  select d.disposition into v_latest
    from public.visit_exception_disposition d
   where d.exception_id = v_ex.id
   order by d.created_at desc, d.seq desc   -- same ordering rule as the state view
   limit 1;
  if v_latest is not null and v_latest = p_disposition then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'exception_id', v_ex.id, 'disposition', v_latest);
  end if;

  insert into public.visit_exception_disposition
    (tenant_id, exception_id, disposition, reason, acted_by)
  values
    (v_ex.tenant_id, v_ex.id, p_disposition, p_reason, auth.uid())
  returning id into v_id;

  -- The insert trigger carries the audit row (0011 pattern); the outbox is explicit
  -- because there is no disposition trigger and consumers rank on this event.
  perform app.emit_event('visit.exception.disposed', 'visit_exception', v_ex.id,
    jsonb_build_object('visit_id', v_ex.visit_id, 'kind', v_ex.kind,
                       'disposition', p_disposition));

  return jsonb_build_object('ok', true, 'exception_id', v_ex.id,
                            'disposition_id', v_id, 'disposition', p_disposition,
                            'open', p_disposition = 'reopened');
end $$;
revoke all on function app.dispose_visit_exception(uuid, text, text) from public, anon;
grant execute on function app.dispose_visit_exception(uuid, text, text) to authenticated;

-- ══ 11 · Notification templates: extending 0039's closed map ══════════════════════════
-- 0039 finding M4 made notification titles PHI-free BY CONSTRUCTION by deriving them
-- from a closed map in the function body and refusing anything unregistered. That is
-- the right property and it is preserved exactly. But a closed map inside a function
-- can only grow by re-declaring the function, and migrations are expand-phase only —
-- 0039 is not edited. So this is the same function with all six existing keys carried
-- over verbatim plus the three visit keys this migration needs. Titles say what
-- happened and what to do, and name nobody: the recipient's surface refetches the
-- content under their OWN RLS (D-005, invariant 5).
-- `create or replace` preserves the existing ACL; the paired revoke/grant below is
-- restated for legibility, not because anything changed.
create or replace function app.queue_notification(
  p_recipient uuid, p_template_key text, p_title text,
  p_subject_type text default null, p_subject_id uuid default null,
  p_channel text default 'in_app', p_dedupe_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_id uuid;
  v_title text := case p_template_key
    when 'offer.new'                then 'An open visit is available — first to accept gets it'
    when 'shift.fill_exhausted'     then 'An open visit ran out of candidates — scheduling attention needed'
    when 'credential.expiring'      then 'A credential needs renewal'
    when 'revocation.overdue'       then 'A separation checklist is overdue'
    when 'onboarding.reminder'      then 'A personnel-file item is waiting on you'
    when 'compliance.due'           then 'A compliance item is coming due'
    -- ST-205 (docs/17 §9): management by exception. Plain language, no jargon —
    -- never the words EVV, geofence, GPS or radius (docs/10 voice, docs/17 §7.1).
    when 'visit.missing_clock_out'  then 'A visit is still open — it needs to be completed'
    when 'visit.missed'             then 'A scheduled visit was never started'
    when 'visit.location_unverified' then 'A visit location could not be verified'
  end;
begin
  if v_title is null then
    raise exception 'CAREOS_BAD_TEMPLATE: % is not a registered notification template',
      p_template_key using errcode = 'P0001';
  end if;
  select tenant_id into v_tenant from public.app_user
   where id = p_recipient and status = 'active';
  if v_tenant is null then
    return null;                       -- never notify a dead account; not an error
  end if;
  insert into public.notification
    (tenant_id, recipient_id, channel, template_key, subject_type, subject_id,
     title, dedupe_key)
  values
    (v_tenant, p_recipient, p_channel, p_template_key, p_subject_type, p_subject_id,
     v_title, p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    return null;                       -- deduped: this nudge already exists
  end if;
  if p_channel <> 'in_app' then
    perform pgmq.send('q_notify', jsonb_build_object(
      'notification_id', v_id, 'channel', p_channel));   -- IDs only (invariant 5)
  end if;
  return v_id;
end $$;
revoke all on function
  app.queue_notification(uuid, text, text, text, uuid, text, text)
from public, anon, authenticated;
grant execute on function
  app.queue_notification(uuid, text, text, text, uuid, text, text)
to service_role;
