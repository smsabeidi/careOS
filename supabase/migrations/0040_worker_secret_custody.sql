-- ST-181 · Migration 0040 — worker shared secret: database custody, zero transit
-- The pump→worker shared secret is now GENERATED inside Postgres (gen_random_bytes →
-- Vault) and read by both parties from the same row: the pump via vault directly
-- (0034), the worker via the service_role RPC below. The value never transits a deploy
-- pipeline, an env file, a chat transcript, or a human — docs/09 §5 custody with the
-- narrowest possible surface. Rotation = delete the vault row and re-run this DO block
-- (or call vault.create_secret afresh); the worker re-reads per cold start.
-- The pump stays honestly 'unconfigured' until careos_worker_url is ALSO set — the URL
-- is environment-specific and deliberately not seeded here (local stacks must not
-- pump anywhere).
-- @trace: ST-181, D-020, docs/09 §5

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'careos_worker_secret') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'),
                                'careos_worker_secret');
  end if;
end $$;

create or replace function app.read_worker_shared_secret() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = 'careos_worker_secret'
$$;
revoke all on function app.read_worker_shared_secret() from public, anon, authenticated;
grant execute on function app.read_worker_shared_secret() to service_role;
