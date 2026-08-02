-- zz_evv_completeness.sql — worked visits, end to end (docs/16 B1/B2, G2, G4).
--
-- Why this file exists, and why it loads LAST: app.denial_risk (the deterministic
-- claim-completeness gate) checks an EVV clock pair, a finalized note, the signature the
-- template requires, and a credential that was valid for the visit window. The rest of
-- the synthetic universe contains NO visit_event rows at all and no note-to-visit links,
-- so every visit in it reports "not claim-ready" and the ready state cannot be shown on
-- any surface. These three visits are yesterday's work, written end to end, so all three
-- verdicts render with the model unavailable:
--   b2001  complete                → ready = true, no gaps
--   b2002  credential had lapsed   → ready = false, the engine names the credential
--   b2003  never clocked out       → ready = false, clock-out gap + note still a draft
--
-- Load order: caregivers arrive in meadowbrook_universe.sql and their credentials in
-- zz_enrichment.sql, so anything that needs a CREDENTIALED caregiver has to run after
-- zz_enrichment (glob order: … zz_enrichment.sql → zz_evv_completeness.sql → zz_family.sql).
--
-- Eligibility is never decided here: both caregivers are SELECTED by asking
-- app.assert_schedulable (0011), the single authority, and app.denial_risk re-derives its
-- own verdict at read time. Events are written directly rather than through
-- app.clock_visit() because the seed has no session and that RPC requires the assigned
-- caregiver's own AAL2 JWT. Synthetic only (D-006, invariant 4); every row is id-pinned
-- and FK-guarded, so a repeated `db reset` is idempotent and a missing persona degrades
-- to "seed fewer rows", never to an error.
-- @trace: docs/16 §2 (B1, B2, G2, G4), invariants 1/4/13

do $evv$
declare
  v_tenant  uuid := '11111111-1111-1111-1111-111111111111';
  v_client  uuid;
  v_cg_ok   uuid;   -- no credential blockers for the window
  v_cg_bad  uuid;   -- a blocking credential that had lapsed by the window
  v_start   timestamptz := date_trunc('day', now()) - interval '15 hours';  -- yesterday 09:00
  v_end     timestamptz := date_trunc('day', now()) - interval '13 hours';  -- yesterday 11:00
  v_window  tstzrange;
  v_content jsonb;
