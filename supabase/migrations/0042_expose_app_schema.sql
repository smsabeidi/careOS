-- ST-181 · Migration 0042 — the app schema joins the API surface, as code
-- Local config.toml has exposed `app` since 0006 (the Lane-B RPCs are the only write
-- path), but hosted kept the platform default (public, storage, graphql_public) — so
-- every worker RPC failed with an unexposed-schema error and the function 500'd before
-- its own error handling (uncaught throw in the auth gate — also hardened here-ish:
-- the gate now runs inside the try, see worker v7). PostgREST's in-database config is
-- the code-reviewable path: role settings override platform config and survive
-- restarts; NOTIFY reloads without downtime.
-- @trace: ST-181, 0006, worker README
alter role authenticator set pgrst.db_schemas = 'public, storage, graphql_public, app';
grant usage on schema app to service_role;
notify pgrst, 'reload config';
