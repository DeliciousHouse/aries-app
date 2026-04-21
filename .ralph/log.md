# Ralph Agent Log — Aries QA Follow-up

Kicked off: 2026-04-20 by Hermes (driver: claude-sonnet-4-6 via delegate_task).

Context: continuation of QA work. First fix (HTML entity decode for brand voice)
already landed in commits a739162 + f77c0a5. This loop handles the remaining 8.

---

## 2026-04-20 — ISSUE-010 (tab routing) — PASSING

- Story: Brand/Strategy/Creative/Launch Status tabs changed URL but not content.
- Root cause: AriesCampaignWorkspace derived `activeView` from a server-component
  prop (`initialView`). Next.js App Router client-side navigation mutates
  search params without re-invoking the server component, so the prop stayed
  frozen after first render and the switch never re-evaluated.
- Fix: read `view` reactively via `useSearchParams()` from `next/navigation` and
  funnel it through a new `resolveWorkspaceView()` helper. `initialView` kept
  as first-render fallback.
- Files changed:
  - frontend/aries-v1/campaign-workspace.tsx
  - frontend/aries-v1/campaign-workspace-state.ts (added resolveWorkspaceView)
  - tests/campaign-workspace-tab-routing.regression-010.test.ts (new)
- Verification: `npx tsx --test` on new + existing campaign-workspace-state test
  file → 15/15 pass. `npx tsc --noEmit` produced no new errors on touched files.
- Commits: f8b2452 (fix), 91c6b4a (test), 9c8fea7 (story flip).
- Live-site browser verification skipped (deploy-gated per task context).

---

## 2026-04-21 — ISSUE-001 landing page empty hero sections (PASSING)

- Root cause: `Hero` in `frontend/donor/marketing/home-page.tsx` uses `h-[250vh]` with an inner `sticky top-0 h-screen`. Scroll-linked transforms faded central circle, orbit platforms, and orbit lines to opacity 0 at scrollYProgress `[0.5, 0.6]`, but the sticky pin doesn't release until progress `1.0`. Resulted in ~1.5 viewports of transparent hero content scrolled past before the testimonial — the "large black void" in the QA report.
- Fix: Shift three `useTransform` keyframe pairs from `[0.5, 0.6]` to `[0.9, 1.0]` so hero visuals stay visible until the section actually ends, matching the logo's existing `[0.95, 1]` fade. 6 lines changed, no structural edits.
- Verification: `npx tsx --test tests/runtime-pages.test.ts tests/public-marketing-pages.test.ts` → 36/36 pass. Live-site repro matched the hypothesis (empty region at scroll ~900–1500px corresponded exactly to `250vh - 1vh` pin tail).
- Commits: d84900c (fix), story + log flip to follow.
- Follow-ups: Other gaps noted in the bug ("Built for business owners", footer spacing) appeared to be ordinary between-section padding in the rendered accessibility tree — not empty sections. If QA's next pass still flags them, they need design input on content density, not a code fix.

---
