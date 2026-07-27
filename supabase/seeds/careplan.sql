-- Care planning seed — minimal, valid Meadowbrook rows (synthetic only, D-006).
-- Loads after seed.sql (glob A→Z: careplan.sql runs first among seeds/), so the
-- tenant, Nina (RN, ce002) and the seed.sql clients already exist. The Seed phase
-- enriches this later; here we plant just enough for the care-plan + supervisory
-- surfaces to render. Runs as postgres (no tenant session) → the audit trigger is a
-- no-op and the append-only triggers permit these inserts. Every insert is idempotent.
--
-- References (from seed.sql):
--   tenant  11111111-1111-1111-1111-111111111111  (Meadowbrook, SYNTHETIC)
--   RN      11111111-1111-1111-1111-0000000ce002  (Nina Vasquez, RN — case manager for Eleanor)
--   client  11111111-1111-1111-1111-000000c10001  (Eleanor Vance, active)
--   client  11111111-1111-1111-1111-000000c10002  (Marcus Webb, active)
-- @trace: docs/07 §10 (care planning), docs/07 §7 (supervisory cadence)

-- ── Care plans (append-only version 1, active) ─────────────────────────────
insert into public.care_plan
  (id, tenant_id, client_id, version, status, title, summary, authored_by,
   authored_at, effective_on, review_due_on)
values
  ('11111111-2222-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10001', 1, 'active',
   'Plan of Care — Eleanor Vance',
   'Support safe living at home: fall prevention, medication reminders, and daily personal care.',
   '11111111-1111-1111-1111-0000000ce002',
   now() - interval '21 days', current_date - 21, current_date + 69),
  ('11111111-2222-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10002', 1, 'active',
   'Plan of Care — Marcus Webb',
   'Maintain independence with light-touch support: mobility, meals, and companionship.',
   '11111111-1111-1111-1111-0000000ce002',
   now() - interval '10 days', current_date - 10, current_date + 80)
on conflict (id) do nothing;

-- ── Care plan items (goals + interventions) ────────────────────────────────
insert into public.care_plan_item
  (id, tenant_id, care_plan_id, kind, seq, text, target)
values
  ('11111111-2233-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '11111111-2222-0000-0000-000000000001', 'goal', 1,
   'Maintain safe mobility throughout the home', 'No falls over the next 90 days'),
  ('11111111-2233-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '11111111-2222-0000-0000-000000000001', 'intervention', 2,
   'Caregiver clears walking paths and assists with transfers each visit', 'Every visit'),
  ('11111111-2233-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   '11111111-2222-0000-0000-000000000001', 'goal', 3,
   'Take medications as prescribed', 'Reminders given twice daily'),
  ('11111111-2233-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   '11111111-2222-0000-0000-000000000002', 'goal', 1,
   'Stay active and engaged', 'Short daily walk, weather permitting'),
  ('11111111-2233-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
   '11111111-2222-0000-0000-000000000002', 'intervention', 2,
   'Prepare a balanced midday meal and note appetite', 'Every visit')
on conflict (id) do nothing;

-- ── Supervisory visits (upcoming 45/90-day cadence, scheduled) ─────────────
insert into public.supervisory_visit
  (id, tenant_id, client_id, rn_id, kind, status, due_on)
values
  ('11111111-2255-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10001',
   '11111111-1111-1111-1111-0000000ce002', '45_day', 'scheduled', current_date + 7),
  ('11111111-2255-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10001',
   '11111111-1111-1111-1111-0000000ce002', '90_day', 'scheduled', current_date + 52),
  ('11111111-2255-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-000000c10002',
   '11111111-1111-1111-1111-0000000ce002', '45_day', 'scheduled', current_date + 30)
on conflict (id) do nothing;
