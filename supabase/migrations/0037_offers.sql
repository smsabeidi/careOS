-- ST-164/165/166 · Migration 0037 — the offer entity (S4-3, S4-4, S2-8)
-- The open-shift fill loop gets its missing state machine. The review findings this
-- closes: the offer entity did not exist in the binding schema (S4-4), acceptance never
-- re-proved eligibility (S4-3), and SMS 'ACCEPT' had no lawful principal (S2-8).
-- Resolution per the ratified plan: acceptance happens IN-APP under the candidate's own
-- JWT — auth.uid() IS the principal; a per-offer signed deep link becomes sugar on top
-- when the V7-gated SMS lane arrives (token_hash column is ready for it).
-- Concurrency: accept takes the per-caregiver 'careos_sched:' advisory lock FIRST and
-- the visit row second — the same order as assign_visit (0023) and the lapse sweep
-- (0024) — then re-runs assert_schedulable inside the transaction. First accept wins;
-- the rest supersede; all-decline/expiry emits shift.fill_exhausted so a dead fill
-- never dies silently.
-- @trace: ST-164, ST-165, ST-166, S4-3, S4-4, S2-8

create table public.offer (                                 -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  candidate_user_id uuid not null references public.app_user(id),
  proposal_id uuid references public.ai_proposal(id),
  status text not null default 'notified' check (status in
    ('pending','notified','accepted','declined','expired','superseded','revoked')),
  expires_at timestamptz not null default now() + interval '2 hours',
  token_hash bytea unique,                 -- reserved for the future SMS deep link
  responded_at timestamptz,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create unique index uq_offer_live on public.offer (visit_id, candidate_user_id)
  where status in ('pending','notified');
create index idx_offer_candidate on public.offer (candidate_user_id)
  where status in ('pending','notified');
create index idx_offer_expiry on public.offer (expires_at)
  where status in ('pending','notified');

alter table public.offer enable row level security;
alter table public.offer force row level security;
create policy offer_select_scoped on public.offer for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and (candidate_user_id = auth.uid() or app.has_perm('schedule.read')));
grant select on public.offer to authenticated;
-- Writes: the RPCs below only.

-- Trigger-written transition trail (the credential_event pattern).
create table public.offer_event (                           -- OPS [AO]
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  offer_id uuid not null references public.offer(id),
  from_status text,
  to_status text not null,
  occurred_at timestamptz not null default now()
);
alter table public.offer_event enable row level security;
alter table public.offer_event force row level security;
create policy offer_event_select_scoped on public.offer_event for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and app.has_perm('schedule.read'));
grant select on public.offer_event to authenticated;
create trigger trg_offer_event_ao before update or delete on public.offer_event
  for each row execute function app.forbid_mutation();

-- AFTER, not BEFORE: the trail row FK-references the offer, which must exist first.
-- A raise from assert_transition still aborts the whole transaction, so illegal moves
-- are refused with identical force.
create or replace function app.log_offer_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.offer_event (tenant_id, offer_id, from_status, to_status)
    values (new.tenant_id, new.id, null, new.status);
  elsif new.status is distinct from old.status then
    perform app.assert_transition('offer', old.status, new.status);
    insert into public.offer_event (tenant_id, offer_id, from_status, to_status)
    values (new.tenant_id, new.id, old.status, new.status);
  end if;
  return null;
end $$;
create trigger trg_offer_transitions after insert or update on public.offer
  for each row execute function app.log_offer_event();

-- ── app.create_offers — fan out from an approved assignment proposal ──────────────────
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
  -- ai_proposal is append-only; effective status is DERIVED from the disposition trail
  -- (ai_proposal_status). A pending or rejected plan cannot fan out.
  if p_proposal is not null and not exists (
    select 1 from public.ai_proposal_status s
     where s.proposal_id = p_proposal and s.tenant_id = v_tenant
       and s.status in ('approved','edited')) then
    raise exception
      'CAREOS_NOT_APPROVED: offers fan out only from an approved plan (invariant 8)'
      using errcode = 'P0001';
  end if;

  foreach v_candidate in array p_candidates loop
    if not exists (select 1 from public.app_user u
                    where u.id = v_candidate and u.tenant_id = v_tenant
                      and u.kind = 'staff' and u.status = 'active') then
      continue;                       -- silently skip dead/foreign ids; log stays honest below
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
      perform app.queue_notification(v_candidate, 'offer.new',
        'An open visit is available — first to accept gets it',
        'offer', v_offer, 'in_app', 'offer.new:' || v_offer::text);
    end if;
  end loop;

  perform app.emit_audit('offer.fanout', 'visit', p_visit,
    jsonb_build_object('offers', v_count, 'proposal_id', p_proposal));
  perform app.emit_event('offer.fanout', 'visit', p_visit,
    jsonb_build_object('offers', v_count));
  return jsonb_build_object('ok', true, 'offers_created', v_count);
