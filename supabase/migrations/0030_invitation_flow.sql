-- ST-133 · Migration 0030 — invitation flow: the front door of the identity write plane
-- Accounts stop being seed-only. The flow is token-gated and Lane-B end to end:
--   invite_staff (staff.manage) → invitation row, token HASH only — the raw token
--   travels in the invite link and never touches the database →
--   accept_invitation binds auth.uid() to the tenant: app_user (active) + employee
--   (onboarding) + user_role (granted_by = the inviting human) in one transaction.
--
-- Pre-Phase-2 enrollment posture (surfaced, not silent): docs/09 §2 wants invite-only
-- auth enrollment via the admin API, but invariant 6 bans service_role from request
-- paths, so until the Phase-2 worker sends admin invites, auth signUp stays open while
-- TENANT enrollment stays invite-token-gated — an auth account alone holds NOTHING
-- (no app_user row ⇒ no tenant context (0022) ⇒ every policy closed). The Phase-2
-- worker flips auth to admin-invite + signup disabled, completing the docs/09 target.
--
-- accept_invitation deliberately does NOT require AAL2: a brand-new user has no TOTP
-- factor yet; acceptance exposes no PHI, and every PHI policy independently requires
-- app.is_aal2(), so the AAL1-limited session docs/09 §2 describes holds by
-- construction. Status is written 'active' at accept BEFORE the audit emit (0022
-- header rule) — PHI access still waits on MFA enrollment via the AAL2 gates.
-- @trace: ST-133, docs/09 §2, invariant 6

create table public.invitation (                            -- OPS (email = PII)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  email text not null,
  full_name text not null,
  role_id uuid not null references public.role(id),
  role_title text not null check (role_title in
    ('RN','LPN','CNA','HHA','Coordinator','Office')),       -- DN-0028a vocabulary
  invited_by uuid not null references public.app_user(id),
  token_hash bytea not null unique,
  expires_at timestamptz not null default now() + interval '7 days',
  status text not null default 'pending' check (status in
    ('pending','accepted','expired','revoked')),
  accepted_user_id uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
create unique index uq_invitation_pending_email
  on public.invitation (tenant_id, lower(email)) where status = 'pending';
create index idx_invitation_tenant on public.invitation (tenant_id, created_at desc);

alter table public.invitation enable row level security;
alter table public.invitation force row level security;
create policy invitation_select_desk on public.invitation for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('staff.manage'));
grant select on public.invitation to authenticated;
-- Writes: the RPCs below only.

-- ── app.invite_staff ──────────────────────────────────────────────────────────────────
create or replace function app.invite_staff(
  p_email text, p_full_name text, p_role_id uuid, p_role_title text,
  p_token_hash_hex text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_role public.role;
  v_id uuid;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to invite staff'
      using errcode = '42501';
  end if;
  if not app.has_perm('staff.manage') then
    raise exception 'CAREOS_FORBIDDEN: staff.manage is required' using errcode = '42501';
  end if;
  if p_email is null or position('@' in p_email) < 2 then
    raise exception 'CAREOS_BAD_EMAIL: a work email is required' using errcode = 'P0001';
  end if;
  select * into v_role from public.role r where r.id = p_role_id and r.tenant_id = v_tenant;
  if v_role.id is null then
    raise exception 'CAREOS_NOT_FOUND: role' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.app_user u
              where u.tenant_id = v_tenant and lower(u.work_email) = lower(p_email)
                and u.status <> 'separated') then
    raise exception 'CAREOS_ALREADY_ENROLLED: that email already belongs to an active account'
      using errcode = 'P0001';
  end if;

  begin
    insert into public.invitation
      (tenant_id, email, full_name, role_id, role_title, invited_by, token_hash)
    values
      (v_tenant, lower(btrim(p_email)), p_full_name, p_role_id, p_role_title,
       auth.uid(), decode(p_token_hash_hex, 'hex'))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'CAREOS_DUPLICATE: a pending invitation already exists for that email'
      using errcode = 'P0001';
  end;

  perform app.emit_audit('identity.invited', 'invitation', v_id,
    jsonb_build_object('role_key', v_role.key, 'role_title', p_role_title));
  perform app.emit_event('identity.invited', 'invitation', v_id,
    jsonb_build_object('role_key', v_role.key));
  return v_id;
