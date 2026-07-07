# Analytics Page Roadmap & Sprint Plan

**Date:** 2026-07-07
**Scope:** The analytics surface — the 9-section `/insights` dashboard (`app/insights/page.tsx` → `frontend/insights/`), the legacy `/dashboard/analytics` screen (`frontend/aries-v1/analytics-screen.tsx`), the 14 `app/api/insights/*` read routes + flag-gated reply route, the `backend/insights/**` builders and sync pipeline, and the `aries-insights-sync-worker` sidecar.
**Method:** 14 parallel code-recon passes over UI, API, sync, data model, flags, tests, issues, and prior plans; every claimed gap adversarially verified against the code (87 confirmed, 0 refuted). The resulting plan was then reviewed by a four-lens engineering panel (technical accuracy, sequencing/estimates, product value, repo conventions) and revised; see the appendix. File:line citations are as of `e5f7a7c`.

## Changelog

- 2026-07-07 — Initial plan (post gap-verification + four-lens review). Decisions ratified per S1-10 get recorded here.

---

## 1. Executive summary

The insights surface is in good shape structurally, and the recent run of fixes (PRs #782–785: hero connect-gate, real-FB trends math, goal normalization, `@unknown` authors, all-channel counting, and the flag-gated Hermes comment-classification pipeline) got the page rendering real data for a live Facebook tenant. The UI layer is polished — every section has skeleton/error/empty states, retry wiring, and a consistent design language.

What remains breaks down into five themes, in priority order:

1. **Trust & correctness (P0).** The single worst bug on the page is that per-post metrics are lifetime-cumulative snapshots SUMmed as daily deltas — totals inflate ~N× over N days of syncing. Several sections silently render "feature not wired" as "you have no data" (content mix, Working with Aries, demographics, sentiment), the most action-oriented CTA on the page 404s, and there is no data-freshness indication anywhere, so a dead sync is indistinguishable from an engagement plateau.
2. **Dormant shipped value (P0, mostly ops).** Comment classification is code-complete and tested but flag-gated OFF; with it off, five surfaces read zero. The Honcho performance leg is dark behind a stale gate (and its frozen SQL no longer matches the landed schema, so the gate cannot simply be flipped).
3. **Missing data writers (P1).** `insights_posts.content_type`, `aries_post_id`, and `reach`/`saves`/`profile_visits` all have readers but no production writer — content mix, Aries attribution, and the product-sales goal run on NULLs.
4. **New operator value (P1).** Weekly results report (planned 2026-06-01, entirely unbuilt), export/reporting, canonical goal configuration, native reply from the page.
5. **Scale & test hardening (P2 for a single-tenant prod, promoted before any multi-tenant growth).** The page fires 9 uncached-or-bypassable requests per load, has never been load-validated against the 50-user target, and the read side has near-zero CI-enforced tests (no tenant-isolation test on any insights GET route; section-endpoint tests self-skip in CI).

The sprint plan sequences these so that correctness lands before anything that would amplify wrong numbers (exports, reports), and attribution lands before any "what Aries did for you" reframing. Because prod serves a single tenant today, operator-visible value (weekly results, reply, goal) ships **before** the scale/hardening sprints — with two security-relevant exceptions (tenant-isolation tests and the Honcho/attribution safety sequencing) pulled forward. If multi-tenant growth or a new-tenant wave lands earlier than Sprint 7, re-order Phase 3 forward.

---

## 2. Current state (what works today)

- **`/insights`** — nine sections, each fetching its own endpoint via `frontend/insights/useInsight.ts` (stale-response tick guard, 401 messaging, retry-with-force): Hero/narrative + Aries Score, Goal, Attention, Activity, Trends (Recharts, current-vs-prior), Top Posts, Conversations, Working with Aries, Audience. Period (week/30/90d) + channel filters.
- **`/dashboard/analytics`** — per-platform metric cards, trend chart, per-post table, honest per-platform "metrics unavailable" reasons, capability-gated columns (`backend/insights/platforms/capabilities.ts`).
- **Sync pipeline** — `aries-insights-sync-worker` (30-min ticks) bridges Composio connections into `insights_accounts`, then runs a 5-leg, leg-isolated sync per account (post list, account dailies, per-post metrics, comments, optional Hermes classification) with an `insights_sync_runs` audit row per run and a stranded-run sweep. Facebook is live-verified; **Instagram is code-complete but live-unverified** (addressed in S3-5); X/YouTube/Reddit/LinkedIn adapters exist behind default-OFF flags.
- **Read API** — all 14 GET routes are real, tenant-scoped (`tenant_id = $1` by convention), session-authenticated queries; 6 section endpoints cache in `insights_narratives` (1h TTL; attention 15m).
- **Comment classification** — `backend/insights/sync/classify-comments.ts` (raw Hermes run, bounded 40/batch/tick, isolated to `legErrors`), 8-case unit test, ships default OFF.
- **Native reply** — `POST /api/insights/comments/[commentId]/reply` with claim/rollback idempotency and cross-tenant 404, flag-gated OFF. The route already dispatches to a Composio reply path (`backend/integrations/composio/composio-reply.ts`) that needs **no** Meta App Review; only the direct-Graph path is App-Review-blocked.

---

## 3. Verified gap inventory (grouped)

### A. Correctness / trust (highest priority)

| # | Gap | Evidence | Effort |
|---|-----|----------|--------|
| A1 | **Lifetime post-metric snapshots SUMmed as daily deltas — totals inflate over time.** IG/FB `fetchPostMetrics` return one lifetime-cumulative row stamped with today's date (`adapters/instagram/index.ts:389-412`, `facebook/index.ts:354-357`); every reader SUMs across date rows (`read-api.ts:165-169`, `top-snapshot-builder.ts:176-180`, `activity-snapshot-builder.ts:122`, `goal-snapshot-builder.ts:312`, `trends-snapshot-builder.ts:425`). #782 capped the symptomatic >999% deltas, not the write semantics. | data-model | L |
| A2 | **No data-freshness surfacing anywhere.** `insights_accounts.last_sync_at` and `insights_sync_runs` are write-only; **(A2a)** integrations cards hardcode `last_synced_at: null` (`app/api/integrations/handlers.ts:128,214`); **(A2b)** `/insights` renders no "data as of" stamp. A silently failing sync looks like an engagement plateau. | observability | S+M |
| A3 | **Dead link on the most urgent card:** Attention "Open Conversations" CTA → `/conversations` (404); real workspace is `/dashboard/comments` (`attention-card-builder.ts:76`). | UI | XS |
| A4 | **Stored-XSS surface:** three unescaped `dangerouslySetInnerHTML` sinks (`AttentionSection.tsx:147`, `TrendsSection.tsx:135`, `TopPostsSection.tsx:307`); today reachable via YouTube video titles → `insights_posts.title` interpolated unescaped (`attention-card-builder.ts:92`). | UI/security | S |
| A5 | **Timezone incoherence:** audience heatmap buckets in tenant tz, but Attention DOW (`attention-snapshot-builder.ts:197`), Trends series/comment buckets (`trends-snapshot-builder.ts:170-172,236-238`), and every period window (`setUTCHours(0,0,0,0)` in 7 builders) are UTC — the page can contradict its own best-time-to-post advice. Daily rows also stamped with sync-server UTC date at fetch time. Two different default-tz constants (`America/New_York` vs `America/Chicago`). No test pins any builder's bucketing tz. | data-model | M+M+S |
| A6 | **Silent goal misclassification: (A6a)** free-text `primary_goal` (4 writers, all free-form) → `normalizeGoal` keyword guess defaulting every miss to `brand_awareness` with zero signal (`goal-snapshot-builder.ts:69-83`); shipped onboarding preset "Increase social media presence" verifiably lands on the wrong goal. **(A6c)** Goal edits stale-cached up to 1h (nothing invalidates the `insights_narratives` goal row on profile save). **(A6b)** `no_goal` empty state says "Go to Settings" with no link. | product/data | M+S+XS |
| A7 | **Synthetic numbers presented as insight:** Aries Score baseline floors ~50 for a dead account; two conflicting `hoursSaved` formulas render on one dashboard; "whyItWorked" copy asserts fixed multipliers ("1.5× your typical rate") not derived from tenant data. | product | S |
| A8 | **`summary.currentFollowers` uses MAX across platforms** — understates multi-platform totals. | API | XS |
| A9 | **Hero connect-gate swallows DB errors as `not_connected`** (`narrative/handler.ts:55-57`) — an outage renders as "connect Facebook". | API | XS |
| A10 | **Intraday metric refreshes dropped:** `ON CONFLICT ... DO NOTHING` freezes the first write per day at BOTH insert sites — account dailies (`dispatcher.ts:240`, PK `(tenant_id, account_id, date)`) and per-post metrics (`dispatcher.ts:290`, PK `(tenant_id, post_id, date)`). A today-row first written mid-day is frozen at that partial value forever. | data-model | S |

### B. Dormant shipped value (ops + small code)

| # | Gap | Evidence | Effort |
|---|-----|----------|--------|
| B1 | **Comment classification OFF in prod** (`ARIES_COMMENT_CLASSIFICATION_ENABLED:-0`, `docker-compose.yml:657`). With it off: Conversations 0% positive + empty asks panel, goal `lead_generation` reads 0, attention lead counts 0, top per-post sentiment null, trends sentiment 0 — five surfaces. Code complete + tested; needs Hermes creds verified in the **worker** env, flag flip, then watch `insights_sync_runs` + one classified batch. | flags | XS (ops) |
| B2 | **Honcho performance leg dark AND un-flippable as-is:** gate `ARIES_INSIGHTS_513_TABLES_PRESENT` defaults empty, and `DUE_PERFORMANCE_POSTS_SQL` (`backend/memory/perf-insights-read.ts:54-100`) was frozen against a contract schema that mismatches the landed one on **six** axes: `external_post_id` join (landed keys on `post_id BIGINT REFERENCES insights_posts(id)` — join must go through `ip.id`), `day`→`date`, `comments`→`comments_count`, `saved`→`saves`, and `impressions`/`video_views` have no landed counterpart (drop/NULL or map `video_views`→`views`); the `honcho_perf_writes` dedup join changes with `day` too. Flipping the gate today would error every tick. | flags+code | M |
| B3 | **Whole insights pipeline dormant on default deploy:** every adapter predicate ANDs `isComposioEnabled`; compose defaults `COMPOSIO_ENABLED:-false`. Activation is host-`.env`-only with no in-repo record of prod values. Document the prod activation profile. | flags/docs | XS |
| B4 | **Native reply:** flag OFF. The reply route handler already dispatches to the shipped Composio path (selected when `effectivePublishProvider === 'composio'`; compose default is already `composio`), which needs no App Review. The `/insights` Conversations "Reply" button is an `alert()` stub — the remaining work is UI wiring, not integration. | flags+UI | M |
| B5 | **Non-Meta platform analytics** (X/YouTube/Reddit/LinkedIn) all default OFF; `/insights` filter chips offer TikTok (unsupported — dead filter) but not X/LinkedIn/Reddit. | flags+UI | S |

### C. Missing data writers (unlock dead sections)

| # | Gap | Evidence | Effort |
|---|-----|----------|--------|
| C1 | **`insights_posts.content_type` never written in production** (dispatcher INSERT omits it, `dispatcher.ts:200-222`; only demo seed stamps it) — content-mix donut reads "pending classification" for everything, goal categories all "other", Top's pattern card degraded. `init-db.js:1196-1200` comment claims propagation that doesn't exist. | sync | M |
| C2 | **`aries_post_id` has no production writer** — attribution impossible; #785 rescoped Activity/Top to all-channel counts as a workaround. **(C2a)** Stamp at Meta-publish/scheduled-dispatch time (`platform_post_id` join) + backfill, then **(C2b)** reintroduce attribution views **with** the backfill (re-adding the filter without it re-empties the sections). | publish+sync | M |
| C3 | **`reach`/`saves`/`profile_visits` columns never written** — adapter contract lacks the fields; IG adapter already fetches reach/saved but buries them in `raw_source` JSONB (`instagram/index.ts:316-322,400-410`). Five builders read these columns (product_sales goal renders 0s indistinguishable from real zeros). | sync | M |
| C4 | **"Working with Aries" dead for real tenants:** only writer of `campaign_learning_labels` is the manual creative-memory labeling tool; marketing approve/review flow never writes it; "learnings" hardcoded `[]` (`aries-builder.ts:209-213`). | marketing+insights | M |
| C5 | **No comment re-classification/backfill path:** `ON CONFLICT (comment_id) DO NOTHING` + pinned `classifier_version` freezes early/bad labels; prompt/model improvements unshippable until a re-classify path exists. | sync | M |
| C6 | **No historical backfill:** first sync captures ~30 days / single 100-post page; `backfill_completed_at` never set. New tenants start with a thin page. | sync | M |
| C7 | **Audience demographics hard stub:** `hasData:false` always (`audience-builder.ts:208-217`); `insights_audience_snapshots` is a dead table (no writer, no reader). Misleading "connect your account" copy shows even for connected tenants (fix copy now; ingestion later). | sync+UI | L (copy fix XS) |
| C8 | **Story/paid metrics absent entirely**; IG Story insights = open #513 child F. | sync | L (deferred) |

### D. Performance & scale (50-user target, guardrail #4)

| # | Gap | Evidence | Effort |
|---|-----|----------|--------|
| D1 | **9-endpoint fan-out per page load, all re-fired on every filter toggle**, no dedup/abort/lazy-load; superseded requests still execute server-side. 50 users × 9 requests vs ~40-connection budget = guardrail #1's contention scenario. | frontend+API | L |
| D2 | **`?force=true` bypasses every server cache unthrottled** from the browser (`useInsight.ts:52,77`; all 6 cached handlers) — authenticated DB-hammer path. | API | S |
| D3 | **conversations/aries/audience + all 4 read-api endpoints fully uncached**; `/dashboard/analytics` fires 3 uncached aggregates via client `Promise.all`. No `Cache-Control` anywhere. | API | M |
| D4 | **Cache-miss holds 2 pool connections** (handler client + builder client) per endpoint. | API | S |
| D5 | **Shared 1h TTL, no jitter/singleflight → top-of-the-hour stampede** across 6 sections × N users. | API | S |
| D6 | **`/insights` never load-validated:** `smoke-scale-50.mjs` tests only `/` + `/api/health/db`, cannot authenticate, and passes any status <500 — appending paths would false-pass on login redirects. Mint QA session (`scripts/qa/mint-qa-session.ts`) + assert 200s + add insights paths. | tooling | M |
| D7 | `goal-snapshot-builder` uses `Promise.all` at 4 sites against the documented sequential convention (benign today — single held client — but a refactor trap: switching to `pool.query` would create real fan-out). | backend | XS |

### E. Test coverage (read side is nearly unguarded)

| # | Gap | Evidence | Effort |
|---|-----|----------|--------|
| E1 | **No auth/tenant-isolation test for any insights GET route** — the single highest-risk untested path with multi-workspace in flight. | tests | S |
| E2 | **`read-api.ts` (365 lines, backs the 4 routes the shipped screens call) has zero behavioral tests.** | tests | M |
| E3 | **Narrative module entirely untested** (score/snapshot/template builders + route). | tests | M |
| E4 | **The only behavior tests for the 8 section endpoints self-skip in CI** (requires-infra; `tests.yml` provisions no Postgres). | CI | M |
| E5 | Dispatcher classification-leg isolation untested at dispatcher level; trends/goal/hero fixes (#782/#783) have no unit tests; no tz fixture test (see A5). | tests | S each |

### F. New operator value (build after correctness)

| # | Gap | Evidence | Effort |
|---|-----|----------|--------|
| F1 | **Weekly Results report + one approved Next Action** — entire 2026-06-01 plan unbuilt (zero code on master). Plan's degradation framing ("insights absent") is stale — rebase against as-built `backend/insights/*` before executing. | product | XL (split) |
| F2 | **Export/reporting absent entirely:** no CSV, no PDF/print-ready report, no share affordance. Data spine is ready (pure reader over shipped builders). Mind comment-PII in exports and pool-friendly streaming. | product | S–L (tiered) |
| F3 | **Canonical goal write path** (see A6): goal `<select>` writing a canonical key alongside descriptive free text (free text also feeds Hermes brand prompts — keep both fields), backfill with low-confidence flagging, cache invalidation on save. | product | M |
| F4 | **Sync-health endpoint + Slack alert** on N consecutive failed sync runs (decide how restart-abort sweeps count, or every deploy pages). Reuses `slack_notifications` dedup + per-tenant Slack config. **Note:** the sync worker has no Slack env wired and CLAUDE.md deliberately scopes Slack vars to `aries-app` — the alert must fire via an app endpoint, not from the worker (see S6-4). | observability | M+M |
| F5 | **Agency/cross-workspace rollup** — absent by design (multi-workspace plan declares it a non-goal); substrate shipped dark. Single `GROUP BY tenant_id` statements, membership-row authorization only. | product | XL (deferred until `ARIES_MULTI_WORKSPACE_ENABLED` is proven in prod) |
| F6 | **Two overlapping analytics surfaces in the nav** (`/insights` + `/dashboard/analytics`) — the consolidation decision must be ratified **before** further shell investment (it is Sprint 1 ticket S1-11, not backlog). | product decision | XS (decision) |
| F7 | **LinkedIn comments never surfaced** (open qa-defect #648) — externally capped by Composio toolkit (no list-comments action) + LinkedIn org-scoped analytics. Track upstream; document limitation on Conversations. | external | L (blocked) |
| F8 | Memory-candidate promotion route (Approve/Edit/Reject) for queued performance findings — write-only today. Pairs with B2. | product | M |

### UI polish (backlog-opportunistic)

- No responsive breakpoints — fixed two-column inline-style grids in every section (M).
- `insights.css` leaks global `body` styles app-wide after visiting `/insights` (S).
- Hardcoded/fabricated copy audit (S, overlaps A7).
- Demographics/active-times misleading empty-state copy (XS — pulled into S1-7).

---

## 4. Roadmap

Four phases; each phase's exit bar gates the next. Flag flips are ops actions, not merges.

**Phase 0 — Believe the page (Sprints 1–2).** Correct math, honest empty states and disclosures, freshness stamps, dead links, XSS, timezone read-side policy, and the classification flag flip.
*Exit bar:* the live tenant's **Facebook and Instagram** trailing-7-day totals match Meta Business Suite / Graph-native numbers within **±5%**, operator-verified and signed off; every rendered number is real or explicitly labeled; a sync failure is visible in-product within one tick.

**Phase 1 — Real data everywhere (Sprints 3–4).** Production writers for `content_type`, `aries_post_id`, reach/saves; comment re-classification path; Honcho perf leg un-darkened; tenant-isolation tests (pulled forward — security-relevant with multi-workspace in flight).
*Exit bar:* no section is seed-only; attribution queries return real rows; Honcho worker ticks clean.

**Phase 2 — New operator value (Sprints 5–6).** Weekly results MVP, reply-from-insights, Working-with-Aries wired to real events, canonical goal, sync-health alerting, CSV export.
*Exit bar:* screenshot-verified weekly report and a live reply on the prod tenant; goal configured canonically; a broken sync alerts within N ticks.

**Phase 3 — Scale & hardening (Sprints 7–8).** Load harness first, then caching/coalescing/throttling; read-side test coverage; CI Postgres job.
*Exit bar:* `/insights` passes the authenticated 50-concurrent smoke inside the connection budget; every route the shipped screens call has a CI-executing test.

Sequencing rationale (deliberate, not accidental): prod serves one tenant today, so Phase 2 (operator-visible value, including the weekly-results plan the operator has been waiting on since 2026-06-01) ships before Phase 3 (mostly customer-invisible hardening). If a new-tenant wave or multi-tenant growth is expected before Sprint 7, pull S7-1/S7-2 and backlog item 1 (historical backfill) forward.

---

## 5. Sprint plan

Assumes ~1 engineer + review support, 2-week sprints (~10 eng-days). Effort scale: **XS = 0.5d · S = 1d · M = 2.5d · L = 5d**; every sprint below is budgeted to ≤ ~10.5 tagged days and names a **designated cut-line ticket** — the one that slips first, so a squeeze never silently drops a load-bearing ticket. Every code ticket lands via the standard gate: regression test that fails before/passes after → `npm run verify` → focused gate (`test:insights` / `validate:social-content` where relevant) → review → PR. Any ticket that changes a cached builder/template's output **must bump that section's `TEMPLATE_VERSION`** (this bit #783 and #785; it is an acceptance criterion, not a reminder).

### Sprint 1 — Trust quick wins & honest UI (budget 10.0d · cut line: S1-7)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S1-1 | Fix Attention CTA `/conversations` → `/dashboard/comments` (A3) | XS | No 404 from the attention card; `TEMPLATE_VERSION` bump so the cached snapshot regenerates |
| S1-2 | Escape/sanitize the three `dangerouslySetInnerHTML` sinks; escape `insights_posts.title` at the builder (A4) | S | Injected `<img onerror>` in a YouTube title renders inert; unit test pins escaping |
| S1-3 | "Data as of" freshness stamp on `/insights` header, with stale (>2 ticks) warning state (A2b) | M | **Must be served from an uncached (or ≤60s micro-cached) path** — its own lightweight endpoint or an already-uncached read-api response — never from a `TEMPLATE_VERSION`'d narrative cache row (a 1h-cached timestamp defeats the point). Acceptance: stamp updates within one sync tick of a successful run; visibly distinguishes "sync broke" from "no engagement"; copy must not overclaim on `partial` runs (a partial run still stamps `last_sync_at`) |
| S1-4 | Hero connect-gate: surface DB errors as an error state, not `not_connected` (A9) | XS | DB outage renders retryable error, never "connect Facebook" |
| S1-5 | Goal `no_goal` empty state links to Settings; unmatched-goal fallthrough logs + renders "Goal inferred — confirm in Settings" chip (A6, interim) | S | Preset "Increase social media presence" no longer silently renders as authoritative BUILD AWARENESS; `TEMPLATE_VERSION` bump (goal section is 1h-cached) |
| S1-6 | Invalidate the goal narrative cache row on business-profile save (A6c) | S | A goal edit renders on next load, not after 1h TTL — required for the S1-5 chip's "confirm in Settings" loop to be coherent |
| S1-7 | Replace `alert()` stub CTAs with real actions, disabled-with-tooltip states, or removal; fix misleading demographics/active-times empty-state copy (C7 copy) | S | No `alert(` under `frontend/insights/`; the Conversations **Reply** button becomes disabled-with-tooltip ("Reply ships soon") — **not removed** — until S5-2 wires it; stub copy says "coming soon", not "connect your account" |
| S1-8 | `summary.currentFollowers`: SUM of per-platform latest, not MAX (A8) | XS | Multi-platform tenant shows combined total; unit test |
| S1-9 | Interim inflated-totals disclosure (A1 mitigation): label or suppress lifetime-SUM aggregates until S2-1 lands | XS | No undisclosed-wrong headline number renders during the Sprint-1→2 gap; removed by S2-1 |
| S1-10 | **Decision:** ratify surface consolidation (F6): recommend `/insights` primary, `/dashboard/analytics` becomes per-platform drill-down | XS | Written decision in this doc's changelog; unblocks all later shell investment |
| S1-11 | **Ops:** flip `ARIES_COMMENT_CLASSIFICATION_ENABLED=1` in prod — verify Hermes creds in the **worker** env first, watch `insights_sync_runs` for `partial`, verify one classified batch (B1) | XS | **Label-quality gate:** manually review the first classified batch before leaving the flag on — labels are frozen (`ON CONFLICT DO NOTHING` + pinned `classifier_version`) until the S4-3 re-classification path lands, and "flag off" does NOT roll back bad labels. The flip decision is made knowing that window |
| S1-12 | **Ops/docs:** record the prod activation profile (COMPOSIO_ENABLED, auth-config ids, Hermes creds per service) in DOCKER.md (B3) | XS | A fresh deploy can reach "data flowing" from docs alone |

### Sprint 2 — Metric correctness & timezone policy (budget 10.5d · cut line: S2-2's account-dailies half; never S2-1/S2-3/S2-5)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S2-1 | Fix lifetime-snapshot-vs-delta semantics (A1): keep storing cumulative snapshots (stamped), change every reader to latest-snapshot/window-delta math (`MAX`-per-post or last-minus-first); document the column semantics in init-db | L | A post synced 10 days reports its real lifetime views; week-over-week deltas are true deltas; regression fixture with 3 cumulative rows; readers: read-api, top, activity, goal, trends. `TEMPLATE_VERSION` bumps on every cached section touched. Acceptance includes: `/insights` and `/dashboard/analytics` render **agreeing totals** post-cutover (two nav entries disagreeing is itself a trust bug); removes the S1-9 disclosure |
| S2-2 | `DO UPDATE` upserts at **both** `DO NOTHING` sites (A10): account dailies (`dispatcher.ts:240`, conflict target `(tenant_id, account_id, date)`) and per-post metrics (`dispatcher.ts:290`, `(tenant_id, post_id, date)`) | S | Later same-day sync updates the row; test pins both upserts. The account-dailies half is safe **independently** of S2-1 (genuine dailies, not cumulative snapshots) and is the half that slips if squeezed; the per-post half lands only alongside/after S2-1 (with SUM semantics it would double-count) |
| S2-3 | Timezone read-side policy (A5): single shared tenant-tz helper; thread tz into Attention DOW extraction, Trends bucket exprs + JS bucket/label helpers, and all 7 builders' period-window starts; reconcile the two default-tz constants; decide the write-side stamping policy here (executed in backlog item 2) | M | Ship read-side changes atomically across sections so they cannot disagree mid-rollout; `TEMPLATE_VERSION` bumps |
| S2-4 | Day-boundary fixture test: post/comment at `23:30-05:00` asserts same calendar day across audience peakWindow, attention dayName, trends bucket keys (E5-tz) | S | Runs in `npm run verify` (extracted builders or mocked pool) |
| S2-5 | Unit tests pinning the S2-1/S2-3 math (trends pctDelta, goal windows, top ranking) — closes the #782/#783 no-unit-test debt (E5) | S | Deterministic fixtures, in `npm run verify`; must land with S2-1, never cut |

### Sprint 3 — Honest numbers & writers I (budget 10.0d · cut line: S3-6)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S3-1 | Honesty pass on synthetic numbers (A7): reconcile the two `hoursSaved` formulas to one, floor-correct Aries Score or label it, replace fixed-multiplier "whyItWorked" claims with tenant-derived stats or qualitative copy | S | No fabricated statistic renders; copy audit checklist in PR; `TEMPLATE_VERSION` bumps on cached sections |
| S3-2 | `content_type` production writer (C1): derive at sync/ingest from the post's known shape (surface/media_type for Aries-published; caption heuristics or the existing Hermes raw-run pattern for external posts), backfill existing rows | M | **Flag decision:** if the Hermes-LLM branch is taken, it ships behind its own default-OFF flag (`:-0`) in the **aries-insights-sync-worker** env block with the bounded-batch + `legErrors`-isolation requirements copied from classify-comments (its direct precedent); the pure-heuristic branch may land unflagged (additive column stamp). Acceptance: content-mix donut, goal categories, Top pattern card show real buckets on a live tenant |
| S3-3 | Stamp `aries_post_id` at Meta-publish/scheduled-dispatch time; backfill by `platform_post_id` join (C2) | M | Publish path writes it; backfill script; unflagged land acceptable (additive NULL-safe column stamp — state this in the PR). Do **not** reintroduce attribution-filtered views in this ticket |
| S3-4 | Rebase the 2026-06-01 weekly-results plan against as-built insights (F1a) — its "insights absent, degrade" framing is stale; best/weakest-post is now buildable from `insights_post_metrics_daily` | S | Updated plan doc; MVP slice agreed; unblocks S5-1 |
| S3-5 | **Ops-verify:** live-verify the Instagram sync legs on the prod tenant — rows land in `insights_posts` / `insights_post_metrics_daily` / `insights_comments`, one clean `insights_sync_runs` entry (closes the "code-complete but live-unverified" gap; the prod tenant publishes to both FB and IG) | XS | Required for the Phase 0 exit bar's IG half; any adapter defect found becomes a Sprint-3 fix or an explicit carry |
| S3-6 | Wire `insights_accounts.last_sync_at` into integrations cards (replace hardcoded null); update pinned-null test (A2a) | S | Single per-tenant `MAX(last_sync_at)` query folded into the card build (no `Promise.all` fan-out — guardrail #1); `tests/integrations-status.test.ts:217` updated |
| S3-7 | Attribution views prep: coverage-threshold helper (fraction of window posts with `aries_post_id`) | S | Powers S4-1's fallback; trivial to test |

### Sprint 4 — Writers II, Honcho, safety (budget 9.5d · cut line: S4-3)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S4-1 | Attribution views: re-introduce "Aries-published vs all-channel" split in Activity/Top **behind the S3-3 backfill** (C2b) | S | Sections never re-empty for tenants with unstamped history (fall back to all-channel below the S3-7 coverage threshold — the exact #785 regression, encoded); `TEMPLATE_VERSION` bumps |
| S4-2 | Ingest reach/saves/profile_visits (C3): extend the adapter contract, lift IG's already-fetched reach/saved out of `raw_source`, add FB equivalents where the Graph provides them; `NULL`-vs-0 semantics documented (silent-zero trap) | M | product_sales goal shows real saves/profile visits; builders distinguish "unavailable" from 0; unflagged land acceptable (additive columns, NULL-safe readers — state in PR). **Land before S4-4** (or its early Honcho events carry null reach/saves — decide explicitly) |
| S4-3 | Comment re-classification path (C5): `classifier_version` bump triggers bounded re-classify sweeps (reuse the one-batch-per-tick pattern); `ON CONFLICT` upgraded to a versioned upsert | M | Bumping the version re-labels old comments over subsequent ticks; frozen-label trap (open since S1-11) closed. **Schema note:** the versioned upsert changes the conflict target on `insights_comment_classifications` (currently keyed on `comment_id` alone) — two-place schema rule applies (init-db.js `ALTER`/index `IF NOT EXISTS` + migrations/) |
| S4-4 | Fix Honcho perf-leg frozen SQL against the landed schema, then **ops:** flip `ARIES_INSIGHTS_513_TABLES_PRESENT=1` and watch one tick (B2) | M | Full column map: `external_post_id`→join via `ip.id`/`post_id`, `day`→`date`, `comments`→`comments_count`, `saved`→`saves`, `impressions`→drop-or-NULL, `video_views`→`views`-or-NULL; `honcho_perf_writes` dedup join updated; **payload-contract decision** for the dropped fields recorded in the PR. Worker ticks clean; performance events ledger to Honcho; requires-infra test against live schema |
| S4-5 | Tenant-isolation + auth tests for every insights GET route (E1): unauthenticated → 401; tenant A cannot read tenant B via any handler | S | In `npm run verify`; pulled forward of Phase 3 deliberately — security-relevant with multi-workspace in flight |
| S4-6 | Wire "Working with Aries" to real events (C4): write `campaign_learning_labels` (or a successor learnings table) from the marketing approve/review flow; keep the manual creative-memory tool as an additional writer | M | Real tenant sees approval-flow bar + learning curve without manual labeling. **Two-place schema rule** if a new/changed table is introduced (init-db.js + migrations/); flag decision line in the PR (writer into an existing table from an existing human-action path — unflagged acceptable if stated) |

*Budget note: S4 lists 12.0d of tagged work (S+M+M+M+S+M = 1+2.5+2.5+2.5+1+2.5) — deliberately over-provisioned against the 9.5d budget; S4-3 is the designated cut (bringing it to the stated 9.5d; it slips to Sprint 5's cut-line slot or Sprint 6), and S4-6 is the second cut if both squeeze. Do not cut S4-4 after S4-2 has landed, and never cut S4-5.*

### Sprint 5 — Weekly results & reply (budget 10.0d · cut line: S5-2)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S5-1 | Weekly Results MVP (F1b): server-side report builder over shipped builders (summary, trends, top/weakest post, one suggested next action), `/dashboard/results` panel, flag-gated `ARIES_WEEKLY_RESULTS_ENABLED` default OFF | L | Live tenant renders a truthful week recap; depends on S2-1 (correct math) + S4-1 (attribution). **Standard flag-landing steps:** `:-0` wiring in the aries-app `environment:` block in docker-compose.yml, `.env.example` entry, CLAUDE.md env-var doc |
| S5-2 | Reply from `/insights` Conversations via the already-shipped Composio reply path behind `ARIES_NATIVE_REPLY_ENABLED` (B4): wire the disabled stub button (S1-7) to the existing endpoint | M | Reply posts on live FB tenant; claim/rollback semantics untouched; direct-Graph path kept for post-App-Review. Includes flag-flip checklist row 3 |
| S5-3 | CSV export: posts + daily account metrics (comments **excluded** in v1 — commenter PII leaves the app boundary; needs an explicit product decision), clamped/streamed queries per guardrail #1 (F2a) | S | Download from `/insights` header; bounded query; tenant-scoped; depends on S2-1 so exported numbers are true |
| S5-4 | Platform filter truthing: drop the TikTok chip, add flag-gated X/LinkedIn/Reddit chips driven by the same rollout flags as the backend (B5) | S | Chips match platforms that can actually have data |

*(S5-2 is the cut line only in the sense that a slipped S4-3 takes its slot; if both fit, nothing cuts.)*

### Sprint 6 — Goal & observability (budget 9.5d · cut line: S6-5)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S6-1 | Canonical goal write path (F3): `goal_type` column (canonical enum) alongside free-text `primary_goal` (which keeps feeding Hermes prompts); goal `<select>` in Settings/Business Profile/onboarding; **two-place schema rule** (init-db `ALTER TABLE ADD COLUMN IF NOT EXISTS` + migration) | M | Both keyword heuristics retired; onboarding presets map explicitly; free text preserved for brand context |
| S6-2 | Goal backfill with low-confidence flagging: auto-migrate clear matches, mark ambiguous rows for the S1-5 confirm chip (F3b) | S | No silent baking-in of today's misclassifications |
| S6-3 | Sync-health read endpoint over `insights_sync_runs` (per-tenant recent runs, status, error) (F4a) | M | Powers the S1-3 freshness stamp's detail view; admin-visible failure reason |
| S6-4 | Slack alert on N consecutive failed sync runs, deduped via `slack_notifications` (F4b). **Architecture (required):** the alert fires from the **app process** — the worker POSTs a sync-failure event to an `INTERNAL_API_SECRET`-authed app endpoint (or the app derives the streak from `insights_sync_runs` on a reconciler-style tick) — because the `aries-insights-sync-worker` service has **no** Slack env (`ARIES_SLACK_NOTIFICATIONS_ENABLED`, `SLACK_*`, `OAUTH_TOKEN_ENCRYPTION_KEY` are deliberately app-service-only per CLAUDE.md, and the notify path is fail-open, so a worker-side call would silently never fire) | M | Restart-abort sweeps (`aborted by worker restart`) excluded from the streak so deploys don't page. Acceptance: **live proof** — a simulated 3-failure streak posts exactly once to the tenant's channel from the deployed topology, not just a unit test |
| S6-5 | Memory-candidate promotion route (Approve/Edit/Reject) for Honcho perf findings (F8) | M | Queued findings actionable. **Dependency:** requires flag-flip checklist row 2 (S4-4) to have been live long enough to produce findings — schedule within the sprint accordingly |

### Sprint 7 — Scale & perf (budget 9.5d · cut line: S7-5)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S7-1 | **Harness first:** authenticated 50-user smoke over `/insights` + section endpoints — mint QA session (`scripts/qa/mint-qa-session.ts`), assert real 200s (fix the `<500`-is-ok check), add insights paths, wire into DOCKER.md profile validation (D6). **Capture a pre-optimization baseline run before any S7-2..S7-5 work** | M | The measurement tool exists from day 1 of the sprint; every subsequent ticket's acceptance is a re-run against the baseline |
| S7-2 | Throttle `force=true`: per-tenant/section cooldown (token bucket, 429 after burst) (D2) | S | Browser retry works; scripted hammering doesn't reach the pool |
| S7-3 | Short-TTL cache for conversations/aries/audience + read-api endpoints (60s micro-cache or `Cache-Control`), preserving conversations' reply/unread freshness expectations (D3) | M | Uncached endpoints gone; freshness semantics documented per endpoint; cap conversations TTL at 60s and exclude `is_replied` from the cached payload if reply lag is noticed |
| S7-4 | Cache TTL jitter + per-key singleflight on rebuild; fix cache-miss double-connection (release handler client before builder acquires, or pass the client through) (D4, D5) | S | One rebuild per section per expiry across concurrent users; ≤1 held connection per request |
| S7-5 | Client coalescing (D1): lazy/viewport-load below-the-fold sections, AbortController on filter toggles, request dedup in `useInsight` | M | Filter toggle fires ≤ visible sections; superseded requests aborted; smoke re-run shows the connection-budget headroom |

### Sprint 8 — Test hardening & reporting polish (budget 8.5d + stretch · cut line: S8-4)

| ID | Ticket | Effort | Notes / acceptance |
|----|--------|--------|--------------------|
| S8-1 | Behavioral tests for `read-api.ts` (4 handlers) + narrative module (E2, E3), mocked-pool where possible | M | Every route the shipped screens call has an executing test |
| S8-2 | Requires-infra CI job (E4): a **dedicated CI job** that provisions Postgres, runs init-db + `db:seed-insights`, and sets `ARIES_TEST_REQUIRES_INFRA_ENABLED` **for that job only** — the `full-suite` gate's self-skip semantics stay untouched. Ticket includes updating CLAUDE.md's "never set by CI" wording and `tests/REQUIRES_INFRA.md` to describe the new job (this deliberately amends a documented convention — the doc change is part of the ticket, not a side effect) | M | The 23 section-endpoint tests execute on PRs; `full-suite` still green; fallback if the job proves flaky: extract builders for mocked-pool coverage in `npm run verify` instead (E4's other branch) |
| S8-3 | Print-ready report view (`@media print` over a report route) as the cheap PDF path; defer true PDF generation (F2b) | M | Cmd+P produces a clean client-ready weekly report |
| S8-4 | Dispatcher-level classification/account-metrics leg-isolation tests; goal-builder `Promise.all` → sequential on the held client with a comment pinning the convention (D7, E5) | S | Convention violation closed without converting it into real fan-out |
| S8-5 | *(stretch)* Responsive breakpoints for section grids + fix `insights.css` global body-style leak | M | Page usable at 768px; visiting `/insights` no longer restyles other routes |

### Backlog (post-Sprint-8, ordered)

1. **Historical backfill** on first connect (C6, M) — biggest new-tenant first-impression win. **Placement is conditional:** if any new-tenant onboarding is expected before Sprint 8 completes, pull this into Sprint 4 (it is thematically a sync-writer ticket); the backlog placement assumes the current single-tenant reality. **Preconditions (both documented conventions):** raise `ARIES_INSIGHTS_SWEEP_GRACE_MINUTES` (or exempt backfill runs from the stranded-run sweep) before shipping any sync path that can run >1h, and design per-page/per-window progress checkpoints so a rate-limit or crash resumes instead of restarting (`backfill_completed_at` is the terminal marker, not the only state — the repo's resumability rule).
2. **Adapter write-side date stamping in tenant tz** (A5 write half, M) — read-side policy (S2-3) already renders correctly; this improves stored-row day accuracy for new rows. Executes the policy decided in S2-3; note the cutover discontinuity (upsert keys on the date) and label the cutover in trends tooltips if deltas look odd. Historical rows keep a ≤1-day skew either way.
3. **Demographics ingestion** → `insights_audience_snapshots` + Audience section rendering (C7, L) — check Graph scope needs (App Review risk).
4. **Comment fetch depth** beyond 20 posts × 100 comments × 30 days (paged) (S).
5. **IG Story insights** (#513 child F) (L) — pairs with `ARIES_VIDEO_PUBLISH_ENABLED` rollout.
6. **Shareable read-only report link** — tokenized public route with expiry/revocation (precedent: public media route); explicit tenant-data-exposure review (F2c, M).
7. **Email digest** of the weekly report via Resend (S, after S5-1).
8. **Agency/cross-workspace rollup** (F5, XL) — only after `ARIES_MULTI_WORKSPACE_ENABLED` is proven in prod; membership-row authorization, single `GROUP BY tenant_id` queries, paid-tier surface per the multi-workspace plan's Decision 13.
9. **Execute the F6 consolidation** ratified in S1-10 (converge `/dashboard/analytics` into `/insights` as per-platform drill-down) (M).
10. **LinkedIn comments** (#648) — blocked on Composio toolkit; document limitation in Conversations until then.
11. **Insights table retention/GC** — nothing deletes or aggregates any insights table today; extend the existing sweep-worker pattern once growth warrants (S–M).
12. **`insights_llm_calls` dead table** — delete or wire (XS decision).

---

## 6. Flag-flip / ops checklist (sequenced)

| Order | Action | Earliest | Precondition | Verify |
|-------|--------|----------|--------------|--------|
| 1 | `ARIES_COMMENT_CLASSIFICATION_ENABLED=1` | Sprint 1 (S1-11) | Hermes creds present in **aries-insights-sync-worker** env (empty-default trap) | `insights_sync_runs` not `partial` from the classify leg; first batch label-quality-reviewed (labels frozen until S4-3); Conversations sentiment real |
| 2 | `ARIES_INSIGHTS_513_TABLES_PRESENT=1` | Sprint 4 (S4-4) | **S4-4 SQL fix merged first** — flipping today errors every tick; S4-2 landed (or null-reach/saves accepted) | One clean perf-worker tick; Honcho events ledgered |
| 3 | `ARIES_NATIVE_REPLY_ENABLED=1` (Composio path) | Sprint 5 (S5-2) | S5-2 merged; `COMPOSIO_ENABLED=true` + `PUBLISH_PROVIDER=composio` (compose default) | One live FB + IG reply; claim/rollback exercised |
| 4 | `ARIES_WEEKLY_RESULTS_ENABLED=1` | Sprint 5 (S5-1) | S5-1 merged; Sprints 2–4 correctness landed | Screenshot-verified weekly report on live tenant |
| 5 | Per-platform `ARIES_<X|LINKEDIN|REDDIT|YOUTUBE>_ENABLED` | On demand | Flags set on the **worker** service env, not just aries-app | Adapter rows land; capability-gated columns honest |

Direct-Graph reply scopes (`instagram_manage_comments`, `pages_manage_engagement`) remain an external Meta App Review track — pursue in parallel, not a blocker (the Composio path covers v1).

---

## 7. Risks & mitigations

- **Metric-semantics cutover (S2-1/S2-2)** changes rendered numbers on the live tenant. Ship read-side change + `TEMPLATE_VERSION` bumps atomically; announce to the operator; keep a one-release revert path. Historical daily rows keep known skew — label the cutover date in the trends tooltip if deltas look discontinuous. The S1-9 disclosure covers the gap between Sprint 1 and this landing.
- **`TEMPLATE_VERSION` discipline:** cached-section fixes without a version bump look broken in prod for up to 1h (bit #783 and #785 already). Standing acceptance criterion on every ticket that touches a cached builder/template (stated in the Sprint-plan header).
- **Attribution re-scoping (S4-1):** re-adding an `aries_post_id` filter without backfill re-empties Activity/Top — the exact regression #785 fixed. The S3-7 coverage-threshold fallback is mandatory.
- **Classification enablement (S1-11):** flag ON with wrong/missing Hermes creds silently downgrades every sync to `partial`. Enable creds → flag → watch, in that order. Early labels are frozen until S4-3 — the label-quality gate on the first batch is the mitigation.
- **Caching conversations (S7-3)** trades away real-time reply/unread semantics — cap TTL at 60s and exclude `is_replied` state from the cached payload if operators notice lag.
- **Pool math (guardrail #1):** every new endpoint/report/export must be benchmarked at the endpoint level under the compose profile; no `Promise.all` over pg without checking `DB_POOL_MAX`.
- **Export PII:** comment exports carry commenter handles/text out of the tenant boundary — deliberately deferred; requires an explicit product decision.
- **Prod env drift:** activation is host-`.env`-only; S1-12's documented profile is the mitigation for un-reproducible prod behavior.
- **Sprint-budget honesty:** every sprint is budgeted against the stated effort scale with a named cut-line ticket; a slip drops the cut-line ticket, never a load-bearing one (S2-1/S2-3/S2-5, S4-4-after-S4-2, S4-5 are never-cut).

---

## 8. Explicitly out of scope

- Hermes-side workflow/skill registration (owned by the Hermes repo).
- True PDF rendering infrastructure (print-CSS covers v1).
- TikTok analytics (no adapter; chip removed in S5-4).
- Paid/ads metrics ingestion (no table; revisit with a customer driver).
- Rewriting the v1 `/dashboard/analytics` screen ahead of executing the S1-10 consolidation decision (backlog item 9).

---

## Appendix: verification & review notes

**Gap verification.** All 87 gap claims in this document survived an adversarial verification pass (independent reviewers instructed to refute each claim against the code; 71 CONFIRMED as stated, 16 confirmed with corrected scope, 0 refuted). Notable scope corrections folded in: native reply is *not* hard-blocked on Meta App Review (the Composio path is shipped and the route already dispatches to it — B4); the XSS surface is real but currently reachable only via YouTube titles/seeds (A4); the goal-builder `Promise.all` is a convention violation, not a live fan-out bug (D7).

**Plan review.** A four-lens engineering panel (technical accuracy against the code, sequencing/dependencies/estimates, product value, repo conventions) reviewed the draft; 2 blocking findings were confirmed by adversarial re-verification and are incorporated: (1) sprint budgets recounted against the stated effort scale and rebalanced from 6 overcommitted sprints to 8 budgeted ones with named cut lines; (2) the Slack sync-alert must fire from the app process, not the Slack-env-less worker (S6-4). All 15 important findings are incorporated, including: load-harness-before-optimization ordering (S7-1), weekly results pulled ahead of hardening (Phase 2 before Phase 3, with rationale), the frozen-label window disclosed at flip time (S1-11), the freshness stamp forbidden from riding a TTL-cached payload (S1-3), goal-cache invalidation pulled into Sprint 1 (S1-6), the F6 consolidation decision pulled into Sprint 1 (S1-10), Instagram live-verification added (S3-5), both `DO NOTHING` sites enumerated with correct conflict targets (S2-2), the full Honcho column map (S4-4), flag/schema-rule decision lines on every Sprint 3–4 writer ticket, the requires-infra CI job scoped to preserve full-suite semantics (S8-2), and backfill preconditions (sweep grace + resumability checkpoints, backlog item 1).