end $$;

-- ── app.accept_offer — the candidate, in-app, first-accept-wins ───────────────────────
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
  select * into v from public.offer
   where id = p_offer and candidate_user_id = auth.uid()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: offer' using errcode = 'P0001';
  end if;
  if v.status not in ('pending','notified') then
    raise exception 'CAREOS_BAD_STATE: this offer is already %', v.status using errcode = 'P0001';
  end if;
  if v.expires_at < now() then
    update public.offer set status = 'expired', responded_at = now() where id = v.id;
    raise exception 'CAREOS_EXPIRED: this offer has expired' using errcode = 'P0001';
  end if;

  -- Lock order pact (0023/0024): advisory caregiver lock FIRST, visit row second.
  perform pg_advisory_xact_lock(hashtextextended('careos_sched:' || auth.uid()::text, 0));
  select * into v_visit from public.visit where id = v.visit_id for update;
  if v_visit.caregiver_id is not null or v_visit.status <> 'scheduled' then
    update public.offer set status = 'superseded', responded_at = now() where id = v.id;
    raise exception 'CAREOS_TOO_LATE: this visit was already taken' using errcode = 'P0001';
  end if;

  -- S4-3: eligibility is proven at WRITE time, inside this transaction.
  v_guard := app.assert_schedulable(auth.uid(), v_visit.client_id,
                                    tstzrange(v_visit.scheduled_start, v_visit.scheduled_end));
  if not (v_guard ->> 'schedulable')::boolean then
    raise exception 'CAREOS_NOT_SCHEDULABLE: %', (v_guard -> 'blockers')::text
      using errcode = 'P0001';
  end if;

  update public.visit
     set caregiver_id = auth.uid(), updated_at = now(), row_version = row_version + 1
   where id = v_visit.id;   -- 0011 triggers audit it; 0027 triggers emit visit.assigned
  update public.offer set status = 'accepted', responded_at = now() where id = v.id;
  update public.offer set status = 'superseded', responded_at = now()
   where visit_id = v.visit_id and id <> v.id and status in ('pending','notified');

  return jsonb_build_object('ok', true, 'visit_id', v.visit_id);
end $$;

create or replace function app.decline_offer(p_offer uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.offer;
begin
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
  perform app.note_fill_exhaustion(v.visit_id);
  return jsonb_build_object('ok', true);
end $$;

-- All-decline / expiry detection: a fill that dies must say so (S4-3's silent case).
create or replace function app.note_fill_exhaustion(p_visit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.visit v
   where v.id = p_visit and v.caregiver_id is null and v.status = 'scheduled';
  if v_tenant is null then
    return;                                   -- filled or gone: nothing to report
  end if;
  if not exists (select 1 from public.offer o
                  where o.visit_id = p_visit and o.status in ('pending','notified')) then
    perform app.emit_event_system(v_tenant, 'shift.fill_exhausted', 'visit', p_visit, '{}');
  end if;
end $$;

create or replace function app.expire_offers() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select o.id, o.visit_id from public.offer o
     where o.status in ('pending','notified') and o.expires_at < now()
     for update skip locked
  loop
    update public.offer set status = 'expired', responded_at = now() where id = r.id;
    perform app.note_fill_exhaustion(r.visit_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

select cron.schedule('careos_offer_expiry', '*/5 * * * *',
  $$select app.run_job('offer_expiry', 300, 'select app.expire_offers()')$$);

-- ── Defense-in-depth for the revocation saga (worker finding, D-020 lane) ─────────────
-- GoTrue has no admin sign-out-by-user-id route; the ban already blocks every refresh
-- grant and 0022 strips the ≤1h access-token tail of all DB authority. This RPC goes
-- one further: hard-deletes the user's auth sessions and refresh tokens so even the
-- banned tail cannot refresh-race during clock skew. Worker-only.
create or replace function app.revoke_auth_sessions(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_sessions int;
  v_tokens int;
begin
  delete from auth.refresh_tokens where user_id = p_user::text;
  get diagnostics v_tokens = row_count;
  delete from auth.sessions where user_id = p_user;
  get diagnostics v_sessions = row_count;
  return jsonb_build_object('sessions_deleted', v_sessions, 'tokens_deleted', v_tokens);
end $$;
revoke all on function app.revoke_auth_sessions(uuid) from public, anon, authenticated;
grant execute on function app.revoke_auth_sessions(uuid) to service_role;

revoke all on function
  app.create_offers(uuid, uuid[], uuid, int),
  app.accept_offer(uuid),
  app.decline_offer(uuid),
  app.note_fill_exhaustion(uuid),
  app.expire_offers()
from public, anon;
revoke all on function app.note_fill_exhaustion(uuid), app.expire_offers()
  from authenticated;
grant execute on function
  app.create_offers(uuid, uuid[], uuid, int),
  app.accept_offer(uuid),
  app.decline_offer(uuid)
to authenticated;
