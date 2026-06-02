# Public-Readiness Roadmap — Reconciliation (2026-06-01)

**Author:** Lead planner (reconciliation pass)
**Source of truth:** `git log` (PR-cited), `docs/plans/*` (file-cited), live repo recon, `app/` route tree.
**Scope:** Map all 15 public-readiness areas (and their sub-items) to shipped / plan-exists / needs-plan, then emit a dependency-ordered build plan for every uncovered area.

---

## Legend

| Marker | Meaning |
|---|---|
| **SHIPPED** | Code is live on `master` (PR cited). User-visible per the guardrail only if the cited surface is rendered UI; backend-only items are flagged `SHIPPED (backend)`. |
| **PLAN-EXISTS** | A `docs/plans/*` file fully covers it; not yet executed/verified. Cite the file. |
| **PARTIAL** | Some sub-items shipped, others need a plan. Split into per-sub-item rows. |
| **NEEDS-PLAN** | No plan and no shipped code. Gets a new `docs/plans/2026-06-01-*.md`. |

Guardrail reminder applied throughout: VM is **production** (live tenants); user-visible completion = **rendered operator-dashboard UI only**; brand URL is **aries.sugarandleather.com** (never bare); new behavior ships **default-OFF**; **never** expose `MARKETING_STATUS_PUBLIC=1` in prod; nothing publishes without human approval.

---

## Per-Area Reconciliation Table

