-- ST-208 · Migration 0050 — the payroll boundary: hours are approved here, money is paid
-- elsewhere. D-027 draws the line this file implements. *Approving hours* is a
-- care-operations act: it belongs with the verified visit, it is worthless if deferred
-- (an unapprovable timesheet makes the whole 0043–0049 layer decorative), and it is the
-- last human judgement in the chain that starts at a caregiver tapping a button on a
-- porch. *Paying people* is an accounting integration — a vendor, a book of record, a
-- general ledger — and stays Phase 2+ per docs/15 §2 and doc 01's "never the accounting
-- book of record" non-goal. The boundary is the point: everything downstream of
-- `payroll_export` is a file with a content hash on it, so adding a payroll provider
-- later is a new consumer of an existing artifact, not a rework of the visit spine.
--
-- WHAT THIS FILE IS ALLOWED TO DECIDE, AND WHAT IT IS NOT (invariant 13). Every number
-- here is arithmetic over an append-only ledger: minutes are subtraction, rounding is a
-- policy constant applied by a pure function, overtime is a comparison against a
-- threshold an agency set. No model participates and none ever may — a wage-and-hour
-- challenge is answered with a subtraction a caregiver can check, not with a
-- probability. The AI layer reads §10's aggregate features and writes the narrative;
-- it never writes a minute.
--
-- WHY approved_work_segment IS APPEND-ONLY AND payroll_period IS NOT. A segment is a
-- human's decision about somebody's pay at a moment in time; correcting it is a NEW
-- segment carrying `supersedes_id`, exactly as `service_location_version` (0043) and
-- `evv_record` (0049) correct themselves, so "what we paid" and "what we later decided
-- we should have paid" both survive (invariant 1). A `payroll_period`, by contrast, is a
-- container whose only mutable field is a three-state status that moves in place
-- (open → locked → exported); making it immutable would mean a new row per transition
-- and a unique window constraint that could no longer be stated. It carries the 0036
-- `sms_log` posture instead — no_delete rather than append_only — so rows are never
-- destroyed and the transitions stay RPC-only.
--
-- SELF-APPROVAL IS STRUCTURAL, NOT PROCEDURAL (D-027). The RPCs refuse it with a legible
-- CAREOS_SELF_APPROVAL, and `chk_approved_work_segment_no_self` refuses it again at the
-- constraint layer, where a future RPC that forgets the discipline still cannot write
-- the row. Both layers are asserted in pgTAP. The same belt-and-suspenders reasoning as
-- 0047's coordinate CHECK: the legible error is for humans, the constraint is for time.
--
-- A PAYROLL FILE IS NOT A PHI DISCLOSURE, AND THIS FILE KEEPS IT THAT WAY. The export
-- carries caregiver_id, work_date, minutes and pay_code — four fields, no client name,
-- no client id, no address, no diagnosis, no coordinate (invariant 5, D-030). A payroll
-- run tells a bookkeeper who worked how long; it has no business telling them who was
-- cared for. The canonical serialisation the content hash is taken over contains exactly
-- those four fields, so the hash proves the shape as well as the contents.
--
-- PRECEDENTS COPIED RATHER THAN REINVENTED: Lane-B definer RPCs with the gate → sanity →
-- existence → advisory lock → `for update` → state → ledger → projection → audit+outbox
-- order (0023); the seed-guarded definer audit trigger (0011); IDs-and-enums payloads
-- (0027); idempotency as a return value, never an error (0023 `assign_visit`); the
-- head-of-chain "the row nothing supersedes" query and the canonical-hash idiom (0049);
-- select-only grants on a ledger a client could otherwise forge (0048).
-- @trace: ST-208, D-024, D-027, D-030, docs/17 §3.10, §3.11, §4.7, §5, §8

-- ══ 1 · Permission catalog (docs/17 §5) ═══════════════════════════════════════════════
-- Real config, so it belongs in the migration and not the synthetic seed (the 0011
-- precedent); per-tenant role grants are wired by the seed / the 0031 identity RPCs.
-- 0045 deliberately deferred these three keys to this file, where they are enforced.
insert into public.permission (key, description) values
  ('visit.approve',  'Approve and reject the hours recorded against a visit'),
  ('payroll.read',   'Read timesheets and payroll readiness'),
  ('payroll.manage', 'Close payroll periods and export approved hours')
on conflict (key) do nothing;

-- ══ 2 · Audit emitters (definer; IDs, enums and numbers only — invariant 5) ═══════════
-- The seed guard comes first in all three: migrations and synthetic seeding run with no
-- session tenant and must never fork the per-tenant audit chain (0011).
--
-- approval_note is staff free text about a person's pay and stays OUT of the payload,
-- the same posture 0011 took with schedule_exception.note and 0044 with change_reason.
-- Its lawful home is the column on this PHI-gated, append-only, AAL2-read table.
create or replace function app.audit_approved_work_segment() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('visit.hours_' || new.decision, 'approved_work_segment', new.id,
    jsonb_build_object('visit_id', new.visit_id,
                       'caregiver_id', new.caregiver_id,   -- id only; never PHI content
                       'approved_by', new.approved_by,
                       'work_date', new.work_date,
                       'decision', new.decision,
                       'verified_minutes', new.verified_minutes,
                       'approved_minutes', new.approved_minutes,
                       'rounding_applied', new.rounding_applied,
                       'pay_code', new.pay_code,
                       'supersedes_id', new.supersedes_id));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_approved_work_segment() from public;

-- A period is two dates and a status: not PHI, and the whole row is legible in the
-- payload. `is distinct from` on the status delta so a no-op UPDATE writes nothing.
create or replace function app.audit_payroll_period() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('payroll.period_opened', 'payroll_period', new.id,
      jsonb_build_object('starts_on', new.starts_on, 'ends_on', new.ends_on,
                         'status', new.status));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform app.emit_audit('payroll.period_status_change', 'payroll_period', new.id,
        jsonb_build_object('starts_on', new.starts_on, 'ends_on', new.ends_on,
                           'from', old.status, 'to', new.status,
                           'locked_by', new.locked_by));
    end if;
  end if;
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_payroll_period() from public;

-- The export's content hash is the single most useful thing a surveyor or an auditor can
-- be shown — it proves which file left the building — and a digest is PHI-safe by
-- construction (the 0014/0015/0049 "digest, never content" posture).
create or replace function app.audit_payroll_export() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('payroll.exported', 'payroll_export', new.id,
    jsonb_build_object('period_id', new.period_id,
                       'format', new.format,
                       'row_count', new.row_count,
                       'total_minutes', new.total_minutes,
                       'content_sha256', new.content_sha256));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_payroll_export() from public;

