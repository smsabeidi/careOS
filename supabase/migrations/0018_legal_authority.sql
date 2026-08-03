-- ST-112 · Migration 0018 — legal authority becomes a structured, append-only record (D-015)
--
-- WHY. "Legal authority" had already forked at n=2 tables, and the weaker fork was on screen:
--   * credential_type.source_ref      holds real citations ("COMAR 10.07.05.10/.11")
--   * cadence_rule.comar_source_ref   holds internal doc pointers, and every seeded row
--                                     carries the literal placeholder
--                                     "Doc 02 §3 — enrich with COMAR cite"
-- apps/web/src/app/office/compliance/page.tsx renders that column verbatim under a shield
-- icon, headed "Regulation", with footer copy telling the reader every row traces to its
-- regulation for a surveyor. In the demo tenant that column displays the placeholder.
-- That is the research brief's Risk 2 — "labeling a form as legally required without
-- sufficient authority" — already shipped. Neither column carries an issuing body, a URL,
-- a checksum, a retrieval date, an effective date, a verifier, or a verification status,
-- and no pgTAP test asserts anything about either. The column name also embeds one
-- jurisdiction (`comar_`), which does not survive a second state.
--
-- WHAT THIS IS. A global, non-PHI catalog of regulatory authorities, built on the
-- public.permission pattern (0002_identity_rbac.sql:35) — the repo's existing, ratified,
-- matrix-listed precedent for a table with no tenant_id: RLS enabled AND forced, one
-- permissive read policy, an explicit SELECT grant, and zero write grants. Regulations are
-- public law; they are not tenant data and not PHI, so this table is deliberately NOT
-- AAL2-gated (cadence_rule and credential_type set that precedent at 0009:54 and 0008:68).
--
-- THE LOAD-BEARING CONSTRAINT. `authority_published_requires_human` makes it structurally
-- impossible for a row to reach 'verified' or 'published' without a named human verifier
-- and a source-document checksum. verified_by is an FK to public.app_user — an AI capability
-- has no row there and cannot acquire one. This is the research brief's rule ("no form
-- should be marked required in production solely because an AI system found it online")
-- enforced in the database rather than asserted in a prompt or a policy document.
--
-- SEEDING POSTURE. The COMAR citations in 0014 were researched from primary text but have
-- NOT been reviewed by a licensed human, and docs/02 — the corpus's own cited authority —
-- is absent from this repository. They are therefore seeded as review_status='unverified'
-- with verified_by NULL, which the CHECK permits and the UI must render as unverified.
-- Honest beats convenient: an unverified citation that says so is safe; one that renders
-- under a "Regulation" heading is not.
-- @trace: ST-112, D-015

-- ── The authority catalog ──────────────────────────────────────────────────
create table public.legal_authority (                      -- [AO] CFG (global catalog)
  id              uuid primary key default gen_random_uuid(),
  -- Source hierarchy: 1 federal statute … 12 AI-generated recommendation.
  -- The UI renders legal requirement vs operational practice from this, not from copy.
  authority_level int  not null check (authority_level between 1 and 12),
  jurisdiction    text not null,          -- 'US' | 'US-MD' | 'US-MD-Baltimore' | …
  issuing_body    text not null,          -- 'Maryland Department of Health, OHCQ'
  citation        text not null,          -- 'COMAR 10.07.05.14'
  title           text not null,          -- 'Clinical Records'
  source_url      text,
  source_sha256   bytea,                  -- checksum of the retrieved source document
  retrieved_at    timestamptz,
  effective_from  date,
  effective_to    date,                   -- null = currently in force
  review_status   text not null default 'unverified' check (review_status in
                    ('unverified','verified','published','superseded','retired')),
  verified_by     uuid references public.app_user(id),
  verified_at     timestamptz,
  supersedes      uuid references public.legal_authority(id),
  note            text,
  created_at      timestamptz not null default now(),

  -- Risk 2, made impossible rather than documented.
  constraint authority_published_requires_human check (
    review_status not in ('verified','published')
    or (verified_by is not null and verified_at is not null and source_sha256 is not null)
  ),
  -- An effective window must be coherent if both ends are known.
  constraint authority_effective_window check (
    effective_from is null or effective_to is null or effective_to >= effective_from
  ),
  unique (jurisdiction, citation, effective_from)
);

create index idx_legal_authority_lookup
  on public.legal_authority (jurisdiction, citation);
create index idx_legal_authority_in_force
  on public.legal_authority (jurisdiction, authority_level)
  where review_status in ('verified','published') and effective_to is null;

