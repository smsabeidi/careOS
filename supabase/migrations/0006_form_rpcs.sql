-- ST-021/ST-022/ST-023 · Migration 0006 — the forms workflow RPC surface (Lane B)
-- Implements: docs/08 §3 (finalize_form, correct_form, sign_version) + save_draft,
-- create_form. Hardening per D-011 (findings S4-1, S4-2, S5-4):
--   * finalize_form: tenant guard, status precondition, latest-version check, and a
--     correct signature-completeness check (docs/07 §5's PERFORM-based check was
--     logically broken).
--   * save_draft: optimistic-concurrency detection via p_base_version — a stale base
--     returns CAREOS_CONFLICT_KEEP_BOTH with the server version, powering the
--     keep-both merge UX (there was previously no detection mechanism for drafts).
--   * All RPCs raise stable CAREOS_* codes (docs/08 §2).
-- @trace: ST-021, ST-022, ST-023

create or replace function app.create_form(
  p_template uuid, p_client uuid default null, p_content jsonb default '{}'
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_instance uuid;
  v_version uuid;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED' using errcode = 'P0001';
  end if;
  perform 1 from public.form_template t
   where t.id = p_template and t.tenant_id = v_tenant and t.status = 'active';
  if not found then
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
    (tenant_id, instance_id, version_no, content, content_hash, author_id, kind)
  values
    (v_tenant, v_instance, 1, p_content,
     extensions.digest(convert_to(p_content::text, 'utf8'), 'sha256'),
     auth.uid(), 'create')
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
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_fi from public.form_instance
   where id = p_instance and tenant_id = v_tenant
   for update;                                   -- serializes version_no assignment
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

  -- Keep-both detection (D-011 / S4-1): stale base = conflict, never overwrite.
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

  insert into public.form_version
    (tenant_id, instance_id, version_no, prev_version_id, content, content_hash, author_id, kind)
  values
    (v_tenant, p_instance, v_latest.version_no + 1, v_latest.id, p_content,
     extensions.digest(convert_to(p_content::text, 'utf8'), 'sha256'),
     auth.uid(), 'edit')
  returning id into v_new;

  update public.form_instance
     set updated_at = now(), row_version = row_version + 1
   where id = p_instance;

  -- Draft autosaves are deliberately not audited per-save (volume — finding S7-3);
  -- create/finalize/correct/sign are the audited consequential actions.
  return jsonb_build_object('conflict', false, 'version_id', v_new,
                            'version_no', v_latest.version_no + 1);
end $$;

create or replace function app.finalize_form(p_instance uuid, p_version uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_fi public.form_instance;
  v_latest_id uuid;
  v_req text[];
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
  if v_fi.status not in ('draft','in_review') then
    raise exception 'CAREOS_INVALID_STATE: instance is %', v_fi.status using errcode = 'P0001';
  end if;
  if not (app.has_perm('form.finalize') or v_fi.created_by = auth.uid()) then
    raise exception 'CAREOS_NOT_AUTHORIZED' using errcode = 'P0001';
  end if;

  perform 1 from public.form_version fv
   where fv.id = p_version and fv.instance_id = p_instance;
  if not found then
    raise exception 'CAREOS_NOT_FOUND: version does not belong to instance' using errcode = 'P0001';
  end if;
  select id into v_latest_id from public.form_version
   where instance_id = p_instance order by version_no desc limit 1;
  if v_latest_id is distinct from p_version then
    raise exception 'CAREOS_STALE_VERSION: a newer version exists' using errcode = 'P0001';
  end if;

  select t.requires_signature_roles into v_req
    from public.form_template t where t.id = v_fi.template_id;
  if cardinality(v_req) > 0 then
    if exists (
      select 1 from (
        select unnest(v_req) as r
        except
        select s.signer_role from public.signature s where s.form_version_id = p_version
      ) missing
    ) then
      raise exception 'CAREOS_SIGNATURES_INCOMPLETE' using errcode = 'P0001';
    end if;
  end if;

  update public.form_instance
     set status = 'final', current_version_id = p_version,
         updated_at = now(), row_version = row_version + 1
   where id = p_instance;

  perform app.emit_audit('form.finalize', 'form_instance', p_instance,
                         jsonb_build_object('version_id', p_version));
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

  insert into public.form_version
    (tenant_id, instance_id, version_no, prev_version_id, content, content_hash,
     author_id, kind, note)
  values
    (v_tenant, p_instance, v_latest.version_no + 1, v_latest.id, p_content,
     extensions.digest(convert_to(p_content::text, 'utf8'), 'sha256'),
     auth.uid(), 'correction', p_reason)
  returning id into v_new;

  update public.form_instance
     set updated_at = now(), row_version = row_version + 1
   where id = p_instance;

  perform app.emit_audit('form.correct', 'form_instance', p_instance,
                         jsonb_build_object('version_id', v_new));
  return v_new;
end $$;

create or replace function app.sign_version(p_version uuid, p_method text default 'click')
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_fv public.form_version;
  v_fi public.form_instance;
  v_req text[];
  v_role text;
  v_sig uuid;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_fv from public.form_version
   where id = p_version and tenant_id = v_tenant;
  if not found then
    raise exception 'CAREOS_NOT_FOUND: form version' using errcode = 'P0001';
  end if;
  select * into v_fi from public.form_instance where id = v_fv.instance_id for update;
  if v_fi.status not in ('draft','in_review','final') then
    raise exception 'CAREOS_INVALID_STATE: instance is %', v_fi.status using errcode = 'P0001';
  end if;

  select t.requires_signature_roles into v_req
    from public.form_template t where t.id = v_fi.template_id;

  -- The signer must hold one of the template's required roles (docs/08 §3).
  select r.key into v_role
    from public.user_role ur
    join public.role r on r.id = ur.role_id
   where ur.user_id = auth.uid() and r.key = any (v_req)
   limit 1;
  if v_role is null then
    raise exception 'CAREOS_NOT_AUTHORIZED: no required signer role held' using errcode = 'P0001';
  end if;

  -- content_hash is copied server-side from the version (never client-supplied) and
  -- the composite FK re-verifies it at the constraint layer (D-011).
  insert into public.signature
    (tenant_id, form_version_id, signer_id, signer_role, content_hash, method, session_aal)
  values
    (v_tenant, p_version, auth.uid(), v_role, v_fv.content_hash, p_method,
     coalesce(auth.jwt()->>'aal', 'aal1'))
  returning id into v_sig;

  perform app.emit_audit('form.sign', 'form_version', p_version,
                         jsonb_build_object('signer_role', v_role, 'method', p_method));
  return v_sig;
end $$;

-- The Lane-B callable catalog (explicit grants — D-011):
grant execute on function app.create_form(uuid, uuid, jsonb) to authenticated;
grant execute on function app.save_draft(uuid, jsonb, uuid) to authenticated;
grant execute on function app.finalize_form(uuid, uuid) to authenticated;
grant execute on function app.correct_form(uuid, jsonb, text) to authenticated;
grant execute on function app.sign_version(uuid, text) to authenticated;
