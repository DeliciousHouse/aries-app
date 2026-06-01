# Launch Readiness — readiness % + Ready/Blocked checklist

> Status: draft plan (2026-06-01). Medium. Roadmap area #10; one of the "10 best to build first" (#3). This is a **read-only, presentation-layer** product surface: it scores launch readiness across onboarding / integrations / review / scheduling / publishing / results and renders a unified **Ready / Blocked** checklist with a single headline **%**. It computes from data the dashboard **already hydrates** — it adds **no** new publish behavior, no autonomous action, and no new write path.

## Context

Today "readiness" is three buried rows. `frontend/aries-v1/view-models/dashboard-home.ts:32-37` declares a `readiness: Array<{ label; value; detail; tone }>` and `:368-400` computes exactly three entries — `Profile`, `Channels`, `Approvals`. The presenter renders them under "Operational Readiness → What Aries is watching closely" (`frontend/aries-v1/presenters/dashboard-home-presenter.tsx:464-500`). There is **no percentage**, no unified checklist, and the signal stops at three coarse dimensions. An operator cannot answer "is this workspace ready to launch this week, and if not, exactly what is blocking it?" from one place.

The roadmap intent (verbatim): *"Add 'Launch Readiness' as a product concept: readiness % with Ready/Blocked checklist unifying onboarding/integrations/review/scheduling/publishing/results (e.g. 78% — Ready: brand approved, 7 generated, 5 approved, LinkedIn connected, calendar scheduled; Blocked: IG needs reconnect, 2 posts need creative approval, Friday post missing image)."*

The good news: **every input already arrives in the browser.** The home dashboard hydrates four hooks — `useRuntimePosts` (posts + `counts`), `useRuntimeReviews` (the approval queue), `useBusinessProfile` (onboarding/profile completeness), `useIntegrations` (per-channel `connection_state` / `last_synced_at` / `expires_at`) — see `frontend/aries-v1/home-dashboard.tsx:23-42`. The calendar surface adds the fifth — `/api/social-content/scheduled-posts` returns `ScheduledPostItem[]` + an `unscheduled` backlog whose items carry `imageUrl` (`lib/api/aries-v1.ts:304-332`, read path `app/api/social-content/scheduled-posts/route.ts`). The calendar reads that route via the typed client `api.getScheduledPosts(range)` (`lib/api/aries-v1.ts:493-496`) inside `frontend/aries-v1/calendar-screen.tsx` — that is the read precedent for this plan (the separate `useCalendarScheduling` hook owns the *write*/move path against `/api/social-content/jobs/{jobId}`, not the scheduled-posts read; it is cited below only for its `fetchImpl`-injection test pattern). So a standalone Launch Readiness surface is a **pure derivation + a new screen**, not a backend project.

## Who cares

- **Operators / the @sugarandleather tenant** — one number + one checklist answers "can I launch this week, and what's stopping me." The current three-row block under-delivers on that promise.
- **First-user experience (Phase P2)** — this is the surface that turns "I connected things and generated content" into "I am 78% ready; here are the 3 things to finish." It is the natural landing pad after onboarding and the demo flow's "what Aries would do next."
- **Product** — "Launch Readiness" is a named product concept; today it's an anonymous hero sub-panel.

## Decisions (locked — do not re-litigate)

