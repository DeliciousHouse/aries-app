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
