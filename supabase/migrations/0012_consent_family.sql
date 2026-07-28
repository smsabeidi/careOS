-- Migration 0012 — consent + family access (Wave 5: the family portal, made real).
-- Implements: docs/07 §11 (family/consent) + docs/09 (consent-gated external access).
--
-- The family portal is the only surface where a NON-staff, NON-care-team user reads any
-- client data, so the perimeter here is doubly explicit:
--   * A family user sees a client ONLY through an ACTIVE family_link AND the client's
--     LATEST consent for 'family_portal' being 'granted' with the relevant scope token.
--     Both checks live in app.on_family_link() (SECURITY DEFINER, like app.on_care_team).
--   * Family NEVER gets a grant on the raw `visit` table (its `note` may carry PHI).
--     The calendar is served by app.family_calendar(), a definer RPC returning only
--     time + status — column-minimized by construction (invariant 5).
--   * consent, family_update and shared_document are append-only [AO]: a consent decision,
--     a shared note, and a shared document are records of consequence — revoking is a NEW
--     'revoked' consent row, never an in-place edit (invariant 1).
--   * Everything family-facing is AAL2-gated (invariant 3) and audited (invariant 7).
--
-- Object order is dependency-driven: the consent + family_link TABLES exist before
-- app.on_family_link() (its SQL body references them), which exists before every policy
-- that calls it. @trace: docs/07 §11, docs/09, Wave 5

-- ── Permission catalog (real config) ────────────────────────────────────────────
insert into public.permission (key, description) values
  ('family.manage', 'Link family members, record consent, and share updates/documents')
on conflict (key) do nothing;

-- ── Audit emitters (definer; PHI-minimized payloads; seed path no-ops on null tenant) ──
create or replace function app.audit_consent() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is not null then
    perform app.emit_audit('consent.' || new.status, 'consent', new.id,
      jsonb_build_object('client_id', new.client_id, 'kind', new.kind, 'scope', new.scope));
  end if;
  return null;
end $$;

create or replace function app.audit_family_link() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then return null; end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('family_link.create', 'family_link', new.id,
      jsonb_build_object('client_id', new.client_id, 'family_user_id', new.family_user_id));
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform app.emit_audit('family_link.' || new.status, 'family_link', new.id,
      jsonb_build_object('client_id', new.client_id, 'family_user_id', new.family_user_id));
  end if;
  return null;
end $$;

create or replace function app.audit_family_share() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is not null then
    perform app.emit_audit(tg_argv[0] || '.share', tg_argv[0], new.id,
      jsonb_build_object('client_id', new.client_id));   -- id + client only; never the body
  end if;
  return null;
end $$;

revoke all on function app.audit_consent()      from public;
revoke all on function app.audit_family_link()   from public;
revoke all on function app.audit_family_share()  from public;

-- ── consent — append-only client consent for family sharing ─────────────── [AO] PHI-adj
create table public.consent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  kind text not null default 'family_portal' check (kind in ('family_portal')),
  scope text[] not null default '{}',              -- {'updates','calendar','documents'}
  status text not null default 'granted' check (status in ('granted','revoked')),
  recorded_by uuid not null references public.app_user(id),   -- staff who recorded it
  note text,
  created_at timestamptz not null default now()
);
create index idx_consent_client_kind on public.consent (client_id, kind, created_at desc);
create index idx_consent_tenant on public.consent (tenant_id);

create trigger trg_consent_ao before update or delete on public.consent
  for each row execute function app.forbid_mutation();
create trigger trg_consent_audit after insert on public.consent
  for each row execute function app.audit_consent();

alter table public.consent enable row level security;
alter table public.consent force row level security;
-- INSERT policy now (uses only pre-existing helpers). SELECT policy is created AFTER
-- app.on_family_link() exists (below), since it references that function.
create policy consent_insert_staff on public.consent for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and recorded_by = auth.uid()
    and (app.has_perm('family.manage') or app.on_care_team(client_id))
    and exists (select 1 from public.client c where c.id = client_id and c.tenant_id = app.current_tenant_id()));
grant select, insert on public.consent to authenticated;   -- append-only: no update/delete

-- ── family_link — a family user connected to a client ──────────────────────────── PHI-adj
create table public.family_link (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  family_user_id uuid not null references public.app_user(id),
  relationship text,                               -- 'daughter','son','spouse',…
  status text not null default 'active' check (status in ('active','revoked')),
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, family_user_id)
);
create index idx_family_link_family on public.family_link (family_user_id) where status = 'active';
create index idx_family_link_client on public.family_link (client_id);

create trigger trg_family_link_audit after insert or update on public.family_link
  for each row execute function app.audit_family_link();

alter table public.family_link enable row level security;
alter table public.family_link force row level security;
-- A family user sees their OWN links; staff see all in-tenant links.
create policy family_link_select_scoped on public.family_link for select to authenticated
  using (tenant_id = app.current_tenant_id() and (
    family_user_id = auth.uid()
    or app.has_perm('client.read.all') or app.on_care_team(client_id)));
create policy family_link_insert_staff on public.family_link for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('family.manage') or app.on_care_team(client_id)));
create policy family_link_update_staff on public.family_link for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('family.manage') or app.on_care_team(client_id)))
  with check (tenant_id = app.current_tenant_id());
grant select, insert, update on public.family_link to authenticated;

