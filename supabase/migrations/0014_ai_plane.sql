-- Migration 0014 — the AI plane: capability registry (tiers), knowledge corpus, and the
-- append-only ai_interaction ledger that records EVERY model call.
-- Implements: docs/05 + docs/11 (AI). Vendor: OpenAI (D-log 2026-07, user-directed) — a NEW
-- vendor; real PHI to any LLM waits for a signed BAA, synthetic-only until then.
--
-- Invariants enforced here:
--   * Invariant 8 (AI proposes, a licensed human disposes): ai_capability.tier ∈ T0..T3,
--     and requires_human is CHECK-forced true for T2/T3. Nothing clinical/compliance-final
--     may be T0/T1 auto-execute — the DB refuses to register it.
--   * Invariant 10 (all model calls go through the client): ai_interaction is the ledger the
--     client (apps/web/src/lib/ai/client.ts) writes on every call. Append-only [AO].
--   * Invariant 5 (no PHI in AI records/prompts outside allowlist): ai_interaction stores only
--     PHI-SAFE digests (the client's PHI-minimizer produces them); the CHECK/columns here carry
--     no PHI, and knowledge_document is POLICY text (not PHI).
--   * Invariant 9 (retrieval runs as the user): the corpus is read under the caller's RLS; there
--     is no privileged retrieval path.
-- @trace: docs/05, docs/11, D-log OpenAI

insert into public.permission (key, description) values
  ('ai.read',   'Read the AI activity ledger across the tenant'),
  ('ai.manage', 'Manage AI capabilities and the knowledge corpus')
on conflict (key) do nothing;

-- ── ai_capability (CFG) — the registry + autonomy tier of each AI capability ──────
create table public.ai_capability (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  key text not null,                       -- 'brain.answer','intake.extract',…
  name text not null,
  description text,
  tier text not null check (tier in ('T0','T1','T2','T3')),
  requires_human boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  -- Invariant 8, DB-enforced: T2/T3 (adverse / clinical / compliance-final) ALWAYS require
  -- a human. You cannot register a high-autonomy capability that skips the human.
  constraint ai_capability_tier_human
    check (tier in ('T0','T1') or requires_human = true)
);
create index idx_ai_capability_tenant on public.ai_capability (tenant_id) where active;

alter table public.ai_capability enable row level security;
alter table public.ai_capability force row level security;
create policy ai_capability_select_tenant on public.ai_capability for select to authenticated
  using (tenant_id = app.current_tenant_id());
grant select on public.ai_capability to authenticated;   -- authored via admin RPC (config)

-- ── knowledge_document — the Brain corpus (agency POLICY, not PHI) ────────────────
create table public.knowledge_document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  title text not null,
  body text not null,
  category text not null default 'policy'
    check (category in ('policy','procedure','regulation','faq','other')),
  source_ref text,                         -- 'COMAR 10.07.05.xx', 'Employee Handbook §4', …
  active boolean not null default true,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_knowledge_document_tenant on public.knowledge_document (tenant_id) where active;
-- Full-text search over title + body (the Brain retrieves as the user, invariant 9).
create index idx_knowledge_document_fts on public.knowledge_document
  using gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,'')));

alter table public.knowledge_document enable row level security;
alter table public.knowledge_document force row level security;
-- Policy text is low-sensitivity and tenant-wide readable by any staff member.
create policy knowledge_document_select_tenant on public.knowledge_document for select to authenticated
  using (tenant_id = app.current_tenant_id() and active);
create policy knowledge_document_insert_manage on public.knowledge_document for insert to authenticated
  with check (tenant_id = app.current_tenant_id()
    and (app.has_perm('ai.manage') or app.has_perm('client.write')));
grant select, insert on public.knowledge_document to authenticated;

-- ── ai_interaction [AO] — the ledger of EVERY model call (PHI-safe digests only) ──
create table public.ai_interaction (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenant(id),
  capability_key text not null,
  provider text not null default 'openai' check (provider in ('openai','anthropic','mock')),
  model text,
  prompt_version text,
  tier text not null default 'T1' check (tier in ('T0','T1','T2','T3')),
  status text not null default 'ok' check (status in ('ok','abstained','error','blocked')),
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(10,4) not null default 0,
  latency_ms int,
  input_digest text,                       -- PHI-safe summary (client minimizer output)
  output_digest text,                      -- PHI-safe summary
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now()
);
create index idx_ai_interaction_tenant on public.ai_interaction (tenant_id, created_at desc);
create index idx_ai_interaction_creator on public.ai_interaction (created_by, created_at desc);

create trigger trg_ai_interaction_ao before update or delete on public.ai_interaction
  for each row execute function app.forbid_mutation();

alter table public.ai_interaction enable row level security;
alter table public.ai_interaction force row level security;
-- Read: your own AI activity, or ai.read (oversight). Insert: the caller logs their OWN
-- call (created_by pinned to self) — this is how the user-scoped AI client records calls
-- without service_role (invariant 6). Append-only.
create policy ai_interaction_select_scoped on public.ai_interaction for select to authenticated
  using (tenant_id = app.current_tenant_id()
    and (created_by = auth.uid() or app.has_perm('ai.read')));
create policy ai_interaction_insert_self on public.ai_interaction for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and created_by = auth.uid());
grant select, insert on public.ai_interaction to authenticated;   -- append-only: no update/delete
