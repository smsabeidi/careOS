-- E10/S5 · Migration 0009 — compliance cadence engine: COMAR-seeded rules,
-- per-subject obligations, and a deterministic evaluator (Engine 1, never an LLM).
-- Implements: docs/07 §7 (compliance cadence engine). Follows docs/07 §1 conventions
-- and the D-007/D-011 explicit-grant + definer-only-write posture used by 0004/0005.
--
-- Naming note (surfaced for the decision log): docs/07 §7 sketches these objects as
-- `compliance_rule` / `compliance_obligation` with `subject`/`source_ref`/`due_at`.
-- This migration lands them as `cadence_rule` / `obligation` with `applies_to` /
-- `comar_source_ref` / `due_on` per the ratified 0009 contract the parallel build
-- agreed on. Semantics are identical; only the identifiers differ. Reconcile the
-- data-dictionary row (docs/07 §7) to these names, or open a decision entry to rename.
--
-- Classification:
--   * cadence_rule  — CFG (COMAR-seeded regulatory config). Tenant-readable; authored
--     only via a future admin RPC (no client write grants), like form_template.
--   * obligation    — OPS. Deliberately MUTABLE: status transitions open→at_risk→
--     overdue→satisfied are derived state, not records of consequence. The consequential
--     records are the satisfying form_version (append-only, 0005) and the audit event
--     (append-only, 0003) — so obligation carries no append-only trigger by design.
--     Writes happen only through the definer evaluator / future waiver RPC.
--
-- The evaluator derives due dates from admissions and the last satisfied obligation and
-- transitions statuses deterministically; each rule carries `comar_source_ref` so a
-- surveyor can trace software behavior to the regulation. Regulation TEXT is never
-- invented here — the reference string is a seed-time field only.
-- @trace: E10/S5, docs/07 §7 (FR compliance cadence)

-- ── cadence_rule (CFG · COMAR-seeded) ──────────────────────────────────────
create table public.cadence_rule (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,                     -- 'assessment.annual','supervisory.90d', …
  name text not null,
  applies_to text not null check (applies_to in ('client','staff')),
  trigger_kind text not null default 'interval_days' check (trigger_kind in
    ('on_admission','interval_days','on_event','credential_expiry')),
  interval_days int,                     -- 365 annual · 45/90/120 supervisory · …
  grace_days int not null default 0,     -- days past due before 'overdue' (regulatory)
  at_risk_days int not null default 14,  -- operational notice lead-time (NOT regulation)
  severity text not null default 'high' check (severity in ('info','medium','high','critical')),
  satisfied_by_template_key text,        -- form_template.key whose final instance satisfies this rule
  comar_source_ref text,                 -- 'COMAR 10.07.05.12B' — survey traceability (ref only)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  -- interval rules must carry an interval; keeps the evaluator's math total
  constraint cadence_rule_interval_present
    check (trigger_kind <> 'interval_days' or interval_days is not null)
);
create index idx_cadence_rule_tenant_active on public.cadence_rule (tenant_id) where active;

alter table public.cadence_rule enable row level security;
alter table public.cadence_rule force row level security;
create policy cadence_rule_select_tenant on public.cadence_rule for select to authenticated
  using (tenant_id = app.current_tenant_id());
grant select on public.cadence_rule to authenticated;
-- Rule authoring is a config-audited admin RPC (later story) — no write grants.

