-- ST-132 · Migration 0029 — public.document + hr-docs bucket + the only delete path
-- Implements docs/07 §9. The document row is METADATA (classification, hashes, linkage);
-- the blob lives in a private bucket whose storage RLS mirrors the owning entity's
-- policy. Access to blobs is short-TTL signed URLs minted server-side under the
-- requester's own JWT (retrieval as the user, invariant 9).
--
-- Retention posture (V14, D-017): docs/07 §9 suggests a 6-year COMAR default, but the
-- 5-year (COMAR 10.07.05.15) vs 7-year (Health-General §4-403) conflict sits with
-- counsel as open item V14. Until it resolves, retention_until stays NULL (= never
-- swept) — the sweep machinery lands now so the day counsel answers, policy becomes a
-- backfilled date, not new code. Nothing is invented (D-017 posture).
--
-- Destruction is a TWO-PHASE saga (no ad-hoc delete anywhere). The storage schema
-- forbids SQL deletes outright ("Use the Storage API instead" — enforced by a Supabase
-- protection trigger), which settles the architecture: phase 1, app.retention_sweep()
-- (respects retention_until + legal_hold) stamps destroy_requested_at — the select
-- policy hides stamped rows, so the document is unreachable at commit — and emits the
-- audited 'document.destroy' outbox event; phase 2, the runtime worker (Phase 2, where
-- the Storage API and service_role lawfully live) deletes the blob and calls
-- app.complete_document_destruction() to remove the row. Both phases are on the ledger.
-- Also closes 0008's dangling pointer: credential.document_id gains its real FK.
-- @trace: ST-132, docs/07 §9, V14

create table public.document (                             -- PHI/PII metadata
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  bucket text not null check (bucket in ('client-docs','hr-docs','intake-inbox')),
  storage_path text not null unique,
  sha256 bytea not null,
  content_type text,
  byte_size bigint,
  classification text not null check (classification in ('phi','pii','ops')),
  client_id uuid references public.client(id),
  employee_id uuid references public.employee(id),
  source text not null default 'upload' check (source in
    ('upload','fax','email','migration','generated')),
  retention_until date,                 -- NULL until V14 resolves (see header)
  legal_hold boolean not null default false,
  destroy_requested_at timestamptz,     -- phase-1 stamp: unreachable, awaiting blob GC
  uploaded_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_document_tenant on public.document (tenant_id, created_at desc);
create index idx_document_employee on public.document (employee_id) where employee_id is not null;
create index idx_document_client on public.document (client_id) where client_id is not null;
create index idx_document_retention on public.document (retention_until)
  where retention_until is not null and not legal_hold;

alter table public.document enable row level security;
alter table public.document force row level security;

-- Read (PHI/PII ⇒ AAL2): the subject employee's own file, the staff-lifecycle desk,
-- the credential wall's readers (verifying a returned document), or — for client
-- documents — the client's care team / chart readers.
create policy document_select_scoped on public.document for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
         and destroy_requested_at is null
         and (employee_id = auth.uid()
              or app.has_perm('staff.manage')
              or app.has_perm('credential.read.all')
              or (client_id is not null
                  and (app.has_perm('client.read.all') or app.on_care_team(client_id)))));
grant select on public.document to authenticated;
-- Writes: app.record_document only. Deletes: app.retention_sweep only. No grants.

-- 0008's promised FK lands with the table it waited for.
alter table public.credential
  add constraint fk_credential_document
  foreign key (document_id) references public.document(id);

-- ── The hr-docs bucket (private) + storage RLS twin ───────────────────────────────────
insert into storage.buckets (id, name, public)
values ('hr-docs', 'hr-docs', false)
on conflict (id) do nothing;

-- Path convention: {tenant_id}/{subject_user_id}/{uuid}-{filename}. The first folder
-- pins tenancy; the second pins the subject for self-reads.
create policy hr_docs_insert_scoped on storage.objects for insert to authenticated
  with check (bucket_id = 'hr-docs' and app.is_aal2()
              and app.has_perm('document.write')
              and (storage.foldername(name))[1] = app.current_tenant_id()::text);
create policy hr_docs_select_scoped on storage.objects for select to authenticated
  using (bucket_id = 'hr-docs' and app.is_aal2()
         and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and ((storage.foldername(name))[2] = auth.uid()::text
              or app.has_perm('staff.manage')
              or app.has_perm('credential.read.all')));
-- No UPDATE/DELETE storage policies: objects are immutable; destruction is the sweep's.

