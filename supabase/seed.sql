-- ST-006 · Meadowbrook synthetic universe — seed v0 (deterministic, synthetic only)
-- D-006: PHI exists only in production; every non-prod environment runs this seed.
-- E3 (ST-102): the Meadowbrook tenant doubles as the standing demo tenant.
-- v0 scope: tenant + permission catalog + system roles + role grants. Personas,
-- clients, and visit history arrive with the packages/fixtures generator
-- (ST-006 completion) — never hand-written records.
-- @trace: ST-006

insert into public.tenant (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'American Care Team (SYNTHETIC)')
on conflict (id) do nothing;

insert into public.permission (key, description) values
  ('client.read.all',  'Read every client chart in the tenant'),
  ('client.write',     'Create and update client records'),
  ('form.read.all',    'Read every form in the tenant'),
  ('form.write.all',   'Draft on any form instance'),
  ('form.finalize',    'Finalize form instances'),
  ('form.correct',     'File corrections on finalized records'),
  ('user.read',        'Read staff directory'),
  ('careteam.read',    'Read all care-team assignments'),
  ('rbac.manage',      'Manage roles and permission grants')
on conflict (key) do nothing;

insert into public.role (id, tenant_id, key, name, is_system) values
  ('11111111-1111-1111-1111-11111111a001', '11111111-1111-1111-1111-111111111111', 'owner',       'Owner',            true),
  ('11111111-1111-1111-1111-11111111a002', '11111111-1111-1111-1111-111111111111', 'admin',       'Administrator',    true),
  ('11111111-1111-1111-1111-11111111a003', '11111111-1111-1111-1111-111111111111', 'rn',          'Registered Nurse', true),
  ('11111111-1111-1111-1111-11111111a004', '11111111-1111-1111-1111-111111111111', 'coordinator', 'Coordinator',      true),
  ('11111111-1111-1111-1111-11111111a005', '11111111-1111-1111-1111-111111111111', 'caregiver',   'Caregiver',        true),
  ('11111111-1111-1111-1111-11111111a006', '11111111-1111-1111-1111-111111111111', 'hr',          'HR',               true)
on conflict (tenant_id, key) do nothing;

insert into public.role_permission (role_id, permission_key)
select r.id, p.perm
from public.role r
join lateral (values
  ('owner',       'client.read.all'), ('owner', 'client.write'), ('owner', 'form.read.all'),
  ('owner',       'form.write.all'),  ('owner', 'form.finalize'), ('owner', 'form.correct'),
  ('owner',       'user.read'),       ('owner', 'careteam.read'), ('owner', 'rbac.manage'),
  ('admin',       'client.read.all'), ('admin', 'client.write'),  ('admin', 'form.read.all'),
  ('admin',       'user.read'),       ('admin', 'careteam.read'), ('admin', 'rbac.manage'),
  ('rn',          'client.read.all'), ('rn', 'form.read.all'),    ('rn', 'form.write.all'),
  ('rn',          'form.finalize'),   ('rn', 'form.correct'),
  ('coordinator', 'client.read.all'), ('coordinator', 'careteam.read'), ('coordinator', 'user.read'),
  ('hr',          'user.read')
) as p(role_key, perm) on p.role_key = r.key
where r.tenant_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

