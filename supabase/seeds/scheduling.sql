-- ST-030 / ST-031 · Scheduling seed — a minimal, coherent Meadowbrook slice.
-- Loads LAST (glob order: seed.sql → demo_users.sql → meadowbrook_universe.sql →
-- scheduling.sql), so the tenant, permission catalog, roles, demo personas, clients
-- and care-team assignments all already exist. Synthetic only (D-006). The S3/S5
-- fixtures generator enriches this later; this keeps the scheduler surface non-empty.
--
-- Personas referenced (from demo_users.sql / meadowbrook_universe.sql):
--   dee  = 22222222-0000-0000-0000-000000000009 (caregiver)
--   omar = 22222222-0000-0000-0000-000000000033 (coordinator / scheduler)
-- Clients (from seed.sql): Eleanor c10001, Marcus c10002, Rosa c10003.
-- @trace: ST-030, ST-031

-- ── Scheduling permission catalog (global CFG; idempotent) ───────────────────
-- Kept alongside the other permission rows (seed.sql owns the catalog in this repo).
insert into public.permission (key, description) values
  ('schedule.read',  'Read the schedule, shifts and visits across the tenant'),
  ('schedule.write', 'Create, assign, reschedule and cancel shifts and visits')
on conflict (key) do nothing;

-- Schedulers (coordinator/owner/admin) get read+write; RN reads the schedule.
insert into public.role_permission (role_id, permission_key)
select r.id, p.perm
from public.role r
join lateral (values
  ('owner',       'schedule.read'), ('owner',       'schedule.write'),
  ('admin',       'schedule.read'), ('admin',       'schedule.write'),
  ('coordinator', 'schedule.read'), ('coordinator', 'schedule.write'),
  ('rn',          'schedule.read')
) as p(role_key, perm) on p.role_key = r.key
where r.tenant_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

-- ── Make dee the assigned caregiver on Marcus (so a visit she owns is coherent) ─
insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case)
select '11111111-1111-1111-1111-111111111111',
       '11111111-1111-1111-1111-000000c10002',
       '22222222-0000-0000-0000-000000000009', 'caregiver'
where not exists (
  select 1 from public.care_team_assignment
   where client_id = '11111111-1111-1111-1111-000000c10002'
     and user_id  = '22222222-0000-0000-0000-000000000009');

-- ── Dee's roster shift for today (08:00–16:00) ───────────────────────────────
insert into public.shift (id, tenant_id, caregiver_id, starts_at, ends_at, status, note) values
  ('11111111-1111-1111-1111-00000005f001', '11111111-1111-1111-1111-111111111111',
   '22222222-0000-0000-0000-000000000009',
   date_trunc('day', now()) + interval '8 hours',
   date_trunc('day', now()) + interval '16 hours',
   'scheduled', 'Morning route — Silver Spring / Takoma Park.')
on conflict (id) do nothing;

-- ── Scheduled visits ─────────────────────────────────────────────────────────
insert into public.visit (id, tenant_id, client_id, caregiver_id, shift_id,
                          scheduled_start, scheduled_end, status, note) values
  -- Assigned: dee visits Marcus this morning (within her shift).
  ('11111111-1111-1111-1111-00000005e001', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10002', '22222222-0000-0000-0000-000000000009',
   '11111111-1111-1111-1111-00000005f001',
   date_trunc('day', now()) + interval '9 hours',
   date_trunc('day', now()) + interval '11 hours',
   'scheduled', 'Personal care + medication reminder.'),
  -- Assigned: dee visits Eleanor this afternoon (Nina RN is on Eleanor's care team).
  ('11111111-1111-1111-1111-00000005e002', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10001', '22222222-0000-0000-0000-000000000009',
   '11111111-1111-1111-1111-00000005f001',
   date_trunc('day', now()) + interval '13 hours',
   date_trunc('day', now()) + interval '15 hours',
   'scheduled', 'Light housekeeping + companionship.'),
  -- Open / unassigned: Rosa needs coverage tomorrow (open-shift board — ST-030 AC).
  ('11111111-1111-1111-1111-00000005e003', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10003', null, null,
   date_trunc('day', now()) + interval '34 hours',
   date_trunc('day', now()) + interval '36 hours',
   'scheduled', 'Needs a caregiver — Spanish-preferred client.')
on conflict (id) do nothing;

-- ── One append-only exception on the record: Eleanor's visit was rescheduled ─
insert into public.schedule_exception (id, tenant_id, visit_id, kind, note, created_by) values
  ('11111111-1111-1111-1111-00000005d001', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-00000005e002', 'reschedule',
   'Moved from morning to afternoon at the family''s request.',
   '22222222-0000-0000-0000-000000000033')
on conflict (id) do nothing;
