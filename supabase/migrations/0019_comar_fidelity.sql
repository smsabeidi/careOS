-- ST-114 · Migration 0019 — COMAR fidelity for the cadence engine (D-015, D-016)
--
-- Four defects, all found by reading COMAR 10.07.05 primary text against what the
-- engine actually encodes. Each is a correctness bug, not a preference:
--
--  (1) WRONG UNIT. COMAR 10.07.05.12 sets nursing supervision at "every 45 days"
--      (staff administers medications), "every 3 months" (staff assists with
--      self-administration), and "every 4 months" (no medication involvement).
--      The engine encoded 45/90/120 as interval_days. Three calendar months is not
--      90 days — it is 89, 90, 91 or 92 depending on where you start. For a regulatory
--      deadline the difference is a missed supervisory visit, so this migration adds a
--      real month interval rather than rounding the regulation to fit the schema.
--
--  (2) DEAD TRIGGER KINDS. trigger_kind accepts 'on_admission', 'on_event' and
--      'credential_expiry', but evaluate_compliance() implements only 'interval_days'
--      (0009:212). assessment.initial — "before receiving services", the single most
--      basic COMAR obligation — could therefore never materialize. This adds
--      'on_admission' as a one-shot obligation. 'on_event' needs an event spine and is
--      left explicitly unimplemented rather than silently half-built.
--
--  (3) NO CLOCK INJECTION. app.cadence_status is IMMUTABLE and takes p_today, but
--      evaluate_compliance() read current_date directly in four places, so temporal
--      correctness — the one property a deadline engine exists to have — was untestable.
--      The evaluator now takes p_today, defaulting to current_date so every existing
--      caller is unaffected.
--
--  (4) UNSOURCED AUTHORITY. Every seeded rule cited the placeholder
--      "Doc 02 §3 — enrich with COMAR cite", rendered to users under a "Regulation"
--      heading. This migration seeds the actual COMAR sections into the global
--      legal_authority catalog from 0013.
--
-- ⚠ VERIFICATION STATUS — READ BEFORE TRUSTING ANY CITATION BELOW.
-- These citations were read from primary COMAR text during engineering research on
-- 2026-08-02, via the third-party mirror mdrules.elaws.us. Maryland's official COMAR
-- home moved to regs.maryland.gov in March 2026 and did not respond to automated
-- retrieval, so NONE of these has been confirmed against the official source, and NO
-- licensed human has reviewed them. docs/02 — the corpus's own cited authority for every
-- COMAR reference in this codebase — is absent from the repository.
-- They are therefore seeded as review_status='unverified' with verified_by NULL and
-- source_sha256 NULL. The 0013 CHECK makes it impossible for them to claim otherwise.
-- Promotion to 'published' happens only through app.publish_authority, which requires a
-- human holding compliance.authority.publish plus a source checksum.
--
-- KNOWN OPEN CONFLICT (compliance counsel, not engineering): COMAR 10.07.05.15 states
-- 5 years' retention after discharge and cites Health-General §4-403, but the current
-- statutory text of §4-403 reads 7 years after the record is made (minors: majority + 7).
-- The two Maryland texts disagree. No retention rule is seeded here; CareOS has no
-- retention implementation at all, and inventing a number would repeat the exact defect
-- this migration exists to fix. Tracked as an escalation, not a TODO.
-- @trace: ST-114, D-015, D-016

-- ── 1. Real calendar-month intervals ───────────────────────────────────────
alter table public.cadence_rule add column interval_months int;

-- An interval rule must carry exactly one unit. Both would be ambiguous; neither
-- would make the evaluator's math partial, which 0009 already guarded against for days.
alter table public.cadence_rule
  add constraint cadence_rule_interval_unit check (
    trigger_kind <> 'interval_days'
    or num_nonnulls(interval_days, interval_months) = 1
  );

-- 0009's original guard assumed days were the only unit. Replace it rather than leave
-- two constraints disagreeing about what a valid interval rule looks like.
alter table public.cadence_rule drop constraint if exists cadence_rule_interval_present;

-- One place where a rule's period becomes an interval. IMMUTABLE + total, so it is
-- callable from the evaluator and directly unit-testable like app.cadence_status.
create or replace function app.cadence_period(p_days int, p_months int)
returns interval language sql immutable as $$
  select case
    when p_months is not null then make_interval(months => p_months)
    when p_days   is not null then make_interval(days   => p_days)
    else null
  end
