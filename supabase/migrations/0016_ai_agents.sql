-- Migration 0016 — the AI action plane (docs/16 Waves 2–5): the approvals-inbox spine,
-- document extraction with human acceptance, the durable coordination-agent runtime,
-- clinical early-warning flags, surveyor evidence packets, and the two deterministic
-- engines that keep the model out of eligibility and money decisions.
--
-- What this migration is for, in one line per wave:
--   Wave 2 (the chase engine)   → ai_proposal + ai_proposal_event + ai_proposal_status
--   Wave 3 (paper becomes chart)→ extraction_job + extraction_field
--   Wave 4 (coordination agent) → agent_task + agent_step + app.rank_fill_candidates
--                                 + app.denial_risk
--   Wave 5 (clinical + glass office) → clinical_flag + evidence_packet
--
-- Invariants enforced here:
--   * Invariant 1 (append-only): every table is a record of consequence. ai_proposal,
--     ai_proposal_event, extraction_job's extracted values, agent_task/agent_step,
--     clinical_flag's finding, and evidence_packet are immutable once written. A
--     proposal is NEVER updated to say "approved" — a disposition is a NEW row in
--     ai_proposal_event, and public.ai_proposal_status derives the current state. The
--     three places where a bounded, column-scoped UPDATE exists (extraction_field's
--     human acceptance, agent_task.status, extraction_job.status, clinical_flag.status)
--     follow the knowledge_chunk.embedding precedent from 0015: a column-scoped GRANT
--     plus a guard trigger that raises CAREOS_APPEND_ONLY if any other column moves —
--     so the RECORD stays immutable while the human's disposition lands.
--   * Invariant 2 (RLS is the perimeter): every table is enable + force RLS, explicit
--     grants only, one policy per operation.
--   * Invariant 3 (AAL2 for PHI): proposals carry drafted content about named clients
--     and staff; extraction fields carry chart data; clinical flags are clinical. Every
--     policy on those tables requires app.is_aal2().
--   * Invariant 5 (no PHI sideways): audit payloads here carry IDs, enums and counts —
--     never a title, body, note, extracted value, summary, or source file name.
--   * Invariant 8 (AI proposes, a licensed human disposes): a proposal cannot execute
--     itself. Execution is an ai_proposal_event whose actor is DB-pinned to auth.uid();
--     there is no path that writes a disposition on someone else's behalf, and no
--     path that writes one without a human session at all.
--   * Invariant 13 (deterministic vs probabilistic): app.rank_fill_candidates is the
--     ONLY answer to "who may take this shift" — it delegates every eligibility verdict
--     to app.assert_schedulable (0011) and returns the blockers verbatim. app.denial_risk
--     is a pure completeness gate. Neither is ever asked of a model; the model receives
--     their output as ground truth and writes outreach copy around it.
-- @trace: docs/16 §2 (C1,C3,C4,C5,C6,C7,O1,O2,R2,R3,R6,X4,B2,F1), docs/16 §4 Waves 2–5,
--         docs/07 §1 conventions, invariants 1/2/3/5/8/13

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0. Shared guards (definer-free; trigger-only, never granted — 0001/0007 posture)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Bounded-mutation guard for [AO] tables that carry exactly one human-writable
-- disposition column set. Any change outside the trigger's argument list raises
-- CAREOS_APPEND_ONLY — even for a table owner or superuser, exactly like
-- app.forbid_mutation(). The privilege layer (column-scoped GRANT) refuses first for
-- `authenticated`; this is the layer underneath it.
create or replace function app.guard_columns_only() returns trigger
language plpgsql as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  k text;
begin
  foreach k in array tg_argv loop
    v_old := v_old - k;
    v_new := v_new - k;
  end loop;
  if v_old is distinct from v_new then
    raise exception
      'CAREOS_APPEND_ONLY: % is append-only — on an existing row only (%) may be written',
      tg_table_name, array_to_string(tg_argv, ', ')
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function app.guard_columns_only() from public;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ai_proposal [AO] (PHI) — the approvals-inbox spine (docs/16 Wave 2)
-- ═══════════════════════════════════════════════════════════════════════════════
-- One row per thing the AI proposes a human should do: a drafted message, a task, an
-- extraction result, an assignment plan, a document draft. The row is the PROPOSAL and
-- never changes. `status` is the state the row was BORN in (always 'pending' from the
-- capability path); the live state is public.ai_proposal_status, derived from the
-- append-only event ledger below.
create table public.ai_proposal (                              -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  capability_key text not null,                                -- registry key: 'chase.draft', 'shift.fill', …
  kind text not null check (kind in ('message','task','extraction','assignment','draft')),
  subject_type text not null,                                  -- 'credential','obligation','visit','client','form_instance',…
  subject_id uuid,                                             -- the record this proposal is about (id travels; content is refetched)
  title text not null,                                         -- one-line human summary
  body text,                                                   -- the drafted content the human reads and edits
  payload jsonb not null default '{}',                         -- structured detail (candidate list, field diffs, deep links)
  rationale text,                                              -- why the capability proposed this, in plain language
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'pending'
    check (status in ('pending','approved','edited','rejected','executed','expired')),
  ai_interaction_id uuid references public.ai_interaction(id), -- null ⇒ deterministic draft, no model call
  proposed_at timestamptz not null default now(),
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_ai_proposal_tenant on public.ai_proposal (tenant_id, proposed_at desc);
create index idx_ai_proposal_subject on public.ai_proposal (subject_type, subject_id);
create index idx_ai_proposal_capability on public.ai_proposal (tenant_id, capability_key);
create index idx_ai_proposal_creator on public.ai_proposal (created_by, proposed_at desc);

create trigger trg_ai_proposal_ao before update or delete on public.ai_proposal
  for each row execute function app.forbid_mutation();

alter table public.ai_proposal enable row level security;
alter table public.ai_proposal force row level security;

-- Read (PHI ⇒ AAL2): AI oversight, the person the capability ran for, and the two desks
-- that act on proposals — scheduling (coordinators) and compliance.
create policy ai_proposal_select_scoped on public.ai_proposal for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('ai.read')
      or created_by = auth.uid()
      or app.has_perm('schedule.write')
      or app.has_perm('compliance.read')));
