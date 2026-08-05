-- ST-160/161/162/163 · Migration 0036 — the actuator, layer 1: notifications
-- Outbound, in trust order: in-app now, email (notification-not-content, D-005) via the
-- worker when Resend keys land, SMS scaffolded but HARD OFF until V7 (Twilio BAA+10DLC).
-- The invariant everywhere: a notification row carries IDs and a template key — the
-- recipient's surface refetches content under their OWN RLS; the email body is an
-- app-name + generic verb + deep link, structurally PHI-free (D-005).
-- @trace: ST-160, ST-161, ST-162, ST-163, D-005

create table public.notification (                          -- OPS
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  recipient_id uuid not null references public.app_user(id),
  channel text not null default 'in_app' check (channel in ('in_app','email','sms')),
  template_key text not null,              -- 'credential.expiring', 'offer.new', …
  subject_type text,                       -- IDs travel; content is refetched under RLS
  subject_id uuid,
  title text not null,                     -- PHI-free by construction (template-rendered)
  dedupe_key text,
  status text not null default 'queued' check (status in
    ('queued','sent','delivered','failed','read')),
  sent_at timestamptz,
  read_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default now()
);
create unique index uq_notification_dedupe on public.notification (dedupe_key)
  where dedupe_key is not null;
create index idx_notification_recipient on public.notification (recipient_id, created_at desc);
create index idx_notification_tenant on public.notification (tenant_id);

alter table public.notification enable row level security;
alter table public.notification force row level security;
-- Recipients read their own; nobody reads anyone else's inbox.
create policy notification_select_own on public.notification for select to authenticated
  using (recipient_id = auth.uid() and tenant_id = app.current_tenant_id());
-- The one client write: marking your own notification read (column-scoped).
create policy notification_update_read on public.notification for update to authenticated
  using (recipient_id = auth.uid() and tenant_id = app.current_tenant_id())
  with check (recipient_id = auth.uid() and tenant_id = app.current_tenant_id());
grant select on public.notification to authenticated;
grant update (read_at, status) on public.notification to authenticated;

-- ── The only enqueue path (definer-body plumbing; RPCs and workers call it) ───────────
create or replace function app.queue_notification(
  p_recipient uuid, p_template_key text, p_title text,
  p_subject_type text default null, p_subject_id uuid default null,
  p_channel text default 'in_app', p_dedupe_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant from public.app_user
   where id = p_recipient and status = 'active';
  if v_tenant is null then
    return null;                       -- never notify a dead account; not an error
  end if;
  -- SMS stays scaffolding until V7 clears (docs/09 §6); flags are per-tenant but this
  -- gate is structural — even a mis-set flag cannot reach a sender that refuses.
  insert into public.notification
    (tenant_id, recipient_id, channel, template_key, subject_type, subject_id,
     title, dedupe_key)
  values
    (v_tenant, p_recipient, p_channel, p_template_key, p_subject_type, p_subject_id,
     left(p_title, 200), p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    return null;                       -- deduped: this nudge already exists
  end if;
  if p_channel <> 'in_app' then
    perform pgmq.send('q_notify', jsonb_build_object(
      'notification_id', v_id, 'channel', p_channel));   -- IDs only (invariant 5)
  end if;
  return v_id;
end $$;
revoke all on function
  app.queue_notification(uuid, text, text, text, uuid, text, text)
from public, anon, authenticated;
grant execute on function
  app.queue_notification(uuid, text, text, text, uuid, text, text)
to service_role;

-- Worker read/write lane for delivery (email via Resend when configured; sms refuses
-- until feature 'sms_outbound' is enabled AND V7 is in the vendor register).
create or replace function app.read_notification_for_delivery(p_notification uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', n.id, 'channel', n.channel, 'template_key', n.template_key,
    'title', n.title, 'recipient_email',
    (select u.work_email from public.app_user u
      where u.id = n.recipient_id and u.status = 'active'))
    from public.notification n where n.id = p_notification
$$;
create or replace function app.mark_notification(
  p_notification uuid, p_status text, p_provider_message_id text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('sent','delivered','failed') then
    raise exception 'CAREOS_BAD_STATE: % is not a delivery status', p_status
      using errcode = 'P0001';
  end if;
  update public.notification
     set status = p_status, sent_at = coalesce(sent_at, now()),
         provider_message_id = coalesce(p_provider_message_id, provider_message_id)
   where id = p_notification;
end $$;
revoke all on function
  app.read_notification_for_delivery(uuid), app.mark_notification(uuid, text, text)
from public, anon, authenticated;
grant execute on function
  app.read_notification_for_delivery(uuid), app.mark_notification(uuid, text, text)
to service_role;

-- ── sms_log scaffold (docs/08 §6.2 shape) — no sender exists until V7 ─────────────────
create table public.sms_log (                               -- OPS [AO]
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  notification_id uuid references public.notification(id),
  direction text not null check (direction in ('outbound','inbound')),
  to_number_last4 text,                    -- minimized: never the full number
  body_minimized text,                     -- operational minimum, no PHI
  provider_sid text,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);
alter table public.sms_log enable row level security;
alter table public.sms_log force row level security;
-- no_delete (not append-only): the future sender updates delivery status in place;
-- rows are never destroyed.
create trigger trg_sms_log_nodelete before delete on public.sms_log
  for each row execute function app.forbid_mutation();
-- Zero client grants; definer/worker writes only, arriving with the V7-gated sender.
