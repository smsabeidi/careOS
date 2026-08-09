-- careOS · local-pg harness — Supabase-compatible bootstrap shim
-- ============================================================================
-- WHY THIS FILE EXISTS
--   `supabase db start` cannot run on this machine (Docker is an x86_64 binary
--   with no Rosetta on an arm64 Mac).  The migration chain and the pgTAP suite
--   nonetheless need the environment Supabase would have created for them
--   BEFORE migration 0001 runs: platform roles, the auth/storage/vault schemas,
--   and the pgmq / pg_cron / pg_net extensions.
--
--   This file recreates that pre-migration environment on a plain
--   Postgres.app 18 cluster.  It is applied by `harness.sh reset` immediately
--   before supabase/migrations/0001_*.sql.
--
-- CONTRACT
--   * Idempotent — safe to run repeatedly against the same database.
--   * Never performs network I/O (the net shim RECORDS requests, see §8).
--   * Creates nothing in `public` or `audit`: those schemas belong entirely to
--     the migration chain, and tests/database/001_schema_invariants.sql asserts
--     RLS on every table it finds there.
--
-- FIDELITY
--   Each section carries a "FIDELITY" note listing what it does NOT reproduce.
--   The consolidated list lives in scripts/local-pg/README.md — read it before
--   treating a green local run as a green CI run.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- §1 · Platform roles
--   Mirrors the roles the Supabase platform creates in every project. Names,
--   LOGIN/INHERIT flags and the authenticator membership graph match upstream,
--   because migrations grant to these names and pgTAP asserts on them via
--   has_function_privilege('authenticated', …) / has_table_privilege(…).
--
--   FIDELITY: no passwords are set (local trust auth); `supabase_auth_admin`,
--   `supabase_storage_admin` and `dashboard_user` exist as name-compatible
--   stubs only — no GoTrue/Storage service ever connects as them here.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- rolname,                  login, inherit, bypassrls, createrole, createdb
      ('anon',                     false, true,  false, false, false),
      ('authenticated',            false, true,  false, false, false),
      ('service_role',             false, true,  true,  false, false),
      ('authenticator',            true,  false, false, false, false),
      ('supabase_admin',           true,  true,  true,  true,  true),
      ('supabase_auth_admin',      true,  false, false, true,  false),
      ('supabase_storage_admin',   true,  false, false, true,  false),
      ('dashboard_user',           false, true,  false, true,  true)
    ) as t(rolname, login, inherit, bypassrls, createrole, createdb)
  loop
    if not exists (select 1 from pg_roles where rolname = r.rolname) then
      execute format(
        'create role %I %s %s %s %s %s',
        r.rolname,
        case when r.login      then 'login'      else 'nologin'      end,
        case when r.inherit    then 'inherit'    else 'noinherit'    end,
        case when r.bypassrls  then 'bypassrls'  else 'nobypassrls'  end,
        case when r.createrole then 'createrole' else 'nocreaterole' end,
        case when r.createdb   then 'createdb'   else 'nocreatedb'   end);
    end if;
  end loop;
end $$;

-- authenticator is NOINHERIT and reaches the request roles only via SET ROLE —
-- exactly how PostgREST switches identity per request.
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- §2 · Schemas
--   `app` and `audit` belong to migration 0001 and are deliberately NOT created
--   here. `extensions` IS created here, because on a real project the platform
--   creates it (with USAGE for the API roles) long before any migration runs —
--   0001's `create schema if not exists extensions` is a no-op there too.
--   This matters: a schema whose owner has not granted USAGE is invisible to
--   name resolution, so without the grant below `authenticated` cannot see the
--   pgTAP functions the test suite calls unqualified, and every assertion fails
--   with a misleading "function is(integer,integer,unknown) does not exist".
-- ─────────────────────────────────────────────────────────────────────────────
create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;

create schema if not exists auth           authorization supabase_auth_admin;
create schema if not exists storage        authorization supabase_storage_admin;
create schema if not exists graphql_public;
create schema if not exists vault;
create schema if not exists pgmq;
create schema if not exists cron;
create schema if not exists net;

