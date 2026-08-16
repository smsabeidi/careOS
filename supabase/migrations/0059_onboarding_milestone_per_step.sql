-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 0059 · First-run milestones: one per checklist step (W-ONB follow-up to 0058)
-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 0058 shipped a five-value allowlist that named only the caregiver's and the nurse's
-- steps. It left the office checklists with nothing to record: an owner or a coordinator
-- who opened a step, worked on that screen and came back to "/" was offered the welcome
-- again at "0 of 3", every time, with no memory of what they had already done. Progress is
-- never lost is one of the four experience principles (docs/10 §1), and for two of the five
-- role checklists it was not true.
--
-- So the allowlist widens to one milestone per step key, `step_<key>`, covering all
-- thirteen steps `checklistFor` can return. 0058 anticipated this in the comment above its
-- CHECK: "widening the list is an expand-phase CHECK change with its own story." This is
-- that story.
--
-- EXPAND-ONLY (invariant 12). The constraint is replaced with a strictly wider one; every
-- value that was legal before is legal now, no row can violate the new CHECK, and nothing
-- is dropped, narrowed or rewritten. Existing rows are untouched — a caregiver who already
-- recorded `step_first_look` keeps it, and it means what it always meant.
--
-- The list is still CLOSED, and still stated twice (the 0054 posture 0058 adopted): the
-- CHECK is the structural floor, the RPC guard is what turns a typo into a CAREOS_* code
-- instead of a raw constraint violation. Both move together, here, in one migration.
-- ═══════════════════════════════════════════════════════════════════════════════════════

alter table public.onboarding_milestone
  drop constraint onboarding_milestone_milestone_check;

alter table public.onboarding_milestone
  add constraint onboarding_milestone_milestone_check
  check (milestone in (
    -- Ending the screen. Distinct on purpose: "worked through it" and "closed it" are
    -- different facts about somebody's first day and both are worth keeping.
    'welcome_completed', 'welcome_skipped',
    -- One per step key in apps/web/src/lib/onboarding.ts. The `step_` prefix is what lets
    -- the surface derive a milestone from a step instead of maintaining a parallel map
    -- that can drift away from this list.
    'step_first_look', 'step_language', 'step_home_screen', 'step_how_visits_work',
    'step_what_you_see', 'step_who_to_contact', 'step_clients', 'step_intake',
    'step_compliance', 'step_clinical_home', 'step_reviews', 'step_exec_overview',
    'step_evidence'
  ));

-- ── The RPC guard moves with the CHECK ───────────────────────────────────────────────
-- Body identical to 0058's apart from the allowlist: replaced rather than patched so the
-- whole function reads as one thing in one place, which is how the 0058 version was
-- written and how the next reader will expect to find it.
create or replace function app.record_onboarding_milestone(p_milestone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_id uuid;
begin
  if not app.is_aal2() then
    raise exception 'CAREOS_AAL2_REQUIRED: a verified session is required'
      using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'CAREOS_NO_TENANT_CONTEXT: an active principal is required'
      using errcode = 'P0001';
  end if;
  if p_milestone is null or p_milestone not in (
     'welcome_completed', 'welcome_skipped',
     'step_first_look', 'step_language', 'step_home_screen', 'step_how_visits_work',
     'step_what_you_see', 'step_who_to_contact', 'step_clients', 'step_intake',
     'step_compliance', 'step_clinical_home', 'step_reviews', 'step_exec_overview',
     'step_evidence') then
    raise exception 'CAREOS_BAD_MILESTONE: % is not a first-run milestone', p_milestone
      using errcode = 'P0001';
  end if;

  insert into public.onboarding_milestone (tenant_id, user_id, milestone)
  values (v_tenant, auth.uid(), p_milestone)
  on conflict on constraint uq_onboarding_milestone do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', true, 'unchanged', true, 'milestone', p_milestone);
  end if;

  perform app.emit_audit('onboarding.milestone', 'onboarding_milestone', v_id,
    jsonb_build_object('milestone', p_milestone));

  return jsonb_build_object('ok', true, 'unchanged', false, 'milestone_id', v_id,
                            'milestone', p_milestone);
end $$;
revoke all on function app.record_onboarding_milestone(text) from public, anon;
grant execute on function app.record_onboarding_milestone(text) to authenticated;
