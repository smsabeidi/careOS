-- ST-131 · Migration 0028 — public.employee: the HR spine's anchor (docs/07 §8)
-- DN-0008a's promised expand lands: every employee IS an app_user (1:1 by id), so no
-- credential/cadence backfill is needed — credential.app_user_id and obligation.staff_id
-- already point at the stable id. app_user stays the ACCESS record (status kills
-- permissions, 0022); employee is the EMPLOYMENT record (titles, hire date, HR status).
-- The two status fields are deliberately independent: access-suspending someone does not
-- rewrite their employment history, and an 'onboarding' hire can hold an active login.
--
-- DN-0028a (surfaced deviation): docs/07 §8 lists care-delivery titles only
-- ('RN','LPN','CNA','HHA','Coordinator'), but kind='staff' includes owner/admin/HR who
-- need a lawful NOT NULL title. 'Office' is added as a deliberately non-clinical title:
-- cadence and credential requirements key off clinical titles and required_for_roles,
-- so 'Office' attracts no clinical obligations. Proposed for the docs/07 §8 dictionary
-- in the same PR; flagged for the decision log rather than silently diverging.
--
-- Backfill: app.backfill_employees() is a reusable definer helper (no grants) called
-- here for already-populated databases (hosted `db push`) and by the
-- seeds/zz_employees.sql seed for fresh synthetic universes. Title mapping is a
-- role-key heuristic (rn→RN, coordinator→Coordinator, caregiver→HHA, else Office) and
-- hire_date falls back to app_user.created_at — the earliest provable date. Both are
-- flagged here as review-items for the onboarding tracker, not silent truth.
-- @trace: ST-131, DN-0008a, docs/07 §8

create table public.employee (                             -- PII
  id uuid primary key references public.app_user(id),
  tenant_id uuid not null references public.tenant(id),
  role_title text not null check (role_title in
    ('RN','LPN','CNA','HHA','Coordinator','Office')),      -- DN-0028a
  hire_date date not null,
  employment_status text not null default 'active' check (employment_status in
    ('candidate','onboarding','active','leave','separated')),
  medication_involvement text not null default 'none' check (medication_involvement in
    ('administers','assists_self_admin','none')),   -- drives 45/90/120 cadence
  supervisor_id uuid references public.app_user(id),
  updated_at timestamptz not null default now(),
  row_version int not null default 1
);
create index idx_employee_tenant on public.employee (tenant_id);
create index idx_employee_status on public.employee (tenant_id, employment_status);

alter table public.employee enable row level security;
alter table public.employee force row level security;

-- Read (PII ⇒ AAL2): your own employment record, the staff-lifecycle desk
-- (staff.manage), or the credential wall's readers (credential.read.all — coordinators
-- and HR already hold it and need titles to reason about requirements). Deliberately
-- NOT user.read: the directory shows people; the employment record is HR's.
create policy employee_select_scoped on public.employee for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and (id = auth.uid()
              or app.has_perm('staff.manage')
              or app.has_perm('credential.read.all')));
grant select on public.employee to authenticated;
-- Writes: Lane-B only (app.update_employee and the lifecycle RPCs, 0030+). No grants.

-- ── Reusable backfill (definer, no grants — migration/seed plumbing) ──────────────────
create or replace function app.backfill_employees() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  insert into public.employee (id, tenant_id, role_title, hire_date, employment_status)
  select u.id, u.tenant_id,
         coalesce((
           select case r.key
                    when 'rn' then 'RN'
                    when 'coordinator' then 'Coordinator'
                    when 'caregiver' then 'HHA'
                  end
             from public.user_role ur
             join public.role r on r.id = ur.role_id
            where ur.user_id = u.id and r.key in ('rn','coordinator','caregiver')
            order by case r.key when 'rn' then 1 when 'coordinator' then 2 else 3 end
            limit 1), 'Office'),
         coalesce(u.created_at::date, current_date),
         case u.status
           when 'separated' then 'separated'
           when 'invited'   then 'onboarding'
           else 'active'
         end
    from public.app_user u
   where u.kind = 'staff'
     and not exists (select 1 from public.employee e where e.id = u.id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.backfill_employees() from public, anon, authenticated;

select app.backfill_employees();   -- no-op on a fresh database; repairs a populated one
