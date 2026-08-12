-- CareOS E2E — arrange the synthetic universe so the journeys are REPEATABLE.
-- ============================================================================
-- Why this exists at all.
--
-- The journeys act on records of consequence, and this platform is append-only by
-- design: an approval cannot be un-approved, a clock event cannot be un-clocked, a
-- disposed exception cannot be un-disposed. That is the product being correct. It also
-- means every full run permanently CONSUMES the rows it acts on, so a suite that was
-- green at 10:00 is red at 10:05 with nothing changed — the seeded universe simply ran
-- out of un-decided work.
--
-- The wrong fixes, both rejected: seeding hundreds of visits into the shipped
-- Meadowbrook universe (which would distort every count the pgTAP suite asserts), or
-- loosening the assertions until they pass on whatever data survives (which is how a
-- suite stops being evidence).
--
-- The right fix is this file: it re-arranges a small, named slice of the SYNTHETIC
-- tenant back to a known starting state before each run. It creates nothing a coordinator
-- could not create, it touches no table the pgTAP suite counts, and it is idempotent.
--
-- D-006 holds absolutely: this is the synthetic universe. It must never be pointed at an
-- environment holding real PHI, which is why it lives under e2e/ and not supabase/seeds/.
-- ============================================================================

begin;

-- ── 1 · Dee's day, back to the top ──────────────────────────────────────────────────
-- The three caregiver journeys each need a visit that has not been clocked yet, and they
-- run in sequence, so the first would otherwise eat the fixture for the other two.
--
-- The first visit is moved to now() deliberately. The seed pins it at 05:00 local; a gate
-- running at 11:00 clocks in 361 minutes late, which correctly yields
-- verification_status = 'exception' and the card correctly reads "Recorded. Your
-- coordinator will take a look at this one." rather than "Visit in progress". That is the
-- product working — the in-fence journey simply cannot be asserted from data whose
-- arrival window closed six hours ago.
-- The ledger and everything derived from it. Deleting append-only rows is lawful HERE and
-- only here: this is fixture teardown in a synthetic tenant, executed as the table owner,
-- not an application path. No RPC and no policy permits it, which is the point.
delete from public.visit_trust_assessment where visit_id in (
  select id from public.visit where caregiver_id = '22222222-0000-0000-0000-000000000009'
    and scheduled_start::date = current_date);
delete from public.visit_exception_disposition where exception_id in (
  select e.id from public.visit_exception e join public.visit v on v.id = e.visit_id
   where v.caregiver_id = '22222222-0000-0000-0000-000000000009'
     and v.scheduled_start::date = current_date);
delete from public.visit_exception where visit_id in (
  select id from public.visit where caregiver_id = '22222222-0000-0000-0000-000000000009'
    and scheduled_start::date = current_date);
delete from public.visit_event where visit_id in (
  select id from public.visit where caregiver_id = '22222222-0000-0000-0000-000000000009'
    and scheduled_start::date = current_date);


with dee_visits as (
  select id, row_number() over (order by scheduled_start) as n
  from public.visit
  where caregiver_id = '22222222-0000-0000-0000-000000000009'
    and scheduled_start::date = current_date
)
update public.visit v
   set scheduled_start = case when d.n = 1 then now() - interval '1 minute'
                              else now() + interval '2 hours' end,
       scheduled_end   = case when d.n = 1 then now() + interval '3 hours 59 minutes'
                              else now() + interval '5 hours' end,
       status              = 'scheduled',
       verification_status = 'pending',   -- app.clock_visit never DOWNGRADES an exception
       approval_status     = 'pending',   -- (0046 §9), so a run left flagged stays flagged
       payroll_status      = 'not_ready',
       updated_at = now()
  from dee_visits d
 where v.id = d.id;

-- Both of the caregiver's visits are pinned INSIDE today in UTC on purpose. An earlier
-- draft pushed the second one four hours out, which rolls past midnight UTC when the suite
-- runs in the evening: the row then falls out of every `scheduled_start::date = current_date`
-- filter — including the verdict below — and the second and third caregiver journeys find
-- nothing to clock while the data looks fine to a human reading the table.

