-- E10/S5 · Cadence seed — Meadowbrook compliance rules + a few live obligations.
-- Synthetic only (D-006). Load order (config.toml: seed.sql, then seeds/*.sql A→Z):
--   seed.sql → seeds/cadence.sql (THIS) → seeds/demo_users.sql → seeds/meadowbrook_universe.sql
-- So this file may reference only what seed.sql created: the Meadowbrook tenant, the
-- permission catalog, the system roles, clients c10001–c10004, and sarah/nina. The
-- 320-client universe loads later; its obligations are materialized when ops first
-- runs app.evaluate_compliance() (the uq_obligation_live indexes keep that idempotent
-- against these hand-seeded rows).
--
-- Minimal-but-valid: real COMAR subsection cites are left to the Seed-phase enrichment;
-- comar_source_ref points at the internal source doc rather than inventing regulation
-- text. Obligation statuses are derived with app.cadence_status() so they stay correct
-- whatever date the seed runs.
-- @trace: E10/S5, docs/07 §7

-- ── Permission + role grants for the compliance surfaces ────────────────────
insert into public.permission (key, description) values
  ('compliance.read', 'Read compliance cadence rules and obligations across the tenant')
on conflict (key) do nothing;

insert into public.role_permission (role_id, permission_key)
select r.id, 'compliance.read'
from public.role r
where r.tenant_id = '11111111-1111-1111-1111-111111111111'
  and r.key in ('owner','admin','rn','coordinator')
on conflict do nothing;

-- ── Cadence rules — COMAR 10.07.05, in the regulation's own units (ST-114) ──
-- comar_source_ref is DEPRECATED (D-015). The authoritative link is legal_authority_id,
-- attached below; the UI branches on cadence_rule_authority.authority_is_verified before
-- showing a shield, so an unverified citation can never render as authority.
--
-- Units matter: COMAR 10.07.05.12 sets nursing supervision at "45 days" (staff
-- administers medications), "3 months" (staff assists with self-administration) and
-- "4 months" (no medication involvement). Three months is NOT 90 days — from 2026-03-01
-- they differ by two days, which is two days of a missed supervisory visit. The
-- interval_months column added in 0019 exists for exactly this reason.
--
-- ⚠ Every citation below is UNVERIFIED: read from the mdrules.elaws.us COMAR mirror on
-- 2026-08-02, NOT confirmed against regs.maryland.gov (the official home since March
-- 2026), NOT reviewed by a licensed human, and docs/02 is absent from this repo.
insert into public.cadence_rule
  (id, tenant_id, key, name, applies_to, trigger_kind, interval_days, interval_months,
   grace_days, at_risk_days, severity, satisfied_by_template_key, comar_source_ref) values
  -- .12: RN assessment before the client receives services. One-shot per admission.
  ('11111111-1111-1111-1111-0000000ca004', '11111111-1111-1111-1111-111111111111',
   'assessment.initial', 'Initial RN assessment (before services)', 'client',
   'on_admission', 0, null,
   0, 3, 'critical', 'rn_assessment', 'COMAR 10.07.05.12'),
  ('11111111-1111-1111-1111-0000000ca001', '11111111-1111-1111-1111-111111111111',
   'assessment.annual', 'Annual RN assessment', 'client', 'interval_days', 365, null,
   0, 30, 'high', 'rn_assessment', 'COMAR 10.07.05.12'),
  -- .12: every 45 DAYS where agency staff administer medications.
  ('11111111-1111-1111-1111-0000000ca005', '11111111-1111-1111-1111-111111111111',
   'supervisory.45d', 'RN supervisory visit — staff administers medications', 'client',
   'interval_days', 45, null,
   0, 14, 'high', 'rn_assessment', 'COMAR 10.07.05.12'),
  -- .12: every 3 MONTHS where staff assist with self-administration.
  ('11111111-1111-1111-1111-0000000ca002', '11111111-1111-1111-1111-111111111111',
   'supervisory.90d', 'RN supervisory visit — staff assists with self-administration',
   'client', 'interval_days', null, 3,
   0, 14, 'high', 'rn_assessment', 'COMAR 10.07.05.12'),
  -- .12: every 4 MONTHS where there is no medication involvement.
  ('11111111-1111-1111-1111-0000000ca006', '11111111-1111-1111-1111-111111111111',
   'supervisory.120d', 'RN supervisory visit — no medication involvement', 'client',
   'interval_days', null, 4,
   0, 14, 'medium', 'rn_assessment', 'COMAR 10.07.05.12'),
  -- .14D: care notes on admission and AT LEAST WEEKLY. This obligation did not exist in
  -- the engine at all before ST-114, despite being the highest-frequency COMAR
  -- documentation duty an RSA has.
  ('11111111-1111-1111-1111-0000000ca007', '11111111-1111-1111-1111-111111111111',
   'carenote.weekly', 'Care note (at least weekly)', 'client', 'interval_days', 7, null,
   0, 2, 'high', 'visit_note', 'COMAR 10.07.05.14'),
  ('11111111-1111-1111-1111-0000000ca003', '11111111-1111-1111-1111-111111111111',
   'credential.rn_license', 'RN license renewal', 'staff', 'credential_expiry', null, null,
   0, 45, 'critical', null, 'COMAR 10.07.05.10')
on conflict do nothing;

-- NOT SEEDED, deliberately — each needs machinery or a human ruling that does not exist:
--   assessment.48h_high_acuity — .12 fires on an enumerated clinical list (wound care,
--     catheter care, stage 3–4 ulcers, ventilator, medication adjustment, infusion
--     therapy, specialized nutrition, high-risk monitoring) with a documented-exception
--     branch to 7 calendar days. That is trigger_kind='on_event', which has no event spine.
--   carenote.on_change / carenote.on_careplan_change — .14D, same reason.
--   oncall.response_log — .12 requires 1-hour response with inquiry logs; obligation.due_on
--     is a DATE, so a 1-hour deadline is inexpressible until due_at timestamptz lands.
--   records.retention — COMAR .15 says 5 years, Health-General §4-403 says 7. Unresolved
--     (V14); seeding either number would repeat the defect ST-114 fixes.

-- ── A few live obligations against seed.sql subjects ────────────────────────
-- One overdue (supervisory, Eleanor), one at-risk (supervisory, Marcus), the rest
-- comfortably open — enough to light up empty/dense states on the compliance surface.
insert into public.obligation (id, tenant_id, cadence_rule_id, client_id, staff_id, due_on, status)
select v.id, r.tenant_id, r.id, v.client_id, v.staff_id, v.due_on,
       app.cadence_status('open', v.due_on, r.grace_days, r.at_risk_days, current_date)
from (values
  ('11111111-1111-1111-1111-00000000b001'::uuid, 'assessment.annual',
     '11111111-1111-1111-1111-000000c10001'::uuid, null::uuid, date '2026-11-03'),
  ('11111111-1111-1111-1111-00000000b002'::uuid, 'supervisory.90d',
     '11111111-1111-1111-1111-000000c10001'::uuid, null::uuid, date '2026-06-15'),
  ('11111111-1111-1111-1111-00000000b003'::uuid, 'assessment.annual',
     '11111111-1111-1111-1111-000000c10002'::uuid, null::uuid, date '2027-01-19'),
  ('11111111-1111-1111-1111-00000000b004'::uuid, 'supervisory.90d',
     '11111111-1111-1111-1111-000000c10002'::uuid, null::uuid, date '2026-07-30'),
  ('11111111-1111-1111-1111-00000000b005'::uuid, 'assessment.annual',
     '11111111-1111-1111-1111-000000c10003'::uuid, null::uuid, date '2027-03-27'),
  ('11111111-1111-1111-1111-00000000b006'::uuid, 'credential.rn_license',
     null::uuid, '11111111-1111-1111-1111-0000000ce002'::uuid, date '2026-09-01')
) as v(id, rule_key, client_id, staff_id, due_on)
join public.cadence_rule r
  on r.tenant_id = '11111111-1111-1111-1111-111111111111' and r.key = v.rule_key
on conflict do nothing;

-- ── Attach researched authority to the seeded rules (ST-114 / D-015) ────────
-- Migration 0019 runs this same linking, but migrations execute BEFORE seeds, so rules
-- inserted here would otherwise land with legal_authority_id NULL. The catalog itself is
-- global and seeded in the migration, so it is guaranteed to exist by this point.
update public.cadence_rule r
   set legal_authority_id = la.id
  from public.legal_authority la
 where la.jurisdiction = 'US-MD'
   and la.citation = case
         when r.key like 'assessment.%'  then 'COMAR 10.07.05.12'
         when r.key like 'supervisory.%' then 'COMAR 10.07.05.12'
         when r.key like 'carenote.%'    then 'COMAR 10.07.05.14'
         when r.key like 'oncall.%'      then 'COMAR 10.07.05.12'
         when r.key like 'credential.%'  then 'COMAR 10.07.05.10'
       end
   and r.legal_authority_id is null;

update public.credential_type ct
   set legal_authority_id = la.id
  from public.legal_authority la
 where la.jurisdiction = 'US-MD'
   and la.citation = 'COMAR 10.07.05.10'
   and ct.legal_authority_id is null;
