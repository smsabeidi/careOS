-- ST-111 · Migration 0017 — form definitions become immutable and record-bound (D-014)
--
-- WHY. The brief's binding requirement is that "a record completed in 2026 must remain
-- reproducible using the exact form version that applied on the date of completion."
-- CareOS failed that at two layers:
--
--   (1) public.form_template carried NO append-only trigger. forbid_mutation() is attached
--       to form_version, signature, audit_event, audit_anchor, credential_event, care_plan,
--       care_plan_item and schedule_exception — every consequential table EXCEPT the one
--       whose mutation silently rewrites how every historical record renders. A single
--       UPDATE of form_template.schema changes what a signed 2026 record appears to say.
--       003_append_only.sql inserts a form_template as a fixture but never asserted its
--       immutability, so the gap was untested as well as unenforced.
--
--   (2) public.form_version carried no pointer to the definition it was authored under.
--       form_instance.template_id pins a version row (form_template is
--       unique(tenant_id,key,version), so each version is its own row) — but that pin lives
--       on the INSTANCE, is resolved live at read time, and a record could not PROVE which
--       definition produced it.
--
-- HOW. This migration mirrors the D-011 e-sign pattern exactly. That decision made the
-- signature↔content binding "constraint-true, not comment-true" by adding
-- form_version unique(id, content_hash) and a composite FK from signature. We do the same
-- one level up: form_template gains a generated schema_hash + unique(id, schema_hash), and
-- form_version gains (template_id, template_schema_hash) with a composite FK onto it.
-- After this, "this record was authored under that exact definition" is enforced by
-- Postgres, not by convention.
--
-- Expand-only (invariant 12). No column is dropped, no grant changes, no client impact:
-- form_template has zero client write grants, and no RPC or migration has ever written it
-- (all three seeded templates are version 1 — template versioning has never been exercised).
-- @trace: ST-111, D-014

-- ── 1. form_template: content-address the definition ───────────────────────
-- A GENERATED ALWAYS column was the first choice and Postgres rejects it:
-- "generation expression is not immutable" — the jsonb→text cast is STABLE, not
-- IMMUTABLE. Rather than launder that through an IMMUTABLE wrapper (which would be a
-- lie to the planner), the hash is stamped by a BEFORE INSERT trigger.
--
-- That is exactly as strong here, and only because of what this section does next:
-- the table becomes append-only. With no UPDATE path in existence, a value stamped at
-- insert can never drift from the `schema` it was computed over. Immutability is what
-- makes the trigger equivalent to a generated column — the two changes are load-bearing
-- together, and neither may be removed without the other.
alter table public.form_template add column schema_hash bytea;

create or replace function app.set_form_template_schema_hash()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  new.schema_hash := extensions.digest(convert_to(new.schema::text, 'utf8'), 'sha256');
  return new;
end $$;

create trigger trg_form_template_schema_hash before insert on public.form_template
  for each row execute function app.set_form_template_schema_hash();

-- Backfill BEFORE the append-only trigger exists (afterwards this UPDATE is refused).
update public.form_template
   set schema_hash = extensions.digest(convert_to(schema::text, 'utf8'), 'sha256')
 where schema_hash is null;

alter table public.form_template alter column schema_hash set not null;

alter table public.form_template
  add constraint form_template_id_schema_hash_key unique (id, schema_hash);

-- The immutability guarantee itself. form_template is CFG, not PHI, but it is
-- evidence-bearing: it is the definition a surveyor reads alongside a signed record.
create trigger trg_form_template_ao before update or delete on public.form_template
  for each row execute function app.forbid_mutation();

-- ── 2. form_version: bind the record to the definition ─────────────────────
-- Nullable because 0012 is expand-only and pre-existing rows have no binding. New rows
-- get it server-side from the RPCs (below); the backfill is in §3 and the NOT NULL
-- contraction is deliberately deferred to a later migration + decision entry.
alter table public.form_version
  add column template_id uuid,
  add column template_schema_hash bytea;

alter table public.form_version
  add constraint fk_form_version_template_schema
    foreign key (template_id, template_schema_hash)
    references public.form_template (id, schema_hash);

-- Both-or-neither: a half-populated binding is worse than none, because it looks like
-- provenance while proving nothing.
alter table public.form_version
  add constraint form_version_binding_complete
    check (num_nonnulls(template_id, template_schema_hash) <> 1);

