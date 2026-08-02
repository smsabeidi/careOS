-- ST-006 · Meadowbrook universe at operating scale (deterministic, synthetic — D-006)
-- 55 staff (8 RN · 42 caregivers · 3 coordinators · 2 HR), 320 clients,
-- care-team assignments (caregiver + RN case manager per active client),
-- ~900 append-only form versions with real hashes, RN signatures on finalized
-- assessments, and an unsigned in-review queue for the clinical surface.
-- Deterministic: setseed + index-derived UUIDs. Runs after seed.sql.
-- Demo logins (all "AmericanCare!demo1"): sarah@ (owner) · nina@ (RN) ·
-- omar@ (coordinator) · dee@ (caregiver) — @americancareteam.demo

do $$
declare
  v_tenant uuid := '11111111-1111-1111-1111-111111111111';
  v_pw text;
  fn text[] := array['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','David','Elizabeth','William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Karen','Charles','Sarah','Christopher','Nancy','Daniel','Lisa','Matthew','Betty','Anthony','Margaret','Mark','Sandra','Donald','Ashley','Steven','Kimberly','Paul','Emily','Andrew','Donna','Joshua','Michelle','Kenneth','Carol','Kevin','Amanda','Brian','Dorothy','George','Melissa','Grace','Rosa','Miriam','Ade','Yusuf','Priya','Wei','Elena'];
  ln text[] := array['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Okafor','Vasquez','Delgado','Osei','Petrov','Haddad'];
  cities text[] := array['Silver Spring','Takoma Park','Rockville','Wheaton','Bethesda','Gaithersburg','Laurel','Hyattsville','College Park','Olney'];
  streets text[] := array['Birchwood Ln','Cedar Ct','Glenmont Ave','Quarry Rd','Fenton St','Colesville Rd','Georgia Ave','Elm Grove Way','Sligo Creek Pkwy','Dale Dr'];
  moods text[] := array['Bright','Content','Tired','Anxious'];
  conditions text[] := array['Stable','Improving','Declining'];
  mobility text[] := array['Independent','Uses walker','Wheelchair','Bed-bound'];

  v_uid uuid; v_email text; v_name text; v_role_key text; v_role uuid;
  v_client uuid; v_status text; v_cg uuid; v_rn uuid;
  v_inst uuid; v_ver uuid; v_content jsonb; v_days int;
  v_tpl_assessment uuid := '11111111-1111-1111-1111-000000f70001';
  v_tpl_note uuid := '11111111-1111-1111-1111-000000f70002';
  i int;
