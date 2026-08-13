-- ST-230 · Migration 0053 — relocate pg_net out of the public schema
-- Closes the one hosted security-advisor WARN this deploy inherited: 0041 installed
-- pg_net without a schema clause, which lands the EXTENSION OBJECT in public
-- (extension_in_public lint). Its working objects live in the `net` schema either way —
-- net.http_post and friends do not move — so pg_cron jobs, the outbox pump and the
-- worker keep calling exactly what they called before. pg_net supports this relocation
-- from 0.10.0 (hosted runs 0.20.4); the drop/create pair executes inside one migration
-- transaction, so there is no window in which net.http_post does not exist.
--
-- Guarded: environments running the Docker-free harness (scripts/local-pg) shim pg_net
-- and have no real extension row to move; they no-op here rather than fail the chain.
-- @trace: ST-230, docs/13 (advisor hygiene), 0041
do $$
begin
  if exists (select 1
               from pg_extension e
               join pg_namespace n on n.oid = e.extnamespace
              where e.extname = 'pg_net' and n.nspname = 'public') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end $$;