create index idx_form_version_template on public.form_version (template_id);

-- Derive the binding for ANY insert path, not just the Lane-B RPCs.
-- The RPCs below set it explicitly, but seeds, migrations and future admin tooling
-- write form_version directly — and an unbound record is precisely the provenance hole
-- this migration exists to close. Deriving it from the instance's pinned template makes
-- the binding a property of the table rather than a property of one call site.
--
-- Semantics are deliberately three-way:
--   both NULL      → derive both from the instance's template (the common path)
--   both supplied  → leave untouched; the composite FK validates them
--   exactly one    → leave untouched, so form_version_binding_complete rejects it.
--                    A half-binding is a caller bug and must surface, not be papered over.
create or replace function app.set_form_version_binding()
returns trigger language plpgsql set search_path = public, extensions as $$
begin
  if new.template_id is null and new.template_schema_hash is null then
    select ft.id, ft.schema_hash
      into new.template_id, new.template_schema_hash
      from public.form_instance fi
      join public.form_template ft on ft.id = fi.template_id
     where fi.id = new.instance_id;
  end if;
  return new;
end $$;

create trigger trg_form_version_binding before insert on public.form_version
  for each row execute function app.set_form_version_binding();

-- ── 3. Backfill existing rows from their instance's pinned template ────────
-- Safe: form_version is append-only via trg_form_version_ao, which is a ROW-level
-- BEFORE UPDATE trigger — so this UPDATE would be refused. Disable it for the
-- backfill only, exactly as 004_audit_chain.sql does to prove tamper detection.
alter table public.form_version disable trigger trg_form_version_ao;

update public.form_version fv
   set template_id          = ft.id,
       template_schema_hash = ft.schema_hash
  from public.form_instance fi
  join public.form_template ft on ft.id = fi.template_id
 where fv.instance_id = fi.id
   and fv.template_id is null;

alter table public.form_version enable trigger trg_form_version_ao;

-- ── 4. RPCs populate the binding server-side ───────────────────────────────
-- The value is never client-supplied: it is read from the instance's pinned template
-- row inside the same transaction, and the composite FK re-verifies it at the
-- constraint layer. Identical trust posture to signature.content_hash (D-011).