$$;

-- ── 2. Evaluator: interval-aware, clock-injectable, on_admission-capable ───
-- Signature gains p_today with a default, so app.evaluate_compliance() keeps working
-- for the ops cron while tests can time-travel.
--
-- The old zero-arg function MUST be dropped first. `create or replace` with a new
-- signature OVERLOADS rather than replaces, and the two would then be ambiguous for a
-- zero-argument call — `app.evaluate_compliance()` raises
-- "function app.evaluate_compliance() is not unique", which is precisely how the ops
-- cron invokes it. 0009's own pgTAP suite caught this; leaving both would have shipped
-- a broken nightly compliance tick.
drop function if exists app.evaluate_compliance();

create or replace function app.evaluate_compliance(p_today date default current_date)
returns void language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  -- A. Satisfaction (period start now derived from the rule's real interval).
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
         and fi.updated_at >= (
               ob.due_on - coalesce(app.cadence_period(r.interval_days, r.interval_months),
                                    make_interval(days => 0))
             )::timestamptz
       order by ob.id, fi.updated_at desc, fi.id desc
    ) sat
   where o.id = sat.obligation_id;

  -- B1. Recurring interval rules.
  insert into public.obligation (tenant_id, cadence_rule_id, client_id, due_on, status)
  select c.tenant_id, r.id, c.id,
         (coalesce(
           (select max(o2.satisfied_at)::date
              from public.obligation o2
             where o2.cadence_rule_id = r.id
               and o2.client_id = c.id
               and o2.status = 'satisfied'),
           c.admitted_on
         ) + app.cadence_period(r.interval_days, r.interval_months))::date,
         'open'
    from public.cadence_rule r
    join public.client c
      on c.tenant_id = r.tenant_id
     and c.status = 'active'
     and c.admitted_on is not null
   where r.active
     and r.applies_to = 'client'
     and r.trigger_kind = 'interval_days'
     and app.cadence_period(r.interval_days, r.interval_months) is not null
     and not exists (
       select 1 from public.obligation o3
        where o3.cadence_rule_id = r.id
          and o3.client_id = c.id
          and o3.status in ('open','at_risk','overdue')
     );

  -- B2. One-shot admission rules (COMAR 10.07.05.12: assessment before services).
  -- Unlike B1 this must NOT recur: once satisfied or waived it is done for that
  -- admission, so the guard tests for ANY prior obligation, not just a live one.
  insert into public.obligation (tenant_id, cadence_rule_id, client_id, due_on, status)
  select c.tenant_id, r.id, c.id,
         (c.admitted_on + coalesce(app.cadence_period(r.interval_days, r.interval_months),
                                   make_interval(days => 0)))::date,
         'open'
    from public.cadence_rule r
    join public.client c
      on c.tenant_id = r.tenant_id
     and c.status = 'active'
     and c.admitted_on is not null
   where r.active
     and r.applies_to = 'client'
     and r.trigger_kind = 'on_admission'
     and not exists (
       select 1 from public.obligation o3
        where o3.cadence_rule_id = r.id and o3.client_id = c.id
     );

  -- C. Transition live obligations to the evaluation date's derived status.
  update public.obligation o
     set status = app.cadence_status(o.status, o.due_on, r.grace_days, r.at_risk_days, p_today),
         updated_at = now(),
         row_version = o.row_version + 1
    from public.cadence_rule r
   where r.id = o.cadence_rule_id
     and o.status in ('open','at_risk','overdue')
     and app.cadence_status(o.status, o.due_on, r.grace_days, r.at_risk_days, p_today)
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

revoke all on function app.evaluate_compliance(date) from public, anon, authenticated;
grant execute on function app.evaluate_compliance(date) to service_role;

-- ── 3. The COMAR authorities (global catalog — safe in a migration) ────────
-- These are seeded in the MIGRATION, not in supabase/seeds/, following 0008's precedent
-- of seeding its permission catalog into the migration so production has the keys.
-- legal_authority has no tenant_id, so unlike cadence_rule it needs no tenant context.
-- authority_level 4 = state administrative regulation (D-015 hierarchy).
insert into public.legal_authority
  (authority_level, jurisdiction, issuing_body, citation, title, source_url, review_status, note)
