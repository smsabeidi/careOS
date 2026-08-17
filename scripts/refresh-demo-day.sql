-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Make "today" a real day again, on whatever day you run it. For the demo tenant only.
-- ═══════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS EXISTS. Seeded visit data is anchored to the day it was seeded, so a demo
-- environment ages: the hosted tenant's visits ran 2026-07-29 → 08-04 and were therefore
-- entirely in the past by 08-17. Every day-scoped surface — /today, the operations board,
-- the exception inbox — renders the CURRENT day, so a stale tenant shows empty screens no
-- matter how many features are switched on. Flags were never the problem there.
--
-- WHAT IT DOES. Re-anchors three of the caregiver persona's visits onto the AGENCY day
-- (America/New_York, which is what every surface renders) in the one shape that
-- demonstrates the product on a single screen:
--
--     07:00  completed    — a finished visit, with its evidence
--     11:00  in progress  — a live visit, mid-shift, clock-out available
--     15:00  scheduled    — an arrival still ahead
--
-- SAFE, AND HERE IS EXACTLY WHY. It only touches visits with NO `visit_event` ledger
-- behind them, so no append-only history is contradicted by moving a scheduled time
-- (invariant 1 is about the ledger, and the ledger is not touched). `app.guard_visit`
-- still forbids what it always forbade — the tenant and client of a visit are immutable —
-- and `trg_visit_audit` records every row this changes, so the edit is itself auditable.
-- Idempotent: absolute times are recomputed from "today" each run.
--
-- RUN IT ONLY AGAINST THE SYNTHETIC TENANT. It asserts that below and aborts otherwise —
-- re-dating real visits would be falsifying a care record, which is not a thing this
-- repository will help anyone do, demo pressure or not.
-- ═══════════════════════════════════════════════════════════════════════════════════════

do $$
declare v_tenant_name text;
begin
  select name into v_tenant_name from public.tenant limit 1;
  if v_tenant_name not ilike '%SYNTHETIC%' then
    raise exception
      'REFUSED: tenant "%" is not the synthetic demo tenant. Re-dating real visits is falsifying a care record.',
      v_tenant_name;
  end if;
end $$;

with agency_midnight as (
  select date_trunc('day', now() at time zone 'America/New_York') as d
),
caregiver as (
  select id from public.app_user where work_email = 'dee@americancareteam.demo'
),
picks as (
  select v.id, row_number() over (order by v.scheduled_start) as rn
    from public.visit v
    join caregiver c on c.id = v.caregiver_id
   -- Ledger-free only: a visit somebody actually clocked into keeps its real timeline.
   where not exists (select 1 from public.visit_event e where e.visit_id = v.id)
   limit 3
),
slots(rn, starts, lasts, st) as (
  values (1, interval '7 hours',  interval '2 hours', 'completed'),
         (2, interval '11 hours', interval '2 hours', 'in_progress'),
         (3, interval '15 hours', interval '2 hours', 'scheduled')
)
update public.visit v
   set scheduled_start = ((select d from agency_midnight) + s.starts)
                           at time zone 'America/New_York',
       scheduled_end   = ((select d from agency_midnight) + s.starts + s.lasts)
                           at time zone 'America/New_York',
       status          = s.st
  from picks p join slots s on s.rn = p.rn
 where v.id = p.id;

-- What the demo will show for the caregiver persona today.
select (v.scheduled_start at time zone 'America/New_York') as start_et, v.status
  from public.visit v
  join public.app_user u on u.id = v.caregiver_id
 where u.work_email = 'dee@americancareteam.demo'
   and (v.scheduled_start at time zone 'America/New_York')::date
     = (now() at time zone 'America/New_York')::date
 order by 1;
