-- ST-180 · Migration 0039 — actuator hardening: the second adversarial review's closure
-- Findings C1/H1/M1-M6/L1-L3 from the 2026-08-05 runtime review. The headline (C1): a
-- separated caregiver's access-token tail could still app.accept_offer — the one
-- authenticated write lane that skipped the active-principal gate — and because a dead
-- principal has no tenant context, the visit/audit triggers no-op'd, making the grab
-- INVISIBLE. Every fix here is the same medicine already proven elsewhere in the corpus.
-- @trace: ST-180, review 2026-08-05

-- ── C1 companion + M5: the active-principal contract now covers agents' kill switch ───
-- kind='system' principals additionally require an ENABLED agent_identity row, making
-- 0035's "flip enabled and the agent is dead mid-token" claim true corpus-wide.
create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_user u
    join public.tenant t on t.id = u.tenant_id and t.status = 'active'
    where u.id = auth.uid() and u.status = 'active'
      and (u.kind <> 'system' or exists
            (select 1 from public.agent_identity ai
              where ai.app_user_id = u.id and ai.enabled))
  )
$$;
create or replace function app.current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select u.tenant_id
  from public.app_user u
  join public.tenant t on t.id = u.tenant_id and t.status = 'active'
  where u.id = auth.uid() and u.status = 'active'
    and (u.kind <> 'system' or exists
          (select 1 from public.agent_identity ai
            where ai.app_user_id = u.id and ai.enabled))
$$;

-- ── C1: leaving 'active' closes your live offers, trigger-driven (covers suspend,
--        separate, and every future path) ─────────────────────────────────────────────
create or replace function app.close_offers_on_deactivation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    update public.offer
       set status = 'superseded', responded_at = now()
     where candidate_user_id = new.id and status in ('pending','notified');
  end if;
  return null;
end $$;
create trigger trg_offer_close_on_deactivation after update on public.app_user
  for each row execute function app.close_offers_on_deactivation();

-- ── M3 expand: the offer trail gets its actor ─────────────────────────────────────────
alter table public.offer_event add column actor uuid references public.app_user(id);
create or replace function app.log_offer_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.offer_event (tenant_id, offer_id, from_status, to_status, actor)
    values (new.tenant_id, new.id, null, new.status, auth.uid());
  elsif new.status is distinct from old.status then
    perform app.assert_transition('offer', old.status, new.status);
    insert into public.offer_event (tenant_id, offer_id, from_status, to_status, actor)
    values (new.tenant_id, new.id, old.status, new.status, auth.uid());
  end if;
  return null;
end $$;

