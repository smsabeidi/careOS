-- zz_enrichment.sql — Meadowbrook operating-scale enrichment for the new domains
-- (credentials, cadence/obligations, care plans, supervisory visits, scheduled visits).
-- Loads LAST (zz*) so every referenced client/staff/type/rule already exists. Runs as
-- postgres (bypasses RLS) exactly like the other seeds; audit triggers no-op on the
-- null-tenant seed path. All data synthetic (invariant 4). Every INSERT is guarded so a
-- repeated `db reset` stays idempotent and never violates the live-obligation uniques.

-- ── 1) Credentials for active staff: each staff member gets the credential types their
--       role requires, with a deterministic expiry spread (some lapsed, some expiring
--       soon, most valid) so the expiry engine has real buckets to compute. ───────────
insert into public.credential (tenant_id, app_user_id, credential_type_id, identifier, issued_on, expires_on, status)
select u.tenant_id, u.id, ct.id,
       upper(substr(ct.key, 1, 3)) || '-' || lpad((row_number() over (order by u.id, ct.key))::text, 5, '0'),
       current_date - (spread.d + 210),
       case when ct.renewal_interval_days is null then null else current_date + spread.d end,
       case when (row_number() over (order by u.id, ct.key)) % 11 = 0 then 'pending' else 'verified' end
from public.app_user u
join public.user_role ur on ur.user_id = u.id
join public.role r on r.id = ur.role_id
join public.credential_type ct
  on ct.tenant_id = u.tenant_id
 and ( cardinality(ct.required_for_roles) = 0
       or exists (select 1 from unnest(ct.required_for_roles) x
                   where lower(x) = lower(r.key) or lower(x) = lower(r.name)) )
cross join lateral (
  select ((('x' || substr(md5(u.id::text || ct.key), 1, 4))::bit(16)::int % 460) - 60) as d
) spread
where u.status <> 'separated'
  and not exists (select 1 from public.credential c
                   where c.app_user_id = u.id and c.credential_type_id = ct.id);

-- ── 2) Live obligation worklist: open / at-risk / overdue across active clients, with a
--       due-date spread around today. Stored status='open'; the view derives the live
--       status. Guarded against the uq_obligation_live_* uniques. ────────────────────
insert into public.obligation (tenant_id, cadence_rule_id, client_id, due_on, status)
select t.tenant_id, t.rule_id, t.client_id,
       current_date + (((t.rn % 90) - 32)::int), 'open'
from (
  select c.tenant_id, cr.id as rule_id, c.id as client_id,
         row_number() over (partition by cr.id order by c.admitted_on desc, c.id) as rn
  from public.client c
  join public.cadence_rule cr
    on cr.tenant_id = c.tenant_id and cr.applies_to = 'client' and cr.active
  where c.status = 'active' and c.admitted_on is not null
    and not exists (select 1 from public.obligation o
                     where o.cadence_rule_id = cr.id and o.client_id = c.id
                       and o.status in ('open','at_risk','overdue'))
) t
where t.rn <= 55;

-- ── 3) A set of satisfied obligations (recently closed) for the "Satisfied" metric ──
insert into public.obligation (tenant_id, cadence_rule_id, client_id, due_on, status,
                               satisfied_by_entity, satisfied_at)
select t.tenant_id, t.rule_id, t.client_id,
       current_date - 20, 'satisfied', 'form_instance', now() - interval '9 days'
from (
  select c.tenant_id, cr.id as rule_id, c.id as client_id,
         row_number() over (partition by cr.id order by c.id desc) as rn
  from public.client c
  join public.cadence_rule cr
    on cr.tenant_id = c.tenant_id and cr.applies_to = 'client' and cr.active
       and cr.key = 'assessment.annual'
  where c.status = 'active' and c.admitted_on is not null
) t
where t.rn <= 24;

-- ── 4) Care plans (v1, active) + goals/interventions for the demo RN's caseload, so the
--       Clinical → Care plans tab is populated for nina@meadowbrook.demo. ─────────────
insert into public.care_plan (tenant_id, client_id, version, status, title, summary,
                              authored_by, effective_on, review_due_on)
select c.tenant_id, c.id, 1, 'active', 'Plan of care',
       'Person-centered plan focused on safe mobility, medication adherence, and skin integrity.',
       cta.user_id, c.admitted_on,
       current_date + (((row_number() over (order by c.id)) % 70 - 12)::int)