values
  (4, 'US-MD', 'Maryland Department of Health, Office of Health Care Quality',
   'COMAR 10.07.05.12', 'Services Provided',
   'https://health.maryland.gov/ohcq/Pages/Residential-Service-Agencies.aspx', 'unverified',
   'RN assessment before services / 48h high-acuity with 7-day documented exception / annual; '
   'nursing supervision 45 days, 3 months, 4 months by medication involvement; '
   'on-call 24/7 with 1-hour response and inquiry logs. Read 2026-08-02 via mdrules.elaws.us '
   'mirror; NOT confirmed against regs.maryland.gov; NOT reviewed by a licensed human.'),
  (4, 'US-MD', 'Maryland Department of Health, Office of Health Care Quality',
   'COMAR 10.07.05.14', 'Clinical Records',
   'https://health.maryland.gov/ohcq/Pages/Residential-Service-Agencies.aspx', 'unverified',
   'Twelve enumerated clinical-record elements; care notes on admission and at least weekly, '
   'on significant change, and when the care plan is modified; entries detailed, legible, '
   'chronological, dated and signed with name and title. Same verification caveat.'),
  (4, 'US-MD', 'Maryland Department of Health, Office of Health Care Quality',
   'COMAR 10.07.05.15', 'Maintenance of Records',
   'https://health.maryland.gov/ohcq/Pages/Residential-Service-Agencies.aspx', 'unverified',
   'Retention 5 years after discharge (minors: to 21 or 5 years, whichever later); discharged '
   'records completed within 30 days. ⚠ CONFLICTS with Health-General §4-403 (7 years after the '
   'record is made). Unresolved — compliance counsel must rule before any retention code ships.'),
  (4, 'US-MD', 'Maryland Department of Health, Office of Health Care Quality',
   'COMAR 10.07.05.10', 'Employee, Independent Contractor, and Contractual Employee Requirements',
   'https://health.maryland.gov/ohcq/Pages/Residential-Service-Agencies.aspx', 'unverified',
   'Pre-referral personnel file: criminal history records check, licensure/certification '
   'verification, health screening incl. tuberculosis, reference verification, employment-history '
   'verification, I-9, identity and work-eligibility verification, in-person interview, skills '
   'assessment and demonstration. Same verification caveat.'),
  (4, 'US-MD', 'Maryland Department of Health, Office of Health Care Quality',
   'COMAR 10.07.05.11', 'Training',
   'https://health.maryland.gov/ohcq/Pages/Residential-Service-Agencies.aspx', 'unverified',
   'Seven required topics; no hours or renewal interval stated in the regulation. Training by '
   'anyone other than the agency requires written OHCQ approval. Same verification caveat.');

-- ── 4. Correct the supervisory rules to the regulation''s own units ────────
-- Seeded rules live in supabase/seeds/cadence.sql (tenant-scoped, local/preview per
-- D-006). This migration corrects any that exist in ANY environment so the unit defect
-- cannot survive a reset, and is a no-op where the rows are absent (e.g. production,
-- which 0009 never seeded).
update public.cadence_rule
   set interval_months = 3, interval_days = null
 where key = 'supervisory.90d' and interval_days = 90;

update public.cadence_rule
   set interval_months = 4, interval_days = null
 where key = 'supervisory.120d' and interval_days = 120;

-- Attach the researched authority to every rule whose section is now catalogued.
update public.cadence_rule r
   set legal_authority_id = la.id
  from public.legal_authority la
 where la.jurisdiction = 'US-MD'
   and la.citation = case
         when r.key like 'assessment.%'  then 'COMAR 10.07.05.12'
         when r.key like 'supervisory.%' then 'COMAR 10.07.05.12'
         when r.key like 'carenote.%'    then 'COMAR 10.07.05.14'
         when r.key like 'oncall.%'      then 'COMAR 10.07.05.12'
       end
   and r.legal_authority_id is null;

update public.credential_type ct
   set legal_authority_id = la.id
  from public.legal_authority la
 where la.jurisdiction = 'US-MD'
   and la.citation = 'COMAR 10.07.05.10'
   and ct.legal_authority_id is null;
