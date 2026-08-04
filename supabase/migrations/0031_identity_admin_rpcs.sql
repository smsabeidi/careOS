-- ST-134 · Migration 0031 — the identity admin write plane
-- 0002:166 promised "admin RPCs (later story)"; this is that story. Role grants,
-- suspensions, care-team assignment lifecycle and employment updates become Lane-B
-- RPCs: guarded, transition-checked, audited, on the outbox. rbac.manage — granted
-- since the first seed and checked NOWHERE — finally gates something.
--
-- Lockout guard: a tenant must never lose its last active rbac.manage holder (the
-- identity plane would freeze until a migration). app.assert_not_last_admin refuses
-- the revoke/suspend/separate that would decapitate the tenant (CAREOS_LAST_ADMIN).
-- @trace: ST-134, docs/09 §3

-- ── Shared guards ─────────────────────────────────────────────────────────────────────
create or replace function app.assert_staff_desk(p_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required' using errcode = '42501';
  end if;
  if not app.has_perm(p_perm) then
    raise exception 'CAREOS_FORBIDDEN: % is required', p_perm using errcode = '42501';
  end if;
end $$;
revoke all on function app.assert_staff_desk(text) from public, anon, authenticated;

-- Would removing p_role from p_user (or deactivating p_user outright when p_role is
-- null) leave the tenant with no ACTIVE rbac.manage holder?
create or replace function app.assert_not_last_admin(p_user uuid, p_role uuid default null)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := (select tenant_id from public.app_user where id = p_user);
begin
  if not exists (
    select 1
      from public.user_role ur
      join public.role_permission rp on rp.role_id = ur.role_id
      join public.role r on r.id = ur.role_id
      join public.app_user u on u.id = ur.user_id
     where r.tenant_id = v_tenant
       and rp.permission_key = 'rbac.manage'
       and u.status = 'active'
       and not (ur.user_id = p_user and (p_role is null or ur.role_id = p_role))
  ) then
    raise exception
      'CAREOS_LAST_ADMIN: this would leave the agency with nobody who can manage access'
      using errcode = 'P0001';
  end if;
end $$;
revoke all on function app.assert_not_last_admin(uuid, uuid) from public, anon, authenticated;

-- ── Role grants (rbac.manage) ─────────────────────────────────────────────────────────
create or replace function app.grant_role(p_user uuid, p_role uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_inserted boolean;
begin
  perform app.assert_staff_desk('rbac.manage');
  if not exists (select 1 from public.app_user u
                 where u.id = p_user and u.tenant_id = v_tenant and u.status <> 'separated') then
    raise exception 'CAREOS_NOT_FOUND: staff member' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.role r
                 where r.id = p_role and r.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: role' using errcode = 'P0001';
  end if;
  insert into public.user_role (user_id, role_id, granted_by)
  values (p_user, p_role, auth.uid())
  on conflict (user_id, role_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted then
    perform app.emit_audit('identity.role_granted', 'app_user', p_user,
      jsonb_build_object('role_id', p_role));
    perform app.emit_event('identity.role_granted', 'app_user', p_user,
      jsonb_build_object('role_id', p_role));
  end if;
  return jsonb_build_object('ok', true, 'granted', v_inserted);
end $$;

create or replace function app.revoke_role(p_user uuid, p_role uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_removed boolean;
begin
  perform app.assert_staff_desk('rbac.manage');
  if not exists (select 1 from public.app_user u
                 where u.id = p_user and u.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: staff member' using errcode = 'P0001';
  end if;
  perform app.assert_not_last_admin(p_user, p_role);
  delete from public.user_role where user_id = p_user and role_id = p_role;
  get diagnostics v_removed = row_count;
  if v_removed then
    perform app.emit_audit('identity.role_revoked', 'app_user', p_user,
      jsonb_build_object('role_id', p_role));
    perform app.emit_event('identity.role_revoked', 'app_user', p_user,
      jsonb_build_object('role_id', p_role));
  end if;
  return jsonb_build_object('ok', true, 'revoked', v_removed);
end $$;

-- ── Suspension (staff.manage) — the reversible kill switch ────────────────────────────
create or replace function app.suspend_user(p_user uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.app_user;
begin
  perform app.assert_staff_desk('staff.manage');
  if p_user = auth.uid() then
    raise exception 'CAREOS_SELF_TARGET: you cannot suspend yourself' using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a suspension needs a reason' using errcode = 'P0001';
  end if;
  select * into v from public.app_user
   where id = p_user and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: staff member' using errcode = 'P0001';
  end if;
  perform app.assert_transition('app_user', v.status, 'suspended');
  perform app.assert_not_last_admin(p_user);
  update public.app_user
     set status = 'suspended', updated_at = now(), row_version = row_version + 1
   where id = p_user;   -- access dies at commit (0022 closure + has_perm status key)
  perform app.emit_audit('identity.suspended', 'app_user', p_user,
    jsonb_build_object('reason', left(p_reason, 200)));
  perform app.emit_event('identity.suspended', 'app_user', p_user, '{}');
  return jsonb_build_object('ok', true);
end $$;

create or replace function app.reinstate_user(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.app_user;
begin
  perform app.assert_staff_desk('staff.manage');
  select * into v from public.app_user
   where id = p_user and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: staff member' using errcode = 'P0001';
  end if;
  perform app.assert_transition('app_user', v.status, 'active');
  update public.app_user
     set status = 'active', updated_at = now(), row_version = row_version + 1
   where id = p_user;
  perform app.emit_audit('identity.reinstated', 'app_user', p_user, '{}');
  perform app.emit_event('identity.reinstated', 'app_user', p_user, '{}');
  return jsonb_build_object('ok', true);
end $$;

-- ── Care-team assignment lifecycle (careteam.manage) ──────────────────────────────────
create or replace function app.create_assignment(
  p_client uuid, p_user uuid, p_role_on_case text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_id uuid;
begin
  perform app.assert_staff_desk('careteam.manage');
  if not exists (select 1 from public.client c
                 where c.id = p_client and c.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.app_user u
                 where u.id = p_user and u.tenant_id = v_tenant
                   and u.kind = 'staff' and u.status = 'active') then
    raise exception 'CAREOS_NOT_FOUND: active staff member' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.care_team_assignment a
              where a.client_id = p_client and a.user_id = p_user
                and a.role_on_case = p_role_on_case and a.ends_on is null) then
    raise exception 'CAREOS_DUPLICATE: that assignment is already active' using errcode = 'P0001';
  end if;
  insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case)
  values (v_tenant, p_client, p_user, p_role_on_case)
  returning id into v_id;
  perform app.emit_audit('assignment.created', 'care_team_assignment', v_id,
    jsonb_build_object('client_id', p_client, 'user_id', p_user, 'role_on_case', p_role_on_case));
  perform app.emit_event('careteam.assigned', 'care_team_assignment', v_id,
    jsonb_build_object('client_id', p_client, 'user_id', p_user));
  return v_id;
end $$;

create or replace function app.end_assignment(p_assignment uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.care_team_assignment;
begin
  perform app.assert_staff_desk('careteam.manage');
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: ending an assignment needs a reason'
      using errcode = 'P0001';
  end if;
  select * into v from public.care_team_assignment
   where id = p_assignment and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: assignment' using errcode = 'P0001';
  end if;
  if v.ends_on is not null then
    return jsonb_build_object('ok', true, 'already_ended', true);   -- idempotent
  end if;
  update public.care_team_assignment set ends_on = current_date where id = v.id;
  perform app.emit_audit('assignment.ended', 'care_team_assignment', v.id,
    jsonb_build_object('client_id', v.client_id, 'user_id', v.user_id,
                       'reason', left(p_reason, 200)));
  perform app.emit_event('careteam.assignment_ended', 'care_team_assignment', v.id,
    jsonb_build_object('client_id', v.client_id, 'user_id', v.user_id));
  return jsonb_build_object('ok', true);
end $$;

-- ── Employment record updates (staff.manage) ──────────────────────────────────────────
-- Separation is NOT reachable here — app.separate_user (0032) is the only path to
-- 'separated', because separation is a saga, not a field edit.
create or replace function app.update_employee(
  p_user uuid, p_row_version int,
  p_role_title text default null, p_employment_status text default null,
  p_medication_involvement text default null, p_supervisor uuid default null,
  p_hire_date date default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.employee;
  v_changes jsonb := '{}';
begin
  perform app.assert_staff_desk('staff.manage');
  select * into v from public.employee
   where id = p_user and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: employee' using errcode = 'P0001';
  end if;
  if v.row_version <> p_row_version then
    raise exception 'CAREOS_STALE: the employment record changed under you — reload and retry'
      using errcode = 'P0001';
  end if;
  if p_employment_status is not null and p_employment_status <> v.employment_status then
    if p_employment_status = 'separated' then
      raise exception
        'CAREOS_USE_SEPARATION: separation runs through app.separate_user, not a field edit'
        using errcode = 'P0001';
    end if;
    perform app.assert_transition('employee', v.employment_status, p_employment_status);
    v_changes := v_changes || jsonb_build_object('employment_status',
      jsonb_build_object('from', v.employment_status, 'to', p_employment_status));
  end if;
  if p_supervisor is not null and not exists
     (select 1 from public.app_user u where u.id = p_supervisor
       and u.tenant_id = v.tenant_id and u.kind = 'staff' and u.status = 'active') then
    raise exception 'CAREOS_NOT_FOUND: supervisor' using errcode = 'P0001';
  end if;
  if p_role_title is not null and p_role_title <> v.role_title then
    v_changes := v_changes || jsonb_build_object('role_title',
      jsonb_build_object('from', v.role_title, 'to', p_role_title));
  end if;

  update public.employee set
    role_title = coalesce(p_role_title, role_title),
    employment_status = coalesce(p_employment_status, employment_status),
    medication_involvement = coalesce(p_medication_involvement, medication_involvement),
    supervisor_id = coalesce(p_supervisor, supervisor_id),
    hire_date = coalesce(p_hire_date, hire_date),
    updated_at = now(), row_version = row_version + 1
  where id = v.id;

  perform app.emit_audit('employee.updated', 'employee', v.id, v_changes);
  if v_changes ? 'employment_status' then
    perform app.emit_event('employee.status_changed', 'employee', v.id,
      v_changes -> 'employment_status');
  end if;
  return jsonb_build_object('ok', true, 'row_version', v.row_version + 1);
end $$;

-- ── Grants ────────────────────────────────────────────────────────────────────────────
revoke all on function
  app.grant_role(uuid, uuid), app.revoke_role(uuid, uuid),
  app.suspend_user(uuid, text), app.reinstate_user(uuid),
  app.create_assignment(uuid, uuid, text), app.end_assignment(uuid, text),
  app.update_employee(uuid, int, text, text, text, uuid, date)
from public, anon;
grant execute on function
  app.grant_role(uuid, uuid), app.revoke_role(uuid, uuid),
  app.suspend_user(uuid, text), app.reinstate_user(uuid),
  app.create_assignment(uuid, uuid, text), app.end_assignment(uuid, text),
  app.update_employee(uuid, int, text, text, text, uuid, date)
to authenticated;