-- ══ 3 · approved_work_segment — the human hours decision ledger ═══════ [AO] PHI ══════
-- docs/17 §3.10 shapes this table as the approval ledger. It carries one addition,
-- surfaced rather than smuggled — DN-0050a, `decision`:
--
--   §4.7 requires `app.reject_visit_hours(p_visit, p_reason)` with a MANDATORY reason,
--   and the corpus has nowhere lawful to put that reason. It cannot go in an audit
--   payload or an outbox payload (free text about a person, invariant 5) and it cannot
--   go in `visit_exception.evidence` (IDs and numbers only, 0047). Without `decision`,
--   `visit.approval_status = 'rejected'` would project NOTHING — and D-024's entire
--   claim is that each of the four axes projects an append-only ledger. So a rejection
--   is a segment too: same visit, same verified minutes, `approved_minutes = 0`,
--   `decision = 'rejected'`, and the reason in `approval_note`, which is a column on an
--   AAL2-gated PHI table rather than a payload. The export filters `decision =
--   'approved'`, so nothing about the money changes; what changes is that a refusal to
--   pay is now as durable, as attributable and as correctable as a decision to pay.
--
-- PHI by linkage, not by content: the row itself is a caregiver id, a date and two
-- integers, but visit_id points at a client's care, so it reads as PHI and takes AAL2
-- (invariant 3) — the same classification schedule_exception (0011) carries.
create table public.approved_work_segment (                           -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  -- NOT NULL where docs/17 leaves it open: an unassigned visit has nobody to pay, and
  -- a nullable caregiver would make the self-approval CHECK below only partly total.
  caregiver_id uuid not null references public.app_user(id),
  work_date date not null,
  -- The immutable fact, straight from the clock ledger with corrections folded in. It is
  -- recorded on the row (not merely derivable) so that a segment stays readable as the
  -- evidence it was: a later correction appends a new segment rather than moving this
  -- number, and the difference between the two is the audit trail.
  verified_minutes int not null check (verified_minutes >= 0),
  -- What a human actually approved. Equal to the rounded verified figure by default and
  -- free to differ when a supervisor overrides — the difference is the whole reason both
  -- columns exist, and it is exactly what a wage-and-hour review asks to see.
  approved_minutes int not null check (approved_minutes >= 0),
  -- Which rounding rule produced approved_minutes. 'manual' means a human supplied the
  -- number outright and no rule was applied — distinct from 'none', which means the
  -- policy's rule IS "do not round".
  rounding_applied text not null default 'none' check (rounding_applied in
    ('none','nearest_1','nearest_5','nearest_6','nearest_15','manual')),
  pay_code text not null default 'regular' check (pay_code in
    ('regular','overtime','holiday','training','travel','adjustment')),
  decision text not null default 'approved'
    check (decision in ('approved','rejected')),
  approval_note text,
  approved_by uuid not null references public.app_user(id),
  supersedes_id uuid references public.approved_work_segment(id),
  created_at timestamptz not null default now(),
  -- APPEND ORDER, for the same reason visit_exception_disposition (0047) carries one.
  -- The head of a supersession chain is "the segment nothing supersedes", and in ordinary
  -- operation there is exactly one — but a correction batch that supersedes and
  -- re-approves inside ONE transaction writes rows sharing an identical created_at
  -- (now() is the transaction timestamp), and the tiebreak would then fall to a random
  -- uuid. A head-of-chain decided by gen_random_uuid() is not a chain. Ordering only:
  -- never an FK target, never surfaced, and the uuid stays the identity.
  seq bigint generated always as identity,
  -- D-027 made structural. The RPCs refuse self-approval with a legible error; this is
  -- the layer that still refuses it when a future writer forgets to. Total, because
  -- caregiver_id is NOT NULL.
  constraint chk_approved_work_segment_no_self check (approved_by <> caregiver_id),
  -- A correction supersedes some OTHER segment. Self-reference would be a cycle of one
  -- and would make the head-of-chain query (the row nothing supersedes) return nothing.
  constraint chk_approved_work_segment_supersedes_other
    check (supersedes_id is distinct from id),
  -- A rejection approves nothing, and it must say why. Both halves are the reason
  -- `decision` was worth adding: without them a rejection could quietly carry minutes,
  -- or carry no explanation at all.
  constraint chk_approved_work_segment_rejection_zero
    check (decision <> 'rejected' or approved_minutes = 0),
  constraint chk_approved_work_segment_rejection_reason
    check (decision <> 'rejected' or btrim(coalesce(approval_note, '')) <> '')
);
create index idx_approved_work_segment_tenant
  on public.approved_work_segment (tenant_id, work_date desc);
create index idx_approved_work_segment_visit
  on public.approved_work_segment (visit_id, created_at desc);
-- app.compute_overtime's exact access path: one caregiver, one ISO week.
create index idx_approved_work_segment_caregiver_date
  on public.approved_work_segment (caregiver_id, work_date);
-- The export's access path: the approved rows inside a period window. Partial, because a
-- rejection is never exported and the index has no reason to carry it.
create index idx_approved_work_segment_export
  on public.approved_work_segment (tenant_id, work_date, caregiver_id)
  where decision = 'approved';
-- Supersession chains are walked head-first ("the row nothing supersedes"), which is an
-- anti-join on this column; without an index that is a sequential scan per approval.
create index idx_approved_work_segment_supersedes
  on public.approved_work_segment (supersedes_id)
  where supersedes_id is not null;

-- One line on purpose (the 0048 note): scripts/check-matrix.sh detects append-only
-- tables by grepping this exact trigger form per LINE, so a wrapped declaration would
-- make the table invisible to the gate.
create trigger trg_approved_work_segment_ao before update or delete on public.approved_work_segment
  for each row execute function app.forbid_mutation();
create trigger trg_approved_work_segment_audit after insert
  on public.approved_work_segment
  for each row execute function app.audit_approved_work_segment();

alter table public.approved_work_segment enable row level security;
alter table public.approved_work_segment force row level security;

-- Read: the caregiver whose pay it is (a worker reading their own timesheet is a
-- wage-and-hour right, not a favour), the approver surface (visit.approve) and the
-- payroll desk (payroll.read / payroll.manage). Care-team membership is deliberately NOT
-- sufficient — a nurse on the case has clinical business with this client and no
-- business with this caregiver's pay — and neither is schedule.read, because seeing the
-- roster is not seeing what people were paid. PHI by linkage ⇒ AAL2 (invariant 3).
create policy approved_work_segment_select_scoped on public.approved_work_segment
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    caregiver_id = auth.uid()
    or app.has_perm('visit.approve')
    or app.has_perm('payroll.read')
    or app.has_perm('payroll.manage')));

grant select on public.approved_work_segment to authenticated;
  -- no insert/update/delete: append-only, and stricter than the usual [AO] select+insert
  -- (the 0048 posture) — a client that could insert a segment could forge approved hours,
  -- which is forging money. app.approve_visit_hours / app.reject_visit_hours only.

