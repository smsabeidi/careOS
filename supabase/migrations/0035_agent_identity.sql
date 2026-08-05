-- ST-154/155 · Migration 0035 — agent identity: the Actor pillar (D-020, closes S1-3)
-- Per the ratified D-020 (machine AAL2): every non-human actor is a real principal — a
-- per-agent `system` app_user with a dedicated role granting ONLY its charter's
-- permissions. The worker (Edge Function, signing-key custody per docs/09 §5) mints
-- ≤5-minute JWTs with sub = the agent's app_user id and aal='aal2'; the agent then runs
-- an ordinary user-scoped client. RLS applies to agents exactly as to humans; retrieval
-- runs as the actor (invariant 9); app.emit_audit works because tenant context exists.
-- The 0022 active-principal contract covers agents too: flip agent_identity.enabled or
-- the app_user status and the agent is dead mid-token.
--
-- Invariant 8 becomes structural here: trg_proposal_human_disposer refuses any
-- ai_proposal_event whose actor is not kind='staff'. Agents can author proposals
-- (their own identity satisfies created_by); they can never dispose one. Combined with
-- 0033's onboarding human-verifier trigger and 0018's legal-authority verifier FK,
-- every "a licensed human decides" claim in the spec is now a database constraint.
-- @trace: ST-154, ST-155, D-020, S1-3, invariant 8

create table public.agent_identity (                        -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  agent_key text not null,                 -- 'compliance_watch', 'shift_fill', …
  app_user_id uuid not null references public.app_user(id),
  charter text not null,                   -- plain-language scope, shown in the UI
  enabled boolean not null default false,  -- autonomy is opt-in (docs/16 posture)
  created_at timestamptz not null default now(),
  unique (tenant_id, agent_key),
  unique (app_user_id)
);
alter table public.agent_identity enable row level security;
alter table public.agent_identity force row level security;
create policy agent_identity_select_oversight on public.agent_identity
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('ai.read'));
grant select on public.agent_identity to authenticated;
-- Writes: provisioning below + a future config-audited admin RPC. No client grants.

-- ── Humans dispose, structurally (invariant 8) ────────────────────────────────────────
create or replace function app.guard_human_disposer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_user u
                  where u.id = new.actor and u.kind = 'staff') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: proposals are disposed by people — agents only propose'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_proposal_human_disposer
  before insert on public.ai_proposal_event
  for each row execute function app.guard_human_disposer();

-- ── Provisioning (definer plumbing; migration/seed + deploy-time entry points) ────────
create or replace function app.provision_agent(
  p_tenant uuid, p_agent_key text, p_display_name text, p_charter text,
  p_permissions text[]
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_role uuid;
  -- Tenant-scoped address: auth.users enforces unique emails, and every tenant gets
  -- its own agent principals.
  v_email text := p_agent_key || '+' || replace(p_tenant::text, '-', '')
                  || '@agents.careos.internal';
begin
  select app_user_id into v_user from public.agent_identity
   where tenant_id = p_tenant and agent_key = p_agent_key;
  if v_user is not null then
    return v_user;                                      -- idempotent
  end if;

  v_user := gen_random_uuid();
  -- A real auth principal with no credentials: no password, no factors — the ONLY way
  -- to a session is the broker's signed JWT (D-020). email is a reserved internal name.
  insert into auth.users (id, email, email_confirmed_at)
  values (v_user, v_email, now());

  insert into public.app_user (id, tenant_id, full_name, work_email, kind, status)
  values (v_user, p_tenant, p_display_name, v_email, 'system', 'active');

  insert into public.role (tenant_id, key, name, is_system)
  values (p_tenant, 'agent_' || p_agent_key, p_display_name, true)
  returning id into v_role;

  insert into public.role_permission (role_id, permission_key)
  select v_role, unnest(p_permissions)
  on conflict do nothing;

  insert into public.user_role (user_id, role_id) values (v_user, v_role);

  insert into public.agent_identity (tenant_id, agent_key, app_user_id, charter)
  values (p_tenant, p_agent_key, v_user, p_charter);

  perform app.emit_audit_system(p_tenant, 'system', 'agent.provisioned',
    'app_user', v_user, jsonb_build_object('agent_key', p_agent_key,
                                           'permissions', to_jsonb(p_permissions)));
  return v_user;
end $$;
revoke all on function app.provision_agent(uuid, text, text, text, text[])
  from public, anon, authenticated;

-- The v1 fleet (docs/11 §7 + docs/16 waves), read-only charters — proposal-writing
-- rides the ordinary self-pinned ai_proposal insert policy under the agent's JWT.
create or replace function app.provision_agent_fleet(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  perform app.provision_agent(p_tenant, 'compliance_watch', 'Compliance Watch',
    'Watches cadence obligations and drafts cure plans. Reads compliance and credentials; never writes records; never disposes.',
    array['compliance.read','credential.read.all','user.read']);
  perform app.provision_agent(p_tenant, 'credential_chase', 'Credential Chase',
    'Watches credential expiry and drafts renewal chases. Reads credentials and the directory; never verifies documents.',
    array['credential.read.all','user.read']);
  perform app.provision_agent(p_tenant, 'shift_fill', 'Shift Fill',
    'Ranks candidates for open visits and drafts outreach plans. Reads the schedule; assignment happens only after a human approves.',
    array['schedule.read','careteam.read','user.read']);
  perform app.provision_agent(p_tenant, 'hr_onboarding', 'Onboarding Assistant',
    'Watches personnel files in progress and drafts document requests. Reads the file; a human verifies every item.',
    array['user.read','credential.read.all']);
  return 4;
end $$;
revoke all on function app.provision_agent_fleet(uuid) from public, anon, authenticated;
grant execute on function app.provision_agent_fleet(uuid) to service_role;

select app.provision_agent_fleet(t.id) from public.tenant t;