grant usage on schema auth    to postgres, anon, authenticated, service_role;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant usage on schema vault   to postgres, service_role;
grant usage on schema pgmq    to postgres, service_role;
grant usage on schema cron    to postgres;
grant usage on schema net     to postgres, service_role;
grant usage on schema graphql_public to postgres, anon, authenticated, service_role;

-- Supabase's platform default privileges for the `public` schema. Migration
-- 0001 immediately REVOKEs the anon/authenticated half of this (D-007); it is
-- reproduced here so that 0001's revoke has the same starting point it has on a
-- real project, and so `service_role` keeps the table access the worker RPCs
-- assume.
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- §3 · auth schema — GoTrue's tables, reduced to what this repo touches
--   Column set is a strict superset of every column referenced anywhere in
--   supabase/migrations, supabase/seeds and supabase/tests/database:
--     instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
--     raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
--     confirmation_token, recovery_token, email_change_token_new, email_change
--   plus the GoTrue columns the app layer commonly reads (banned_until,
--   last_sign_in_at, deleted_at, is_sso_user, is_anonymous, phone).
--
--   FIDELITY:
--     * No GoTrue triggers, no auth.schema_migrations, no MFA tables
--       (auth.mfa_factors / auth.mfa_challenges), no auth.sessions,
--       auth.refresh_tokens, auth.audit_log_entries, auth.flow_state.
--       Nothing in this repo reads them; a future migration that does will need
--       this section extended.
--     * `encrypted_password` is a plain text column here; seeds populate it with
--       extensions.crypt(...) exactly as they do upstream, but no login path
--       ever verifies it because there is no GoTrue in this harness.
--     * AAL is NOT modelled by a session table. app.is_aal2() reads the `aal`
--       claim out of request.jwt.claims (§4) — which is precisely how it behaves
--       on a real project, so this is a faithful path, not a stub.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists auth.users (
  instance_id             uuid,
  id                      uuid primary key,
  aud                     varchar(255),
  role                    varchar(255),
  email                   varchar(255),
  encrypted_password      varchar(255),
  email_confirmed_at      timestamptz,
  invited_at              timestamptz,
  confirmation_token      varchar(255),
  confirmation_sent_at    timestamptz,
  recovery_token          varchar(255),
  recovery_sent_at        timestamptz,
  email_change_token_new  varchar(255),
  email_change            varchar(255),
  email_change_sent_at    timestamptz,
  last_sign_in_at         timestamptz,
  raw_app_meta_data       jsonb,
  raw_user_meta_data      jsonb,
  is_super_admin          boolean,
  created_at              timestamptz,
  updated_at              timestamptz,
  phone                   text default null,
  phone_confirmed_at      timestamptz,
  banned_until            timestamptz,
  deleted_at              timestamptz,
  is_sso_user             boolean not null default false,
  is_anonymous            boolean not null default false
);
-- GoTrue's partial unique index on email — 0035_agent_identity.sql relies on
-- "auth.users enforces unique emails" to make agent principals tenant-unique.
create unique index if not exists users_email_partial_key
  on auth.users (email) where is_sso_user = false;
create index if not exists users_instance_id_idx on auth.users (instance_id);

create table if not exists auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text generated always as (lower(identity_data->>'email')) stored,
  id              uuid primary key default gen_random_uuid(),
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);
create index if not exists identities_user_id_idx on auth.identities (user_id);

-- auth.mfa_factors — GoTrue's enrolled second factors. Needed because
-- supabase/seeds/demo_users.sql enrols a verified TOTP factor for each demo
-- persona so app.is_aal2() is satisfied honestly on a local instance rather
-- than by weakening a policy. Column set mirrors GoTrue's schema for the
-- columns the repo actually writes; GoTrue additionally carries
-- last_challenged_at, phone, web_authn_* and factor-type columns we do not use.
create table if not exists auth.mfa_factors (
  id             uuid primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  friendly_name  text,
  factor_type    text not null,
  status         text not null,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  secret         text
);
create index if not exists mfa_factors_user_friendly_name_idx
  on auth.mfa_factors (friendly_name, user_id) where friendly_name is not null;