-- ── app.record_document — the only metadata write path ────────────────────────────────
create or replace function app.record_document(
  p_bucket text, p_storage_path text, p_sha256_hex text, p_classification text,
  p_content_type text default null, p_byte_size bigint default null,
  p_client uuid default null, p_employee uuid default null,
  p_source text default 'upload'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_existing public.document;
  v_id uuid;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to record a document'
      using errcode = '42501';
  end if;
  if not app.has_perm('document.write') then
    raise exception 'CAREOS_FORBIDDEN: document.write is required' using errcode = '42501';
  end if;
  if p_client is not null and not exists
     (select 1 from public.client c where c.id = p_client and c.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: client' using errcode = 'P0001';
  end if;
  if p_employee is not null and not exists
     (select 1 from public.employee e where e.id = p_employee and e.tenant_id = v_tenant) then
    raise exception 'CAREOS_NOT_FOUND: employee' using errcode = 'P0001';
  end if;

  -- Idempotency by natural key: the same path with the same content is the same record.
  select * into v_existing from public.document where storage_path = p_storage_path;
  if v_existing.id is not null then
    if v_existing.tenant_id = v_tenant
       and v_existing.sha256 = decode(p_sha256_hex, 'hex') then
      return v_existing.id;
    end if;
    raise exception 'CAREOS_CONFLICT: that storage path is already recorded with different content'
      using errcode = 'P0001';
  end if;

  insert into public.document
    (tenant_id, bucket, storage_path, sha256, content_type, byte_size,
     classification, client_id, employee_id, source, uploaded_by)
  values
    (v_tenant, p_bucket, p_storage_path, decode(p_sha256_hex, 'hex'), p_content_type,
     p_byte_size, p_classification, p_client, p_employee, p_source, auth.uid())
  returning id into v_id;

  perform app.emit_audit('document.recorded', 'document', v_id,
    jsonb_build_object('bucket', p_bucket, 'classification', p_classification,
                       'client_id', p_client, 'employee_id', p_employee));
  perform app.emit_event('document.recorded', 'document', v_id,
    jsonb_build_object('bucket', p_bucket, 'employee_id', p_employee, 'client_id', p_client));
  return v_id;
end $$;
revoke all on function
  app.record_document(text, text, text, text, text, bigint, uuid, uuid, text)
from public, anon;
grant execute on function
  app.record_document(text, text, text, text, text, bigint, uuid, uuid, text)
to authenticated;

-- ── app.retention_sweep — the only lawful destruction path ────────────────────────────
create or replace function app.retention_sweep(p_today date default current_date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select d.id, d.tenant_id, d.bucket
      from public.document d
     where d.retention_until is not null
       and d.retention_until < p_today
       and not d.legal_hold
       and d.destroy_requested_at is null
     order by d.retention_until
       for update
  loop
    update public.document set destroy_requested_at = now() where id = r.id;
    -- Phase 1 on the ledger + outbox; the worker (Phase 2) destroys the blob via the
    -- Storage API and completes below. Payload is IDs-only (invariant 5) — the worker
    -- reads bucket/path under its own identity.
    perform app.emit_audit_system(r.tenant_id, 'system', 'document.destruction_requested',
      'document', r.id, jsonb_build_object('bucket', r.bucket));
    perform app.emit_event_system(r.tenant_id, 'document.destroy', 'document', r.id, '{}');
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('swept', v_count, 'as_of', p_today);
end $$;
revoke all on function app.retention_sweep(date) from public, anon, authenticated;
grant execute on function app.retention_sweep(date) to service_role;

-- Phase 2 of the saga: after the blob is destroyed via the Storage API, the worker
-- removes the metadata row. Refuses rows that were never stamped — there is no path
-- from "reachable document" straight to "gone".
create or replace function app.complete_document_destruction(p_document uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.document;
begin
  select * into v from public.document where id = p_document for update;
  if v.id is null then
    return jsonb_build_object('ok', true, 'already_gone', true);   -- idempotent replay
  end if;
  if v.destroy_requested_at is null then
    raise exception 'CAREOS_BAD_STATE: destruction was never requested for this document'
      using errcode = 'P0001';
  end if;
  delete from public.document where id = v.id;
  perform app.emit_audit_system(v.tenant_id, 'system', 'document.swept',
    'document', v.id, jsonb_build_object('bucket', v.bucket));
  return jsonb_build_object('ok', true, 'document_id', v.id);
end $$;
revoke all on function app.complete_document_destruction(uuid) from public, anon, authenticated;
grant execute on function app.complete_document_destruction(uuid) to service_role;