begin
  perform setseed(0.42);
  select extensions.crypt('AmericanCare!demo1', extensions.gen_salt('bf')) into v_pw;

  -- ── Staff 1..55 ──────────────────────────────────────────────────────────
  for i in 1..55 loop
    v_uid := ('22222222-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
    v_role_key := case
      when i <= 8 then 'rn'
      when i <= 50 then 'caregiver'
      when i <= 53 then 'coordinator'
      else 'hr' end;
    v_name := fn[1 + (i * 7) % 56] || ' ' || ln[1 + (i * 11) % 56]
              || case when v_role_key = 'rn' then ', RN' else '' end;
    v_email := case
      when i = 9  then 'dee@americancareteam.demo'
      when i = 51 then 'hussien@americancareteam.demo'
      else 'staff' || i || '@americancareteam.demo' end;
    if i = 9  then v_name := 'Dee Alvarez'; end if;
    if i = 51 then v_name := 'Hussien Barre'; end if;

    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at, confirmation_token, recovery_token,
                            email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
            v_email, v_pw, now(), '{"provider":"email","providers":["email"]}', '{}',
            now(), now(), '', '', '', '')
    on conflict (id) do nothing;

    insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                                 last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid, v_uid::text,
            jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
            'email', now(), now(), now())
    on conflict do nothing;

    insert into public.app_user (id, tenant_id, full_name, work_email, kind)
    values (v_uid, v_tenant, v_name, v_email, 'staff')
    on conflict (id) do nothing;

    select id into v_role from public.role
     where tenant_id = v_tenant and key = v_role_key;
    insert into public.user_role (user_id, role_id) values (v_uid, v_role)
    on conflict do nothing;
  end loop;

  -- HR needs the directory + assignment views
  insert into public.role_permission (role_id, permission_key)
  select r.id, 'careteam.read' from public.role r
   where r.tenant_id = v_tenant and r.key in ('hr','coordinator')
  on conflict do nothing;

  -- ── Clients 1..320 ───────────────────────────────────────────────────────
  for i in 1..320 loop
    v_client := ('33333333-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
    v_status := case
      when i <= 210 then 'active'
      when i <= 240 then 'inquiry'
      when i <= 265 then 'pending_admission'
      when i <= 285 then 'on_hold'
      else 'discharged' end;

    insert into public.client (id, tenant_id, status, first_name, last_name, dob,
                               address_line1, city, state, zip, primary_language,
                               payer_type, admitted_on)
    values (
      v_client, v_tenant, v_status,
      fn[1 + (i * 13) % 53], ln[1 + (i * 17) % 55],   -- coprime periods: no duplicate-name clumps
      date '1938-01-01' + ((i * 37) % 6570),
      (100 + (i * 7) % 899)::text || ' ' || streets[1 + i % 10],
      cities[1 + (i * 3) % 10], 'MD', (20850 + i % 120)::text,
      case when i % 9 = 0 then 'es' else 'en' end,
      (array['medicaid','private','ltc_insurance','medicaid','va'])[1 + i % 5],
      case when v_status in ('active','on_hold','discharged')
           then current_date - ((i * 29) % 600) else null end)
    on conflict (id) do nothing;

    -- Care team: caregiver + RN case manager for everyone in service
    if v_status in ('active', 'on_hold') then
      v_cg := ('22222222-0000-0000-0000-' || lpad(to_hex(9 + (i % 42)), 12, '0'))::uuid;
      v_rn := ('22222222-0000-0000-0000-' || lpad(to_hex(1 + (i % 8)), 12, '0'))::uuid;
      insert into public.care_team_assignment (tenant_id, client_id, user_id, role_on_case)
      values (v_tenant, v_client, v_cg, 'caregiver'),
             (v_tenant, v_client, v_rn, 'rn_case_manager')
      on conflict do nothing;
    end if;

    -- ── Records history for active clients ────────────────────────────────
    if v_status = 'active' then
      v_days := (i * 5) % 60;

      -- Finalized RN assessment, signed by the case manager
      v_inst := ('44444444-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
      v_ver  := ('55555555-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
      v_content := jsonb_build_object(
        'visit_date', to_char(current_date - v_days - 14, 'YYYY-MM-DD'),
        'general_condition', conditions[1 + i % 3],
        'vitals_notes', 'BP within usual range. Pulse steady.',
        'mobility', mobility[1 + i % 4],
        'medications_reviewed', true,
        'narrative', 'Assessment completed at home. Care plan remains appropriate.',
        'follow_up_needed', (i % 4 = 0));
      insert into public.form_instance (id, tenant_id, template_id, client_id, status,
                                        current_version_id, created_by, created_at, updated_at)
      values (v_inst, v_tenant, v_tpl_assessment, v_client, 'final', v_ver, v_rn,
              now() - (v_days + 14) * interval '1 day', now() - (v_days + 14) * interval '1 day')
      on conflict (id) do nothing;
      insert into public.form_version (id, tenant_id, instance_id, version_no, content,
                                       content_hash, author_id, authored_at, kind)
      values (v_ver, v_tenant, v_inst, 1, v_content,
              extensions.digest(convert_to(v_content::text, 'utf8'), 'sha256'),
              v_rn, now() - (v_days + 14) * interval '1 day', 'create')
      on conflict (id) do nothing;
      insert into public.signature (tenant_id, form_version_id, signer_id, signer_role,
                                    content_hash, method, session_aal, signed_at)
      select v_tenant, v_ver, v_rn, 'rn', fv.content_hash, 'click', 'aal2',
             now() - (v_days + 14) * interval '1 day'
        from public.form_version fv where fv.id = v_ver
      on conflict do nothing;

      -- Finalized caregiver visit note
      v_inst := ('66666666-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
      v_ver  := ('77777777-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
      v_content := jsonb_build_object(
        'visit_date', to_char(current_date - v_days, 'YYYY-MM-DD'),
        'tasks_completed', 'Personal care, breakfast, light housekeeping, medication reminder.',
        'client_mood', moods[1 + i % 4],
        'notes', 'Visit went smoothly.');
      insert into public.form_instance (id, tenant_id, template_id, client_id, status,
                                        current_version_id, created_by, created_at, updated_at)
      values (v_inst, v_tenant, v_tpl_note, v_client, 'final', v_ver, v_cg,
              now() - v_days * interval '1 day', now() - v_days * interval '1 day')
      on conflict (id) do nothing;
      insert into public.form_version (id, tenant_id, instance_id, version_no, content,
                                       content_hash, author_id, authored_at, kind)
      values (v_ver, v_tenant, v_inst, 1, v_content,
              extensions.digest(convert_to(v_content::text, 'utf8'), 'sha256'),
              v_cg, now() - v_days * interval '1 day', 'create')
      on conflict (id) do nothing;

      -- Draft visit note in progress for every 3rd client
      if i % 3 = 0 then
        v_inst := ('88888888-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
        v_ver  := ('99999999-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
        v_content := jsonb_build_object(
          'visit_date', to_char(current_date, 'YYYY-MM-DD'),
          'tasks_completed', 'Morning routine underway.',
          'client_mood', '', 'notes', '');
        insert into public.form_instance (id, tenant_id, template_id, client_id, status,
                                          created_by, created_at, updated_at)
        values (v_inst, v_tenant, v_tpl_note, v_client, 'draft', v_cg,
                now() - interval '3 hours', now() - interval '2 hours')
        on conflict (id) do nothing;
        insert into public.form_version (id, tenant_id, instance_id, version_no, content,
                                         content_hash, author_id, authored_at, kind)
        values (v_ver, v_tenant, v_inst, 1, v_content,
                extensions.digest(convert_to(v_content::text, 'utf8'), 'sha256'),
                v_cg, now() - interval '3 hours', 'create')
        on conflict (id) do nothing;
      end if;

      -- Unsigned in-review RN assessment for every 8th client → clinical queue
      if i % 8 = 0 then
        v_inst := ('aaaa4444-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
        v_ver  := ('aaaa5555-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid;
        v_content := jsonb_build_object(
          'visit_date', to_char(current_date - 2, 'YYYY-MM-DD'),
          'general_condition', conditions[1 + i % 3],
          'vitals_notes', 'Reassessment following schedule.',
          'mobility', mobility[1 + i % 4],
          'medications_reviewed', true,
          'narrative', 'Annual reassessment drafted — pending RN signature.',
          'follow_up_needed', false);
        insert into public.form_instance (id, tenant_id, template_id, client_id, status,
                                          created_by, created_at, updated_at)
        values (v_inst, v_tenant, v_tpl_assessment, v_client, 'in_review', v_rn,
                now() - interval '2 days', now() - interval '1 day')
        on conflict (id) do nothing;
        insert into public.form_version (id, tenant_id, instance_id, version_no, content,
                                         content_hash, author_id, authored_at, kind)
        values (v_ver, v_tenant, v_inst, 1, v_content,
                extensions.digest(convert_to(v_content::text, 'utf8'), 'sha256'),
                v_rn, now() - interval '2 days', 'create')
        on conflict (id) do nothing;
      end if;
    end if;
  end loop;

  -- Nina (demo RN) takes over caseload of seeded RN #1 so her surfaces are full
  update public.care_team_assignment
     set user_id = '11111111-1111-1111-1111-0000000ce002'
   where user_id = '22222222-0000-0000-0000-000000000001';
  update public.form_instance
     set created_by = '11111111-1111-1111-1111-0000000ce002'
   where created_by = '22222222-0000-0000-0000-000000000001';
end $$;