alter table auth.users       enable row level security;
alter table auth.identities  enable row level security;
alter table auth.mfa_factors enable row level security;
-- No policies and no grants: on a real project the auth tables are readable only
-- by supabase_auth_admin. Migrations reach them as the migration owner.
revoke all on auth.users, auth.identities from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4 · auth helper functions — byte-for-byte semantics of upstream Supabase
--   These are the functions every RLS policy in this repo is written against.
--   They read the request GUCs that PostgREST sets per request; pgTAP tests set
--   the same GUCs with set_config('request.jwt.claims', …, true).
--
--   FIDELITY: faithful. The only difference is provenance — on a real project
--   the claims GUC is populated from a *verified* JWT signature, here any
--   session can set it. That makes the harness suitable for authorization
--   testing (which is what the pgTAP suite does) but NOT for authentication
--   testing.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

grant execute on function auth.uid(), auth.jwt(), auth.role(), auth.email()
  to public;

-- ─────────────────────────────────────────────────────────────────────────────
-- §5 · storage schema — buckets/objects + the path helpers
--   0029_document_store.sql inserts the private `hr-docs` bucket and creates two
--   RLS policies on storage.objects; its pgTAP twin inserts objects as
--   `authenticated` and asserts the policies bite.
--
--   FIDELITY:
--     * These are the metadata tables only. There is no object store: nothing
--       is ever written to or read from disk/S3, and storage.objects rows here
--       are not backed by bytes.
--     * No storage.migrations, storage.s3_multipart_uploads, storage.prefixes,
--       or the Storage API's own trigger set.
--     * storage.foldername/filename/extension match upstream implementations.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null,
  owner               uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  public              boolean default false,
  avif_autodetection  boolean default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  owner_id            text
);
create unique index if not exists bname on storage.buckets (name);

create table if not exists storage.objects (
  id                uuid primary key default gen_random_uuid(),
  bucket_id         text references storage.buckets(id),
  name              text,
  owner             uuid,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  last_accessed_at  timestamptz default now(),
  metadata          jsonb,
  path_tokens       text[] generated always as (string_to_array(name, '/')) stored,
  version           text,
  owner_id          text,
  user_metadata     jsonb
);
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
create index if not exists name_prefix_search on storage.objects (name text_pattern_ops);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end $$;

create or replace function storage.filename(name text) returns text
language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;

create or replace function storage.extension(name text) returns text
language plpgsql immutable as $$
declare
  _parts text[];
  _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;

-- Upstream grants the request roles full DML on the storage tables and lets RLS
-- do the authorizing — reproduced so 0029's policies are the only gate.
grant select, insert, update, delete on storage.buckets, storage.objects
  to anon, authenticated, service_role;
grant execute on function storage.foldername(text), storage.filename(text),
                          storage.extension(text) to public;

-- ─────────────────────────────────────────────────────────────────────────────
-- §6 · Supabase Vault
--   0040_worker_secret_custody.sql generates the worker shared secret with
--   gen_random_bytes() and stores it via vault.create_secret(); 0034's pump
--   reads it back from vault.decrypted_secrets.
--
--   FIDELITY — THE IMPORTANT ONE:
--     Real Vault encrypts `secret` with an authenticated-encryption key held
--     outside the table (pgsodium / the platform root key), and
--     vault.decrypted_secrets is a security-barrier view that decrypts on read.
--     THIS SHIM STORES SECRETS IN PLAINTEXT. That is acceptable only because
--     nothing but synthetic values ever lands in a local cluster (invariant 4);
--     it is emphatically NOT a model of production custody, and no conclusion
--     about docs/09 §5 custody may be drawn from a green local run.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text unique,
  description text not null default '',
  secret      text not null,
  key_id      uuid,
  nonce       bytea,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table vault.secrets enable row level security;   -- no policies: definer-only reach

create or replace view vault.decrypted_secrets as
  select s.id, s.name, s.description, s.secret,
         s.secret as decrypted_secret,          -- plaintext passthrough (see FIDELITY)
         s.key_id, s.nonce, s.created_at, s.updated_at
    from vault.secrets s;

create or replace function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default '',
  new_key_id uuid default null
) returns uuid
language plpgsql security definer set search_path = vault, public as $$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, new_description, new_key_id)
  returning id into v_id;
  return v_id;
end $$;