-- Append (AAL2): the capability records the proposal as the user who ran it. Self-pinned,
-- so a proposal can never be attributed to a colleague.
create policy ai_proposal_insert_self on public.ai_proposal for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and created_by = auth.uid());

grant select, insert on public.ai_proposal to authenticated;   -- append-only: no update/delete

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ai_proposal_event [AO] (PHI) — the disposition ledger (invariant 8)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Approve / edit / reject / execute / expire. The human's edited text lands here as a
-- NEW row (edited_body), so the original draft and the human's version both persist and
-- the pair is a training label (docs/16 §3.2) as well as an audit fact.
create table public.ai_proposal_event (                        -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  -- Monotonic insert order. created_at is transaction time (now()), so two dispositions
  -- filed in one transaction — approve then execute — carry an identical timestamp and
  -- cannot be ordered by it. `seq` is what ai_proposal_status orders by, so the derived
  -- status is never a coin flip. Same reason audit.audit_event carries a bigint identity.
  seq bigint generated always as identity,
  tenant_id uuid not null references public.tenant(id),
  proposal_id uuid not null references public.ai_proposal(id),
  action text not null check (action in ('approve','edit','reject','execute','expire')),
  note text,                                                   -- the human's reason, in their words
  edited_body text,                                            -- the human's version of the draft, when action = 'edit'
  actor uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_ai_proposal_event_proposal on public.ai_proposal_event (proposal_id, seq desc);
create index idx_ai_proposal_event_tenant on public.ai_proposal_event (tenant_id, created_at desc);
create index idx_ai_proposal_event_actor on public.ai_proposal_event (actor, created_at desc);

create trigger trg_ai_proposal_event_ao before update or delete on public.ai_proposal_event
  for each row execute function app.forbid_mutation();

alter table public.ai_proposal_event enable row level security;
alter table public.ai_proposal_event force row level security;

-- Read follows the parent proposal's visibility.
create policy ai_proposal_event_select_scoped on public.ai_proposal_event
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.ai_proposal p
    where p.id = proposal_id and p.tenant_id = app.current_tenant_id()
      and (app.has_perm('ai.read')
        or p.created_by = auth.uid()
        or app.has_perm('schedule.write')
        or app.has_perm('compliance.read'))));
-- Append (AAL2, self-pinned): a disposition is always the act of the logged-in human on
-- a proposal they can see. This IS the invariant-8 enforcement point — no session, no
-- disposition; someone else's uid, no disposition.
create policy ai_proposal_event_insert_self on public.ai_proposal_event
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and actor = auth.uid()
    and exists (
      select 1 from public.ai_proposal p
      where p.id = proposal_id and p.tenant_id = app.current_tenant_id()
        and (app.has_perm('ai.read')
          or p.created_by = auth.uid()
          or app.has_perm('schedule.write')
          or app.has_perm('compliance.read'))));