-- ── The family-access gate (SECURITY DEFINER; like app.on_care_team) ─────────────
-- True when the caller has an ACTIVE link to p_client AND (if p_scope given) the client's
-- LATEST 'family_portal' consent is 'granted' and its scope covers p_scope. A later
-- 'revoked' consent row wins because it is the newest — access closes with no edits.
create or replace function app.on_family_link(p_client uuid, p_scope text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.family_link fl
    where fl.family_user_id = auth.uid()
      and fl.client_id = p_client
      and fl.status = 'active'
      and fl.tenant_id = app.current_tenant_id()
  )
  and (
    p_scope is null
    or exists (
      -- A granted row covering the scope, with NO revoke at-or-after it. Deny-wins on a
      -- tie (a revoke at the same instant closes access), so revocation is always safe.
      select 1 from public.consent g
      where g.client_id = p_client
        and g.kind = 'family_portal'
        and g.tenant_id = app.current_tenant_id()
        and g.status = 'granted'
        and p_scope = any (g.scope)
        and not exists (
          select 1 from public.consent r
          where r.client_id = g.client_id and r.kind = g.kind and r.tenant_id = g.tenant_id
            and r.status = 'revoked' and r.created_at >= g.created_at)
    )
  )
$$;
revoke all on function app.on_family_link(uuid, text) from public, anon;
grant execute on function app.on_family_link(uuid, text) to authenticated;

-- ── consent SELECT policy (deferred until on_family_link exists) ──────────────────
-- Staff on the care team (or client.read.all) read consent; a linked family user reads
-- consent for their client so the portal can show "what you're cleared to see".
create policy consent_select_scoped on public.consent for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    app.has_perm('client.read.all') or app.on_care_team(client_id)
    or app.on_family_link(client_id, null)));

-- ── family_update — a care-team note explicitly shared to family ───────────── [AO] PHI
create table public.family_update (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  author_id uuid not null references public.app_user(id),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index idx_family_update_client on public.family_update (client_id, created_at desc);
create index idx_family_update_tenant on public.family_update (tenant_id);

create trigger trg_family_update_ao before update or delete on public.family_update
  for each row execute function app.forbid_mutation();
create trigger trg_family_update_audit after insert on public.family_update
  for each row execute function app.audit_family_share('family_update');

alter table public.family_update enable row level security;
alter table public.family_update force row level security;
create policy family_update_select_scoped on public.family_update for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    app.has_perm('client.read.all') or app.on_care_team(client_id)
    or app.on_family_link(client_id, 'updates')));
create policy family_update_insert_staff on public.family_update for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and author_id = auth.uid()
    and (app.has_perm('family.manage') or app.on_care_team(client_id)));
grant select, insert on public.family_update to authenticated;   -- append-only

-- ── shared_document — metadata for a document shared to family (no file bytes here) ─ [AO]
create table public.shared_document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  title text not null,
  doc_kind text not null default 'other' check (doc_kind in
    ('care_plan','consent','instructions','other')),
  shared_by uuid not null references public.app_user(id),
  note text,
  created_at timestamptz not null default now()
);
create index idx_shared_document_client on public.shared_document (client_id, created_at desc);
create index idx_shared_document_tenant on public.shared_document (tenant_id);

create trigger trg_shared_document_ao before update or delete on public.shared_document
  for each row execute function app.forbid_mutation();
create trigger trg_shared_document_audit after insert on public.shared_document
  for each row execute function app.audit_family_share('shared_document');

alter table public.shared_document enable row level security;
alter table public.shared_document force row level security;
create policy shared_document_select_scoped on public.shared_document for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    app.has_perm('client.read.all') or app.on_care_team(client_id)
    or app.on_family_link(client_id, 'documents')));
create policy shared_document_insert_staff on public.shared_document for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and shared_by = auth.uid()
    and (app.has_perm('family.manage') or app.on_care_team(client_id)));
grant select, insert on public.shared_document to authenticated;   -- append-only

-- ── Family calendar RPC (SECURITY DEFINER; column-minimized — time + status only) ──
-- Family never touches the raw `visit` table (note may be PHI). This returns only what a
-- calendar needs, and only for a client the caller is consented to see (scope 'calendar').
create or replace function app.family_calendar(p_client uuid)
returns table (scheduled_start timestamptz, scheduled_end timestamptz, status text)
language sql stable security definer set search_path = public as $$
  select v.scheduled_start, v.scheduled_end, v.status
  from public.visit v
  where v.client_id = p_client
    and v.tenant_id = app.current_tenant_id()
    and app.on_family_link(p_client, 'calendar')
    and v.scheduled_start >= date_trunc('day', now())
    and v.status <> 'cancelled'
  order by v.scheduled_start
  limit 60
$$;
revoke all on function app.family_calendar(uuid) from public, anon;
grant execute on function app.family_calendar(uuid) to authenticated;

-- ── Family client identity (SECURITY DEFINER; name + city only) ──────────────────
-- A linked family member is entitled to know their loved one's name, but must not get a
-- grant on the raw `client` table (which carries DOB, payer, address, etc.). This returns
-- only name + city, and only for a client the caller is actively linked to.
create or replace function app.family_client(p_client uuid)
returns table (first_name text, last_name text, city text)
language sql stable security definer set search_path = public as $$
  select c.first_name, c.last_name, c.city
  from public.client c
  where c.id = p_client
    and c.tenant_id = app.current_tenant_id()
    and app.on_family_link(p_client, null)
$$;
revoke all on function app.family_client(uuid) from public, anon;
grant execute on function app.family_client(uuid) to authenticated;
