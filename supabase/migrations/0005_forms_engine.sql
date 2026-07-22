-- ST-020/ST-021/ST-022 · Migration 0005 — forms engine: templates, instances,
-- append-only versions, hash-bound signatures
-- Implements: docs/07 §5. Hardening per D-011 (findings S1-4, S1-5, S4-2, S5-2, S5-3):
--   * form_instance and form_version have NO client write grants — every mutation
--     goes through the 0006 RPCs. This is transition-guard-by-privilege: status can
--     never change via Lane A (final→draft is impossible by construction), version
--     numbers are server-assigned, corrections cannot skip their mandatory reason,
--     and versions can never land on a finalized instance outside the correction RPC.
--   * signature.content_hash is bound to form_version by a COMPOSITE FK
--     (form_version_id, content_hash) → form_version(id, content_hash): the e-sign
--     evidence claim is constraint-true, not comment-true.
-- @trace: ST-020, ST-021, ST-022, FR-X-001

create table public.form_template (                        -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,
  title text not null,
  version int not null default 1,
  schema jsonb not null,
  ui jsonb not null default '{}',
  requires_signature_roles text[] not null default '{}',
  status text not null default 'active' check (status in ('draft','active','retired')),
  created_at timestamptz not null default now(),
  unique (tenant_id, key, version)
);
alter table public.form_template enable row level security;
alter table public.form_template force row level security;
create policy form_template_select_tenant on public.form_template for select to authenticated
  using (tenant_id = app.current_tenant_id());
grant select on public.form_template to authenticated;
-- Template authoring is a config-audited admin RPC (later story) — no write grants.

create table public.form_instance (                        -- PHI (by reference)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  template_id uuid not null references public.form_template(id),
  client_id uuid references public.client(id),
  employee_id uuid,                     -- FK lands with the employee table (docs/07 §8)
  visit_id uuid,                        -- FK lands with the visit table (docs/07 §6)
  status text not null default 'draft' check (status in
    ('draft','in_review','final','superseded','void')),
  current_version_id uuid,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
create index idx_form_instance_tenant on public.form_instance (tenant_id);
create index idx_form_instance_client on public.form_instance (client_id);

alter table public.form_instance enable row level security;
alter table public.form_instance force row level security;
create policy form_instance_select_scoped on public.form_instance for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    app.has_perm('form.read.all')
    or (client_id is not null and app.on_care_team(client_id))
    or created_by = auth.uid()));
grant select on public.form_instance to authenticated;
-- No insert/update/delete grants: all writes via app.create_form / RPCs (D-011).

create table public.form_version (                         -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  instance_id uuid not null references public.form_instance(id),
  version_no int not null,
  prev_version_id uuid references public.form_version(id),
  content jsonb not null,
  content_hash bytea not null,
  author_id uuid not null references public.app_user(id),
  authored_at timestamptz not null default now(),
  kind text not null default 'edit' check (kind in
    ('create','edit','correction','merge','import','ai_draft')),
  ai_interaction_id uuid,               -- FK lands with the ai schema (docs/07 §10)
  note text,
  unique (instance_id, version_no),
  unique (id, content_hash)             -- D-011: target for the signature composite FK
);
create index idx_form_version_instance on public.form_version (instance_id, version_no);

create trigger trg_form_version_ao before update or delete on public.form_version
  for each row execute function app.forbid_mutation();

alter table public.form_version enable row level security;
alter table public.form_version force row level security;
create policy form_version_select_scoped on public.form_version for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.form_instance fi
    where fi.id = instance_id and (
      app.has_perm('form.read.all')
      or (fi.client_id is not null and app.on_care_team(fi.client_id))
      or fi.created_by = auth.uid())));
grant select on public.form_version to authenticated;
-- No insert grant (D-011 / S5-3): version_no assignment, kind gating, tenant pinning
-- and finalized-instance protection all live in the 0006 RPCs.

create table public.signature (                            -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  form_version_id uuid not null references public.form_version(id),
  signer_id uuid not null references public.app_user(id),
  signer_role text not null,
  signed_at timestamptz not null default now(),
  content_hash bytea not null,
  method text not null default 'click' check (method in ('click','drawn','external_docusign')),
  session_aal text not null,
  ip inet, user_agent text,
  constraint fk_signature_version_hash
    foreign key (form_version_id, content_hash)
    references public.form_version (id, content_hash)      -- D-011: constraint-true e-sign
);
create index idx_signature_version on public.signature (form_version_id);

create trigger trg_signature_ao before update or delete on public.signature
  for each row execute function app.forbid_mutation();

alter table public.signature enable row level security;
alter table public.signature force row level security;
create policy signature_select_scoped on public.signature for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.form_version fv
    join public.form_instance fi on fi.id = fv.instance_id
    where fv.id = form_version_id and (
      app.has_perm('form.read.all')
      or (fi.client_id is not null and app.on_care_team(fi.client_id))
      or fi.created_by = auth.uid())));
grant select on public.signature to authenticated;
-- Inserts only via app.sign_version (D-011).
