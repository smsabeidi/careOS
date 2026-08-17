-- ═══════════════════════════════════════════════════════════════════════════════════════
-- The demo lane: every shipped surface lit, and a day worth looking at. Runs LAST.
-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Two jobs, both of which exist because a demo that is only true on the day it was written
-- is not a demo.
--
-- 1 · EVERY FEATURE ON. The other seeds write each flag DARK with a stated reason, which is
--     right for local/preview/CI: a surface should have to be switched on deliberately.
--     But the founder demo wants the opposite default, so this lane — and only this lane,
--     the last one to run — flips them. Flipping here rather than in each feature's own
--     seed keeps the dark-by-default posture legible where those features are defined, and
--     puts the whole "show everything" decision in ONE file you can delete to get the
--     conservative demo back.
--
--     Written as plain UPDATEs, matching how `app.seed_*_flags` establish these rows in the
--     first place. A seed sets initial state; `app.set_feature_flag` is the RUNTIME act,
--     and it keeps its AAL2 + platform.manage guard precisely so a real flip is never this
--     easy. Nothing here weakens that.
--
-- 2 · TODAY IS ALWAYS A REAL DAY. The caregiver's visits were anchored to UTC midnight
--     while every surface renders the day in America/New_York, so on a late-evening reset
--     the two drifted apart and `/today` came up EMPTY — no visit card, and therefore no
--     clock control, no voice note and no note coach to show anyone. That is exactly how
--     the note-coach journey failed on 2026-08-16: the caregiver had visits on the 14th,
--     15th and 17th and none on the day the suite ran.
--
--     So three of her visits are re-anchored to the AGENCY day, every reset: one already
--     finished, one live now, one still ahead. That shape is deliberate — it is the only
--     one that demonstrates a completed visit's evidence, an in-progress clock-out, and an
--     upcoming arrival on the same screen.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- ── 1 · Every flag on, every AI capability armed ─────────────────────────────────────
update public.feature_flag
   set enabled = true, disabled_reason = null, updated_at = now()
 where not enabled;

-- The registry's kill switches are separate from the flags by design: a flag says the
-- surface exists, a kill switch says the capability may call a model at all. With no
-- provider key the governed client degrades to its deterministic fallback and records
-- `provider: 'mock'` honestly (apps/web/src/lib/ai/client.ts), so every AI surface is
-- demoable offline and gains real model output the day billing is added — no code change.
update public.ai_capability set enabled = true where not enabled;

-- ── 2 · Re-anchor the caregiver's day to the agency timezone ─────────────────────────
-- Idempotent: it recomputes absolute times from "today" on every reset, so running it
-- twice is running it once. `visit` is a schedulable row, not append-only history — the
-- ledger this demo is judged on (`visit_event`, `signature`, `audit_event`) is untouched.
with agency_midnight as (
  select date_trunc('day', now() at time zone 'America/New_York') as d
),
caregiver as (
  select id from public.app_user where work_email = 'dee@americancareteam.demo'
),
picks as (
  select v.id,
         row_number() over (order by v.scheduled_start) as rn
    from public.visit v
    join caregiver c on c.id = v.caregiver_id
   where v.status in ('scheduled', 'in_progress')
   limit 3
),
slots(rn, starts, lasts) as (
  values (1, interval '7 hours',  interval '2 hours'),   -- finished before the demo starts
         (2, interval '11 hours', interval '2 hours'),   -- the live one
         (3, interval '15 hours', interval '2 hours')    -- still ahead
)
update public.visit v
   set scheduled_start = ((select d from agency_midnight) + s.starts)
                           at time zone 'America/New_York',
       scheduled_end   = ((select d from agency_midnight) + s.starts + s.lasts)
                           at time zone 'America/New_York'
  from picks p
  join slots s on s.rn = p.rn
 where v.id = p.id;