-- ══ 4 · payroll_period — the container whose status moves in place ═══════════ OPS ════
-- Not append-only (see the header): open → locked → exported are transitions of one row,
-- and the unique window constraint could not be stated across a version chain. no_delete
-- instead, the 0036 sms_log posture. Not PHI: two calendar dates, a status and who
-- locked it — no client, no caregiver, no visit.
create table public.payroll_period (                                           -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open'
    check (status in ('open','locked','exported')),
  locked_by uuid references public.app_user(id),
  locked_at timestamptz,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  constraint uq_payroll_period_window unique (tenant_id, starts_on, ends_on),
  -- A one-day period is legal (a daily run); an inverted one is a data-entry accident
  -- that would silently export nothing.
  constraint chk_payroll_period_window check (ends_on >= starts_on),
  -- A locked or exported period without an attributed locker is a period nobody closed,
  -- which is the one fact the close is FOR. Unrepresentable rather than merely avoided.
  constraint chk_payroll_period_locked
    check (status = 'open' or (locked_by is not null and locked_at is not null))
);
create index idx_payroll_period_tenant on public.payroll_period (tenant_id, starts_on desc);
-- The timesheets surface asks "what is still open?" on every page load; 'open' is a
-- small minority of rows once an agency has been running for a year.
create index idx_payroll_period_open on public.payroll_period (tenant_id, starts_on desc)
  where status = 'open';

-- no_delete, not append-only: the status transitions in place, but a period is never
-- destroyed. Deliberately NOT `before update or delete` — that literal is what
-- scripts/check-matrix.sh greps to classify a table as append_only, and this table is
-- not (the manifest must not be able to lie about immutability either way).
create trigger trg_payroll_period_nodelete before delete on public.payroll_period
  for each row execute function app.forbid_mutation();
create trigger trg_payroll_period_audit after insert or update on public.payroll_period
  for each row execute function app.audit_payroll_period();

alter table public.payroll_period enable row level security;
alter table public.payroll_period force row level security;

-- No AAL2: there is no PHI here, and the `feature_flag` (0026) / `evv_adapter` (0049)
-- posture for operational config applies — permission-gated, not MFA-gated. It is still
-- narrow: only the payroll surfaces have any business reading it.
create policy payroll_period_select_scoped on public.payroll_period
  for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_perm('payroll.read') or app.has_perm('payroll.manage')));

grant select on public.payroll_period to authenticated;
  -- no insert/update/delete: the three transitions are RPC-only (§4.7), because a direct
  -- UPDATE could lock a period with unapproved hours still in it — which is precisely
  -- the check app.close_payroll_period exists to perform.

-- ══ 5 · payroll_export — the artifact that left the building ══════════ [AO] OPS ══════
-- Append-only and deliberately thin: what was exported, how many rows, how many minutes,
-- and the hash of the canonical serialisation. The rows themselves are NOT stored — they
-- are derivable from approved_work_segment at any time, and a second copy of payroll
-- data would be a second thing to protect for no gain. The hash is what makes the
-- derivation checkable: re-run the export, compare, and either the file is the file or
-- something moved (the 0049 record_sha256 idiom).
-- `exported_at` is the row's creation timestamp under its domain name, the same choice
-- visit_trust_assessment.computed_at (0048) made.
create table public.payroll_export (                                     -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  period_id uuid not null references public.payroll_period(id),
  format text not null default 'csv' check (format in ('csv')),
  row_count int not null check (row_count >= 0),
  total_minutes int not null check (total_minutes >= 0),
  content_sha256 text not null,
  exported_by uuid not null references public.app_user(id),
  exported_at timestamptz not null default now(),
  -- A hash-shaped hash, so a truncated or double-encoded digest cannot be stored and
  -- later presented as provenance (the 0049 chk_evv_record_hash precedent).
  constraint chk_payroll_export_hash check (content_sha256 ~ '^[0-9a-f]{64}$')
);
create index idx_payroll_export_tenant on public.payroll_export (tenant_id, exported_at desc);
create index idx_payroll_export_period on public.payroll_export (period_id, exported_at desc);

create trigger trg_payroll_export_ao before update or delete on public.payroll_export
  for each row execute function app.forbid_mutation();
create trigger trg_payroll_export_audit after insert on public.payroll_export
  for each row execute function app.audit_payroll_export();

alter table public.payroll_export enable row level security;
alter table public.payroll_export force row level security;

-- Same reasoning as payroll_period: counts and a digest, no PHI, permission-gated.
create policy payroll_export_select_scoped on public.payroll_export
  for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_perm('payroll.read') or app.has_perm('payroll.manage')));

grant select on public.payroll_export to authenticated;
  -- no insert/update/delete: append-only, and definer-written only — a forged export row
  -- is a forged provenance claim about a file that moved money.

-- ══ 6 · app.round_minutes — rounding is a policy choice, stated once ══════════════════
-- ROUNDING IS THE MOST CONSEQUENTIAL ARITHMETIC IN THIS FILE and it is therefore
-- deterministic, pure, and inspectable — never inferred, never a model's judgement
-- (invariant 13). The grain is what the policy literally says it is:
--   nearest_1   whole minutes (identity: the ledger is already whole minutes)
--   nearest_5   five-minute increments
--   nearest_6   TENTHS OF AN HOUR — six minutes, the common agency payroll grain
--   nearest_15  QUARTER HOURS — fifteen minutes
--   none        no rounding at all
-- Half rounds AWAY FROM ZERO (a 7.5-minute remainder at nearest_15 rounds up), which is
-- the conventional wage-and-hour reading and, on non-negative minutes, is plain half-up.
--
-- The ::numeric cast is load-bearing, not decoration: round(double precision) is
-- BANKER'S rounding in Postgres (round(2.5::float8) = 2), so a float path would round
-- half of all boundary cases DOWN and quietly shave paid minutes off half the timesheets
-- in the agency. round(numeric) is half-away-from-zero. This is the kind of defect that
-- is invisible in every test that does not sit exactly on a boundary, so the pgTAP file
-- probes the boundaries specifically.
create or replace function app.round_minutes(p_minutes int, p_policy text) returns int
language sql immutable set search_path = public as $$
  select case
    when p_minutes is null       then null
    when p_policy = 'nearest_5'  then (round(p_minutes::numeric /  5) *  5)::int
    when p_policy = 'nearest_6'  then (round(p_minutes::numeric /  6) *  6)::int
    when p_policy = 'nearest_15' then (round(p_minutes::numeric / 15) * 15)::int
    else p_minutes            -- 'none' and 'nearest_1' are both identity on whole minutes
  end
$$;
-- Internal plumbing: reachable from the definer bodies below and from pgTAP (which runs
-- as the owner), never from a client lane. There is no request path that needs to round
-- a number without also needing the visit it came from.
revoke all on function app.round_minutes(int, text) from public, anon, authenticated;