grant select, insert on public.ai_proposal_event to authenticated;  -- append-only

-- ── public.ai_proposal_status — the derived current state of every proposal ───────
-- security_invoker: the view sees exactly what the caller's RLS lets them see on the
-- two base tables (invariant 9 posture — no privileged read path hides behind a view).
create view public.ai_proposal_status with (security_invoker = true) as
select
  p.id                as proposal_id,
  p.tenant_id,
  p.capability_key,
  p.kind,
  p.subject_type,
  p.subject_id,
  p.title,
  p.confidence,
  p.proposed_at,
  p.created_by,
  p.ai_interaction_id,
  coalesce(
    case last_event.action
      when 'approve' then 'approved'
      when 'edit'    then 'edited'
      when 'reject'  then 'rejected'
      when 'execute' then 'executed'
      when 'expire'  then 'expired'
    end,
    p.status) as status,
  last_event.action     as last_action,
  last_event.actor      as last_actor,
  last_event.created_at as last_action_at,
  coalesce(event_count.n, 0) as event_count
from public.ai_proposal p
left join lateral (
  select e.action, e.actor, e.created_at
  from public.ai_proposal_event e
  where e.proposal_id = p.id
  order by e.seq desc
  limit 1
) last_event on true
left join lateral (
  select count(*)::int as n from public.ai_proposal_event e2 where e2.proposal_id = p.id
) event_count on true;

grant select on public.ai_proposal_status to authenticated;

-- ── Audit emitters (definer; IDs and enums only — never title/body/note) ─────────
create or replace function app.audit_ai_proposal() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('ai_proposal.proposed', 'ai_proposal', new.id,
    jsonb_build_object('capability_key', new.capability_key, 'kind', new.kind,
                       'subject_type', new.subject_type, 'subject_id', new.subject_id));
  return null;
end $$;

create or replace function app.audit_ai_proposal_event() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  -- action is a bounded enum; note/edited_body (free text, possible PHI) stay out.
  perform app.emit_audit('ai_proposal.' || new.action, 'ai_proposal', new.proposal_id,
    jsonb_build_object('event_id', new.id, 'action', new.action));
  return null;
end $$;

revoke all on function app.audit_ai_proposal()       from public;
revoke all on function app.audit_ai_proposal_event() from public;

create trigger trg_ai_proposal_audit after insert on public.ai_proposal
  for each row execute function app.audit_ai_proposal();
create trigger trg_ai_proposal_event_audit after insert on public.ai_proposal_event
  for each row execute function app.audit_ai_proposal_event();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. extraction_job [AO] + extraction_field [AO] (PHI) — paper becomes chart (Wave 3)
-- ═══════════════════════════════════════════════════════════════════════════════
create table public.extraction_job (                           -- [AO] PHI (by reference)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  kind text not null check (kind in ('intake_packet','credential_doc','referral')),
  source_name text,                                            -- the uploaded document's name
  page_count int check (page_count is null or page_count >= 0),
  status text not null default 'pending'
    check (status in ('pending','extracted','reviewed','committed','failed')),
  client_id uuid references public.client(id),                 -- null until the packet is matched to a chart
  ai_interaction_id uuid references public.ai_interaction(id),
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_extraction_job_tenant on public.extraction_job (tenant_id, created_at desc);
create index idx_extraction_job_client on public.extraction_job (client_id);
create index idx_extraction_job_status on public.extraction_job (tenant_id, status);

-- The job is a record of consequence: what was extracted, from what, by whom, when.
-- Only its review lifecycle may advance (pending → extracted → reviewed → committed |
-- failed) — same column-scoped posture as knowledge_chunk.embedding (0015).
create trigger trg_extraction_job_guard before update on public.extraction_job
  for each row execute function app.guard_columns_only('status');
create trigger trg_extraction_job_ao before delete on public.extraction_job
  for each row execute function app.forbid_mutation();

alter table public.extraction_job enable row level security;
alter table public.extraction_job force row level security;

create policy extraction_job_select_scoped on public.extraction_job for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('client.write')
      or app.has_perm('client.read.all')
      or created_by = auth.uid()
      or (client_id is not null and app.on_care_team(client_id))));
