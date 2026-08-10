-- ST-207 · Migration 0049 — the canonical evv record, adapters, and the submission ledger
-- The EVV layer's whole point (D-026): CareOS keeps ONE state-agnostic record of what
-- happened, and adapters translate it outward. `evv_record` carries the six data elements
-- docs/17 §3.12 names as "the six federally required EVV data elements" — here they are a
-- DATA MODEL, nothing more. This migration deliberately asserts no legal requirement,
-- seeds no `public.legal_authority` row, and cites no regulation: under D-015/D-017 an
-- authority becomes citable only when a named human verifier and a source checksum exist,
-- and docs/02 is still missing (V13). The element names below describe the model; they do
-- not claim what any regulator requires.
--
-- Why this unblocks the build. V17 (is Maryland's ISAS an OPEN or CLOSED EVV model?) has
-- blocked EVV design since S0 because the corpus assumed the answer decided the
-- architecture. It does not. In a closed model CareOS reconciles against the state's
-- system of record; in an open model the identical canonical record is pushed. Both need
-- the SAME internal object, so the answer decides the value of ONE column —
-- `evv_adapter.mode` — and Maryland therefore ships here as
-- ('isas','MD', mode='reconcile', enabled=false). Flipping to capture mode is one row
-- update plus an adapter implementation; no schema, no record, no RPC changes. That is
-- precisely why V17 no longer blocks the build (D-026). What the disabled flag protects is
-- the other half of D-026's condition: no live submission endpoint is wired until
-- D-Q16/V10/V17 resolve.
--
-- Shape and precedents:
--   * `evv_record` is [AO] (invariant 1) on the 0013 `visit_event` precedent — a rebuild
--     APPENDS a new record whose `supersedes_id` points at the one it replaces, so the
--     history of what was asserted about a visit is never rewritten. `record_sha256` is a
--     canonical hash over the six elements only (sorted, pipe-delimited), which is what
--     makes "is this the same record we already submitted?" a comparison and not a guess —
--     the 0017 `schema_hash` / 0006 content-hash idiom.
--   * `evv_submission` is [AO] too, which forces one design choice worth naming: an
--     outcome cannot be UPDATEd onto the attempt row. It is APPENDED as a further row for
--     the same (evv_record_id, adapter_id, attempt_no), and current state is the latest
--     row — exactly the "current state = latest disposition" pattern docs/17 §3.8 already
--     uses for `visit_exception_disposition`. `attempt_no` therefore counts transmission
--     attempts, not ledger rows.
--   * `evv_adapter` is CFG and deliberately NOT append-only: D-026's "one column flip" has
--     to be an update. It carries no secrets — a CHECK refuses the obvious secret-bearing
--     keys, because adapter credentials belong in Vault (docs/09 §5), never in a row.
--   * Audit: `evv_record` is trigger-audited (0011/0013 idiom) because it has exactly one
--     writer and that writer is always a session. `evv_submission` has TWO lanes — a
--     session RPC and the worker — and the seed guard in a trigger would silently swallow
--     the worker's audit, so both submission RPCs emit explicitly (the 0030+/0034
--     `complete_revocation_step_system` posture). Every path lands on the same chain.
--   * Queue: submissions ride `q_events` via the 0027 outbox rather than a new pgmq queue.
--     0034's `app.queue_read`/`app.queue_archive` allowlist exactly three queue names, so a
--     fourth queue means re-signing a worker contract that belongs to the devops slice.
--     The outbox already gives same-transaction delivery, which is the property we need.
--   * Coordinates appear nowhere in this file — not in a column, not in an audit payload,
--     not in an outbox payload, not in a queue message. `evv_record` binds a LOCATION
--     VERSION ID; the geography stays behind RLS on `service_location_version`, where the
--     requester refetches it (invariant 5, D-030).
-- @trace: ST-207, D-026, D-030, D-015, D-017, docs/17 §3.12, §3.13, §4.8

-- ── Permission catalog (real config — belongs in the migration, not the seed) ──────────
-- Mirrors the 0011 scheduling-permission precedent; per-tenant role grants are wired by
-- the seed / the identity admin RPCs.
insert into public.permission (key, description) values
  ('evv.read',   'Read EVV records and submissions'),
  ('evv.manage', 'Configure EVV adapters and trigger submission and reconciliation')
on conflict (key) do nothing;

-- ── Audit emitter for the canonical record (definer; IDs, enums and a hash only) ───────
-- A content hash is PHI-safe by construction (the 0014/0015 "digest, never content"
-- posture) and is the single most useful piece of evidence a surveyor can be shown:
-- it proves which canonical assertion was on the ledger at that moment.
create or replace function app.audit_evv_record() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is null then
    return null;                                  -- seed / system path: not a user action
  end if;
  perform app.emit_audit('evv.record.built', 'evv_record', new.id,
    jsonb_build_object('visit_id', new.source_visit_id,
                       'client_id', new.client_id,          -- id only; never PHI content
                       'caregiver_id', new.caregiver_id,
                       'service_type_id', new.service_type_id,
                       'capture_method', new.capture_method,
                       'payer_kind', new.payer_kind,
                       'is_complete', new.is_complete,
                       'record_sha256', new.record_sha256,
                       'supersedes_id', new.supersedes_id));
  return null;                                    -- AFTER trigger: result ignored
