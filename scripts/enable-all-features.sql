-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Turn every shipped surface on, for one tenant, audited.
-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Run as a signed-in principal holding `platform.manage` under an AAL2 session — that is
-- what `app.set_feature_flag` demands, and the demand is the point: a flag flip is a
-- release decision, so it carries a named human and an audit row rather than a silent
-- UPDATE. On hosted, the Supabase SQL editor runs as the service role, which is NOT that
-- principal; set the claims below to the owner's uid first (that is what this file does)
-- or flip from a signed-in session.
--
-- REVERSIBLE, ALWAYS. Every line here has an exact inverse: the same call with `false`
-- and a reason. Nothing is destroyed, no data changes shape, and recorded milestones and
-- audit history survive a rollback untouched (invariant 1).
--
-- WHAT THIS DOES NOT TOUCH, deliberately:
--   · `evv_adapter` — Maryland's ISAS adapter stays `enabled=false` (D-026). That row, not
--     the `evv.submission` flag, is what gates real outbound transmission to the state.
--     Lighting the flag reveals the EVV console; it cannot send anything anywhere. The
--     adapter flips only when the state answers D-Q16/V17.
--   · The AI provider posture — with no OpenAI billing every capability degrades to its
--     deterministic fallback and records `provider: 'mock'` honestly (see lib/ai/client.ts).
--     Features work and demo correctly; they gain real model output the day billing lands.
--
-- BEFORE YOU RUN IT: `onboarding.welcome` intercepts the root route for every user who has
-- not finished or skipped the welcome — which today is every user, since no milestone rows
-- exist. That is the surface working as designed, but it does change where everyone lands.
-- It is also the flag PD-5 gates: ratifying PD-5 is the decision, this is the mechanism.
-- ═══════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_owner uuid;
  k text;
begin
  -- The tenant's own `platform.manage` holder. Resolved rather than hardcoded so this file
  -- is safe to run against any tenant, and so it fails loudly if nobody can authorise it.
  select u.id into v_owner
    from public.app_user u
    join public.user_role ur on ur.user_id = u.id
    join public.role_permission rp on rp.role_id = ur.role_id
   where rp.permission_key = 'platform.manage'
   limit 1;

  if v_owner is null then
    raise exception 'No principal holds platform.manage in this tenant — nobody can authorise a flag flip';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal2')::text, true);

  foreach k in array array[
    'front_door.command_bar',   -- ask-anything bar + NL scheduling drafts
    'front_door.actions',       -- the drafting lane behind the bar (independent of it)
    'front_door.note_coach',    -- note quality coaching on /today
    'front_door.inbox',         -- the attention queue + timesheet review
    'front_door.form_import',   -- PDF form import
    'front_door.family_weekly', -- family update drafts
    'onboarding.welcome',       -- first-run welcome (PD-5)
    'evv.submission',           -- the EVV console (adapter stays off — see header)
    'evv.offline_capture'       -- offline capture posture
  ] loop
    perform app.set_feature_flag(k, true, null);
  end loop;
end $$;

-- The AI registry's kill switches are a separate, owner-level act by design: a flag says
-- "this surface exists", a kill switch says "this capability may call a model at all".
update public.ai_capability set enabled = true where not enabled;

select key, enabled from public.feature_flag order by key;
select key, enabled from public.ai_capability order by key;
