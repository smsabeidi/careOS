-- ST-013 · Demo persona registry — the five "View as" accounts (synthetic, D-006)
-- ─────────────────────────────────────────────────────────────────────────────
-- LOCAL / PREVIEW ONLY. These are the accounts the in-app persona switcher signs
-- in as. They live in the Meadowbrook synthetic tenant and hold NO real PHI.
--
-- Load order (config.toml → ["./seed.sql", "./seeds/*.sql"], glob sorts A→Z):
--   1. seed.sql .................. tenant + permission catalog + system roles;
--                                  also creates sarah (owner) and nina (RN).
--   2. seeds/demo_users.sql ...... THIS FILE — the canonical 5-persona set.
--   3. seeds/meadowbrook_universe.sql  layers 55 staff / 320 clients / records;
--                                  its omar (#51) and dee (#9) rows match ours.
--
-- Every insert is idempotent (`on conflict do nothing`). Whichever seed inserts a
-- given account first wins; the bcrypt hash verifies the same dev password either
-- way, so re-declaring the four staff accounts here is a safe no-op that keeps all
-- five logins documented in one place. UUIDs below are pinned to match the other
-- seeds exactly (omar = staff #51 = 0x33, dee = staff #9 = 0x09).
--
--   Persona       Email                     Password           Home surface
--   owner         fatima@americancareteam.demo     AmericanCare!demo1  /exec
--   coordinator   hussien@americancareteam.demo      AmericanCare!demo1  /office/clients
--   rn            nina@americancareteam.demo      AmericanCare!demo1  /clinical
--   caregiver     dee@americancareteam.demo       AmericanCare!demo1  /today
--   family        family@americancareteam.demo    AmericanCare!demo1  /family
-- @trace: ST-013

-- ── Family role ──────────────────────────────────────────────────────────────
-- The system catalog (seed.sql) ships no 'family' role. Family members get a
-- read-nothing role: the family portal is a consent-gated preview with no
-- tenant-wide grants, so this role intentionally carries ZERO role_permission
-- rows. PHI stays gated by RLS (client reads still require client.read.all or an
-- on-care-team assignment, neither of which a family user has).
insert into public.role (id, tenant_id, key, name, is_system) values
  ('11111111-1111-1111-1111-11111111a007', '11111111-1111-1111-1111-111111111111',
   'family', 'Family', true)
on conflict (tenant_id, key) do nothing;

-- ── auth.users ───────────────────────────────────────────────────────────────
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token,
                        email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000', p.uid, 'authenticated', 'authenticated',
       p.email, extensions.crypt('AmericanCare!demo1', extensions.gen_salt('bf')),
       now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
from (values
  ('11111111-1111-1111-1111-0000000ce001'::uuid, 'fatima@americancareteam.demo'),
  ('11111111-1111-1111-1111-0000000ce002'::uuid, 'nina@americancareteam.demo'),
  ('22222222-0000-0000-0000-000000000033'::uuid, 'hussien@americancareteam.demo'),
  ('22222222-0000-0000-0000-000000000009'::uuid, 'dee@americancareteam.demo'),
  ('11111111-1111-1111-1111-0000000ce003'::uuid, 'family@americancareteam.demo')
) as p(uid, email)
on conflict (id) do nothing;

-- ── auth.identities (email provider; provider_id = uid::text, matching sibling seeds) ──
insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                             last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), p.uid, p.uid::text,
       jsonb_build_object('sub', p.uid::text, 'email', p.email, 'email_verified', true),
       'email', now(), now(), now()
from (values
  ('11111111-1111-1111-1111-0000000ce001'::uuid, 'fatima@americancareteam.demo'),
  ('11111111-1111-1111-1111-0000000ce002'::uuid, 'nina@americancareteam.demo'),
  ('22222222-0000-0000-0000-000000000033'::uuid, 'hussien@americancareteam.demo'),
  ('22222222-0000-0000-0000-000000000009'::uuid, 'dee@americancareteam.demo'),
  ('11111111-1111-1111-1111-0000000ce003'::uuid, 'family@americancareteam.demo')
) as p(uid, email)
on conflict do nothing;

-- ── app_user (names/kinds match meadowbrook_universe.sql so nothing diverges) ──
insert into public.app_user (id, tenant_id, full_name, work_email, kind)
select p.uid, '11111111-1111-1111-1111-111111111111', p.full_name, p.email, p.kind
from (values
  ('11111111-1111-1111-1111-0000000ce001'::uuid, 'fatima@americancareteam.demo',  'Dr. Fatima',       'staff'),
  ('11111111-1111-1111-1111-0000000ce002'::uuid, 'nina@americancareteam.demo',   'Nina Vasquez, RN', 'staff'),
  ('22222222-0000-0000-0000-000000000033'::uuid, 'hussien@americancareteam.demo',   'Hussien Barre',    'staff'),
  ('22222222-0000-0000-0000-000000000009'::uuid, 'dee@americancareteam.demo',    'Dee Alvarez',      'staff'),
  ('11111111-1111-1111-1111-0000000ce003'::uuid, 'family@americancareteam.demo', 'Grace Vance',      'family')
) as p(uid, email, full_name, kind)
on conflict (id) do nothing;

-- ── user_role (one role per persona, resolved by key in the demo tenant) ──────
insert into public.user_role (user_id, role_id)
select p.uid, r.id
from (values
  ('11111111-1111-1111-1111-0000000ce001'::uuid, 'owner'),
  ('11111111-1111-1111-1111-0000000ce002'::uuid, 'rn'),
  ('22222222-0000-0000-0000-000000000033'::uuid, 'coordinator'),
  ('22222222-0000-0000-0000-000000000009'::uuid, 'caregiver'),
  ('11111111-1111-1111-1111-0000000ce003'::uuid, 'family')
) as p(uid, role_key)
join public.role r
  on r.key = p.role_key
 and r.tenant_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

-- ── auth.mfa_factors: a verified TOTP factor per persona, with a shared synthetic
-- secret, so the demo login + "View as" switcher can auto-complete the genuine MFA
-- challenge and reach AAL2 (apps/web/src/lib/demo-totp.ts). This is the real step-up
-- flow, automated for synthetic accounts — app.is_aal2() is satisfied honestly, no
-- policy is weakened. LOCAL/synthetic only; the secret unlocks nothing but these demo
-- accounts on a local instance.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status,
                              created_at, updated_at, secret)
select gen_random_uuid(), p.uid, 'Demo authenticator', 'totp', 'verified', now(), now(),
       'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
from (values
  ('11111111-1111-1111-1111-0000000ce001'::uuid),
  ('11111111-1111-1111-1111-0000000ce002'::uuid),
  ('22222222-0000-0000-0000-000000000033'::uuid),
  ('22222222-0000-0000-0000-000000000009'::uuid),
  ('11111111-1111-1111-1111-0000000ce003'::uuid)
) as p(uid)
where not exists (select 1 from auth.mfa_factors f where f.user_id = p.uid);
