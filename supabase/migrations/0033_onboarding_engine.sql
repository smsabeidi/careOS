-- ST-136 · Migration 0033 — onboarding engine: the COMAR personnel file becomes a checklist
-- The deterministic spine C9 (docs/16) narrates over. Two-part model:
--   * onboarding_checklist (CFG catalog) — WHAT a title's personnel file requires.
--     One-time file items (I-9, references, interview, …) live here; expiring/verifiable
--     items stay credentials (0008) and are referenced by credential_type_key.
--   * onboarding_item (OPS) — one row per employee × requirement, human-verified.
-- Materialization is trigger-driven: an employee entering 'onboarding' gets their
-- title's items automatically (accept_invitation and every future path included).
--
-- D-015 enforcement, structural: trg_onboarding_human_verifier refuses any verifier
-- whose app_user.kind ≠ 'staff' — a Phase-2 agent identity (kind='system') can chase,
-- draft, and remind, but can never attest a personnel-file item. Same posture as
-- legal_authority.verified_by.
--
-- Catalog content: COMAR 10.07.05.10 items per the 2026-08-03 gap analysis. Every
-- source_ref enters UNVERIFIED (D-017) — the shield comes only after human promotion
-- via the legal-authority plane. The CHRC two-pathway question (Health-General
-- §19-1902 vs Board of Nursing) is catalog metadata flagged for the HR advisor, not
-- an invented citation. app.seed_onboarding_catalog(p_tenant) is the single content
-- source: this migration applies it to existing tenants; seeds/zz_onboarding.sql
-- applies it to fresh synthetic universes (the 0028 two-entry-point pattern).
-- @trace: ST-136, C9, D-015, D-017, COMAR 10.07.05.10

create table public.onboarding_checklist (                  -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,
  name text not null,
  kind text not null check (kind in ('credential','form','document','manual')),
  required_for_titles text[] not null default '{}',   -- empty ⇒ every title
  credential_type_key text,                           -- when kind='credential'
  form_template_key text,                             -- when kind='form'
  source_ref text,                                    -- COMAR cite, D-017 unverified
  advisor_note text,                                  -- open human questions (never AI-resolved)
  sort_order int not null default 100,
  active boolean not null default true,
  unique (tenant_id, key)
);
alter table public.onboarding_checklist enable row level security;
alter table public.onboarding_checklist force row level security;
create policy onboarding_checklist_select_tenant on public.onboarding_checklist
  for select to authenticated using (tenant_id = app.current_tenant_id());
grant select on public.onboarding_checklist to authenticated;

create table public.onboarding_item (                       -- OPS (PII-adjacent)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  employee_id uuid not null references public.employee(id),
  checklist_key text not null,
  status text not null default 'pending' check (status in
    ('pending','submitted','verified','waived')),
  satisfied_by_entity text,            -- 'credential' | 'form_instance' | 'document'
  satisfied_by_id uuid,
  verified_by uuid references public.app_user(id),    -- HUMAN — trigger-enforced
  verified_at timestamptz,
  waiver_reason text,
  waived_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  unique (employee_id, checklist_key)
);
create index idx_onboarding_item_tenant on public.onboarding_item (tenant_id)
  where status in ('pending','submitted');

alter table public.onboarding_item enable row level security;
alter table public.onboarding_item force row level security;
create policy onboarding_item_select_scoped on public.onboarding_item
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and (employee_id = auth.uid()
              or app.has_perm('staff.manage')
              or app.has_perm('credential.read.all')));
grant select on public.onboarding_item to authenticated;
-- Writes: RPCs below only.

-- Lawful item moves (global transition catalog, S1-4 pattern).
insert into public.state_transition (entity, from_state, to_state) values
  ('onboarding_item', 'pending',   'submitted'),
  ('onboarding_item', 'pending',   'verified'),
  ('onboarding_item', 'submitted', 'verified'),
  ('onboarding_item', 'pending',   'waived'),
  ('onboarding_item', 'submitted', 'waived')
on conflict do nothing;