-- ══ 7 · app.compute_visit_minutes — the deterministic clock arithmetic (§4.7) ═════════
-- One visit, five numbers, no opinions. Everything is derived from the append-only clock
-- ledger with 0047 CORRECTIONS FOLDED IN (the 0049 build_evv_record idiom): a corrected
-- clock time is the fact, and payroll must read the corrected fact rather than the
-- superseded one. public.verified_visit (0045) deliberately does NOT fold corrections in
-- — it reports the literal ledger — so the two differ on a corrected visit, on purpose,
-- and this is the one that feeds money.
--
-- Minutes are WHOLE MINUTES, FLOORED, matching 0045: a visit worked 125 seconds short of
-- two hours is 119 minutes, because the conservative direction is the one that survives
-- a wage-and-hour challenge and rounding up silently invents paid time. Any rounding the
-- policy asks for is applied ON TOP, by app.round_minutes, and both figures are
-- returned so the subtraction stays visible.
--
-- verified_minutes is NOT clamped at zero here (0045's reasoning): a clock-out that
-- precedes its clock-in is an incoherent ledger and a negative number says so. The
-- approval RPC refuses such a visit outright rather than laundering it into hours.
--
-- Visibility: this returns numbers about one visit, so it is gated on being able to SEE
-- that visit — the caregiver themself, an approver, the payroll desk, or a schedule
-- reader. It is definer only so that the ledger walk does not depend on the caller's
-- visit_event RLS (a co-worker's correction on your visit is still your minutes).
create or replace function app.compute_visit_minutes(p_visit uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant       uuid := app.current_tenant_id();
  v_caregiver    uuid;
  v_sched_start  timestamptz;
  v_sched_end    timestamptz;
  v_policy_id    uuid;
  v_policy       public.visit_policy;
  v_rounding     text;
  v_start        timestamptz;
  v_end          timestamptz;
  v_sched_min    int;
  v_verified_min int;
  v_late_min     int;
  v_overrun_min  int;
  v_rounded_min  int;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to read visit hours'
      using errcode = '42501';
  end if;

  select v.caregiver_id, v.scheduled_start, v.scheduled_end, v.policy_id
    into v_caregiver, v_sched_start, v_sched_end, v_policy_id
    from public.visit v
   where v.id = p_visit and v.tenant_id = v_tenant;
  if v_sched_start is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;

  if not (v_caregiver = auth.uid()
          or app.has_perm('visit.approve')
          or app.has_perm('payroll.read')
          or app.has_perm('payroll.manage')
          or app.has_perm('schedule.read')) then
    raise exception 'CAREOS_FORBIDDEN: these hours are not yours to read'
      using errcode = '42501';
  end if;

  -- Effective clock times: the latest correction of an event wins, else the event
  -- itself. Earliest clock-in and latest clock-out bound the visit — a caregiver who
  -- taps twice has one arrival, and the last departure is the one that ended the work.
  with clock as (
    select e.event_type,
           coalesce(
             (select c.occurred_at
                from public.visit_event c
               where c.corrects_event_id = e.id
               order by c.occurred_at desc, c.created_at desc
               limit 1),
             e.occurred_at) as effective_at
      from public.visit_event e
     where e.visit_id = p_visit and e.tenant_id = v_tenant
       and e.event_type in ('clock_in','clock_out'))
  select min(effective_at) filter (where event_type = 'clock_in'),
         max(effective_at) filter (where event_type = 'clock_out')
    into v_start, v_end
    from clock;

  v_sched_min := floor(extract(epoch from (v_sched_end - v_sched_start)) / 60)::int;
  if v_start is not null and v_end is not null then
    v_verified_min := floor(extract(epoch from (v_end - v_start)) / 60)::int;
  end if;
  -- NULL, never 0, when the corresponding event is missing. The explicit CASE is
  -- mandatory: greatest() IGNORES nulls, so greatest(null, 0) is 0 — which would report
  -- a visit nobody ever showed up for as "on time" (0045's most expensive silent bug).
  if v_start is not null then
    v_late_min := greatest(
      floor(extract(epoch from (v_start - v_sched_start)) / 60), 0)::int;
  end if;
  if v_end is not null then
    v_overrun_min := greatest(
      floor(extract(epoch from (v_end - v_sched_end)) / 60), 0)::int;
  end if;

  -- The BOUND policy governs (D-014): a visit is measured against the rules it was
  -- verified under, so loosening a rounding rule tomorrow cannot restate yesterday's
  -- hours. Only a visit that was never clocked has no binding, and then the currently
  -- resolved policy is the honest answer.
  if v_policy_id is not null then
    select vp.rounding_policy into v_rounding
      from public.visit_policy vp where vp.id = v_policy_id;
  end if;
  if v_rounding is null then
    v_policy := app.visit_policy_for(p_visit);      -- raises CAREOS_POLICY_MISSING (§4.2)
    v_rounding := v_policy.rounding_policy;
  end if;
  v_rounded_min := app.round_minutes(v_verified_min, v_rounding);

  return jsonb_build_object(
    'ok',                true,
    'visit_id',          p_visit,
    'caregiver_id',      v_caregiver,
    'actual_start',      v_start,
    'actual_end',        v_end,
    'scheduled_minutes', v_sched_min,
    'verified_minutes',  v_verified_min,
    'late_minutes',      v_late_min,
    'overrun_minutes',   v_overrun_min,
    'rounding_policy',   v_rounding,
    'rounded_minutes',   v_rounded_min,
    'policy_id',         v_policy_id);
end $$;

-- ══ 8 · app.approve_visit_hours — the last human judgement in the chain (§4.7) ════════
-- Three refusals are pinned by docs/17 §4.7 and two more are added by this file because
-- the ledger can be in states the contract did not enumerate (DN-0050c):
--   CAREOS_BAD_STATE          the visit is not 'completed' — nothing was delivered yet
--   CAREOS_APPROVAL_BLOCKED   an OPEN 'critical' exception is on the visit
--   CAREOS_SELF_APPROVAL      the actor is the caregiver (also a CHECK, see §3)
--   CAREOS_NO_HOURS           no clock-in/clock-out pair — correct it, don't approve it
--   CAREOS_INCOHERENT_LEDGER  clock-out precedes clock-in — a negative shift is not pay
-- Approving is a HUMAN act (D-020): an agent principal holding visit.approve is refused,
-- the same gate app.dispose_visit_exception (0047) applies.
create or replace function app.approve_visit_hours(
  p_visit uuid, p_approved_minutes int default null,
  p_pay_code text default 'regular', p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant         uuid := app.current_tenant_id();
  v_caregiver      uuid;
  v_client         uuid;
  v_status         text;
  v_payroll        text;
  v_blocking       int;
  v_minutes        jsonb;
  v_verified       int;
  v_rounded        int;
  v_rounding       text;
  v_actual_start   timestamptz;
  v_work_date      date;
  v_approved       int;
  v_applied        text;
  v_prior_id       uuid;
  v_prior_minutes  int;
  v_prior_pay      text;
  v_prior_decision text;
  v_segment_id     uuid;
begin
  -- 1 · Gate.
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to approve hours'
      using errcode = '42501';
  end if;
  if not app.has_perm('visit.approve') then
    raise exception 'CAREOS_FORBIDDEN: visit.approve is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                  where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: hours are approved by people — agents only propose'
      using errcode = '42501';
  end if;

  -- 2 · Input sanity.
  if p_pay_code not in
     ('regular','overtime','holiday','training','travel','adjustment') then
    raise exception 'CAREOS_BAD_PAY_CODE: % is not a pay code', p_pay_code
      using errcode = 'P0001';
  end if;
  if p_approved_minutes is not null and p_approved_minutes < 0 then
    raise exception 'CAREOS_BAD_MINUTES: approved minutes cannot be negative'
      using errcode = 'P0001';
  end if;

  -- 3 · Existence, inside the caller's tenant.
  select v.caregiver_id, v.client_id, v.status
    into v_caregiver, v_client, v_status
    from public.visit v
   where v.id = p_visit and v.tenant_id = v_tenant;
  if v_status is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v_caregiver is null then
    raise exception 'CAREOS_BAD_STATE: an unassigned visit has nobody to pay'
      using errcode = 'P0001';
  end if;

  -- 4 · D-027: self-approval is structurally impossible. Checked before any lock so the
  --     refusal is cheap and unambiguous; the CHECK constraint refuses it again.
  if v_caregiver = auth.uid() then
    raise exception
      'CAREOS_SELF_APPROVAL: a caregiver cannot approve or reject their own hours'
      using errcode = '42501';
  end if;

  -- 5 · Serialize every payroll act on this visit, so two approvals cannot both append
  --     against the same antecedent and fork the supersession chain (the 0049 posture).
  perform pg_advisory_xact_lock(hashtextextended('careos_payroll:' || p_visit::text, 0));
  select v.status, v.payroll_status into v_status, v_payroll
    from public.visit v where v.id = p_visit for update;

  -- 6 · State: only delivered work has hours to approve.
  if v_status <> 'completed' then
    raise exception
      'CAREOS_BAD_STATE: only a completed visit can have its hours approved (is %)',
      v_status using errcode = 'P0001';
  end if;

  -- 7 · An OPEN critical finding blocks approval (§4.7). Read through
  --     public.visit_exception_state so "open" means exactly what 0047 defined it to
  --     mean — no disposition yet, or the latest one reopened it — rather than a second
  --     copy of that rule drifting here. The view is security_invoker, which inside this
  --     definer body evaluates as the owner: the block must consider EVERY critical
  --     finding on the visit, including ones this approver cannot personally read.
  select count(*)::int into v_blocking
    from public.visit_exception_state s
   where s.visit_id = p_visit and s.tenant_id = v_tenant
     and s.severity = 'critical' and s.open;
  if v_blocking > 0 then
    raise exception
      'CAREOS_APPROVAL_BLOCKED: % unresolved critical exception(s) on this visit',
      v_blocking using errcode = 'P0001';
  end if;

  -- 8 · The arithmetic (§7). Deterministic, and the same function the timesheet surface
  --     shows the approver before they press the button.
  v_minutes      := app.compute_visit_minutes(p_visit);
  v_verified     := (v_minutes ->> 'verified_minutes')::int;
  v_rounded      := (v_minutes ->> 'rounded_minutes')::int;
  v_rounding     :=  v_minutes ->> 'rounding_policy';
  v_actual_start := (v_minutes ->> 'actual_start')::timestamptz;
  if v_verified is null then
    raise exception
      'CAREOS_NO_HOURS: the visit has no clock-in and clock-out pair to approve'
      using errcode = 'P0001';
  end if;
  if v_verified < 0 then
    raise exception
      'CAREOS_INCOHERENT_LEDGER: the clock-out precedes the clock-in — correct it first'
      using errcode = 'P0001';
  end if;

  -- Calendar date of the work, pinned to UTC so the same visit lands on the same day on
  -- every machine. There is no agency-timezone column on public.tenant today; when one
  -- lands this becomes a one-line change and a correction appends a new segment. Flagged
  -- in the ST-208 result rather than silently assumed (the 0049 precedent).
  v_work_date := (v_actual_start at time zone 'UTC')::date;
  v_approved  := coalesce(p_approved_minutes, v_rounded, v_verified);
  v_applied   := case when p_approved_minutes is null then v_rounding else 'manual' end;

  -- 9 · Head of chain: the segment nothing supersedes. Idempotency is a RETURN VALUE,
  --     never an error (the 0023 assign_visit posture) — a double-submitted approval of
  --     the same minutes under the same pay code is the same approval, not a second one.
  select s.id, s.approved_minutes, s.pay_code, s.decision
    into v_prior_id, v_prior_minutes, v_prior_pay, v_prior_decision
    from public.approved_work_segment s
   where s.visit_id = p_visit and s.tenant_id = v_tenant
     and not exists (select 1 from public.approved_work_segment t
                      where t.supersedes_id = s.id)
   order by s.created_at desc, s.seq desc      -- seq, not id: see the column's note
   limit 1;
  if v_prior_decision = 'approved'
     and v_prior_minutes = v_approved and v_prior_pay = p_pay_code then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'visit_id', p_visit,
                              'segment_id', v_prior_id,
                              'approved_minutes', v_prior_minutes,
                              'pay_code', v_prior_pay);
  end if;

  -- 10 · Append (never update — invariant 1). The audit row rides the insert trigger.
  insert into public.approved_work_segment
    (tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
     rounding_applied, pay_code, decision, approval_note, approved_by, supersedes_id)
  values
    (v_tenant, p_visit, v_caregiver, v_work_date, v_verified, v_approved,
     v_applied, p_pay_code, 'approved', p_note, auth.uid(), v_prior_id)
  returning id into v_segment_id;

  -- 11 · Project onto the two axes this act moves (D-024). payroll_status returns to
  --      'ready' even from 'exported': a correction after an export IS a payroll delta
  --      and belongs back in the queue, where the next export picks it up and produces a
  --      new content hash. row_version is deliberately not bumped — it is the scheduling
  --      surface's optimistic-concurrency token, and a back-office projection consuming
  --      it would manufacture keep-both conflicts out of nothing (the 0049 reasoning).
  update public.visit
     set approval_status = 'approved',
         payroll_status  = 'ready',
         updated_at      = now()
   where id = p_visit;

  -- 12 · Outbox (invariant 7, §8). IDs, enums and integers — consumers refetch under RLS.
  perform app.emit_event('visit.hours.approved', 'visit', p_visit,
    jsonb_build_object('visit_id', p_visit,
                       'segment_id', v_segment_id,
                       'caregiver_id', v_caregiver,
                       'client_id', v_client,
                       'work_date', v_work_date,
                       'approved_minutes', v_approved,
                       'pay_code', p_pay_code,
                       'supersedes_id', v_prior_id));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'visit_id', p_visit,
                            'segment_id', v_segment_id,
                            'work_date', v_work_date,
                            'verified_minutes', v_verified,
                            'approved_minutes', v_approved,
                            'rounding_applied', v_applied,
                            'pay_code', p_pay_code,
                            'supersedes_id', v_prior_id,
                            'approval_status', 'approved',
                            'payroll_status', 'ready');
end $$;

-- ══ 9 · app.reject_visit_hours — a refusal to pay is a record too (§4.7) ══════════════
-- The reason is MANDATORY and durable: it lands in approved_work_segment.approval_note,
-- which is a column on an AAL2-gated PHI table — not an audit payload and not exception
-- evidence, both of which are IDs and enums only (invariant 5). See DN-0050a in §3.
--
-- NO EXCEPTION IS RAISED HERE, deliberately. app.raise_visit_exception_internal (0047)
-- sets visit.verification_status = 'exception' as a side effect, and a rejected TIMESHEET
-- says nothing about whether the LOCATION evidence held up. Flipping the verification
-- axis from an approval-axis act is exactly the coupling D-024 exists to prevent — the
-- four axes are orthogonal or they are not four axes. The rejection reaches the queue as
-- an approval_status projection and an outbox event instead.
create or replace function app.reject_visit_hours(p_visit uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant         uuid := app.current_tenant_id();
  v_caregiver      uuid;
  v_client         uuid;
  v_status         text;
  v_minutes        jsonb;
  v_verified       int;
  v_actual_start   timestamptz;
  v_sched_start    timestamptz;
  v_work_date      date;
  v_prior_id       uuid;
  v_prior_decision text;
  v_segment_id     uuid;
begin
  -- 1 · Gate — identical to approval: rejecting somebody's hours is as consequential as
  --     approving them, and it is equally a human act (D-020).
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to reject hours'
      using errcode = '42501';
  end if;
  if not app.has_perm('visit.approve') then
    raise exception 'CAREOS_FORBIDDEN: visit.approve is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                  where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: hours are ruled on by people — agents only propose'
      using errcode = '42501';
  end if;

  -- 2 · Input sanity: the reason is the entire point of this RPC.
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a rejection needs a reason'
      using errcode = 'P0001';
  end if;

  -- 3 · Existence.
  select v.caregiver_id, v.client_id, v.status, v.scheduled_start
    into v_caregiver, v_client, v_status, v_sched_start
    from public.visit v
   where v.id = p_visit and v.tenant_id = v_tenant;
  if v_status is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v_caregiver is null then
    raise exception 'CAREOS_BAD_STATE: an unassigned visit has no hours to rule on'
      using errcode = 'P0001';
  end if;

  -- 4 · Self-action is barred on this side too. A caregiver declining their own pay is
  --     not the fraud vector D-027 names, but the segment a rejection writes carries
  --     approved_by, and chk_approved_work_segment_no_self would refuse it as a raw
  --     constraint violation. One legible error beats a 23514 (same code as approval:
  --     the rule is "nobody rules on their own hours", stated once).
  if v_caregiver = auth.uid() then
    raise exception
      'CAREOS_SELF_APPROVAL: a caregiver cannot approve or reject their own hours'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('careos_payroll:' || p_visit::text, 0));
  select v.status into v_status from public.visit v where v.id = p_visit for update;

  -- 5 · State.
  if v_status <> 'completed' then
    raise exception
      'CAREOS_BAD_STATE: only a completed visit can have its hours rejected (is %)',
      v_status using errcode = 'P0001';
  end if;

  -- 6 · The arithmetic, best-effort. A rejection must be recordable PRECISELY when the
  --     ledger is broken — a missing clock-out is the single most common reason to send
  --     a timesheet back — so unlike approval this path does not refuse on a missing or
  --     negative interval. verified_minutes is clamped to 0 in those cases (the column
  --     is NOT NULL >= 0 by §3.10); the authoritative figure stays derivable from the
  --     ledger through app.compute_visit_minutes, which reports null and negative
  --     honestly. The segment's copy is a snapshot a rejection cannot always take.
  v_minutes      := app.compute_visit_minutes(p_visit);
  v_verified     := greatest(coalesce((v_minutes ->> 'verified_minutes')::int, 0), 0);
  v_actual_start := (v_minutes ->> 'actual_start')::timestamptz;
  v_work_date    := (coalesce(v_actual_start, v_sched_start) at time zone 'UTC')::date;

  -- 7 · Idempotency as a return value: a double-submitted rejection is one rejection.
  select s.id, s.decision into v_prior_id, v_prior_decision
    from public.approved_work_segment s
   where s.visit_id = p_visit and s.tenant_id = v_tenant
     and not exists (select 1 from public.approved_work_segment t
                      where t.supersedes_id = s.id)
   order by s.created_at desc, s.seq desc      -- seq, not id: see the column's note
   limit 1;
  if v_prior_decision = 'rejected' then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'visit_id', p_visit, 'segment_id', v_prior_id,
                              'decision', 'rejected');
  end if;

  -- 8 · Append. approved_minutes = 0 and decision = 'rejected' are both enforced by
  --     chk_approved_work_segment_rejection_zero, so the export can never pick this up.
  insert into public.approved_work_segment
    (tenant_id, visit_id, caregiver_id, work_date, verified_minutes, approved_minutes,
     rounding_applied, pay_code, decision, approval_note, approved_by, supersedes_id)
  values
    (v_tenant, p_visit, v_caregiver, v_work_date, v_verified, 0,
     'none', 'regular', 'rejected', p_reason, auth.uid(), v_prior_id)
  returning id into v_segment_id;

  -- 9 · Project. 'not_ready' is the honest payroll state for work nobody will pay for
  --     until it is fixed, including a visit that had already been exported.
  update public.visit
     set approval_status = 'rejected',
         payroll_status  = 'not_ready',
         updated_at      = now()
   where id = p_visit;

  -- 10 · Outbox. The reason is NOT carried — it is free text about a person's work, and
  --      consumers refetch it under their own RLS from the segment (invariant 5).
  perform app.emit_event('visit.hours.rejected', 'visit', p_visit,
    jsonb_build_object('visit_id', p_visit,
                       'segment_id', v_segment_id,
                       'caregiver_id', v_caregiver,
                       'client_id', v_client,
                       'work_date', v_work_date,
                       'verified_minutes', v_verified,
                       'supersedes_id', v_prior_id));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'visit_id', p_visit,
                            'segment_id', v_segment_id,
                            'work_date', v_work_date,
                            'verified_minutes', v_verified,
                            'decision', 'rejected',
                            'approval_status', 'rejected',
                            'payroll_status', 'not_ready');
end $$;

-- ══ 10 · app.compute_overtime — money is never an LLM judgement (§4.7) ════════════════
-- INVARIANT 13, stated as plainly as it can be stated: this is a SUM and a COMPARISON.
-- Overtime is one of the few numbers in the product where being approximately right is
-- indistinguishable from being wrong, and a caregiver disputing it is entitled to an
-- arithmetic answer they can reproduce on paper — the same promise D-028 makes about the
-- trust score. No model reads these hours and none writes them.
--
-- THE WEEK IS THE ISO WEEK. p_week_start is normalised to the Monday of whatever ISO
-- week it falls in, so a caller passing a Wednesday gets that week rather than a
-- seven-day window starting Wednesday — two different questions with the same shape, and
-- only one of them is what a timesheet means.
--
-- THE THRESHOLD COMES FROM THE TENANT-SCOPE POLICY ROW, not from the per-visit
-- resolution ladder (§4.2). Overtime is a property of the EMPLOYMENT relationship: a
-- caregiver's week does not belong to one client or one service type, so there is no
-- client rung to inherit from. The tenant rung is the floor 0044 guarantees exists, and
-- its absence is CAREOS_POLICY_MISSING rather than a silently assumed 40 hours.
create or replace function app.compute_overtime(p_caregiver uuid, p_week_start date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant    uuid := app.current_tenant_id();
  v_start     date;
  v_end       date;
  v_threshold int;
  v_total     int := 0;
  v_segments  int := 0;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to read worked hours'
      using errcode = '42501';
  end if;
  -- A caregiver may always compute their own week; anybody else needs the payroll desk.
  if not (p_caregiver = auth.uid()
          or app.has_perm('payroll.read')
          or app.has_perm('payroll.manage')) then
    raise exception 'CAREOS_FORBIDDEN: payroll.read is required' using errcode = '42501';
  end if;
  if p_week_start is null then
    raise exception 'CAREOS_BAD_WINDOW: a week needs a start date' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.app_user u
                  where u.id = p_caregiver and u.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: caregiver' using errcode = 'P0001';
  end if;

  v_start := (date_trunc('week', p_week_start::timestamp))::date;   -- ISO Monday
  v_end   := v_start + 6;

  select vp.overtime_weekly_minutes into v_threshold
    from public.visit_policy vp
   where vp.tenant_id = v_tenant and vp.scope_kind = 'tenant'
     and vp.effective_from <= now()
     and (vp.effective_until is null or vp.effective_until > now())
   order by vp.version_no desc, vp.created_at desc
   limit 1;
  if v_threshold is null then
    raise exception
      'CAREOS_POLICY_MISSING: this tenant has no visit policy to read an overtime ceiling from'
      using errcode = 'P0001';
  end if;

  -- Head-of-chain segments only: a superseded segment is what we USED to think, and
  -- counting it would pay the same hour twice. Rejections carry approved_minutes = 0 by
  -- constraint, and are excluded explicitly so the segment count is honest too.
  select coalesce(sum(s.approved_minutes), 0)::int, count(*)::int
    into v_total, v_segments
    from public.approved_work_segment s
   where s.tenant_id = v_tenant
     and s.caregiver_id = p_caregiver
     and s.decision = 'approved'
     and s.work_date between v_start and v_end
     and not exists (select 1 from public.approved_work_segment t
                      where t.supersedes_id = s.id);

  return jsonb_build_object(
    'ok',                     true,
    'caregiver_id',           p_caregiver,
    'week_start',             v_start,
    'week_end',               v_end,
    'total_minutes',          v_total,
    'regular_minutes',        least(v_total, v_threshold),
    'overtime_minutes',       greatest(v_total - v_threshold, 0),
    'overtime_weekly_minutes', v_threshold,
    'segment_count',          v_segments);
end $$;

-- ══ 11 · app.open_payroll_period — the container has to come from somewhere ═══════════
-- DN-0050b: docs/17 §4.7 pins close and export but no opener, and the table carries no
-- write grants (the 0023/0043/0044 Lane-B perimeter), so without this RPC a period could
-- only be created by a seed and the two functions the contract DOES pin would have
-- nothing to act on. Minimal, same gate as close, and surfaced in the ST-208 result.
create or replace function app.open_payroll_period(p_starts_on date, p_ends_on date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := app.current_tenant_id();
  v_id       uuid;
  v_status   text;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to open a payroll period'
      using errcode = '42501';
  end if;
  if not app.has_perm('payroll.manage') then
    raise exception 'CAREOS_FORBIDDEN: payroll.manage is required' using errcode = '42501';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'CAREOS_BAD_WINDOW: a period must end on or after it starts'
      using errcode = 'P0001';
  end if;

  -- Idempotent by window (the 0023 posture): re-opening the same fortnight returns the
  -- period that already covers it rather than colliding with uq_payroll_period_window.
  select p.id, p.status into v_id, v_status
    from public.payroll_period p
   where p.tenant_id = v_tenant and p.starts_on = p_starts_on and p.ends_on = p_ends_on;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'period_id', v_id, 'status', v_status);
  end if;

  insert into public.payroll_period (tenant_id, starts_on, ends_on, created_by)
  values (v_tenant, p_starts_on, p_ends_on, auth.uid())
  returning id into v_id;

  perform app.emit_event('payroll.period.opened', 'payroll_period', v_id,
    jsonb_build_object('starts_on', p_starts_on, 'ends_on', p_ends_on, 'status', 'open'));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'period_id', v_id, 'status', 'open',
                            'starts_on', p_starts_on, 'ends_on', p_ends_on);
end $$;

-- ══ 12 · app.close_payroll_period — the readiness gate (§4.7) ═════════════════════════
-- Refuses while any delivered visit in the window still waits on a human, and SAYS HOW
-- MANY: "3 visits are still waiting on approval" is an instruction, where "period not
-- ready" is a riddle (docs/10 voice — what happened, what to do next).
--
-- MEMBERSHIP IS BY SCHEDULED DATE, not by worked date, and the asymmetry is deliberate:
-- a visit that was never clocked has no worked date at all, and those are exactly the
-- visits that must block a close. The export, by contrast, reads approved segments,
-- which always have a worked date. The residual artifact — a visit scheduled late on the
-- last day whose work crosses midnight UTC exports into the next period — is the same
-- missing agency-timezone column 0049 flagged, and it moves with that column.
create or replace function app.close_payroll_period(p_period uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := app.current_tenant_id();
  v_starts   date;
  v_ends     date;
  v_status   text;
  v_pending  int;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to close a payroll period'
      using errcode = '42501';
  end if;
  if not app.has_perm('payroll.manage') then
    raise exception 'CAREOS_FORBIDDEN: payroll.manage is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                  where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: a payroll period is closed by a person'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('careos_period:' || p_period::text, 0));
  select p.starts_on, p.ends_on, p.status
    into v_starts, v_ends, v_status
    from public.payroll_period p
   where p.id = p_period and p.tenant_id = v_tenant
   for update;
  if v_status is null then
    raise exception 'CAREOS_NOT_FOUND: payroll period' using errcode = 'P0001';
  end if;
  -- Idempotency is a return value: closing a closed period is the same close.
  if v_status = 'locked' then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'period_id', p_period, 'status', 'locked');
  end if;
  if v_status = 'exported' then
    raise exception
      'CAREOS_BAD_STATE: this period has already been exported and cannot be reclosed'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_pending
    from public.visit v
   where v.tenant_id = v_tenant
     and v.status = 'completed'
     and v.approval_status = 'pending'
     and (v.scheduled_start at time zone 'UTC')::date between v_starts and v_ends;
  if v_pending > 0 then
    raise exception
      'CAREOS_PERIOD_NOT_READY: % completed visit(s) are still waiting on approval',
      v_pending using errcode = 'P0001';
  end if;

  update public.payroll_period
     set status = 'locked', locked_by = auth.uid(), locked_at = now(),
         updated_at = now(), row_version = row_version + 1
   where id = p_period;

  -- The status delta rides trg_payroll_period_audit; the outbox is explicit because
  -- there is no period event trigger and Phase-2 consumers rank on this event (§8).
  perform app.emit_event('payroll.period.closed', 'payroll_period', p_period,
    jsonb_build_object('starts_on', v_starts, 'ends_on', v_ends, 'status', 'locked'));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'period_id', p_period, 'status', 'locked',
                            'starts_on', v_starts, 'ends_on', v_ends,
                            'pending_visits', 0);
