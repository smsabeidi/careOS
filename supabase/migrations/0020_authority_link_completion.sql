-- ST-114 · Migration 0020 — complete the authority linking (D-015)
--
-- 0019's linking CASE covered assessment.%, supervisory.%, carenote.% and oncall.% but
-- omitted credential.%, so credential.rn_license landed with legal_authority_id NULL while
-- every other rule resolved. The seed file's copy of the same statement DID include it —
-- the two drifted, and production surfaced the gap: on the hosted demo, that rule renders
-- with no citation at all while its siblings show COMAR 10.07.05.12.
--
-- Forward-fix rather than editing 0019, which has already run everywhere (invariant 12).
-- Idempotent: only touches rows whose link is still NULL.
--
-- Personnel requirements sit in COMAR 10.07.05.10 (pre-referral screening: criminal history
-- records check, licensure verification, health screening incl. tuberculosis, reference and
-- employment-history verification, I-9, identity/work-eligibility, in-person interview,
-- skills assessment). Same verification caveat as every citation seeded by 0019: read from
-- the mdrules.elaws.us mirror on 2026-08-02, NOT confirmed against regs.maryland.gov, NOT
-- reviewed by a licensed human — so it stays review_status='unverified' and the UI keeps
-- labelling it as such.
-- @trace: ST-114, D-015

update public.cadence_rule r
   set legal_authority_id = la.id
  from public.legal_authority la
 where la.jurisdiction = 'US-MD'
   and la.citation = 'COMAR 10.07.05.10'
   and r.key like 'credential.%'
   and r.legal_authority_id is null;

update public.credential_type ct
   set legal_authority_id = la.id
  from public.legal_authority la
 where la.jurisdiction = 'US-MD'
   and la.citation = 'COMAR 10.07.05.10'
   and ct.legal_authority_id is null;
