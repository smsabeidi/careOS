-- ST-135 · Migration 0032 — app.separate_user: the revocation saga's DB-side head
-- docs/09 §2's flagship control ("≤15 min from HR trigger"), redesigned per S2-7 as a
-- verified saga instead of a happy-path spec:
--   Phase 1 (THIS transaction, atomic): access status → separated (every policy closes
--   at commit — 0022), employment record → separated, every open care-team assignment
--   ends, every FUTURE scheduled visit is vacated back to the open board (regardless
--   of credentials — separation vacates unconditionally, with its own
--   'separation' exception kind), and the six-step revocation checklist materializes.
--   The 'identity.separated' outbox event is the worker's cue.
--   Phase 2 (worker, Phase-2 runtime): the external steps — Supabase Auth ban +
--   refresh-token revocation (kills the ≤1 h token tail), push-token invalidation —
--   executed idempotently, each completion an audited checklist row via
--   app.complete_revocation_step. When the last step lands, the saga emits
--   'identity.revocation_verified': the evidence row docs/09 §3's quarterly access
--   review reconciles against. The deadman (Phase 2) pages on any checklist older
--   than 15 minutes with pending steps.
-- There is deliberately NO un-separate path: rehire = a fresh invitation, a fresh
-- account binding, and a fresh onboarding file — never a resurrection of the old
-- access surface.
-- @trace: ST-135, S2-7, S3-1, docs/09 §2-3

-- ── schedule_exception gains the 'separation' kind (expand-phase widening) ────────────
alter table public.schedule_exception drop constraint schedule_exception_kind_check;
alter table public.schedule_exception add constraint schedule_exception_kind_check
  check (kind in ('reschedule','cancellation','no_show','late_start','early_end',
                  'reassignment','callout','credential_lapse','separation','other'));

-- ── The checklist ─────────────────────────────────────────────────────────────────────
create table public.revocation_checklist (                  -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  user_id uuid not null references public.app_user(id),
  step text not null check (step in
    ('auth_ban','refresh_revoke','push_invalidate',
     'secrets_rotation','equipment_return','final_documentation')),
  status text not null default 'pending' check (status in ('pending','done','not_applicable')),
  completed_by uuid references public.app_user(id),
  completed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, step)
);
create index idx_revocation_tenant on public.revocation_checklist (tenant_id)
  where status = 'pending';

alter table public.revocation_checklist enable row level security;
alter table public.revocation_checklist force row level security;
create policy revocation_select_desk on public.revocation_checklist for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('staff.manage'));
grant select on public.revocation_checklist to authenticated;
-- Writes: the two RPCs below only.