create policy extraction_job_insert_self on public.extraction_job for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and created_by = auth.uid()
    and (app.has_perm('client.write') or app.has_perm('ai.manage')));
create policy extraction_job_update_status on public.extraction_job for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('client.write') or app.has_perm('ai.manage')))
  with check (tenant_id = app.current_tenant_id());

grant select, insert on public.extraction_job to authenticated;
grant update (status) on public.extraction_job to authenticated;   -- lifecycle only

-- Per-field extraction with the model's confidence and the human's acceptance. The
-- extracted value is what the model said and never changes; acceptance is what the
-- human decided (side-by-side review, docs/16 C6 — never auto-commit).
create table public.extraction_field (                         -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  job_id uuid not null references public.extraction_job(id),
  field_key text not null,                                     -- 'client.last_name', 'payer.member_id', …
  extracted_value text,                                        -- immutable: what the model read
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  page_ref int,                                                -- which page it came from
  accepted_value text,                                         -- the human's corrected value, if any
  accepted boolean,                                            -- null = not reviewed yet
  accepted_by uuid references public.app_user(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (job_id, field_key)
);
create index idx_extraction_field_job on public.extraction_field (job_id, field_key);
create index idx_extraction_field_tenant on public.extraction_field (tenant_id);

create trigger trg_extraction_field_guard before update on public.extraction_field
  for each row execute function
    app.guard_columns_only('accepted', 'accepted_value', 'accepted_by', 'accepted_at');
create trigger trg_extraction_field_ao before delete on public.extraction_field
  for each row execute function app.forbid_mutation();

alter table public.extraction_field enable row level security;
alter table public.extraction_field force row level security;

create policy extraction_field_select_scoped on public.extraction_field for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.extraction_job j
    where j.id = job_id and j.tenant_id = app.current_tenant_id()
      and (app.has_perm('client.write')
        or app.has_perm('client.read.all')
        or j.created_by = auth.uid()
        or (j.client_id is not null and app.on_care_team(j.client_id)))));
create policy extraction_field_insert_scoped on public.extraction_field for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('client.write') or app.has_perm('ai.manage'))
    and exists (select 1 from public.extraction_job j
                 where j.id = job_id and j.tenant_id = app.current_tenant_id()));
-- The review flow: a human accepts or corrects a field. The grant is COLUMN-scoped, so
-- extracted_value/confidence/page_ref are unwritable no matter what the caller sends,
-- and accepted_by can only ever be the caller (provenance, invariant 8).
create policy extraction_field_update_review on public.extraction_field for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('client.write') or app.has_perm('ai.manage')))
  with check (tenant_id = app.current_tenant_id()
    and (accepted_by is null or accepted_by = auth.uid()));

grant select, insert on public.extraction_field to authenticated;
grant update (accepted, accepted_value, accepted_by, accepted_at)
  on public.extraction_field to authenticated;

create or replace function app.audit_extraction_job() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- source_name may carry a person's name (a faxed packet) ⇒ never in the payload.
    perform app.emit_audit('extraction.job_created', 'extraction_job', new.id,
      jsonb_build_object('kind', new.kind, 'page_count', new.page_count,
                         'client_id', new.client_id));
  elsif new.status is distinct from old.status then
    perform app.emit_audit('extraction.job_' || new.status, 'extraction_job', new.id,
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return null;
end $$;
revoke all on function app.audit_extraction_job() from public;
create trigger trg_extraction_job_audit after insert or update on public.extraction_job
  for each row execute function app.audit_extraction_job();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. agent_task [AO] + agent_step [AO] (OPS) — the durable agent runtime (Wave 4)
-- ═══════════════════════════════════════════════════════════════════════════════
-- A task is a goal a coordinator handed the agent; steps are the replayable trace of
-- what it did. Digests only (PHI-safe, produced by the client's minimizer) — a step
-- never stores a message body or a client's details.
create table public.agent_task (                               -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  kind text not null check (kind in ('shift_fill','compliance_cure','credential_chase')),
  subject_id uuid,                                             -- the visit / obligation / credential in play
  status text not null default 'running'
    check (status in ('running','awaiting_approval','completed','failed','cancelled')),
  goal text not null,                                          -- plain-language statement of the objective
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_agent_task_tenant on public.agent_task (tenant_id, created_at desc);
create index idx_agent_task_subject on public.agent_task (subject_id);
create index idx_agent_task_open on public.agent_task (tenant_id, status)
  where status in ('running','awaiting_approval');

create trigger trg_agent_task_guard before update on public.agent_task
  for each row execute function app.guard_columns_only('status');
create trigger trg_agent_task_ao before delete on public.agent_task
  for each row execute function app.forbid_mutation();

alter table public.agent_task enable row level security;
alter table public.agent_task force row level security;

create policy agent_task_select_scoped on public.agent_task for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('ai.read')
      or app.has_perm('schedule.read')
      or app.has_perm('schedule.write')
      or created_by = auth.uid()));
create policy agent_task_insert_self on public.agent_task for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and created_by = auth.uid()
    and (app.has_perm('schedule.write') or app.has_perm('ai.manage')));