-- ── obligation (OPS · one live obligation per rule×subject) ────────────────
create table public.obligation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  cadence_rule_id uuid not null references public.cadence_rule(id),
  client_id uuid references public.client(id),      -- subject when applies_to='client'
  staff_id uuid references public.app_user(id),     -- subject when applies_to='staff'
                                                    -- (employee table lands in a later
                                                    --  migration; app_user is the stable id)
  due_on date not null,
  status text not null default 'open' check (status in
    ('open','at_risk','overdue','satisfied','waived')),
  satisfied_by_entity text,                         -- e.g. 'form_instance'
  satisfied_by_id uuid,                             -- the satisfying record's id
  satisfied_at timestamptz,
  waiver_reason text,                               -- RN-documented waiver path
  waived_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  -- exactly one subject
  constraint obligation_one_subject check (num_nonnulls(client_id, staff_id) = 1)
);
create index idx_obligation_tenant on public.obligation (tenant_id);
create index idx_obligation_rule on public.obligation (cadence_rule_id);
create index idx_obligation_client on public.obligation (client_id) where client_id is not null;
create index idx_obligation_staff on public.obligation (staff_id) where staff_id is not null;
-- Hot filter: the open/at-risk/overdue worklist ordered by due date.
create index idx_obligation_open on public.obligation (tenant_id, due_on)
  where status in ('open','at_risk','overdue');
-- At most one LIVE obligation per rule×subject → the evaluator stays idempotent.
create unique index uq_obligation_live_client on public.obligation (cadence_rule_id, client_id)
  where client_id is not null and status in ('open','at_risk','overdue');
create unique index uq_obligation_live_staff on public.obligation (cadence_rule_id, staff_id)
  where staff_id is not null and status in ('open','at_risk','overdue');

alter table public.obligation enable row level security;
alter table public.obligation force row level security;
create policy obligation_select_scoped on public.obligation for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('compliance.read')
      or (client_id is not null and app.on_care_team(client_id))
      or (staff_id is not null and staff_id = auth.uid())
    ));
grant select on public.obligation to authenticated;
-- No insert/update/delete grants: obligations are materialized and transitioned only
-- by app.evaluate_compliance (below) and, later, a documented waiver RPC (D-011 posture).

-- ── Deterministic status derivation (pure — no clock inside) ───────────────
-- Given a live obligation's dates and today, returns its derived status. IMMUTABLE
-- because today is passed in, so the value is a total function of its arguments —
-- callable safely from the security-invoker view and the evaluator alike.
create or replace function app.cadence_status(
  p_status text, p_due_on date, p_grace_days int, p_at_risk_days int, p_today date
) returns text language sql immutable as $$
  select case
    when p_status in ('satisfied','waived') then p_status
    when p_today > p_due_on + p_grace_days then 'overdue'
    when p_today >= p_due_on - p_at_risk_days then 'at_risk'
    else 'open'
  end
$$;
grant execute on function app.cadence_status(text, date, int, int, date) to authenticated;

-- ── Read view: obligations with their live derived status + timing ─────────
-- security_invoker = true → the querying user's RLS on obligation/cadence_rule
-- applies. Never expose this without that flag (it would bypass the perimeter).
create view public.cadence_obligation_status
  with (security_invoker = true) as
select
  o.id, o.tenant_id, o.cadence_rule_id, o.client_id, o.staff_id,
  o.due_on, o.status,
  o.satisfied_by_entity, o.satisfied_by_id, o.satisfied_at,
  o.updated_at,
  r.key            as rule_key,
  r.name           as rule_name,
  r.applies_to,
  r.severity,
  r.grace_days,
  r.at_risk_days,
  r.comar_source_ref,
  (o.due_on + r.grace_days)              as effective_due_on,
  (o.due_on - current_date)              as days_until_due,
  app.cadence_status(o.status, o.due_on, r.grace_days, r.at_risk_days, current_date)
                                         as computed_status
from public.obligation o
join public.cadence_rule r on r.id = o.cadence_rule_id;
grant select on public.cadence_obligation_status to authenticated;

