-- ST-124/125/126 · Migration 0026 — RBAC repairs, transition guard, kill switches
-- A) Repairs the grant drift the identity audit found: family.manage and
--    compliance.authority.publish were granted to NO role (publish_authority was
--    uncallable by anyone), admin lacked the form permissions its surfaces assume, and
--    the staff-lifecycle RPC set (Phase 1) needs its permission vocabulary. Wiring is by
--    role KEY across every tenant's system roles (idempotent), so already-seeded hosted
--    databases are repaired by `db push` while fresh environments also get it from
--    seed.sql. Like all seed wiring, these are config rows outside a user session — no
--    audit events exist for them (the identity write plane in Phase 1 makes role grants
--    audited, RPC-only actions from then on).
-- B) app.assert_transition + the global state_transition catalog (S1-4): state machines
--    become transition-constrained, not just value-constrained. Phase-1+ RPCs call it
--    before every status write.
-- C) public.feature_flag (S9-4): the DB-backed kill switch the automation runtime
--    (Phase 2+) checks on every loop; writes only via the audited RPC.
-- @trace: ST-124, ST-125, ST-126, S1-4, S9-4

-- ═══ A · Permission vocabulary + grant repairs ════════════════════════════════════════
insert into public.permission (key, description) values
  ('staff.manage',    'Invite, update, suspend, and separate staff'),
  ('careteam.manage', 'Create and end care-team assignments'),
  ('document.write',  'Record documents into the document store'),
  ('platform.manage', 'Operate platform controls — feature flags and kill switches')
on conflict (key) do nothing;

insert into public.role_permission (role_id, permission_key)
select r.id, v.perm
from public.role r
join lateral (values
  -- Owner: the full command surface, including the two orphaned grants.
  ('owner',       'staff.manage'), ('owner', 'careteam.manage'), ('owner', 'document.write'),
  ('owner',       'platform.manage'), ('owner', 'audit.read'), ('owner', 'family.manage'),
  ('owner',       'compliance.authority.publish'),
  -- Admin: parity with the surfaces it guards (missing form perms), plus lifecycle ops.
  ('admin',       'staff.manage'), ('admin', 'careteam.manage'), ('admin', 'document.write'),
  ('admin',       'audit.read'),   ('admin', 'form.write.all'),  ('admin', 'form.finalize'),
  ('admin',       'form.correct'),
  -- Coordinator: runs the day — assignments and family communication.
  ('coordinator', 'careteam.manage'), ('coordinator', 'family.manage'),
  -- HR: the staff file — invitations and documents.
  ('hr',          'staff.manage'), ('hr', 'document.write')
) as v(role_key, perm) on v.role_key = r.key
where r.is_system
on conflict do nothing;

-- ═══ B · Transition-constrained state machines (S1-4) ═════════════════════════════════
create table public.state_transition (                              -- CFG (global catalog)
  entity     text not null,
  from_state text not null,
  to_state   text not null,
  primary key (entity, from_state, to_state)
);
alter table public.state_transition enable row level security;
alter table public.state_transition force row level security;
create policy state_transition_select_all on public.state_transition
  for select to authenticated using (true);
grant select on public.state_transition to authenticated;

