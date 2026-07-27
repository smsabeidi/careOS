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

-- ── Cadence rules (COMAR-seeded config; refs enriched later) ────────────────
insert into public.cadence_rule
  (id, tenant_id, key, name, applies_to, trigger_kind, interval_days,
   grace_days, at_risk_days, severity, satisfied_by_template_key, comar_source_ref) values
  ('11111111-1111-1111-1111-0000000ca001', '11111111-1111-1111-1111-111111111111',
   'assessment.annual', 'Annual RN assessment', 'client', 'interval_days', 365,
   0, 30, 'high', 'rn_assessment', 'Doc 02 §3 — enrich with COMAR cite'),
  ('11111111-1111-1111-1111-0000000ca002', '11111111-1111-1111-1111-111111111111',
   'supervisory.90d', 'RN supervisory visit', 'client', 'interval_days', 90,
   0, 14, 'high', 'rn_assessment', 'Doc 02 §3 — enrich with COMAR cite'),
  ('11111111-1111-1111-1111-0000000ca003', '11111111-1111-1111-1111-111111111111',
   'credential.rn_license', 'RN license renewal', 'staff', 'credential_expiry', null,
   0, 45, 'critical', null, 'Doc 02 §7 — enrich with COMAR cite')
on conflict do nothing;

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