create or replace function vault.update_secret(
  secret_id uuid,
  new_secret text default null,
  new_name text default null,
  new_description text default null,
  new_key_id uuid default null
) returns void
language plpgsql security definer set search_path = vault, public as $$
begin
  update vault.secrets s
     set secret      = coalesce(new_secret, s.secret),
         name        = coalesce(new_name, s.name),
         description = coalesce(new_description, s.description),
         key_id      = coalesce(new_key_id, s.key_id),
         updated_at  = now()
   where s.id = secret_id;
end $$;

revoke all on function vault.create_secret(text, text, text, uuid) from public;
revoke all on function vault.update_secret(uuid, text, text, text, uuid) from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- §7 · pgmq — a real, table-backed queue implementation
--   Not a stub: 0027 depends on pgmq.send() being transactional (that IS the
--   outbox property under test), and 0034's queue_read/queue_archive wrappers
--   depend on visibility-timeout semantics. So this reimplements pgmq's
--   behaviour on the same physical layout upstream uses:
--     pgmq.q_<queue>  (live)      msg_id, read_ct, enqueued_at, vt, message
--     pgmq.a_<queue>  (archive)   … + archived_at
--     pgmq.meta       (registry)
--   pgmq.read() takes rows whose vt has expired, bumps read_ct, pushes vt out by
--   `vt` seconds, and uses FOR UPDATE SKIP LOCKED — same as upstream.
--   Tests reference pgmq.q_q_events directly, so the naming must match exactly.
--
--   FIDELITY:
--     * No partitioned or unlogged queues (pgmq.create_partitioned /
--       create_unlogged); pgmq.meta records is_partitioned/is_unlogged as false.
--     * No metrics()/metrics_all(), no set_vt(), no purge_queue(), no
--       read_with_poll() long-polling — nothing in this repo calls them.
--     * Implemented in plpgsql rather than Rust; behaviour, not performance,
--       is what is being reproduced.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists pgmq.meta (
  queue_name      text primary key,
  is_partitioned  boolean not null default false,
  is_unlogged     boolean not null default false,
  created_at      timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'pgmq' and t.typname = 'message_record') then
    create type pgmq.message_record as (
      msg_id      bigint,
      read_ct     integer,
      enqueued_at timestamptz,
      vt          timestamptz,
      message     jsonb
    );
  end if;
end $$;

