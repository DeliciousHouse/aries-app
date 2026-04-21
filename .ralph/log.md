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

## 2026-04-21 — ISSUE-005 (logo candidates) — PASSING

- Story: Brand identity step 4 showed the page title "Nike. Just Do It.
  Nike.com" repeated as 4 text rows instead of logo images.
- Root cause: extractLogoUrls in backend/marketing/brand-kit.ts never
  scanned inline <svg class="logo"> (Nike's header pattern), discarded
  favicons via the -100 favicon penalty + score>=0 gate, and only kept
  og:image when a higher-signal logo already existed. So logo_urls came
  back empty and the frontend's graceful placeholder was being replaced
  upstream by the page title string.
- Fix: added extractHeaderNavSvgLogos pass (emits data:image/svg+xml
  URLs), added className signal to scoreLogoCandidate, tightened the
  <link> pass to rel=icon variants only, and kept favicons/og:image as
  fallback candidates when no explicit-signal logo exists. Ordering:
  explicit (score>=40) wins and caps at 2; else best-of-3 fallback.
- Frontend already renders img src tiles in VisualBoard — no change
  needed there, the bug was purely backend returning an empty array.
- Files changed:
  - backend/marketing/brand-kit.ts (extraction + normalize)
  - tests/marketing-brand-kit-logo-extraction.regression-005.test.ts (new)
- Verification: new regression covers 5 cases (nav-svg, favicon fallback,
  og fallback, explicit beats fallback, empty-page). Existing
  marketing-brand-kit.test.ts + brand-kit-logo-filter.test.ts +
  entity-decode regression + business-profile-screen.test.ts all still
  pass (42/42).
- Commits: f78a426 (fix), ef38ad5 (regression test), story + log flip to
  follow.
- Follow-ups: none — ordering decision (highest score first, og beats
  favicon in fallback tier) is deterministic and documented in the fix
  commit for future readers.
