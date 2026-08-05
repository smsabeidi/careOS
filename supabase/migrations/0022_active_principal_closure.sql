-- ST-120 · Migration 0022 — active-principal closure: separation/suspension fails closed
-- Closes: S3-1 residue (self-scoped policy branches — created_by/app_user_id/staff_id/
--         caregiver_id = auth.uid() — stayed readable by separated staff until token
--         expiry), tenant.status never enforced anywhere, user_role policy missing its
--         tenant predicate.
--
-- Mechanism: app.current_tenant_id() now returns the tenant of an ACTIVE principal in an
-- ACTIVE tenant, and NULL otherwise. Every domain policy from 0004–0016 carries
-- `tenant_id = app.current_tenant_id()` as a top-level conjunct (verified before this
-- migration was written), so a non-active principal loses every row — including its own
-- self-scoped rows — the moment status flips, mid-token. One function closes the corpus;
-- future policies inherit the closure by construction instead of each remembering an
-- is_active conjunct (the drift that produced S3-1 in the first place).
-- app.has_perm() and app.on_care_team() (0002, D-011) already embed status='active';
-- this brings tenant context to parity.
--
-- RPC-author note: SECURITY DEFINER bodies bypass RLS but any emit_audit they perform
-- derives tenant via this function from auth.uid(). An RPC acting for a not-yet-active
-- principal (e.g. the future app.accept_invitation) must flip status to 'active' BEFORE
-- emitting audit in the same transaction.
-- @trace: ST-120, S3-1, D-011

-- ── Explicit standing predicate (for app code and policies that want it by name) ──────
create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_user u
    join public.tenant t on t.id = u.tenant_id and t.status = 'active'
    where u.id = auth.uid() and u.status = 'active'
  )
$$;
grant execute on function app.is_active_user() to authenticated;

-- ── The perimeter change: tenant context requires an active principal ─────────────────
create or replace function app.current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select u.tenant_id
  from public.app_user u
  join public.tenant t on t.id = u.tenant_id and t.status = 'active'
  where u.id = auth.uid() and u.status = 'active'
$$;

-- ── user_role: add the missing tenant predicate + active-principal closure ────────────
-- The old policy predicated only on user_id/user.read: no tenant isolation (relied on FK
-- chains and zero write grants), and readable by a separated holder of the same token.
drop policy user_role_select_scoped on public.user_role;
create policy user_role_select_scoped on public.user_role for select to authenticated
  using (
    exists (select 1 from public.app_user u
            where u.id = user_role.user_id
              and u.tenant_id = app.current_tenant_id())
    and (user_id = auth.uid() or app.has_perm('user.read'))
  );
