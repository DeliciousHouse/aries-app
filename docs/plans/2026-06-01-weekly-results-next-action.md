# Weekly Results Report + one approved Next Action (with performance memory candidates)

> Status: draft plan (2026-06-01). Roadmap area **#11** ("Results → Next Action" loop), priority 6. Build #8 of the "10 best to build first". This plan builds the **weekly report UI + the learning-approval loop**. It is a *reader/presenter* over already-shipped state plus a *thin promotion route* over the already-shipped Honcho performance-insights write leg (#522). It does **not** add a new Meta fetch, does **not** publish anything, and must **degrade gracefully when post/story insights scopes are absent** (per memory: insights scopes are not granted, so real engagement numbers are frequently unavailable).

## Context

Roadmap #11 asks for an explicit loop: a **weekly report** that says, for the week's social run — posts published, posts skipped-or-blocked, top channel, best post, weakest post, *what Aries learned*, *next week's recommended adjustment* — plus **memory candidates from performance**, ending with one prompt: **"Approve this learning for future planning? [Approve memory] [Edit] [Reject]"**. Approving promotes a memory candidate that feeds the memory screen.

Three pieces of this already exist and must be **reconciled, not rebuilt**:

1. **A Results screen** at `/dashboard/results` exists but is thin. The rendered component (`frontend/aries-v1/results-screen.tsx`, 80 lines) only filters `posts.status === 'live'` and links out — there is *no* week boundary, *no* published/skipped breakdown, *no* learning, *no* next action. (A richer `results-presenter.tsx` + `view-models/results.ts` pair exists in the tree but is **not wired into the page** — the page renders `AriesResultsScreen`, not the presenter.)
2. **The Honcho performance-insights WRITE leg** is shipped default-OFF (`HONCHO_WRITE_PUBLISH_ENABLED`, `recordPerformanceEvent` at `backend/memory/write-events.ts:652` / `scheduleHermesPublishPerformanceHonchoWrite` at `:708`, #522). It writes a `research_conclusion` "market signal" finding that the curator **queues for review** (`persistQueuedFinding` → `aries_research_findings.curator_decision='queue_for_review'`).
3. **A memory-candidate store + read route** exists: `aries_research_findings` (`backend/memory/research-jobs.ts`) and `GET /api/tenant/research/review-queue` (`app/api/tenant/research/review-queue/route.ts`). But there is **no approve/edit/reject mutation route** — queued findings are write-only; nothing promotes them and no operator UI surfaces them.

So the data spine for "what Aries learned → memory candidate" is half-built (write leg in, read route in, **promotion missing**), and the report itself does not exist. This plan closes both: a real weekly report and the Approve/Edit/Reject promotion that turns a performance finding into an approved memory the planner can use.

**Hard constraint (memory: Meta insights scopes missing).** `read_insights` / `instagram_manage_insights` are **not granted**; the #513 insights tables that `recordPerformanceEvent` reads do not exist on master (`insights513TablesPresent()` returns false unless `ARIES_INSIGHTS_513_TABLES_PRESENT=1`). Therefore **best/weakest post by engagement is frequently unavailable**. The report must derive everything it can from *publish-state truth* Aries already owns (published vs skipped vs blocked, per-channel counts, failure taxonomy / reconnect signal) and clearly label engagement-ranked sections as "insights not yet connected" rather than fabricating numbers.

## Who cares

- **Operators / @sugarandleather** — closes the loop. Today the system publishes and goes quiet; there is no "here is what happened this week and what I'd change". This is the single screen that makes Aries feel like it *learns*.
- **Product** — #11 is the capstone of the weekly-content OS: research → strategy → produce → publish → **review → adjust**. Without it the product has no visible feedback loop.
- **Eng** — the Honcho perf write leg (#522) currently writes findings into a queue that *nothing reads back into planning*. This plan gives those findings a destination (approved memory) and a human gate, which is the whole point of `queue_for_review`.

## Decisions (locked — do not re-litigate)

1. **Reader/presenter + thin promotion route. No new Meta fetch, no new insights pipeline.** Engagement metrics come only from #513's tables *if/when present*; otherwise the report runs on publish-state truth. This plan never calls `graph.facebook.com`.
2. **Week boundary = the tenant's most-recent completed ISO week (Mon–Sun, UTC), with a `?week=YYYY-WW` override.** Derived server-side from `posts.published_at` / `scheduled_posts.scheduled_for`. No per-tenant cadence config in v1.
3. **"Published / skipped / blocked" is computed from state Aries owns**, not insights:
   - **Published** = `posts.published_status='published'` with a `platform_post_id`, `published_at` in the week.
   - **Skipped** = `scheduled_posts` rows that were due-but-never-dispatched in the week (`dispatch_status='pending'` past `scheduled_for`). (The synthesis `skipped` counter — video stripped while `ARIES_VIDEO_PUBLISH_ENABLED=0`, no-image-fallback — is returned by `synthesizePublishPostsFromContentPackage` but **not persisted per-reason**; v1 derives skipped from publish-state only and labels it honestly.)
   - **Blocked** = `scheduled_posts.dispatch_status='failed'` in the week. **There is no persisted per-row failure code.** The `MetaPublishFailureKind` (`backend/integrations/meta-publishing.ts:153`, `MetaPublishFailureKind`) is classified at dispatch time (`app/api/internal/publishing/scheduled-dispatch/route.ts:277`) and surfaced in the HTTP response, but **not stored** — only free-text `error_message` / `error_at` is persisted on `scheduled_posts` (and per-platform on `scheduled_post_dispatches`). The report therefore derives the **auth / "Reconnect Meta"** signal from `oauth_connections.status='reauthorization_required'` (the shipped #519 reconnect surface), and reports other blocked posts as a single `failed` count (optionally bucketed by re-classifying `error_message` text). It does **not** GROUP BY a `last_error_code` column — that column does not exist on `scheduled_posts`.
4. **Top channel = the channel with the most *published* posts this week** (a count, not an engagement rank) when insights are absent; if `ARIES_INSIGHTS_513_TABLES_PRESENT=1` it upgrades to "most reach". Always labeled with which basis it used.
5. **Best/weakest post is insights-gated and fails soft.** With insights absent, the report shows a neutral "Engagement ranking is not available yet — connect post insights to rank posts" panel, NOT a guessed winner. With insights present (post-#513), rank by the same metric the perf payload already carries (reach, then engagement sum).
6. **The "learning" + "next-week adjustment" is the memory candidate.** The report surfaces the queued `aries_research_findings` rows for the week (curator `queue_for_review`, market-signal peer) AND a deterministic publish-reliability learning Aries derives itself (e.g. "2 Instagram posts blocked on auth — reconnect before next week's run"). Each is one approve-able candidate.
7. **Promotion is approval-gated and human-only (CLAUDE.md + guardrails).** Approve calls a new `POST /api/memory/findings/[findingId]/resolve` with `{ action: 'approve' | 'edit' | 'reject', editedClaim? }`. Approve writes the finding to Honcho as an **approved** memory (via the existing `appendHonchoApproved` path) and flips the finding's `curator_decision`; Edit approves an operator-edited claim; Reject marks it dropped. **AI never auto-approves its own learning.** No autonomous publish is involved anywhere.
8. **Flag `ARIES_WEEKLY_RESULTS_ENABLED`** (default OFF) gates the whole surface — the report tab/panel and the promotion route. OFF ⇒ `/dashboard/results` renders exactly today's screen; the route returns 404-equivalent `{ enabled:false }`. It is a rollout switch over a multi-PR feature, not the feature.

## Current State (VERIFIED — branch `fix/story-composer-serving` @ image-stories-live worktree)

**Results UI:**
- `app/dashboard/results/page.tsx` renders `AriesResultsScreen` inside `AppShellLayout currentRouteId="results"`.
- `frontend/aries-v1/results-screen.tsx` — uses `useRuntimePosts({ autoLoad:true })`, filters `status==='live'`, renders cards linking to `/dashboard/social-content/{id}`. No week, no breakdown, no learning, no next action.
- `frontend/aries-v1/view-models/results.ts` + `presenters/results-presenter.tsx` — a richer status-mix/portfolio presentation exists but is **dead** (not imported by the page). Reusable as scaffolding; not the report.
- `app/results/page.tsx` is a `redirect('/dashboard/results')` shim.
- Route registered in `frontend/app-shell/routes.ts` (`id:'results'`, `href:'/dashboard/results'`, line 94 description already says "recommended next actions" — copy is ahead of implementation).

**Data sources Aries already owns (no insights needed):**
- `posts` (`scripts/init-db.js`, table created ~`:396`, columns backfilled through `:442` and again at `:603`): `published_status IN ('draft'…'published','failed','rolled_back','unverified')` (`:420`), `platform_post_id` (`:405`), `published_at` (`:408`), `surface` (`feed|story|reel`, `:440`), `media_type`, `platform` (added `:603`), `job_id`, `tenant_id INTEGER` (FK organizations.id). **Note the tenant_id type:** `posts.tenant_id` is INTEGER; the research-findings tables key on TEXT `tenant_id` — the builder must coerce (`String(tenantId)`) when calling the findings reader, exactly as the existing write path does.
- `scheduled_posts` (`scripts/init-db.js`, created `:462`, columns backfilled `:511-524` and `:619-624`): `dispatch_status IN ('pending','in_flight','dispatched','failed')` (`:619`), `dispatched_at`/`error_at`/`error_message` (`:622-624`), `surface`, `media_type`, `scheduled_for`. **There is NO `last_error_code` / `last_error_message` column on `scheduled_posts`** — those names exist only on `oauth_connections` (`:73-74`). Per-platform outcomes live in `scheduled_post_dispatches` (status + `error_message` + `error_at`, `:637`).
- `oauth_connections.status` (`scripts/init-db.js:67`) ∈ `('pending','connected','reauthorization_required','disconnected','error')` — `'reauthorization_required'` is the **reconnect / auth-blocked signal** (#519, `backend/integrations/reconnect.ts`). This is the report's source for "Reconnect Meta", not any per-post code.
- `backend/marketing/synthesize-publish-posts.ts` returns `{ inserted, skipped, total, approvalRecordReady, reason }` — the **skipped** counter (video stripped, no-image-fallback, etc.) is the "skipped" source of truth at synthesis time but is **not persisted per-reason** (do not retrofit storage here).
- `backend/integrations/meta-publishing.ts:153` — `MetaPublishFailureKind = 'transient'|'permanent'|'auth'|'outcome_unknown'` + `classifyMetaPublishFailureKind` (`:162`). Classified at dispatch time and returned in the dispatch response, **not stored** as a column.
- `backend/social-content/dashboard-projection.ts` — existing status normalization (`live`/`scheduled`/`published_to_meta_paused`, `:495-496`) + per-status counts (`:984-986`).
- `backend/marketing/runtime-views.ts` — `listSocialContentJobsForTenant` (the list the Results screen already consumes via `app/api/social-content/posts/route.ts`).

**Honcho performance write leg (#522, default OFF) — the learning source:**
- `backend/memory/write-events.ts:652-706` — `recordPerformanceEvent`; `:708` — `scheduleHermesPublishPerformanceHonchoWrite`. Self-gates on `isHonchoEnabled() && isHonchoWritePublishEnabled()` (`backend/memory/honcho-env.ts`, `HONCHO_WRITE_PUBLISH_ENABLED`). On a verifiable https `source_url` (`:675` guard), curates a `research_conclusion` market-signal finding whose `claim` is a **stringified JSON** `{event:'publish_stage_performance', research_job_id, provider, metrics, source_url}` (`:683-689`); `queue_for_review` ⇒ `persistQueuedFinding` (`:701`).
- `recordPerformanceEvent` **requires a verifiable https `source_url`** and a valid topic pseudonym — with insights absent there is usually no source_url, so **today this write leg rarely fires**. The report must therefore not depend on it being populated; it surfaces whatever findings exist plus its own derived publish-reliability learning.

**Memory candidate store + read route (the destination):**
- `backend/memory/research-jobs.ts` — `aries_research_findings (id, job_id, raw JSONB, curator_decision TEXT, peer, approved_message_id, created_at)`; `aries_research_jobs (… tenant_id TEXT …)`. The stored `raw` shape is `{ kind, claim, sources, confidence, uncertainty, peerHint, metadata }` (`candidateToRaw`, `write-events.ts:101`) — **the perf `event` discriminator lives inside the stringified `raw.claim`, not at top-level `raw.event`.** `listQueuedResearchFindingsForTenant(tenantId,{limit})` returns `curator_decision='queue_for_review'` rows (`:246`) joined to the job for tenant scoping. `ensureMarketingMemoryQueueJob` shows the synthetic-job-for-memory-candidate pattern.
- `app/api/tenant/research/review-queue/route.ts` — `GET`, `tenant_admin` only (`getTenantContext()` → role gate → 403), returns `{ items }`. **No POST / mutation. No approve. No reject.** This is the gap.
- `appendHonchoApproved` (`write-events.ts:124`, called by `recordScheduleEvent`/auto-approve paths at `:607`) is the existing "write an approved memory to Honcho" primitive to reuse for promotion. **It is not a one-arg call:** its signature is `{ ctx, client: TenantMemoryClient, peer: PeerRef, session: SessionRef, message: ApprovedMessage }`. The promotion route must construct a `TenantMemoryClient`, derive the `PeerRef` (market-signal / brand) + a `SessionRef`, and rebuild an `ApprovedMessage` from the stored finding's parsed claim. Budget for this reconstruction in phase E.

**Insights gate (graceful degradation contract):**
- `backend/memory/insights-513-contract.ts` — `insights513TablesPresent()` is `false` unless `ARIES_INSIGHTS_513_TABLES_PRESENT=1` (`:99-103`). `backend/memory/perf-insights-read.ts` short-circuits `selectDuePerformancePosts` to `[]` while false (`:134-137`). `perf-insights-payload.ts` defines the metric shape (`reach, impressions, likes, comments, shares, saves, video_views`; #513 column `saved` maps to payload `saves`) the report would use *if* present.

**Approval route precedent (the promotion handler shape):**
- `app/api/social-content/jobs/[jobId]/approve/route.ts` → `handleApproveMarketingJob(...)` — the existing pattern for an approval POST that resolves tenant context and mutates state. The memory-promotion route mirrors this shape (tenant context → validate → mutate → typed safe response). Tenant resolution reuses `loadTenantContextOrResponse` (`lib/tenant-context-http.ts`) or `getTenantContext()` (`lib/tenant-context.ts`), as the existing routes do.

## Architecture (target data flow)

```
posts + scheduled_posts + oauth_connections (publish-state truth Aries owns)
   │  (most-recent completed ISO week, ?week override)
   ▼
backend/marketing/weekly-results-report.ts        ← NEW (pure builder, no Meta)
   ├─ publishedCount / skippedCount / blockedCount   (posts + scheduled_posts.dispatch_status)
   ├─ reconnectNeeded = oauth_connections.status='reauthorization_required'   (the auth signal; #519)
   ├─ topChannel = max published-per-channel  (or max reach if insights present)
   ├─ best/weakest post:  insights present? rank by reach : { available:false, reason:'insights_not_connected' }
   ├─ learnings[]:  derived publish-reliability learning(s)  +  queued perf findings for the week
   └─ nextAction:   the single highest-priority adjustment (e.g. "Reconnect Instagram before next run")
   │
   ▼
app/api/dashboard/weekly-results/route.ts          ← NEW (GET, tenant-scoped, flag-gated)
   │  { enabled, week, published, skipped, blocked, topChannel, bestPost, weakestPost, learnings[], nextAction }
   ▼
frontend/aries-v1/weekly-results-report.tsx        ← NEW (panel; rendered above the existing roster)
   ├─ "This week" summary row  (published / skipped / blocked-with-reconnect-CTA)
   ├─ "What Aries learned"  +  "Recommended next week"
   └─ each learning card:  [Approve memory] [Edit] [Reject]
        │  Approve/Edit  → POST /api/memory/findings/[id]/resolve { action, editedClaim? }
        ▼
app/api/memory/findings/[findingId]/resolve/route.ts   ← NEW (POST, tenant_admin, human-only)
   ├─ approve → appendHonchoApproved({ctx,client,peer,session,message}) + UPDATE aries_research_findings SET curator_decision='approved'
   ├─ edit    → approve operator-edited claim (same write, edited message)
   └─ reject  → UPDATE … curator_decision='dropped'
        │
        ▼
   feeds the memory screen (creative-memory / future memory transparency surface)
```

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Report builder: pure `weekly-results-report.ts` over posts/scheduled_posts + oauth_connections reconnect signal + synthesis-free skipped (insights-gated best/weakest) | Critical | 4h / 1.5h | none |
| B | Read API: `GET /api/dashboard/weekly-results` (flag-gated, tenant-scoped) + client hook | High | 2h / 45m | A |
| C | Report UI panel on `/dashboard/results` (published/skipped/blocked + top channel + best/weakest + learned + next action) | High | 5h / 2h | B |
| D | Memory-candidate surfacing in the report (queued findings for the week + derived publish-reliability learning) | High | 3h / 1h | A, C |
| E | Promotion route `POST /api/memory/findings/[id]/resolve` (Approve/Edit/Reject) + wire the report buttons; verify it shows on the memory screen | High | 4h / 1.5h | D |
| F | Flag `ARIES_WEEKLY_RESULTS_ENABLED`, docs, live verify on @sugarandleather, ship | Medium | 3h / 1h | C, E |

**Sequencing:** A first (everything reads its output). B/C are the visible report. D/E are the learning loop (D surfaces candidates, E promotes them). F gates + ships. C can land behind the flag before D/E so the report is reviewable while the promotion loop is finished.

```
A ─> B ─> C ──┬─> D ─> E ─> F
              └────────────┘
```

---

### A — Weekly report builder (Critical, 4h)

**New file `backend/marketing/weekly-results-report.ts`** — a pure async builder (single tenant-scoped query bundle, no Meta, no `pool.connect` held across work — guardrail #1). Exports `buildWeeklyResultsReport(tenantId, opts?: { weekIso?: string }, client?): Promise<WeeklyResultsReport>`. The builder accepts the numeric `posts.tenant_id` and coerces (`String(tenantId)`) when it reaches the TEXT-keyed findings tables (phase D).

`WeeklyResultsReport` shape (the contract the route returns):
```ts
interface WeeklyResultsReport {
  week: { iso: string; startYmd: string; endYmd: string; label: string };
  published: { total: number; byChannel: Record<string, number>; bySurface: Record<string,number> };
  skipped:   { total: number; reasons: Array<{ reason: string; count: number }> };
  blocked:   { total: number; failedCount: number; reconnect: boolean; reconnectChannels: string[] };
  topChannel: { channel: string | null; basis: 'published_count' | 'reach'; value: number };
  bestPost:   { available: boolean; reason?: 'insights_not_connected'; postId?: string; metric?: string };
  weakestPost:{ available: boolean; reason?: 'insights_not_connected'; postId?: string; metric?: string };
  insightsConnected: boolean;
}
```

Implementation notes:
1. **Week boundary** — compute most-recent *completed* Mon–Sun ISO week in UTC; accept `weekIso` override. Pure date math (no library).
2. **Published** — `SELECT platform, surface, count(*) FROM posts WHERE tenant_id=$1 AND published_status='published' AND platform_post_id IS NOT NULL AND published_at >= $2 AND published_at < $3 GROUP BY platform, surface`.
3. **Skipped** — derive from publish-state only: `scheduled_posts` rows in-week that are still `dispatch_status='pending'` past their `scheduled_for` (due-but-not-dispatched). Label the bucket honestly. The synthesis-time `skipped` counter is **not** persisted per-reason and is out of scope (do not retrofit storage).
4. **Blocked** — `SELECT count(*) FROM scheduled_posts WHERE tenant_id=$1 AND dispatch_status='failed' AND scheduled_for IN week` ⇒ `blocked.failedCount`. **Do not** GROUP BY `last_error_code` — that column does not exist on `scheduled_posts`. The auth / reconnect determination comes from a *separate* read: `SELECT provider, status FROM oauth_connections WHERE tenant_id=$1 AND status='reauthorization_required'` ⇒ `reconnect=true` + `reconnectChannels`. (Optionally, a coarse text bucket can be derived by re-running `classifyMetaPublishFailureKind` over the stored `error_message`, but v1 only needs `failedCount` + the oauth-driven reconnect flag.)
5. **Top channel** — `insights513TablesPresent()` ? max-reach (from #513 read model, reuse `selectDuePerformancePosts` shape) : max published count. Always set `basis`.
6. **Best/weakest** — gated on `insightsConnected = insights513TablesPresent()`. False ⇒ `{ available:false, reason:'insights_not_connected' }` (NEVER guess). True ⇒ rank by reach using the existing perf read model.

**Acceptance:** unit table — a fixture of in-week posts (3 published IG, 2 published FB, 1 failed IG `scheduled_post`, 1 due-undispatched FB, + an IG `oauth_connections` row at `reauthorization_required`) yields `published.total=5`, `byChannel={instagram:3,facebook:2}`, `blocked={failedCount:1, reconnect:true, reconnectChannels:['instagram']}`, `skipped.total≥1`, `topChannel={channel:'instagram',basis:'published_count',value:3}`, `bestPost.available=false reason:'insights_not_connected'`. With `ARIES_INSIGHTS_513_TABLES_PRESENT=1` + a metrics fixture, `bestPost.available=true` and ranks by reach.

### B — Read API + hook (High, 2h)

1. **New `app/api/dashboard/weekly-results/route.ts`** — `GET`. Resolve tenant via `loadTenantContextOrResponse` / `getTenantContext()` (mirror `app/api/social-content/posts/route.ts`). If `ARIES_WEEKLY_RESULTS_ENABLED` is off, return `{ enabled:false }` (200). Else `buildWeeklyResultsReport(tenantId, { weekIso: searchParams.week })` and return `{ enabled:true, report, learnings:[] }` (learnings filled in D). Tenant-scoped, parameterized, single query bundle (guardrail #1 — no `Promise.all` fan-out across pool-backed calls; sequential or one combined query).
2. **New hook** `hooks/use-weekly-results.ts` (mirror `hooks/use-runtime-social-content.ts`'s fetch/loading/error pattern) returning `{ data, isLoading, error, reload }`.

**Acceptance:** with flag OFF the route returns `{enabled:false}`; with flag ON it returns the built report for the signed-in tenant; an unauthenticated request 403s; `?week=2026-21` selects that week. Response carries no raw rows / file paths (route boundary guardrail).

### C — Report UI panel (High, 5h)

**New `frontend/aries-v1/weekly-results-report.tsx`** — a panel rendered **above** the existing roster on `/dashboard/results`. Reuse the existing shell primitives (`ShellPanel`, `StatusChip`, `EmptyStatePanel` from `frontend/aries-v1/components`) — do **not** introduce a new design language (brand redesign is roadmap #5, out of scope).

Sections (rendered UI = the success bar):
1. **"This week" header** — week label + a one-line summary ("8 published · 1 skipped · 2 blocked").
2. **Published / Skipped / Blocked** — three counts; the Blocked card, when `blocked.reconnect`, shows an amber **"Reconnect Meta"** link to `/dashboard/settings/channel-integrations` (reuse the shipped reconnect surface; do not build a new one).
3. **Top channel** — channel + basis label ("by posts published" / "by reach").
4. **Best post / Weakest post** — when `available:false`, a neutral panel: "Engagement ranking isn't available yet — connect post insights to rank posts." (No fabricated winner — memory: insights scopes missing.)
5. **What Aries learned** + **Recommended next week** — filled by D.

Wire into `app/dashboard/results/page.tsx`: render `<WeeklyResultsReport />` above `<AriesResultsScreen />` **only when the hook reports `enabled:true`**; otherwise render today's screen unchanged. (Flag OFF ⇒ visually identical to today.)

**Acceptance (USER-VISIBLE SUCCESS BAR):** with the flag ON, an operator opening `/dashboard/results` for @sugarandleather sees a rendered weekly panel with real published/skipped/blocked counts from this tenant's posts, the top channel, and — because insights are not connected — an explicit "insights not connected" best/weakest panel (not a guessed number). With flag OFF the screen is byte-identical to today. (Per memory: only rendered UI in the dashboard counts — DB/route/state do not.)

### D — Memory-candidate surfacing in the report (High, 3h)

1. **Surface queued perf findings for the week.** Extend the route (B) to also load this week's `queue_for_review` market-signal findings via `listQueuedResearchFindingsForTenant(String(tenantId),{limit})` (existing), filtered to perf findings: parse each row's stringified `raw.claim` and keep those whose `JSON.parse(raw.claim).event === 'publish_stage_performance'` and whose payload day falls in-week. (There is **no** top-level `raw.event` — the discriminator is inside the stringified `claim`.) Map each to a `learning` card `{ findingId, claim, source:'performance', confidence }`.
2. **Derive a publish-reliability learning (always available, insights-free).** In the builder (A) emit a deterministic learning when the week's `blocked.reconnect` is true ("N Instagram posts were blocked because the Meta connection needs reauthorizing — reconnect before next week's run") or when `skipped.total>0` for a stripped surface ("Video posts were skipped because video publishing is off"). This is a *report-derived* learning, not a Honcho finding — it carries `findingId:null` and is **informational** (its "next action" is operational, e.g. reconnect), not promotable to memory unless an operator explicitly approves a paraphrase.
3. **Pick the single `nextAction`** — highest-priority adjustment: reconnect (if `blocked.reconnect`) > a queued perf finding's recommendation > "keep current cadence". Render it as the one bolded recommendation.

**Acceptance:** when a tenant has an `oauth_connections` row at `reauthorization_required` and a failed dispatch this week, the report renders a "Recommended next week: Reconnect Instagram…" card with a reconnect link; when a queued perf finding exists, it renders as an approve-able learning card with its claim + source; with neither, the panel shows a calm "No adjustments recommended this week" state.

### E — Promotion route: Approve / Edit / Reject (High, 4h)

**New `app/api/memory/findings/[findingId]/resolve/route.ts`** — `POST`, `tenant_admin` only (mirror `app/api/tenant/research/review-queue/route.ts`'s tenant-admin gate and `app/api/social-content/jobs/[jobId]/approve/route.ts`'s handler shape). Human-only; no AI caller.

Body: `{ action: 'approve' | 'edit' | 'reject', editedClaim?: string }`.

1. Load the finding tenant-scoped (`aries_research_findings` JOIN `aries_research_jobs` on `tenant_id` — never trust client tenant; coerce the session tenant id to TEXT to match `aries_research_jobs.tenant_id`). 404 if not found / not this tenant. Reject if `curator_decision` is already terminal (`approved`/`dropped`) — idempotent (return current state, no double-write).
2. **approve** — write the finding to Honcho as an **approved** memory via `appendHonchoApproved({ ctx, client, peer, session, message })` (the same path auto-approve uses at `write-events.ts:607`). This is **not** a one-arg call: construct a `TenantMemoryClient`, derive a `PeerRef` (market-signal/brand) + `SessionRef`, and rebuild the `ApprovedMessage` from the finding's parsed `raw.claim`. Then `UPDATE aries_research_findings SET curator_decision='approved', approved_message_id=$msgId`. Self-gates on `isHonchoEnabled()` — if Honcho is off, still flip the local decision and record that promotion is pending (no crash).
3. **edit** — same as approve but the persisted/Honcho message uses `editedClaim` (validated: non-empty, length-capped, run through the same label scrubbing the write path uses). The original `raw` is preserved for provenance.
4. **reject** — `UPDATE … curator_decision='dropped'`. No Honcho write.
5. Return `{ findingId, status }` — typed, no raw rows.

Wire the report's `[Approve memory] [Edit] [Reject]` buttons (C/D) to this route; Edit opens an inline textarea pre-filled with the claim. On success, optimistically flip the card to "Approved / Rejected" and `reload()` the hook.

**Resumability / idempotency:** the `claimIdempotencyKey` pattern already guards the *write* leg; the promotion is guarded by the terminal-state check (re-approving an `approved` finding is a no-op). A Honcho write failure after the local flip leaves the finding `approved` with `approved_message_id=null` — a retry re-attempts the Honcho append without duplicating (idempotent on the deterministic message key).

**Acceptance (USER-VISIBLE):** an operator clicks **Approve memory** on a learning card; the card flips to "Approved for future planning"; the finding's `curator_decision` becomes `approved`; and the approved fact is visible on the memory surface (today: `app/api/tenant/research/review-queue` no longer lists it because it's no longer `queue_for_review`; the approved memory appears in the memory transparency view). Reject removes it from the queue. Edit promotes the operator's wording. **No publish happens.**

### F — Flag + docs + live verify + ship (Medium, 3h)

1. **`ARIES_WEEKLY_RESULTS_ENABLED`** (default OFF). Add to `.env.example`, `docker-compose.yml` (`${ARIES_WEEKLY_RESULTS_ENABLED:-0}`), and a CLAUDE.md "Environment Variables" entry in the house style:
   > `ARIES_WEEKLY_RESULTS_ENABLED=1` — enables the weekly results report panel on `/dashboard/results` and the memory-promotion route (`POST /api/memory/findings/[id]/resolve`). Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, `/dashboard/results` renders the legacy live-posts screen unchanged and the weekly-results + promotion routes return `{enabled:false}` / 404. The report reads only publish-state Aries already owns (posts/scheduled_posts publish status, `oauth_connections` reconnect signal); engagement-ranked best/weakest sections degrade to "insights not connected" until post/story insights scopes are granted and `ARIES_INSIGHTS_513_TABLES_PRESENT=1`. Approve/Edit/Reject promotes a queued performance finding to approved memory (human-only; never auto-approved). No publishing occurs.
2. **Live verify on @sugarandleather** (treat-as-production): flip the flag ON for the prod tenant, open `/dashboard/results`, confirm the rendered panel shows real this-week counts and the insights-absent best/weakest panel; approve one derived/queued learning and confirm it leaves the review queue and appears as approved memory.
3. `npm run verify` then `npm run test:concurrent` (touches a new route + backend + a memory mutation), allowlist new test files in `scripts/verify-regression-suite.mjs`, then `/ship-triage-deploy`; bump `VERSION` (minor — new route + flag + builder) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ `/dashboard/results` byte-identical to today, promotion route inert; flag ON ⇒ report + Approve/Edit/Reject all render and function on the live tenant; `full-suite` gate green.

## Testing Plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit | `buildWeeklyResultsReport`: week boundary math (most-recent completed week, `?week` override, UTC) | +3 |
| Unit | published/skipped/blocked counts from a posts+scheduled_posts fixture; `byChannel`; `blocked.failedCount` | +4 |
| Unit | reconnect signal derived from an `oauth_connections.status='reauthorization_required'` fixture (NOT from a per-post code) | +1 |
| Unit | `topChannel` basis switch (published_count vs reach when `ARIES_INSIGHTS_513_TABLES_PRESENT=1`) | +2 |
| Unit | best/weakest **insights-gated**: absent ⇒ `{available:false,reason:'insights_not_connected'}` (no guess); present ⇒ ranks by reach | +3 |
| Unit | derived publish-reliability learning: reconnect-needed ⇒ reconnect next action; video-skipped ⇒ skip learning; none ⇒ calm state | +3 |
| Unit | perf-finding filter parses stringified `raw.claim` and matches `event==='publish_stage_performance'` (not top-level `raw.event`) | +1 |
| Integration | `GET /api/dashboard/weekly-results`: flag OFF ⇒ `{enabled:false}`; ON ⇒ report; unauth ⇒ 403; `?week=` selects week | +4 |
| Integration | `POST /api/memory/findings/[id]/resolve`: approve flips `curator_decision` + Honcho append; edit uses editedClaim; reject ⇒ dropped; cross-tenant finding ⇒ 404; double-approve ⇒ idempotent no-op | +5 |
| Integration | flag-gated promotion route is inert (404/disabled) when `ARIES_WEEKLY_RESULTS_ENABLED` off | +1 |
| Live-DB | weekly report built against a real tenant's posts (precedent: `tests/marketing/ingest-production-assets-live-db.test.ts`, DB-gated `t.skip`) | +1 |
| E2E (live, manual) | @sugarandleather: render report, approve one learning, confirm it appears as approved memory | manual |

**~28 automated + 1 manual.** New test files: `tests/weekly-results-report.test.ts`, `tests/weekly-results-route.test.ts`, `tests/memory-finding-resolve-route.test.ts`. All set `APP_BASE_URL=https://aries.example.com`. Allowlist in `scripts/verify-regression-suite.mjs`. Run `npm run verify` then `npm run test:concurrent` before ship (routes + backend + memory mutation).

## Rollback

- **Flag:** `ARIES_WEEKLY_RESULTS_ENABLED=0` — instant kill switch. `/dashboard/results` reverts to today's screen; both new routes return disabled. No data path is touched when off.
- **No schema migration.** This plan adds *no* columns — it reads existing `posts`/`scheduled_posts`/`oauth_connections` and writes only to the existing `aries_research_findings.curator_decision` (an in-place status flip, reversible: a rejected/approved finding can be set back to `queue_for_review` by SQL if needed). If a migration is later wanted to persist per-reason skips or a per-dispatch failure code, that is a separate, additive, idempotent change — explicitly out of scope here.
- **Promotion mistake:** an over-eager Approve writes one approved Honcho memory; supersede/delete it via the memory surface (or `UPDATE aries_research_findings SET curator_decision='dropped'`). No publish, no external side effect.

## Out of Scope

- **Any new Meta insights fetch / new OAuth scope.** Engagement metrics come only from #513's tables when present; this plan never calls Graph. (Scopes-missing is a separate blocker per memory.)
- **The #513 insights pipeline itself** (`backend/insights/*`, `honcho-performance-insights.md`) — this plan *reads* its tables behind the existing gate; it does not implement them.
- **Persisting a per-dispatch failure code** (`last_error_code`) on `scheduled_posts` — today only `error_message` (free text) + `dispatch_status` are stored; the report works off `dispatch_status='failed'` + the `oauth_connections` reconnect signal. Adding a structured failure-code column is a separate, additive change.
- **A full memory transparency screen** (roadmap #4) — promotion *feeds* the memory surface; building the museum/supersession/redaction UI is its own plan. This plan only adds the Approve/Edit/Reject promotion + surfaces the result.
- **Brand redesign** (#5) — the report reuses existing shell primitives; no new palette/type.
- **Per-tenant cadence config, multi-week trends, email/digest delivery, PDF export.**
- **Persisting per-reason synthesis skip records** — the synthesis `skipped` counter is consumed live; retrofitting per-reason storage is a separate change.
- **Autonomous promotion / AI self-approval** — every memory promotion is a human click (guardrail).
- **Wiring the dead `results-presenter.tsx`** into the page — it is reusable scaffolding, but replacing the rendered screen wholesale is not required; the report is an additive panel.

## Risks

1. **Insights absence makes the report feel thin.** Mitigation: lead with the publish-reliability story (published/skipped/blocked + reconnect CTA) which is *fully available without insights* and is genuinely useful; label best/weakest honestly as "not connected" rather than guessing. This is also the highest-trust framing ("Aries is safety-first — it won't fabricate numbers").
2. **The Honcho perf write leg rarely fires today** (needs an https source_url it usually lacks). Mitigation: the report's primary learning is the *derived* publish-reliability learning, not the queued finding; queued findings are surfaced when present but are not load-bearing. (Per memory "trace actual wire bytes": verify against the live `aries_research_findings` table how many perf findings actually exist before assuming the queue is populated — and remember the perf discriminator is inside the stringified `raw.claim`, not `raw.event`.)
3. **No persisted failure-kind code on `scheduled_posts`.** Mitigation: the builder does NOT GROUP BY a `last_error_code` column (it does not exist). It counts `dispatch_status='failed'` and reads the auth/reconnect signal from `oauth_connections.status='reauthorization_required'` (the #519 surface). A finer text-bucket via re-classifying `error_message` is optional and out of v1.
4. **Widening `curator_decision` values** (`queue_for_review` → `approved`/`dropped`). Per CLAUDE.md memory "widening union → grep inequalities": grep every `curator_decision === 'queue_for_review'` / `!== 'queue_for_review'` (notably `listQueuedResearchFindingsForTenant`'s WHERE clause at `research-jobs.ts:246` and any presenter) after adding the new terminal values; literal-inequality checks won't be caught by TS.
5. **Promotion route is a new mutation with a tenant boundary.** Mitigation: tenant-admin gate + load-finding-tenant-scoped (never trust client tenant; coerce session tenant id to TEXT for the `aries_research_jobs.tenant_id` join) + idempotent terminal-state guard, all covered by the cross-tenant + double-approve tests.
6. **`appendHonchoApproved` is not a trivial call.** Its signature is `{ ctx, client: TenantMemoryClient, peer: PeerRef, session: SessionRef, message: ApprovedMessage }`. Mitigation: phase E budgets for constructing the client + deriving peer/session + rebuilding the message from the parsed finding claim; reuse the exact construction the auto-approve path uses at `write-events.ts:607`.
7. **`/dashboard/results` is on the slow list-hydration path** (the posts fetch can take 10–40s per existing comments). Mitigation: the new report uses its own focused query bundle (not the full job hydration) and renders independently of the roster — render the report header immediately, don't block it on the roster fetch (guardrail #1: do not add `Promise.all` fan-out across pool-backed calls).
8. **Pre-existing brand-URL footgun:** any copy/example in the report or learnings must use `aries.sugarandleather.com`, never bare `sugarandleather.com`.

## Related

- #522 — Honcho performance-insights WRITE leg (`backend/memory/write-events.ts:652-748`). This plan gives its queued findings a human promotion gate + a destination. Reconciled, not re-planned.
- `docs/plans/2026-05-30-honcho-performance-insights.md` — the READ-side worker (#513-gated). This plan consumes its read model behind the same `insights513TablesPresent()` gate; disjoint from its implementation.
- `docs/plans/2026-05-30-publishing-reliability.md` (#519) — the failure taxonomy + `oauth_connections` reconnect signal the "blocked" section reuses (the report derives reconnect from `oauth_connections.status`, not a per-post code).
- `docs/plans/2026-05-30-story-reel-video-publishing.md` (#520) — the `surface`/`media_type` axes the published breakdown reads; shipped, treated as read-only here.
- Memory: "Meta insights scopes missing" (best/weakest degrade gracefully); "User-visible completion = only PASS" (rendered `/dashboard/results` panel is the bar); "Honcho writes already live" (auth-off local Honcho means `appendHonchoApproved` lands unauthenticated — no JWT change needed); "trace actual wire bytes" (perf event lives in stringified `raw.claim`; `scheduled_posts` has no `last_error_code`).
- CLAUDE.md guardrails honored: default-OFF flag, no autonomous publish, treat-as-production live verify, tenant-scoping via `getTenantContext()`, pool fan-out #1 (focused query, no held client), Turbopack (no build changes).
