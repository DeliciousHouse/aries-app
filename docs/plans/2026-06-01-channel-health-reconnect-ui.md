# Channel Health + Impossible-to-Miss Reconnect Surface

> Status: draft plan (2026-06-01). Roadmap areas [7, 1b]. Priority 3 / "build-first #4". This makes the **already-shipped** #519 publish-failure taxonomy and the per-channel token signal **visible in the operator dashboard**. Per the repo guardrail, only rendered operator UI counts as done — DB state, route payloads, and worker logs do not.

## Context

The plumbing for channel health already exists end-to-end; the **rendering does not**.

- **The auth signal is computed and persisted but never surfaced.** `app/api/internal/publishing/scheduled-dispatch/route.ts:232-241` returns a per-platform `kind?: MetaPublishFailureKind` (`'auth' | 'transient' | 'permanent' | 'outcome_unknown'`) for each dispatch. The scheduled-posts worker already turns `kind === 'auth'` into a human string and writes it to the DB: `scripts/automations/scheduled-posts-worker.mjs:241-242` prepends `auth: Meta account disconnected — reconnect required.` onto `scheduled_post_dispatches.error_message`. **Nothing in the UI reads that column.** An operator whose Instagram page token expired sees scheduled posts silently stall with zero on-screen explanation.
- **The channel cards already model token validity but under-render it.** `app/api/integrations/handlers.ts:88-112,185-219` already derives `connection_state` (`connected | reauth_required | connection_error | disabled | not_connected`), a `health` enum (`healthy | degraded | error | unknown`) computed from `token_expires_at` via `resolveTokenHealth`, an `expires_at`, and `scopes_outdated`. The card type (`lib/api/integrations.ts:56-70`) carries `last_synced_at`, `expires_at`, `permissions`, and `error`. But `channel-integrations-screen.tsx` renders only a single status chip + a Connect/Reconnect/Disconnect button. It **never shows** token-expiry, last-sync, or — critically — that a `reauth_required` state means **scheduled posts are paused right now**.
- **The dashboard surfaces channel attention as a quiet metric, not an alarm.** `frontend/aries-v1/view-models/dashboard-home.ts:146-171` maps each card into an `AriesChannelConnection` with a 3-state `health` (`connected | attention | not_connected`) and renders it in a "Connected channels" list (`presenters/dashboard-home-presenter.tsx:515-610`). A `reauth_required` channel just gets an amber dot and a "Reconnect" link — there is no top-of-page banner, and the all-important "publishing is paused because of this" framing is absent.

This plan adds **two rendered surfaces** that consume the *already-shipped* signal:
1. **A dashboard-top reconnect banner** that fires when any channel needs reconnection, with the exact roadmap-7 copy: "Instagram needs reconnect — page token expired — scheduled posts paused — Reconnect Meta."
2. **An enriched channel-integrations card** that renders, per channel: token validity, last sync, can-publish, can-read-results, and an inline reconnect CTA when action is needed.

It also adds **one new read endpoint** so the banner can say "scheduled posts paused" *truthfully* — i.e. only when there is actually a pending/failed scheduled post blocked on that auth failure, derived from the `auth:`-tagged `scheduled_post_dispatches.error_message` the worker already writes.

This is **a UI + one read-route feature behind a default-OFF flag** (`ARIES_CHANNEL_HEALTH_UI_ENABLED`). It is medium-sized: no new publish behavior, no Meta API changes, no schema changes. It reads existing columns and renders them. The flag exists so the new banner/enriched card can land dark on prod and be flipped once verified against the live @sugarandleather tenant.

## Who cares

