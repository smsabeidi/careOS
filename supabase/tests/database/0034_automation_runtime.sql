-- pgTAP · automation runtime: cron jobs scheduled, heartbeat/deadman mechanics, queue
-- wrappers, the worker's revocation lane, honest unconfigured-pump behavior.
-- @trace: ST-150, ST-151, ST-152
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── The ticks are scheduled (0009:246's comment is dead) ───────────────────
select ok(
  (select count(*) >= 4 from cron.job where jobname like 'careos_%'),
  'cron: the careos jobs are scheduled (cadence, pump, retention, deadman)');
select is(
  (select schedule from cron.job where jobname = 'careos_cadence_tick'),
  '5 * * * *', 'cron: the compliance evaluator ticks hourly');

-- ── Heartbeats + deadman ───────────────────────────────────────────────────
select lives_ok($$select app.run_job('t_ok', 60, 'select 1')$$,
  'runtime: run_job records a clean pass');
select ok(
  (select last_ok_at is not null and last_error is null
     from public.job_heartbeat where job_key = 't_ok'),
  'runtime: the clean pass heartbeats ok');
select lives_ok($$select app.run_job('t_boom', 60, 'select 1/0')$$,
  'runtime: a failing tick is caught, never thrown');
select ok(
  (select last_error like '%division by zero%'
     from public.job_heartbeat where job_key = 't_boom'),
  'runtime: the failure is recorded on the heartbeat');

insert into public.job_heartbeat (job_key, expected_interval_seconds, last_ok_at)
values ('t_stalled', 60, now() - interval '10 minutes');
select ok(
  (select app.check_heartbeats() @> '[{"job_key": "t_stalled"}]'),
  'deadman: a job quieter than 2x its interval is flagged');
select is(
  ((app.health_check()) ->> 'ok'), 'false',
  'deadman: health_check goes red on a stall');
-- Live cron has been running since the reset (pump heartbeats 'unconfigured' locally),
-- so clear the whole board before asserting green — the rollback restores reality.
delete from public.job_heartbeat where job_key <> 't_ok';
select is(
  ((app.health_check()) ->> 'ok'), 'true',
  'deadman: health_check is green when nothing stalls');

-- ── Unconfigured pump is honest, not silent ────────────────────────────────
select lives_ok($$select app.pump_queues()$$,
  'pump: runs without vault secrets configured');
select ok(
  (select last_error like 'unconfigured%'
     from public.job_heartbeat where job_key = 'pump.queues'),
  'pump: the missing configuration is on the heartbeat, loudly');

-- ── Queue wrappers (the worker''s API) ─────────────────────────────────────
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'admin.a@meadowbrook.test');
insert into public.tenant (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tenant A');
insert into public.app_user (id, tenant_id, full_name, work_email, kind) values
  ('aaaaaaaa-0000-0000-0000-0000000000ad', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin A', 'admin.a@meadowbrook.test', 'staff');

select lives_ok(
  $$select app.emit_event_system('aaaaaaaa-0000-0000-0000-000000000001',
      'probe.event', 'probe', null, '{}')$$,
  'queues: a system event lands on the outbox');
select ok(
  (select jsonb_array_length(app.queue_read('q_events', 0, 5)) >= 1),
  'queues: the worker reads the message batch');
-- vt=0 above keeps the message visible, so the archive read finds it again.
select ok(
  (select app.queue_archive('q_events',
     ((app.queue_read('q_events', 0, 5)) -> 0 ->> 'msg_id')::bigint)),
  'queues: the worker archives a handled message');
select throws_like(
  $$select app.queue_read('pg_shadow_dump', 30, 5)$$,
  '%CAREOS_BAD_QUEUE%', 'queues: only the three careos queues are reachable');

-- ── The worker''s revocation lane: machine steps only, system actor ────────
insert into public.revocation_checklist (tenant_id, user_id, step) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000ad', 'auth_ban'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000ad', 'equipment_return');
select lives_ok(
  $$select app.complete_revocation_step_system(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-0000000000ad', 'auth_ban', 'worker: admin api')$$,
  'worker lane: the machine step completes');
select ok(
  (select completed_by is null and status = 'done'
     from public.revocation_checklist where step = 'auth_ban'),
  'worker lane: the completion is a system act (no human attribution)');
select throws_like(
  $$select app.complete_revocation_step_system(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-0000000000ad', 'equipment_return', 'nope')$$,
  '%CAREOS_FORBIDDEN_STEP%',
  'worker lane: human steps are unreachable from the system path');
select is(
  (select count(*)::int from audit.audit_event
    where action = 'identity.revocation_step' and actor_kind = 'system'),
  1, 'worker lane: the system completion is on the ledger as a system act');

-- ── Grants: the whole plane is service_role-only ───────────────────────────
select ok(not has_function_privilege('authenticated', 'app.queue_read(text,int,int)', 'execute'),
  'grants: authenticated cannot read queues');
select ok(not has_function_privilege('authenticated', 'app.health_check()', 'execute'),
  'grants: authenticated cannot probe health');
select ok(has_function_privilege('service_role', 'app.health_check()', 'execute'),
  'grants: service_role probes health (the GH deadman''s path)');
select ok(not has_table_privilege('authenticated', 'public.job_heartbeat', 'select'),
  'grants: heartbeats are platform telemetry, not client data');
select ok(not has_function_privilege('authenticated', 'app.read_worker_shared_secret()', 'execute'),
  'grants: the worker shared secret is service_role custody only (0040)');
select ok(has_function_privilege('service_role', 'app.read_worker_shared_secret()', 'execute'),
  'grants: the worker reads its secret through its own lane (0040)');

reset role;
select * from finish();
rollback;