from public.client c
join public.care_team_assignment cta
  on cta.client_id = c.id and cta.role_on_case = 'rn_case_manager' and cta.ends_on is null
 and cta.user_id = (select id from auth.users where email = 'nina@meadowbrook.demo')
where c.status = 'active'
  and not exists (select 1 from public.care_plan cp where cp.client_id = c.id);

insert into public.care_plan_item (tenant_id, care_plan_id, kind, seq, text, target)
select cp.tenant_id, cp.id, v.kind, v.seq, v.txt, v.target
from public.care_plan cp
cross join (values
  ('goal', 0, 'Maintain safe mobility in the home', 'No falls; ambulates with walker'),
  ('goal', 1, 'Medication adherence', '100% of scheduled doses taken'),
  ('intervention', 2, 'Assist with ADLs and reinforce fall precautions each visit', 'Every visit'),
  ('intervention', 3, 'Weekly medication reconciliation', 'Weekly')
) as v(kind, seq, txt, target)
where cp.title = 'Plan of care'
  and not exists (select 1 from public.care_plan_item i where i.care_plan_id = cp.id);

-- ── 5) Supervisory visits (45/90/120-day) on the demo RN's caseload, mixed
--       due/overdue/completed, so the Clinical → Supervisory tab is populated. ────────
insert into public.supervisory_visit (tenant_id, client_id, rn_id, kind, status, due_on, completed_on)
select c.tenant_id, c.id,
       (select id from auth.users where email = 'nina@meadowbrook.demo'),
       (array['45_day','90_day','120_day'])[1 + (row_number() over (order by c.id)) % 3],
       case when (row_number() over (order by c.id)) % 4 = 0 then 'completed' else 'scheduled' end,
       current_date + (((row_number() over (order by c.id)) % 55 - 22)::int),
       case when (row_number() over (order by c.id)) % 4 = 0 then current_date - 4 else null end
from public.client c
join public.care_team_assignment cta
  on cta.client_id = c.id and cta.role_on_case = 'rn_case_manager' and cta.ends_on is null
 and cta.user_id = (select id from auth.users where email = 'nina@meadowbrook.demo')
where c.status = 'active'
  and not exists (select 1 from public.supervisory_visit sv where sv.client_id = c.id);

-- ── 6) Scheduled visits across this week for caregiver care teams (feeds the caregiver
--       Today screen and week coverage). Deterministic day/time spread. ──────────────
insert into public.visit (tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status)
select a.tenant_id, a.client_id, a.user_id,
       date_trunc('day', now()) + ((a.rn % 7) || ' days')::interval + ((8 + (a.rn % 7)) || ' hours')::interval,
       date_trunc('day', now()) + ((a.rn % 7) || ' days')::interval + ((10 + (a.rn % 7)) || ' hours')::interval,
       case when (a.rn % 9) = 0 then 'completed' when (a.rn % 17) = 0 then 'in_progress' else 'scheduled' end
from (
  select cta.tenant_id, cta.client_id, cta.user_id,
         row_number() over (order by cta.user_id, cta.client_id) as rn
  from public.care_team_assignment cta
  where cta.role_on_case = 'caregiver' and cta.ends_on is null
) a
where a.rn <= 130
  and not exists (
    select 1 from public.visit v
     where v.caregiver_id = a.user_id and v.client_id = a.client_id
       and v.scheduled_start >= date_trunc('day', now())
  );

-- ── 7) A guaranteed full day TODAY for the demo caregiver (dee@meadowbrook.demo) ─────
insert into public.visit (tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status)
select cta.tenant_id, cta.client_id, cta.user_id,
       date_trunc('day', now()) + ((7 + 2 * rn.n) || ' hours')::interval,
       date_trunc('day', now()) + ((8 + 2 * rn.n) || ' hours')::interval,
       case rn.n when 1 then 'completed' when 2 then 'in_progress' else 'scheduled' end
from (
  select cta.*, row_number() over (order by cta.client_id) as n
  from public.care_team_assignment cta
  join auth.users u on u.id = cta.user_id
  where u.email = 'dee@meadowbrook.demo' and cta.role_on_case = 'caregiver' and cta.ends_on is null
) cta, lateral (select cta.n) rn
where not exists (
  select 1 from public.visit v
   where v.caregiver_id = cta.user_id and v.client_id = cta.client_id
     and v.scheduled_start >= date_trunc('day', now())
     and v.scheduled_start <  date_trunc('day', now()) + interval '1 day'
);