insert into public.state_transition (entity, from_state, to_state) values
  -- app_user.status — the access kill switch (0022 closure keys off 'active')
  ('app_user',   'invited',    'active'),
  ('app_user',   'active',     'suspended'),
  ('app_user',   'suspended',  'active'),
  ('app_user',   'active',     'separated'),
  ('app_user',   'suspended',  'separated'),
  -- employee.employment_status (docs/07 §8; table lands in Phase 1)
  ('employee',   'candidate',  'onboarding'),
  ('employee',   'onboarding', 'active'),
  ('employee',   'onboarding', 'separated'),
  ('employee',   'active',     'leave'),
  ('employee',   'leave',      'active'),
  ('employee',   'active',     'separated'),
  ('employee',   'leave',      'separated'),
  -- invitation.status (Phase 1)
  ('invitation', 'pending',    'accepted'),
  ('invitation', 'pending',    'expired'),
  ('invitation', 'pending',    'revoked'),
  -- offer.status (Phase 3, S4-4 entity)
  ('offer',      'pending',    'notified'),
  ('offer',      'pending',    'expired'),
  ('offer',      'pending',    'revoked'),
  ('offer',      'pending',    'superseded'),
  ('offer',      'notified',   'accepted'),
  ('offer',      'notified',   'declined'),
  ('offer',      'notified',   'expired'),
  ('offer',      'notified',   'superseded'),
  -- obligation.status (0009 evaluator's moves)
  ('obligation', 'open',       'at_risk'),
  ('obligation', 'open',       'overdue'),
  ('obligation', 'open',       'satisfied'),
  ('obligation', 'open',       'waived'),
  ('obligation', 'at_risk',    'overdue'),
  ('obligation', 'at_risk',    'satisfied'),
  ('obligation', 'at_risk',    'waived'),
  ('obligation', 'overdue',    'satisfied'),
  ('obligation', 'overdue',    'waived'),
  -- visit.status (0011/0013 moves, documented here for adopting RPCs)
  ('visit',      'scheduled',  'in_progress'),
  ('visit',      'scheduled',  'missed'),
  ('visit',      'scheduled',  'cancelled'),
  ('visit',      'in_progress','completed');

create or replace function app.assert_transition(p_entity text, p_from text, p_to text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  -- p_from null = initial state assignment; the CHECK constraint owns value validity.
  if p_from is null or p_from = p_to then
    return;
  end if;
  if not exists (select 1 from public.state_transition
                  where entity = p_entity and from_state = p_from and to_state = p_to) then
    raise exception 'CAREOS_INVALID_TRANSITION: % may not move from % to %',
      p_entity, p_from, p_to using errcode = 'P0001';
  end if;
end $$;
revoke all on function app.assert_transition(text, text, text) from public, anon;
grant execute on function app.assert_transition(text, text, text) to authenticated;

-- ═══ C · feature_flag — the DB-backed kill switch (S9-4) ══════════════════════════════
create table public.feature_flag (                                  -- CFG
  tenant_id       uuid not null references public.tenant(id),
  key             text not null,
  enabled         boolean not null default true,
  disabled_reason text,
  updated_by      uuid references public.app_user(id),
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, key)
);
alter table public.feature_flag enable row level security;
alter table public.feature_flag force row level security;
create policy feature_flag_select_tenant on public.feature_flag
  for select to authenticated using (tenant_id = app.current_tenant_id());
grant select on public.feature_flag to authenticated;
-- No write grants: app.set_feature_flag is the only pen.

create or replace function app.set_feature_flag(
  p_key text, p_enabled boolean, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to flip a flag'
      using errcode = '42501';
  end if;
  if not app.has_perm('platform.manage') then
    raise exception 'CAREOS_FORBIDDEN: platform.manage is required' using errcode = '42501';
  end if;
  if not p_enabled and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'CAREOS_REASON_REQUIRED: disabling a feature needs a reason'
      using errcode = 'P0001';
  end if;
  insert into public.feature_flag (tenant_id, key, enabled, disabled_reason, updated_by, updated_at)
  values (v_tenant, p_key, p_enabled, case when p_enabled then null else p_reason end, auth.uid(), now())
  on conflict (tenant_id, key) do update
    set enabled = excluded.enabled,
        disabled_reason = excluded.disabled_reason,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  perform app.emit_audit('config.feature_flag', 'feature_flag', null,
    jsonb_build_object('key', p_key, 'enabled', p_enabled));
  return jsonb_build_object('key', p_key, 'enabled', p_enabled);
end $$;
revoke all on function app.set_feature_flag(text, boolean, text) from public, anon;
grant execute on function app.set_feature_flag(text, boolean, text) to authenticated;

-- Read helper for RPCs and workers: absent flag = the given default (features ship ON
-- unless a story says otherwise; agents pass false so autonomy is opt-in).
create or replace function app.feature_enabled(p_key text, p_default boolean default true)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select enabled from public.feature_flag
      where tenant_id = app.current_tenant_id() and key = p_key),
    p_default)
$$;
revoke all on function app.feature_enabled(text, boolean) from public, anon;
grant execute on function app.feature_enabled(text, boolean) to authenticated;