-- ── D-015, structural: only a human staff member can verify or waive ──────────────────
create or replace function app.guard_human_verifier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.verified_by is not null and not exists
     (select 1 from public.app_user u where u.id = new.verified_by and u.kind = 'staff') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: personnel-file items are verified by people, not systems'
      using errcode = 'P0001';
  end if;
  if new.waived_by is not null and not exists
     (select 1 from public.app_user u where u.id = new.waived_by and u.kind = 'staff') then
    raise exception
      'CAREOS_HUMAN_REQUIRED: personnel-file waivers come from people, not systems'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_onboarding_human_verifier
  before insert or update on public.onboarding_item
  for each row execute function app.guard_human_verifier();

-- ── Materialization ───────────────────────────────────────────────────────────────────
create or replace function app.materialize_onboarding(p_employee uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_emp public.employee;
  v_count int;
begin
  select * into v_emp from public.employee where id = p_employee;
  if v_emp.id is null then
    raise exception 'CAREOS_NOT_FOUND: employee' using errcode = 'P0001';
  end if;
  insert into public.onboarding_item (tenant_id, employee_id, checklist_key)
  select v_emp.tenant_id, v_emp.id, c.key
    from public.onboarding_checklist c
   where c.tenant_id = v_emp.tenant_id and c.active
     and (cardinality(c.required_for_titles) = 0
          or v_emp.role_title = any (c.required_for_titles))
  on conflict (employee_id, checklist_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.materialize_onboarding(uuid) from public, anon, authenticated;

-- Trigger: entering 'onboarding' materializes the file (accept_invitation included).
create or replace function app.onboarding_on_employee() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.employment_status = 'onboarding'
     and (tg_op = 'INSERT' or old.employment_status is distinct from new.employment_status) then
    perform app.materialize_onboarding(new.id);
    if app.current_tenant_id() is not null then
      perform app.emit_audit('onboarding.started', 'employee', new.id, '{}');
      perform app.emit_event('onboarding.started', 'employee', new.id, '{}');
    end if;
  end if;
  return null;
end $$;
create trigger trg_onboarding_on_employee after insert or update on public.employee
  for each row execute function app.onboarding_on_employee();

-- Explicit re-materialization (catalog grew, backfilled hires) — desk-callable.
create or replace function app.start_onboarding(p_employee uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_added int;
begin
  perform app.assert_staff_desk('staff.manage');
  if not exists (select 1 from public.employee e
                 where e.id = p_employee and e.tenant_id = app.current_tenant_id()) then
    raise exception 'CAREOS_NOT_FOUND: employee' using errcode = 'P0001';
  end if;
  v_added := app.materialize_onboarding(p_employee);
  return jsonb_build_object('ok', true, 'items_added', v_added);
end $$;

-- ── Item completion + waiver ──────────────────────────────────────────────────────────
create or replace function app.complete_onboarding_item(
  p_employee uuid, p_checklist_key text,
  p_satisfied_by_entity text default null, p_satisfied_by_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.onboarding_item;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required' using errcode = '42501';
  end if;
  if not (app.has_perm('staff.manage') or app.has_perm('credential.write')) then
    raise exception 'CAREOS_FORBIDDEN: staff.manage or credential.write is required'
      using errcode = '42501';
  end if;
  select * into v from public.onboarding_item
   where employee_id = p_employee and checklist_key = p_checklist_key
     and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: onboarding item' using errcode = 'P0001';
  end if;
  if v.status in ('verified','waived') then
    return jsonb_build_object('ok', true, 'already_closed', true);
  end if;
  perform app.assert_transition('onboarding_item', v.status, 'verified');
  update public.onboarding_item
     set status = 'verified', verified_by = auth.uid(), verified_at = now(),
         satisfied_by_entity = coalesce(p_satisfied_by_entity, satisfied_by_entity),
         satisfied_by_id = coalesce(p_satisfied_by_id, satisfied_by_id),
         updated_at = now(), row_version = row_version + 1
   where id = v.id;
  perform app.emit_audit('onboarding.item_completed', 'onboarding_item', v.id,
    jsonb_build_object('employee_id', p_employee, 'checklist_key', p_checklist_key));
  if not exists (select 1 from public.onboarding_item i
                  where i.employee_id = p_employee and i.status in ('pending','submitted')) then
    perform app.emit_audit('onboarding.completed', 'employee', p_employee, '{}');
    perform app.emit_event('onboarding.completed', 'employee', p_employee, '{}');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function app.waive_onboarding_item(
  p_employee uuid, p_checklist_key text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.onboarding_item;
begin
  perform app.assert_staff_desk('staff.manage');
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: a waiver needs a documented reason'
      using errcode = 'P0001';
  end if;
  select * into v from public.onboarding_item
   where employee_id = p_employee and checklist_key = p_checklist_key
     and tenant_id = app.current_tenant_id()
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: onboarding item' using errcode = 'P0001';
  end if;
  perform app.assert_transition('onboarding_item', v.status, 'waived');
  update public.onboarding_item
     set status = 'waived', waived_by = auth.uid(), waiver_reason = p_reason,
         updated_at = now(), row_version = row_version + 1
   where id = v.id;
  perform app.emit_audit('onboarding.item_waived', 'onboarding_item', v.id,
    jsonb_build_object('employee_id', p_employee, 'checklist_key', p_checklist_key));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function
  app.start_onboarding(uuid),
  app.complete_onboarding_item(uuid, text, text, uuid),
  app.waive_onboarding_item(uuid, text, text)
from public, anon;
grant execute on function
  app.start_onboarding(uuid),
  app.complete_onboarding_item(uuid, text, text, uuid),
  app.waive_onboarding_item(uuid, text, text)
to authenticated;

-- ── The completeness engine (pure SQL, never LLM — invariant 13) ──────────────────────
create or replace view public.employee_file_status
with (security_invoker = true) as
select e.id as employee_id,
       e.tenant_id,
       e.role_title,
       e.employment_status,
       count(i.id)::int as items_total,
       count(i.id) filter (where i.status in ('verified','waived'))::int as items_closed,
       coalesce(array_agg(i.checklist_key order by i.checklist_key)
                filter (where i.status in ('pending','submitted')), '{}') as items_open,
       (count(i.id) filter (where i.status in ('pending','submitted')) = 0) as file_complete
  from public.employee e
  left join public.onboarding_item i on i.employee_id = e.id
 group by e.id, e.tenant_id, e.role_title, e.employment_status;
grant select on public.employee_file_status to authenticated;

-- ── The catalog content (single source, two entry points — 0028 pattern) ──────────────
create or replace function app.seed_onboarding_catalog(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_clinical text[] := array['RN','LPN','CNA','HHA'];
begin
  insert into public.onboarding_checklist
    (tenant_id, key, name, kind, required_for_titles, credential_type_key,
     source_ref, advisor_note, sort_order)
  values
    (p_tenant, 'interview',            'In-person interview',                'manual',
      '{}', null, 'COMAR 10.07.05.10', null, 10),
    (p_tenant, 'identity_eligibility', 'Identity & work-eligibility (I-9)',  'document',
      '{}', null, 'COMAR 10.07.05.10', null, 20),
    (p_tenant, 'employment_history',   'Employment history',                 'document',
      '{}', null, 'COMAR 10.07.05.10', null, 30),
    (p_tenant, 'reference_1',          'Professional reference #1',          'document',
      '{}', null, 'COMAR 10.07.05.10', null, 40),
    (p_tenant, 'reference_2',          'Professional reference #2',          'document',
      '{}', null, 'COMAR 10.07.05.10', null, 41),
    (p_tenant, 'chrc_background',      'Criminal history records check',     'credential',
      '{}', 'background_check', 'COMAR 10.07.05.10',
      'TWO statutory pathways exist (Health-General §19-1902 vs Board of Nursing CHRC); '
      || 'which applies per title is an open HR-advisor question — do not auto-resolve.', 50),
    (p_tenant, 'tb_screening',         'TB screening (baseline)',            'credential',
      v_clinical, 'tb_screen', 'COMAR 10.07.05.11', null, 60),
    (p_tenant, 'cpr_certification',    'CPR certification',                  'credential',
      v_clinical, 'cpr', 'COMAR 10.07.05.11', null, 70),
    (p_tenant, 'licensure_verification', 'License verification with the Board', 'credential',
      '{RN,LPN}', 'rn_license', 'COMAR 10.07.05.10', null, 80),
    (p_tenant, 'skills_demonstration', 'Skills demonstration',               'manual',
      v_clinical, null, 'COMAR 10.07.05.10', null, 90)
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.seed_onboarding_catalog(uuid) from public, anon, authenticated;

-- Existing tenants get the catalog now; fresh universes via seeds/zz_onboarding.sql.
select app.seed_onboarding_catalog(t.id) from public.tenant t;