end $$;
revoke all on function app.audit_evv_record() from public;

-- ── evv_adapter: the translation seam, one row per (target, state) ──────────────── CFG
-- NOT append-only on purpose: D-026's whole claim is that switching Maryland from
-- reconcile to capture is a single-column update. Making this table immutable would
-- turn the cheapest possible migration into a data migration.
create table public.evv_adapter (                                              -- CFG
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  target text not null check (target in ('isas','sandata','hhax','none')),
  state_code text not null check (state_code ~ '^[A-Z]{2}$'),
  mode text not null default 'disabled'
    check (mode in ('capture','reconcile','dual','disabled')),
  enabled boolean not null default false,
  adapter_version text,
  config jsonb not null default '{}'::jsonb,     -- NON-SECRET only; see the CHECK below
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version int not null default 1,
  -- An enabled adapter in 'disabled' mode is an illegal state, so it is unrepresentable.
  constraint chk_evv_adapter_enabled_mode check (not enabled or mode <> 'disabled'),
  -- Adapter credentials live in Vault (docs/09 §5). jsonb_exists_any is the function
  -- behind the `?|` operator and is immutable, so it is legal in a CHECK; the
  -- jsonb→text cast is only STABLE (the D-014 finding) and could not be used here.
  constraint chk_evv_adapter_config_non_secret check (
    not jsonb_exists_any(config,
      array['api_key','apikey','secret','client_secret','password','token','bearer']))
);
create index idx_evv_adapter_tenant on public.evv_adapter (tenant_id);
create unique index uq_evv_adapter_target on public.evv_adapter
  (tenant_id, target, state_code);
-- Hot path: app.submit_evv resolves "is anything live for this tenant?" on every call.
create index idx_evv_adapter_enabled on public.evv_adapter (tenant_id, state_code, target)
  where enabled;

alter table public.evv_adapter enable row level security;
alter table public.evv_adapter force row level security;

-- Adapter configuration carries no PHI (target, state, mode, version, non-secret config),
-- so no AAL2 gate — the `feature_flag` (0026) posture for operational config. It is still
-- permission-gated: only the EVV surfaces have any business reading it.
create policy evv_adapter_select_scoped on public.evv_adapter for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_perm('evv.read') or app.has_perm('evv.manage')));

grant select on public.evv_adapter to authenticated;   -- config write path: see below

-- ── evv_record: the canonical, state-agnostic object ────────────────────── [AO] PHI
-- The six elements are numbered to match docs/17 §3.12's own labels. They are the data
-- model of this system; this file makes no claim about what any regulator requires.
create table public.evv_record (                                          -- [AO] PHI
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  source_visit_id uuid not null references public.visit(id),
  service_type_id uuid references public.service_type(id),            -- (1) type of service
  client_id uuid not null references public.client(id),               -- (2) who received it
  service_date date not null,                                         -- (3) date of service
  service_location_version_id uuid
    references public.service_location_version(id),                   -- (4) where
  caregiver_id uuid references public.app_user(id),                   -- (5) who provided it
  start_at timestamptz not null,                                      -- (6a) begin time
  end_at timestamptz not null,                                        -- (6b) end time
  capture_method text not null default 'web_gps'
    check (capture_method in ('web_gps','manual','offline_sync','telephony','corrected')),
  exception_code text,                           -- adapter vocabulary; NULL until one exists
  payer_kind text not null default 'other'
    check (payer_kind in ('medicaid','medicare','private','waiver','other')),
  element_completeness jsonb not null,           -- exactly six booleans, keys fixed below
  is_complete boolean not null,                  -- their conjunction, CHECK-enforced
  record_sha256 text not null,                   -- canonical hash of the six elements
  supersedes_id uuid references public.evv_record(id),
  created_at timestamptz not null default now(),
  constraint chk_evv_record_window check (end_at >= start_at),
  constraint chk_evv_record_hash check (record_sha256 ~ '^[0-9a-f]{64}$'),
  -- The completeness object may not be a free-form bag: all six element keys are present
  -- in every stored row, so "which element is missing?" is always answerable.
  constraint chk_evv_record_elements_named check (
    (element_completeness ->> 'service_type')        is not null
    and (element_completeness ->> 'individual_receiving') is not null
    and (element_completeness ->> 'service_date')    is not null
    and (element_completeness ->> 'service_location') is not null
    and (element_completeness ->> 'individual_providing') is not null
    and (element_completeness ->> 'service_times')   is not null),
  -- is_complete is not an opinion: it is the conjunction, true by constraint.
  constraint chk_evv_record_completeness check (
    is_complete = ((element_completeness ->> 'service_type')::boolean
              and  (element_completeness ->> 'individual_receiving')::boolean
              and  (element_completeness ->> 'service_date')::boolean
              and  (element_completeness ->> 'service_location')::boolean
              and  (element_completeness ->> 'individual_providing')::boolean
              and  (element_completeness ->> 'service_times')::boolean))
);
create index idx_evv_record_tenant on public.evv_record (tenant_id);
create index idx_evv_record_visit on public.evv_record (source_visit_id, created_at desc);
create index idx_evv_record_client_date on public.evv_record (client_id, service_date);
create index idx_evv_record_caregiver_date on public.evv_record (caregiver_id, service_date);
-- Head-of-chain lookup ("the record nothing supersedes") is the hot read on every
-- build/submit, and it is an anti-join on this column.
create index idx_evv_record_supersedes on public.evv_record (supersedes_id)
  where supersedes_id is not null;

