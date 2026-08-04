-- ST-123 · Migration 0025 — function hygiene + the audit ledger becomes readable
-- 1) Pins search_path on the nine functions the Supabase security advisor flags as
--    mutable (0011_function_search_path_mutable). None is SECURITY DEFINER, and each
--    body references only pg_catalog built-ins or schema-qualified names, so pinning to
--    `public` (the corpus convention) is behavior-preserving. A pgTAP invariant in 001
--    keeps the schemas clean from here on.
-- 2) Gives the hash-chained audit ledger its first application read path. The tables
--    keep their zero-grant, definer-only posture (D-011); reads go through two guarded
--    RPCs gated on the new `audit.read` permission — the person-detail activity feed
--    ("no dark automation", docs/10 AI-8) and the Owner's "prove integrity" button ride
--    these. Role wiring for audit.read lands with the RBAC repairs (ST-124).
-- @trace: ST-123, advisor 0011_function_search_path_mutable, 2026-08-02 §2.4 (ledger unreadable)

-- ── 1 · Pin search_path (behavior-preserving; ALTER only, no body changes) ────────────
alter function app.cadence_status(text, date, integer, integer, date) set search_path = public;
alter function app.credential_expiry_bucket(date, integer)            set search_path = public;
alter function app.current_user_id()                                  set search_path = public;
alter function app.forbid_mutation()                                  set search_path = public;
alter function app.guard_columns_only()                               set search_path = public;
alter function app.guard_supervisory_visit()                          set search_path = public;
alter function app.guard_visit()                                      set search_path = public;
alter function app.is_aal2()                                          set search_path = public;
alter function audit.compute_chain()                                  set search_path = public;

-- ── 2 · audit.read permission + guarded read RPCs ─────────────────────────────────────
insert into public.permission (key, description) values
  ('audit.read', 'Read the tenant''s audit trail and verify chain integrity')
on conflict (key) do nothing;

create or replace function app.read_audit_trail(
  p_entity_type text default null, p_entity_id uuid default null, p_limit int default 50
) returns table (
  id bigint, occurred_at timestamptz, actor_id uuid, actor_kind text,
  action text, entity_type text, entity_id uuid, payload jsonb
)
language plpgsql stable security definer set search_path = public, audit as $$
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to read the audit trail'
      using errcode = '42501';
  end if;
  if not app.has_perm('audit.read') then
    raise exception 'CAREOS_FORBIDDEN: audit.read is required' using errcode = '42501';
  end if;
  return query
  select e.id, e.occurred_at, e.actor_id, e.actor_kind,
         e.action, e.entity_type, e.entity_id, e.payload
    from audit.audit_event e
   where e.tenant_id = app.current_tenant_id()
     and (p_entity_type is null or e.entity_type = p_entity_type)
     and (p_entity_id   is null or e.entity_id   = p_entity_id)
   order by e.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

create or replace function app.verify_audit_chain() returns jsonb
language plpgsql stable security definer set search_path = public, audit as $$
declare
  v_ok  boolean;
  v_bad bigint;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required to verify the chain'
      using errcode = '42501';
  end if;
  if not app.has_perm('audit.read') then
    raise exception 'CAREOS_FORBIDDEN: audit.read is required' using errcode = '42501';
  end if;
  select vc.ok, vc.first_bad_id into v_ok, v_bad
    from audit.verify_chain(app.current_tenant_id()) vc;
  return jsonb_build_object('ok', coalesce(v_ok, true), 'first_bad_id', v_bad);
end $$;

revoke all on function
  app.read_audit_trail(text, uuid, int),
  app.verify_audit_chain()
from public, anon;
grant execute on function
  app.read_audit_trail(text, uuid, int),
  app.verify_audit_chain()
to authenticated;
