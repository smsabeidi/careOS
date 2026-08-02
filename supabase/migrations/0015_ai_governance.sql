-- Migration 0015 — AI governance floor (Doc 16 Wave 0, D-013): per-capability model
-- pin + kill switch + budget cap, the registry-versioned prompt store, the disposition
-- flywheel, per-role huddle briefs, and the chunked corpus for embeddings retrieval.
--
-- Invariants enforced here:
--   * Invariant 8 (AI proposes, a licensed human disposes): ai_disposition is the
--     append-only record of every human disposition over an AI output — the flywheel
--     of §3.2 in Doc 16. Self-pinned inserts; no update/delete path exists.
--   * Invariant 10 (all model calls go through the client): prompts are registry rows
--     (ai_prompt_template), models are registry pins (ai_capability.model), and the
--     kill switch (ai_capability.enabled) + budget cap (monthly_budget_usd) are data,
--     not code — the client reads them before every call.
--   * Invariant 13 (deterministic vs probabilistic separated): huddle_brief.facts is
--     the deterministic payload computed in SQL; narrative is optional narration only.
--     A brief with narrative = null renders deterministically — AI is an accelerant,
--     never a dependency.
--   * Invariant 3 (AAL2 for PHI): huddle_brief facts name clients and staff → PHI;
--     both policies require app.is_aal2(). knowledge_chunk is POLICY text (not PHI),
--     scoped like knowledge_document.
--   * Invariant 9 (retrieval runs as the user): knowledge_chunk is read under the
--     caller's RLS; embedding search has no privileged path.
-- @trace: docs/16 §3.2/§4 Wave 0, docs/05, docs/11, D-013

-- ── ai_capability (CFG) — model pin, kill switch, budget cap ──────────────────────
alter table public.ai_capability
  add column model text,                                  -- registry-pinned model id; null = client default
  add column enabled boolean not null default true,       -- kill switch: false ⇒ capability refuses politely
  add column monthly_budget_usd numeric(10,2);            -- null = uncapped; client checks before each call

-- ── ai_prompt_template (CFG) — the registry-versioned prompt store ────────────────
-- Prompts are versioned rows, never string literals in code. The client resolves the
-- active version per capability and records it as ai_interaction.prompt_version.
-- Authored via admin RPC (later story) — no client write grants.
create table public.ai_prompt_template (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  capability_key text not null,
  version int not null,
  system_prompt text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, capability_key, version)
);
create index idx_ai_prompt_template_active
  on public.ai_prompt_template (tenant_id, capability_key) where active;

alter table public.ai_prompt_template enable row level security;
alter table public.ai_prompt_template force row level security;
create policy ai_prompt_template_select_tenant on public.ai_prompt_template
  for select to authenticated
  using (tenant_id = app.current_tenant_id());
grant select on public.ai_prompt_template to authenticated;   -- read-only from the client

