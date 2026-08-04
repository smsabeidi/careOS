-- ST-122 · Migration 0024 — credential lapse sweep (S2-9)
-- Closes: "no worker ever serves a client with a lapsed license — by construction" held
-- only at ASSIGNMENT time. A credential that expires or is verification-rejected after
-- assignment left every future visit staffed by a now-ineligible caregiver, with only an
-- obligation/notification trail. From this migration, the moment a scheduling-blocking
-- credential leaves 'verified', every future scheduled visit of that caregiver is
-- re-proven through app.assert_schedulable and vacated back to the open board when it
-- fails, each with a 'credential_lapse' exception-trail row (the C1 fill agent's cue).
--
-- Scope notes:
-- * Past visits and in-progress/completed visits are never touched — history is not
--   rewritten (invariant 1); a lapsed-mid-window visit is an exception-report matter.
-- * Natural date expiry with no status write has no trigger; the nightly compliance
--   evaluator gains a sweep pass when the automation runtime lands (Phase 2) — the
--   status-transition hook here covers every write-path lapse (HR marks expired,
--   verification rejected).
-- * The sweep requires a named actor for the exception trail (created_by is NOT NULL by
--   design). Identity-less system paths defer visibly via credential.sweep_deferred
--   rather than sweeping anonymously; Phase 2 agent identities close that lane.
-- @trace: ST-122, S2-9

-- ── schedule_exception gains the 'credential_lapse' kind (expand-phase widening) ──────
alter table public.schedule_exception drop constraint schedule_exception_kind_check;
alter table public.schedule_exception add constraint schedule_exception_kind_check
  check (kind in ('reschedule','cancellation','no_show','late_start','early_end',
                  'reassignment','callout','credential_lapse','other'));

-- ── The sweep engine (deterministic; definer; no client grants) ───────────────────────
create or replace function app.sweep_ineligible_assignments(
  p_user uuid, p_actor uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor  uuid := coalesce(p_actor, auth.uid());
  v_tenant uuid;
  v_guard  jsonb;
  v_why    text;
  v_count  int := 0;
  v_ids    uuid[] := '{}';
  r        record;
begin
  if v_actor is null then
    raise exception
      'CAREOS_ACTOR_REQUIRED: the sweep needs a named actor for the exception trail'
      using errcode = 'P0001';
  end if;
  select tenant_id into v_tenant from public.app_user where id = p_user;
  if v_tenant is null then
    raise exception 'CAREOS_NOT_FOUND: staff member' using errcode = 'P0001';
  end if;

  for r in
    select v.id, v.tenant_id, v.client_id, v.scheduled_start, v.scheduled_end
      from public.visit v
     where v.caregiver_id = p_user
       and v.tenant_id = v_tenant
       and v.status = 'scheduled'
       and v.scheduled_start > now()
     order by v.scheduled_start
       for update
  loop
    v_guard := app.assert_schedulable(p_user, r.client_id,
                                      tstzrange(r.scheduled_start, r.scheduled_end));
    if not (v_guard ->> 'schedulable')::boolean then
      v_why := coalesce(
        (v_guard #>> '{blockers,0,name}') || ' is ' || (v_guard #>> '{blockers,0,reason}'),
        'a required credential is not valid');
      insert into public.schedule_exception (tenant_id, visit_id, kind, note, created_by)
      values (r.tenant_id, r.id, 'credential_lapse',
              'Vacated by the credential sweep: ' || v_why, v_actor);
      update public.visit
         set caregiver_id = null, updated_at = now(), row_version = row_version + 1
       where id = r.id;                      -- back on the open board (idx_visit_open)
      v_count := v_count + 1;
      v_ids := v_ids || r.id;
    end if;
  end loop;

  return jsonb_build_object('vacated', v_count, 'visit_ids', to_jsonb(v_ids));
end $$;
revoke all on function app.sweep_ineligible_assignments(uuid, uuid) from public, anon, authenticated;

-- ── Hook: a blocking credential leaving 'verified' sweeps its holder ──────────────────
create or replace function app.sweep_on_credential_block() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'verified' and new.status in ('expired','rejected')
     and exists (select 1 from public.credential_type ct
                  where ct.id = new.credential_type_id and ct.blocks_scheduling) then
    if auth.uid() is null then
      -- No lawful actor (seed / identity-less system path): defer visibly, never sweep
      -- anonymously. Phase-2 agent identities make this lane disappear.
      perform app.emit_audit_system(new.tenant_id, 'system', 'credential.sweep_deferred',
        'credential', new.id, jsonb_build_object('app_user_id', new.app_user_id));
      return null;
    end if;
    perform app.sweep_ineligible_assignments(new.app_user_id);
  end if;
  return null;
end $$;

create trigger trg_credential_sweep after update on public.credential
  for each row execute function app.sweep_on_credential_block();