-- Immutable: an authority record is evidence. Corrections supersede, never overwrite —
-- the same doctrine as form_version and signature.
create trigger trg_legal_authority_ao before update or delete on public.legal_authority
  for each row execute function app.forbid_mutation();

alter table public.legal_authority enable row level security;
alter table public.legal_authority force row level security;
-- Global read: public law is readable by any authenticated user of any tenant.
-- Deliberately no app.is_aal2() — this row class contains no PHI.
create policy legal_authority_select_all on public.legal_authority for select to authenticated
  using (true);
grant select on public.legal_authority to authenticated;
-- NO write grants. Authorities are authored by app.publish_authority (below) only.

-- ── The permission a human must hold to assert regulatory authority ────────
-- The seeded catalog was entirely operational; there was no permission key for
-- publishing a regulatory claim and no role corresponding to compliance review.
insert into public.permission (key, description) values
  ('compliance.authority.publish',
   'Attest that a regulatory citation is verified and may be published as authority')
on conflict (key) do nothing;

-- ── Lane-B: the only path to a verified authority ──────────────────────────
-- Supersession, not mutation: verifying an authority appends a new row that supersedes
-- the unverified one. The permission check, the checksum requirement and the human
-- verifier are all enforced here AND again by the table CHECK, so a future caller that
-- forgets one still cannot produce an unbacked claim.
create or replace function app.publish_authority(
  p_authority    uuid,     -- the unverified row being attested
  p_source_url   text,
  p_source_sha256 bytea,
  p_note         text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_src public.legal_authority;
  v_new uuid;
begin
  if not app.has_perm('compliance.authority.publish') then
    raise exception 'CAREOS_NOT_AUTHORIZED: compliance.authority.publish required'
      using errcode = 'P0001';
  end if;
  if p_source_sha256 is null then
    raise exception 'CAREOS_SOURCE_REQUIRED: a source-document checksum is required to publish'
      using errcode = 'P0001';
  end if;

  select * into v_src from public.legal_authority where id = p_authority;
  if not found then
    raise exception 'CAREOS_NOT_FOUND: legal authority' using errcode = 'P0001';
  end if;
  if v_src.review_status <> 'unverified' then
    raise exception 'CAREOS_INVALID_STATE: authority is %', v_src.review_status
      using errcode = 'P0001';
  end if;

  insert into public.legal_authority
    (authority_level, jurisdiction, issuing_body, citation, title,
     source_url, source_sha256, retrieved_at,
     effective_from, effective_to, review_status, verified_by, verified_at,
     supersedes, note)
  values
    (v_src.authority_level, v_src.jurisdiction, v_src.issuing_body, v_src.citation,
     v_src.title, coalesce(p_source_url, v_src.source_url), p_source_sha256, now(),
     v_src.effective_from, v_src.effective_to, 'published', auth.uid(), now(),
     v_src.id, p_note)
  returning id into v_new;

  perform app.emit_audit('compliance.authority.publish', 'legal_authority', v_new,
                         jsonb_build_object('supersedes', v_src.id,
                                            'citation', v_src.citation));
  return v_new;
end $$;

revoke all on function app.publish_authority(uuid, text, bytea, text) from public, anon;
grant execute on function app.publish_authority(uuid, text, bytea, text) to authenticated;

-- ── Wire the existing rule tables to real authority (expand-only) ──────────
-- The free-text columns are NOT dropped here. Contraction requires its own migration
-- and its own decision-log entry (invariant 12); until every row is backfilled and
-- verified, the old strings remain as a fallback the UI can label 'unverified'.
alter table public.cadence_rule
  add column legal_authority_id uuid references public.legal_authority(id);
alter table public.credential_type
  add column legal_authority_id uuid references public.legal_authority(id);

comment on column public.cadence_rule.comar_source_ref is
  'DEPRECATED (D-015): jurisdiction-specific free text. Use legal_authority_id. '
  'Contraction requires its own migration + decision entry.';

-- ── Read surface: is this rule backed by verified authority? ───────────────
-- security_invoker so the perimeter still applies (the established idiom —
-- 0009_cadence.sql:127, asserted by 0008_credentials.sql:75).
create or replace view public.cadence_rule_authority
with (security_invoker = true) as
select r.id                as cadence_rule_id,
       r.tenant_id,
       r.key,
       la.id               as legal_authority_id,
       la.citation,
       la.issuing_body,
       la.authority_level,
       la.source_url,
       la.effective_from,
       coalesce(la.review_status, 'none') as review_status,
       -- The single boolean the UI must branch on before showing a shield icon.
       (la.review_status in ('verified','published')) as authority_is_verified
  from public.cadence_rule r
  left join public.legal_authority la on la.id = r.legal_authority_id;

grant select on public.cadence_rule_authority to authenticated;
