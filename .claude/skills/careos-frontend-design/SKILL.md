---
name: careos-frontend-design
description: The web UI law for CareOS. Use for ANY frontend work — pages, components, layouts, forms, dashboards, UI copy/microcopy, loading/empty/error states, styling, accessibility, or performance. Fires even for "quick UI tweaks", because every screen carries the four-state doctrine, a11y gates, PHI-in-bundle rules, and the plain-language voice. Also use when reviewing designs or writing Storybook stories.
---

# CareOS Frontend & Design Playbook

Deep spec: `docs/10`. The audience test for everything: **a non-technical caregiver on a mid-tier Android in a basement.**

## Build rules

- **RSC-first.** Data-heavy views render on the server; PHI never lands in client JS bundles pre-authorization. Client components only for interactivity (forms runtime, scheduler, map, voice). Mutations via Server Actions → Lane B RPCs, optimistic UI with rollback toasts.
- **Use the system, don't fork it.** Tokens (`packages/ui/tokens`): Inter, 1.25 scale, 4-pt spacing, teal-700 accent, semantic status colors with AA pairs. Components: shadcn/Radix-based CareOS set — `StatusChip`, `ComplianceBadge`, `AIAssistLabel`, `ConflictResolver`, `SignatureBlock`, `OfflineBanner`, `ApprovalCard`, `EmptyState`… Extend variants in `packages/ui`, never one-off styles in app code. New component ⇒ Storybook story with all states + visual-regression snapshot.
- **Compliance states = color + icon + label.** Never color alone.
- **Four-state doctrine — every screen ships all four:** empty (explanation + primary action), loading (layout-mirroring skeletons, no spinner walls), error (what happened + what's preserved + retry), degraded (AI/offline fallbacks per docs/10 §8). Storybook stories required for each; a screen missing a state is an incomplete story.

## The forms runtime (touch with care — it's the product's heart)

Schema-driven from `form_template` — never hard-code a form. Autosave ≤3 s + on-blur to draft versions with visible "Saved ✓". Validation: plain-language, inline; distinguish *required-to-save* vs *required-to-finalize* (never block typing for completeness). AI drafts render visually distinct until accepted per section, with the persistent provenance label ("Drafted with AI · reviewed & signed by …"). Finalize = review of exact content + hash excerpt + AAL2 step-up + explicit intent copy; post-final is locked with "Create correction" (reason required) as the only path. **Conflict = `ConflictResolver` keep-both merge; there is no overwrite button in CareOS and you will not add one.**

## Copy voice (docs/10 §1, §3)

Plain, specific, blame-free, next-action-first. "Ms. Johnson's yearly check-up is due Friday" not "Obligation OBL-1042 pending." Errors: what happened + what's saved + what to do. No jargon outside compliance-lead surfaces. All strings through i18n keys (`en` + `es`) — hard-coded strings fail lint.

## Accessibility & performance (release gates, not aspirations)

WCAG 2.1 AA: axe-clean in CI on gated flows; full keyboard operability; focus managed on route change; errors announced via live regions; 48 dp touch targets (56 dp for clock actions); dynamic type to 200%. Budgets enforced in CI: LCP < 2.5 s on 4G mid-tier Android, INP < 200 ms, route JS < 170 KB gz on field surfaces — a budget breach is a failing check, not a note.

## Don'ts

Don't fetch PHI in client components that RSC could render · don't build bespoke tables/modals/toasts beside the system ones · don't express compliance/absence states in prose-free iconography · don't add a data-dense "power view" without its plain-language default · don't ship a flow the keyboard can't complete.
