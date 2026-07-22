# CareOS Agent Harness — CLAUDE.md + Skills

**What this is.** The operating system for the AI coding agent(s) that build CareOS. It converts the 16-document spec package (`docs/00–15`) into *enforceable, in-context engineering law*: a master constitution that is always loaded, plus nine deep skills that load on demand when the agent touches the corresponding domain.

**Design.** Two layers, matching how 2026 agents actually consume context:

1. **`CLAUDE.md` (always loaded).** The mission, the spec-corpus precedence rules, the fourteen non-negotiable invariants, the workflow loop, definition of done, and escalation rules. Kept lean on purpose — it's in every context window.
2. **`.claude/skills/careos-*/SKILL.md` (loaded when triggered).** Domain playbooks with copy-paste templates: schema/RLS, PHI safety, API lanes, frontend, mobile/offline, AI layer, testing, DevOps, compliance context. Each skill's `description` is written to trigger aggressively on its domain, and each ends with pointers into the deep docs.

## Install

```
your-repo/
├── CLAUDE.md                        ← from this folder (repo root)
├── docs/                            ← the 16-document package (00–15)
├── .claude/
│   └── skills/
│       ├── careos-db-schema-rls/SKILL.md
│       ├── careos-phi-safety/SKILL.md
│       ├── careos-api-workflows/SKILL.md
│       ├── careos-frontend-design/SKILL.md
│       ├── careos-mobile-offline/SKILL.md
│       ├── careos-ai-layer/SKILL.md
│       ├── careos-testing-quality/SKILL.md
│       ├── careos-devops-operations/SKILL.md
│       └── careos-compliance-context/SKILL.md
└── ...
```

- Commit everything — project-scoped skills in `.claude/skills/` travel with the repo, so every engineer's agent (and CI agents) get identical law.
- Personal experiments can go in `~/.claude/skills/`, but **team law lives in the repo**.
- The SKILL.md format follows the open Agent Skills standard, so the same files work in Claude Code, Claude.ai (zip-upload under Settings → Features), the API, and other compatible agents.
- Verify loading: start a session in the repo and ask "which CareOS skills do you have?" — the agent should list all nine from their descriptions.

## Enforcement beyond prompting (recommended, phase-in)

Prompts steer; harness rules enforce. As the repo matures, add deterministic backstops so the invariants hold even if a model ignores instructions:

- **CI is the real enforcer** (already specced): pgTAP RLS matrix, policy-catalog drift check, canary-PHI suite, eval gates (docs/12–13). The agent is told a red gate is never "fixed" by weakening the gate.
- **Hooks** (Claude Code): block file edits to `tests/canary/**` and `db/policies.md` (generated), require `pnpm test:pgtap` after any `db/migrations/**` change.
- **CODEOWNERS**: human review required on `db/`, `packages/ai/`, auth code — mirrors docs/13 §2.

## Maintenance

- The harness is downstream of the docs. When `docs/00 §3` gains a decision, update the affected skill in the same PR — harness drift is a bug (same rule as policy-catalog drift, docs/07 §11).
- Keep CLAUDE.md under ~200 lines; push detail into skills; push *depth* into `docs/`.
- Optionally run a skill-triggering eval pass later (skill-creator tooling) once you see real misses in daily use.