1. **Read-only, presentation-layer only.** No new DB column, no new write route, no change to publish/schedule behavior. Readiness is a *projection* of state that already exists. This keeps it off the "treat-as-production" risk surface entirely — it cannot change what publishes.
2. **No autonomous action from this surface.** Every Blocked item links to the existing surface that resolves it (review queue, channel integrations, posts, calendar). Aries never auto-fixes. Honors "nothing publishes without human approval."
3. **Reuse the four already-hydrated hooks + the one calendar read path.** Do not add a sixth fetch or a server aggregation endpoint. The readiness score is computed client-side in a pure view-model, exactly like `createDashboardHomeViewModel`, so it is unit-testable with zero I/O (`tests/dashboard-home-view-model.test.ts` is the precedent).
4. **The dimension set is fixed at six**, matching the roadmap: `onboarding`, `integrations`, `review`, `scheduling`, `publishing`, `results`. Each contributes Ready items and/or Blocked items; the % is a weighted roll-up (see Scoring).
5. **Standalone route `/dashboard/launch-readiness`** (new `AppRouteId: 'launchReadiness'`), mounted in the same `AppShellLayout` as every other dashboard surface, with a sidebar nav entry. The home hero's existing three-row block stays as-is for now (it is a different, smaller widget) — but when the flag is ON, those three rows gain a "View launch readiness →" link to the new surface. We do **not** delete the hero block in this plan (avoids a same-PR regression of a shipped surface).
6. **Flag-gated default OFF.** `ARIES_LAUNCH_READINESS_ENABLED` gates the route's reachability, the nav entry, and the hero link. When OFF, the surface is dark and nothing about today's dashboard changes. It is a rollout switch over a new user-facing surface, per the guardrail that new behavior ships behind a default-OFF flag.
7. **"Friday post missing image" requires the scheduled-posts read.** The home hooks do not include scheduled rows. The new screen fetches `/api/social-content/scheduled-posts` (same route the calendar already uses) so the scheduling dimension can flag a queued post with no resolvable media. This is the only new fetch the screen issues, and it is an existing route.

## Current State (VERIFIED — branch @ fix/story-composer-serving, VERSION 0.1.13.18)

**View-model — `frontend/aries-v1/view-models/dashboard-home.ts`:**
- `readiness` type at `:32-37`: `Array<{ label; value; detail; tone: 'default'|'good'|'watch' }>`. No `%`, no per-item `state: 'ready'|'blocked'`, no `href`.
- Computed at `:368-400`: exactly three entries (`Profile`, `Channels`, `Approvals`), derived from `args.profile.incomplete`, `connectedCount`/`attentionCount`, and `args.reviews.length`. The richer signals (`readyToPublishCount`, `pausedCount`, `livePosts`, per-post `counts`) are computed in the same function (`:247-273`) but **not** surfaced into readiness.
- `createDashboardHomeViewModel(args)` is a pure function over `{ posts, reviews, profile, integrationCards, integrationsPending }` (`:235-241`). This is the model to mirror.

**Presenter — `frontend/aries-v1/presenters/dashboard-home-presenter.tsx`:**
- `:464-500` renders the three-row readiness block (icon by `tone`, `label`/`value`/`detail`). No %, no Ready/Blocked split, no per-row link.

**Inputs already in the browser (`frontend/aries-v1/home-dashboard.tsx:23-42`):**
- `useRuntimePosts({ autoLoad: true })` → `RuntimePostListItem[]` with `counts` (`lib/api/aries-v1.ts:57-70`): `posts`, `imageAds`, `scripts`, `ready`, `readyToPublish`, `pausedMetaAds`, `scheduled`, `live`, `publishItems` (plus `landingPages`, `videoAds`, `proposalConcepts`). Plus `pendingApprovals`, `status`, `dashboardStatus`. The hook is exported from `@/hooks/use-runtime-social-content`.
- `useRuntimeReviews({ autoLoad: true })` → `RuntimeReviewItem[]` (`lib/api/aries-v1.ts:96-135`) with `reviewType: 'brand'|'strategy'|'creative'|'workflow_approval'`, `channel`, `placement`, `scheduledFor`, `status`. This is exactly the granularity needed for "2 posts need creative approval".
- `useBusinessProfile({ autoLoad: true })` → `BusinessProfileView` (`incomplete`, `websiteUrl`) for the onboarding dimension.
- `useIntegrations({ autoLoad: true })` → `IntegrationCard[]` (`lib/api/integrations.ts:56-70`) with `connection_state` (`connected|reauth_required|connection_error|disabled|not_connected`), `last_synced_at`, `expires_at`, `display_name`, `error`. This is the channel-health signal for "IG needs reconnect" — `reauth_required` ⇒ Blocked with a reconnect link. Note the home dashboard reads cards as `integrations.data?.status === 'ok' ? integrations.data.cards : []` and sets `integrationsPending = integrations.isLoading`.

