-- ST-121 · Migration 0023 — Lane-B scheduling: the credential guard becomes the perimeter
-- Closes 2026-08-03 review blocker #3: app.assert_schedulable existed, was granted, was
-- pgTAP-tested — and had no production caller, because visit/shift carried direct
-- insert/update grants that bypassed it ("guard outside the perimeter"). From this
-- migration, every scheduling mutation flows through a definer RPC that proves
-- eligibility in the same transaction, and the direct grants are revoked.
-- Audit: the existing app.audit_visit / app.audit_schedule_exception AFTER-triggers
-- (0011) already emit visit.schedule / visit.status_change / visit.reassign /
-- schedule_exception.<kind> — RPC bodies do not double-emit. Outbox events are added
-- when public.domain_event lands (0027, invariant 7 follow-up noted there).
-- @trace: ST-121, 2026-08-03 §7 blocker 3, S4-3 groundwork

-- ── schedule_exception gains the 'callout' kind (expand-phase CHECK widening) ─────────
-- A call-out is an advance notice that vacates a visit — distinct from no_show (after
-- the fact) and cancellation (the visit stops existing operationally). The open-shift
-- fill agent (C1) subscribes to exactly this kind.
alter table public.schedule_exception drop constraint schedule_exception_kind_check;
alter table public.schedule_exception add constraint schedule_exception_kind_check
  check (kind in ('reschedule','cancellation','no_show','late_start','early_end',
                  'reassignment','callout','other'));

-- ── Shared guard: window sanity + caller gate ─────────────────────────────────────────
create or replace function app.assert_scheduler() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to change the schedule'
      using errcode = '42501';
  end if;
  if not app.has_perm('schedule.write') then
    raise exception 'CAREOS_FORBIDDEN: schedule.write is required' using errcode = '42501';
  end if;
end $$;