create trigger trg_evv_record_ao before update or delete on public.evv_record
  for each row execute function app.forbid_mutation();
create trigger trg_evv_record_audit after insert on public.evv_record
  for each row execute function app.audit_evv_record();

alter table public.evv_record enable row level security;
alter table public.evv_record force row level security;

-- PHI (a named client, a named caregiver, a date and a place of care) ⇒ AAL2. Read:
-- the EVV surfaces, the client's care team, or the caregiver reading their own record —
-- the same three-way scope `visit_event` (0013) uses, so the two ledgers agree.
create policy evv_record_select_scoped on public.evv_record for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2() and (
      app.has_perm('evv.read')
      or app.has_perm('evv.manage')
      or caregiver_id = auth.uid()
      or app.on_care_team(client_id)
    ));

grant select on public.evv_record to authenticated;   -- no update/delete: append-only

-- ── evv_submission: one ledger row per attempt, one more per outcome ─────── [AO] OPS
-- No PHI of its own (IDs, enums, vendor codes) but PHI-by-linkage through evv_record,
-- so reads are AAL2-gated like the record itself.
create table public.evv_submission (                                      -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  evv_record_id uuid not null references public.evv_record(id),
  adapter_id uuid not null references public.evv_adapter(id),
  attempt_no int not null check (attempt_no >= 1),
  status text not null default 'pending' check (status in
    ('pending','submitted','accepted','rejected','superseded','reconciled')),
  external_reference text,                       -- the vendor's own id for this record
  response_code text,                            -- vendor code, e.g. 'E-104'
  response_message text,                         -- vendor prose — NEVER PHI, see below
  request_sha256 text,                           -- the record hash this attempt carried
  submitted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  -- Any terminal status must say when it became terminal.
  constraint chk_evv_submission_resolved
    check (status in ('pending','submitted') or resolved_at is not null),
  -- response_message is text WE DID NOT WRITE, arriving from a vendor over the worker
  -- lane. app.reconcile_evv truncates it, and the bound is re-asserted here so no future
  -- caller can widen it: a vendor echoing a client name back at us must not be able to
  -- turn an OPS row into an unbounded PHI sink (invariant 5).
  constraint chk_evv_submission_message_bounded
    check (response_message is null or length(response_message) <= 500)
);
create index idx_evv_submission_tenant on public.evv_submission (tenant_id);
create index idx_evv_submission_record on public.evv_submission
  (evv_record_id, adapter_id, attempt_no, created_at desc);
create index idx_evv_submission_adapter on public.evv_submission (adapter_id, created_at desc);
-- The "in flight" queue: what the worker and the /operations/evv board both poll.
create index idx_evv_submission_open on public.evv_submission (tenant_id, created_at)
  where status in ('pending','submitted');

create trigger trg_evv_submission_ao before update or delete on public.evv_submission
  for each row execute function app.forbid_mutation();

alter table public.evv_submission enable row level security;
alter table public.evv_submission force row level security;

-- Submissions are back-office claim plumbing: the EVV surfaces read them, caregivers do
-- not. Narrower than evv_record on purpose (a caregiver has no operational use for a
-- vendor rejection code, and D-030's spirit is to show people what helps them act).
create policy evv_submission_select_scoped on public.evv_submission for select to authenticated
  using (
    tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('evv.read') or app.has_perm('evv.manage')));

grant select on public.evv_submission to authenticated;   -- no update/delete: append-only