**Scheduling signal (NOT in the home hooks):**
- `/api/social-content/scheduled-posts` (`app/api/social-content/scheduled-posts/route.ts`) returns `ScheduledPostsResponse` (`lib/api/aries-v1.ts:329-333`): `posts: ScheduledPostItem[]` (each has `scheduledFor`, `dispatchStatus`, `targetPlatforms`, `title`, `jobId`) and `unscheduled: UnscheduledPostItem[]` (each has `imageUrl: string | null`). The calendar **screen** consumes the same route via `api.getScheduledPosts(range)` (`lib/api/aries-v1.ts:493-496`, called in `frontend/aries-v1/calendar-screen.tsx`); the calendar view-model then takes `scheduledPosts: ScheduledPostItem[]` as input (`frontend/aries-v1/view-models/calendar.ts:95-101`). "Friday post missing image" = a queued/approved post whose `imageUrl`/media is null.

**Routing + nav:**
- `frontend/app-shell/routes.ts:1-15` defines the `AppRouteId` union (14 ids) and `APP_ROUTES` (`:25-124`) with `getRouteById` (`:126-132`). Adding a route = extend the union + add an `AppRoute` entry.
- `components/redesign/layout/app-shell-client.tsx:32-47` defines `const ICONS: Record<AppRouteId, ...>` — **TS will fail the build** if a new `AppRouteId` has no icon (this is the intended guard). Nav lists are `primaryItems` (`:88-96`)/`utilityItems` (`:98-106`), each built with `useMemo(() => [...], [])`.
- Every dashboard sub-page is `<AppShellLayout currentRouteId="..." loginRedirectPath="...">{<Screen/>}</AppShellLayout>` — see `app/dashboard/results/page.tsx:4-10`. `app/dashboard/layout.tsx` already enforces the onboarding gate for the whole `/dashboard/*` segment (via `enforceOnboardingGate`).