-- ── app.schedule_visit — create a visit (open when p_caregiver is null) ───────────────
create or replace function app.schedule_visit(
  p_client uuid, p_start timestamptz, p_end timestamptz,
  p_caregiver uuid default null, p_shift uuid default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_guard jsonb;
  v_id uuid;
begin
  perform app.assert_scheduler();
  if p_end <= p_start then
    raise exception 'CAREOS_BAD_WINDOW: the visit must end after it starts' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.client c where c.id = p_client and c.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
  end if;
  if p_caregiver is not null then
    v_guard := app.assert_schedulable(p_caregiver, p_client, tstzrange(p_start, p_end));
    if not (v_guard ->> 'schedulable')::boolean then
      raise exception 'CAREOS_NOT_SCHEDULABLE: %', (v_guard -> 'blockers')::text using errcode = 'P0001';
    end if;
  end if;
  insert into public.visit (tenant_id, client_id, caregiver_id, shift_id,
                            scheduled_start, scheduled_end, note)
  values (v_tenant, p_client, p_caregiver, p_shift, p_start, p_end, p_note)
  returning id into v_id;
  return v_id;
end $$;

-- ── app.create_shift — roster block for an active staff caregiver ─────────────────────
create or replace function app.create_shift(
  p_caregiver uuid, p_start timestamptz, p_end timestamptz, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_id uuid;
begin
  perform app.assert_scheduler();
  if p_end <= p_start then
    raise exception 'CAREOS_BAD_WINDOW: the shift must end after it starts' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.app_user u
                 where u.id = p_caregiver and u.tenant_id = v_tenant
                   and u.kind = 'staff' and u.status = 'active') then
    raise exception 'CAREOS_NOT_FOUND: active staff caregiver' using errcode = 'P0001';
  end if;
  insert into public.shift (tenant_id, caregiver_id, starts_at, ends_at, note)
  values (v_tenant, p_caregiver, p_start, p_end, p_note)
  returning id into v_id;
  return v_id;
end $$;

-- ── app.assign_visit — put a caregiver on an open (or reassign an assigned) visit ─────
-- Row-locks the visit so a concurrent assignment can't double-book the slot, then
-- re-proves eligibility inside the same transaction (the S4-3 pattern: eligibility is
-- checked at WRITE time, not at proposal time).
create or replace function app.assign_visit(
  p_visit uuid, p_caregiver uuid, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.visit;
  v_guard jsonb;
begin
  perform app.assert_scheduler();
  select * into v from public.visit
   where id = p_visit and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v.status not in ('scheduled') then
    raise exception 'CAREOS_BAD_STATE: only a scheduled visit can be assigned (is %)', v.status
      using errcode = 'P0001';
  end if;
  if v.caregiver_id = p_caregiver then
    return jsonb_build_object('ok', true, 'visit_id', v.id, 'caregiver_id', p_caregiver,
                              'unchanged', true);   -- idempotent re-assign
  end if;
  v_guard := app.assert_schedulable(p_caregiver, v.client_id,
                                    tstzrange(v.scheduled_start, v.scheduled_end));
  if not (v_guard ->> 'schedulable')::boolean then
    raise exception 'CAREOS_NOT_SCHEDULABLE: %', (v_guard -> 'blockers')::text using errcode = 'P0001';
  end if;
  -- A true reassignment (someone was already on it) leaves an exception-trail row.
  if v.caregiver_id is not null then
    insert into public.schedule_exception (tenant_id, visit_id, kind, note, created_by)
    values (v.tenant_id, v.id, 'reassignment', p_reason, auth.uid());
  end if;
  update public.visit
     set caregiver_id = p_caregiver, updated_at = now(), row_version = row_version + 1
   where id = v.id;
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'caregiver_id', p_caregiver);
end $$;

-- ── app.cancel_visit — cancellation with a mandatory reason ───────────────────────────
create or replace function app.cancel_visit(p_visit uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.visit;
begin
  perform app.assert_scheduler();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a cancellation needs a reason' using errcode = 'P0001';
  end if;
  select * into v from public.visit
   where id = p_visit and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v.status in ('completed','cancelled') then
    raise exception 'CAREOS_BAD_STATE: a % visit cannot be cancelled', v.status using errcode = 'P0001';
  end if;
  insert into public.schedule_exception (tenant_id, visit_id, kind, note, created_by)
  values (v.tenant_id, v.id, 'cancellation', p_reason, auth.uid());
  update public.visit
     set status = 'cancelled', updated_at = now(), row_version = row_version + 1
   where id = v.id;
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'status', 'cancelled');
end $$;

-- ── app.record_callout — advance call-out vacates the visit back to open ──────────────
create or replace function app.record_callout(p_visit uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.visit;
begin
  perform app.assert_scheduler();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a call-out needs a reason' using errcode = 'P0001';
  end if;
  select * into v from public.visit
   where id = p_visit and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v.caregiver_id is null then
    raise exception 'CAREOS_BAD_STATE: an open visit has nobody to call out' using errcode = 'P0001';
  end if;
  if v.status <> 'scheduled' then
    raise exception 'CAREOS_BAD_STATE: only a scheduled visit can take a call-out (is %)', v.status
      using errcode = 'P0001';
  end if;
  insert into public.schedule_exception (tenant_id, visit_id, kind, note, created_by)
  values (v.tenant_id, v.id, 'callout', p_reason, auth.uid());
  update public.visit
     set caregiver_id = null, updated_at = now(), row_version = row_version + 1
   where id = v.id;   -- back on the open-shift board (idx_visit_open)
  return jsonb_build_object('ok', true, 'visit_id', v.id, 'open', true);
end $$;

-- ── Grants: RPCs in, direct writes out ────────────────────────────────────────────────
revoke all on function
  app.assert_scheduler(),
  app.schedule_visit(uuid, timestamptz, timestamptz, uuid, uuid, text),
  app.create_shift(uuid, timestamptz, timestamptz, text),
  app.assign_visit(uuid, uuid, text),
  app.cancel_visit(uuid, text),
  app.record_callout(uuid, text)
from public, anon;
grant execute on function
  app.assert_scheduler(),
  app.schedule_visit(uuid, timestamptz, timestamptz, uuid, uuid, text),
  app.create_shift(uuid, timestamptz, timestamptz, text),
  app.assign_visit(uuid, uuid, text),
  app.cancel_visit(uuid, text),
  app.record_callout(uuid, text)
to authenticated;

-- The perimeter change: no direct scheduling writes remain.
drop policy visit_insert_scheduler on public.visit;
drop policy visit_update_scheduler on public.visit;
drop policy shift_insert_scheduler on public.shift;
drop policy shift_update_scheduler on public.shift;
revoke insert, update on public.visit from authenticated;
revoke insert, update on public.shift from authenticated;