-- ── Maryland ships disabled (D-026) ───────────────────────────────────────────────────
-- Idempotent seeder with two entry points — this migration for hosted tenants, and
-- seeds/ for a fresh local universe — exactly the 0038 `expand_credential_catalog`
-- pattern. `reconcile` is the correct mode under BOTH answers to V17, and `enabled=false`
-- keeps D-026's condition (no live endpoint until D-Q16/V10/V17 resolve) structural
-- rather than aspirational.
create or replace function app.seed_evv_adapters(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  insert into public.evv_adapter
    (tenant_id, target, state_code, mode, enabled, adapter_version, config)
  values
    (p_tenant, 'isas', 'MD', 'reconcile', false, null, '{}'::jsonb)
  on conflict (tenant_id, target, state_code) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function app.seed_evv_adapters(uuid) from public, anon, authenticated;

select app.seed_evv_adapters(t.id) from public.tenant t;

-- ── app.build_evv_record — canonicalise, hash, score completeness, append ─────────────
-- Deterministic end to end (invariant 13): every value here is read out of the ledger or
-- computed by arithmetic. No model is consulted and none ever will be — "are the six
-- elements present?" is the left column of docs/17 §1.1.
--
-- Corrections are honoured. §4.6 appends a `correction` event carrying `corrects_event_id`
-- and never touches the original, so the EFFECTIVE time of a clock event is the latest
-- correction pointed at it, falling back to the event's own `occurred_at`. Building from
-- raw min/max would quietly file a time a human had already fixed.
--
-- Because the table is append-only, a rebuild appends: the new row's `supersedes_id`
-- points at the row it replaces, and an unchanged rebuild is a no-op that RETURNS
-- `unchanged` rather than raising (idempotency is a return value, never an error).
create or replace function app.build_evv_record(p_visit uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant        uuid := app.current_tenant_id();
  v_client        uuid;
  v_caregiver     uuid;
  v_visit_status  text;
  v_service_type  uuid;
  v_location_ver  uuid;
  v_evv_required  boolean := false;
  v_payer_kind    text := 'other';
  v_start_at      timestamptz;
  v_end_at        timestamptz;
  v_service_date  date;
  v_corrected     boolean := false;
  v_manual        boolean := false;
  v_offline       boolean := false;
  v_capture       text;
  v_elements      jsonb;
  v_complete      boolean;
  v_canonical     text;
  v_sha           text;
  v_prior_id      uuid;
  v_prior_sha     text;
  v_record_id     uuid;
  v_evv_status    text;
  v_superseded    int := 0;
begin
  -- 1 · Gate. PHI in, PHI out ⇒ AAL2 (invariant 3); building the compliance record is an
  --     EVV-desk act, not a caregiver act (docs/17 §5).
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to build an EVV record'
      using errcode = '42501';
  end if;
  if not app.has_perm('evv.manage') then
    raise exception 'CAREOS_FORBIDDEN: evv.manage is required' using errcode = '42501';
  end if;

  -- 2 · Existence, inside the caller's tenant.
  if not exists (select 1 from public.visit v
                  where v.id = p_visit and v.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;

  -- 3 · Serialize every EVV act on this visit (build vs rebuild vs submit), so two
  --     concurrent rebuilds cannot both append against the same antecedent and fork
  --     the supersession chain.
  perform pg_advisory_xact_lock(hashtextextended('careos_evv:' || p_visit::text, 0));

  select v.client_id, v.caregiver_id, v.status,
         v.service_type_id, v.service_location_version_id
    into v_client, v_caregiver, v_visit_status, v_service_type, v_location_ver
    from public.visit v
   where v.id = p_visit and v.tenant_id = v_tenant
   for update;

  -- 4 · State: only a delivered visit has something to assert about.
  if v_visit_status <> 'completed' then
    raise exception
      'CAREOS_BAD_STATE: only a completed visit can be canonicalised (is %)', v_visit_status
      using errcode = 'P0001';
  end if;

  -- 5 · Times, from the append-only clock ledger with corrections applied.
  with clock as (
    select e.event_type,
           coalesce(
             (select c.occurred_at
                from public.visit_event c
               where c.corrects_event_id = e.id
               order by c.occurred_at desc, c.created_at desc
               limit 1),
             e.occurred_at) as effective_at,
           e.capture_source,
           e.is_offline
      from public.visit_event e
     where e.visit_id = p_visit and e.tenant_id = v_tenant
       and e.event_type in ('clock_in','clock_out'))
  select min(effective_at) filter (where event_type = 'clock_in'),
         max(effective_at) filter (where event_type = 'clock_out'),
         coalesce(bool_or(capture_source = 'manual'), false),
         coalesce(bool_or(is_offline), false)
    into v_start_at, v_end_at, v_manual, v_offline
    from clock;

  select exists (select 1 from public.visit_event c
                  where c.visit_id = p_visit and c.tenant_id = v_tenant
                    and c.event_type = 'correction')
    into v_corrected;

  if v_start_at is null or v_end_at is null then
    -- start_at/end_at are NOT NULL by §3.12, so a half-record is not storable. Refusing
    -- here is the honest outcome: the visit needs a correction, not a partial assertion.
    raise exception
      'CAREOS_EVV_NO_TIMES: the visit has no clock-in and clock-out pair to canonicalise'
      using errcode = 'P0001';
  end if;

  -- Calendar date of service, pinned to UTC so the same visit hashes identically on every
  -- machine. There is no agency-timezone column on public.tenant today; when one lands,
  -- this becomes a one-line change and a rebuild appends the corrected record (see the
  -- task result — flagged, not silently assumed).
  v_service_date := (v_start_at at time zone 'UTC')::date;

  -- 6 · Provenance. 'telephony' is unreachable in Phase 1 (no IVR capture exists); a
  --     corrected time outranks every other provenance claim, then a manual entry, then
  --     an offline replay (docs/17 §7.6: offline is never presented as ordinarily
  --     verified), else the browser capture.
  v_capture := case
                 when v_corrected then 'corrected'
                 when v_manual    then 'manual'
                 when v_offline   then 'offline_sync'
                 else 'web_gps'
               end;

  -- 7 · Payer + whether EVV applies at all, from the service catalog (§3.1).
  select st.evv_required, st.payer_kind
    into v_evv_required, v_payer_kind
    from public.service_type st
   where st.id = v_service_type and st.tenant_id = v_tenant;
  v_evv_required := coalesce(v_evv_required, false);
  v_payer_kind   := coalesce(v_payer_kind, 'other');

  -- 8 · Completeness: six booleans, one per element, and their conjunction. Three of the
  --     six are true in every storable row (client_id, service_date and the time pair are
  --     NOT NULL); they are still computed rather than hardcoded so the object reads the
  --     same way whatever the schema does later.
  v_elements := jsonb_build_object(
    'service_type',         v_service_type is not null,
    'individual_receiving', v_client is not null,
    'service_date',         v_service_date is not null,
    'service_location',     v_location_ver is not null,
    'individual_providing', v_caregiver is not null,
    'service_times',        (v_start_at is not null and v_end_at is not null));
  v_complete := (v_elements ->> 'service_type')::boolean
            and (v_elements ->> 'individual_receiving')::boolean
            and (v_elements ->> 'service_date')::boolean
            and (v_elements ->> 'service_location')::boolean
            and (v_elements ->> 'individual_providing')::boolean
            and (v_elements ->> 'service_times')::boolean;

  -- 9 · Canonicalisation: `key=value` pairs for the six elements ONLY, sorted by key and
  --     pipe-delimited, so the hash depends on what the record asserts and on nothing
  --     else — not on row id, not on created_at, not on assembly order. Timestamps are
  --     rendered in UTC to the second for the same reason.
  v_canonical :=
       'caregiver='                || coalesce(v_caregiver::text, '')
    || '|client='                  || coalesce(v_client::text, '')
    || '|service_date='            || to_char(v_service_date, 'YYYY-MM-DD')
    || '|service_location_version='|| coalesce(v_location_ver::text, '')
    || '|service_times='
    || to_char(v_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    || '~'
    || to_char(v_end_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    || '|service_type='            || coalesce(v_service_type::text, '');
  v_sha := encode(extensions.digest(convert_to(v_canonical, 'utf8'), 'sha256'), 'hex');

  -- 10 · Head of chain: the record nothing supersedes.
  select r.id, r.record_sha256
    into v_prior_id, v_prior_sha
    from public.evv_record r
   where r.source_visit_id = p_visit and r.tenant_id = v_tenant
     and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id)
   order by r.created_at desc
   limit 1;

  if v_prior_sha = v_sha then
    -- Nothing about the six elements moved. Appending an identical record would be
    -- noise on a ledger a surveyor has to read.
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'evv_record_id', v_prior_id,
                              'record_sha256', v_sha,
                              'is_complete', v_complete);
  end if;

  -- 11 · Append (never update — invariant 1). The audit event rides trg_evv_record_audit.
  insert into public.evv_record
    (tenant_id, source_visit_id, service_type_id, client_id, service_date,
     service_location_version_id, caregiver_id, start_at, end_at, capture_method,
     payer_kind, element_completeness, is_complete, record_sha256, supersedes_id)
  values
    (v_tenant, p_visit, v_service_type, v_client, v_service_date,
     v_location_ver, v_caregiver, v_start_at, v_end_at, v_capture,
     v_payer_kind, v_elements, v_complete, v_sha, v_prior_id)
  returning id into v_record_id;

  -- 12 · Any attempt still in flight for the superseded record is now describing an
  --      assertion we no longer make, so each open attempt gets a 'superseded' outcome
  --      row (§3.8's "current state = latest row" pattern).
  --      "Open" is defined WITHOUT ordering by created_at: the four terminal statuses are
  --      absorbing, so an attempt is open exactly when it has a pending/submitted row and
  --      no terminal row. This matters because rows written in one transaction all carry
  --      the same now() — a created_at ordering would be a coin flip there, and pgTAP
  --      runs every path inside one transaction.
  if v_prior_id is not null then
    insert into public.evv_submission
      (tenant_id, evv_record_id, adapter_id, attempt_no, status,
       request_sha256, submitted_at, resolved_at)
    select s.tenant_id, s.evv_record_id, s.adapter_id, s.attempt_no, 'superseded',
           max(s.request_sha256),      -- every row of one attempt carries the same hash
           max(s.submitted_at), now()
      from public.evv_submission s
     where s.evv_record_id = v_prior_id
       and s.status in ('pending','submitted')
       and not exists (
         select 1 from public.evv_submission t
          where t.evv_record_id = s.evv_record_id and t.adapter_id = s.adapter_id
            and t.attempt_no = s.attempt_no
            and t.status in ('accepted','rejected','reconciled','superseded'))
     group by s.tenant_id, s.evv_record_id, s.adapter_id, s.attempt_no;
    get diagnostics v_superseded = row_count;
  end if;

  -- 13 · Project onto the visit's EVV axis (D-024). row_version is deliberately NOT
  --      bumped: it is the scheduling surface's optimistic-concurrency token, and a
  --      back-office projection consuming it would manufacture keep-both conflicts
  --      (invariant 11) out of nothing.
  v_evv_status := case when v_evv_required then 'pending' else 'not_required' end;
  update public.visit
     set evv_status = v_evv_status, updated_at = now()
   where id = p_visit;

  -- 14 · Outbox (invariant 7). IDs, enums and a hash — consumers refetch under RLS.
  perform app.emit_event('evv.record.built', 'evv_record', v_record_id,
    jsonb_build_object('visit_id', p_visit,
                       'client_id', v_client,
                       'is_complete', v_complete,
                       'evv_status', v_evv_status,
                       'record_sha256', v_sha,
                       'supersedes_id', v_prior_id));

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'evv_record_id', v_record_id,
                            'record_sha256', v_sha,
                            'is_complete', v_complete,
                            'element_completeness', v_elements,
                            'capture_method', v_capture,
                            'evv_status', v_evv_status,
                            'supersedes_id', v_prior_id,
                            'superseded_submissions', v_superseded);
end $$;

-- ── app.submit_evv — hand the head record to whatever adapter is live, if any ─────────
-- A tenant with no enabled adapter is the NORMAL state today (Maryland ships disabled,
-- D-026), so "nothing to submit" is a no-op that returns `skipped`. Raising there would
-- turn the ratified configuration into a permanent error in every log and every UI.
create or replace function app.submit_evv(p_visit uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant      uuid := app.current_tenant_id();
  v_record_id   uuid;
  v_record_sha  text;
  v_complete    boolean;
  v_adapter_id  uuid;
  v_target      text;
  v_state_code  text;
  v_mode        text;
  v_open_id     uuid;
  v_attempt     int;
  v_submission  uuid;
begin
  -- 1 · Gate.
  if not app.is_aal2() then
    raise exception
      'CAREOS_AAL2_REQUIRED: a verified session is required to submit an EVV record'
      using errcode = '42501';
  end if;
  if not app.has_perm('evv.manage') then
    raise exception 'CAREOS_FORBIDDEN: evv.manage is required' using errcode = '42501';
  end if;

  -- 2 · Existence.
  if not exists (select 1 from public.visit v
                  where v.id = p_visit and v.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;

  -- 3 · Same lock key as the builder: a submit can never interleave with a rebuild.
  perform pg_advisory_xact_lock(hashtextextended('careos_evv:' || p_visit::text, 0));

  perform 1 from public.visit v
   where v.id = p_visit and v.tenant_id = v_tenant
   for update;

  select r.id, r.record_sha256, r.is_complete
    into v_record_id, v_record_sha, v_complete
    from public.evv_record r
   where r.source_visit_id = p_visit and r.tenant_id = v_tenant
     and not exists (select 1 from public.evv_record s where s.supersedes_id = r.id)
   order by r.created_at desc
   limit 1;
  if v_record_id is null then
    raise exception 'CAREOS_NOT_FOUND: evv record — build it first' using errcode = 'P0001';
  end if;

  -- 4 · Adapter resolution. Phase 1 is one live adapter per tenant (Maryland); the
  --     ordering makes "which one" deterministic if a second is ever enabled, and
  --     fan-out to several adapters is a later change, not an accident.
  select a.id, a.target, a.state_code, a.mode
    into v_adapter_id, v_target, v_state_code, v_mode
    from public.evv_adapter a
   where a.tenant_id = v_tenant and a.enabled and a.mode <> 'disabled'
   order by a.state_code, a.target
   limit 1;
  if v_adapter_id is null then
    return jsonb_build_object('ok', true, 'skipped', true,
                              'reason', 'adapter_disabled',
                              'evv_record_id', v_record_id);
  end if;

  -- 5 · An incomplete record is not something to send to a payer; it is a work item.
  if not v_complete then
    raise exception
      'CAREOS_EVV_INCOMPLETE: the canonical record is missing at least one element'
      using errcode = 'P0001';
  end if;

  -- 6 · Idempotent re-submit: an attempt already in flight is returned, not duplicated.
  --     "In flight" is order-free (see the builder's note): a pending/submitted row with
  --     no terminal row for the same attempt. Reading the LATEST row by created_at would
  --     be undefined inside a single transaction, and would also mistake the frozen
  --     'pending' antecedent of an already-accepted attempt for live work.
  select s.attempt_no, s.id
    into v_attempt, v_open_id
    from public.evv_submission s
   where s.evv_record_id = v_record_id and s.adapter_id = v_adapter_id
     and s.status in ('pending','submitted')
     and not exists (
       select 1 from public.evv_submission t
        where t.evv_record_id = s.evv_record_id and t.adapter_id = s.adapter_id
          and t.attempt_no = s.attempt_no
          and t.status in ('accepted','rejected','reconciled','superseded'))
   order by s.attempt_no desc,
            case s.status when 'submitted' then 2 else 1 end desc
   limit 1;
  if v_open_id is not null then
    return jsonb_build_object('ok', true, 'skipped', false, 'unchanged', true,
                              'submission_id', v_open_id,
                              'evv_record_id', v_record_id,
                              'attempt_no', v_attempt);
  end if;

  select coalesce(max(s.attempt_no), 0) + 1
    into v_attempt
    from public.evv_submission s
   where s.evv_record_id = v_record_id and s.adapter_id = v_adapter_id;

  -- 7 · Append the attempt. It is 'pending' until the worker reports back: the row
  --     records that we queued it, not that a vendor received it.
  insert into public.evv_submission
    (tenant_id, evv_record_id, adapter_id, attempt_no, status, request_sha256)
  values
    (v_tenant, v_record_id, v_adapter_id, v_attempt, 'pending', v_record_sha)
  returning id into v_submission;

  update public.visit
     set evv_status = 'pending', updated_at = now()
   where id = p_visit;

  -- 8 · Audit explicitly: evv_submission is written from TWO lanes (here and the worker),
  --     and a trigger's seed guard would silently drop the worker's half.
  perform app.emit_audit('evv.submitted', 'evv_submission', v_submission,
    jsonb_build_object('evv_record_id', v_record_id,
                       'visit_id', p_visit,
                       'adapter_id', v_adapter_id,
                       'target', v_target,
                       'state_code', v_state_code,
                       'mode', v_mode,
                       'attempt_no', v_attempt));
  -- 9 · The outbox IS the queue hand-off: app.emit_event writes domain_event and sends on
  --     pgmq 'q_events' in the same transaction (0027). A dedicated q_evv queue would
  --     require re-signing 0034's queue_read/queue_archive allowlist, which belongs to the
  --     devops slice, and would buy nothing the outbox does not already guarantee.
  perform app.emit_event('evv.submitted', 'evv_submission', v_submission,
    jsonb_build_object('evv_record_id', v_record_id,
                       'visit_id', p_visit,
                       'adapter_id', v_adapter_id,
                       'target', v_target,
                       'mode', v_mode,
                       'attempt_no', v_attempt));

  return jsonb_build_object('ok', true, 'skipped', false, 'unchanged', false,
                            'submission_id', v_submission,
                            'evv_record_id', v_record_id,
                            'attempt_no', v_attempt,
                            'adapter', jsonb_build_object(
                              'id', v_adapter_id, 'target', v_target,
                              'state_code', v_state_code, 'mode', v_mode));
end $$;

-- ── app.reconcile_evv — the worker lane records what the far side said ────────────────
-- service_role ONLY (D-020's machine lane): the Edge Function holds the vendor
-- connection, Postgres holds the truth. Because evv_submission is append-only, the
-- outcome is a NEW row for the same (evv_record_id, adapter_id, attempt_no) and the
-- attempt row it answers is left exactly as written — current state is the latest row.
--
-- `p_response_message` is VENDOR PROSE. It is truncated here and bounded by CHECK on the
-- table, and it must never carry PHI back into CareOS: nothing downstream may render it
-- to a caregiver surface, put it in a notification, or feed it to a model. Vendor codes
-- explain vendor behaviour; a client's details never need to make that round trip
-- (invariant 5, D-030).
create or replace function app.reconcile_evv(
  p_submission uuid, p_status text, p_external_reference text,
  p_response_code text, p_response_message text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant       uuid;
  v_record_id    uuid;
  v_adapter_id   uuid;
  v_attempt      int;
  v_prior_status text;
  v_request_sha  text;
  v_submitted_at timestamptz;
  v_visit_id     uuid;
  v_client_id    uuid;
  v_new_id       uuid;
begin
  -- 1 · Input sanity. 'pending' is not an outcome and 'superseded' belongs to the
  --     builder, so neither is reportable from the worker.
  if p_status not in ('submitted','accepted','rejected','reconciled') then
    raise exception
      'CAREOS_BAD_STATE: % is not a reconciliation outcome', p_status using errcode = 'P0001';
  end if;

  -- 2 · Existence. No tenant predicate: this lane has no session principal, so the
  --     submission id IS the scope, and the tenant is read off the row it names.
  select s.tenant_id, s.evv_record_id, s.adapter_id, s.attempt_no, s.status,
         s.request_sha256, s.submitted_at
    into v_tenant, v_record_id, v_adapter_id, v_attempt, v_prior_status,
         v_request_sha, v_submitted_at
    from public.evv_submission s
   where s.id = p_submission;
  if v_record_id is null then
    raise exception 'CAREOS_NOT_FOUND: evv submission' using errcode = 'P0001';
  end if;

  select r.source_visit_id, r.client_id
    into v_visit_id, v_client_id
    from public.evv_record r
   where r.id = v_record_id;

  -- 3 · Terminal or already-reported attempts are a no-op, never an error: a worker
  --     retrying after a lost ack must be safe by construction (the 0034
  --     complete_revocation_step_system posture). The guard reads the whole ATTEMPT, not
  --     just the row named — the terminal statuses are absorbing, so once one exists the
  --     attempt is closed no matter which of its rows the worker points at.
  if exists (select 1 from public.evv_submission t
              where t.evv_record_id = v_record_id and t.adapter_id = v_adapter_id
                and t.attempt_no = v_attempt
                and (t.status in ('accepted','rejected','reconciled','superseded')
                     or t.status = p_status)) then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'submission_id', p_submission,
                              'status', v_prior_status);
  end if;

  -- 4 · Same key the session lane takes, so a reconciliation cannot interleave with a
  --     rebuild of the very record it is answering.
  perform pg_advisory_xact_lock(hashtextextended('careos_evv:' || v_visit_id::text, 0));

  perform 1 from public.visit v where v.id = v_visit_id for update;

  -- When the attempt was actually transmitted is a property of the ATTEMPT, not of the
  -- row the worker happened to name, so it is carried forward across the whole chain.
  select max(s.submitted_at)
    into v_submitted_at
    from public.evv_submission s
   where s.evv_record_id = v_record_id and s.adapter_id = v_adapter_id
     and s.attempt_no = v_attempt;

  -- 5 · Append the outcome.
  insert into public.evv_submission
    (tenant_id, evv_record_id, adapter_id, attempt_no, status, external_reference,
     response_code, response_message, request_sha256, submitted_at, resolved_at)
  values
    (v_tenant, v_record_id, v_adapter_id, v_attempt, p_status,
     left(p_external_reference, 200), left(p_response_code, 64),
     left(p_response_message, 500),                     -- vendor prose, bounded (see above)
     v_request_sha,
     case when p_status = 'submitted' then now() else coalesce(v_submitted_at, now()) end,
     case when p_status = 'submitted' then null else now() end)
  returning id into v_new_id;

  -- 6 · Project onto the visit's EVV axis. The four outcome values are exactly the four
  --     non-initial values of visit.evv_status (§3.5), so the mapping is identity.
  update public.visit
     set evv_status = p_status, updated_at = now()
   where id = v_visit_id;

  -- 7 · Audit + outbox on the SYSTEM emitters: there is no session principal here, so
  --     app.emit_audit would raise CAREOS_NO_TENANT_CONTEXT and the trigger-side seed
  --     guard would drop the row. Payload is IDs, enums and the vendor CODE only — the
  --     vendor MESSAGE never leaves the row it landed in.
  perform app.emit_audit_system(v_tenant, 'system', 'evv.reconciled',
    'evv_submission', v_new_id,
    jsonb_build_object('evv_record_id', v_record_id,
                       'visit_id', v_visit_id,
                       'adapter_id', v_adapter_id,
                       'attempt_no', v_attempt,
                       'from', v_prior_status,
                       'to', p_status,
                       'response_code', left(p_response_code, 64)));
  -- docs/17 §8 names evv.accepted and evv.rejected as domain events; 'submitted' and
  -- 'reconciled' are ledger transitions with no subscriber, so they stay on the audit
  -- chain only rather than inventing event types the contract does not list.
  if p_status in ('accepted','rejected') then
    perform app.emit_event_system(v_tenant, 'evv.' || p_status,
      'evv_record', v_record_id,
      jsonb_build_object('submission_id', v_new_id,
                         'visit_id', v_visit_id,
                         'client_id', v_client_id,
                         'attempt_no', v_attempt,
                         'response_code', left(p_response_code, 64)));
  end if;

  return jsonb_build_object('ok', true, 'unchanged', false,
                            'submission_id', v_new_id,
                            'answers_submission_id', p_submission,
                            'evv_record_id', v_record_id,
                            'visit_id', v_visit_id,
                            'attempt_no', v_attempt,
                            'status', p_status);
end $$;

-- ── Grants: two session lanes in, one worker lane out (invariant 6) ────────────────────
-- build/submit are user-scoped and never reachable by service_role; reconcile is the
-- worker's and is never reachable from a request path. The two sets do not intersect.
revoke all on function
  app.build_evv_record(uuid),
  app.submit_evv(uuid)
from public, anon;
grant execute on function
  app.build_evv_record(uuid),
  app.submit_evv(uuid)
to authenticated;

revoke all on function
  app.reconcile_evv(uuid, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  app.reconcile_evv(uuid, text, text, text, text)
to service_role;