- **Operators / the @sugarandleather tenant** — today a token expiry is invisible until someone notices the calendar stopped publishing. The whole point of #519's taxonomy was to make "expired token → reconnect" legible; that promise is unkept until it renders.
- **Public-readiness (roadmap 1b)** — "publish failure clarity — expired tokens say 'Reconnect account' not generic failed" is an explicit public-trust blocker. The backend says it; the screen must too.
- **Launch Readiness (build-first #3)** — a future readiness checklist needs a single source of truth for "IG needs reconnect"; this plan establishes the read endpoint + view-model field it will reuse.

## Decisions (locked — do not re-litigate)

1. **Reuse the shipped signal; do not recompute it.** The `MetaPublishFailureKind` taxonomy (`backend/integrations/meta-publishing.ts:128-173`), the worker's `auth:` error-message tagging (`scheduled-posts-worker.mjs:241-242`), and the integrations card's `connection_state`/`health`/`expires_at` (`app/api/integrations/handlers.ts`) are the inputs. This plan renders them and adds **one** aggregation read; it does not re-derive token health or re-classify failures.
2. **Two distinct "needs reconnect" inputs, OR-ed into one banner state.** (a) The connection itself is `reauth_required`/`connection_error` (token expiry from the integrations card). (b) A scheduled post actually failed with `kind === 'auth'` (the worker tagged it). Either is sufficient to show the banner; (b) is what unlocks the literal "scheduled posts paused" clause. Never claim "scheduled posts paused" from (a) alone — a freshly-expired token with no pending posts is "needs reconnect" but nothing is paused yet.
3. **No new writes, no schema change.** Both inputs already persist. The new endpoint is read-only over `scheduled_post_dispatches` + `oauth` status. (`scheduled_post_dispatches.error_message` already holds the `auth:` prefix — `init-db.js:637-651`.)
4. **Brand URL is `aries.sugarandleather.com`.** Any CTA / "Reconnect Meta" link points at the in-app `/oauth/connect/{platform}?mode=reconnect` route (the existing path `channel-integrations-screen.tsx:30-37` already uses), never a bare `sugarandleather.com`.
5. **Reconnect is operator-initiated only.** The banner/card *surface* the need and link to the existing OAuth reconnect flow. Nothing auto-reconnects, nothing auto-publishes. Approval-gated publish is untouched.
6. **Flag `ARIES_CHANNEL_HEALTH_UI_ENABLED` (default OFF)** gates the new banner, the enriched-card fields, and the new read endpoint's invocation from the client. When OFF, the dashboard and channel screen render exactly as today (the existing amber-dot card + "Reconnect" link remain — they are not behind the flag).

## Current State (VERIFIED — branch @ fix/story-composer-serving)

**Dispatch route — already emits the auth kind:**
- `app/api/internal/publishing/scheduled-dispatch/route.ts:6-7` imports `classifyMetaPublishFailureKind` + `MetaPublishFailureKind`; `:240` includes `kind?` on each per-platform result; `:277` calls the classifier; `:278` pushes `kind` into `results`. The route returns `{ status, results }` with `kind` per platform (`:311`).

**Failure taxonomy — shipped:**
- `backend/integrations/meta-publishing.ts:128-173`: `META_AUTH_FAILURE_CODES = {oauth_token_missing, external_account_missing}`; `MetaPublishFailureKind = 'transient'|'permanent'|'auth'|'outcome_unknown'`; `classifyMetaPublishFailureKind()` precedence outcome-unknown → auth → transient → permanent.

**Worker — already persists the human auth string:**
- `scripts/automations/scheduled-posts-worker.mjs:222-247` `planPlatformOutcomes()`; `:241-242`: `if (result?.kind === 'auth') error = 'auth: Meta account disconnected — reconnect required. ' + error;`. This lands in `scheduled_post_dispatches.error_message` (`:165,180,186`) and the parent `scheduled_posts.error_message`.

**Schema — columns already exist (no migration needed):**
- `scripts/init-db.js:619-651`: `scheduled_posts.dispatch_status` (`pending|in_flight|dispatched|failed`), `error_message`, `error_at`; `scheduled_post_dispatches(scheduled_post_id, platform, status, error_message, error_at, ...)`. NOTE: `scheduled_post_dispatches` has no `tenant_id` column — tenant scoping is via the join to `scheduled_posts.tenant_id` (which exists; `idx_scheduled_posts_tenant_scheduled`, `init-db.js:529`).

**Integrations card builder — already derives validity:**
- `app/api/integrations/handlers.ts:88-96` `mapState()` → `reauth_required` for `token_expired|revoked|permission_denied`; `:98-112` `mapHealth()` via `resolveTokenHealth(token_expires_at)` → `healthy|degraded|error|unknown`; `:185-219` builds the card with `connection_state`, `health`, `scopes_outdated`, `expires_at`, `available_actions`, `connected_account`, `error`. `last_synced_at` is currently hardcoded `null` (`:208`).
- `oauthStatusAsync` (`backend/integrations/status.ts`) returns `connection_status`, `token_expires_at`, `refresh_token_expires_at`, `last_error`, `external_account_id/name`, `granted_scopes`.

**Card type — already has the fields:**
- `lib/api/integrations.ts:56-70` `IntegrationCard`: `connection_state`, `health`, `available_actions`, `last_synced_at`, `expires_at`, `permissions`, `connected_account`, `error`, `scopes_outdated`.

**Channel-integrations screen — under-renders:**
- `frontend/aries-v1/channel-integrations-screen.tsx`: renders one `StatusChip` (`:164-174`) + primary action button (`:184-193`). Does NOT render `expires_at`, `health`, `last_synced_at`, can-publish/can-read-results, or any "scheduled posts paused" notice.

**Dashboard channel mapping — 3-state, no banner:**
- `frontend/aries-v1/view-models/dashboard-home.ts:146-171` `mapChannelConnection()` → `AriesChannelConnection{health: 'connected'|'attention'|'not_connected', detail}`; `:244-246` derives `connectedCount`/`attentionCount`. The view-model's `channels` block (`:104-109`) has no banner field.
- `AriesChannelConnection` type: `lib/api/aries-v1.ts:376-384` (`id,name,handle,health,detail,canDisconnect`).
- `presenters/dashboard-home-presenter.tsx:515-610` renders the channel list with an amber dot + `/oauth/connect/{id}?mode=reconnect` link (`:600`). No top banner.

**No read endpoint exposes recent dispatch auth-failures to the browser:**
- `app/api/social-content/scheduled-posts/route.ts` returns per-post dispatch detail in a *date-range calendar* read, not a tenant-wide "is publishing paused on auth" rollup. There is no `/api/integrations/health` or equivalent (verified: no `app/api/integrations/health/` dir exists). This is the one genuinely-new server surface.

**Existing tests to extend:**
- `tests/dashboard-home-view-model.test.ts` (view-model unit tests, no DB). NOTE: this file is NOT currently in a `verify-regression-suite.mjs` step, so its extensions run only in the full CI glob — see Testing Plan.
- `tests/integrations-status.test.ts` (card-builder behavior). Already in the verify "post-30-day-backlog contract regression tests" step (`verify-regression-suite.mjs:166`), so its extension runs under `npm run verify`.

## Architecture (target data flow)

```
                          (input A: connection token validity)
app/api/integrations  ──> IntegrationCard{ connection_state, health, expires_at, scopes_outdated }
        │
        │               (input B: a scheduled post actually failed on auth)
NEW app/api/integrations/health/route.ts
   SELECT … FROM scheduled_post_dispatches d JOIN scheduled_posts sp …
   WHERE d.status='failed' AND d.error_message LIKE 'auth:%'           ← the worker's tag
     AND sp.dispatch_status IN ('failed','pending')                    ← still blocked
   ──> { tenant, channels:[{ platform, pausedScheduledCount, lastAuthFailureAt }] }
        │
        ▼
hooks/use-channel-health.ts  (client, flag-gated fetch)
        │
        ├─────────────────────────────────────────────┐
        ▼                                               ▼
view-models/dashboard-home.ts                  channel-integrations-screen.tsx
  channels.reconnect: {                          per-card health panel:
    needed: bool,                                  • token validity (expires_at/health)
    platformLabel, pausedScheduledCount,           • last sync
    href: /oauth/connect/{p}?mode=reconnect }      • can-publish / can-read-results
        │                                            • inline "Reconnect Meta" when needed
        ▼
presenters/dashboard-home-presenter.tsx
  NEW <ChannelReconnectBanner/> at top of dashboard:
  "Instagram needs reconnect — page token expired —
   scheduled posts paused — Reconnect Meta"  [Reconnect Meta →]
```

## Child phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Read endpoint: `/api/integrations/health` (auth-paused rollup over existing columns) | Critical | 3h / 1h | none |
| B | View-model + types: `channels.reconnect` field; can-publish/can-read-results derivation | High | 3h / 1h | A (shape) |
| C | Dashboard banner: `<ChannelReconnectBanner/>` with exact roadmap-7 copy | High | 3h / 1h | B |
| D | Enriched channel-integrations card: token validity / last sync / can-publish / can-read | High | 4h / 1.5h | B |
| E | Flag `ARIES_CHANNEL_HEALTH_UI_ENABLED`, docs, live verify on tenant 15, ship | Medium | 3h / 1h | A–D |

**Sequencing:** A first (defines the read shape both surfaces consume). B depends on A's response shape. C and D are parallel UI consumers of B. E last (flag wrap + live verify + ship).

```
A ──> B ──┬──> C ──┐
          └──> D ──┴──> E
```

---

### A — Read endpoint: auth-paused rollup (Critical, 3h)

**What exists:** the worker already writes `auth: Meta account disconnected — reconnect required.` into `scheduled_post_dispatches.error_message` (`scheduled-posts-worker.mjs:241-242`). The columns are all present (`init-db.js:637-651`). **Nothing reads them for the UI.**

**Implementation:**
1. New `app/api/integrations/health/route.ts` (+ a `handlers.ts` sibling matching the repo's handler/route split — `app/api/integrations/route.ts` delegates to `app/api/integrations/handlers.ts:handleIntegrationsGet`). Resolve tenant via `loadTenantContextOrResponse` from `@/lib/tenant-context-http` (same pattern as `handlers.ts:226-236`). Accept an injectable `queryable` for tests (mirror `ScheduledPostsQueryable`, `scheduled-posts/route.ts:28-33`).
2. Query (tenant-scoped, parameterized, no `Promise.all` fan-out — guardrail #1). NOTE: `scheduled_post_dispatches` has no `tenant_id`; the tenant filter is on the joined `scheduled_posts.tenant_id`:
   ```sql
   SELECT d.platform,
          COUNT(*) FILTER (
            WHERE d.status = 'failed' AND d.error_message LIKE 'auth:%'
          ) AS auth_failed_count,
          MAX(d.error_at) FILTER (
            WHERE d.status = 'failed' AND d.error_message LIKE 'auth:%'
          ) AS last_auth_failure_at
     FROM scheduled_post_dispatches d
     JOIN scheduled_posts sp ON sp.id = d.scheduled_post_id
    WHERE sp.tenant_id = $1
      AND sp.dispatch_status IN ('failed','pending','in_flight')
    GROUP BY d.platform;
   ```
   `sp.dispatch_status IN ('failed','pending','in_flight')` is the "still blocked / not yet drained" gate — a post that later published on a re-claim must not keep the banner up. Pair with the existing partial indexes (`idx_scheduled_posts_pending`, `idx_scheduled_posts_in_flight`, `init-db.js:625-628`).
3. Response (frontend-safe, no raw rows/paths — guardrail in CLAUDE.md "route handlers return frontend-safe payloads"):
   ```ts
   { status: 'ok',
     channels: Array<{ platform: string; pausedScheduledCount: number; lastAuthFailureAt: string | null }> }
   ```
   `error_message` itself is NOT returned (it can carry a raw Meta code); only the count + timestamp + platform.
4. Tenant `onboarding_required`/missing-tenant handling identical to `scheduled-posts/route.ts:9-13`.

**Resumability/idempotency:** read-only; safe to call on every dashboard load. No state mutation.

**Acceptance (this phase is backend; not user-visible alone):** unit test with a fake `queryable` — a row with `status='failed'`, `error_message='auth: …'`, parent `dispatch_status='failed'` yields `pausedScheduledCount: 1`; a `transient:`-tagged failure yields `0`; a `dispatched` parent yields `0`; cross-tenant rows are excluded by the `$1` filter.

### B — View-model + types (High, 3h)

**Implementation:**
1. `lib/api/aries-v1.ts:376-384`: extend `AriesChannelConnection` with rendered-fact fields:
   ```ts
   tokenValidity: 'valid' | 'expiring' | 'expired' | 'unknown';   // from card.health
   expiresAtLabel: string | null;                                  // humanized expires_at
   lastSyncLabel: string | null;                                   // from last_synced_at
   canPublish: boolean;                                            // connected && !reauth
   canReadResults: boolean;                                        // connected && has insights scope
   reconnectHref: string | null;                                   // /oauth/connect/{p}?mode=reconnect
   ```
   Per CLAUDE.md memory "Widening union → grep inequalities": `AriesChannelConnection.health` is unchanged (still 3-state); only additive fields. No literal-inequality risk.
2. `frontend/aries-v1/view-models/dashboard-home.ts`:
   - Extend `mapChannelConnection()` (`:146-171`) to populate the new fields from the `IntegrationCard` it already receives: `tokenValidity` from `card.health` (`healthy→valid`, `degraded→expiring`, `error→expired`, else `unknown`); `expiresAtLabel` from `card.expires_at`; `canPublish = card.connection_state === 'connected'`; `canReadResults = canPublish && card.permissions.some(p => p.granted && p.permission includes 'insights')` — **note**: per the MEMORY fact "Meta insights scopes missing", `canReadResults` will be `false` for FB/IG today; render it honestly as "Results read: not granted" rather than hiding it.
   - Add a `reconnect` block to the view-model's `channels` (`:104-109`):
     ```ts
     channels: {
       …,
       reconnect: {
         needed: boolean;                 // any card reauth_required/connection_error OR any health.pausedScheduledCount>0
         platformLabel: string | null;    // e.g. "Instagram", "Meta"
         tokenExpired: boolean;           // input A: connection-level
         scheduledPaused: boolean;        // input B: a real auth-failed scheduled post exists
         pausedCount: number;             // sum of pausedScheduledCount across channels
         href: string | null;            // reconnectHref of the first needing channel
       }
     }
     ```
   - `createDashboardHomeViewModel` (`:235-241`) gains an optional `channelHealth?: { channels: Array<{platform; pausedScheduledCount; lastAuthFailureAt}> }` arg (from endpoint A). When absent (flag OFF / not yet loaded), `scheduledPaused=false`, `pausedCount=0` — the banner can still fire on input A (token expiry) but won't claim "scheduled posts paused".
3. Keep all copy customer-safe; never leak a raw Meta code.

**Acceptance (unit, no DB):** in `tests/dashboard-home-view-model.test.ts` — a `reauth_required` IG card with `channelHealth` carrying `pausedScheduledCount:2` produces `channels.reconnect = { needed:true, platformLabel:'Instagram', tokenExpired:true, scheduledPaused:true, pausedCount:2 }`; a fully-connected set produces `needed:false`; a `reauth_required` card with NO paused posts produces `needed:true, scheduledPaused:false`.

### C — Dashboard reconnect banner (High, 3h)

**Implementation:**
1. New `<ChannelReconnectBanner/>` in `frontend/aries-v1/components.tsx` (sibling to `ChannelHealthIndicator`, `:540`). Amber/danger treatment, top-of-page, dismiss NOT offered (it must stay until resolved). Copy is assembled from `channels.reconnect`:
   - Both inputs true: **"Instagram needs reconnect — page token expired — scheduled posts paused — Reconnect Meta"** (exact roadmap-7 phrasing; `{pausedCount}` posts paused).
   - Token expired, nothing paused yet: "Instagram needs reconnect — page token expired — reconnect before the next scheduled post."
   - Paused but card not yet `reauth` (worker saw auth fail before card refreshed): "Publishing is paused — Meta rejected the last post for authentication — Reconnect Meta."
   - CTA button → `channels.reconnect.href` (`/oauth/connect/{platform}?mode=reconnect`). Brand-safe in-app link only.
2. `presenters/dashboard-home-presenter.tsx`: render `<ChannelReconnectBanner/>` above the hero **only when** `ARIES_CHANNEL_HEALTH_UI_ENABLED` (passed as a prop from the client, see E) **and** `model.channels.reconnect.needed`. When the flag is OFF, render nothing new (the existing per-channel amber link at `:600` is unchanged).
3. `frontend/aries-v1/home-dashboard.tsx` (`:21-54,106-118`): add a flag-gated `useChannelHealth()` hook fetch (new `hooks/use-channel-health.ts`, mirroring `hooks/use-integrations.ts`); thread its data into `createDashboardHomeViewModel({ …, channelHealth })` (the call site at `:46-52`); pass `channelHealthUiEnabled` into the presenter (props at `:107-118`).

**User-visible success bar (THIS is the done-signal):** on `/dashboard`, with the @sugarandleather IG connection in a `reauth_required` state and ≥1 scheduled post failed with `kind==='auth'`, a banner renders at the top reading "Instagram needs reconnect — page token expired — scheduled posts paused — Reconnect Meta" with a working Reconnect button that lands on the Meta OAuth reconnect flow. Verified rendered in Brendan's dashboard (screenshot), not by payload/DB.

### D — Enriched channel-integrations card (High, 4h)

**Implementation:** `frontend/aries-v1/channel-integrations-screen.tsx` — add a per-card health panel below the existing header row (`:147-196`), flag-gated so OFF = today's behavior:
1. **Token validity:** from `card.health` + `card.expires_at` → "Token valid · expires May 30" / "Token expiring soon" / **"Page token expired"** / "—".
2. **Last sync:** from `card.last_synced_at` (humanized) → "Last checked 2h ago" / "Not yet synced". (Note: `handlers.ts:208` currently hardcodes `last_synced_at: null`; render "Not yet synced" until a future sync-timestamp wiring lands — out of scope to populate it here, but the field is rendered so it lights up for free later.)
3. **Can publish:** `card.connection_state === 'connected'` → "Publishing: ready" / **"Publishing paused — reconnect required"**.
4. **Can read results:** honest per MEMORY "Meta insights scopes missing" → "Results read: not granted (insights scope pending)". Do not fake a granted state.
5. **Inline reconnect CTA** when `connection_state` is `reauth_required`/`connection_error` — reuse the existing `reconnect` action path (`:30-37`, `:184-193`) but add the explicit "Reconnect Meta — scheduled posts are paused" sublabel when endpoint-A data shows a paused count for this platform (thread `useChannelHealth()` into this screen too).

**Acceptance (rendered):** on `/dashboard/settings/channel-integrations`, an expired-token IG card shows "Page token expired", "Publishing paused — reconnect required", "Results read: not granted", and a Reconnect Meta button; a healthy FB card shows "Token valid", "Publishing: ready", "Results read: not granted". Verified rendered.

### E — Flag + docs + live verify + ship (Medium, 3h)

**Implementation:**
1. `ARIES_CHANNEL_HEALTH_UI_ENABLED` (default OFF). Read once server-side and passed to the client (mirror how other UI flags reach the app shell); when OFF: `use-channel-health.ts` does not fetch, the banner does not render, the enriched card panel does not render — the screen is byte-identical to today.
2. Document in `CLAUDE.md` "Environment Variables" (matching the existing flag-entry style), `.env.example`, and `docker-compose.yml`:
   > `ARIES_CHANNEL_HEALTH_UI_ENABLED=1` — renders the channel-health reconnect surface: a dashboard-top banner ("Instagram needs reconnect — page token expired — scheduled posts paused — Reconnect Meta") and per-channel token-validity / last-sync / can-publish / can-read-results facts on the Channels screen, consuming the already-shipped #519 `MetaPublishFailureKind === 'auth'` signal (`scheduled_post_dispatches.error_message` `auth:` tag) and the integrations-card token validity. Read-only; never auto-reconnects, never auto-publishes. Aries treats `1`/`true`/`yes`/`on` as enabled. Default OFF until verified on the live tenant.
3. Live verify on tenant 15 (@sugarandleather): with a real `reauth_required` IG connection and a real `auth:`-tagged failed `scheduled_post_dispatches` row, confirm the banner and enriched card render (screenshot in Brendan's dashboard). Then verify flag-OFF restores today's UI exactly.
4. `/ship-triage-deploy`; bump `VERSION` (minor — new route + UI + flag), `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ dashboard + channels screen unchanged; flag ON ⇒ banner + enriched card render with the exact reconnect copy on the live tenant; `full-suite` gate green.

## Feature Flag

`ARIES_CHANNEL_HEALTH_UI_ENABLED` — default **OFF**. Gates: the `useChannelHealth()` client fetch, `<ChannelReconnectBanner/>`, and the enriched-card health panel. OFF reproduces current behavior exactly (the pre-existing 3-state amber-dot card and `/oauth/connect?mode=reconnect` link are NOT behind the flag and remain). Treated as enabled for `1|true|yes|on` (match the existing parser style in `synthesize-publish-posts.ts:115-117` / `backend/memory/honcho-env.ts`). Process-wide, single-tenant prod.

## Testing Plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit (route, fake queryable) | `/api/integrations/health`: `auth:`+failed+pending → count 1; `transient:` → 0; `dispatched` parent → 0; cross-tenant excluded | +4 |
| Unit (view-model) | `channels.reconnect`: token-expired+paused → needed/scheduledPaused/pausedCount; connected → not needed; expired-no-paused → needed but scheduledPaused:false | +4 |
| Unit (view-model) | `mapChannelConnection` new fields: tokenValidity from health; canPublish; canReadResults honest-false for Meta | +3 |
| Unit (integrations card) | extend `tests/integrations-status.test.ts`: `expires_at`/`health` already-present fields surface unchanged (regression guard) | +1 |
| Component (render) | banner renders exact copy for both-inputs / token-only / paused-only; CTA href is in-app reconnect (never bare sugarandleather.com) | +3 |
| Component (render) | enriched card renders "Page token expired" + "Publishing paused" + reconnect CTA for reauth card; "ready" for connected | +2 |
| Live-DB (skip-guarded) | endpoint A against real DB precedent `tests/marketing/ingest-production-assets-live-db.test.ts` pattern (`t.skip` when DB env absent) | +1 |
| E2E (live, manual) | dashboard banner + channels card render on @sugarandleather with a real auth-failed scheduled post | manual |

**~18 automated + 1 manual.**

**Verify-suite wiring (important — `verify-regression-suite.mjs` is an explicit `steps` array, NOT a glob allowlist):**
- `tests/integrations-status.test.ts` is **already** in the "post-30-day-backlog contract regression tests" step (`verify-regression-suite.mjs:166`), so its regression-guard extension runs under `npm run verify` for free.
- `tests/dashboard-home-view-model.test.ts` is **not** currently in any verify step — its `channels.reconnect` / new-card-field extensions will run only in the **full CI glob** unless explicitly added. To gate them pre-push, add the new test files (route, banner, card, and — if the view-model coverage should be in the fast suite — `dashboard-home-view-model.test.ts`) as explicit entries to a `steps` group in `verify-regression-suite.mjs` (e.g. extend the post-30-day-backlog step's `args`, keeping it under the ~35s wall-clock budget, or add a dedicated "channel-health UI" step).

All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify`, then `npm run test:concurrent` before ship (touches a route + view-model + shared frontend). Then the **CI-exact** full set (this is the glob that runs the view-model + new component tests regardless of the verify-step wiring above):
```
APP_BASE_URL=https://aries.example.com tsx --test tests/*.test.ts tests/**/*.test.ts
```

## Rollout

1. Land A–E behind `ARIES_CHANNEL_HEALTH_UI_ENABLED=0` (dark). No behavior change on prod.
2. Verify on tenant 15 with the flag flipped ON in a scratch shell: real `reauth_required` IG + real `auth:` dispatch failure → banner + card render (screenshot).
3. Flip `ARIES_CHANNEL_HEALTH_UI_ENABLED=1` in `docker-compose.yml`, deploy, re-verify rendered.
4. `/context-save` after deploy (per Brendan's standing workflow).

## Rollback

- **Flag:** `ARIES_CHANNEL_HEALTH_UI_ENABLED=0` — instant kill switch; dashboard + channels screen revert to today's UI. No redeploy of code needed if the flag is env-driven.
- **Endpoint A:** read-only, additive route; removing its client call (via flag) makes it inert. No data written, nothing to reverse.
- **No schema change** ⇒ nothing to migrate down.

## Out of Scope

- **Populating `last_synced_at`** with a real timestamp — `handlers.ts:208` hardcodes `null`; this plan *renders* the field ("Not yet synced") so it lights up when a future sync-stamp wiring lands, but does not add that wiring.
- **Granting insights / `read_insights` scopes** — per MEMORY "Meta insights scopes missing", `canReadResults` is honestly `false` for FB/IG; obtaining scopes + App Review is #510's problem, not this plan's. This plan renders the truthful "not granted" state.
- **Auto-reconnect / token auto-refresh UX** — the refresh-sweeper (`backend/integrations/refresh-sweeper.ts`) is unrelated; this plan only surfaces the *need* to reconnect.
- **A standalone Launch-Readiness page** (build-first #3) — this plan establishes the `channels.reconnect` view-model field that page will reuse, but does not build the page.
- **Non-Meta channels** (LinkedIn/X/YouTube/Reddit/TikTok) — they have cards but no scheduled-dispatch auth path today; the banner keys off Meta's `auth` failures. The enriched card fields render generically but the "scheduled posts paused" clause is Meta-only.
- **Changing retry policy** — `kind` is surface-only; `retryable` still drives pending-vs-failed (unchanged, per `scheduled-dispatch/route.ts:237-241`).

## Risks

1. **Banner false-positive ("paused" when nothing is actually paused).** Mitigated by Decision 2: the "scheduled posts paused" clause requires input B (a real `auth:`-tagged failed dispatch with a still-blocked parent), not just a `reauth_required` card. The `sp.dispatch_status IN ('failed','pending','in_flight')` gate drops the banner once the post drains.
2. **Banner staleness after reconnect.** After an operator reconnects, the old `auth:`-tagged failed rows remain in history. Mitigated by the `dispatch_status` gate — a reconnect + successful re-claim flips the parent to `dispatched`, excluding it. Worst case: the banner persists until the next worker pass re-claims and succeeds (≤ one 60s tick + reclaim window). Acceptable; document it.
3. **Union-widening literal-inequality bug (repeat offender per MEMORY).** `AriesChannelConnection.health` stays 3-state and `MetaPublishFailureKind` is untouched — all new fields are additive, so the class of bug ("shipped same bug 3× via `=== '<old>'`") does not apply here. Still: grep `connection_state ===`/`health ===` call sites after the view-model edit to confirm no consumer assumed exhaustiveness.
4. **DB pressure from a new per-dashboard read (guardrail #1).** Endpoint A is one indexed `GROUP BY` over tenant-scoped pending/failed rows (small set), no `Promise.all`, fired once per dashboard load. Benchmark the endpoint, not just the query, against the `ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10` profile before flip.
5. **Treating mock-pass as done (MEMORY: only rendered UI counts).** The done-bar is explicitly the rendered banner + enriched card on the live @sugarandleather dashboard, screenshotted — not endpoint payload, not view-model unit green.

## Files Reference

| File | Change | Phase |
|------|--------|-------|
| `app/api/integrations/health/route.ts` + `handlers.ts` | NEW: read-only auth-paused rollup over `scheduled_post_dispatches` (tenant scoped via join to `scheduled_posts.tenant_id`) | A |
| `app/api/integrations/handlers.ts` (pattern ref `:226-236`, `mapState`/`mapHealth`) | reference only — card builder unchanged | A,B |
| `lib/api/aries-v1.ts:376-384` | extend `AriesChannelConnection` (tokenValidity, expiresAtLabel, lastSyncLabel, canPublish, canReadResults, reconnectHref) | B |
| `frontend/aries-v1/view-models/dashboard-home.ts:104-109,146-171,235-246` | `channels.reconnect` block; enriched `mapChannelConnection`; `channelHealth` arg | B |
| `hooks/use-channel-health.ts` | NEW: flag-gated client fetch of endpoint A (mirror `hooks/use-integrations.ts`) | C,D |
| `frontend/aries-v1/components.tsx` (near `ChannelHealthIndicator` `:540`) | NEW `<ChannelReconnectBanner/>` | C |
| `frontend/aries-v1/presenters/dashboard-home-presenter.tsx:515-610` | render banner above hero when flag ON + `reconnect.needed` | C |
| `frontend/aries-v1/home-dashboard.tsx:21-54,106-118` | wire `useChannelHealth`, thread `channelHealth` + flag prop | C |
| `frontend/aries-v1/channel-integrations-screen.tsx:30-37,147-196` | enriched per-card health panel (flag-gated) | D |
| `docker-compose.yml`, `.env.example`, `CLAUDE.md` | document `ARIES_CHANNEL_HEALTH_UI_ENABLED` | E |
| `tests/integrations-health-route.test.ts` | NEW (endpoint A, fake queryable) | A |
| `tests/dashboard-home-view-model.test.ts` | +`channels.reconnect` + new card fields | B |
| `tests/integrations-status.test.ts` | regression guard on existing card fields | B |
| `tests/channel-reconnect-banner.test.tsx` / `channel-card-health.test.tsx` | NEW (render assertions) | C,D |
| `scripts/verify-regression-suite.mjs`, `VERSION`, `CHANGELOG.md` | add new test files to a `steps` group + bump | E |

## Related

- #519 — Meta failure taxonomy + reconnect signal + `creative_asset_ids` backfill. **This plan renders the `kind==='auth'` signal #519 shipped.** Do not re-plan the classifier (`backend/integrations/meta-publishing.ts:128-173`) or the worker tagging (`scheduled-posts-worker.mjs:241-242`).
- `docs/plans/2026-05-30-publishing-reliability.md` — the plan that introduced the taxonomy + backfill. Its **P4** ("Wire taxonomy into handlers + worker surface") shipped the backend `auth:` tag + dispatch `kind`, and its Out of Scope (line 208) explicitly deferred "the OAuth reconnect UI is a separate workstream." This plan IS that deferred rendered-UI surface — it consumes P4's signal, it does not rebuild it.
- Roadmap 1b (public-trust: "expired tokens say Reconnect account not generic failed") and roadmap 7 (channel connection health impossible to miss) — both satisfied by the banner + enriched card.
- CLAUDE.md guardrails honored: no `Promise.all` DB fan-out (#1), treat-as-production (live-tenant render is the done-bar), brand URL `aries.sugarandleather.com` (in-app reconnect links only), no autonomous publish (surface-only), never expose `MARKETING_STATUS_PUBLIC=1`.