| Area | Sub-item | Status | Evidence |
|---|---|---|---|
| **1a** Test suite split (requires-infra vs self-contained) | — | **PARTIAL → PLAN-EXISTS** | Phase C landed (#515 dead `runScript` helpers removed); full-suite gate REQUIRED on master (#505, #507). Remaining Phase B/D/E work (4 flat-vs-tenant-scoped fixtures in `tests/frontend-api-layer.test.ts:815,1873,2333`; oauth-connect `status` vs `connection_status` column drift `tests/auth/oauth-connect.test.ts:56,122`) is fully specified in `docs/plans/2026-05-30-test-suite-repair.md`. **Plan exists, not finished.** |
| **1b** Publish failure clarity ("Reconnect account") | — | **SHIPPED (backend)** | 4-class taxonomy (`outcome_unknown`/`auth`/`transient`/`permanent`) + `oauth_token_missing`/`external_account_missing` reconnect codes in `backend/integrations/meta-publishing.ts:128-173`; per-platform `kind` returned by `app/api/internal/publishing/scheduled-dispatch/route.ts:237-241` (#519). **The operator-facing "Reconnect account" RENDERED UI is NOT yet wired** — see Area 7 gap. |
| **1c** Backfill + verify `creative_asset_ids` | — | **PARTIAL → PLAN-EXISTS (execution outstanding)** | Backfill *script* exists (`scripts/backfill-creative-asset-ids.mjs`) + write paths shipped (#519). BUT `docs/plans/2026-05-30-publishing-reliability.md:17,48` documents that **prod rows written before the PRs are still `'{}'`, the backfill has never run, and the manual-schedule path is unverified** — a multi-image job can still publish the wrong creative. P1/P2 execution + verification outstanding. |
| **1d** Public "known limitations" page | — | **NEEDS-PLAN** | No `app/limitations`, `app/known-limitations`, or equivalent route exists. Security/self-host facts are documented in `docs/SECURITY_MODEL.md` / `docs/SELF_HOSTING.md` but never surfaced as a public page. |
| **2** Public demo experience ("first useful result") | — | **NEEDS-PLAN** | Only a programmatic public artifact catch-all (`app/[...publicPath]/route.ts` + `backend/marketing/public-pages.ts`) exists. No curated demo tenant, no website→brand-draft→sample-calendar flow, no "save by creating account." Must NOT expose `MARKETING_STATUS_PUBLIC=1` in prod. |
| **3** Review Queue v2 (diff / brand-fit / risk flags / revision brief / publish summary) | — | **PARTIAL → NEEDS-PLAN** | Basic queue EXISTS (`app/review/page.tsx`, `app/review/[reviewId]/page.tsx`) and decision endpoints EXIST (`app/api/marketing/reviews/[reviewId]/decision/route.ts`, `app/api/marketing/jobs/[jobId]/approve/route.ts`) — correcting RECON 5 which said decision routes were missing. But v2 emotional-center features (side-by-side version diff, brand-fit score, risk flags, approval history, one-click revision brief, final publish summary) are ALL absent — grep for `brand.fit`/`risk.flag`/`revision.brief`/`version.diff` in `review-queue.tsx` returns nothing. |
| **4** Memory transparency screen | — | **PARTIAL → NEEDS-PLAN** | `app/creative-memory/page.tsx` is internal prompt-recipe tooling, **not linked from operator nav** (grep of `frontend/aries-v1/` finds no link). Curation engine LIVE (`backend/memory/curator.ts`). Missing: operator-facing screen with brand/audience/voice/rejected/constraints/learnings/pending sections, each fact's source/status/used-in + Edit/Supersede/Delete. Honcho writes already land (per memory). |
| **5** Brand-aligned redesign (Obsidian/Cream/Warm Stone/Ember + Cormorant Garamond + Helvetica Neue) | — | **NEEDS-PLAN** | Confirmed current system is Inter/Manrope + violet `#7c3aed`/cyan `#38bdf8` (`app/layout.tsx`, `styles/redesign/tokens.css`). Zero hits for obsidian/warm stone/cormorant/helvetica neue anywhere. This is the **token foundation** every screen consumes — must precede screen-level work. |
| **6** Onboarding business-setup wizard (goals → channels → voice → approval rules → first weekly plan) | — | **PARTIAL → NEEDS-PLAN** | Multi-step wizard EXISTS (`app/onboarding/start/page.tsx` → `frontend/aries-v1/onboarding-flow.tsx`: goal/business/website/brand/channels; channels include Meta/IG/TikTok/YouTube/LinkedIn). Legacy intake redirects to it. MISSING: voice stage (tone picker / good-bad examples / words-to-avoid), approval-rules stage, and "generate first weekly plan immediately → review queue → calendar" completion handoff. |
| **7** Channel health + reconnect impossible-to-miss | — | **PARTIAL → NEEDS-PLAN** | Channel-integrations screen EXISTS (`app/dashboard/settings/channel-integrations/page.tsx`: `connected`/`reauth_required`/`connection_error`, reconnect button). MISSING the publish-blocking reconnect surface that consumes 1b's `auth` signal: per-channel can-publish / can-read-results / "scheduled posts paused — Reconnect Meta" banner driven by live token validity + last sync. This is what makes 1b user-visible. |
| **8** Reels/Stories/video publishing (flag-gated) | — | **SHIPPED** | `ARIES_VIDEO_PUBLISH_ENABLED` default OFF; FB/IG video+story+reel dispatch branches (`backend/integrations/meta-publishing.ts:366-822`), per-surface validation (`backend/integrations/meta-media-validation.ts`), `posts.surface`/`scheduled_posts.media_type` migration (`migrations/20260531120000_posts_surface.sql`), synthesis strip-when-off (`backend/marketing/synthesize-publish-posts.ts:488-491`) (#520). Image-story composition also live (#523/#524/#525). Plan: `docs/plans/2026-05-30-story-reel-video-publishing.md`. |
| **9** Shareable client campaign preview (`/public-:brandSlug/campaign` + comments/approval/expiry/password) | — | **PARTIAL → NEEDS-PLAN** | Read-only public artifact resolution EXISTS (`backend/marketing/public-pages.ts`, slug must start `public-`). MISSING the share *system*: approved/unapproved sectioning, client comments, require-approval-before-publish, read-only link **expiry + password protection** (grep confirms none present). |
| **10** "Launch Readiness" product concept (readiness % + Ready/Blocked checklist) | — | **NEEDS-PLAN** | A `readiness` array is embedded in the home dashboard hero view-model (`frontend/aries-v1/view-models/dashboard-home.ts:32-37`) but there is no standalone readiness surface, no % computation, no unified Ready/Blocked checklist across onboarding/integrations/review/scheduling/publishing/results. |
| **11** Results → Next Action loop (weekly report + approve-this-learning) | — | **PARTIAL → NEEDS-PLAN** | Honcho performance-insights WRITE leg shipped, default OFF (`HONCHO_WRITE_PUBLISH_ENABLED`, `backend/memory/write-events.ts:637-748`, #522). Results screens exist (`app/results/page.tsx`, `app/dashboard/results/page.tsx`). MISSING the weekly report UI (published/skipped/top-channel/best-worst post/what-Aries-learned/next-week-recommendation) and the "Approve this learning? [Approve memory][Edit][Reject]" loop that promotes a performance memory candidate. |
| **12** Easier self-hosting (one-command stack, bundled Postgres, Hermes stub, setup-checklist UI, "self-host vs managed") | — | **NEEDS-PLAN** | Confirmed `docker-compose.yml` does NOT bundle Postgres (expects external `DB_*`). No Hermes stub/demo mode, no setup-checklist UI (missing env / DB status / Hermes reachability / OAuth readiness), no seeded demo tenant, no comparison page. 8 friction points enumerated in recon. |
| **13** Public trust center (auth model / tenant isolation / token encryption / callback security / rotation / deletion-export / reporting / what-Aries-does-NOT-do) | — | **NEEDS-PLAN** | All facts exist in `docs/SECURITY_MODEL.md` (sessions, two-layer tenant auth, `OAUTH_TOKEN_ENCRYPTION_KEY` at-rest, dual-layer Hermes callback auth, constant-time compares, secret-rotation table) but there is NO public trust page rendering them. Pairs with 1d. |
| **14** Team roles & approval policies UI | — | **NEEDS-PLAN** | Confirmed only 3 roles (`tenant_admin`/`tenant_analyst`/`tenant_viewer`, `lib/tenant-context.ts:6`); no Approver/Strategist/Operator/Reviewer distinction, no `/admin/members`/`/admin/roles` page (settings dir holds only business-profile + channel-integrations), no policy config ("only admin can publish", "client must approve strategy", "generated video always requires approval", "memory candidates require owner approval"). |
| **15** Repeatable marketing workflows (Weekly Social core → Campaign Plan → Creative Production → Landing Brief → Competitor Research → Performance Review → Public Preview) | — | **PARTIAL → NEEDS-PLAN** | Weekly Social Content workflow is the live core (orchestrator + atomic stage workflows via `/api/tenant/workflows/*`, `backend/execution/workflow-catalog.ts`). MISSING the productized, separately-surfaced workflows (Campaign Plan, Landing Page **Brief** [structured copy/sections, not full-page gen], bounded/sourced Competitor Research, Performance Review, Public Campaign Preview) each with typed input / stages / job status / artifacts / approval gates / memory candidates / retry-resume. Do NOT add placeholder workflow files (guardrail). |

---

## Status Rollup

- **SHIPPED (fully):** 8, 1b (backend taxonomy only).
- **PLAN-EXISTS (execution/verification outstanding):** 1a (`test-suite-repair`), 1c (`publishing-reliability` P1/P2).
- **NEEDS-PLAN (new 2026-06-01 plans):** 1d, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15. (1c also gets a focused execution plan because the prod backfill RUN is a P0 trust gate not yet done despite the descriptive plan.)

---

## Execution Order (re-ordered by REAL dependency, not the raw "10 best first")

**Wave 0 — P0 trust gates (must clear before any public launch):**
1. `publish-reliability-backfill-verify` (Area 1c) — run + verify the prod `creative_asset_ids` backfill; without it the wrong creative can still publish. No UI dependency.
2. `test-suite-split-finish` (Area 1a) — finish Phase B/D/E so the REQUIRED full-suite gate is honestly green; everything else pushes through this gate.

**Wave 1 — Foundation the screens consume:**
3. `brand-design-tokens` (Area 5) — Obsidian/Cream/Warm Stone/Ember + Cormorant Garamond/Helvetica Neue token + font migration. **Blocks every new/redesigned screen** so they are built once, on-brand.
4. `channel-health-reconnect-ui` (Area 7) — renders the already-shipped 1b `auth` signal; makes "Reconnect account" user-visible. Depends on tokens.

**Wave 2 — First-user experience (consumes tokens + reconnect):**
5. `launch-readiness-dashboard` (Area 10) — unifies onboarding/integrations/review/scheduling/publishing/results signals; consumes channel-health.
6. `review-queue-v2` (Area 3) — diff/brand-fit/risk/history/revision-brief/publish-summary.
7. `memory-transparency-screen` (Area 4) — operator-facing facts screen + Edit/Supersede/Delete; surfaces existing Honcho writes.
8. `public-demo-tenant` (Area 2) — curated demo; depends on tokens; explicitly NO `MARKETING_STATUS_PUBLIC=1` in prod.
9. `onboarding-wizard-voice-policy` (Area 6) — add voice + approval-rules stages + first-weekly-plan handoff into the review queue.

**Wave 3 — Feature depth & loops:**
10. `weekly-results-next-action` (Area 11) — weekly report + approve-this-learning; consumes results data + Honcho write leg.
11. `shareable-campaign-preview` (Area 9) — share system w/ comments + approval + expiry/password.
12. `team-roles-policies-ui` (Area 14) — role expansion + policy config; review-queue v2 and approval gates lean on richer roles.

**Wave 4 — Trust surfaces & ecosystem:**
13. `public-trust-and-limitations` (Areas 1d + 13) — single plan, two public pages from existing `SECURITY_MODEL.md`/`SELF_HOSTING.md` facts.
14. `easier-self-hosting` (Area 12) — bundled Postgres / Hermes stub / setup-checklist UI / seeded demo / comparison page.
15. `repeatable-marketing-workflows` (Area 15) — productize Campaign Plan / Landing Brief / Competitor Research / Performance Review / Public Preview as typed workflows (no placeholder files).

---

## Dependency Graph (notes)

- `brand-design-tokens` is the root for all rendered-UI work → review-queue-v2, memory-screen, launch-readiness, channel-health, demo-tenant, onboarding, weekly-results, share-preview, roles-ui, trust pages all depend on it (build on-brand once).
- `channel-health-reconnect-ui` → consumed by `launch-readiness-dashboard` (Blocked items include "IG needs reconnect") and is the rendered home for the shipped 1b signal.
- `publish-reliability-backfill-verify` and `test-suite-split-finish` are **independent P0 gates** with no UI dependency — run first, in parallel.
- `weekly-results-next-action` depends on the shipped Honcho write leg (#522) + results screens, and feeds memory candidates into `memory-transparency-screen`.
- `onboarding-wizard-voice-policy`'s "generate first weekly plan → review" handoff depends on `review-queue-v2` existing.
- `team-roles-policies-ui` is depended on (soft) by review-queue-v2's approval-history/who-approved and by onboarding approval-rules; sequenced after the core screens so policy hooks attach to real surfaces.
- `public-trust-and-limitations` and `easier-self-hosting` are leaf ecosystem items — no downstream dependents; safe to do last but each is a launch-credibility item.
- Every NEEDS-PLAN item ships its new behavior **default-OFF** where it changes runtime, runs the **CI-exact full suite** before push, and counts as done **only** when the operator dashboard renders it.
