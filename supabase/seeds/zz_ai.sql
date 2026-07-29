-- zz_ai.sql — AI plane seed: capability registry (tiers), the Brain's policy corpus
-- (synthetic, NOT PHI), permission grants, and a few logged interactions.

-- Grants: owner + admin oversee AI activity and manage the corpus.
insert into public.role_permission (role_id, permission_key)
select r.id, p.key
from public.role r
cross join (values ('ai.read'), ('ai.manage')) as p(key)
where r.key in ('owner', 'admin')
on conflict do nothing;

-- Capability registry with autonomy tiers (T2 requires a human — DB-enforced).
insert into public.ai_capability (tenant_id, key, name, description, tier, requires_human)
select t.id, c.key, c.name, c.descr, c.tier, c.rh
from public.tenant t
cross join (values
  ('brain.answer',          'Policy Brain',            'Answers staff questions from agency policy, with citations, or abstains.', 'T1', false),
  ('intake.extract',        'Intake extraction',       'Extracts structured fields from an intake packet for human review.',        'T1', true),
  ('credential.flag',       'Credential risk flag',    'Flags credentials at risk of lapsing for coordinator review.',              'T1', true),
  ('coordination.suggest',  'Coordination suggestions','Proposes schedule fills; a coordinator disposes.',                          'T2', true)
) as c(key, name, descr, tier, rh)
on conflict (tenant_id, key) do nothing;

-- The Brain's knowledge corpus — synthetic agency policy (no PHI).
insert into public.knowledge_document (tenant_id, title, body, category, source_ref, created_by)
select t.id, d.title, d.body, d.cat, d.ref,
       (select id from public.app_user where tenant_id = t.id order by id limit 1)
from public.tenant t
cross join (values
  ('Fall prevention',
   'Every client is assessed for fall risk on admission and at each supervisory visit. For clients at elevated risk, caregivers must keep walking paths clear, keep frequently used items within reach, confirm the client uses their prescribed mobility aid, and report any fall or near-fall immediately through the incident process.',
   'policy', 'Care Policy 3.2'),
  ('Supervisory visit cadence',
   'A registered nurse conducts supervisory visits for each client at 45, 90, and 120 days, and at least every 60 days thereafter, to review the plan of care and caregiver performance. Each visit is documented and signed. A missed required supervisory visit is a citable deficiency.',
   'regulation', 'COMAR 10.07.05'),
  ('Medication reaction',
   'If a client shows a suspected adverse medication reaction such as a rash, difficulty breathing, swelling, or new confusion, the caregiver stops assisting with the medication, keeps the client safe, calls 911 for any emergency symptoms, then notifies the RN case manager and the coordinator. An incident report is filed the same day.',
   'procedure', 'Clinical SOP 7'),
  ('Incident reporting',
   'Any incident (a fall, injury, medication error, missed visit, property damage, or allegation) is reported to the coordinator within 2 hours and documented in an incident report the same calendar day. The RN reviews clinical incidents within 24 hours.',
   'procedure', 'Care Policy 9'),
  ('Infection control and TB',
   'All field staff keep current TB screening and follow standard precautions: hand hygiene before and after each visit, gloves for any contact with bodily fluids, and proper disposal of sharps. Staff with a fever or respiratory illness do not report to a client visit.',
   'policy', 'Health and Safety 4'),
  ('On-call and after hours',
   'The on-call coordinator is reachable 24/7 at the agency on-call line. Caregivers call on-call for any urgent clinical concern, a client who cannot be reached, or a safety issue outside office hours. Emergencies always go to 911 first.',
   'procedure', 'Operations 2'),
  ('Client privacy (HIPAA)',
   'Protected health information is shared only with the care team and only as needed for care. Never discuss a client in public, never share records outside the agency without consent, and report any suspected privacy breach to the compliance lead immediately.',
   'policy', 'HIPAA Policy 1'),
  ('Caregiver credentials',
   'Caregivers must hold current CPR certification and TB screening and pass a background check before their first visit. The scheduler will not assign a caregiver whose required credential has lapsed; assignments are blocked automatically until the credential is renewed.',
   'policy', 'HR Policy 5')
) as d(title, body, cat, ref);

-- A few logged interactions so the activity ledger is populated before the first live ask.
insert into public.ai_interaction
  (tenant_id, capability_key, provider, model, prompt_version, tier, status,
   tokens_in, tokens_out, cost_usd, latency_ms, input_digest, output_digest, created_by)
select t.id, v.cap, v.prov, v.model, 'brain.v1', 'T1', v.status,
       v.ti, v.tou, v.cost, v.lat, v.indig, v.outdig,
       (select u.id from public.app_user u
          join public.user_role ur on ur.user_id = u.id
          join public.role r on r.id = ur.role_id
         where u.tenant_id = t.id and r.key = 'rn' order by u.id limit 1)
from public.tenant t
cross join (values
  ('brain.answer', 'mock', 'gpt-4o-mini (mock)', 'ok',        180, 90,  0.0001, 240, 'What is our fall-prevention policy?',      'Every client is assessed for fall risk on admission...'),
  ('brain.answer', 'mock', 'gpt-4o-mini (mock)', 'ok',        160, 70,  0.0001, 210, 'How often are supervisory visits required?','An RN conducts supervisory visits at 45, 90, and 120 days...'),
  ('brain.answer', 'mock', 'gpt-4o-mini (mock)', 'abstained', 120, 30,  0.0000, 150, 'What is the agency PTO policy?',            'I do not have a policy document that covers that.')
) as v(cap, prov, model, status, ti, tou, cost, lat, indig, outdig);