create or replace function app.create_form(
  p_template uuid, p_client uuid default null, p_content jsonb default '{}'
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_instance uuid;
  v_version uuid;
  v_schema_hash bytea;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED' using errcode = 'P0001';
  end if;
  select t.schema_hash into v_schema_hash from public.form_template t
   where t.id = p_template and t.tenant_id = v_tenant and t.status = 'active';
  if v_schema_hash is null then
    raise exception 'CAREOS_NOT_FOUND: active template' using errcode = 'P0001';
  end if;
  if p_client is not null then
    if not (app.has_perm('form.write.all') or app.on_care_team(p_client)) then
      raise exception 'CAREOS_NOT_ON_CARE_TEAM' using errcode = 'P0001';
    end if;
    perform 1 from public.client c where c.id = p_client and c.tenant_id = v_tenant;
    if not found then
      raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
    end if;
  end if;

  insert into public.form_instance (tenant_id, template_id, client_id, created_by)
  values (v_tenant, p_template, p_client, auth.uid())
  returning id into v_instance;

  insert into public.form_version
    (tenant_id, instance_id, version_no, content, content_hash, author_id, kind,
     template_id, template_schema_hash)
  values
    (v_tenant, v_instance, 1, p_content,
     extensions.digest(convert_to(p_content::text, 'utf8'), 'sha256'),
     auth.uid(), 'create', p_template, v_schema_hash)
  returning id into v_version;

  perform app.emit_audit('form.create', 'form_instance', v_instance,
                         jsonb_build_object('template_id', p_template));
  return v_instance;
end $$;

create or replace function app.save_draft(
  p_instance uuid, p_content jsonb, p_base_version uuid
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_fi public.form_instance;
  v_latest public.form_version;
  v_new uuid;
  v_schema_hash bytea;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_fi from public.form_instance
   where id = p_instance and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'CAREOS_NOT_FOUND: form instance' using errcode = 'P0001';
  end if;
  if not (v_fi.created_by = auth.uid()
          or app.has_perm('form.write.all')
          or (v_fi.client_id is not null and app.on_care_team(v_fi.client_id))) then
    raise exception 'CAREOS_NOT_AUTHORIZED' using errcode = 'P0001';
  end if;
  if v_fi.status not in ('draft','in_review') then
    raise exception 'CAREOS_INVALID_STATE: instance is %', v_fi.status using errcode = 'P0001';
  end if;

  select * into v_latest from public.form_version
   where instance_id = p_instance
   order by version_no desc limit 1;

  if v_latest.id is distinct from p_base_version then
    return jsonb_build_object(
      'conflict', true,
      'code', 'CAREOS_CONFLICT_KEEP_BOTH',
      'server_version_id', v_latest.id,
      'server_version_no', v_latest.version_no,
      'server_author_id', v_latest.author_id,
      'server_authored_at', v_latest.authored_at,
      'server_content', v_latest.content);
  end if;

  select t.schema_hash into v_schema_hash
    from public.form_template t where t.id = v_fi.template_id;

  insert into public.form_version
    (tenant_id, instance_id, version_no, prev_version_id, content, content_hash, author_id, kind,
     template_id, template_schema_hash)
  values
    (v_tenant, p_instance, v_latest.version_no + 1, v_latest.id, p_content,
     extensions.digest(convert_to(p_content::text, 'utf8'), 'sha256'),
     auth.uid(), 'edit', v_fi.template_id, v_schema_hash)
  returning id into v_new;

  update public.form_instance
     set updated_at = now(), row_version = row_version + 1
   where id = p_instance;

  return jsonb_build_object('conflict', false, 'version_id', v_new,
                            'version_no', v_latest.version_no + 1);
end $$;

create or replace function app.correct_form(
  p_instance uuid, p_content jsonb, p_reason text
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_fi public.form_instance;
  v_latest public.form_version;
  v_new uuid;
  v_schema_hash bytea;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED' using errcode = 'P0001';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'CAREOS_REASON_REQUIRED: corrections must state a reason' using errcode = 'P0001';
  end if;

  select * into v_fi from public.form_instance
   where id = p_instance and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'CAREOS_NOT_FOUND: form instance' using errcode = 'P0001';
  end if;
  if v_fi.status <> 'final' then
    raise exception 'CAREOS_INVALID_STATE: corrections target finalized records (instance is %)', v_fi.status
      using errcode = 'P0001';
  end if;
  if not (app.has_perm('form.correct') or v_fi.created_by = auth.uid()) then
    raise exception 'CAREOS_NOT_AUTHORIZED' using errcode = 'P0001';
  end if;

  select * into v_latest from public.form_version
   where instance_id = p_instance order by version_no desc limit 1;

  select t.schema_hash into v_schema_hash
    from public.form_template t where t.id = v_fi.template_id;

  insert into public.form_version
    (tenant_id, instance_id, version_no, prev_version_id, content, content_hash,
     author_id, kind, note, template_id, template_schema_hash)
  values
    (v_tenant, p_instance, v_latest.version_no + 1, v_latest.id, p_content,
     extensions.digest(convert_to(p_content::text, 'utf8'), 'sha256'),
     auth.uid(), 'correction', p_reason, v_fi.template_id, v_schema_hash)
  returning id into v_new;

  -- The corrected version becomes the record's current version. Without this the UI
  -- renders correction content under a stale current_version_id, shows the 'final'
  -- banner, and reports every required signer as still waiting (signatures are matched
  -- against the current version). Correcting a final record leaves it final BY DESIGN —
  -- a correction is a new version, never a reopening.
  update public.form_instance
     set current_version_id = v_new,
         updated_at = now(), row_version = row_version + 1
   where id = p_instance;

  perform app.emit_audit('form.correct', 'form_instance', p_instance,
                         jsonb_build_object('version_id', v_new));
  return v_new;
end $$;

revoke all on function app.create_form(uuid, uuid, jsonb) from public, anon;
revoke all on function app.save_draft(uuid, jsonb, uuid) from public, anon;
revoke all on function app.correct_form(uuid, jsonb, text) from public, anon;
grant execute on function app.create_form(uuid, uuid, jsonb) to authenticated;
grant execute on function app.save_draft(uuid, jsonb, uuid) to authenticated;
grant execute on function app.correct_form(uuid, jsonb, text) to authenticated;