-- ── 2 · A standing pool of approvable work ──────────────────────────────────────────
-- approve-hours and payroll-close-export need COMPLETED visits, clocked in AND out, with
-- no blocking critical exception, worked by somebody who is not the approver (D-027 makes
-- self-approval structurally impossible, so the payroll persona cannot supply its own).
--
-- Rather than hunt for survivors, we restore a fixed, named set to un-approved every run.
-- Six is comfortably more than the four decisions a full suite makes.
with pool as (
  select v.id, row_number() over (order by v.scheduled_start desc) as n
  from public.visit v
  where v.tenant_id = '11111111-1111-1111-1111-111111111111'
    and v.caregiver_id is not null
    and v.caregiver_id <> '22222222-0000-0000-0000-000000000009'  -- not the approver
    and v.status = 'completed'
    and exists (select 1 from public.visit_event e
                 where e.visit_id = v.id and e.event_type = 'clock_in')
    and exists (select 1 from public.visit_event e
                 where e.visit_id = v.id and e.event_type = 'clock_out')
  limit 6
)
update public.visit v
   set approval_status = 'pending',
       payroll_status  = 'not_ready',
       updated_at      = now()
  from pool p
 where v.id = p.id;

-- Their approvals go too, or the RPC refuses with CAREOS_ALREADY_APPROVED and the journey
-- reads a correct refusal as a failure.
delete from public.approved_work_segment
 where visit_id in (
   select v.id from public.visit v
    where v.tenant_id = '11111111-1111-1111-1111-111111111111'
      and v.caregiver_id <> '22222222-0000-0000-0000-000000000009'
      and v.status = 'completed');

-- Nothing critical may be left open on the pool, or approval is correctly blocked and the
-- journey cannot reach the assertion it exists to make. The BLOCKED case has its own
-- fixture below, on a visit outside the pool.
update public.visit v set verification_status = 'verified'
 where v.tenant_id = '11111111-1111-1111-1111-111111111111'
   and v.status = 'completed'
   and v.caregiver_id <> '22222222-0000-0000-0000-000000000009'
   and v.verification_status = 'exception'
   and not exists (
     select 1 from public.visit_exception e
      where e.visit_id = v.id and e.severity = 'critical');

-- ── 3 · Payroll periods, back to open ───────────────────────────────────────────────
-- The close journey needs an OPEN period; a previous run leaves it locked or exported.
update public.payroll_period
   set status = 'open', locked_by = null, locked_at = null
 where tenant_id = '11111111-1111-1111-1111-111111111111';

-- Stated last and unconditionally: the statements above have all had their say, so this is
-- the state the run actually starts from. No `status <> 'scheduled'` guard — that guard
-- silently matched nothing whenever an earlier statement had already done the work, which
-- is exactly when a reader would most want the reset to be real.
update public.visit
   set status = 'scheduled', updated_at = now()
 where caregiver_id = '22222222-0000-0000-0000-000000000009'
   and scheduled_start::date = current_date;

commit;

-- A one-line verdict, so a run that arranged nothing says so rather than failing later
-- with a selector error that blames the UI for an empty database.
select 'e2e fixtures: '
       || (select count(*) from public.visit
            where caregiver_id = '22222222-0000-0000-0000-000000000009'
              and scheduled_start::date = current_date and status = 'scheduled')
       || ' clockable for the caregiver, '
       || (select count(*) from public.visit v
            where v.tenant_id = '11111111-1111-1111-1111-111111111111'
              and v.status = 'completed' and v.approval_status = 'pending'
              and v.caregiver_id <> '22222222-0000-0000-0000-000000000009')
       || ' awaiting a decision, '
       || (select count(*) from public.payroll_period
            where tenant_id = '11111111-1111-1111-1111-111111111111' and status = 'open')
       || ' open period(s)' as arranged;