begin
  v_window := tstzrange(v_start, v_end, '[)');

  select c.id into v_client
    from public.client c
   where c.tenant_id = v_tenant and c.status = 'active'
   order by (c.id = '11111111-1111-1111-1111-000000c10001') desc, c.id
   limit 1;
  if v_client is null then
    raise notice 'zz_evv_completeness: no active client — skipping the claim-completeness fixtures';
    return;
  end if;

  -- Ask the engine, do not re-implement it. The five named walkthrough personas (dee@,
  -- sarah@, nina@, omar@, family@ — everyone else is staffNN@) sort last, so the accounts
  -- a demo actually signs in as are not the ones carrying the seeded problems.
  select u.id into v_cg_ok
    from public.app_user u
   where u.tenant_id = v_tenant and u.status = 'active' and u.kind = 'staff'
     and exists (select 1 from public.user_role ur join public.role r on r.id = ur.role_id
                  where ur.user_id = u.id and lower(r.key) = 'caregiver')
     and (app.assert_schedulable(u.id, v_client, v_window) ->> 'schedulable')::boolean
   order by exists (select 1 from auth.users au
                     where au.id = u.id and au.email not like 'staff%'), u.id
   limit 1;

  select u.id into v_cg_bad
    from public.app_user u
   where u.tenant_id = v_tenant and u.status = 'active' and u.kind = 'staff'
     and exists (select 1 from public.user_role ur join public.role r on r.id = ur.role_id
                  where ur.user_id = u.id and lower(r.key) = 'caregiver')
     and not (app.assert_schedulable(u.id, v_client, v_window) ->> 'schedulable')::boolean
   order by exists (select 1 from auth.users au
                     where au.id = u.id and au.email not like 'staff%'), u.id
   limit 1;

  if v_cg_ok is null then
    raise notice 'zz_evv_completeness: no schedulable caregiver — skipping the claim-completeness fixtures';
    return;
  end if;

  insert into public.visit
    (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status, note)
  values
    ('11111111-1111-1111-1111-0000000b2001', v_tenant, v_client, v_cg_ok,
     v_start, v_end, 'completed', 'Morning personal care visit.'),
    ('11111111-1111-1111-1111-0000000b2003', v_tenant, v_client, v_cg_ok,
     v_start + interval '4 hours', v_end + interval '4 hours', 'completed',
     'Afternoon visit — clock-out was not recorded.')
  on conflict (id) do nothing;

  if v_cg_bad is not null then
    insert into public.visit
      (id, tenant_id, client_id, caregiver_id, scheduled_start, scheduled_end, status, note)
    values
      ('11111111-1111-1111-1111-0000000b2002', v_tenant, v_client, v_cg_bad,
       v_start + interval '2 hours', v_end + interval '2 hours', 'completed',
       'Midday visit — worked while a required credential was out of date.')
    on conflict (id) do nothing;
  end if;

  -- EVV pairs. Coordinates are the client's neighbourhood, synthetic like everything else.
  insert into public.visit_event
    (id, tenant_id, visit_id, caregiver_id, event_type, occurred_at,
     latitude, longitude, accuracy_m, method)
  select e.id, v_tenant, e.visit_id, e.cg, e.kind, e.at, 39.0004, -77.0261, 12.0, 'web'
  from (values
    ('11111111-1111-1111-1111-0000000b2e01'::uuid, '11111111-1111-1111-1111-0000000b2001'::uuid,
     v_cg_ok,  'clock_in',  v_start + interval '2 minutes'),
    ('11111111-1111-1111-1111-0000000b2e02'::uuid, '11111111-1111-1111-1111-0000000b2001'::uuid,
     v_cg_ok,  'clock_out', v_end - interval '3 minutes'),
    ('11111111-1111-1111-1111-0000000b2e03'::uuid, '11111111-1111-1111-1111-0000000b2002'::uuid,
     v_cg_bad, 'clock_in',  v_start + interval '2 hours 4 minutes'),
    ('11111111-1111-1111-1111-0000000b2e04'::uuid, '11111111-1111-1111-1111-0000000b2002'::uuid,
     v_cg_bad, 'clock_out', v_end + interval '2 hours' - interval '2 minutes'),
    -- b2003: clocked in, never clocked out (docs/16 G2 — the correction is a human's job).
    ('11111111-1111-1111-1111-0000000b2e05'::uuid, '11111111-1111-1111-1111-0000000b2003'::uuid,
     v_cg_ok,  'clock_in',  v_start + interval '4 hours 1 minute')
  ) as e(id, visit_id, cg, kind, at)
  where e.cg is not null
    and exists (select 1 from public.visit v where v.id = e.visit_id)
  on conflict (id) do nothing;

  -- Finalized visit notes for the two claim-ready candidates. The Meadowbrook visit-note
  -- template requires no signature, so a finalized note closes the documentation gate.
  v_content := jsonb_build_object(
    'visit_date',      (current_date - 1)::text,
    'tasks_completed', 'Personal care, breakfast, medication reminder and a short walk in the garden.',
    'client_mood',     'Content',
    'notes',           'Steady visit. Nothing new to report.');

  insert into public.form_instance
    (id, tenant_id, template_id, client_id, visit_id, status, created_by, created_at)
  select f.id, v_tenant, '11111111-1111-1111-1111-000000f70002', v_client, f.visit_id,
         f.status, f.author, f.at
  from (values
    ('11111111-1111-1111-1111-0000000b2f01'::uuid, '11111111-1111-1111-1111-0000000b2001'::uuid,
     'final', v_cg_ok,  v_end + interval '10 minutes'),
    ('11111111-1111-1111-1111-0000000b2f02'::uuid, '11111111-1111-1111-1111-0000000b2002'::uuid,
     'final', v_cg_bad, v_end + interval '2 hours 12 minutes'),
    -- b2003's note is still a draft: the visit that was never clocked out is also the
    -- one whose note never got finished. Two gaps, one story (docs/16 G2, G4).
    ('11111111-1111-1111-1111-0000000b2f03'::uuid, '11111111-1111-1111-1111-0000000b2003'::uuid,
     'draft', v_cg_ok,  v_end + interval '4 hours 20 minutes')
  ) as f(id, visit_id, status, author, at)
  where f.author is not null
    and exists (select 1 from public.visit v where v.id = f.visit_id)
  on conflict (id) do nothing;

  insert into public.form_version
    (id, tenant_id, instance_id, version_no, content, content_hash, author_id, authored_at, kind)
  select w.id, v_tenant, w.instance_id, 1, v_content,
         extensions.digest(convert_to(v_content::text, 'utf8'), 'sha256'),
         w.author, w.at, 'create'
  from (values
    ('11111111-1111-1111-1111-0000000b2fa1'::uuid, '11111111-1111-1111-1111-0000000b2f01'::uuid,
     v_cg_ok,  v_end + interval '10 minutes'),
    ('11111111-1111-1111-1111-0000000b2fa2'::uuid, '11111111-1111-1111-1111-0000000b2f02'::uuid,
     v_cg_bad, v_end + interval '2 hours 12 minutes'),
    ('11111111-1111-1111-1111-0000000b2fa3'::uuid, '11111111-1111-1111-1111-0000000b2f03'::uuid,
     v_cg_ok,  v_end + interval '4 hours 20 minutes')
  ) as w(id, instance_id, author, at)
  where w.author is not null
    and exists (select 1 from public.form_instance fi where fi.id = w.instance_id)
  on conflict (id) do nothing;

  update public.form_instance fi
     set current_version_id = fv.id
    from public.form_version fv
   where fv.instance_id = fi.id
     and fi.id in ('11111111-1111-1111-1111-0000000b2f01',
                   '11111111-1111-1111-1111-0000000b2f02',
                   '11111111-1111-1111-1111-0000000b2f03')
     and fi.current_version_id is distinct from fv.id;
end $evv$;