create policy agent_task_update_status on public.agent_task for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('schedule.write') or app.has_perm('ai.manage')
      or created_by = auth.uid()))
  with check (tenant_id = app.current_tenant_id());

grant select, insert on public.agent_task to authenticated;
grant update (status) on public.agent_task to authenticated;   -- lifecycle only

create table public.agent_step (                               -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  task_id uuid not null references public.agent_task(id),
  seq int not null,
  tool text not null,                                          -- allowlisted tool name
  input_digest text,                                           -- PHI-safe digest (minimizer output)
  output_digest text,
  status text not null default 'ok'
    check (status in ('running','ok','error','blocked','skipped')),
  created_at timestamptz not null default now(),
  unique (task_id, seq)
);
create index idx_agent_step_task on public.agent_step (task_id, seq);
create index idx_agent_step_tenant on public.agent_step (tenant_id, created_at desc);

create trigger trg_agent_step_ao before update or delete on public.agent_step
  for each row execute function app.forbid_mutation();

alter table public.agent_step enable row level security;
alter table public.agent_step force row level security;

create policy agent_step_select_scoped on public.agent_step for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and exists (
    select 1 from public.agent_task t
    where t.id = task_id and t.tenant_id = app.current_tenant_id()
      and (app.has_perm('ai.read')
        or app.has_perm('schedule.read')
        or app.has_perm('schedule.write')
        or t.created_by = auth.uid())));
create policy agent_step_insert_scoped on public.agent_step for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('schedule.write') or app.has_perm('ai.manage'))
    and exists (select 1 from public.agent_task t
                 where t.id = task_id and t.tenant_id = app.current_tenant_id()));

grant select, insert on public.agent_step to authenticated;    -- append-only

create or replace function app.audit_agent_task() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform app.emit_audit('agent_task.started', 'agent_task', new.id,
      jsonb_build_object('kind', new.kind, 'subject_id', new.subject_id));
  elsif new.status is distinct from old.status then
    perform app.emit_audit('agent_task.' || new.status, 'agent_task', new.id,
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return null;
end $$;
revoke all on function app.audit_agent_task() from public;
create trigger trg_agent_task_audit after insert or update on public.agent_task
  for each row execute function app.audit_agent_task();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. clinical_flag [AO] (PHI) — early warning, RN disposes (docs/16 R3, Wave 5)
-- ═══════════════════════════════════════════════════════════════════════════════
-- The flag is a finding about a client, proposed by a T2 capability over deterministic
-- feature series. It never escalates itself and it never changes: only its disposition
-- (open → acknowledged | dismissed) moves, and only by a care-team clinician.
create table public.clinical_flag (                            -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid not null references public.client(id),
  kind text not null check (kind in
    ('condition_trend','mood_trend','exception_spike','visit_shortfall')),
  severity text not null check (severity in ('info','medium','high')),
  summary text not null,                                       -- plain language, one or two sentences
  evidence jsonb not null default '{}',                        -- the deterministic series the flag stands on
  status text not null default 'open' check (status in ('open','acknowledged','dismissed')),
  ai_interaction_id uuid references public.ai_interaction(id),
  acknowledged_by uuid references public.app_user(id),
  acknowledged_at timestamptz,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_clinical_flag_client on public.clinical_flag (client_id, created_at desc);
create index idx_clinical_flag_tenant on public.clinical_flag (tenant_id, created_at desc);
create index idx_clinical_flag_open on public.clinical_flag (tenant_id, severity)
  where status = 'open';

create trigger trg_clinical_flag_guard before update on public.clinical_flag
  for each row execute function
    app.guard_columns_only('status', 'acknowledged_by', 'acknowledged_at');
create trigger trg_clinical_flag_ao before delete on public.clinical_flag
  for each row execute function app.forbid_mutation();

alter table public.clinical_flag enable row level security;
alter table public.clinical_flag force row level security;

-- Clinical content ⇒ AAL2 + care-team (or the tenant-wide clinical read permission).
create policy clinical_flag_select_scoped on public.clinical_flag for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.on_care_team(client_id) or app.has_perm('client.read.all')));
create policy clinical_flag_insert_scoped on public.clinical_flag for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and created_by = auth.uid()
    and (app.on_care_team(client_id) or app.has_perm('client.read.all')));
