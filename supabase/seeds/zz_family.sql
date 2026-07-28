-- zz_family.sql — Wave 5 family-portal demo data. Loads after zz_enrichment (visits exist).
-- Links the demo family persona (Grace Vance) to a loved one with full consent, a few
-- shared updates, and shared documents, so the family portal renders real, consent-gated
-- content. Synthetic only; runs as postgres (bypasses RLS), audit triggers no-op.

-- Grace's loved one = the client of the earliest upcoming visit, so her calendar is full.
insert into public.family_link (tenant_id, client_id, family_user_id, relationship, status, created_by)
select v.tenant_id, v.client_id, '11111111-1111-1111-1111-0000000ce003'::uuid, 'daughter', 'active',
       '11111111-1111-1111-1111-0000000ce002'::uuid
from public.visit v
where v.scheduled_start >= date_trunc('day', now())
order by v.scheduled_start, v.id
limit 1
on conflict (client_id, family_user_id) do nothing;

-- Consent: granted for all three scopes, recorded by the RN (Nina).
insert into public.consent (tenant_id, client_id, kind, scope, status, recorded_by, note)
select fl.tenant_id, fl.client_id, 'family_portal',
       array['updates','calendar','documents'], 'granted',
       '11111111-1111-1111-1111-0000000ce002'::uuid,
       'Client consented to share updates, the visit calendar, and documents with their daughter.'
from public.family_link fl
where fl.family_user_id = '11111111-1111-1111-1111-0000000ce003'::uuid
  and not exists (
    select 1 from public.consent c
    where c.client_id = fl.client_id and c.kind = 'family_portal');

-- A few approved updates the care team chose to share.
insert into public.family_update (tenant_id, client_id, author_id, title, body)
select fl.tenant_id, fl.client_id, '11111111-1111-1111-1111-0000000ce002'::uuid, u.title, u.body
from public.family_link fl
cross join (values
  ('A good week',
   'Your mother has been in great spirits and eating well. She especially enjoyed sitting in the garden on Tuesday afternoon.'),
  ('Medication review complete',
   'The nurse completed the routine medication review this week. Everything is on track and no changes were needed.'),
  ('Supervisory visit scheduled',
   'The RN supervisory visit is on the calendar for next week. We will share a short summary with you afterward.')
) as u(title, body)
where fl.family_user_id = '11111111-1111-1111-1111-0000000ce003'::uuid
  and not exists (
    select 1 from public.family_update fu
    where fu.client_id = fl.client_id and fu.title = u.title);

-- Documents shared with the family (metadata only — no file bytes in this table).
insert into public.shared_document (tenant_id, client_id, title, doc_kind, shared_by, note)
select fl.tenant_id, fl.client_id, d.title, d.kind, '11111111-1111-1111-1111-0000000ce002'::uuid, d.note
from public.family_link fl
cross join (values
  ('Plan of Care summary', 'care_plan', 'The current plan of care, shared with your permission.'),
  ('What to expect during visits', 'instructions', 'A short guide to how caregiver visits work.')
) as d(title, kind, note)
where fl.family_user_id = '11111111-1111-1111-1111-0000000ce003'::uuid
  and not exists (
    select 1 from public.shared_document sd
    where sd.client_id = fl.client_id and sd.title = d.title);
