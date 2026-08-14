-- W-ONB · Migration 0058 — onboarding_milestone: the first-run progress ledger
-- The first-run welcome surface (/welcome) is guided REAL work, not a tour: docs/14 §6's
-- ratified training doctrine is "learning by doing real work", so the checklist points at
-- live surfaces and the only thing this plane stores is WHICH steps a person has already
-- been through. That is a per-user fact about a person's own account — no client, no
-- visit, no clinical content — so the table holds a user id, a closed enum and a
-- timestamp, and nothing else (invariant 5: a milestone name is not PHI and never
-- becomes one).
--
-- Shape and posture are lifted from 0054_alert_ack.sql, the modern per-user append-only
-- pattern: (tenant_id, user_id, milestone) unique, so a second tap is an ON CONFLICT
-- no-op and idempotency is a RETURN VALUE rather than an error (the 0023 posture).
-- APPEND-ONLY (invariant 1): "un-completing" onboarding does not exist. A person who
-- wants the welcome screen again is a product question for a future story, and the
-- honest answer is a new row type, never an UPDATE or a DELETE of the record that says
-- they were already here.
--
-- Reads and writes both go through definer RPCs and the table carries NO client grants
-- at all — not even SELECT (the 0027 domain_event posture). The self-only SELECT policy
-- below is therefore dead code today ON PURPOSE: it is the safety net that keeps a
-- future migration's careless `grant select` from turning a per-user ledger into a
-- tenant-wide one. RLS is the perimeter, grants are the door, and both are shut.
--
-- Both RPCs require app.is_aal2(). The milestone rows are not PHI, but /welcome is an
-- authenticated post-MFA surface and the AAL1 answer must be a REFUSAL, not an empty
-- list: a silent empty would let the first-run screen tell someone "nothing to do here"
-- when the truth is "your session is not verified yet" (docs/10 §8, the AAL1-probe rule).
-- That is why app.my_onboarding_milestones raises instead of filtering.
--
-- The surface ships dark: app.seed_onboarding_flags writes `onboarding.welcome` as an
-- EXPLICIT disabled row with a stated reason (the 0052/0057 idiom — a row is the switch,
-- a call-site default is only a fallback), and the flip is an owner's audited act
-- through app.set_feature_flag, never a migration default. The proposed decision that
-- governs the surface (PD-5, docs/00 §3) is not ratified; nothing here self-ratifies it.
-- @trace: W-ONB, docs/14 §6, docs/10 §8, invariant 1, invariant 5, invariant 7, D-018, D-019

create table public.onboarding_milestone (                             -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  user_id uuid not null references public.app_user(id),
  -- Closed allowlist: the five first-run steps the /welcome checklist can record. A
  -- typo'd caller cannot invent a sixth step that no surface ever reads, and widening
  -- the list is an expand-phase CHECK change with its own story.
  milestone text not null check (milestone in
    ('welcome_completed','welcome_skipped','step_language','step_home_screen',
     'step_first_look')),
  recorded_at timestamptz not null default now(),
  constraint uq_onboarding_milestone unique (tenant_id, user_id, milestone)
);
-- No second index: uq_onboarding_milestone's implicit index is (tenant_id, user_id,
-- milestone), and both RPCs filter on the (tenant_id, user_id) prefix. A redundant index
-- would only cost writes.

create trigger trg_onboarding_milestone_ao before update or delete on public.onboarding_milestone
  for each row execute function app.forbid_mutation();

alter table public.onboarding_milestone enable row level security;
alter table public.onboarding_milestone force row level security;

-- Your own progress, full stop — see the header: no grants accompany this policy, so it
-- is a floor under any future read grant rather than a door of its own.
create policy onboarding_milestone_select_own on public.onboarding_milestone
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = auth.uid());

-- Deliberately zero client grants: app.record_onboarding_milestone is the only writer and
-- app.my_onboarding_milestones is the only reader.