end $$;

-- ══ 13 · app.export_payroll_period — four columns and a hash (§4.7) ═══════════════════
-- THE EXPORT CONTAINS caregiver_id, work_date, minutes, pay_code. NOTHING ELSE.
-- No client name, no client id, no address, no service type, no diagnosis, no note, no
-- coordinate. A payroll file tells a bookkeeper who worked how long; it has no business
-- telling them who was cared for, and a payroll run is therefore NOT a PHI disclosure —
-- which is only true because this function keeps it that way (invariant 5, D-030). The
-- caregiver_id is workforce PII the payer already holds by definition.
--
-- The content hash is taken over a canonical serialisation of exactly those four fields:
-- one line per row, fields as `key=value` in a fixed order, rows sorted by
-- (caregiver, date, pay_code). It therefore depends on what the file ASSERTS and on
-- nothing else — not on row ids, not on export time, not on the order the planner
-- happened to emit. Re-running the export over unchanged data reproduces the hash, which
-- is what makes "is this the file we sent?" an answerable question (the 0049 idiom).
--
-- Rows are aggregated per (caregiver, date, pay_code): two visits by one caregiver on
-- one day at one pay code are one payroll line, which is the shape every payroll system
-- consumes. The per-visit detail stays in approved_work_segment for anyone who asks.
create or replace function app.export_payroll_period(p_period uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant     uuid := app.current_tenant_id();
  v_starts     date;
  v_ends       date;
  v_status     text;
  v_rows       jsonb;
  v_canonical  text;
  v_sha        text;
  v_row_count  int;
  v_total      int;
  v_prior_sha  text;
  v_prior_id   uuid;
  v_export_id  uuid;
begin
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to export payroll'
      using errcode = '42501';
  end if;
  if not app.has_perm('payroll.manage') then
    raise exception 'CAREOS_FORBIDDEN: payroll.manage is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                  where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: a payroll export is authorised by a person'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('careos_period:' || p_period::text, 0));
  select p.starts_on, p.ends_on, p.status
    into v_starts, v_ends, v_status
    from public.payroll_period p
   where p.id = p_period and p.tenant_id = v_tenant
   for update;
  if v_status is null then
    raise exception 'CAREOS_NOT_FOUND: payroll period' using errcode = 'P0001';
  end if;
  -- An open period has not been checked for unapproved hours yet, so exporting it would
  -- ship a file that is missing work somebody did. Close it first — that is the gate.
  if v_status = 'open' then
    raise exception
      'CAREOS_BAD_STATE: close the period before exporting it (is %)', v_status
      using errcode = 'P0001';
  end if;

  -- The four columns, aggregated and ordered deterministically. Head-of-chain segments
  -- only (a superseded segment is a decision we replaced), approved only.
  with line as (
    select s.caregiver_id,
           s.work_date,
           s.pay_code,
           sum(s.approved_minutes)::int as minutes
      from public.approved_work_segment s
     where s.tenant_id = v_tenant
       and s.decision = 'approved'
       and s.work_date between v_starts and v_ends
       and not exists (select 1 from public.approved_work_segment t
                        where t.supersedes_id = s.id)
     group by s.caregiver_id, s.work_date, s.pay_code)
  select coalesce(jsonb_agg(jsonb_build_object(
             'caregiver_id', l.caregiver_id,
             'work_date',    l.work_date,
             'minutes',      l.minutes,
             'pay_code',     l.pay_code)
           order by l.caregiver_id, l.work_date, l.pay_code), '[]'::jsonb),
         coalesce(string_agg(
             'caregiver=' || l.caregiver_id::text
          || '|work_date=' || to_char(l.work_date, 'YYYY-MM-DD')
          || '|minutes='   || l.minutes::text
          || '|pay_code='  || l.pay_code,
             E'\n' order by l.caregiver_id, l.work_date, l.pay_code), ''),
         count(*)::int,
         coalesce(sum(l.minutes), 0)::int
    into v_rows, v_canonical, v_row_count, v_total
    from line l;

  v_sha := encode(extensions.digest(convert_to(v_canonical, 'utf8'), 'sha256'), 'hex');

  -- Idempotency as a return value: re-exporting a period nothing has changed in returns
  -- the export that already exists rather than appending an identical artifact to a
  -- ledger a surveyor has to read. A CORRECTION moves the hash, and then a new row is
  -- exactly what should be written.
  select e.id, e.content_sha256 into v_prior_id, v_prior_sha
    from public.payroll_export e
   where e.period_id = p_period and e.tenant_id = v_tenant
   order by e.exported_at desc
   limit 1;
  if v_prior_sha = v_sha then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'period_id', p_period,
                              'export_id', v_prior_id,
                              'content_sha256', v_sha,
                              'row_count', v_row_count,
                              'total_minutes', v_total,
                              'rows', v_rows);
  end if;

  insert into public.payroll_export
    (tenant_id, period_id, format, row_count, total_minutes, content_sha256, exported_by)
  values
    (v_tenant, p_period, 'csv', v_row_count, v_total, v_sha, auth.uid())
  returning id into v_export_id;

  update public.payroll_period
     set status = 'exported', updated_at = now(), row_version = row_version + 1
   where id = p_period and status <> 'exported';

  -- Axis 3 closes (D-024): the work in this window has left for payroll. Only 'ready'
  -- rows move — a visit still pending or rejected was never in the file.
  update public.visit v
     set payroll_status = 'exported', updated_at = now()
   where v.tenant_id = v_tenant
     and v.payroll_status = 'ready'
     and exists (select 1 from public.approved_work_segment s
                  where s.visit_id = v.id and s.decision = 'approved'
                    and s.work_date between v_starts and v_ends
                    and not exists (select 1 from public.approved_work_segment t
                                     where t.supersedes_id = s.id));

  -- Outbox (§8). Counts and a digest — never the rows, which consumers refetch under
  -- their own RLS if they are entitled to them (invariant 5).
  perform app.emit_event('payroll.exported', 'payroll_export', v_export_id,
    jsonb_build_object('period_id', p_period,
                       'row_count', v_row_count,
                       'total_minutes', v_total,
                       'content_sha256', v_sha));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'period_id', p_period,
                            'export_id', v_export_id,
                            'format', 'csv',
                            'row_count', v_row_count,
                            'total_minutes', v_total,
                            'content_sha256', v_sha,
                            'status', 'exported',
                            'rows', v_rows);
end $$;

-- ══ 14 · Grants — the Lane-B catalog in, everything else out ══════════════════════════
-- Belt-and-suspenders against the default PUBLIC execute grant on new functions
-- (0001/0007), and the paired revoke/grant form every migration since 0011 uses.
-- service_role appears nowhere: none of these is a worker lane, and invariant 6 keeps it
-- out of every request path.
revoke all on function
  app.compute_visit_minutes(uuid),
  app.compute_overtime(uuid, date),
  app.approve_visit_hours(uuid, int, text, text),
  app.reject_visit_hours(uuid, text),
  app.open_payroll_period(date, date),
  app.close_payroll_period(uuid),
  app.export_payroll_period(uuid)
from public, anon;
grant execute on function
  app.compute_visit_minutes(uuid),
  app.compute_overtime(uuid, date),
  app.approve_visit_hours(uuid, int, text, text),
  app.reject_visit_hours(uuid, text),
  app.open_payroll_period(date, date),
  app.close_payroll_period(uuid),
  app.export_payroll_period(uuid)
to authenticated;
