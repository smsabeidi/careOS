-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Repair a tenant whose Verified-Visit role grants never landed. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════════════════
-- THE GAP THIS FIXES, found on hosted 2026-08-17. Migrations 0043–0052 insert the
-- permission KEYS (`workforce.read`, `evv.read`, `payroll.read`, `policy.manage`,
-- `location.manage`, `visit.approve`, …) but the role→permission GRANTS live in
-- `supabase/seeds/zz_verified_visit.sql`. Seeds do not run against a hosted project, so a
-- database built from the migration chain alone ends up with those keys granted to NOBODY.
--
-- The effect is not subtle: `requirePerm` redirects every caller, so `/operations/workforce`,
-- `/operations/evv`, `/operations/locations`, `/operations/timesheets` and
-- `/settings/visit-policy` are unreachable for EVERY user of that tenant — the owner
-- included. Six of the fourteen a11y journeys that failed against production failed for
-- exactly this reason and reported it themselves ("requirePerm(...) redirects a reader who
-- lacks it"), which is the harness earning its keep: an accessibility sweep found a
-- missing authorization grant.
--
-- This is a DEPLOYMENT gap, not a demo-data gap. It reproduces on any tenant provisioned by
-- migrations alone, which includes a future real customer. The durable fix is to decide
-- whether these grants belong in a migration rather than a seed — that is a decision-log
-- question (docs/00 §3), not something a repair script should settle. This file makes an
-- affected tenant usable now; it does not close the underlying question.
--
-- WHAT IT DOES NOT DO. It grants exactly what the seed grants and nothing else, so the
-- narrow posture the seed documents is preserved: owner and admin hold the full back
-- office; the coordinator runs the day (queue, locations, readiness) but not the clock pen,
-- the money or the state file; the RN sees verification detail because a supervisory visit
-- is judged on the same evidence. No role gains anything here it was not designed to hold.
-- ═══════════════════════════════════════════════════════════════════════════════════════

insert into public.role_permission (role_id, permission_key)
select r.id, p.perm
from public.role r
join lateral (values
  ('owner',       'location.manage'),   ('owner',       'policy.manage'),
  ('owner',       'visit.verify.read'), ('owner',       'visit.verify.act'),
  ('owner',       'visit.correct'),     ('owner',       'visit.approve'),
  ('owner',       'payroll.read'),      ('owner',       'payroll.manage'),
  ('owner',       'evv.read'),          ('owner',       'evv.manage'),
  ('owner',       'workforce.read'),
  ('admin',       'location.manage'),   ('admin',       'policy.manage'),
  ('admin',       'visit.verify.read'), ('admin',       'visit.verify.act'),
  ('admin',       'visit.correct'),     ('admin',       'visit.approve'),
  ('admin',       'payroll.read'),      ('admin',       'payroll.manage'),
  ('admin',       'evv.read'),          ('admin',       'evv.manage'),
  ('admin',       'workforce.read'),
  ('coordinator', 'location.manage'),
  ('coordinator', 'visit.verify.read'), ('coordinator', 'visit.verify.act'),
  ('coordinator', 'payroll.read'),      ('coordinator', 'workforce.read'),
  ('rn',          'visit.verify.read')
) as p(role_key, perm) on p.role_key = r.key
-- Every tenant in this database, rather than the seed's hardcoded id: a repair should fix
-- what it finds. `on conflict do nothing` makes re-running it free.
where exists (select 1 from public.permission k where k.key = p.perm)
on conflict do nothing;

-- Proof. Every row below should name at least one role; a dash means the repair missed it.
select p.key as permission,
       coalesce(string_agg(distinct r.key, ', ' order by r.key), '— STILL GRANTED TO NO ROLE —') as roles
from public.permission p
left join public.role_permission rp on rp.permission_key = p.key
left join public.role r on r.id = rp.role_id
where p.key in ('workforce.read','evv.read','evv.manage','location.manage','policy.manage',
                'payroll.read','payroll.manage','visit.approve','visit.correct',
                'visit.verify.read','visit.verify.act')
group by p.key order by p.key;
