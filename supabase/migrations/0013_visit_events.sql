-- Migration 0013 — web-based EVV: append-only visit clock events + the clock_visit RPC.
-- Decision (docs/00 §3): NO native mobile app. The responsive web app is the caregiver
-- surface, and Electronic Visit Verification (clock in/out + location + timestamp, a
-- federal Medicaid requirement) is captured in the browser via navigator.geolocation and
-- written through app.clock_visit(). This supersedes the native-mobile/PowerSync EVV wave.
--
-- Design:
--   * visit_event [AO] is the tamper-evident EVV ledger — one row per clock in/out, with
--     the captured coordinates. It is append-only (a clock event is a record of consequence,
--     invariant 1) and written ONLY through the RPC (no direct insert grant), so a client
--     cannot forge a clock event out of band.
--   * app.clock_visit() is a Lane-B, SECURITY DEFINER transition RPC (like app.finalize_form):
--     it verifies the caller is the ASSIGNED caregiver on an AAL2 session, appends the event,
--     and advances visit.status (scheduled→in_progress on clock-in, →completed on clock-out).
--     Location is PHI-sensitive, so it never appears in an audit payload (invariant 5); the
--     audit records only the visit id + event type.
-- @trace: docs/07 §6 (EVV), docs/09, Wave "web EVV"

-- ── Audit emitter (definer; location deliberately excluded from the payload) ──────
create or replace function app.audit_visit_event() returns trigger
language plpgsql security definer set search_path = public, audit, extensions as $$
begin
  if app.current_tenant_id() is not null then
    perform app.emit_audit('visit.' || new.event_type, 'visit_event', new.id,
      jsonb_build_object('visit_id', new.visit_id, 'method', new.method));  -- never lat/lng
  end if;
  return null;
end $$;
revoke all on function app.audit_visit_event() from public;

-- ── visit_event — append-only EVV clock ledger ─────────────────────────── [AO] PHI
create table public.visit_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  visit_id uuid not null references public.visit(id),
  caregiver_id uuid not null references public.app_user(id),
  event_type text not null check (event_type in ('clock_in','clock_out')),
  occurred_at timestamptz not null default now(),
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  method text not null default 'web' check (method in ('web','manual')),
  note text,
  created_at timestamptz not null default now()
);
create index idx_visit_event_visit on public.visit_event (visit_id, occurred_at);
create index idx_visit_event_caregiver on public.visit_event (caregiver_id, occurred_at);
create index idx_visit_event_tenant on public.visit_event (tenant_id);

create trigger trg_visit_event_ao before update or delete on public.visit_event
  for each row execute function app.forbid_mutation();
create trigger trg_visit_event_audit after insert on public.visit_event
  for each row execute function app.audit_visit_event();

alter table public.visit_event enable row level security;
alter table public.visit_event force row level security;
-- Read: the caregiver who clocked (own events), schedule.read (coordinators/admin), or a
-- care-team member on the visit's client. PHI ⇒ AAL2. Writes go through the RPC only.
create policy visit_event_select_scoped on public.visit_event for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2() and (
    caregiver_id = auth.uid()
    or app.has_perm('schedule.read')
    or exists (select 1 from public.visit v
                where v.id = visit_id and app.on_care_team(v.client_id))));
grant select on public.visit_event to authenticated;   -- append-only; no insert/update/delete grant

-- ── app.clock_visit — Lane-B transition RPC (assigned caregiver clocks in/out) ────
create or replace function app.clock_visit(
  p_visit uuid, p_event text,
  p_lat double precision default null, p_lng double precision default null,
  p_accuracy double precision default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.visit;
  v_status text;
  v_event_id uuid;
begin
  if p_event not in ('clock_in','clock_out') then
    raise exception 'CAREOS_BAD_EVENT: event must be clock_in or clock_out' using errcode = 'P0001';
  end if;
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to clock a visit' using errcode = '42501';
  end if;
  select * into v from public.visit where id = p_visit and tenant_id = app.current_tenant_id();
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: visit' using errcode = 'P0001';
  end if;
  -- Only the ASSIGNED caregiver may clock their own visit.
  if v.caregiver_id is distinct from auth.uid() then
    raise exception 'CAREOS_FORBIDDEN: only the assigned caregiver can clock this visit' using errcode = '42501';
  end if;

  insert into public.visit_event
    (tenant_id, visit_id, caregiver_id, event_type, latitude, longitude, accuracy_m, method)
  values
    (v.tenant_id, v.id, auth.uid(), p_event, p_lat, p_lng, p_accuracy, 'web')
  returning id into v_event_id;

  v_status := case when p_event = 'clock_in' then 'in_progress' else 'completed' end;
  update public.visit set status = v_status, updated_at = now(), row_version = row_version + 1
    where id = v.id;   -- definer bypasses schedule.write RLS; caller already proven to be the caregiver

  return jsonb_build_object('ok', true, 'status', v_status, 'event_id', v_event_id, 'occurred_at', now());
end $$;
revoke all on function app.clock_visit(uuid, text, double precision, double precision, double precision) from public, anon;
grant execute on function app.clock_visit(uuid, text, double precision, double precision, double precision) to authenticated;
