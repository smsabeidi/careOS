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

-- ST-244. The teardown below DELETEs from append-only tables, which the file's own header
-- argues is lawful here and only here — fixture teardown in the synthetic tenant, as the
-- table owner, through no RPC and no policy. It was nevertheless broken: app.forbid_mutation
-- is a BEFORE DELETE **row** trigger, so it stays silent while the delete matches nothing
-- and raises CAREOS_APPEND_ONLY the moment it matches something. The arrangement therefore
-- worked on a clean database and aborted — taking the whole transaction with it — as soon
-- as a spec had raised a single visit_exception. That is precisely the "green at 10:00,
-- red at 10:05" failure this file exists to prevent, hiding in the fix for it.
--
-- session_replication_role = replica suspends user triggers for THIS transaction only
-- (set local), which is the standard fixture escape hatch and is unavailable to any
-- application path: the app's roles are not superusers, so no product code can reach it.
-- The append-only guarantee is untouched everywhere it means anything.
set local session_replication_role = replica;

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

-- ── 4b · One clockable visit PER caregiver spec, all at the SAME address ────────────
-- ST-244. The three caregiver journeys each consume a clockable visit, and they share one
-- worker and one database, so with Dee's two seeded visits the third spec found nothing
-- to clock. Worse than "nothing", in fact: `firstClockableCard()` walks to the next card,
-- and Dee's second visit belongs to a DIFFERENT client at a DIFFERENT address — so the
-- run silently started testing an in-fence journey against coordinates that are nowhere
-- near that client's home, the engine correctly refused the clock, and the failure read
-- as "the product broke" when the truth was "the harness pointed the caregiver at the
-- wrong house". A geographic anchor is only meaningful against the address it was taken
-- from (CAREOS_E2E_INFENCE_LAT/LNG, e2e/README.md).
--
-- So: every one of Dee's visits today is pointed at the ANCHOR client — the client whose
-- attested pin those coordinates came from — and the day is topped up to three scheduled
-- visits so each spec consumes its own. Same lawful-here reasoning as §1: arrangement in
-- the synthetic tenant, as the table owner, through no RPC and no policy. Idempotent.
with anchor as (
  select v.client_id
    from public.visit v
   where v.caregiver_id = '22222222-0000-0000-0000-000000000009'
     and v.scheduled_start::date = current_date
   order by v.scheduled_start
   limit 1
)
update public.visit v
   set client_id = (select client_id from anchor), updated_at = now()
 where v.caregiver_id = '22222222-0000-0000-0000-000000000009'
   and v.scheduled_start::date = current_date
   and v.client_id is distinct from (select client_id from anchor);

insert into public.visit (tenant_id, client_id, caregiver_id, status,
                          scheduled_start, scheduled_end)
select v.tenant_id, v.client_id, v.caregiver_id, 'scheduled',
       current_date + interval '1 hour' * (13 + g.n),
       current_date + interval '1 hour' * (14 + g.n)
  from (select * from public.visit
         where caregiver_id = '22222222-0000-0000-0000-000000000009'
           and scheduled_start::date = current_date
         order by scheduled_start limit 1) v
  cross join generate_series(1, 3) as g(n)
 where (select count(*) from public.visit
         where caregiver_id = '22222222-0000-0000-0000-000000000009'
           and scheduled_start::date = current_date
           and status = 'scheduled') + g.n <= 3;

-- ── 5 · The self-approval refusal's precondition (D-027) ────────────────────────────
-- The one spec that proves CAREOS_SELF_APPROVAL end to end needs a principal who WORKED
-- a shift and also holds visit.approve. No seeded persona qualifies (approvers approve,
-- caregivers work), so this block arranges exactly one: yesterday's completed,
-- still-unapproved visit worked by the OWNER persona (Dr. Fatima), against the same
-- client Dee sees. Same lawful-here reasoning as §1: fixture arrangement in the
-- synthetic tenant, as the table owner, through no RPC and no policy. Idempotent by
-- fixed uuid: delete-then-insert, ledger first.
delete from public.approved_work_segment
 where visit_id = '11111111-1111-1111-1111-00000000e25a';
delete from public.visit_event
 where visit_id = '11111111-1111-1111-1111-00000000e25a';
delete from public.visit where id = '11111111-1111-1111-1111-00000000e25a';

insert into public.visit (id, tenant_id, client_id, caregiver_id, status,
                          scheduled_start, scheduled_end, approval_status, payroll_status)
select '11111111-1111-1111-1111-00000000e25a', v.tenant_id, v.client_id,
       '11111111-1111-1111-1111-0000000ce001',            -- Dr. Fatima (owner persona)
       'completed',
       current_date - interval '1 day' + interval '9 hours',
       current_date - interval '1 day' + interval '11 hours',
       'pending', 'not_ready'
  from public.visit v
 where v.caregiver_id = '22222222-0000-0000-0000-000000000009'
 order by v.scheduled_start limit 1;

insert into public.visit_event (tenant_id, visit_id, caregiver_id, event_type,
                                occurred_at, method, capture_source, location_status)
select tenant_id, id, caregiver_id, e.t, e.at_, 'web', 'web', 'not_required'
  from public.visit,
       lateral (values
         ('clock_in',  current_date - interval '1 day' + interval '9 hours'),
         ('clock_out', current_date - interval '1 day' + interval '11 hours')
       ) as e(t, at_)
 where id = '11111111-1111-1111-1111-00000000e25a';

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