-- Disposition is NARROWER than visibility, on purpose (invariant 8: a clinical finding is
-- disposed by clinical/office staff, not by whoever can see it). A care-team caregiver
-- reads the flag on their client; acknowledging or dismissing it requires the tenant-wide
-- clinical read permission, which the seeded RBAC gives to the RN, owner, admin and
-- coordinator roles — never to a caregiver.
create policy clinical_flag_update_disposition on public.clinical_flag for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and app.has_perm('client.read.all'))
  with check (tenant_id = app.current_tenant_id()
    and (acknowledged_by is null or acknowledged_by = auth.uid()));

grant select, insert on public.clinical_flag to authenticated;
grant update (status, acknowledged_by, acknowledged_at) on public.clinical_flag to authenticated;

create or replace function app.audit_clinical_flag() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- summary is clinical free text ⇒ never in the payload; kind + severity are enums.
    perform app.emit_audit('clinical_flag.raised', 'clinical_flag', new.id,
      jsonb_build_object('client_id', new.client_id, 'kind', new.kind,
                         'severity', new.severity));
  elsif new.status is distinct from old.status then
    perform app.emit_audit('clinical_flag.' || new.status, 'clinical_flag', new.id,
      jsonb_build_object('client_id', new.client_id, 'from', old.status, 'to', new.status));
  end if;
  return null;
end $$;
revoke all on function app.audit_clinical_flag() from public;
create trigger trg_clinical_flag_audit after insert or update on public.clinical_flag
  for each row execute function app.audit_clinical_flag();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. evidence_packet [AO] (PHI by reference) — surveyor "show me" (docs/16 O2)
-- ═══════════════════════════════════════════════════════════════════════════════
-- The manifest is the deterministic bundle: record IDs, version numbers, signature and
-- hash-chain references, counts. The narrative is an optional plain-language index; a
-- packet with narrative = null is a complete, defensible packet — AI is an accelerant.
create table public.evidence_packet (                          -- [AO] PHI (by reference)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  client_id uuid references public.client(id),                 -- null = tenant-wide scope
  scope text not null,                                         -- 'supervisory_visits.2026', 'credentials.active', …
  record_count int not null default 0 check (record_count >= 0),
  manifest jsonb not null default '{}',                        -- ids, hashes, version chains — the evidence itself
  narrative text,                                              -- optional AI-written index; null = deterministic-only
  generated_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_evidence_packet_tenant on public.evidence_packet (tenant_id, created_at desc);
create index idx_evidence_packet_client on public.evidence_packet (client_id, created_at desc);

create trigger trg_evidence_packet_ao before update or delete on public.evidence_packet
  for each row execute function app.forbid_mutation();

alter table public.evidence_packet enable row level security;
alter table public.evidence_packet force row level security;

create policy evidence_packet_select_compliance on public.evidence_packet
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and app.has_perm('compliance.read'));
create policy evidence_packet_insert_compliance on public.evidence_packet
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and app.has_perm('compliance.read')
    and generated_by = auth.uid());

grant select, insert on public.evidence_packet to authenticated;   -- append-only

create or replace function app.audit_evidence_packet() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;
  end if;
  perform app.emit_audit('evidence.packet_generated', 'evidence_packet', new.id,
    jsonb_build_object('client_id', new.client_id, 'scope', new.scope,
                       'record_count', new.record_count));
  return null;
end $$;
revoke all on function app.audit_evidence_packet() from public;
create trigger trg_evidence_packet_audit after insert on public.evidence_packet
  for each row execute function app.audit_evidence_packet();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Engine: app.rank_fill_candidates — who may take this open shift (invariant 13)
