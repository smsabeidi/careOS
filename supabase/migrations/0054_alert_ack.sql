-- ST-238 · Migration 0054 — alert_ack: the attention queue's append-only acknowledgement ledger
-- The Front Door program's W5 (docs/designs/intelligent-front-door.md, review finding R1/1A).
-- The unified attention queue at /inbox merges six existing sources — pending AI proposals,
-- credential lapses and the 60/30/0 cadence ladder, visit exceptions, clinical flags,
-- notifications, offers — and a queue nobody can clear becomes wallpaper within a month:
-- alert fatigue is the exact failure the queue exists to prevent. This table is the
-- clearing mechanism, and it is APPEND-ONLY (invariant 1): dismissing an alert is itself
-- an audit-visible act, which is precisely what a surveyor wants to see ("who saw this
-- credential warning, and when"). Un-acking does not exist; a source whose underlying
-- condition re-fires produces a NEW source row (new dedupe key ⇒ new source_id), which
-- arrives un-acked by construction.
--
-- Shape: (tenant_id, user_id, source, source_id) unique — one ack per person per alert,
-- a second tap is an ON CONFLICT no-op (idempotency is a return value, the 0023 posture).
-- Acks are PER USER deliberately: the queue is each person's attention, not a shared
-- checkbox — a coordinator acking a lapse warning must not silently clear it from the
-- owner's queue. `source` is a closed enum of the queue's six lanes so a typo'd caller
-- cannot invent a seventh lane the UI never reads.
--
-- Not PHI by content (a user id, an enum, a uuid, a timestamp), but source_id points at
-- rows that are, so reads stay inside the owner's own rows and the queue surface itself
-- carries the AAL2 gate (its sources do; an ack row alone discloses nothing).
-- Write path is a definer RPC (app.ack_alert) rather than a direct INSERT grant, so the
-- source enum, the self-only rule and the audit emission cannot be forgotten by a future
-- surface (the Lane-B reasoning at 0023 §6.1 scale — small, but the same shape).
-- @trace: ST-238, docs/designs/intelligent-front-door.md W5, R1/1A, invariant 1, invariant 7

create table public.alert_ack (                                        -- [AO] OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  user_id uuid not null references public.app_user(id),
  source text not null check (source in
    ('proposal','credential','exception','clinical','notification','offer')),
  source_id uuid not null,
  acked_at timestamptz not null default now(),
  constraint uq_alert_ack unique (tenant_id, user_id, source, source_id)
);
create index idx_alert_ack_tenant_user on public.alert_ack (tenant_id, user_id, acked_at desc);
-- The queue's anti-join access path: "rows of source S not acked by me".
create index idx_alert_ack_lookup on public.alert_ack (user_id, source, source_id);

create trigger trg_alert_ack_ao before update or delete on public.alert_ack
  for each row execute function app.forbid_mutation();

alter table public.alert_ack enable row level security;
alter table public.alert_ack force row level security;

-- Read: your own acks, full stop. Nobody triages somebody else's attention, and the
-- audit ledger (below) is where an administrator reads the acknowledgement history.
create policy alert_ack_select_own on public.alert_ack for select to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = auth.uid());

grant select on public.alert_ack to authenticated;
  -- no insert/update/delete: append-only, and app.ack_alert is the only writer

-- ── app.ack_alert — the one way to clear a row from your queue ────────────────────────
-- Self-only by construction: the row is written for auth.uid(), never for a parameter,
-- so "ack somebody else's queue" is not expressible. Active-principal and tenancy come
-- from app.current_tenant_id() (0022 fails closed for separated/suspended principals).
-- The audit event is the point (invariant 7): dismissal of a warning is a consequential
-- act, and "who was told and clicked it away" is the question that follows an incident.
create or replace function app.ack_alert(p_source text, p_source_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_id uuid;
begin
  if v_tenant is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: an active principal is required'
      using errcode = 'P0001';
  end if;
  if p_source is null or p_source not in
     ('proposal','credential','exception','clinical','notification','offer') then
    raise exception 'CAREOS_BAD_SOURCE: % is not an attention-queue lane', p_source
      using errcode = 'P0001';
  end if;
  if p_source_id is null then
    raise exception 'CAREOS_NOT_FOUND: alert' using errcode = 'P0001';
  end if;

  insert into public.alert_ack (tenant_id, user_id, source, source_id)
  values (v_tenant, auth.uid(), p_source, p_source_id)
  on conflict on constraint uq_alert_ack do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', true, 'unchanged', true,
                              'source', p_source, 'source_id', p_source_id);
  end if;

  perform app.emit_audit('alert.acknowledged', 'alert_ack', v_id,
    jsonb_build_object('source', p_source, 'source_id', p_source_id));

  return jsonb_build_object('ok', true, 'unchanged', false, 'ack_id', v_id,
                            'source', p_source, 'source_id', p_source_id);
end $$;
revoke all on function app.ack_alert(text, uuid) from public, anon;
grant execute on function app.ack_alert(text, uuid) to authenticated;