-- ── Evaluator (Engine 1 · deterministic tick) ─────────────────────────────
-- Pure SQL/plpgsql — never an LLM (invariant 13). Runs as a system actor (cron /
-- worker), so it is SECURITY DEFINER with a pinned search_path. It:
--   A. marks live client obligations satisfied when a matching final form exists;
--   B. materializes the next obligation for active clients under interval rules
--      (idempotent: only when no live obligation exists for that rule×client);
--   C. transitions live obligations open↔at_risk↔overdue for today;
--   D. emits an ID/counts-only system audit heartbeat per tenant.
-- Staff/credential rules are generated by a later migration once employee+credential
-- tables land; today the evaluator only transitions any staff obligations that exist.
create or replace function app.evaluate_compliance()
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  -- A. Satisfaction: a live client obligation is satisfied by the most recent final
  --    form_instance for that client whose template.key matches the rule, finalized
  --    on/after the obligation's period start (due_on - interval_days). The satisfying
  --    row is picked deterministically (updated_at desc, id desc) in a derived table
  --    joined back by id — no reference to the UPDATE target inside FROM.
  update public.obligation o
     set status = 'satisfied',
         satisfied_by_entity = 'form_instance',
         satisfied_by_id = sat.instance_id,
         satisfied_at = sat.finalized_at,
         updated_at = now(),
         row_version = o.row_version + 1
    from (
      select distinct on (ob.id)
             ob.id as obligation_id, fi.id as instance_id, fi.updated_at as finalized_at
        from public.obligation ob
        join public.cadence_rule r on r.id = ob.cadence_rule_id
        join public.form_instance fi
          on fi.tenant_id = ob.tenant_id and fi.client_id = ob.client_id and fi.status = 'final'
        join public.form_template ft
          on ft.id = fi.template_id and ft.key = r.satisfied_by_template_key
       where ob.status in ('open','at_risk','overdue')
         and ob.client_id is not null
         and r.satisfied_by_template_key is not null
         and r.interval_days is not null
         and fi.updated_at >= (ob.due_on - r.interval_days)::timestamptz
       order by ob.id, fi.updated_at desc, fi.id desc
    ) sat
   where o.id = sat.obligation_id;

  -- B. Materialize the next obligation where none is live for this rule×client.
  insert into public.obligation (tenant_id, cadence_rule_id, client_id, due_on, status)
  select c.tenant_id, r.id, c.id,
         coalesce(
           (select max(o2.satisfied_at)::date
              from public.obligation o2
             where o2.cadence_rule_id = r.id
               and o2.client_id = c.id
               and o2.status = 'satisfied'),
           c.admitted_on
         ) + r.interval_days,
         'open'
    from public.cadence_rule r
    join public.client c
      on c.tenant_id = r.tenant_id
     and c.status = 'active'
     and c.admitted_on is not null
   where r.active
     and r.applies_to = 'client'
     and r.trigger_kind = 'interval_days'
     and r.interval_days is not null
     and not exists (
       select 1 from public.obligation o3
        where o3.cadence_rule_id = r.id
          and o3.client_id = c.id
          and o3.status in ('open','at_risk','overdue')
     );

  -- C. Transition live obligations to today's derived status.
  update public.obligation o
     set status = app.cadence_status(o.status, o.due_on, r.grace_days, r.at_risk_days, current_date),
         updated_at = now(),
         row_version = o.row_version + 1
    from public.cadence_rule r
   where r.id = o.cadence_rule_id
     and o.status in ('open','at_risk','overdue')
     and app.cadence_status(o.status, o.due_on, r.grace_days, r.at_risk_days, current_date)
         is distinct from o.status;

  -- D. System audit heartbeat per tenant — counts only, never PHI.
  for v_t in select distinct r.tenant_id from public.cadence_rule r where r.active loop
    perform app.emit_audit_system(
      v_t, 'system', 'cadence.evaluated', 'cadence_rule', null,
      jsonb_build_object(
        'open',    (select count(*) from public.obligation where tenant_id = v_t and status = 'open'),
        'at_risk', (select count(*) from public.obligation where tenant_id = v_t and status = 'at_risk'),
        'overdue', (select count(*) from public.obligation where tenant_id = v_t and status = 'overdue')
      ));
  end loop;
end $$;

-- System-only: no client-facing role may run the evaluator.
revoke all on function app.evaluate_compliance() from public;
grant execute on function app.evaluate_compliance() to service_role;

-- The hourly schedule is wired by ops (pg_cron is not installed in the migration
-- baseline), e.g.  select cron.schedule('careos_cadence_tick','5 * * * *',
-- $$select app.evaluate_compliance()$$);  — see careos-devops-operations.