**Test precedent:**
- `tests/dashboard-home-view-model.test.ts` unit-tests `createDashboardHomeViewModel` with hand-built `RuntimePostListItem` / publish-item fixtures and **zero I/O** (node:test + node:assert/strict). The new readiness view-model gets an identical test file. (Note: this file runs in the **full-suite** gate but is **not** in `scripts/verify-regression-suite.mjs`; the new test file should be added to the verify suite's step list so it runs in `npm run verify` too — mirror the existing "partner attribution (VMS) unit tests" / "honcho performance-insights unit tests" steps.)

## Architecture (target data flow)

```
useRuntimePosts ─┐   (posts[].counts, pendingApprovals, status)
useRuntimeReviews├┐  (reviews[]: reviewType, channel, status)
useBusinessProfile│  (profile.incomplete, websiteUrl)
useIntegrations  ││  (cards[]: connection_state, expires_at, display_name)
                 ││
 NEW: useScheduledPosts (existing /api/social-content/scheduled-posts via api.getScheduledPosts)
                 ││  (scheduled[].dispatchStatus, unscheduled[].imageUrl)
                 ▼▼
   createLaunchReadinessViewModel(args)   ← NEW pure fn (no I/O)
     ├─ onboarding   dimension → ready/blocked items
     ├─ integrations dimension → ready/blocked (reauth_required ⇒ blocked + reconnect href)
     ├─ review       dimension → blocked: "N posts need creative approval" (by reviewType)
     ├─ scheduling   dimension → blocked: "Friday post missing image" (unscheduled.imageUrl null)
     ├─ publishing   dimension → ready: "N ready to publish"; blocked: failed dispatch
     └─ results      dimension → ready: "live + sending signal"
     ▼
   readinessPercent (weighted roll-up) + readyItems[] + blockedItems[]
     ▼
 LaunchReadinessScreen  ('use client')  ← NEW
   ├─ headline ring/number "78% ready"
   ├─ Ready column   (green checks, each links to source surface)
   └─ Blocked column (amber/red, each links to the surface that resolves it)
     ▼
 /dashboard/launch-readiness  (AppShellLayout, currentRouteId='launchReadiness')
   gated by ARIES_LAUNCH_READINESS_ENABLED (NEXT_PUBLIC mirror for client gate)
```

## Scoring (locked)

Six dimensions, each scored 0–1, then weighted. Weights bias toward the launch-critical path:

| Dimension | Weight | Ready (1.0) when | Blocked / partial signal |
|-----------|-------:|------------------|--------------------------|
| onboarding | 0.15 | `profile && !profile.incomplete` | `profile.incomplete` ⇒ "Finish business profile" → `/dashboard/settings/business-profile` |
| integrations | 0.20 | `connectedCount >= 1 && attentionCount === 0` | each `reauth_required`/`connection_error` card ⇒ "`{display_name}` needs reconnect" → `/dashboard/settings/channel-integrations` |
| review | 0.20 | `reviews.length === 0` | group by `reviewType`: "`N` posts need creative approval" / "strategy needs approval" → `/review` |
| scheduling | 0.15 | at least one `scheduled_post` queued AND no queued/approved post missing media | per missing-media post ⇒ "`{title}` ({day}) missing image" → `/dashboard/calendar` |
| publishing | 0.20 | `readyToPublishCount > 0 || liveCount > 0` and no failed dispatch | failed dispatch ⇒ "`N` posts failed to publish" → `/dashboard/posts`; nothing ready ⇒ partial |
| results | 0.10 | `liveCount > 0` | no live yet ⇒ neutral (not blocking), 0.0 until first live post |

- `readinessPercent = round(100 * Σ(weight_i * score_i))`. Weights sum to 1.0.
- A dimension can emit **both** ready and blocked items (e.g. integrations: "LinkedIn connected" + "Instagram needs reconnect"). The dimension's numeric score is computed independently of how many human-readable lines it emits.
- `results` is **never** a hard blocker (a brand-new workspace with no live posts is still launch-ready); it only adds upside to the %.
- Each `ReadyItem` / `BlockedItem` carries `{ id, label, detail, href, dimension, severity: 'ready'|'attention'|'critical' }` so the presenter sorts critical-first and links every row.

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Readiness view-model + types (pure fn, unit-tested) | Critical | 3h / 1h | none |
| B | Standalone screen + route + nav + ICONS + flag wiring | High | 4h / 1.5h | A |
| C | Scheduling read (reuse scheduled-posts route) for missing-media signal | Medium | 2h / 45m | A |
| D | Hero cross-link + flag docs + verify allowlist + ship | Medium | 2h / 45m | B, C |

**Sequencing:** A first (everything renders from it; it is testable with zero UI). B mounts the surface behind the flag. C enriches the scheduling dimension (the screen renders fine without it — scheduling just shows "no scheduling signal yet" until C lands). D ships.

```
A ──> B ──┐
   └─> C ──┴─> D
```

---

### A — Readiness view-model + types (Critical, 3h)

**New file `frontend/aries-v1/view-models/launch-readiness.ts`:**
1. Export `LaunchReadinessDimension = 'onboarding' | 'integrations' | 'review' | 'scheduling' | 'publishing' | 'results'`.
2. Export `LaunchReadinessItem = { id; label; detail; href; dimension: LaunchReadinessDimension; severity: 'ready' | 'attention' | 'critical' }`.
3. Export `LaunchReadinessViewModel`:
   ```ts
   {
     percent: number;                 // 0–100
     headline: string;                // e.g. "78% ready to launch"
     summary: string;                 // one calm sentence
     dimensions: Array<{ dimension; label; score: number; tone: 'good'|'watch'|'default' }>;
     ready: LaunchReadinessItem[];    // severity 'ready'
     blocked: LaunchReadinessItem[];  // severity 'attention' | 'critical', critical first
   }
   ```
4. Export `createLaunchReadinessViewModel(args: { posts: RuntimePostListItem[]; reviews: RuntimeReviewItem[]; profile: BusinessProfileView | null; integrationCards: IntegrationCard[]; integrationsPending?: boolean; scheduledPosts?: ScheduledPostItem[]; unscheduledPosts?: UnscheduledPostItem[] })` — a pure function, no I/O, mirroring `createDashboardHomeViewModel` (`dashboard-home.ts:235`).
   - Reuse the existing helpers' logic: `readyToPublishCountFor` / `isLivePost` (already in `dashboard-home.ts:173-179`) — extract them into a small shared module `frontend/aries-v1/view-models/post-signals.ts` and import from both, OR re-derive locally (extraction preferred to keep one source of truth; if extracting, leave `dashboard-home.ts` importing the same helpers and re-run its test).
   - **review dimension granularity:** group `reviews` by `reviewType` so the label is specific ("2 posts need creative approval" for `reviewType === 'creative'`, "strategy needs approval" for `'strategy'`), not a generic count. Default unknown types to "needs approval".
   - **integrations dimension:** map each `connection_state` to ready vs blocked using the SAME mapping already in `dashboard-home.ts:146-171` (`reauth_required`/`connection_error` ⇒ attention). When `integrationsPending`, emit a neutral "Checking channels" item and exclude integrations from the % (treat score as pending → contributes 0 weight until loaded, like the hero's `'...'` handling at `dashboard-home.ts:348`).
   - **scheduling/results dimensions:** degrade gracefully when `scheduledPosts` is absent (Phase C not yet wired) — emit no blocked items, score 0.5 neutral, so the screen is correct in B before C.

**Edit `frontend/aries-v1/view-models/dashboard-home.ts` (optional, only if extracting helpers):** swap the two local helpers for imports from `post-signals.ts`. No behavior change. Re-run `tests/dashboard-home-view-model.test.ts`.

**New test `tests/launch-readiness-view-model.test.ts`** (mirror `tests/dashboard-home-view-model.test.ts` fixtures):
- Empty workspace (no posts/reviews/channels, incomplete profile) ⇒ low %, onboarding+integrations blocked.
- "78%" golden: brand approved + 7 generated + 5 ready + LinkedIn connected + IG `reauth_required` + 2 `creative` reviews + one unscheduled post with `imageUrl: null` ⇒ asserts `percent` in expected band, `blocked` contains an IG-reconnect item with the channel-integrations href, a "2 posts need creative approval" item with `/review` href, and a missing-image item with `/dashboard/calendar` href; `ready` contains LinkedIn-connected + "5 ready to publish".
- `integrationsPending: true` ⇒ integrations excluded from %, no false-blocked.
- Weights sum to 1.0 (assert the constant table).
- `results` never appears in `blocked` (only upside).

**Acceptance (A):** `createLaunchReadinessViewModel` is importable and pure; the new unit test passes with `APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/launch-readiness-view-model.test.ts`; `npm run typecheck` clean.

### B — Standalone screen + route + nav + flag (High, 4h)

**New flag helper `lib/launch-readiness-flag.ts`** (server + client safe):
```ts
export function isLaunchReadinessEnabled(env = process.env): boolean {
  const v = (env.ARIES_LAUNCH_READINESS_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
```
Mirror the exact truthy parsing used by `isVideoPublishEnabled` (`backend/marketing/synthesize-publish-posts.ts:115-117`) and the Honcho flags. For the **client** gate (nav entry + hero link), expose a build-time `NEXT_PUBLIC_ARIES_LAUNCH_READINESS_ENABLED` read by a thin `frontend/aries-v1/launch-readiness-flag.client.ts` (precedent: `NEXT_PUBLIC_*` reads in `frontend/components/media-preview.tsx`), since the sidebar is a client component. Document both in `.env.example`/`docker-compose.yml` so they are set together.

**New route `app/dashboard/launch-readiness/page.tsx`** (mirror `app/dashboard/results/page.tsx`):
- Server component: if `!isLaunchReadinessEnabled()` ⇒ `notFound()` (so the URL is dark when the flag is off; `notFound()` is already used in app routes, e.g. `app/materials/[jobId]/[assetId]/page.tsx`).
- Else render `<AppShellLayout currentRouteId="launchReadiness" loginRedirectPath="/dashboard/launch-readiness"><LaunchReadinessScreen/></AppShellLayout>`. The onboarding gate is already enforced by `app/dashboard/layout.tsx`.

**New screen `frontend/aries-v1/launch-readiness-screen.tsx`** (`'use client'`, mirror `frontend/aries-v1/results-screen.tsx`):
- Call `useRuntimePosts`, `useRuntimeReviews`, `useBusinessProfile`, `useIntegrations` (autoLoad) — identical to `home-dashboard.tsx:23-26`. Read cards as `integrations.data?.status === 'ok' ? integrations.data.cards : []` and `integrationsPending = integrations.isLoading`, matching the home dashboard.
- `useMemo(() => createLaunchReadinessViewModel({...}), [...])`.
- Render the existing shell primitives (`ShellPanel`, `LoadingStateGrid`, `StatusChip` from `./components`) — header renders immediately, content hydrates below (same "looks alive while fetching" pattern `results-screen.tsx` documents for the ~10–40s posts fetch).
- Layout: a headline % ring/number, a one-line `summary`, then two columns — **Ready** (green) and **Blocked** (amber for `attention`, red for `critical`), each row a `<Link href={item.href}>` to the resolving surface. Critical-first ordering.
- Customer-safe error copy via `customerSafeUiErrorMessage` (as `home-dashboard.tsx:101,110` do).

**Route plumbing:**
- `frontend/app-shell/routes.ts`: add `'launchReadiness'` to the `AppRouteId` union (`:1-15`) and an `AppRoute` entry to `APP_ROUTES` (`:25-124`): `{ id:'launchReadiness', title:'Launch Readiness', href:'/dashboard/launch-readiness', section:'primary', description:'Readiness % and the Ready/Blocked checklist unifying onboarding, channels, review, scheduling, and publishing.' }`.
- `components/redesign/layout/app-shell-client.tsx`: add a `launchReadiness:` entry to the `ICONS: Record<AppRouteId,...>` map (`:32-47`) — TS build fails otherwise (use `Rocket` or `Gauge` from lucide). Add `{ type:'link', routeId:'launchReadiness' }` to `primaryItems` (`:88-96`) **only when** `isLaunchReadinessEnabledClient()` is true. Note `primaryItems` is a `useMemo(() => [...], [])` with an empty dep array, so do the flag check **inside** the memo (and either add the flag value to the dep array or read it from a stable build-time constant) — do not mutate the memoized array elsewhere.

**Acceptance (B):** with `ARIES_LAUNCH_READINESS_ENABLED=1` + `NEXT_PUBLIC_...=1`, navigating to `/dashboard/launch-readiness` renders the % + Ready/Blocked columns populated from the live tenant; the sidebar shows the entry; with the flag unset, the URL 404s and the nav entry is gone. `npm run typecheck` + `npm run lint` clean. **User-visible success bar:** the rendered Launch Readiness page in the operator dashboard shows a real % and at least one correctly-linked Blocked row for a tenant that has a known gap (e.g. an unconnected channel) — verified in the browser, not from state.

### C — Scheduling read for missing-media signal (Medium, 2h)

**New hook `frontend/aries-v1/hooks/useScheduledPostsReadOnly.ts`** — a thin read wrapper around `/api/social-content/scheduled-posts`. Mirror the read precedent: `frontend/aries-v1/calendar-screen.tsx` calls `api.getScheduledPosts(range)` (the typed client in `lib/api/aries-v1.ts:493-496`); reuse that same client method here. Borrow the `fetchImpl`-injection pattern from `useCalendarScheduling` (`frontend/aries-v1/hooks/useCalendarScheduling.ts` — `fetchImpl?: typeof fetch`) so tests inject a fake fetch with zero I/O. Returns `{ scheduled: ScheduledPostItem[]; unscheduled: UnscheduledPostItem[]; isLoading; error }`.

**Edit `frontend/aries-v1/launch-readiness-screen.tsx`:** call the new hook and pass `scheduledPosts` + `unscheduledPosts` into `createLaunchReadinessViewModel`. The scheduling dimension now flags:
- a queued post whose dispatch failed ⇒ blocked → `/dashboard/calendar`;
- an approved/unscheduled post with `imageUrl: null` ⇒ "`{title}` missing image" → `/dashboard/calendar` (the roadmap's "Friday post missing image"). Derive the day label from `scheduledFor` when present.

**Edit `tests/launch-readiness-view-model.test.ts`:** add the missing-image and failed-dispatch fixtures (now that the inputs are wired).

**Acceptance (C):** a tenant with an approved post that has no resolvable image renders a Blocked "missing image" row linking to the calendar; a clean tenant shows scheduling as Ready. Verified in the browser.

### D — Hero cross-link + docs + verify allowlist + ship (Medium, 2h)

**Implementation:**
1. `frontend/aries-v1/presenters/dashboard-home-presenter.tsx` (`:464-500`): when the client flag is ON, add a "View launch readiness →" `<Link href="/dashboard/launch-readiness">` under the existing three-row block. When OFF, the block is untouched (no regression to the shipped hero).
2. Document `ARIES_LAUNCH_READINESS_ENABLED` (+ the `NEXT_PUBLIC_` mirror) in `CLAUDE.md` "Environment Variables" (matching the existing flag-entry format), `.env.example` (`=0`), and `docker-compose.yml` (default `${ARIES_LAUNCH_READINESS_ENABLED:-0}`, matching the `ARIES_VIDEO_PUBLISH_ENABLED` entry style).
3. Add `tests/launch-readiness-view-model.test.ts` as a new step in `scripts/verify-regression-suite.mjs` so it runs in `npm run verify` (it is fast/pure; mirror the existing "partner attribution (VMS) unit tests" / "honcho performance-insights unit tests" `args: ['--test', 'tests/...']` steps).
4. Bump `VERSION` (patch → `0.1.13.19`; additive surface, no schema) + `CHANGELOG.md`.
5. `/ship-triage-deploy`.

**Acceptance (D):** flag OFF ⇒ home hero unchanged, no nav entry, `/dashboard/launch-readiness` 404; flag ON ⇒ hero shows the cross-link and the new surface renders end-to-end against the live @sugarandleather tenant; `full-suite` gate green.

## Feature flag

`ARIES_LAUNCH_READINESS_ENABLED` (+ build-time mirror `NEXT_PUBLIC_ARIES_LAUNCH_READINESS_ENABLED`) — rollout switch for the standalone Launch Readiness surface (readiness % + Ready/Blocked checklist at `/dashboard/launch-readiness`). Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF: the route returns 404, the sidebar nav entry is absent, and the home dashboard hero is unchanged — today's behavior is byte-for-byte preserved. When ON: the route is reachable, the nav entry appears, and the home hero's readiness block gains a "View launch readiness →" link. This surface is **read-only** — it never changes what publishes or schedules, never triggers an action autonomously; every Blocked row links to the existing surface (review queue / channel integrations / posts / calendar) where a human resolves it. Document in `CLAUDE.md`, `.env.example`, and `docker-compose.yml` (set both vars together).

## User-visible success bar (rendered UI only)

Done = with the flag ON, an operator opens `/dashboard/launch-readiness` in Brendan's dashboard and sees, rendered:
1. a headline **percentage** (e.g. "78% ready to launch") computed from live tenant state;
2. a **Ready** column with real items (e.g. "5 ready to publish", "LinkedIn connected");
3. a **Blocked** column with real, specifically-labeled items, each a working link to the surface that resolves it — at minimum, for a tenant with a `reauth_required` channel, a "`{channel}` needs reconnect" row linking to `/dashboard/settings/channel-integrations`.

A passing unit test, a populated DB, or a 200 from a route does **not** count. Only the rendered page in the operator dashboard counts.

## Testing + verify

| Layer | What | Count |
|-------|------|-------|
| Unit (pure view-model) | empty workspace ⇒ low %, onboarding+integrations blocked | +1 |
| Unit | "78%" golden: ready+blocked mix, correct labels + hrefs per dimension | +1 |
| Unit | `integrationsPending` excludes integrations from %, no false-blocked | +1 |
| Unit | weights sum to 1.0; `results` never blocks | +2 |
| Unit | review grouping by `reviewType` ("2 posts need creative approval") | +1 |
| Unit | scheduling: unscheduled `imageUrl:null` ⇒ "missing image" blocked + calendar href | +1 |
| Unit | scheduling absent (Phase C unwired) ⇒ neutral, no false-blocked | +1 |
| Manual (live, in-browser) | render `/dashboard/launch-readiness` on @sugarandleather; verify % + a real reconnect Blocked row links correctly | manual |

All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify` (new test added as a step in `scripts/verify-regression-suite.mjs`), then `npm run test:concurrent` before ship (this touches routes + frontend + a shared view-model helper if extracted). `npm run typecheck` + `npm run lint` must be clean (the `ICONS` `Record<AppRouteId>` and the `AppRouteId` union both fail the build if the new route is half-wired — a useful guard).

**Idempotency / resumability:** N/A in the classic sense — this is a stateless read-only projection. The relevant safety property is **purity**: `createLaunchReadinessViewModel` must be deterministic over its inputs (no `Date.now()` in the score; if a day-label needs "today", inject the clock as an arg defaulting to `new Date()` and pin it in tests, mirroring the tenant-zone helpers used in `calendar.ts`).

## Rollback

- **Flag:** `ARIES_LAUNCH_READINESS_ENABLED=0` (+ rebuild for the `NEXT_PUBLIC` mirror) ⇒ route 404s, nav entry gone, hero unchanged. Instant, total kill switch.
- **Code:** the surface is purely additive (new files + a new `AppRouteId` + one nav entry + one optional hero link). Reverting the PR removes it with zero data or schema impact.
- **No DB / no migration:** nothing to roll back at the data layer.

## Out of scope

- **Any new write / action.** No "fix this for me" buttons, no auto-reconnect, no auto-schedule. Blocked rows link out; humans act. (Autonomous publishing is explicitly de-prioritized by the roadmap.)
- **A server-side readiness aggregation endpoint.** The score is computed client-side from already-hydrated hooks; do not add a sixth fetch beyond the existing scheduled-posts route, and do not move scoring server-side in this plan.
- **New channel-health depth** (token-expiry countdowns, last-sync freshness scoring) beyond what `IntegrationCard` already exposes — that is roadmap #7 (channel health center). This surface *consumes* `connection_state`; it does not deepen it.
- **Brand-palette restyling** of the new screen — it reuses the current `components.tsx` primitives and the existing dark theme. The Obsidian/Cream/Ember redesign (roadmap #5) is a separate, repo-wide effort; do not fork the palette here.
- **Public / demo exposure.** This is an authenticated operator surface only. Do NOT wire it into any public route and do NOT expose `MARKETING_STATUS_PUBLIC=1` in prod.
- **Replacing or deleting the home-hero readiness block.** It stays; we only add a cross-link. A future plan may fold it into this surface.
- **Results dimension as a hard gate.** Results contributes upside only; building a real "performance learnings" loop is roadmap #11.

## Risks

1. **Score feels arbitrary / operators distrust the %.** Mitigation: the % is a transparent weighted sum of six named dimensions whose ready/blocked lines are all human-readable and individually actionable; the weight table is asserted in tests and documented here. The number is supportive, the checklist is authoritative.
2. **Posts fetch latency (~10–40s with many jobs, per `results-screen.tsx` comment and the social-content list-perf memory).** Mitigation: render the shell header + % skeleton immediately and hydrate columns below (the documented pattern); never block the whole screen on the slow fetch. Do **not** add `Promise.all` fan-out across the four hooks beyond what the home dashboard already does (guardrail #1 — DB pressure is `ARIES_WEB_CONCURRENCY * DB_POOL_MAX`).
3. **Union-widening literal-inequality bug (CLAUDE.md memory).** Adding `'launchReadiness'` to `AppRouteId` is a string-literal union widening. After widening, grep for any `=== 'home'` / `!== 'results'` / `.includes(...)` route-id checks — e.g. the `isReviewSectionActive` check at `app-shell-client.tsx:118-120` uses `['brandReview','strategyReview','creativeReview'].includes(currentRouteId)` over a hardcoded subset, so the new id is safe there, but confirm no other literal check silently mishandles it. TS catches the `ICONS` and `getRouteById` paths but not literal inequalities.
4. **Client flag drift from server flag.** `NEXT_PUBLIC_...` is build-time; if only the server var is set, the route works but the nav entry/hero link won't appear (or vice-versa). Mitigation: document "set both together" in `.env.example`/`docker-compose.yml`, and have the server route be the source of truth (404 when its var is off) so a half-set flag degrades safe (dark), never to a broken-looking nav entry that 404s.
5. **Double-counting a blocker across dimensions** (e.g. an unscheduled approved post showing up under both scheduling and publishing). Mitigation: assign each post-derived signal to exactly one dimension (missing-media ⇒ scheduling; failed-dispatch ⇒ scheduling; ready-but-unpublished ⇒ publishing), asserted by the golden test.

## Related

- Roadmap #7 (channel health + reconnect center) — this surface consumes the same `IntegrationCard.connection_state` signal; the reconnect link targets the existing `/dashboard/settings/channel-integrations`. Keep the reconnect copy consistent with that screen.
- Roadmap #11 (results → next action) — the `results` dimension here is a placeholder for the future performance loop; do not pre-build it.
- Shipped: `#519` Meta failure taxonomy + reconnect signal — the dispatch-failure / reconnect states this surface reads are already real; nothing new is needed on the publish side.
- Shipped: `#520` video/Reel/Story-video publish surfaces (flag-gated, default OFF) — out of scope here; this surface reads existing image/feed publish state only and adds no publish behavior.
- CLAUDE.md guardrails honored: treat-as-production (read-only, cannot change publishes), default-OFF flag, no autonomous action, brand URL untouched (no public exposure), full-suite before push, Turbopack (no build-config change).
