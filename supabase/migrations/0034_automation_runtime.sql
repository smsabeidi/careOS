-- ST-150/151/152 · Migration 0034 — the automation runtime: cron, heartbeats, worker plane
-- "Nothing scheduled actually runs" ends here. Three layers:
--   1. pg_cron drives the deterministic ticks entirely inside Postgres (the 0009:246
--      comment becomes a real job), plus a per-minute queue pump that invokes the worker
--      Edge Function through pg_net. The worker URL/secret live in Supabase Vault
--      (docs/09 §5 custody — never hardcoded in a migration); an unconfigured pump
--      heartbeats honestly instead of failing silently.
--   2. Every job writes public.job_heartbeat through app.run_job (exception-safe), and
--      app.check_heartbeats flags anything quieter than 2× its expected interval —
--      a dead consumer can no longer wedge invisibly (S1-6/S8-1/S8-2).
--   3. app.health_check() is the outer probe: the GitHub Actions deadman (CI already
--      holds credentials per docs/09 §5 — no new vendor) fails loudly on stall, guarding
--      against pg_cron itself wedging.
-- Also lands the worker's service_role RPC contract (queue_read/queue_archive/
-- read_domain_event/read_document_for_destruction/complete_revocation_step_system):
-- the Edge Function stays a thin REST client; Postgres remains the authority.
-- @trace: ST-150, ST-151, ST-152, S1-6, S8-1, S8-2, docs/11 §7

create extension if not exists pg_cron;

-- The remaining queues (q_events landed in 0027).
select pgmq.create('q_ai_jobs');
select pgmq.create('q_notify');

-- ── Heartbeats ────────────────────────────────────────────────────────────────────────
create table public.job_heartbeat (                         -- OPS (platform, tenant-less
  job_key text primary key,                                 --  by design: ops telemetry,
  expected_interval_seconds int not null,                   --  zero tenant data)
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.job_heartbeat enable row level security;
alter table public.job_heartbeat force row level security;
-- Zero client grants: written by definer plumbing, read through health RPCs.

create or replace function app.worker_heartbeat(
  p_job_key text, p_ok boolean, p_error text default null,
  p_interval_seconds int default 120
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.job_heartbeat as h
    (job_key, expected_interval_seconds, last_ok_at, last_error, last_error_at)
  values
    (p_job_key, p_interval_seconds,
     case when p_ok then now() end,
     case when not p_ok then left(p_error, 500) end,
     case when not p_ok then now() end)
  on conflict (job_key) do update set
    expected_interval_seconds = excluded.expected_interval_seconds,
    last_ok_at   = case when p_ok then now() else h.last_ok_at end,
    last_error   = case when not p_ok then left(p_error, 500) else h.last_error end,
    last_error_at = case when not p_ok then now() else h.last_error_at end,
    updated_at = now();
end $$;
revoke all on function app.worker_heartbeat(text, boolean, text, int)
  from public, anon, authenticated;
grant execute on function app.worker_heartbeat(text, boolean, text, int) to service_role;

-- Exception-safe job wrapper: the tick itself can fail, the heartbeat record cannot.
create or replace function app.run_job(
  p_job_key text, p_interval_seconds int, p_sql text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  execute p_sql;
  perform app.worker_heartbeat(p_job_key, true, null, p_interval_seconds);
exception when others then
  perform app.worker_heartbeat(p_job_key, false, sqlerrm, p_interval_seconds);
end $$;
revoke all on function app.run_job(text, int, text) from public, anon, authenticated;

create or replace function app.check_heartbeats()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'job_key', h.job_key,
           'last_ok_at', h.last_ok_at,
           'last_error', h.last_error)), '[]'::jsonb)
    from public.job_heartbeat h
   where h.last_ok_at is null
      or now() - h.last_ok_at > make_interval(secs => 2 * h.expected_interval_seconds)
$$;
revoke all on function app.check_heartbeats() from public, anon, authenticated;

create or replace function app.health_check() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ok', (select count(*) = 0 from jsonb_array_elements(app.check_heartbeats())),
    'checked_at', now(),
    'stalled', app.check_heartbeats())
$$;
revoke all on function app.health_check() from public, anon, authenticated;
grant execute on function app.health_check() to service_role;