-- ── ai_disposition [AO] — every human disposition over an AI output (the flywheel) ─
-- Accept / edit / reject + reason code, keyed to the ai_interaction row (which carries
-- capability, model, and prompt_version — Doc 16 §3.2 rule: no pair is useful unless it
-- answers "which template version and model produced this?"). edited_digest is PHI-SAFE
-- (the client's minimizer produces it); raw content never lands here.
create table public.ai_disposition (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  ai_interaction_id uuid not null references public.ai_interaction(id),
  capability_key text not null,
  action text not null check (action in ('accepted','edited','rejected')),
  reason_code text check (reason_code in ('wrong','tone','unsafe','incomplete','other')),
  edited_digest text,                      -- PHI-safe digest of the human's edit, if any
  disposed_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_ai_disposition_tenant on public.ai_disposition (tenant_id, created_at desc);
create index idx_ai_disposition_interaction on public.ai_disposition (ai_interaction_id);

create trigger trg_ai_disposition_ao before update or delete on public.ai_disposition
  for each row execute function app.forbid_mutation();

alter table public.ai_disposition enable row level security;
alter table public.ai_disposition force row level security;
-- Read: your own dispositions, or ai.read (oversight). Insert: self-pinned — a human
-- records their OWN disposition (invariant 8); nobody can dispose on another's behalf.
create policy ai_disposition_select_scoped on public.ai_disposition
  for select to authenticated
  using (tenant_id = app.current_tenant_id()
    and (disposed_by = auth.uid() or app.has_perm('ai.read')));
create policy ai_disposition_insert_self on public.ai_disposition
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and disposed_by = auth.uid());
grant select, insert on public.ai_disposition to authenticated;   -- append-only: no update/delete

-- ── huddle_brief [AO] (PHI) — the per-role morning brief (Doc 16 X5) ──────────────
-- facts = the deterministic payload (SQL-computed ground truth: call-outs, gaps,
-- obligations, expiring credentials). narrative = optional LLM narration; null means
-- the brief renders deterministic-only (provider 'none'). One brief per role per day
-- (role-wide), plus optional per-user editions.
create table public.huddle_brief (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  role_key text not null check (role_key in ('owner','coordinator','rn','caregiver')),
  for_user uuid references public.app_user(id),           -- null = role-wide edition
  brief_date date not null,
  facts jsonb not null,                                   -- deterministic payload (ground truth)
  narrative text,                                         -- LLM narration; null = deterministic-only render
  provider text not null default 'none'
    check (provider in ('none','openai','anthropic','mock')),
  model text,
  generated_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
-- One role-wide brief per (tenant, role, day); one per-user brief per (tenant, role, user, day).
create unique index uq_huddle_brief_role_wide on public.huddle_brief
  (tenant_id, role_key, brief_date) where for_user is null;
create unique index uq_huddle_brief_per_user on public.huddle_brief
  (tenant_id, role_key, for_user, brief_date) where for_user is not null;
create index idx_huddle_brief_tenant_date on public.huddle_brief (tenant_id, brief_date desc);

create trigger trg_huddle_brief_ao before update or delete on public.huddle_brief
  for each row execute function app.forbid_mutation();

alter table public.huddle_brief enable row level security;
alter table public.huddle_brief force row level security;
-- Read (PHI ⇒ AAL2): oversight (ai.read), your own per-user edition, or the role-wide
-- edition of a role you hold. The for_user-is-null guard keeps one caregiver's personal
-- edition out of another caregiver's view — "their role_key rows" means role-WIDE rows.
create policy huddle_brief_select_scoped on public.huddle_brief
  for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_aal2()
    and (app.has_perm('ai.read')
      or for_user = auth.uid()
      or (for_user is null and role_key in (
            select r.key from public.user_role ur
            join public.role r on r.id = ur.role_id
            where ur.user_id = auth.uid()))));
-- Insert (AAL2): the generator records the brief as themselves — self-pinned.
create policy huddle_brief_insert_self on public.huddle_brief
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.is_aal2()
    and generated_by = auth.uid());
grant select, insert on public.huddle_brief to authenticated;   -- append-only: no update/delete

-- ── knowledge_chunk — chunked corpus for hybrid FTS + vector retrieval (Doc 16 X2) ─
-- POLICY text (not PHI), tenant-scoped like knowledge_document. embedding is nullable:
-- seeds land chunks with embedding null; the backfill arrives at runtime through the
-- X2 story's dedicated path (never a broad client UPDATE grant).
create extension if not exists vector with schema extensions;

create table public.knowledge_chunk (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  document_id uuid not null references public.knowledge_document(id),
  seq int not null,
  content text not null,
  embedding extensions.vector(1536),                      -- text-embedding-3-small; null until backfilled
  created_at timestamptz not null default now(),
  unique (document_id, seq)
);
create index idx_knowledge_chunk_tenant on public.knowledge_chunk (tenant_id);
create index idx_knowledge_chunk_embedding on public.knowledge_chunk
  using hnsw (embedding extensions.vector_cosine_ops);
create index idx_knowledge_chunk_fts on public.knowledge_chunk
  using gin (to_tsvector('english', content));

alter table public.knowledge_chunk enable row level security;
alter table public.knowledge_chunk force row level security;
-- Retrieval-as-the-user (invariant 9): the Brain searches chunks under the caller's RLS.
create policy knowledge_chunk_select_tenant on public.knowledge_chunk
  for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy knowledge_chunk_insert_manage on public.knowledge_chunk
  for insert to authenticated
  with check (tenant_id = app.current_tenant_id()
    and (app.has_perm('ai.manage') or app.has_perm('client.write')));
-- Embedding backfill runs as the user too (invariant 6: no service_role in a request
-- path). The grant is COLUMN-scoped: a holder of ai.manage may write `embedding` and
-- nothing else, so corpus text stays immutable while vectors land at runtime.
create policy knowledge_chunk_update_embedding on public.knowledge_chunk
  for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_perm('ai.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_perm('ai.manage'));
grant select, insert on public.knowledge_chunk to authenticated;
grant update (embedding) on public.knowledge_chunk to authenticated;
