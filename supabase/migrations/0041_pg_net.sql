-- ST-181 · Migration 0041 — pg_net, explicitly
-- The local stack ships pg_net pre-installed, which masked that 0034 never created the
-- extension — on hosted, every careos_queue_pump tick failed with `schema "net" does
-- not exist` (visible in cron.job_run_details, which is exactly where the runbook says
-- to look). The extension belongs to the migration chain, not to an environment's
-- defaults.
-- @trace: ST-181, 0034
create extension if not exists pg_net;