-- ── Queue pump: pg_cron → pg_net → the worker Edge Function ───────────────────────────
-- URL + shared secret come from Vault at runtime (DEPLOY.md step); a missing secret is
-- an honest 'pump.unconfigured' heartbeat, never a silent no-op.
create or replace function app.pump_queues() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'careos_worker_url';
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'careos_worker_secret';
  exception when others then
    v_url := null;
  end;
  if v_url is null or v_secret is null then
    perform app.worker_heartbeat('pump.queues', false, 'unconfigured: vault secrets missing', 60);
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-careos-worker-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000);
  perform app.worker_heartbeat('pump.queues', true, null, 60);
end $$;
revoke all on function app.pump_queues() from public, anon, authenticated;

-- ── The scheduled ticks (0009:246's comment becomes real) ─────────────────────────────
select cron.schedule('careos_cadence_tick', '5 * * * *',
  $$select app.run_job('cadence_tick', 3600, 'select app.evaluate_compliance()')$$);
select cron.schedule('careos_queue_pump', '* * * * *',
  $$select app.pump_queues()$$);
select cron.schedule('careos_retention_sweep', '15 3 * * *',
  $$select app.run_job('retention_sweep', 86400, 'select app.retention_sweep()')$$);
select cron.schedule('careos_deadman', '*/5 * * * *',
  $$select app.run_job('deadman', 300, 'select app.check_heartbeats()')$$);

-- ── Worker RPC contract (service_role only — the Edge Function's whole API) ───────────
create or replace function app.queue_read(
  p_queue text, p_vt_seconds int default 60, p_batch int default 10
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  if p_queue not in ('q_events','q_ai_jobs','q_notify') then
    raise exception 'CAREOS_BAD_QUEUE: %', p_queue using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'msg_id', m.msg_id, 'read_ct', m.read_ct, 'message', m.message)), '[]'::jsonb)
    into v
    from pgmq.read(p_queue, p_vt_seconds, p_batch) m;
  return v;
end $$;

create or replace function app.queue_archive(p_queue text, p_msg_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_queue not in ('q_events','q_ai_jobs','q_notify') then
    raise exception 'CAREOS_BAD_QUEUE: %', p_queue using errcode = 'P0001';
  end if;
  return pgmq.archive(p_queue, p_msg_id);
end $$;

create or replace function app.read_domain_event(p_event uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(e) from public.domain_event e where e.id = p_event
$$;

create or replace function app.read_document_for_destruction(p_document uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('bucket', d.bucket, 'storage_path', d.storage_path)
    from public.document d
   where d.id = p_document and d.destroy_requested_at is not null
$$;

-- The worker's lane of the revocation saga: only the three machine steps, system actor.
create or replace function app.complete_revocation_step_system(
  p_tenant uuid, p_user uuid, p_step text, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.revocation_checklist;
  v_remaining int;
begin
  if p_step not in ('auth_ban','refresh_revoke','push_invalidate') then
    raise exception
      'CAREOS_FORBIDDEN_STEP: % is a human step — the desk completes it', p_step
      using errcode = 'P0001';
  end if;
  select * into v from public.revocation_checklist
   where user_id = p_user and step = p_step and tenant_id = p_tenant
   for update;
  if v.id is null then
    raise exception 'CAREOS_NOT_FOUND: revocation step' using errcode = 'P0001';
  end if;
  if v.status <> 'pending' then
    return jsonb_build_object('ok', true, 'already_done', true);
  end if;
  update public.revocation_checklist
     set status = 'done', completed_by = null, completed_at = now(), note = p_note
   where id = v.id;
  perform app.emit_audit_system(p_tenant, 'system', 'identity.revocation_step',
    'app_user', p_user, jsonb_build_object('step', p_step, 'outcome', 'done'));
  select count(*) into v_remaining from public.revocation_checklist
   where user_id = p_user and status = 'pending';
  if v_remaining = 0 then
    perform app.emit_audit_system(p_tenant, 'system', 'identity.revocation_verified',
      'app_user', p_user, '{}');
    perform app.emit_event_system(p_tenant, 'identity.revocation_verified',
      'app_user', p_user, '{}');
  end if;
  return jsonb_build_object('ok', true, 'remaining', v_remaining);
end $$;

revoke all on function
  app.queue_read(text, int, int),
  app.queue_archive(text, bigint),
  app.read_domain_event(uuid),
  app.read_document_for_destruction(uuid),
  app.complete_revocation_step_system(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function
  app.queue_read(text, int, int),
  app.queue_archive(text, bigint),
  app.read_domain_event(uuid),
  app.read_document_for_destruction(uuid),
  app.complete_revocation_step_system(uuid, uuid, text, text)
to service_role;