-- ═══════════════════════════════════════════════════════════════════════════════
-- The open-shift fill agent (docs/16 C1) never asks a model who is eligible. This
-- function answers, in SQL, and delegates every eligibility verdict to
-- app.assert_schedulable (0011) — the single authority. The model receives this output
-- as ground truth and writes the outreach copy around it.
--
-- Scoring (deterministic, documented, and displayed to the coordinator):
--   base                                   100
--   any schedulability blocker              −40   (the blockers themselves are returned verbatim)
--   active assignment with this client      +25   (familiarity)
--   already serves clients in the same city +10   (travel proximity, no geocoding needed)
--   hours already scheduled that week       −min(hours, 40)
--
-- Returns caregiver IDs, not names: the caller refetches identity under its own RLS
-- (invariant 5 — IDs travel, content is refetched).
-- SECURITY DEFINER for the same reason as assert_schedulable: it must see credential
-- and roster state regardless of the caller's own row visibility. It is hard-scoped to
-- the caller's tenant and gated on AAL2 + a scheduling permission.
create or replace function app.rank_fill_candidates(p_visit uuid)
returns table (caregiver_id uuid, score int, blockers jsonb, reasons text[])
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v public.visit;
  v_window tstzrange;
  v_city text;
  v_week_start timestamptz;
  v_week_end timestamptz;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to rank fill candidates'
      using errcode = '42501';
  end if;
  if not (app.has_perm('schedule.read') or app.has_perm('schedule.write')) then
    raise exception 'CAREOS_FORBIDDEN: scheduling permission is required to rank fill candidates'
      using errcode = '42501';
  end if;

  select * into v from public.visit
   where id = p_visit and tenant_id = v_tenant;
  if v.id is null then
    return;                                    -- unknown or out-of-tenant: no candidates
  end if;

  v_window     := tstzrange(v.scheduled_start, v.scheduled_end, '[)');
  v_week_start := date_trunc('week', v.scheduled_start);
  v_week_end   := v_week_start + interval '7 days';
  select c.city into v_city from public.client c where c.id = v.client_id;

  return query
  with candidate as (
    select u.id as cg
    from public.app_user u
    where u.tenant_id = v_tenant
      and u.status = 'active'
      and u.kind = 'staff'
      and u.id is distinct from v.caregiver_id            -- the incumbent is not a "fill"
      and exists (
        select 1 from public.user_role ur
        join public.role r on r.id = ur.role_id
        where ur.user_id = u.id and lower(r.key) = 'caregiver')
  ), scored as (
    select
      cd.cg,
      app.assert_schedulable(cd.cg, v.client_id, v_window) as sched,
      exists (
        select 1 from public.care_team_assignment a
        where a.user_id = cd.cg and a.client_id = v.client_id
          and a.starts_on <= v.scheduled_start::date
          and (a.ends_on is null or a.ends_on >= v.scheduled_start::date)) as familiar,
      (v_city is not null and exists (
        select 1 from public.care_team_assignment a2
        join public.client c2 on c2.id = a2.client_id
        where a2.user_id = cd.cg and a2.ends_on is null and c2.city = v_city)) as same_area,
      coalesce((
        select sum(extract(epoch from (vv.scheduled_end - vv.scheduled_start))) / 3600.0
        from public.visit vv
        where vv.caregiver_id = cd.cg
          and vv.tenant_id = v_tenant
          and vv.status in ('scheduled','in_progress','completed')
          and vv.scheduled_start >= v_week_start
          and vv.scheduled_start <  v_week_end), 0) as week_hours,
      exists (
        select 1 from public.visit vo
        where vo.caregiver_id = cd.cg
          and vo.tenant_id = v_tenant
          and vo.status in ('scheduled','in_progress')
          and tstzrange(vo.scheduled_start, vo.scheduled_end, '[)') && v_window) as overlaps
    from candidate cd
  )
  select
    s.cg,
    (100
      - case when jsonb_array_length(s.sched -> 'blockers') > 0 then 40 else 0 end
      + case when s.familiar  then 25 else 0 end
      + case when s.same_area then 10 else 0 end
      - least(round(s.week_hours)::int, 40))::int,
    jsonb_build_object(
      'blocked', jsonb_array_length(s.sched -> 'blockers') > 0,
      'items',   s.sched -> 'blockers'),
    (
      coalesce((
        select array_agg(
                 'Blocked: ' || coalesce(b ->> 'name', b ->> 'credential')
                 || ' is ' || (b ->> 'reason'))
        from jsonb_array_elements(s.sched -> 'blockers') b), array[]::text[])
      || array_remove(array[
           case when s.familiar  then 'Has an active assignment with this client' end,
           case when s.same_area then 'Already serves clients in the same area' end,
           case when s.overlaps  then 'Has another visit that overlaps this window' end,
           case when s.week_hours > 0
                then round(s.week_hours)::text || ' hours already scheduled that week' end
         ], null)
    )
  from scored s
  order by 2 desc, 1;