create or replace function pgmq.format_table_name(queue_name text, prefix text)
returns text language plpgsql immutable as $$
begin
  if queue_name ~ '\$|;|--|''' then
    raise exception 'queue name contains invalid characters: $, ;, --, or ''''';
  end if;
  return lower(prefix || '_' || queue_name);
end $$;

create or replace function pgmq.create(queue_name text) returns void
language plpgsql as $$
declare
  qname  text := queue_name;
  qtable text := pgmq.format_table_name(queue_name, 'q');
  atable text := pgmq.format_table_name(queue_name, 'a');
begin
  execute format($QUERY$
    create table if not exists pgmq.%I (
      msg_id      bigint generated always as identity primary key,
      read_ct     integer not null default 0,
      enqueued_at timestamptz not null default now(),
      vt          timestamptz not null,
      message     jsonb
    )$QUERY$, qtable);
  execute format($QUERY$
    create table if not exists pgmq.%I (
      msg_id      bigint primary key,
      read_ct     integer not null default 0,
      enqueued_at timestamptz not null default now(),
      archived_at timestamptz not null default now(),
      vt          timestamptz not null,
      message     jsonb
    )$QUERY$, atable);
  execute format('create index if not exists %I on pgmq.%I (vt asc)',
                 qtable || '_vt_idx', qtable);
  -- NOT `on conflict (queue_name)`: plpgsql would read the conflict target as the
  -- function's own parameter of that name. The anti-join is equivalent here.
  insert into pgmq.meta (queue_name)
  select qname where not exists (select 1 from pgmq.meta m where m.queue_name = qname);
end $$;

-- pgmq exposes create_non_partitioned() as an alias; kept for signature parity.
create or replace function pgmq.create_non_partitioned(queue_name text) returns void
language sql as $$ select pgmq.create(queue_name) $$;

create or replace function pgmq.drop_queue(queue_name text) returns boolean
language plpgsql as $$
begin
  execute format('drop table if exists pgmq.%I', pgmq.format_table_name(queue_name, 'q'));
  execute format('drop table if exists pgmq.%I', pgmq.format_table_name(queue_name, 'a'));
  delete from pgmq.meta m where m.queue_name = drop_queue.queue_name;
  return true;
end $$;

create or replace function pgmq.list_queues()
returns table (queue_name text, created_at timestamptz,
               is_partitioned boolean, is_unlogged boolean)
language sql stable as $$
  select m.queue_name, m.created_at, m.is_partitioned, m.is_unlogged from pgmq.meta m
$$;

create or replace function pgmq.send(queue_name text, msg jsonb, delay integer default 0)
returns setof bigint language plpgsql as $$
begin
  return query execute format($QUERY$
    insert into pgmq.%I (vt, message)
    values (now() + make_interval(secs => $1), $2)
    returning msg_id$QUERY$, pgmq.format_table_name(queue_name, 'q'))
  using delay, msg;
end $$;

create or replace function pgmq.send_batch(queue_name text, msgs jsonb[], delay integer default 0)
returns setof bigint language plpgsql as $$
begin
  return query execute format($QUERY$
    insert into pgmq.%I (vt, message)
    select now() + make_interval(secs => $1), unnest($2)
    returning msg_id$QUERY$, pgmq.format_table_name(queue_name, 'q'))
  using delay, msgs;
end $$;

create or replace function pgmq.read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record language plpgsql as $$
begin
  return query execute format($QUERY$
    with cte as (
      select msg_id from pgmq.%1$I
       where vt <= now()
       order by msg_id asc
       limit $1
       for update skip locked
    )
    update pgmq.%1$I q
       set vt = now() + make_interval(secs => $2),
           read_ct = q.read_ct + 1
      from cte
     where q.msg_id = cte.msg_id
    returning q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message$QUERY$,
    pgmq.format_table_name(queue_name, 'q'))
  using qty, vt;
end $$;

create or replace function pgmq.pop(queue_name text)
returns setof pgmq.message_record language plpgsql as $$
begin
  return query execute format($QUERY$
    with cte as (
      select msg_id from pgmq.%1$I
       where vt <= now()
       order by msg_id asc
       limit 1
       for update skip locked
    )
    delete from pgmq.%1$I q using cte
     where q.msg_id = cte.msg_id
    returning q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message$QUERY$,
    pgmq.format_table_name(queue_name, 'q'));
end $$;

create or replace function pgmq.delete(queue_name text, msg_id bigint)
returns boolean language plpgsql as $$
declare
  v_deleted bigint;
begin
  execute format($QUERY$
    delete from pgmq.%I where msg_id = $1 returning msg_id$QUERY$,
    pgmq.format_table_name(queue_name, 'q'))
  using msg_id into v_deleted;
  return v_deleted is not null;
end $$;

create or replace function pgmq.archive(queue_name text, msg_id bigint)
returns boolean language plpgsql as $$
declare
  v_archived bigint;
begin
  execute format($QUERY$
    with deleted as (
      delete from pgmq.%1$I where msg_id = $1
      returning msg_id, read_ct, enqueued_at, vt, message
    )
    insert into pgmq.%2$I (msg_id, read_ct, enqueued_at, archived_at, vt, message)
    select msg_id, read_ct, enqueued_at, now(), vt, message from deleted
    returning msg_id$QUERY$,
    pgmq.format_table_name(queue_name, 'q'),
    pgmq.format_table_name(queue_name, 'a'))
  using msg_id into v_archived;
  return v_archived is not null;
end $$;

grant usage on schema pgmq to service_role;
grant execute on all functions in schema pgmq to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- §8 · pg_cron — the registry, without the scheduler
--   0034/0037/0038 call cron.schedule() to register the deterministic ticks;
--   tests/database/0034_automation_runtime.sql asserts on the resulting
--   cron.job rows (jobname + schedule). That registry behaviour is reproduced
--   exactly, including upsert-on-jobname.
--
--   FIDELITY — READ THIS:
--     NOTHING IS EVER EXECUTED. There is no background worker in this harness,
--     so app.pump_queues(), app.evaluate_compliance(), app.retention_sweep()
--     and app.check_heartbeats() never fire on a timer. cron.job_run_details
--     exists but stays empty. A local run therefore proves the jobs are
--     REGISTERED with the right cadence — never that they RUN.
--     To exercise a tick, call its command by hand in psql.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists cron.job (
  jobid    bigint generated always as identity primary key,
  schedule text not null,
  command  text not null,
  nodename text not null default 'localhost',
  nodeport integer not null default inet_server_port(),
  database text not null default current_database(),
  username text not null default current_user,
  active   boolean not null default true,
  jobname  text
);
create unique index if not exists jobname_username_uniq on cron.job (jobname, username);

create table if not exists cron.job_run_details (
  jobid          bigint,
  runid          bigint generated always as identity primary key,
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql as $$
declare
  v_jobid bigint;
begin
  insert into cron.job as j (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname, username) do update
    set schedule = excluded.schedule,
        command  = excluded.command,
        active   = true
  returning j.jobid into v_jobid;
  return v_jobid;
end $$;

create or replace function cron.schedule(schedule text, command text)
returns bigint language sql as $$
  select cron.schedule(null::text, schedule, command)
$$;

create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql as $$
declare
  v_deleted bigint;
begin
  delete from cron.job j where j.jobname = job_name returning j.jobid into v_deleted;
  if v_deleted is null then
    raise exception 'could not find valid entry for job "%"', job_name;
  end if;
  return true;
end $$;

create or replace function cron.unschedule(job_id bigint)
returns boolean language plpgsql as $$
declare
  v_deleted bigint;
begin
  delete from cron.job j where j.jobid = job_id returning j.jobid into v_deleted;
  if v_deleted is null then
    raise exception 'could not find valid entry for job %', job_id;
  end if;
  return true;
end $$;

create or replace function cron.alter_job(
  job_id bigint, schedule text default null, command text default null,
  database text default null, username text default null, active boolean default null
) returns void language plpgsql as $$
begin
  update cron.job j
     set schedule = coalesce(alter_job.schedule, j.schedule),
         command  = coalesce(alter_job.command,  j.command),
         database = coalesce(alter_job.database, j.database),
         username = coalesce(alter_job.username, j.username),
         active   = coalesce(alter_job.active,   j.active)
   where j.jobid = job_id;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §9 · pg_net — records requests, never sends them
--   0034's app.pump_queues() calls net.http_post(url := …, headers := …,
--   body := …, timeout_milliseconds := …). The parameter names and the bigint
--   request-id return value match upstream so the call site is unmodified.
--
--   FIDELITY — SAFETY PROPERTY:
--     THIS SHIM PERFORMS NO NETWORK I/O, BY CONSTRUCTION. There is no worker,
--     no libcurl, no socket. A request is appended to net.http_request_queue
--     and that is the end of it — inspect that table to assert on what the
--     database *would* have sent. Consequently:
--       * net._http_response never gains rows, so any future code that polls
--         for a response will block forever / find nothing;
--       * a "successful" pump heartbeat locally means "the pump reached the
--         http_post call", not "the worker was invoked".
--     This is deliberate: a test harness must never be able to reach out of the
--     machine, least of all from a database that will one day hold PHI.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists net.http_request_queue (
  id                   bigint generated always as identity primary key,
  method               text not null,
  url                  text not null,
  headers              jsonb,
  body                 jsonb,
  timeout_milliseconds integer not null,
  created_at           timestamptz not null default now()   -- shim-only column
);

create table if not exists net._http_response (
  id            bigint primary key,
  status_code   integer,
  content_type  text,
  headers       jsonb,
  content       text,
  timed_out     boolean,
  error_msg     text,
  created       timestamptz not null default now()
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', http_post.url, http_post.headers, http_post.body,
          http_post.timeout_milliseconds)
  returning id into v_id;
  return v_id;    -- request_id; no response will ever arrive (see FIDELITY)
end $$;

create or replace function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('GET', http_get.url, http_get.headers, null, http_get.timeout_milliseconds)
  returning id into v_id;
  return v_id;
end $$;

create or replace function net.http_delete(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('DELETE', http_delete.url, http_delete.headers, null,
          http_delete.timeout_milliseconds)
  returning id into v_id;
  return v_id;
end $$;

grant usage on schema net to service_role;
grant execute on all functions in schema net to service_role;
