-- ST-006 · Meadowbrook synthetic universe — seed v0 (deterministic, synthetic only)
-- D-006: PHI exists only in production; every non-prod environment runs this seed.
-- E3 (ST-102): the Meadowbrook tenant doubles as the standing demo tenant.
-- v0 scope: tenant + permission catalog + system roles + role grants. Personas,
-- clients, and visit history arrive with the packages/fixtures generator
-- (ST-006 completion) — never hand-written records.
-- @trace: ST-006

insert into public.tenant (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Meadowbrook Home Care (SYNTHETIC)')
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