-- ── Demo personas (LOCAL/PREVIEW ONLY — synthetic, D-006) ────────────────────
-- Password for both demo accounts: AmericanCare!demo1
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token,
                        email_change_token_new, email_change)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-0000000ce001',
   'authenticated', 'authenticated', 'fatima@americancareteam.demo',
   extensions.crypt('AmericanCare!demo1', extensions.gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-0000000ce002',
   'authenticated', 'authenticated', 'nina@americancareteam.demo',
   extensions.crypt('AmericanCare!demo1', extensions.gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                             last_sign_in_at, created_at, updated_at)
values
  (gen_random_uuid(), '11111111-1111-1111-1111-0000000ce001', '11111111-1111-1111-1111-0000000ce001',
   jsonb_build_object('sub','11111111-1111-1111-1111-0000000ce001','email','fatima@americancareteam.demo','email_verified',true),
   'email', now(), now(), now()),
  (gen_random_uuid(), '11111111-1111-1111-1111-0000000ce002', '11111111-1111-1111-1111-0000000ce002',
   jsonb_build_object('sub','11111111-1111-1111-1111-0000000ce002','email','nina@americancareteam.demo','email_verified',true),
   'email', now(), now(), now())
on conflict do nothing;

insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('11111111-1111-1111-1111-0000000ce001', '11111111-1111-1111-1111-111111111111',
   'Dr. Fatima', 'fatima@americancareteam.demo', 'staff'),
  ('11111111-1111-1111-1111-0000000ce002', '11111111-1111-1111-1111-111111111111',
   'Nina Vasquez, RN', 'nina@americancareteam.demo', 'staff')
on conflict (id) do nothing;

insert into public.user_role (user_id, role_id)
select u.uid, r.id
from (values
  ('11111111-1111-1111-1111-0000000ce001'::uuid, 'owner'),
  ('11111111-1111-1111-1111-0000000ce002'::uuid, 'rn')
) as u(uid, role_key)
join public.role r on r.key = u.role_key
  and r.tenant_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into public.client (id, tenant_id, status, first_name, last_name, dob,
                           address_line1, city, state, zip, primary_language,
                           payer_type, admitted_on) values
  ('11111111-1111-1111-1111-000000c10001', '11111111-1111-1111-1111-111111111111',
   'active', 'Eleanor', 'Vance', '1941-03-14', '412 Birchwood Ln', 'Silver Spring', 'MD', '20901',
   'en', 'medicaid', '2025-11-03'),
  ('11111111-1111-1111-1111-000000c10002', '11111111-1111-1111-1111-111111111111',
   'active', 'Marcus', 'Webb', '1948-09-22', '88 Cedar Ct', 'Takoma Park', 'MD', '20912',
   'en', 'private', '2026-01-19'),
  ('11111111-1111-1111-1111-000000c10003', '11111111-1111-1111-1111-111111111111',
   'active', 'Rosa', 'Delgado', '1936-06-02', '1509 Glenmont Ave', 'Rockville', 'MD', '20851',
   'es', 'medicaid', '2026-03-27'),
  ('11111111-1111-1111-1111-000000c10004', '11111111-1111-1111-1111-111111111111',
   'on_hold', 'Harold', 'Finch', '1944-12-08', '23 Quarry Rd', 'Wheaton', 'MD', '20902',
   'en', 'ltc_insurance', '2025-08-15')
on conflict (id) do nothing;

insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case) values
  ('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-000000c10001',
   '11111111-1111-1111-1111-0000000ce002', 'rn_case_manager')
on conflict do nothing;

insert into public.form_template (id, tenant_id, key, title, schema, requires_signature_roles) values
  ('11111111-1111-1111-1111-000000f70001', '11111111-1111-1111-1111-111111111111',
   'rn_assessment', 'RN Assessment',
   '{"fields":[
      {"key":"visit_date","label":"Assessment date","type":"date"},
      {"key":"general_condition","label":"General condition","type":"select","options":["Stable","Improving","Declining"]},
      {"key":"vitals_notes","label":"Vitals & observations","type":"textarea","help":"Blood pressure, pulse, anything you noticed."},
      {"key":"mobility","label":"Mobility","type":"select","options":["Independent","Uses walker","Wheelchair","Bed-bound"]},
      {"key":"medications_reviewed","label":"Medications reviewed with client","type":"boolean"},
      {"key":"narrative","label":"Nursing narrative","type":"textarea"},
      {"key":"follow_up_needed","label":"Follow-up visit needed","type":"boolean"}
    ]}',
   '{rn}'),
  ('11111111-1111-1111-1111-000000f70002', '11111111-1111-1111-1111-111111111111',
   'visit_note', 'Visit Note',
   '{"fields":[
      {"key":"visit_date","label":"Visit date","type":"date"},
      {"key":"tasks_completed","label":"What was done today","type":"textarea","help":"Plain words are perfect: meals, bathing, walk, laundry…"},
      {"key":"client_mood","label":"How they seemed","type":"select","options":["Bright","Content","Tired","Anxious"]},
      {"key":"notes","label":"Anything else worth noting","type":"textarea"}
    ]}',
   '{}'),
  ('11111111-1111-1111-1111-000000f70003', '11111111-1111-1111-1111-111111111111',
   'plan_of_care', 'Plan of Care',
   '{"fields":[
      {"key":"effective_date","label":"Effective date","type":"date"},
      {"key":"goals","label":"Care goals","type":"textarea"},
      {"key":"services","label":"Services & schedule","type":"textarea"},
      {"key":"safety_notes","label":"Safety considerations","type":"textarea"}
    ]}',
   '{rn}')
on conflict (id) do nothing;