-- ── app.separate_user — Phase 1, one transaction ──────────────────────────────────────
create or replace function app.separate_user(
  p_user uuid, p_reason text, p_last_day date default current_date
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.app_user;
  v_emp public.employee;
  v_assignments int := 0;
  v_vacated int := 0;
  r record;
begin
  perform app.assert_staff_desk('staff.manage');
  if p_user = auth.uid() then
    raise exception 'CAREOS_SELF_TARGET: you cannot separate yourself' using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a separation needs a reason' using errcode = 'P0001';
  end if;

  -- Serialize with assignment/sweep paths for this caregiver (0023/0024 lock order).
  perform pg_advisory_xact_lock(hashtextextended('careos_sched:' || p_user::text, 0));

  select * into v from public.app_user
   where id = p_user and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: staff member' using errcode = 'P0001';
  end if;
  if v.status = 'separated' then
    -- Saga heads replay safely (S2-7): no duplicate events, no re-run of the steps.
    return jsonb_build_object('ok', true, 'already_separated', true);
  end if;
  perform app.assert_transition('app_user', v.status, 'separated');
  perform app.assert_not_last_admin(p_user);

  -- 1 · Access dies at commit (0022 closure + has_perm/on_care_team status keys).
  update public.app_user
     set status = 'separated', separated_at = now(),
         updated_at = now(), row_version = row_version + 1
   where id = p_user;

  -- 2 · Employment record closes.
  select * into v_emp from public.employee where id = p_user for update;
  if v_emp.id is not null and v_emp.employment_status <> 'separated' then
    perform app.assert_transition('employee', v_emp.employment_status, 'separated');
    update public.employee
       set employment_status = 'separated', updated_at = now(),
           row_version = row_version + 1
     where id = p_user;
  end if;

  -- 3 · Open care-team assignments end today, each on the ledger.
  for r in
    select a.id, a.client_id from public.care_team_assignment a
     where a.user_id = p_user and a.ends_on is null
     for update
  loop
    update public.care_team_assignment set ends_on = current_date where id = r.id;
    perform app.emit_audit('assignment.ended', 'care_team_assignment', r.id,
      jsonb_build_object('client_id', r.client_id, 'user_id', p_user,
                         'reason', 'separation'));
    v_assignments := v_assignments + 1;
  end loop;

  -- 4 · Future visits vacate unconditionally (separation ≠ credential lapse: no
  --     eligibility question, the person is simply gone).
  for r in
    select vv.id, vv.tenant_id from public.visit vv
     where vv.caregiver_id = p_user and vv.status = 'scheduled'
       and vv.scheduled_start > now()
     for update
  loop
    insert into public.schedule_exception (tenant_id, visit_id, kind, note, created_by)
    values (r.tenant_id, r.id, 'separation', left(p_reason, 200), auth.uid());
    update public.visit
       set caregiver_id = null, updated_at = now(), row_version = row_version + 1
     where id = r.id;
    v_vacated := v_vacated + 1;
  end loop;

  -- 5 · The checklist materializes; the worker (Phase 2) executes the external steps.
  insert into public.revocation_checklist (tenant_id, user_id, step)
  select v.tenant_id, p_user,
         unnest(array['auth_ban','refresh_revoke','push_invalidate',
                      'secrets_rotation','equipment_return','final_documentation'])
  on conflict (user_id, step) do nothing;

  perform app.emit_audit('identity.separated', 'app_user', p_user,
    jsonb_build_object('reason', left(p_reason, 200), 'last_day', p_last_day,
                       'assignments_ended', v_assignments, 'visits_vacated', v_vacated));
  perform app.emit_event('identity.separated', 'app_user', p_user,
    jsonb_build_object('last_day', p_last_day));

  return jsonb_build_object('ok', true, 'assignments_ended', v_assignments,
                            'visits_vacated', v_vacated, 'checklist_steps', 6);
end $$;

-- ── app.complete_revocation_step — Phase 2's write-back, human or worker ──────────────
create or replace function app.complete_revocation_step(
  p_user uuid, p_step text, p_note text default null,
  p_not_applicable boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.revocation_checklist;
  v_remaining int;
begin
  perform app.assert_staff_desk('staff.manage');
  select * into v from public.revocation_checklist
   where user_id = p_user and step = p_step and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: revocation step' using errcode = 'P0001';
  end if;
  if v.status <> 'pending' then
    return jsonb_build_object('ok', true, 'already_done', true);   -- idempotent replay
  end if;
  update public.revocation_checklist
     set status = case when p_not_applicable then 'not_applicable' else 'done' end,
         completed_by = auth.uid(), completed_at = now(), note = p_note
   where id = v.id;
  perform app.emit_audit('identity.revocation_step', 'app_user', p_user,
    jsonb_build_object('step', p_step,
                       'outcome', case when p_not_applicable then 'not_applicable' else 'done' end));

  select count(*) into v_remaining from public.revocation_checklist
   where user_id = p_user and status = 'pending';
  if v_remaining = 0 then
    -- The docs/09 §3 evidence row: revocation fully verified, on the ledger + outbox.
    perform app.emit_audit('identity.revocation_verified', 'app_user', p_user, '{}');
    perform app.emit_event('identity.revocation_verified', 'app_user', p_user, '{}');
  end if;
  return jsonb_build_object('ok', true, 'remaining', v_remaining);
end $$;

revoke all on function
  app.separate_user(uuid, text, date),
  app.complete_revocation_step(uuid, text, text, boolean)
from public, anon;
grant execute on function
  app.separate_user(uuid, text, date),
  app.complete_revocation_step(uuid, text, text, boolean)
to authenticated;
