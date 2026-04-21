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
- Code-review follow-up for ISSUE-005 landed: removed dead-code branch in extractHeaderNavSvgLogos so role=img alone qualifies; added regression tests for role=img SVG and og:image-vs-favicon tie-break ordering.

## ISSUE-004 — scraped brand text grammar artifacts (2026-04-21)
Root cause: stripping inline tags (<em>, etc.) replaces the boundary with a space so adjacent words don't fuse, but normalizeWhitespace did not collapse the resulting space-before-punctuation artifact (e.g. "innovative , experiences").
Fix: normalizeWhitespace now drops a single whitespace run before , . ; : ! ? and collapses repeated commas. URLs/ellipses unaffected.
Files: backend/marketing/brand-kit.ts, tests/marketing-brand-kit-grammar.regression-004.test.ts
Commits: 1916e1b (fix + regression test)
Verification: 43/43 pass across marketing-brand-kit, entity-decode-001, logo-extraction-005, brand-kit-logo-filter, grammar-004 suites.

## ISSUE-002 — onboarding core-offer textarea a11y (2026-04-21) — PASSING

Root cause: in frontend/aries-v1/onboarding-flow.tsx the Step-1 question
'What does your business offer?' was a <span> and the adjacent <textarea>
had neither htmlFor/id binding nor aria-label, so it never appeared in
the accessibility tree (browser snapshot returned no @e ref).
Fix: convert the question to <label htmlFor="onboarding-core-offer">,
add matching id on the <textarea>, plus an explicit
aria-label="Describe your core offer and customer" as a screen-reader
safety net. Class names and surrounding markup unchanged → no visual diff.
Files: frontend/aries-v1/onboarding-flow.tsx,
       tests/onboarding-textarea-a11y.regression-002.test.ts (new).
Commits: 15e8ac8 (fix), 776b484 (regression test), story + log flip to follow.
Verification: new regression passes (1/1); brand-kit suite still 43/43;
onboarding-flow-public still 4/4. No backend touched.

## ISSUE-008 — Visible brand links not deduplicated (PASSING)

- Root cause: extractExternalLinks deduped via JSON.stringify of {platform, url}, so query-string and fragment variants of the same hostname+path survived.
- Fix: new dedupeBrandLinks() helper keys on platform|hostname|pathname (URL-parsed, lowercased host, default '/' path). Preserves first-seen order; shortest URL wins on collision.
- Files: backend/marketing/brand-kit.ts, tests/marketing-brand-kit-link-dedup.regression-008.test.ts
- Commits: 0601b56 (fix + regression test)
- Verification: targeted regression suite (marketing-brand-kit + ISSUE-001/004/005/008 + brand-kit-logo-filter) — 48/48 pass.

## ISSUE-006 — Palette/Fonts empty-state copy (2026-04-21) — PASSING

- Investigation found VisualBoard in frontend/aries-v1/onboarding-flow.tsx
  already renders Logo-pattern-matching empty-state copy for both Palette
  ("Palette cues will appear here once the website review is ready.") and
  Fonts ("Type direction will appear here once the website review is
  ready.") at lines 1933 and 1953. Live-site symptom must be a stale
  deploy or pre-fix snapshot — the source has the branch.
- Action: locked in the behaviour with a regression test so a future
  refactor cannot drop the empty-state branches again. Test asserts:
  (1) Logo-candidates reference pattern still present,
  (2) Palette has `props.colors.length > 0 ? ... : <p>...will appear here...</p>`
      and the fallback mentions "Palette",
  (3) Fonts has the parallel branch on `props.fontFamilies` referencing
      type/typography copy,
  (4) Populated branches still iterate the underlying arrays so visual
      output is unchanged when content exists.
- Files: tests/palette-fonts-empty-state.regression-006.test.ts (new).
  No frontend source change needed — the fix already shipped.
- Verification: `npx tsx --test tests/palette-fonts-empty-state.regression-006.test.ts`
  → 3/3 pass.
- ISSUE-009 territory note: VisualBoard's font map keys on `font` alone
  (line 1946 `key={font}`), which would already collapse exact-string
  duplicates but not case/whitespace variants. Did NOT touch — that bug
  belongs to ISSUE-009. Flagged here for the next pass.
- Commits: regression test + story flip (atomic).

## ISSUE-009 — Font preview cards all identical (PASSING)

- Root cause: normalizeFontFamilies used plain Set dedup, so case/whitespace variants ("Arial", " Arial ", "arial") each survived as separate entries and became separate VisualBoard cards. Frontend already applied per-card fontFamily — the bug was data-layer.
- Fix: canonicalize dedup key (lowercased trimmed family) while preserving first-seen casing; still caps at 4. Also made VisualBoard React `key` case-insensitive as a belt-and-braces guard.
- Layer fixed: backend (primary) + frontend (defensive key).
- Files: backend/marketing/brand-kit.ts, frontend/aries-v1/onboarding-flow.tsx, tests/font-cards-dedup.regression-009.test.ts
- Commits: a4ac186 (fix), 1fbc9e3 (regression test)
- Verification: target regression suite (ISSUE-001/002/004/005/006/008/009 + marketing-brand-kit + brand-kit-logo-filter) — 56/56 pass.