end $$;

revoke all on function app.rank_fill_candidates(uuid) from public, anon;
grant execute on function app.rank_fill_candidates(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. Engine: app.denial_risk — deterministic claim-completeness gate (docs/16 B2)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Errors surface ~60 days later as denials. This is the pre-check, and it is rules,
-- not judgment: an EVV clock pair, a finalized note, the signature the template
-- requires, and a credential that was valid for the visit window. The LLM narrates the
-- gaps for the biller; it never decides whether a claim is ready.
-- Returns {visit_id, ready, gaps[], checked_at}. Gap strings are generic — no client or
-- staff names ever appear (invariant 5).
create or replace function app.denial_risk(p_visit uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v public.visit;
  v_tenant uuid := app.current_tenant_id();
  v_gaps text[] := array[]::text[];
  v_clock_in timestamptz;
  v_clock_out timestamptz;
  v_note_final boolean;
  v_sig_missing boolean;
  v_blockers jsonb;
  v_blocker_names text;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to run the denial-risk check'
      using errcode = '42501';
  end if;

  select * into v from public.visit
   where id = p_visit and tenant_id = v_tenant;
  if v.id is null then
    return jsonb_build_object(
      'visit_id', p_visit, 'ready', false,
      'gaps', jsonb_build_array('The visit was not found'),
      'checked_at', now(), 'basis', 'deterministic');
  end if;

  if v.status <> 'completed' then
    v_gaps := array_append(v_gaps, 'The visit is not marked completed (it is ' || v.status || ')');
  end if;

  if v.caregiver_id is null then
    v_gaps := array_append(v_gaps, 'No caregiver is assigned to the visit'::text);
  end if;

  select max(ve.occurred_at) filter (where ve.event_type = 'clock_in'),
         max(ve.occurred_at) filter (where ve.event_type = 'clock_out')
    into v_clock_in, v_clock_out
  from public.visit_event ve
  where ve.visit_id = v.id;

  if v_clock_in is null then
    v_gaps := array_append(v_gaps, 'No clock-in was recorded for the visit'::text);
  end if;
  if v_clock_out is null then
    v_gaps := array_append(v_gaps, 'No clock-out was recorded for the visit'::text);
  end if;

  select exists (
    select 1 from public.form_instance fi
    where fi.visit_id = v.id and fi.tenant_id = v.tenant_id and fi.status = 'final')
    into v_note_final;
  if not v_note_final then
    v_gaps := array_append(v_gaps, 'The visit note is not finalized'::text);
  end if;

  -- A signature is only a gap where the template actually requires one.
  select exists (
    select 1
    from public.form_instance fi
    join public.form_template ft on ft.id = fi.template_id
    where fi.visit_id = v.id
      and fi.tenant_id = v.tenant_id
      and fi.status = 'final'
      and cardinality(ft.requires_signature_roles) > 0
      and not exists (
        select 1 from public.signature s
        where s.form_version_id = fi.current_version_id))
    into v_sig_missing;
  if v_sig_missing then
    v_gaps := array_append(v_gaps, 'A required signature is missing on the finalized note'::text);
  end if;

  -- Credential validity for the visit window — same authority as scheduling (0011).
  if v.caregiver_id is not null then
    v_blockers := app.assert_schedulable(
      v.caregiver_id, v.client_id,
      tstzrange(v.scheduled_start, v.scheduled_end, '[)')) -> 'blockers';
    if jsonb_array_length(v_blockers) > 0 then
      select string_agg(coalesce(b ->> 'name', b ->> 'credential'), ', ')
        into v_blocker_names
      from jsonb_array_elements(v_blockers) b;
      v_gaps := array_append(v_gaps,
        'A required credential was not valid for the visit window: ' || v_blocker_names);
    end if;
  end if;

  return jsonb_build_object(
    'visit_id',   v.id,
    'ready',      cardinality(v_gaps) = 0,
    'gaps',       to_jsonb(v_gaps),
    'checked_at', now(),
    'basis',      'deterministic');
end $$;

revoke all on function app.denial_risk(uuid) from public, anon;
grant execute on function app.denial_risk(uuid) to authenticated;