end $$;

-- ── app.accept_invitation — the invitee binds their auth account to the tenant ────────
create or replace function app.accept_invitation(p_token_hex text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.invitation;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'CAREOS_FORBIDDEN: sign in first, then accept your invitation'
      using errcode = '42501';
  end if;
  select * into v_inv from public.invitation
   where token_hash = sha256(decode(p_token_hex, 'hex'))
   for update;
  if v_inv.id is null then
    raise exception 'CAREOS_NOT_FOUND: invitation' using errcode = 'P0001';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'CAREOS_BAD_STATE: this invitation is %', v_inv.status using errcode = 'P0001';
  end if;
  if v_inv.expires_at < now() then
    perform app.assert_transition('invitation', 'pending', 'expired');
    update public.invitation
       set status = 'expired', updated_at = now(), row_version = row_version + 1
     where id = v_inv.id;
    raise exception 'CAREOS_EXPIRED: this invitation has expired — ask for a new one'
      using errcode = 'P0001';
  end if;
  if v_email <> lower(v_inv.email) then
    raise exception 'CAREOS_EMAIL_MISMATCH: this invitation belongs to a different email'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.app_user u where u.id = auth.uid()) then
    raise exception 'CAREOS_ALREADY_ENROLLED: this account is already part of an agency'
      using errcode = 'P0001';
  end if;

  -- Enrollment, one transaction: access record (active — BEFORE the audit emit, per
  -- the 0022 contract), employment record (onboarding), and the audited role grant.
  insert into public.app_user (id, tenant_id, full_name, work_email, kind, status)
  values (auth.uid(), v_inv.tenant_id, v_inv.full_name, v_inv.email, 'staff', 'active');

  insert into public.employee (id, tenant_id, role_title, hire_date, employment_status)
  values (auth.uid(), v_inv.tenant_id, v_inv.role_title, current_date, 'onboarding');

  insert into public.user_role (user_id, role_id, granted_by)
  values (auth.uid(), v_inv.role_id, v_inv.invited_by);

  perform app.assert_transition('invitation', 'pending', 'accepted');
  update public.invitation
     set status = 'accepted', accepted_user_id = auth.uid(),
         updated_at = now(), row_version = row_version + 1
   where id = v_inv.id;

  perform app.emit_audit('identity.invitation_accepted', 'app_user', auth.uid(),
    jsonb_build_object('invitation_id', v_inv.id, 'role_title', v_inv.role_title));
  perform app.emit_audit('identity.role_granted', 'app_user', auth.uid(),
    jsonb_build_object('role_id', v_inv.role_id, 'granted_by', v_inv.invited_by));
  perform app.emit_event('identity.invitation_accepted', 'app_user', auth.uid(),
    jsonb_build_object('invitation_id', v_inv.id));

  return jsonb_build_object('ok', true, 'tenant_id', v_inv.tenant_id,
                            'role_title', v_inv.role_title);
end $$;

-- ── app.revoke_invitation ─────────────────────────────────────────────────────────────
create or replace function app.revoke_invitation(p_invitation uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.invitation;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required' using errcode = '42501';
  end if;
  if not app.has_perm('staff.manage') then
    raise exception 'CAREOS_FORBIDDEN: staff.manage is required' using errcode = '42501';
  end if;
  select * into v_inv from public.invitation
   where id = p_invitation and tenant_id = app.current_tenant_id()
   for update;
  if v_inv.id is null then
    raise exception 'CAREOS_NOT_FOUND: invitation' using errcode = 'P0001';
  end if;
  perform app.assert_transition('invitation', v_inv.status, 'revoked');
  update public.invitation
     set status = 'revoked', updated_at = now(), row_version = row_version + 1
   where id = v_inv.id;
  perform app.emit_audit('identity.invitation_revoked', 'invitation', v_inv.id, '{}');
  return jsonb_build_object('ok', true);
end $$;

revoke all on function
  app.invite_staff(text, text, uuid, text, text),
  app.accept_invitation(text),
  app.revoke_invitation(uuid)
from public, anon;
grant execute on function
  app.invite_staff(text, text, uuid, text, text),
  app.accept_invitation(text),
  app.revoke_invitation(uuid)
to authenticated;