-- ── C1 + M1 + M2 + M3: accept/decline re-declared with the full gate stack ────────────
-- Gate order: AAL2 → active-staff self (the 0023 principal gate — a separated principal
-- stops HERE, loudly) → advisory(self) → visit row → own offer row (M1: the visit is
-- the single serialization point, so no ABBA through sibling offer rows) → raise-only
-- refusals (M2: no doomed writes that a raise rolls back — the cron sweep converges
-- stale statuses) → write-time assert_schedulable → audited writes.
create or replace function app.accept_offer(p_offer uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.offer;
  v_visit public.visit;
  v_guard jsonb;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                 where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception 'CAREOS_FORBIDDEN: only active staff can take an offer' using errcode = '42501';
  end if;
  select * into v from public.offer
   where id = p_offer and candidate_user_id = auth.uid();
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: offer' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('careos_sched:' || auth.uid()::text, 0));
  select * into v_visit from public.visit where id = v.visit_id for update;
  select * into v from public.offer where id = p_offer for update;   -- re-read, now locked

  if v.status not in ('pending','notified') then
    raise exception 'CAREOS_BAD_STATE: this offer is already %', v.status using errcode = 'P0001';
  end if;
  if v.expires_at < now() then
    raise exception 'CAREOS_EXPIRED: this offer has expired' using errcode = 'P0001';
  end if;
  if v_visit.caregiver_id is not null or v_visit.status <> 'scheduled' then
    raise exception 'CAREOS_TOO_LATE: this visit was already taken' using errcode = 'P0001';
  end if;

  v_guard := app.assert_schedulable(auth.uid(), v_visit.client_id,
                                    tstzrange(v_visit.scheduled_start, v_visit.scheduled_end));
  if not (v_guard ->> 'schedulable')::boolean then
    raise exception 'CAREOS_NOT_SCHEDULABLE: %', (v_guard -> 'blockers')::text
      using errcode = 'P0001';
  end if;

  update public.visit
     set caregiver_id = auth.uid(), updated_at = now(), row_version = row_version + 1
   where id = v_visit.id;
  update public.offer set status = 'accepted', responded_at = now() where id = v.id;
  update public.offer set status = 'superseded', responded_at = now()
   where visit_id = v.visit_id and id <> v.id and status in ('pending','notified');

  perform app.emit_audit('offer.accepted', 'offer', v.id,
    jsonb_build_object('visit_id', v.visit_id));                      -- M3
  return jsonb_build_object('ok', true, 'visit_id', v.visit_id);
end $$;

create or replace function app.decline_offer(p_offer uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.offer;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_user u
                 where u.id = auth.uid() and u.kind = 'staff' and u.status = 'active') then
    raise exception 'CAREOS_FORBIDDEN: only active staff can decline an offer' using errcode = '42501';
  end if;
  select * into v from public.offer
   where id = p_offer and candidate_user_id = auth.uid()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: offer' using errcode = 'P0001';
  end if;
  if v.status not in ('pending','notified') then
    return jsonb_build_object('ok', true, 'already_closed', true);
  end if;
  update public.offer set status = 'declined', responded_at = now() where id = v.id;
  perform app.emit_audit('offer.declined', 'offer', v.id,
    jsonb_build_object('visit_id', v.visit_id));                      -- M3
  perform app.note_fill_exhaustion(v.visit_id);
  return jsonb_build_object('ok', true);
end $$;

-- ── M6: fanout's proposal must be an approved ASSIGNMENT plan ─────────────────────────
create or replace function app.create_offers(
  p_visit uuid, p_candidates uuid[], p_proposal uuid default null,
  p_expires_minutes int default 120
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_visit public.visit;
  v_candidate uuid;
  v_offer uuid;
  v_count int := 0;
begin
  perform app.assert_scheduler();
  select * into v_visit from public.visit
   where id = p_visit and tenant_id = v_tenant for update;
  if v_visit.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  if v_visit.caregiver_id is not null or v_visit.status <> 'scheduled' then
    raise exception 'CAREOS_BAD_STATE: only an open scheduled visit takes offers'
      using errcode = 'P0001';
  end if;
  if p_proposal is not null and not exists (
    select 1 from public.ai_proposal_status s
     where s.proposal_id = p_proposal and s.tenant_id = v_tenant
       and s.kind = 'assignment'                                      -- M6
       and s.status in ('approved','edited')) then
    raise exception
      'CAREOS_NOT_APPROVED: offers fan out only from an approved assignment plan (invariant 8)'
      using errcode = 'P0001';
  end if;

  foreach v_candidate in array p_candidates loop
    if not exists (select 1 from public.app_user u
                    where u.id = v_candidate and u.tenant_id = v_tenant
                      and u.kind = 'staff' and u.status = 'active') then
      continue;
    end if;
    insert into public.offer
      (tenant_id, visit_id, candidate_user_id, proposal_id, expires_at, created_by)
    values
      (v_tenant, p_visit, v_candidate, p_proposal,
       now() + make_interval(mins => p_expires_minutes), auth.uid())
    on conflict (visit_id, candidate_user_id) where status in ('pending','notified')
    do nothing
    returning id into v_offer;
    if v_offer is not null then
      v_count := v_count + 1;
      perform app.queue_notification(v_candidate, 'offer.new', null,
        'offer', v_offer, 'in_app', 'offer.new:' || v_offer::text);
    end if;
  end loop;

  perform app.emit_audit('offer.fanout', 'visit', p_visit,
    jsonb_build_object('offers', v_count, 'proposal_id', p_proposal));
  perform app.emit_event('offer.fanout', 'visit', p_visit,
    jsonb_build_object('offers', v_count));
  return jsonb_build_object('ok', true, 'offers_created', v_count);
end $$;

-- ── M4: notification titles become PHI-free BY CONSTRUCTION ───────────────────────────
-- The title is derived from a closed template map; free text is refused, so no future
-- caller can put a name in an email body. p_title is retained for signature stability
-- and ignored.
create or replace function app.queue_notification(
  p_recipient uuid, p_template_key text, p_title text,
  p_subject_type text default null, p_subject_id uuid default null,
  p_channel text default 'in_app', p_dedupe_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_id uuid;
  v_title text := case p_template_key
    when 'offer.new'             then 'An open visit is available — first to accept gets it'
    when 'shift.fill_exhausted'  then 'An open visit ran out of candidates — scheduling attention needed'
    when 'credential.expiring'   then 'A credential needs renewal'
    when 'revocation.overdue'    then 'A separation checklist is overdue'
    when 'onboarding.reminder'   then 'A personnel-file item is waiting on you'
    when 'compliance.due'        then 'A compliance item is coming due'
  end;
begin
  if v_title is null then
    raise exception 'CAREOS_BAD_TEMPLATE: % is not a registered notification template',
      p_template_key using errcode = 'P0001';
  end if;
  select tenant_id into v_tenant from public.app_user
   where id = p_recipient and status = 'active';
  if v_tenant is null then
    return null;
  end if;
  insert into public.notification
    (tenant_id, recipient_id, channel, template_key, subject_type, subject_id,
     title, dedupe_key)
  values
    (v_tenant, p_recipient, p_channel, p_template_key, p_subject_type, p_subject_id,
     v_title, p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  if p_channel <> 'in_app' then
    perform pgmq.send('q_notify', jsonb_build_object(
      'notification_id', v_id, 'channel', p_channel));
  end if;
  return v_id;
end $$;

-- ── L3: a dead fill notifies the scheduling desk instead of dying in a table ──────────
create or replace function app.note_fill_exhaustion(p_visit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  r record;
begin
  select tenant_id into v_tenant from public.visit v
   where v.id = p_visit and v.caregiver_id is null and v.status = 'scheduled';
  if v_tenant is null then
    return;
  end if;
  if not exists (select 1 from public.offer o
                  where o.visit_id = p_visit and o.status in ('pending','notified')) then
    perform app.emit_event_system(v_tenant, 'shift.fill_exhausted', 'visit', p_visit, '{}');
    for r in
      select distinct ur.user_id
        from public.user_role ur
        join public.role_permission rp on rp.role_id = ur.role_id
        join public.role ro on ro.id = ur.role_id
        join public.app_user u on u.id = ur.user_id and u.status = 'active'
       where rp.permission_key = 'schedule.write' and ro.tenant_id = v_tenant
    loop
      perform app.queue_notification(r.user_id, 'shift.fill_exhausted', null,
        'visit', p_visit, 'in_app', 'fill_exhausted:' || p_visit::text || ':' || r.user_id::text);
    end loop;
  end if;
end $$;

-- ── L2: recipients keep the read receipt, lose the delivery-telemetry pen ─────────────
revoke update on public.notification from authenticated;
grant update (read_at) on public.notification to authenticated;

-- ── L1: on_event obligations pin the entity to the event's tenant ─────────────────────
create or replace function app.cadence_on_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.obligation (tenant_id, cadence_rule_id, staff_id, due_on, status)
  select new.tenant_id, r.id, new.entity_id,
         (current_date + coalesce(app.cadence_period(r.interval_days, r.interval_months),
                                  make_interval(days => 30)))::date,
         'open'
    from public.cadence_rule r
   where r.active and r.trigger_kind = 'on_event'
     and r.applies_to = 'staff'
     and r.event_type = new.event_type
     and r.tenant_id = new.tenant_id
     and new.entity_id is not null
     and exists (select 1 from public.app_user u
                  where u.id = new.entity_id and u.tenant_id = new.tenant_id)
     and not exists (
       select 1 from public.obligation o
        where o.cadence_rule_id = r.id and o.staff_id = new.entity_id
          and o.status in ('open','at_risk','overdue'));
  return null;
end $$;

-- ── H1: a worker that never came up is RED, not unknown ───────────────────────────────
-- Pre-seeded heartbeat rows with last_ok_at NULL are flagged by check_heartbeats until
-- the worker's first green pass — health starts red and must be EARNED.
insert into public.job_heartbeat (job_key, expected_interval_seconds)
values ('worker.q_events', 300), ('worker.q_notify', 300)
on conflict (job_key) do nothing;
