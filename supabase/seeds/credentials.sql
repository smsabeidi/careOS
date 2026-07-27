-- E09 · Credentials seed — Meadowbrook synthetic workforce credentials (D-006).
-- LOCAL / PREVIEW ONLY. No real PHI/PII. Minimal-but-valid; the fixtures generator
-- (S5) enriches the full 55-staff credential set later.
--
-- Load order (config.toml → ["./seed.sql", "./seeds/*.sql"], glob sorts A→Z):
--   seed.sql → seeds/credentials.sql (THIS) → demo_users.sql → meadowbrook_universe.sql
-- So only the base personas (sarah=owner, nina=RN, from seed.sql) exist as app_users
-- when this runs. Every credential insert JOINs public.app_user so it is FK-safe and
-- simply skips any persona not yet loaded — nothing here depends on later seeds.
--
-- Credential permission KEYS ship in migration 0008 (real config). The per-tenant
-- role grants below are synthetic-tenant wiring, so they live in the seed.
-- @trace: E09, M7

-- ── Role grants for the synthetic tenant ────────────────────────────────────────
insert into public.role_permission (role_id, permission_key)
select r.id, p.perm
from public.role r
join (values
  ('owner',       'credential.read.all'), ('owner',       'credential.write'),
  ('admin',       'credential.read.all'), ('admin',       'credential.write'),
  ('hr',          'credential.read.all'), ('hr',          'credential.write'),
  ('coordinator', 'credential.read.all')
) as p(role_key, perm) on p.role_key = r.key
where r.tenant_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

-- ── Credential type catalog (COMAR 10.07.05 §7 HR items) ────────────────────────
insert into public.credential_type
  (id, tenant_id, key, name, category, required_for_roles, renewal_interval_days, blocks_scheduling, source_ref) values
  ('11111111-1111-1111-1111-000000c70001', '11111111-1111-1111-1111-111111111111',
   'rn_license',       'RN License',                 'license',           '{RN}',                             730,  true,  'COMAR 10.07.05.10'),
  ('11111111-1111-1111-1111-000000c70002', '11111111-1111-1111-1111-111111111111',
   'cpr',              'CPR Certification',          'certification',     '{RN,LPN,CNA,HHA,Caregiver}',       365,  true,  'COMAR 10.07.05.11'),
  ('11111111-1111-1111-1111-000000c70003', '11111111-1111-1111-1111-111111111111',
   'tb_screen',        'TB Screening',               'health_screening',  '{RN,LPN,CNA,HHA,Caregiver}',       365,  true,  'COMAR 10.07.05.11'),
  ('11111111-1111-1111-1111-000000c70004', '11111111-1111-1111-1111-111111111111',
   'background_check', 'Criminal Background Check',  'background_check',  '{RN,LPN,CNA,HHA,Caregiver,Coordinator}', null, true, 'COMAR 10.07.05.10')
on conflict (tenant_id, key) do nothing;

-- ── A few plausible credentials for the base personas (nina=RN, sarah=owner) ────
-- Spread across the three expiry buckets so the dashboard has real states to render:
--   nina rn_license   → valid          (renews in ~11 months)
--   nina cpr          → expiring_soon   (due in ~3 weeks)
--   nina tb_screen    → lapsed          (expired 15 days ago; status expired)
--   sarah bg check    → valid           (non-expiring)
-- Inserting a credential fires the history + audit triggers (a 'created' event each).
insert into public.credential
  (id, tenant_id, app_user_id, credential_type_id, identifier, issued_on, expires_on, status, verified_by, verified_at)
select v.id, '11111111-1111-1111-1111-111111111111', v.app_user_id, v.type_id,
       v.identifier, v.issued_on, v.expires_on, v.status, v.verified_by, v.verified_at
from (values
  ('11111111-1111-1111-1111-000000cd0001'::uuid, '11111111-1111-1111-1111-0000000ce002'::uuid,
   '11111111-1111-1111-1111-000000c70001'::uuid, 'RN-MD-448201',
   current_date - 400, current_date + 330, 'verified',
   '11111111-1111-1111-1111-0000000ce001'::uuid, now() - interval '35 days'),
  ('11111111-1111-1111-1111-000000cd0002'::uuid, '11111111-1111-1111-1111-0000000ce002'::uuid,
   '11111111-1111-1111-1111-000000c70002'::uuid, 'CPR-2025-7741',
   current_date - 345, current_date + 20, 'verified',
   '11111111-1111-1111-1111-0000000ce001'::uuid, now() - interval '20 days'),
  ('11111111-1111-1111-1111-000000cd0003'::uuid, '11111111-1111-1111-1111-0000000ce002'::uuid,
   '11111111-1111-1111-1111-000000c70003'::uuid, null,
   current_date - 380, current_date - 15, 'expired',
   '11111111-1111-1111-1111-0000000ce001'::uuid, now() - interval '380 days'),
  ('11111111-1111-1111-1111-000000cd0004'::uuid, '11111111-1111-1111-1111-0000000ce001'::uuid,
   '11111111-1111-1111-1111-000000c70004'::uuid, 'BGC-MD-2024-1188',
   current_date - 500, null, 'verified',
   '11111111-1111-1111-1111-0000000ce001'::uuid, now() - interval '500 days')
) as v(id, app_user_id, type_id, identifier, issued_on, expires_on, status, verified_by, verified_at)
join public.app_user au on au.id = v.app_user_id            -- FK-safe: skip absent personas
join public.credential_type ct on ct.id = v.type_id
on conflict (id) do nothing;