-- ── app.record_onboarding_milestone — the one way to record first-run progress ────────
-- Self-only by construction: the row is written for auth.uid(), never for a parameter,
-- so "mark somebody else's onboarding done" is not expressible. Tenancy comes from
-- app.current_tenant_id(), which fails closed for separated or suspended principals
-- (0022). The audit event is invariant 7: skipping the welcome is a consequential act
-- (it is the difference between "was never offered the tour" and "chose to skip it"),
-- and the answer lives on the ledger, in the same transaction as the row.
create or replace function app.record_onboarding_milestone(p_milestone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_id uuid;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required'
      using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: an active principal is required'
      using errcode = 'P0001';
  end if;
  -- The allowlist is stated twice on purpose (the 0054 posture): the CHECK is the
  -- structural floor, this guard is what gives the caller a CAREOS_* code instead of a
  -- raw constraint violation. Both lists move together or neither moves.
  if p_milestone is null or p_milestone not in
     ('welcome_completed','welcome_skipped','step_language','step_home_screen',
      'step_first_look') then
    raise exception 'CAREOS_BAD_MILESTONE: % is not a first-run milestone', p_milestone
      using errcode = 'P0001';
  end if;

  insert into public.onboarding_milestone (tenant_id, user_id, milestone)
  values (v_tenant, auth.uid(), p_milestone)
  on conflict on constraint uq_onboarding_milestone do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', true, 'unchanged', true, 'milestone', p_milestone);
  end if;

  perform app.emit_audit('onboarding.milestone', 'onboarding_milestone', v_id,
    jsonb_build_object('milestone', p_milestone));

  return jsonb_build_object('ok', true, 'unchanged', false, 'milestone_id', v_id,
                            'milestone', p_milestone);
end $$;
revoke all on function app.record_onboarding_milestone(text) from public, anon;
grant execute on function app.record_onboarding_milestone(text) to authenticated;

-- ── app.my_onboarding_milestones — the caller's own progress, as plain strings ────────
-- setof text, not the row: the surface needs "which steps are done", and IDs and
-- timestamps it never renders are egress it does not need (invariant 5). AAL1 RAISES
-- rather than returning zero rows, so the client can tell "not verified yet" apart from
-- "no progress yet" and never shows an honest-looking empty for an auth reason.
create or replace function app.my_onboarding_milestones() returns setof text
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required'
      using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: an active principal is required'
      using errcode = 'P0001';
  end if;
  return query
    select m.milestone
      from public.onboarding_milestone m
     where m.tenant_id = v_tenant and m.user_id = auth.uid()
     order by m.milestone;
end $$;
revoke all on function app.my_onboarding_milestones() from public, anon;
grant execute on function app.my_onboarding_milestones() to authenticated;

-- ── The dark flag (0057 seed_front_door_flags idiom) ──────────────────────────────────
-- An explicit row, because app.feature_enabled(key, default) resolves an ABSENT row to
-- the caller's default: the row is what makes "off, and here is why" a fact in the
-- database that an owner can read, audit and flip, rather than an assumption in code.
create or replace function app.seed_onboarding_flags(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  insert into public.feature_flag (tenant_id, key, enabled, disabled_reason, updated_by)
  select p_tenant, f.key, false, f.reason, null::uuid
  from (values
    ('onboarding.welcome',
     'Dark until PD-5 is ratified and the Front Door soak clears.')
  ) as f(key, reason)
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.seed_onboarding_flags(uuid) from public, anon, authenticated;

-- app.feature_enabled(text, boolean) is the read side every surface calls; 0026 granted
-- EXECUTE on it to authenticated and nothing since has revoked it (verified against the
-- live schema, and asserted permanently in tests/database/0058_user_onboarding.sql), so
-- no grant is restated here. The assertion is the durable guard, not this comment.

-- Existing tenants get the dark flag now; fresh synthetic universes get it from the
-- seed layer (see the seeds/zz_verified_visit.sql tail, where the 0057 seeders are
-- invoked after the Meadowbrook tenants exist).
select app.seed_onboarding_flags(t.id) from public.tenant t;
