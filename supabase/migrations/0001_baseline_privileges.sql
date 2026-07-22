-- ST-003 · Migration 0001 — schemas, extensions, least-privilege baseline
-- Implements: docs/07 §2 (D-007 explicit-grant posture)
-- Hardened per D-011: function EXECUTE privileges are revoked by default too.
--   Postgres grants EXECUTE on new functions to PUBLIC by default; without this
--   baseline every SECURITY DEFINER helper (including app.emit_audit) becomes a
--   callable endpoint for any authenticated user once its schema is exposed.
-- @trace: ST-003

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
create schema if not exists audit;

-- Tables: nothing exposed by default (docs/07 §2).
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Functions: nothing callable by default (D-011).
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- app schema: exposed to PostgREST (config.toml api.schemas), but callable
-- surface is strictly the explicitly-granted RPC catalog.
grant usage on schema app to authenticated, service_role;
alter default privileges in schema app revoke all on functions from public, anon, authenticated;

-- audit schema: no client access at all; reads happen via RPCs later.
revoke all on schema audit from public;
alter default privileges in schema audit revoke all on functions from public, anon, authenticated;
alter default privileges in schema audit revoke all on tables from anon, authenticated;
