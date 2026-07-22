-- ST-003 · Migration 0002 — tenancy, identity, RBAC, assignment scoping, auth helpers
-- Implements: docs/07 §3 (FR-X-010…014)
-- Hardening per D-011:
--   * app.current_tenant_id() is SECURITY DEFINER (callers have no direct grant on app_user rows they don't own)
--   * app.on_care_team() requires the assignment-holder to be an active user (separation revokes scope immediately,
--     not at token expiry — S3-1)
-- @trace: ST-003, ST-011

-- ── Tenancy ────────────────────────────────────────────────────────────────
create table public.tenant (                                        -- CFG
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);

-- ── Users (1:1 with Supabase auth.users) ───────────────────────────────────
create table public.app_user (                                      -- PII
  id uuid primary key references auth.users(id) on delete restrict,
  tenant_id uuid not null references public.tenant(id),
  full_name text not null,
  work_email text not null,
  phone text,
  kind text not null check (kind in ('staff','family','system')),
  status text not null default 'active'
    check (status in ('invited','active','suspended','separated')),
  separated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
create index idx_app_user_tenant on public.app_user (tenant_id);

-- ── Permission catalog ─────────────────────────────────────────────────────
create table public.permission (                                    -- CFG (global catalog)
  key text primary key,
  description text not null
);
create table public.role (                                          -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,
  name text not null,
  is_system boolean not null default false,
  unique (tenant_id, key)
);
create table public.role_permission (                               -- CFG
  role_id uuid references public.role(id) on delete cascade,
  permission_key text references public.permission(key),
  primary key (role_id, permission_key)
);
create table public.user_role (                                     -- OPS
  user_id uuid references public.app_user(id) on delete cascade,
  role_id uuid references public.role(id) on delete cascade,
  granted_by uuid references public.app_user(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

-- ── Assignment scoping ─────────────────────────────────────────────────────
create table public.care_team_assignment (                          -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null,           -- FK added in 0004 (client table)
  user_id uuid not null references public.app_user(id),
  role_on_case text not null check (role_on_case in
    ('caregiver','rn_case_manager','supervisor','backup')),
  starts_on date not null default current_date,
  ends_on date,
  created_at timestamptz not null default now()
);
create index idx_cta_user_active on public.care_team_assignment (user_id)
  where ends_on is null;
create index idx_cta_client_active on public.care_team_assignment (client_id)
  where ends_on is null;
create index idx_cta_tenant on public.care_team_assignment (tenant_id);

-- ── Authorization helpers (docs/07 §3.1; used by every policy) ─────────────
create or replace function app.current_user_id() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.app_user where id = auth.uid()
$$;

create or replace function app.is_aal2() returns boolean
language sql stable as $$
  select coalesce(auth.jwt()->>'aal','aal1') = 'aal2'
$$;

create or replace function app.has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_role ur
    join public.role_permission rp on rp.role_id = ur.role_id
    join public.app_user u on u.id = ur.user_id
    where ur.user_id = auth.uid() and rp.permission_key = p
      and u.status = 'active'
  )
$$;

create or replace function app.on_care_team(p_client uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.care_team_assignment a
    join public.app_user u on u.id = a.user_id and u.status = 'active'
    where a.client_id = p_client and a.user_id = auth.uid()
      and a.starts_on <= current_date
      and (a.ends_on is null or a.ends_on >= current_date)
  )
$$;

-- Helpers run with invoker privileges inside policies → authenticated needs EXECUTE.
grant execute on function
  app.current_user_id(), app.current_tenant_id(), app.is_aal2(),
  app.has_perm(text), app.on_care_team(uuid)
to authenticated;

-- ── RLS: enabled + forced on every table; explicit grants only ─────────────
alter table public.tenant enable row level security;
alter table public.tenant force row level security;
create policy tenant_select_own on public.tenant for select to authenticated
  using (id = app.current_tenant_id());
grant select on public.tenant to authenticated;

alter table public.app_user enable row level security;
alter table public.app_user force row level security;
create policy app_user_select_scoped on public.app_user for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (id = auth.uid() or app.has_perm('user.read')));
grant select on public.app_user to authenticated;

alter table public.permission enable row level security;
alter table public.permission force row level security;
create policy permission_select_all on public.permission for select to authenticated
  using (true);
grant select on public.permission to authenticated;

alter table public.role enable row level security;
alter table public.role force row level security;
create policy role_select_tenant on public.role for select to authenticated
  using (tenant_id = app.current_tenant_id());
grant select on public.role to authenticated;

alter table public.role_permission enable row level security;
alter table public.role_permission force row level security;
create policy role_permission_select_tenant on public.role_permission for select to authenticated
  using (exists (select 1 from public.role r
                 where r.id = role_id and r.tenant_id = app.current_tenant_id()));
grant select on public.role_permission to authenticated;

alter table public.user_role enable row level security;
alter table public.user_role force row level security;
create policy user_role_select_scoped on public.user_role for select to authenticated
  using (user_id = auth.uid() or app.has_perm('user.read'));
grant select on public.user_role to authenticated;

alter table public.care_team_assignment enable row level security;
alter table public.care_team_assignment force row level security;
create policy cta_select_scoped on public.care_team_assignment for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (user_id = auth.uid() or app.has_perm('careteam.read')));
grant select on public.care_team_assignment to authenticated;

-- Role/assignment mutations happen only via admin RPCs (later story) — no write grants.
