<!-- /autoplan restore point: ~/.gstack/projects/DeliciousHouse-aries-app/claude-aries-live-social-sessions-9lqla6-autoplan-restore-20260720-150305.md -->
# Live Social Sessions — manage live broadcasts (Instagram Live, Facebook Live, …) from Aries

> Status: draft plan (2026-07-20). Net-new domain (`backend/live/`). Thesis: **managed where the platform API allows, honest companion everywhere else.** A live broadcast is a long-lived stateful external resource, not a one-shot publish — it gets its own tables, its own CAS state machine, and its own dormant sidecar worker. It never rides `posts`/`scheduled_posts`.

## Context

Operators run live sessions (IG Live, FB Live) as part of their marketing, and today Aries knows nothing about them: no scheduling, no reminders, no stream-credential handling, no post-live follow-up. Repo-wide grep for `live_video`, `rtmp`, `broadcast`, `live_media`, `liveStream`, `stream_key` confirms **zero live-broadcast code exists** — the only hits are marketing prose ("posts go live") and the Composio `publish_video` slot, which is VOD upload (`FACEBOOK_CREATE_VIDEO_POST`), not live streaming.

The feature: an operator can schedule a live session per connected platform, see it on the calendar, get Slack reminders, run a per-platform prep checklist, and — on platforms whose public API permits it, behind separate flags and external approvals — have Aries create the platform broadcast object, hand over RTMPS credentials safely, drive go-live/end from a control room, watch a polled viewer count, and capture the VOD into the existing insights pipeline.

**What each platform's public API actually permits (verified against official docs, July 2026) is the load-bearing constraint of this plan:**

| Platform | Tier | Reality (July 2026) |
|---|---|---|
| **Facebook Pages** | **Managed** (App-Review-gated) | Full lifecycle via the Live Video API: `POST /{page-id}/live_videos` (status `LIVE_NOW` / `SCHEDULED_UNPUBLISHED` + `event_params` UNIX start_time), per-broadcast RTMPS `secure_stream_url`, reschedule, `end_live_video=true`, status+`live_views` polling, `live_videos` page webhook, VOD via the `video` field. Gates: App Review for the **"Live Video API" feature** (must demonstrate a real RTMPS stream), `pages_manage_posts` + `pages_read_engagement` Advanced Access, and since 2024-06-10 the account must be ≥60 days old and the Page ≥100 followers. Traps: `planned_start_time` is DEAD (errors since v12.0 — use `event_params`); scheduling max 7 days out; VOD auto-deletes 30 days post-broadcast (policy since 2025-02-19); SSE comment endpoints removed — poll the comments edge. |
| **YouTube** | **Managed** (optional, go/no-go) | Genuinely full API: `liveBroadcasts.insert` (any horizon), `liveStreams.insert` → RTMP ingest + reusable stream key, `bind`, `transition` or `enableAutoStart/enableAutoStop`, `concurrentViewers`, chat, auto-archived VOD (broadcast id == video id, <12h). Gates: `youtube`/`youtube.force-ssl` are Google *sensitive* scopes (OAuth verification), 10k-unit/day project quota **shared across all tenants**, per-channel live-enablement (phone-verified, age 16+, 24h first-enable). Composio's YouTube toolkit has **no** liveBroadcasts/liveStreams actions (verified against the toolkit inventory 2026-07-20) → direct Google API via the legacy Aries-managed OAuth path. |
| **Instagram** | **Companion only** (permanent, by API design) | NO public API to create/schedule/start/stop a live or fetch stream keys. The only live surface (unchanged since 2021-11-09): read-only `GET /{ig-user-id}/live_media` **while broadcasting** (doubles as a go-live detector), live comment read/moderation, `live_comments` webhook. Requires the Instagram-API-with-Facebook-Login path (the newer Instagram-Login API does not list `live_media`). No VOD retrieval — only if the user manually reposts the replay. Stream keys exist only in Instagram Live Producer (manual copy). Unofficial private-API clients (instagrapi etc.) violate Meta ToS → banned from this design. |
| **LinkedIn** | Out of scope (business-dev gated) | A real Live Events API exists but only inside an approval-gated partner program (vetting + certification + broadcaster-side LinkedIn Live access). Applying is a business decision, not an engineering phase; `backend/live/providers/` leaves the seam. |
| **TikTok / X** | **Companion only** (permanent) | TikTok: no official LIVE API at all; stream keys are manual, follower-gated (~1k), expire ~2h. X: no public live API post-Periscope (v2 Spaces endpoints are read-only audio lookups); Live Studio (July 2026) is Premium-gated UI; the legacy partner API is closed to new integrators. |

**Honesty rule:** any UI copy implying Aries can start or fetch keys for IG/TikTok/X is a defect. Companion checklist copy is single-sourced in `backend/live/checklists.ts`.

## Who cares

- **Operators / @sugarandleather** — lives are scheduled in someone's head, reminders are manual, and post-live nothing links the replay to analytics. Companion mode alone (schedule + calendar + Slack reminders + checklist + promo posts + follow-up) is real value on every platform with zero new platform approvals.
- **The publish pipeline's integrity** — without a first-class model, the temptation is to shove a live into `scheduled_posts`, where the dispatch route would coerce it to a feed image (`app/api/internal/publishing/scheduled-dispatch/route.ts:369-371`) and the 15-min stale-`in_flight` reclaim would re-"start" a broadcast. This plan explicitly forbids that.
- **Roadmap** — live is the one content surface Aries has zero coverage for; FB managed mode rides the same App Review submission the native-reply scopes already need.

## Decisions (locked — do not re-litigate)

1. **Live sessions NEVER ride `posts`/`scheduled_posts`.** No CHECK-widening of `surface`/`media_type` (`scripts/init-db.js:727-732`). New tables + new state machine. The dispatch machine models a one-shot publish (30s/330s fetch ceilings, 15-min reclaim) — structurally wrong for an hours-long session.
2. **Two modes per session: `managed` | `companion`.** Platform tier table above is non-negotiable; it comes from API reality, not product preference. Companion ships first — it needs zero approvals and delivers on all platforms.
3. **Every platform mutation follows the meta-reply contract** (`app/api/insights/comments/[commentId]/reply/handler.ts`): atomically CLAIM via conditional UPDATE before the Graph call; Graph call OUTSIDE any held pool client; stamp platform id best-effort on confirmed success; `outcome_unknown` (2xx, no id) parks the record and is NEVER auto-retried; `definitely_never_posted` rolls the claim back. Graph has no idempotency keys — a reconciler leg adopts-or-cancels orphans as compensation.
4. **Every state transition is a CAS**: `UPDATE … WHERE id=$1 AND tenant_id=$2 AND state=$3 RETURNING …`. Double-clicks and concurrent workers lose the race; they never double-mutate. The pure transition table lives in `backend/live/state-machine.ts`.
5. **Monitor posture: never destructive on doubt.** State advances only on CONFIRMED platform status. A poll failure sets `monitoring_degraded` (loud, non-destructive); Aries never auto-ends a broadcast on a false positive. The abandon sweep is the one exception — after grace it cancels the *platform* object too, so a no-show never leaves a public FB announcement dangling.
6. **Stream keys are credentials.** Encrypted at rest via the existing `encryptToken`/`OAUTH_TOKEN_ENCRYPTION_KEY` substrate, isolated in their own table that list/detail queries never join, revealed only via a tenant_admin-only audited endpoint, never logged, scrubbed after terminal state. Re-reveal is allowed until terminal (show-once punishes a lost clipboard mid-OBS-setup); every reveal is audited.
7. **Aries never originates video.** No RTMP relay, no hosted encoder, no ffmpeg restream. The operator's encoder pushes bytes; the API mints credentials. (FB: API-created broadcasts auto-publish at start time when receiving stream data; YT: `enableAutoStart` makes bytes-arriving = live.)
8. **No websockets/SSE.** All monitoring rides the established polling idioms (Meta removed its SSE endpoints anyway). Client polls the detail route; a cooldown-guarded refresh route covers "right now".
9. **Roles:** all mutations `tenant_admin`, except checklist-item toggles (`tenant_analyst` allowed — day-of run-of-show is analyst work). Viewers read-only. Go-live/end stay admin-only in v1; revisit on operator feedback, not speculation. Flag-off 404 comes BEFORE the role check (the posting-times ordering convention, `app/api/marketing/posting-times/handler.ts:65-74`).
10. **Identity store:** FB managed mode requires the direct-OAuth page token in `oauth_connections` (the meta-publishing identity store, `backend/integrations/oauth-credentials.ts:4-43`). Composio-only tenants are detected at preflight and routed through the direct Meta connect flow with a reconnect attention state — never a silent failure. Composio live ops don't exist and slugs are never guessed (repo discipline).
11. **Promo + follow-up posts reuse the existing pipeline.** "Announce this live" / "Generate follow-up posts" fire the existing `one_off_post` flow with deterministic `createdBy` markers `live-promo:<sessionId>` / `live-followup:<sessionId>` + the `findRecentJobIdForTenant` re-fire collapse (the `reel:<jobId>` idiom). Generated posts go through normal review/approve/schedule with no special-casing.

## Current State (VERIFIED — master @ v0.1.31.0)

**Meta substrate (reusable as-is):**
- Graph transport: `requestGraphJson()` — `https://graph.facebook.com/{META_GRAPH_API_VERSION||v21.0}/…`, bounded 429/Retry-After backoff (max 5, 60s cap), 5xx retryable / 4xx not (`backend/integrations/meta-publishing.ts:287-350`).
- Per-tenant token: `getDecryptedAccessTokenContextForTenantProvider` — one SQL join `oauth_connections` (status `connected`) → latest non-revoked `oauth_tokens`, decrypted in-process (`backend/integrations/oauth-credentials.ts:4-43`). Stored token is a **Page token**; the user token is never persisted (`backend/integrations/meta/select-page.ts:130-135,151-156`).
- Failure taxonomy: `MetaPublishError{code,status,retryable,outcomeUnknown}` (`meta-publishing.ts:66-92`); 2-class `classifyMetaPublishFailure` + 4-class `classifyMetaPublishFailureKind` with `auth` = reconnect signal (`meta-publishing.ts:107-120,153-173`).
- Claim/rollback idempotency pattern proven in the native-reply handler (`app/api/insights/comments/[commentId]/reply/handler.ts`).
- Scopes today (`backend/integrations/provider-registry.ts:25-35,42-50`): **no `publish_video`, no live scope on any provider** (YouTube has only `youtube.upload`, `:71-78`). App-Review-gated scopes are marked with `// Inert until App Review` comments (`:30-31,45-46`).

**Scheduling/publishing (explicitly NOT reused for the session itself):**
- `posts`/`scheduled_posts` CHECKs: surface `feed|story|reel`, media_type `image|video` (`scripts/init-db.js:727-732`); dispatch route coerces unknown surface → `'feed'` (`scheduled-dispatch/route.ts:369-371`); worker reclaims stale `in_flight` after 15 min. All three make a live row structurally unsafe there.
- Reusable idioms: `FOR UPDATE SKIP LOCKED` claim, in_flight-before-network, `next_attempt_at` backoff, per-platform child rows, `INTERNAL_API_SECRET` timing-safe auth (`lib/internal-callback-auth.ts`).

**Composio path:** `connected_accounts` (UNIQUE(tenant_id, platform), no secrets by design, `backend/integrations/composio/connection-store.ts:1-11`); the `ComposioOperation` union has no live ops (`composio-config.ts:39-52`); `getPublishStatus` is a stub (`composio-publisher-provider.ts:800-811`). Not the substrate for live.

**UI:** three-layer idiom (server page → `'use client'` screen → shared primitives). Nav registration is **three places**: `APP_ROUTES` in `frontend/app-shell/routes.ts`, the `ICONS Record<AppRouteId,…>` and sidebar item arrays in `components/redesign/layout/app-shell-client.tsx:120-141`. Flags are read server-side and threaded as props (the `imageEditEnabled` example). No websocket/SSE anywhere; in-flight screens poll (5–15s `setInterval`). No secret-reveal drawer exists yet.

**Insights:** 30-min batch sidecar; `insights_posts.media_type` already documents `'live'` (`scripts/init-db.js:1067`) but `RawPost.mediaType` union excludes it (`backend/insights/adapters/_adapter.types.ts:57`) — the value is currently unreachable. `honcho-performance-worker` reads stored snapshots 24h–30d post-publish, so a bridged VOD row gets performance memory for free.

**Conventions:** flag parser + flag-off-404 (`backend/marketing/image-edit-env.ts:20-23`, reply handler `:71-75`); two-place env rule (compose `${VAR:-default}` + `.env.example`, pinned by `tests/deploy-manifest-parity.test.ts`); schema dual-ship (`scripts/init-db.js` applied path + `migrations/` record); dormant sidecar (idle-not-exit, `tickSafe`, own pool DB_POOL_MAX 3, compose service + deploy.yml force-recreate, parity-tested); verify-suite registration via explicit `{name, args}` steps; live-DB tests via `requireDbEnvOrSkip` + `tests/REQUIRES_INFRA.md`.

## Architecture (target)

```
app/dashboard/live (hub)  app/dashboard/live/[sessionId] (detail: pre-live / control room / recap)
        │ lib/api/live-sessions.ts + hooks/use-live-sessions.ts (useRequestState; 5–10s poll while live)
        ▼
app/api/live-sessions/* route.ts → handler.ts        [flag-off 404 → tenant → role]
        ▼
backend/live/  store.ts (CRUD + CAS)   state-machine.ts (pure transitions)
               checklists.ts (single-source honest copy)
               credentials.ts (encryptToken reuse; reveal audit)
               providers/facebook-live.ts   (requestGraphJson + MetaPublishError reuse)
               providers/instagram-live-detect.ts   (live_media polling, windowed)
               providers/youtube-live.ts   (optional phase)
        ▼                                    ▼
live_sessions  live_session_credentials  live_session_events  live_session_metrics
        ▲
scripts/automations/live-session-worker.ts  (dormant sidecar; per-leg isolation like insights-sync)
  legs: reminders → abandon sweep → [FB: materializer, monitor, orphan reconciler, credential scrub]
        ▲
docker-compose service aries-live-session-worker + deploy.yml force-recreate (parity-tested)

Post-live: monitor resolves LiveVideo.video → insights_posts bridge row (media_type 'live')
           → existing 30-min sync + comment classification + honcho-performance-worker cover analytics
Calendar:  liveSessions[] item type on GET /api/social-content/scheduled-posts (no stub posts rows)
```

## Child phases

| # | Phase | Priority | Effort | External gate | Dependencies |
|---|-------|----------|--------|---------------|--------------|
| V | **Validation gate**: confirm live usage with the live tenant(s); probe prod Page FB eligibility + Slack connection; set the kill/continue thresholds below | Critical | XS | none | none |
| 0 | Substrate: flags, scope, **companion-subset schema**, state machine, route skeletons | Critical | S | none | V |
| 1 | Companion core: CRUD + hub UI + calendar chips + **promo/follow-up buttons + ICS download** (worker-less; lazy reconcile-on-read) | Critical | M | none | 0 |
| 2 | Sidecar worker (one atomic PR): reminders + abandon sweep | High | M | none | 1 |
| 3 | Facebook managed lifecycle (**explicit go/no-go**, same posture as Phase 6): materializer, credentials, control room, monitor + reconciler + scrub | Medium | L | **Meta App Review (Live Video API + Advanced Access)** + go/no-go | 2 + kill/continue pass |
| 4 | Instagram detection + during-live comments (read-only) | Medium | M | none (rides existing scopes) | 2 |
| 5 | Post-live recap: VOD capture, insights bridge, dashboard section | High | M | none | 3 (FB VOD) / 4 (IG) |
| 6 | YouTube managed lifecycle (explicit go/no-go) | Low | L | **Google sensitive-scope verification + quota extension** | 2 + kill/continue pass |

```
V ──> 0 ──> 1 ──> 2 ──┬──> 3 (go/no-go) ──┬──> 5
                      ├──> 4 ─────────────┘
                      └──> 6 (go/no-go)
```

Companion phases (1–2) ship value on every platform with zero approvals — that is the point of the ordering. Phases 3 and 6 are **both** go/no-go-gated on demonstrated companion usage plus their external approvals; the FB-before-YT ordering is a default (it reuses the existing Meta token substrate the tenant already connects), revisitable at the go/no-go if validation shows the tenant's live platform is YouTube. Every phase gate includes a **platform-doc re-verification** item: the July-2026 API-reality table is perishable (Meta has repeatedly changed this exact surface — `planned_start_time` killed, SSE removed, 30-day VOD deletion added), so re-check the load-bearing doc claims for the platforms that phase touches before building.

### Kill/continue metrics (set at Phase V, measured after each flag-flip)

- **Phase 1–2 continue-gate:** ≥2 live sessions scheduled by a real tenant within 30 days of the master flag flipping on prod, and ≥1 promo/follow-up generation fired from a session. Below threshold → stop the program; keep the companion surface as-is (it is cheap to carry) and do not build Phases 3–6.
- **Phase 3/6 go-gate:** companion continue-gate passed AND the external approval granted AND the tenant's Page/channel passes the platform eligibility probe.
- These are usage gates, not vanity metrics: they exist so the program can fail cheaply instead of joining the dark-flag inventory.

---

### Phase V — Validation gate (XS)

1. Ask the live tenant(s) directly: do you run lives today, on which platform, how often, and what hurts (forgetting to promote? no follow-up? the scheduling itself)? Record the answers in this doc.
2. Probe the prod Page's FB eligibility signals cheaply with the existing page token (`fan_count` via `pages_read_engagement` for the 100-follower gate; the 60-day account age is not probeable — record it as asked-not-verified).
3. Check the tenant's Slack connection exists (`loadSlackConfigForTenant`) — without it the Phase 2 reminder leg is a no-op for that tenant; if absent, ICS download (Phase 1) is the only reminder channel until the email leg lands.
4. Set/adjust the kill-continue thresholds above with the operator's actual cadence in mind.

**Acceptance:** answers recorded in this doc; thresholds confirmed. If the answer is "we never go live and don't plan to" → stop here; the plan stays as a reviewed artifact.

### Phase 0 — Substrate (S)

1. `backend/live/live-sessions-env.ts`: `isLiveSessionsEnabled` / `isLiveFacebookManagedEnabled` / `isLiveIgDetectionEnabled` / `isLiveYouTubeManagedEnabled` — exact `1|true|yes|on` parser, default OFF (copy `image-edit-env.ts:20-23`).
2. Add `publish_video` to the facebook entry in `provider-registry.ts` with the established `// Inert until App Review` comment (needed for the Live Video API review track + scheduled-broadcast listing).
3. Schema dual-ship (`scripts/init-db.js` + `migrations/20260720000000_live_sessions.sql`) — **companion subset only**: `live_sessions` (with the state CHECK covering the full vocabulary so no later CHECK-widening migration is needed, but only companion/scheduling states reachable) + `live_session_events`. The managed-mode tables (`live_session_credentials`, `live_session_metrics`) ship in Phase 3's PR — they exist solely for managed mode and building them now would be dead schema if the go/no-go says no.
4. `backend/live/state-machine.ts`: pure `allowedTransition(from, to, source)` implementing the pinned transition table (see Autoplan Review Record). Sources: `operator | worker | reconciler | platform`. Idempotency key for create = **client-generated UUIDv4 minted ONCE per logical submission** (on drawer open / first submit) and **reused across retries** until success or form reset — a per-attempt mint would produce a fresh key on exactly the timeout-retry the key exists to dedupe (eng-voice F8). Retry-reuses-key is tested. All worker time predicates (grace windows, reminder offsets, staleness) evaluate against DB `now()`, never process clocks, so app/worker/DB clock skew cannot shift the abandon or reminder windows.
5. `backend/live/serialize.ts`: the single `serializeLiveSession()` every route returns through — the structural choke point the credentials-never-serialized test pins.
6. Route skeletons under `app/api/live-sessions/` returning the flag-off real 404. Input validation pinned: title ≤254 chars, `scheduled_start_at` future + ≤1 year, IANA timezone via the same validation `marketing_schedule` uses, platform from the CHECK enum.
7. Verify step: `{ name: 'live sessions substrate', args: ['--test', 'tests/live-state-machine.test.ts', 'tests/live-sessions-env.test.ts', 'tests/live-sessions-flag-off-404.test.ts'] }`.
8. Wire `ARIES_LIVE_SESSIONS_ENABLED` into the `aries-app` compose environment block + `.env.example`.

**Acceptance:** flag OFF ⇒ every route 404s before touching DB; state-machine unit tests enumerate the full legal-transition matrix; `npm run verify` green.

### Phase 1 — Companion core, worker-less (M)

1. `backend/live/store.ts`: tenant-scoped CRUD + CAS transitions; create is idempotent on `UNIQUE(tenant_id, idempotency_key)`.
2. `backend/live/checklists.ts`: per-platform checklist templates (IG Live Producer key instructions; TikTok LIVE Studio; X Live Studio; encoder settings for FB/YT) — the single source of honest copy.
3. Routes (thin `route.ts` + testable `handler.ts` with deps seams; order: flag-off 404 → `loadTenantContextOrResponse` → role):
   - `POST+GET /api/live-sessions` (create admin-only; list any role)
   - `GET+PATCH /api/live-sessions/[sessionId]` (PATCH admin; checklist-toggle sub-action allowed for analyst)
   - `POST /api/live-sessions/[sessionId]/cancel` (admin)
4. UI: new `AppRouteId 'liveSessions'` registered in all three places; `app/dashboard/live/page.tsx` (inherits onboarding gate; reads flags server-side, threads props) → `frontend/live/live-sessions-screen.tsx` (ShellPanel list: upcoming/past, state chips, countdowns) + `frontend/live/live-schedule-drawer.tsx` (platform picker with **honest capability cards**: "Full control" vs "Companion — you go live in the app; Aries handles promotion, reminders, checklist, follow-up"); `lib/api/live-sessions.ts` + `hooks/use-live-sessions.ts` on the `useRequestState` idiom.
5. **Presentation-only staleness (NO writes on read — eng-voice F15):** the read paths never mutate state (a viewer-role GET must not write; the source enum has no fitting value; and abandon semantics must not ship in Phase 1 without Phase 2's dry-run safety). Instead `serializeLiveSession()` derives an "effectively missed" presentation state for `scheduled` rows long past start; the Phase 2 sweep is the ONLY writer of `abandoned`.
6. Calendar: `liveSessions[]` as a **new item type** on the `GET /api/social-content/scheduled-posts` response (flag-gated, empty when off) rendered as read-only chips in the calendar view-model — no stub `posts`/`scheduled_posts` rows (avoids caption NOT NULL, approval gating, draft-expiry exposure, and the coerce-to-feed-image trap).
7. **Promo + follow-up buttons (moved here from Phase 5 — this is the differentiated piece and it is cheap):** "Announce this live" and (post-live) "Generate follow-up posts" fire the EXISTING `one_off_post` pipeline with `createdBy` markers `live-promo:<sessionId>` / `live-followup:<sessionId>` + the `findRecentJobIdForTenant` re-fire collapse. **Two safety pins the "normal machinery" claim requires (eng-voice F2 — verified against prod config):** (a) `orchestrator.ts` sets `publishingRequested: true` unconditionally for `one_off_post`, and prod ships `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1` — so without an override, one promo click auto-publishes unreviewed content; live-promo/live-followup jobs MUST set `publishingRequested: false` (review-required posture; the human clicks publish). (b) Mirror the `reel:` created_by scope-clamp for `live-promo:`/`live-followup:` prefixes in `synthesizePublishPostsFromContentPackage` — the 2026-07-13 incident proved Hermes can emit a rogue 7-post weekly package on a one-off job; a promo click must never synthesize more than its intended announcement post(s). Both behaviors are tested. This is what no free platform tool does: the content pipeline wraps the live moment — with a human still on the publish gate.
8. **ICS download** (accepted micro-expansion): a "Add to calendar" button downloads an `.ics` for the session (one util + one route + one button) — the reminder channel that works for every tenant, Slack or not.
9. UI states are explicit acceptance: hub loads with `LoadingStateGrid`, EMPTY via `EmptyStatePanel` ("No live sessions yet — schedule your first"), fetch-failure retry panel, per-card countdown, stale-monitor DEGRADED banner derived client-side from `state_updated_at` age — **scoped to worker-monitored states only** (managed `materializing`/`live`/`ending`, IG `live_detected`); a companion `live` session gets no worker writes for its whole broadcast and must never show a false stale warning (eng-voice F14).
10. **Hub hierarchy (5 bands, pinned):** (1) on-air hero row — any `live`/`live_detected` session: elapsed time, viewer count where known, one tap to detail; (2) needs-attention items (`attention_reason`/`monitoring_degraded`/reconnect) — always above upcoming; (3) next upcoming with countdown + ONE contextual primary action; (4) remaining upcoming; (5) past with recap links.
11. **Companion lifecycle buttons:** "I'm live now" and "Mark as done" on companion session detail (the operator IS the detector on TikTok/X and a fallback on IG). **Companion recap** ships in Phase 1, not Phase 5: "You went live on <platform>" header, detected-or-manual duration, replay-nudge checklist item, and "Generate follow-up posts" as the hero CTA; metrics appear only where they exist. Follow-up/promo buttons render an **inline job card** resolving the `live-promo:<id>`/`live-followup:<id>` job through the existing job-status idiom (Generating → In review with deep link → Scheduled) — never a button that fires into silence.
12. **Mode is derived, not picked:** platform capability × flag state × identity preflight decides `managed|companion`; FB/YT get an explicit "run this one manually" companion override; existing sessions never change mode retroactively when a managed flag flips on.
13. **State→label→tone table pinned** (extend/wrap `StatusChip`, never overload the post-status union): `scheduled`→"Scheduled", `materializing`→"Preparing", `ready`→"Ready to stream", `preview`→"Preview", `live`/`live_detected`→**"On air"** (red/rose tone — deliberately distinct from the emerald post-status "Live", which means *published* on the same calendar surface), `ending`→"Ending…", `ended`→"Done", `vod_ready`→"Replay ready", `canceled`→"Canceled", `failed`→"Failed", `abandoned`→**"Missed"** (neutral tone, blame-free, one-tap reschedule). Calendar chips are a separate `CalendarLiveItem` view-model type with a broadcast icon + "On air" tone, `href` to the session detail, and are excluded from the drag/reschedule affordances of post chips.
14. **Schedule drawer spec:** platform grid listing all supported platforms (companion needs no connection — the picker is NOT sourced from `connected_accounts`; connection-required note appears only under managed-capable picks) → capability card under the selection → title → date/time entered in tenant wall-time (reuse the `reschedule-drawer` wall-time idiom) → timezone defaulted from tenant, editable → inline field errors (existing create-form idiom) → on success, close and navigate to the session detail.

**Acceptance (rendered):** on a live tenant, schedule an IG companion session in the drawer → it renders in the hub with the honest companion badge and on the calendar as an "On air"-capable live chip; "I'm live now"/"Mark as done" drive the lifecycle; the companion recap renders with the follow-up hero CTA and its inline job card reaches "In review"; the `.ics` imports into Google Calendar; cancel works; analyst can tick checklist items, viewer cannot. Screenshot-verified.

### Phase 2 — Sidecar worker: reminders + abandon sweep (M, ONE atomic PR)

`scripts/automations/live-session-worker.ts` (tickSafe overlap guard; flag-off idles, never exits; own `pg.Pool` with compose `DB_POOL_MAX: 3`; `ARIES_LIVE_RUN_ONCE` smoke escape hatch) + compose service `aries-live-session-worker` + deploy.yml force-recreate block — **must land together**: `tests/deploy-manifest-parity.test.ts` fails verify until all three exist.

Legs (per-leg error isolation like insights-sync):
- **Reminders** — Slack pings at `ARIES_LIVE_REMINDER_OFFSETS_MINUTES` (default `1440,60,15`) via `loadSlackConfigForTenant`, deduped in the existing `slack_notifications` table on stable keys **`live:<sessionId>:<startEpoch>:<offsetMinutes>`** (`INSERT … ON CONFLICT DO NOTHING` — re-delivery safe). The key includes the scheduled instant so a **reschedule regains its reminders** (the old keys are consumed against the old time — eng-voice F9), and a session created inside its offset windows fires **only the nearest un-elapsed offset**, never a burst of all elapsed ones. **Block Kit shape pinned** (the reminder is the arc's most important touchpoint): session title, platform, local start time, countdown, deep link to `/dashboard/live/<sessionId>` (the approval-notification deep-link idiom); the T-15 variant leads with checklist state ("3 of 7 prep items unchecked"). Tenants without Slack are skipped (`no_tenant_config`), no global fallback — the Phase 1 ICS download is their channel. Email is a named follow-up, not v1.
- **Abandon sweep** — `scheduled`/`ready` sessions past start + `ARIES_LIVE_ABANDON_GRACE_MINUTES` (default 30) with no live transition → `abandoned` (companion: local flip only, and operator-marked-live sessions are always skipped; managed sessions in Phase 3 also cancel the platform object). **First prod enable runs one observation cycle with `ARIES_LIVE_ABANDON_DRY_RUN=1`** (read-only candidate counts, mirroring the draft-expiry convention) before committing — this sweep becomes destructive at the platform in Phase 3. **Blind-window guards (eng-voice F1, CRITICAL — the sweep must obey "never destructive on doubt" too):** the managed arm (a) never runs for a session with `monitoring_degraded` or a failed poll in the current tick, (b) performs its OWN fresh platform status read immediately before cancel and, on `LIVE`/receiving-stream, adopts the session as live instead of canceling, (c) treats a "cannot cancel an active broadcast" Graph error as adoption, not failure, and (d) the abandon leg is ordered AFTER the monitor leg in the tick so the freshest confirmed status always precedes any cancel decision.

Also in this PR: update CLAUDE.md guardrail #1's DB-pressure accounting with the new worker's `DB_POOL_MAX: 3` pool (every sidecar pool is budgeted there).

**Acceptance:** worker-tick tests with a fake clock/provider in verify; parity test green; dormant when flag off (one info line, no DB writes); dry-run tick logs candidates and mutates nothing.

### Phase 3 — Facebook managed lifecycle (L; go/no-go-gated + externally gated on Meta App Review)

Behind `ARIES_LIVE_FACEBOOK_MANAGED_ENABLED` (companion behavior byte-identical when off). **Go/no-go first** (same posture as Phase 6): companion kill/continue gate passed + App Review submission at least filed + the Phase V eligibility probe passed. **The one-sentence delta over Meta's free Business Suite / Live Producer** (which already does scheduling, keys, and go-live natively): Aries is the only place the live sits in the SAME pipeline as its promo posts, reminders, calendar, post-live analytics, and brand memory — plus automation Meta doesn't do (auto-materialize from a long-range slot, the abandon janitor that cancels a no-show's public announcement). If that sentence stops being true, the go/no-go answer is no.

This PR also ships the managed-mode schema deferred from Phase 0: `live_session_credentials` + `live_session_metrics` (dual-shipped, additive).

**Spike first (hard precondition):** live-verify `GET /{page-id}/live_videos?broadcast_status=[…]` against Graph v25.0 on an admin-owned Page — the reference page is documented-inconsistent, and the orphan reconciler depends on this listing. Re-verify the load-bearing FB doc claims (event_params scheduling, 7-day window, VOD retention) at the same time.

1. `backend/live/providers/facebook-live.ts` on `requestGraphJson` + `getDecryptedAccessTokenContextForTenantProvider` + `requireStringField(…, {outcomeUnknown:true})`:
   - Create/schedule: `POST /{page-id}/live_videos` `status=SCHEDULED_UNPUBLISHED&event_params=<unix start>` — **`planned_start_time` must not appear anywhere in the codebase** (dead since v12.0). Immediate go-live: `status=LIVE_NOW`.
   - Reschedule `POST /<id>?event_params=…`; end `end_live_video=true` (one-shot); cancel `SCHEDULED_CANCELED`/DELETE; status poll `?fields=status,live_views`.
2. Worker legs added:
   - **Materializer** — sessions >7 days out are held Aries-side (FB hard-caps scheduling at 7 days); inside the window at T-`ARIES_LIVE_MATERIALIZE_LEAD_HOURS` (default 24), CAS `scheduled→materializing`, create the LiveVideo outside any held pool client, stamp `external_broadcast_id` on confirmed id → `ready`. Definite failure → back to `scheduled` with `next_attempt_at` backoff. 2xx-no-id → `outcome_unknown`: stays `materializing` + attention; **never auto-retried**.
   - **Orphan reconciler** — adopts-or-cancels by listing the Page's scheduled broadcasts — the compensation for Graph having no idempotency keys. **Trust guards (eng-voice F3):** (a) *provenance* — Aries embeds a deterministic marker (`aries:live:<sessionId>`) in the broadcast `description` at create; the reconciler only ever cancels objects carrying an Aries marker — an operator's natively-scheduled Business Suite broadcast with a similar title is untouchable; (b) *no double-adoption* — partial UNIQUE on `(tenant_id, platform, external_broadcast_id) WHERE external_broadcast_id IS NOT NULL` makes double-mapping structurally impossible, and ambiguous multi-match resolves nearest-`scheduled_start_at`-wins; (c) *fallback* — if the Phase-3 spike finds the `broadcast_status` listing unreliable, `outcome_unknown` sessions park with attention for manual reconciliation (the meta-reply posture) instead of shipping a broken reconciler; (d) *zombie path* — `materializing` past `scheduled_start_at` + grace transitions to `failed` with attention (the sweep's `scheduled`/`ready` predicate never covered it). Also re-drives stale transitional states (`ending`) idempotently.
   - **Monitor** — polls status/`live_views` for in-window sessions only; advances state ONLY on confirmed platform status; poll failure → `monitoring_degraded` attention flag, never auto-end; samples `live_session_metrics` (viewer counts are not retroactive — sample or lose them).
   - **Abandon sweep (managed arm)** — cancels the FB platform object after grace, so the public announcement post never dangles.
   - **Credential scrub** — nulls `*_enc` columns `ARIES_LIVE_CREDENTIAL_SCRUB_HOURS` (default 24) after the session reaches `ended` **or** any terminal state (eng-voice F13 — `ended` is non-terminal for managed sessions awaiting a VOD, and a session whose VOD never materializes must not hold live RTMPS keys forever). The VOD resolver has a give-up bound (7 days): past it the session stays `ended` with a "replay unavailable" recap note and never reaches `vod_ready`.
3. Credentials: `backend/live/credentials.ts` encrypts `secure_stream_url` (+ backup) via `encryptToken` into `live_session_credentials`. `POST /api/live-sessions/[sessionId]/credentials/reveal` (tenant_admin-only) is **the only payload anywhere that carries key material** — the leak test pins this across `serializeLiveSession()` payloads AND the calendar's `CalendarLiveItem` shape (a different route/view-model — the choke-point claim must cover it too), AND asserts `live_session_events.detail_json`, `attention_reason`, and worker log lines never contain key material (eng-voice F17). The reveal response sets `Cache-Control: no-store`. Reveal has its own cooldown (`ARIES_LIVE_REVEAL_COOLDOWN_SECONDS`, default 5 — each call decrypts; an admin session must not be able to hammer it). Every reveal stamps `revealed_at`/`reveal_count` + an audit event (the event records THAT a reveal happened, never the material); re-reveal allowed until scrub; keys never logged.
4. Also: manual **"Prepare now"** button (operator-initiated early materialize, ≤7-day validation); preflight before materialize and go-live (`auth`-kind failures park the session with a "reconnect Facebook" attention state via `classifyMetaPublishFailureKind` reuse); eligibility preflight copy for the 60-day/100-follower gate (reads as a platform rule, not an Aries bug).
5. Control room UI: `app/dashboard/live/[sessionId]/page.tsx` → `frontend/live/live-control-room.tsx` — **three state-dependent layouts, not one static page** (design-voice F7): *pre-live* leads with checklist + reveal card + encoder **status ladder**; *on-air* leads with elapsed time + viewer count + End button, and the reveal card auto-collapses (re-expandable, still audited — keys on screen while live is noise and a leak vector); *ending/ended* shows the "Ending…" persistence state then hands off to the recap. **v1 FB go-live posture resolved (was open question #3): auto-publish-on-bytes.** There is NO "Go live" button for FB in v1 — the pre-live primary element is a status ladder driven by the status poll ("Waiting for your encoder… → Receiving stream → You're live"); `preview` stays in the CHECK but is unreachable in v1. "End broadcast" remains an explicit operator button (CAS-backed, confirm dialog). Viewer sparkline via 10s client poll of the detail route + `POST /api/live-sessions/[sessionId]/refresh` (server-side direct poll, per-session cooldown `ARIES_LIVE_REFRESH_COOLDOWN_SECONDS`, default 5). **Mobile-usable is acceptance, not polish** — the operator starting a live is holding their phone; reveal, countdown, and checklist must work one-handed on a phone viewport.
6. **Reveal card is a four-state component:** *locked* ("Credentials appear after preparation — <date>"), *preparing* ("Preparing…"), *ready* (masked value, show toggle + copy with "Copied ✓", re-reveal counter, "reveals are logged" note), *scrubbed/unavailable* (the pinned 409 `credentials_unavailable` copy — "Re-prepare the session"; never a raw 500).
7. **Announcement visibility (trust, not a knob):** from creation, a managed session's card/detail shows "Announces publicly on <date>" (T-`ARIES_LIVE_MATERIALIZE_LEAD_HOURS`); after materialization it flips to "Announced — view on Facebook" (deep link) and a Slack ping fires on key `live:<sessionId>:materialized`. A surprise public Page post is never acceptable.
8. **Failure-UX contracts:** CAS-conflict (409) responses from transition routes are stale-view signals — the client silently refetches and converges, never renders an error toast (the loser of a double-click race sees the winner's state). A *client* poll failure on the control room renders "Connection to Aries lost — your broadcast is unaffected" — visually distinct from `monitoring_degraded` (server-side) so an Aries hiccup never reads as a broadcast failure. Attention stacking: the reconnect CTA always wins the detail banner slot (it is the only actionable one); `monitoring_degraded` renders as an independent overlay chip; the hub row shows a single amber attention chip.

**Acceptance:** full lifecycle screenshot-verified on an admin-owned dev-mode Page (App Review not yet granted): schedule → auto-materialize → announcement visible on the Page → reveal → OBS pushes → live with viewer sparkline → end → `vod_ready`. Abandon a session → platform object canceled. Credentials absent from every list/detail payload (test-pinned).

### Phase 4 — Instagram detection + during-live comments, read-only (M)

Behind `ARIES_LIVE_IG_DETECTION_ENABLED`. IG has NO broadcast API — this phase is deliberately detection + follow-up only. **External-gate label corrected (eng-voice F5): the identity-store split applies here exactly as in Phase 3.** `live_media` requires the Instagram-API-with-Facebook-Login token from `oauth_connections`; Composio-only tenants (the prod default connect path) don't have one, and Composio has no live_media operation. Phase 4 therefore runs the same preflight + "connect direct Meta" reconnect-attention routing as Phase 3, and the phase's doc-recheck must verify whether `live_media` needs Advanced Access for non-app-role users.

1. `backend/live/providers/instagram-live-detect.ts`: worker leg polls `GET /{ig-user-id}/live_media` **only inside scheduled windows** (T-15m → T+4h) to bound Graph cost. Empty→present flips `scheduled→live_detected` with **nearest-`scheduled_start_at`-wins attribution** when windows overlap (one physical broadcast must never flip two sessions — the partial-unique index also binds `live_detected`, see Schema). Present→empty flips to `ended` only after **3 consecutive empty polls** (a phone-network blip mid-broadcast resumes; a single empty read must not trapdoor the session — eng-voice F11); an error read never flips state. The no-reopen loss (a live resumed after the debounce window is untracked) is accepted and documented.
2. During-live comments (read-only): ingested at **worker-tick granularity (~60s), not a 10s inner loop** — the tick model's overlap guard means a 10s loop inside a leg would starve every other leg for the duration of a broadcast (eng-voice F7). `ARIES_LIVE_COMMENT_POLL_MS` is dropped; the UX claim is "comments refresh about every minute." A detached per-session poll loop is a named follow-up if operators need faster. Comments upsert into `insights_comments` via the bridging `insights_posts` row — **the bridge-row substrate (RawPost.mediaType widening + creation rules) is a shared prerequisite that lands with whichever of Phase 4/5 ships first** (eng-voice F19; the dependency edge is real). FB during-live comments ride the same shape (`GET /<LIVE_VIDEO_ID>/comments?order=reverse_chronological` — SSE is dead). Inline reply rides the EXISTING native-reply substrate and stays hidden unless `ARIES_NATIVE_REPLY_ENABLED` + scopes granted — no new write path.
3. Post-live replay nudge: checklist item + Slack key `live:<id>:<startEpoch>:replay_nudge` — "share your replay as a video/reel"; operator picks the replay post from recent media to link it (no API path from a live to its archive exists; this stays honest/manual).

**Acceptance:** a real IG live started from the phone during a scheduled window flips the session to `live_detected` on the hub (rendered), comments appear read-only on the ~minute cadence, a simulated single-empty poll does NOT end the session, and a real ending flips to `ended` after the debounce.

### Phase 5 — Post-live recap + insights bridge + dashboard (M)

1. **VOD capture:** on FB `ended`, the monitor resolves the LiveVideo's `video` field → `external_video_id` → `vod_ready`, retrying on ticks until it resolves. The insights bridge row is created **only once the Video node id resolves — never keyed on the LiveVideo id** (avoids a re-key against `UNIQUE(tenant_id, platform, external_post_id)`).
2. **Insights bridge:** widen `RawPost.mediaType` to include `'live'` (`_adapter.types.ts:57`; DB + `PostMediaType` already accept it) and upsert the bridging `insights_posts` row with `platform_data.live_session_id`. **"Zero new sync code" was overstated (eng-voice F6, verified against the dispatcher):** the per-post metrics loop has no upper age bound and only advances its watermark on success, so a bridge row whose platform node dies (IG: immediately at live end; FB: at the 30-day VOD deletion) would be re-selected every 6 hours forever and mark every sync run `partial`. The bridge therefore ships WITH a sync-side terminal rule: `media_type='live'` rows are skipped after N consecutive fetch failures or past the platform retention horizon (FB: 30 days post-broadcast). Prerequisites made explicit: the bridge requires an `insights_accounts` row (`ensure-account.ts` path — tenants without insights connected simply don't get bridged, recap says "connect analytics"), and `published_at` (NOT NULL) sources from `actual_started_at`. Recap reads `insights_post_metrics_daily` latest-snapshot with an honest "refreshes on the 30-minute analytics sync" lag note.
3. **30-day retention countdown** (FB policy): recap shows days remaining; Slack reminder key `live:<sessionId>:vod_retention` at day 23 ("download/clip before FB deletes the replay").
4. **Dashboard:** a `live` section added to `DashboardHomeViewModel` + `createDashboardHomeViewModel` + presenter together (next upcoming, on-air indicator, needs-attention count).

(Promo/follow-up generation moved to Phase 1 — it is the differentiated piece and needs none of this phase's machinery.)

**Acceptance (rendered):** recap page shows peak viewers (from `live_session_metrics`), duration, VOD link, retention countdown; the dashboard live section renders.

### Phase 6 — YouTube managed (L, OPTIONAL — explicit go/no-go)

Gate: real tenant demand + Google sensitive-scope verification + quota-extension cost accepted. Behind `ARIES_LIVE_YOUTUBE_MANAGED_ENABLED`.

Mechanics (decided now so the go/no-go is about cost, not design): widen the YouTube scope set in `provider-registry.ts` to `youtube.force-ssl`; `backend/live/providers/youtube-live.ts` — **non-reusable per-session `liveStreams.insert`** (eng-voice F16: a reusable channel key copied into per-session `live_session_credentials` rows makes the scrub guarantee theater — the same key stays valid on the next session's row; per-session streams keep the credential model uniform: one key, one session, one scrub, at the cost of one extra insert per session; a per-channel reusable-key optimization with its own credential lifecycle is a named follow-up), `liveBroadcasts.insert` with `scheduledStartTime` (no 7-day cap — materialize at schedule time), `bind`, and **default posture `enableAutoStart`/`enableAutoStop`** (bytes-arriving = live; avoids the `errorStreamInactive` race); explicit `transition` only for frame-control operators. Monitor extends with a per-tick quota budget (10k units/day **shared across all tenants** — 60s sampling, chat deferred). Eligibility preflight surfaces 403 `liveStreamingNotEnabled` as "enable live streaming at youtube.com/features (can take 24h)". VOD is free (broadcast id == video id, auto-archived <12h).

## Feature flags (all default OFF, `1|true|yes|on` parser, two-place rule)

| Flag | Gates |
|---|---|
| `ARIES_LIVE_SESSIONS_ENABLED` | Master: routes 404, nav hidden, calendar item type empty. **Worker drain semantics (eng-voice F4):** flag off ⇒ the worker takes no NEW work but keeps running the scrub + abandon legs for existing in-flight/undrained rows (a frozen encrypted stream key and a publicly-announced orphan broadcast are worse than a few more ticks); once no in-flight rows remain it idles fully. Off-flip with a session `live` is documented: the operator ends via the platform natively; the abandon/monitor drain cleans local state. Tested explicitly ("flag off with in-flight sessions"). |
| `ARIES_LIVE_FACEBOOK_MANAGED_ENABLED` | FB Live Video API lifecycle (OFF until App Review grants) |
| `ARIES_LIVE_IG_DETECTION_ENABLED` | IG live_media detection + read-only comment ingest |
| `ARIES_LIVE_YOUTUBE_MANAGED_ENABLED` | Direct Google lifecycle (OFF until verification) |
| `ARIES_LIVE_WORKER_INTERVAL_MS` (60000) · `ARIES_LIVE_MATERIALIZE_LEAD_HOURS` (24) · `ARIES_LIVE_ABANDON_GRACE_MINUTES` (30) · `ARIES_LIVE_ABANDON_DRY_RUN` (0; first-enable observation cycle) · `ARIES_LIVE_CREDENTIAL_SCRUB_HOURS` (24) · `ARIES_LIVE_REFRESH_COOLDOWN_SECONDS` (5) · `ARIES_LIVE_REVEAL_COOLDOWN_SECONDS` (5) · `ARIES_LIVE_REMINDER_OFFSETS_MINUTES` (`1440,60,15`) · `ARIES_LIVE_RUN_ONCE` | Worker knobs (non-positive/unparseable → default). During-live comment ingest runs at worker-tick granularity (~60s) — the former 10s `ARIES_LIVE_COMMENT_POLL_MS` knob was dropped: an inner 10s loop would starve every other leg under the tick model's overlap guard |

## Schema (dual-shipped; split by phase)

**Phase 0 (companion subset):**
- **`live_sessions`** — `id`, `tenant_id` FK, `platform` CHECK (`facebook|instagram|youtube|tiktok|x|linkedin`), `mode` CHECK (`managed|companion`), `state` CHECK (full vocabulary — the CHECK covers managed states up-front so Phase 3 needs no CHECK-widening migration, but only companion/scheduling states are reachable until then; `followed_up` is NOT a state — see `followed_up_at`), `title`, `description`, `scheduled_start_at`, `timezone`, `external_broadcast_id`, `external_stream_id`, `external_video_id`, `checklist_json`, `attention_reason`, `monitoring_degraded`, `next_attempt_at`, `state_updated_at`, `followed_up_at` (stamp, works from both `ended` and `vod_ready`), `actual_started_at`/`actual_ended_at` (operator- or detector-recorded), `idempotency_key`, `created_by`, timestamps. `UNIQUE(tenant_id, idempotency_key)`; partial index on `scheduled_start_at` over active states (worker scan); **partial UNIQUE `(tenant_id, platform) WHERE state IN ('live','live_detected')`** — concurrent broadcasts per account structurally impossible, including detector-attributed ones (eng-voice F12); **partial UNIQUE `(tenant_id, platform, external_broadcast_id) WHERE external_broadcast_id IS NOT NULL`** — reconciler double-adoption structurally impossible (eng-voice F3b). The 23505 raised when a unique-index loser inserts/transitions maps to the same friendly 409 stale-view contract as a CAS loser — never a 500. FK actions: all four tables `ON DELETE CASCADE` from `organizations` (repo convention); tenant deletion cascades local rows while a materialized platform broadcast survives untouched — documented as accepted.
- **`live_session_events`** — append-only audit: `session_id`, `from_state`, `to_state`, `source` CHECK (`operator|worker|reconciler|platform`), `event_id` UNIQUE (idempotent re-delivery), `detail_json`, `created_at`.

**Phase 3 (managed mode — deferred so a no-go leaves no dead schema):**
- **`live_session_credentials`** — `session_id` PK/FK, `stream_url_enc`, `stream_key_enc`, `backup_url_enc`, `issued_at`, `expires_at`, `revealed_at`, `reveal_count`, `scrubbed_at`. Secrets isolated: no list/detail query ever joins this table.
- **`live_session_metrics`** — `session_id`, `sampled_at`, `concurrent_viewers`, `raw_status` (sparkline + peak-viewer recap).

**Explicit NON-changes:** `posts`/`scheduled_posts` CHECKs untouched; `connected_accounts` untouched; `slack_notifications` reused as-is with `live:<sessionId>:<kind>` keys. Phase 5 type-only widening of `RawPost.mediaType`.

## Testing plan

| Layer | What | Gate |
|---|---|---|
| Unit | state-machine full transition table; env parsers; checklist templates | verify |
| Unit (route) | flag-off 404 (before role check); cross-tenant 404; role matrix (admin/analyst/viewer) | verify |
| Unit (serializer) | **no payload except the reveal route ever carries key material** | verify |
| Unit (worker, fake provider+clock) | reminder dedupe keys; abandon sweep; materializer claim/rollback/outcome_unknown-parks; orphan adoption; monitor never-auto-ends on poll failure; credential scrub | verify |
| Live-DB (`requireDbEnvOrSkip`) | CAS race (two concurrent transitions, one wins); idempotent create; partial-unique live constraint | `test:requires-infra`, indexed in `tests/REQUIRES_INFRA.md` |
| Parity | worker ↔ compose ↔ deploy.yml (`deploy-manifest-parity.test.ts` — automatic) | verify |
| E2E (manual, per phase) | rendered acceptance bars above, screenshot-verified on a live tenant | phase done-signal |

Run `npm run verify` per change; `npm run test:concurrent` before ship (routes + backend + worker + shared helpers touched).

## Rollout

1. Land Phases 0–2 dark (`ARIES_LIVE_SESSIONS_ENABLED=0`). No behavior change.
2. Flip master flag on prod; verify companion flow rendered on @sugarandleather (schedule IG session → calendar chip → Slack reminders fire → checklist).
3. Submit Meta App Review (Live Video API feature + `publish_video` + Advanced Access; decide whether to bundle `pages_manage_engagement` for live replies) — external clock starts here, parallel to Phases 4–5.
4. On grant: dev-mode-verified Phase 3 flips `ARIES_LIVE_FACEBOOK_MANAGED_ENABLED=1`; screenshot-verify the full managed lifecycle on the live tenant.
5. Phase 6 go/no-go reviewed on demand signal.

## Rollback

- Any flag → `0` is an instant kill switch at its layer; master flag off restores byte-identical current behavior (routes 404, nav hidden, worker idles, calendar unchanged).
- Worker: dormant pattern means the compose service can stay deployed while disabled.
- Schema: additive tables only; nothing to migrate down. Credentials scrub leg limits residual secret surface even after disable.
- Platform side: cancel/DELETE endpoints exist for any materialized broadcast; the abandon sweep is the automated janitor.

## Out of scope

- LinkedIn Live (partner-program application = business decision; provider seam reserved).
- Programmatic TikTok/X lifecycle (no official API; unofficial clients banned).
- Aries-originated video (RTMP relay / hosted encoder / ffmpeg restream).
- Websockets/SSE; FB `live_comments` webhook ingestion; during-live comment **writes** beyond the existing native-reply substrate.
- Multi-Page/multi-channel destinations (`UNIQUE(tenant_id, platform)` stands).
- Live shopping, monetization, cuepoint ads, Super Chat, crossposting management, VOD clipping (needs net-new Hermes capability).
- Historical backfill; any change to the post publish pipeline or its guards.
- **Integrating a third-party streaming SaaS (StreamYard / Restream) instead of, or in addition to, the credential layer** — considered and documented: it adds a vendor + OAuth surface for a capability whose demand is unproven, and Aries's delta is the content pipeline around the live, not the streaming itself. Revisit only if Phase V/kill-continue data shows heavy live usage that the companion + FB managed tiers don't serve.

## Risks

1. **Meta App Review is the critical external blocker** for FB managed mode (demonstration RTMPS stream required; same class as the still-ungranted reply scopes). Mitigated by phase order: companion ships value regardless; Phase 3 lands dark and is dev-mode-testable on admin-owned Pages.
2. **Stream key leakage** — mitigated structurally (isolated table, encrypted at rest, audited admin-only reveal, scrub leg, serializer test pinning "no payload carries key material", never logged).
3. **Double-start / duplicate broadcasts** — CAS transitions + claim-before-call + never-retry-outcome_unknown + orphan reconciler + partial-unique live index.
4. **Stuck `live` records / crashed monitor** — confirmed-status-only advancement; `monitoring_degraded` is loud but non-destructive; reconciler re-drives stale transitional states; wrongly ending a live is treated as worse than stale state.
5. **Token expiry / revocation mid-flow** — preflight before materialize and go-live; `auth`-kind failures park with a reconnect attention state (taxonomy reuse), never silent-fail. Page tokens are long-lived, not immortal.
6. **FB platform traps** are encoded in code, not docs: `event_params` (not `planned_start_time`), 7-day window (Aries holds longer slots), 30-day VOD deletion (day-23 reminder), RTMPS-only, 60-day/100-follower eligibility gate surfaced as preflight copy.
7. **Rate limits / quota** — FB polling windowed + bounded 429 backoff + refresh cooldown; YT 10k-unit shared quota budgeted per tick, chat deferred (Phase 6 concern).
8. **Worker granularity (60s)** — state/viewer lag up to ~1 min; acceptable because go-live is operator-initiated (synchronous route) or encoder-initiated, and the refresh route covers "right now".
9. **Identity-store split** — Composio-only tenants have no page token in `oauth_connections`; preflight detects and routes through direct Meta connect (reconnect attention state).
10. **Scope-creep temptation on IG** — any "start IG live from Aries" ask is only satisfiable via ToS-violating private APIs; the design hard-commits to companion-only and the UI says so.

## Open questions (for review, not blockers)

1. App Review logistics: who produces the demonstration RTMPS stream, on which Page/app — and do we bundle `pages_manage_engagement` into the same submission?
2. Materialize lead time as product policy: is T-24h right for SMBs? (The surprise-announcement trust problem is solved by the Phase 3 announcement-visibility spec; this question is now only about the default number. Per-tenant settings-hub knob deferred to TODOS.)
3. ~~Preview flow~~ **RESOLVED (design phase):** v1 FB posture is auto-publish-on-bytes with a status ladder; no Go live button; `preview` unreachable in v1.
4. ~~FB eligibility preflight~~ **RESOLVED (premise gate):** probed at Phase V via `fan_count`; account age recorded as asked-not-verified.
5. Credential policy: is 24h post-terminal scrub aggressive enough, and should `reveal_count > N` raise an attention flag?

## External blockers (tracked as first-class plan items)

- **Meta App Review** — Live Video API feature + `publish_video` + Advanced Access (`pages_manage_posts`, `pages_read_engagement`): assign an owner + demo Page before Phase 3 is scheduled.
- **Google OAuth verification + quota extension** — gates Phase 6 only.

## Files reference

| File | Change | Phase |
|---|---|---|
| `backend/live/live-sessions-env.ts` · `state-machine.ts` · `store.ts` · `checklists.ts` · `credentials.ts` · `reconciler.ts` · `providers/{facebook-live,instagram-live-detect,youtube-live}.ts` | NEW domain | 0–6 |
| `backend/integrations/provider-registry.ts` | +`publish_video` (`// Inert until App Review`); Phase 6: `youtube.force-ssl` | 0, 6 |
| `scripts/init-db.js` + `migrations/20260720000000_live_sessions.sql` | 4 new tables (dual-ship) | 0 |
| `app/api/live-sessions/**` (route.ts + handler.ts pairs: root, [sessionId], cancel, credentials/reveal, go-live, end, refresh) | NEW | 1, 3 |
| `app/dashboard/live/page.tsx` + `app/dashboard/live/[sessionId]/page.tsx` | NEW server pages | 1, 3 |
| `frontend/live/{live-sessions-screen,live-schedule-drawer,live-control-room}.tsx` | NEW screens | 1, 3 |
| `lib/api/live-sessions.ts` + `hooks/use-live-sessions.ts` | NEW client | 1 |
| `frontend/app-shell/routes.ts` + `components/redesign/layout/app-shell-client.tsx` | nav registration (3 places) | 1 |
| `app/api/social-content/scheduled-posts/route.ts` + calendar view-model/screen | `liveSessions[]` item type | 1 |
| `scripts/automations/live-session-worker.ts` + `docker-compose.yml` service + `.github/workflows/deploy.yml` | NEW sidecar (one atomic PR) | 2 |
| `backend/insights/adapters/_adapter.types.ts` | `RawPost.mediaType` +`'live'` | 5 |
| `frontend/aries-v1/view-models/dashboard-home.ts` + presenter | `live` section | 5 |
| `scripts/verify-regression-suite.mjs` · `tests/REQUIRES_INFRA.md` · `.env.example` · `CLAUDE.md` · `VERSION` · `CHANGELOG.md` | conventions | all |

## Related

- `docs/plans/2026-05-30-story-reel-video-publishing.md` — closest shipped prior art: surface axes, fail-closed media validation, claim/rollback/outcomeUnknown contract, flag-gated-strip rollout. Live reuses its contracts but not its tables.
- `app/api/insights/comments/[commentId]/reply/handler.ts` — the Graph-mutation idempotency pattern this plan generalizes to a lifecycle.
- `docs/plans/2026-06-01-channel-health-reconnect-ui.md` — the reconnect attention surface FB managed preflight will link into.
- Platform doc sources are recorded in the research bundle (Meta Live Video API, IG Platform live_media/changelog, YouTube Live Streaming API, LinkedIn Live Events, TikTok/X developer docs — retrieved 2026-07-20).

---

# Autoplan Review Record (2026-07-20)

> Generated by `/autoplan` (CEO → Design → Eng pipeline, auto-decisions per the 6 principles; Codex CLI absent → all outside voices are Claude-subagent-only, tagged `[subagent-only]`). DX phase skipped — the feature is operator-facing SaaS UI, not a developer-facing surface (the plan's API/flag mentions are internal implementation, not a developer product).

## Phase 1 — CEO Review (mode: SELECTIVE EXPANSION)

### 0A Premise Challenge

| # | Premise | Status |
|---|---------|--------|
| P1 | Operators want to run live sessions and manage them from Aries | **ASSUMED — weakest premise.** Zero live mentions in the PRD, no qa-defect requests. Mitigated by phasing: the companion slice is cheap and generically useful; managed tiers are demand-gated. Surfaced at the premise gate. |
| P2 | "Live" = live broadcasts (IG Live, FB Live, …) | Confirmed by the user directly. |
| P3 | Companion mode has standalone value without managed control | Plausible but bounded: with Slack-only reminders, a tenant without a Slack connection gets scheduling + checklist + calendar only. Honest cap; email reminders deferred to TODOS. |
| P4 | Platform API reality (IG none / FB gated / YT full / TikTok+X none / LinkedIn partner-gated) | **VERIFIED** against official docs 2026-07-20 (sources in research bundle). Strongest premise. |
| P5 | Live sessions must not ride `posts`/`scheduled_posts` | **VERIFIED** structurally (CHECK constraints, coerce-to-feed trap, 15-min reclaim re-"start" hazard). |
| P6 | Meta App Review will eventually grant the Live Video API feature | Uncertain (reply scopes still pending months later). Mitigated: Phase 3 is dev-mode-testable on admin-owned Pages; do not schedule Phase 3 until the submission is filed. |

### 0B Existing Code Leverage (what already exists)

Graph transport + 429 backoff (`requestGraphJson`), per-tenant page-token retrieval, `MetaPublishError`/failure-kind taxonomy, claim/rollback/outcome-unknown mutation contract (native-reply handler), token encryption substrate (`encryptToken`), dormant-sidecar pattern + deploy parity test, `slack_notifications` dedupe table, per-tenant Slack config resolver, `one_off_post` promo pipeline with `createdBy` markers + re-fire collapse, insights sync + `honcho-performance-worker` (post-live analytics ride free via the bridge row), calendar read route, three-layer UI idiom + `useRequestState` hooks, flag parser + flag-off-404 + two-place env + dual-ship migration conventions. Nothing in this plan rebuilds an existing flow.

### 0C Dream State

```
CURRENT STATE                      THIS PLAN                          12-MONTH IDEAL
Aries manages async posts     ---> Live sessions are a first-class ---> Live is a peer content surface:
end-to-end; zero live              domain: managed FB (+opt YT),        same calendar, same promo pipeline,
coverage anywhere                  honest companion IG/TikTok/X,        same insights + taste learning;
                                   post-live analytics via bridge       LinkedIn partner status; Hermes
                                                                        clip generation from VODs
```
The plan moves directly toward the ideal; the provider seam and bridge row are the platform pieces later phases build on.

### 0C-bis Implementation Alternatives

```
APPROACH A: Companion-only (Phases 0-2, stop there)
  Effort: S-M   Risk: Low
  Pros: zero platform approvals; fastest value; no Graph mutations at all
  Cons: never manages a broadcast; "glorified calendar entry" ceiling
  Reuses: calendar, Slack, checklists

APPROACH B (CHOSEN): Tiered managed-where-the-API-allows (this plan)
  Effort: M-L phased   Risk: Med (external App Review)
  Pros: A is literally its first two phases; honest per-platform ceiling; full FB/YT control when granted
  Cons: state machine + worker + credentials handling complexity
  Reuses: everything in 0B

APPROACH C: Managed-first (FB Live Video API end-to-end before any companion UI)
  Effort: L   Risk: High
  Pros: deepest single-platform demo
  Cons: zero shippable value until App Review grants; inverts value/risk
```
**RECOMMENDATION: B** — A is a strict prefix of B (not a competing approach), C inverts value/risk. Auto-decided (P1 completeness, P6 bias-to-action); not a taste decision because A⊂B.

### 0D Selective-expansion scan (cherry-picks, auto-decided per blast-radius rule)

| Candidate | Effort | Decision |
|---|---|---|
| ICS calendar-file download for a scheduled session ("Add to Google Calendar") | S (1 util + 1 route + 1 button) | **ACCEPTED** — in blast radius, <5 files, no new infra; folded into Phase 1 |
| Email reminder leg (beyond Slack) | M (no email substrate exists) | Deferred → TODOS |
| Per-tenant materialize-lead-time settings card | M | Deferred → TODOS (open question #2 stands) |
| VOD download/archival into `DATA_ROOT` before FB's 30-day deletion | M-L (storage) | Deferred → TODOS |
| Public countdown/on-air page | M (no public surface fits) | Skipped |
| Live performance → taste/Honcho memory | free | Already covered — bridge row is swept by `honcho-performance-worker` |
| Hermes clip generation from VOD | L | Already out of scope (kept) |

### 0E Temporal Interrogation → decisions resolved into the plan body

1. **Transition table pinned** (was prose-only): see the state-machine table added to Phase 0 below.
2. **Idempotency key**: client-generated UUIDv4 minted by the schedule drawer per submission attempt (NOT a deterministic hash — two intentional sessions on the same platform/time must not collapse).
3. **Serializer**: one `serializeLiveSession()` in `backend/live/serialize.ts`; every route returns through it; the credentials-never-serialized test pins this single choke point.
4. **Reveal decrypt failure** (e.g. `OAUTH_TOKEN_ENCRYPTION_KEY` rotation): 409 `credentials_unavailable` + `attention_reason='credentials_unavailable'` — never a raw 500, never silent.
5. **PATCH reschedule propagates**: when `external_broadcast_id` exists, PATCH must call the provider reschedule (`POST /<id>?event_params=…`) under the same claim/CAS contract; local-only reschedule of a materialized session is a defect.
6. **Input validation pinned**: title ≤254 chars (FB cap), `scheduled_start_at` in the future and ≤1 year out, timezone validated against the same IANA validation used by `marketing_schedule`, platform from the CHECK enum.

### Phase 0 addition — legal transition table (source: operator O, worker W, reconciler R, platform P)

```
draft        → scheduled(O), canceled(O)
scheduled    → materializing(W,O via Prepare-now), live_detected(W: IG detect),
               live(O: companion "I'm live now"), ended(O: companion "Mark as done"),
               canceled(O), abandoned(W), failed(W: permanent error / retries exhausted — e.g. the
               60-day/100-follower eligibility rejection surfaces as "Facebook rejected the broadcast",
               never loops silently and never mislabels as "Missed")
materializing→ ready(W,R), scheduled(W: definite TRANSIENT create failure, with backoff),
               failed(R: unrecoverable; W: past start + grace — the zombie path)
failed       → scheduled(O: reschedule — the operator's recovery exit; resets attention)
ready        → preview(O), live(W: platform confirms), canceled(O: cancels platform object), abandoned(W: cancels platform object)
preview      → live(O / W platform confirm), canceled(O)   [preview is unreachable in v1 — kept in the CHECK like the managed states]
live         → ending(O end), ended(W: platform confirms LIVE_STOPPED/VOD; O: companion "Mark as done")
ending       → ended(W,R)
ended        → vod_ready(W: video id resolves)
live_detected→ ended(W: live_media empty; O: companion)
Terminal: vod_ready, canceled, failed, abandoned (credential scrub applies); ended is terminal for companion.
Follow-up is a TIMESTAMP (`followed_up_at`), not a state — a state raced `vod_ready` on managed sessions and made the
follow-up CTA state-mutating; a stamp works from ended AND vod_ready (design-voice F9).
Companion operator transitions ("I'm live now" / "Mark as done") exist because TikTok/X have no detection and IG detection
can miss — without them the abandon sweep flags an operator abandoned MID-BROADCAST (design-voice F1, CRITICAL).
The abandon sweep skips any session the operator marked live.
Illegal everywhere else — CAS enforces; `allowedTransition` is the single source; the state-machine test enumerates the full matrix.
Cancel is only legal from pre-live states (draft/scheduled/materializing/ready/preview) — a live broadcast is ended, never canceled.
```

### Sections 1–11 findings (auto-decided; each folded into the plan body)

- **S1 Architecture** — dependency graph below; coupling one-directional into existing substrates (justified). **Finding S1-a:** a dead worker means nobody sets `monitoring_degraded`; the hub/detail UI must ALSO derive a client-side "monitoring stale" warning from `state_updated_at` age for in-flight states (worker self-report is not the only signal). Folded into Phases 1/3 UI.
- **S2 Error & Rescue** — registry below. Gap found and fixed: reveal-decrypt failure path (0E item 4). Slack outages best-effort by existing contract; Graph failures classified by the existing taxonomy; no catch-all handlers introduced.
- **S3 Security** — reveal is admin-only + audited + rate-limited by cooldown; IDOR blocked by tenant-scoped loads (cross-tenant-404 test); validation pinned (0E item 6); zero new dependencies; stream keys follow the credentials contract. No open findings.
- **S4 Data flow & interaction edge cases** — double-click/CAS, duplicate create/idempotency key, stale-CSRF n/a (same-origin route handlers + session auth), navigate-away-mid-reveal (re-reveal until terminal), worker-crash-mid-materialize (reconciler adopts), reschedule-after-materialize (0E item 5), cancel-after-live (illegal, table above), DST (offsets computed against the stored UTC instant). Calendar `liveSessions[]` honors the same from/to window params as scheduled posts.
- **S5 Code quality** — companion states kept separate from managed states deliberately (detector-driven and lossy; merging them would fake precision). No DRY violations: transport/crypto/Slack/promo all reused, not re-implemented.
- **S6 Tests** — two additions to the testing plan: (a) PATCH-reschedule-propagates-to-platform test (fake provider asserts the reschedule call), (b) reveal-after-scrub returns 409/410, not decrypted nulls. 2am-Friday test = the live-DB CAS race; hostile-QA test = viewer-role reveal + cross-tenant id probes; chaos test = kill worker mid-materialize, assert reconciler adoption.
- **S7 Performance** — no `Promise.all` fan-outs anywhere; worker scan uses the partial index; comment polling bounded by the partial-unique live constraint (≤1 live per tenant×platform); refresh route cooldown floors. **Finding S7-a:** CLAUDE.md guardrail #1's DB-pressure accounting must be updated to include the new worker's `DB_POOL_MAX: 3` pool when the compose service lands (Phase 2). Folded into Phase 2.
- **S8 Observability** — `live_session_events` is the reconstruction trail (3-weeks-later debuggability: yes — every transition, source, and reveal is an event row). **Finding S8-a:** the abandon sweep cancels PLATFORM objects — destructive; adopt the repo's first-enable convention: `ARIES_LIVE_ABANDON_DRY_RUN=1` observation cycle before committing, mirroring `ARIES_DRAFT_EXPIRY_DRY_RUN`. Folded into flags + Phase 2.
- **S9 Deployment** — additive schema only; worker lands as one atomic PR (parity-tested); flags default OFF; post-deploy smoke = flag-off 404 checks + `ARIES_LIVE_RUN_ONCE`. No open findings.
- **S10 Long-term** — reversibility 4/5 (flags + additive tables); provider seam carries LinkedIn later; the bridge row makes live a peer of posts in every downstream analytics/memory system for free. No debt flagged.
- **S11 Design/UX** — **Finding S11-a:** interaction-state coverage was implicit; now explicit — hub EMPTY ("No live sessions yet — schedule your first"), reveal ERROR (`credentials_unavailable` copy), DEGRADED (stale-monitor banner), control-room SUCCESS/PARTIAL states. **Finding S11-b:** the control room MUST be mobile-usable — the operator starting an IG live is holding their phone; the reveal card, countdown, and checklist must work one-handed on a phone viewport. Folded into Phases 1/3 acceptance.

### Architecture diagram (S1 required output)

```
                    app/dashboard/live  ──────  app/dashboard/live/[sessionId]
                          │  lib/api/live-sessions.ts + hooks (poll 5–10s while live)
                          ▼
                 app/api/live-sessions/* (flag-404 → tenant → role → serializeLiveSession())
                          ▼
   ┌──────────────── backend/live/ ────────────────┐
   │ store.ts (CAS)   state-machine.ts (pure)      │
   │ serialize.ts     checklists.ts   credentials.ts│──encryptToken──▶ live_session_credentials
   │ providers/facebook-live.ts ──requestGraphJson──┼──▶ Meta Graph (reuses 429 backoff + taxonomy)
   │ providers/instagram-live-detect.ts ────────────┼──▶ GET /{ig}/live_media (windowed)
   │ providers/youtube-live.ts (opt) ───────────────┼──▶ Google Live Streaming API
   └───────────────┬────────────────────────────────┘
                   ▼
   live_sessions  live_session_events  live_session_metrics
                   ▲
   scripts/automations/live-session-worker.ts (legs isolated: reminders │ abandon │ materialize │ monitor │ reconcile │ scrub)
                   │ Slack via loadSlackConfigForTenant + slack_notifications dedupe
                   ▼
   ended → video id → insights_posts bridge row → existing 30-min sync / classifier / honcho worker
```

### Error & Rescue Registry (S2 required output)

```
CODEPATH                         | FAILURE                          | CLASS/CODE                  | RESCUED? | ACTION                                        | USER SEES
facebook-live.createBroadcast    | 429 rate limit                   | MetaPublishError retryable  | Y        | bounded Retry-After backoff (transport)       | nothing (worker retries next tick)
                                 | 4xx permanent                    | graph_api_error !retryable  | Y        | CAS back to scheduled + next_attempt_at, then failed | attention: "Facebook rejected the broadcast"
                                 | 2xx no id                        | outcomeUnknown              | Y        | park materializing; reconciler adopts/cancels | attention: "needs reconciliation" (auto-resolves)
                                 | token missing/revoked            | oauth_token_missing (auth)  | Y        | park + attention                              | "Reconnect Facebook" CTA
facebook-live.endBroadcast       | network error                    | graph_network_error         | Y        | state stays ending; worker/reconciler re-drive| "Ending…" persists, degraded banner if stale
credentials.decrypt (reveal)     | key rotation / corrupt ciphertext| CredentialsUnavailable      | Y        | 409 credentials_unavailable + attention       | "Credentials unavailable — re-prepare the session"
worker tick (any leg)            | leg throws                       | per-leg isolation           | Y        | log + continue other legs (insights-sync idiom)| nothing; next tick retries
worker down entirely             | —                                | client-side staleness check | Y        | hub derives stale-monitor from state_updated_at| "Monitoring stale" banner
instagram-live-detect poll       | Graph error                      | logged, non-fatal           | Y        | skip window tick; never flips state on error  | nothing
Slack reminder                   | Slack outage                     | client never throws         | Y        | skipped; dedupe row absent → retried next tick| late/no ping (documented best-effort)
insights bridge upsert           | video id not yet resolvable      | expected                    | Y        | retry on monitor ticks until resolves         | "metrics pending" on recap
```

### Failure Modes Registry (critical-gap scan)

```
CODEPATH                  | FAILURE MODE                | RESCUED? | TEST? | USER SEES?              | LOGGED?
materializer              | crash mid-create            | Y (reconciler) | Y (chaos test) | attention state       | events row
go-live double-click      | concurrent CAS              | Y        | Y (live-DB race) | one winner           | events row
abandon sweep             | cancels wrong session       | Y (predicate re-check + DRY_RUN first-enable) | Y | dry-run log | events row
reveal after scrub        | decrypt of nulls            | Y (409/410) | Y | "credentials expired"     | events row
monitor false-end         | poll failure ≠ ended        | Y (never auto-end) | Y | degraded banner       | events row
NO CRITICAL GAPS — every row is rescued, tested, visible, and logged.
```

### NOT in scope (CEO record — beyond the plan's Out-of-scope list)

Email reminders (TODOS), per-tenant lead-time knob (TODOS), VOD archival to DATA_ROOT (TODOS), public countdown page (skipped), live-shopping/monetization (already out), unofficial APIs (banned).

### Dream state delta

This plan lands the domain, the FB managed tier (pending review), and the analytics bridge — roughly 70% of the 12-month ideal. Remaining: YouTube go/no-go, LinkedIn partner program, Hermes clip generation, email reach.

### CEO dual voices — `[subagent-only]` (Codex CLI absent)

See consensus table below the Decision Audit Trail. Independent Claude CEO subagent findings and dispositions are logged in the Decision Audit Trail.

## Phase 2 — Design Review (classifier: APP UI; 7 passes)

| Pass | Rating | Disposition |
|---|---|---|
| 1 IA | 7→10 | Hierarchy pinned per screen (below); nav placement decided: **primary sidebar section, adjacent to Calendar** (it is an operator workflow surface, not a setting) |
| 2 States | 6→10 | Interaction-state table added (below) |
| 3 Journey | 8 | Storyboard below; two break-risks fixed (reveal-under-stress, abandoned-shame) |
| 4 AI-slop | 8→9 | App-UI rules hold (ShellPanel/StatusChip/drawer idiom reused; capability cards ARE the interaction so cards are earned). One risk pinned: the recap must use the existing insights stat idiom — numbers first, no decorative stat-tile mosaic, no ornamental icons |
| 5 System alignment | 8 | All primitives existing; two NEW components named: countdown, secret-reveal card (spec below); sparkline uses the Recharts already in the stack |
| 6 Responsive/a11y | 6→9 | Mobile control room already acceptance; added: ≥44px touch targets on reveal/copy actions, `aria-live="polite"` countdown, sparkline always paired with the numeric viewer count, drawer keyboard-dismiss per existing idiom |
| 7 Unresolved decisions | — | All resolved (rows 23–26 in the audit trail) |

**Screen hierarchies (Pass 1):** Hub = 1) next-session hero (countdown + ONE contextual primary action: Prepare→Reveal→Go live as state advances), 2) upcoming list, 3) past sessions with recap links. Drawer = 1) platform picker with capability badge, 2) title/time/timezone, 3) checklist preview. Control room = 1) state + countdown, 2) reveal card, 3) go-live/end, 4) viewers, 5) checklist. Recap = 1) headline numbers (peak viewers, duration), 2) "Generate follow-up posts" CTA, 3) VOD link + retention countdown, 4) comments.

**Interaction-state table (Pass 2):**

```
FEATURE           | LOADING           | EMPTY                          | ERROR                         | SUCCESS                        | PARTIAL
Hub list          | LoadingStateGrid  | "No live sessions yet —        | request-failed retry panel    | sessions render                | stale-monitor DEGRADED banner
                  | skeleton          |  schedule your first" + CTA    | (useRequestState idiom)       |                                | on in-flight rows
Schedule drawer   | submit spinner    | n/a                            | inline field errors (existing | navigate to session detail     | n/a
                  | on button         |                                | create-form idiom)            |                                |
Reveal card       | brief spinner     | pre-materialize: "Credentials  | 409 credentials_unavailable:  | masked key + "Copied ✓"        | n/a
                  |                   | appear after Prepare"          | "Re-prepare the session"      | confirmation on copy           |
Control room      | skeleton          | n/a                            | degraded banner (poll fails)  | live state + viewers           | "viewer count unavailable"
Recap             | skeleton          | "Metrics arrive on the next    | bridge-row missing: retry note| numbers + VOD + follow-up CTA  | "metrics pending" (sync lag)
                  |                   |  analytics sync (~30 min)"     |                               |                                |
```

**Journey storyboard (Pass 3):** schedule (confidence: "it's on the calendar; Aries reminds me") → T-24h/T-1h pings (relief) → prep checklist (calm) → reveal + encoder handoff (THE tense moment: masked key with show/copy, biggest type on the screen, zero scrolling on phone) → live (excitement: viewer count ticking) → end → recap (payoff: numbers + one-tap follow-up generation). Break-risk fixes: the reveal card is the top element of the control room in pre-live states; the `abandoned` state renders without blame ("Missed it? Reschedule in one tap" + reschedule action), never a red error treatment.

**New-component specs (Pass 5):** `SessionCountdown` (relative "in 3h 12m" under 7 days, absolute date beyond; `aria-live="polite"`; ticks client-side). `SecretRevealCard` (masked by default, show toggle + copy button — masked-first protects screen-shares; monospace value; audit note "reveals are logged" under the value; ≥44px targets).

Design litmus (App-UI set): anchor=session hero ✓; scannable by headings ✓; one job per section ✓; cards earned (capability picker only) ✓; motion = countdown tick + drawer slide only ✓; premium without decorative shadows ✓.

### Design dual voices — `[subagent-only]` consensus

The independent design subagent returned 17 findings (2 critical). Both criticals were real defects my primary pass missed: **F1** — the locked transition table had no operator path for companion sessions on undetectable platforms (TikTok/X), so the abandon sweep would flag a mid-broadcast operator "abandoned" and the recap/kill-metric payoff was unreachable; fixed with operator "I'm live now"/"Mark as done" transitions + sweep skip. **F2** — the Go live button had undefined semantics; resolved to auto-publish-on-bytes + status ladder, no button. All 17 findings were structural (not aesthetic-taste) and were adopted; the full disposition is audit-trail rows 27–35. Consensus: IA gaps CONFIRMED (hub 5-band hierarchy adopted over my 3-band), state coverage CONFIRMED-extended (loading/fetch-error/client-poll-error added), journey CONFIRMED (4 break-points fixed: go-live moment, T-15 reminder shape, recap payoff, announcement trust), specificity CONFIRMED (drawer/recap/reveal-card were under-specified; now pinned), system alignment CONFIRMED (the "Live"-label collision with the calendar's published-post chips was caught only by the voice — live sessions render "On air" in a distinct tone).

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 27 | Design-voice | Operator companion transitions + abandon-sweep skip (F1, CRITICAL) | Mechanical | P1 | without them companion mode structurally punishes its users | detector-only |
| 28 | Design-voice | Auto-publish-on-bytes + status ladder; no FB Go-live button in v1 (F2, CRITICAL; resolves open Q3) | Mechanical | P5 | the button had no defined semantics; the ladder reflects what actually happens | manual transition button |
| 29 | Design-voice | `followed_up` state → `followed_up_at` timestamp (F9) | Mechanical | P5 | the state raced vod_ready and made the follow-up CTA state-mutating | keep state + extra edge |
| 30 | Design-voice | Hub = 5 pinned bands with on-air hero + attention-above-upcoming (F3) | Mechanical | P1 | time-critical domain needs rank, not a flat list | flat list |
| 31 | Design-voice | Mode derived (capability × flag × preflight) + manual override, never retroactive (F4) | Mechanical | P5 | the schema's central axis needs an owner | operator picks raw mode |
| 32 | Design-voice | Drawer spec pinned incl. platform grid NOT sourced from connected_accounts (F5) | Mechanical | P1 | companion needs no connection; TikTok isn't connectable at all | connected-only picker |
| 33 | Design-voice | Companion recap in Phase 1 with follow-up hero CTA + inline job card (F6/F10) | Mechanical | P1+P6 | the kill/continue metric's payoff surface must exist in the measured phase | Phase-5-only recap |
| 34 | Design-voice | Announcement visibility spec + `live:<id>:materialized` ping (F11) | Mechanical | design-for-trust | surprise public content is never acceptable | knob-only answer |
| 35 | Design-voice | State-label table ("On air" ≠ "Live"), CalendarLiveItem, CAS-409 silent refetch, client-poll-error copy, attention stacking, reveal 4-state, reminder Block Kit shape (F8/F12–F17) | Mechanical | P5+P1 | each is a place the implementer would otherwise invent the product | implicit |

## Phase 3 — Eng Review

**Scope challenge (against real code):** the plan's structural claims were verified against the repo during research (file:line evidence throughout Current State): the posts pipeline genuinely cannot hold a session (CHECKs at `scripts/init-db.js:727-732`, coercion at `scheduled-dispatch/route.ts:369-371`, 15-min reclaim), the claim/rollback idiom exists and is the correct template (`app/api/insights/comments/[commentId]/reply/handler.ts`), and no simpler existing substrate was found that the lightweight-alternative argument (CEO-voice F5) could ride — its adopted resolution (defer managed schema, keep the domain) stands. Complexity smell (>8 files, new worker) is justified by the lifecycle statefulness; the minimum-set answer is pinned as Phases V–2.

**Architecture diagram:** see Phase 1 record (S1). **Failure-modes registry:** see Phase 1 record — zero critical gaps after the reveal-decrypt and stale-monitor fixes.

**Test diagram + test plan artifact:** the full codepath→coverage matrix (every new UX flow, data flow, guard, worker leg, integration, plus 2am-Friday/hostile-QA/chaos cases, flakiness controls, and per-phase verify-suite registration) is written to `~/.gstack/projects/DeliciousHouse-aries-app/brendan-claude-aries-live-social-sessions-9lqla6-test-plan-20260720-154500.md`. Additions it forces beyond the plan's original table: a grep-level assertion that `planned_start_time` never appears in `backend/`; event-replay idempotency on `live_session_events.event_id`; DRY_RUN-mutates-nothing tick test; view-model unit for the client-side stale-monitor derivation.

**TODOS.md updated** (auto-write per autoplan override): three deferred items appended under a new "Live Sessions" heading — email reminder leg, per-tenant lead-time setting, VOD archival.

### Eng dual voices — `[subagent-only]` consensus

The independent eng subagent verified the plan's substrate citations against real code (all accurate) and returned 19 findings (1 critical, 6 high). Every finding was a place the plan's specifics contradicted its own invariants or the verified behavior of reused code; all 19 were adopted (rows 36–46). The two heaviest: **F1 (CRITICAL)** — the abandon sweep ran before the monitor and ignored `monitoring_degraded`, so it could cancel an actually-live broadcast; fixed with leg reordering + degraded-skip + pre-cancel fresh status read + cannot-cancel-active→adopt. **F2 (HIGH)** — "flows through normal review machinery" was FALSE in prod: `one_off_post` sets `publishingRequested:true` unconditionally and compose ships auto-approve ON, so the promo button would have auto-published unreviewed content; fixed with a `publishingRequested:false` pin + a `live-promo:`/`live-followup:` synthesis clamp mirroring the `reel:` incident clamp.

```
ENG DUAL VOICES — CONSENSUS
Dimension                        Claude(primary)      Subagent              Consensus
1. Architecture sound?           yes                  yes, shape confirmed  CONFIRMED (with F3/F16 hardening adopted)
2. Test coverage sufficient?     table + artifact     8 missing cases       GAP CONFIRMED → F18 additions adopted
3. Performance risks addressed?  yes (no fan-out)     comment-loop starvation GAP CONFIRMED → tick-granularity adopted (F7)
4. Security threats covered?     strong               4 reveal gaps         GAP CONFIRMED → cooldown/no-store/leak-scope adopted (F17)
5. Error paths handled?          registry, no gaps    5 real gaps           GAP CONFIRMED → F1/F6/F10/F11/F13 adopted
6. Deployment risk manageable?   yes                  flag-off drain hole   GAP CONFIRMED → drain semantics adopted (F4)
```

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 36 | Eng-voice | Abandon sweep: monitor-first ordering + degraded-skip + pre-cancel status read + cannot-cancel-active→adopt (F1, CRITICAL) | Mechanical | P1 | "never destructive on doubt" must bind the sweep too | exempted sweep |
| 37 | Eng-voice | Promo jobs pin `publishingRequested:false` + created_by synthesis clamp (F2) | Mechanical | P1 + incident precedent | prod config would auto-publish unreviewed content; 2026-07-13 rogue-package precedent | trust the pipeline |
| 38 | Eng-voice | Reconciler provenance marker + external_broadcast_id partial-unique + nearest-start tie-break + zombie path + park-on-unreliable-listing fallback (F3) | Mechanical | P1 | never cancel what Aries didn't create; never double-adopt | title-match-only |
| 39 | Eng-voice | Flag-off drain semantics: scrub+abandon keep draining in-flight rows (F4) | Mechanical | P1 | frozen keys + orphaned public announcements are worse than a few more ticks | full idle |
| 40 | Eng-voice | Phase 4 gets Phase 3's identity preflight; gate label corrected (F5) | Mechanical | P1 | Composio-only tenants have no live_media-capable token | "no external gate" |
| 41 | Eng-voice | Bridge ships with sync-side dead-node terminal rule + ensure-account + published_at source (F6) | Mechanical | P1 | dead nodes would mark every sync run partial forever | "zero new sync code" |
| 42 | Eng-voice | During-live comments at tick granularity; 10s knob dropped (F7) | Mechanical | P3+P5 | a 10s inner loop starves the tick model; honesty over specced latency | detached loop now |
| 43 | Eng-voice | Idempotency key mint-once-per-submission; reminder keys include startEpoch + nearest-un-elapsed-only; DB now() time source (F8/F9/F18) | Mechanical | P1 | per-attempt mint defeats retry dedupe; reschedule must regain reminders | as-drafted |
| 44 | Eng-voice | `scheduled→failed` for permanent errors + `failed→scheduled` operator recovery; IG 3-empty-poll debounce; live_detected in partial-unique + nearest-start attribution; scrub on ended-or-terminal + 7d VOD give-up; stale-banner scoped to monitored states (F10–F14) | Mechanical | P1 | each closed a loop where an operator saw a lie or a trapdoor | as-drafted |
| 45 | Eng-voice | No writes on read: presentation-only "effectively missed"; sweep is the only abandoned-writer (F15) | Mechanical | P5 + role model | GET must not mutate; viewer-role write hole; dry-run bypass | lazy write-on-read |
| 46 | Eng-voice | YT per-session non-reusable streams (F16); reveal cooldown + no-store + leak-test covers events/attention/logs/calendar (F17); 8 test additions incl. 23505→409 + DST + flag-off-shape (F18); Phase 4/5 bridge-substrate dependency edge (F19) | Mechanical | P1+P5 | uniform credential lifecycle; leak test must cover every payload shape | as-drafted |

## Cross-phase themes (high-confidence signals — flagged independently by 2+ phases)

1. **"The sweep/janitor must be as careful as the mutation path."** CEO S8-a (dry-run convention), design F1 (abandon punishes companion operators), eng F1 (abandon can cancel a live broadcast) all attacked the abandon sweep from different angles. The final shape — monitor-first ordering, degraded-skip, pre-cancel platform read, operator-marked-live skip, dry-run first enable — exists because all three converged here.
2. **"The plan's differentiated value is the content wrap, and it kept slipping to later phases."** CEO voice (F3/F7: moat is generative wrap-around) and design voice (F6/F10: the recap/follow-up CTA — the kill-metric's payoff — was the least-designed surface) independently forced promo/follow-up into Phase 1 with a real UI home and (eng F2) real publish-safety pins.
3. **"Companion mode was designed as managed-minus instead of its own product."** Design F1 (no operator lifecycle), eng F14 (stale banner false-positives on companion), eng F5 (Phase 4's identity gap) — all traced to managed-mode assumptions leaking into the companion path. The adopted operator transitions, scoped staleness, and preflight parity close it.
4. **"Verified-substrate reuse claims must be re-verified at the seam, not the label."** CEO F8 (perishable API table), eng F2 ("normal review machinery" false in prod config), eng F6 ("zero new sync code" false at the dispatcher's watermark behavior) — the plan now carries per-phase doc re-verification and the corrected seam contracts.

## Completion Summary

```
+====================================================================+
|        AUTOPLAN REVIEW — COMPLETION SUMMARY (all phases)           |
+====================================================================+
| Mode                 | SELECTIVE EXPANSION (autoplan override)     |
| Premise gate         | PASSED — user chose B (live sessions +      |
|                      | validation gate + kill/continue metrics)    |
| CEO sections 1-11    | 13 findings, all dispositioned              |
| CEO voice            | 9 findings (2 critical) → 7 adopted, 2      |
|                      | user-resolved at premise gate               |
| Design passes 1-7    | ratings 6-8 → fixed to 9-10                 |
| Design voice         | 17 findings (2 critical) → all adopted      |
| Eng review           | scope challenge vs real code; test artifact |
| Eng voice            | 19 findings (1 critical) → all adopted      |
| DX phase             | SKIPPED — no developer-facing scope         |
| Error/rescue registry| complete, 0 critical gaps after fixes       |
| Failure modes        | complete, 0 critical gaps                   |
| NOT in scope         | written (incl. StreamYard/Restream)         |
| What already exists  | written (0B leverage map)                   |
| Dream state delta    | written (~70% of 12-month ideal)            |
| TODOS.md             | 3 items appended (auto-write)               |
| Scope proposals      | 7 scanned: 1 accepted (ICS), 3 deferred,    |
|                      | 1 skipped, 2 already-covered                |
| Test plan artifact   | written to ~/.gstack/projects/…-test-plan…  |
| Diagrams             | architecture, state machine, data-flow      |
| Decision audit trail | 46 rows                                     |
| Outside voices       | [subagent-only] x3 (Codex CLI absent)       |
| Unresolved decisions | 0 (3 taste decisions confirmed at final     |
|                      | gate; open questions 1/2/5 are review       |
|                      | inputs, not blockers)                       |
+====================================================================+
```

## GSTACK REVIEW REPORT

Generated by /autoplan on 2026-07-20 · branch `claude/aries-live-social-sessions-9lqla6` · plan `docs/plans/2026-07-20-live-social-sessions.md`

| Run | Status | Findings |
|-----|--------|----------|
| CEO review (SELECTIVE EXPANSION) | clean | 13 primary findings dispositioned; premise gate PASSED (user: option B — live sessions + validation gate) |
| CEO outside voice `[subagent-only]` | clean | 9 findings (2 critical) — 7 adopted, 2 user-resolved at premise gate |
| Design review (7 passes, APP UI) | clean | passes 6–8 → fixed to 9–10; state tables, hierarchies, and component specs pinned |
| Design outside voice `[subagent-only]` | clean | 17 findings (2 critical: companion-end impossibility, undefined go-live) — all adopted |
| Eng review | clean | scope challenge vs real code; test-plan artifact written; TODOS.md updated |
| Eng outside voice `[subagent-only]` | clean | 19 findings (1 critical: abandon-sweep blind window; promo auto-publish config truth) — all adopted |
| DX review | skipped | no developer-facing scope (operator SaaS UI; API/flag mentions are internal implementation) |

Decision audit trail: **46 rows** (41 auto-decided by the 6 principles, 3 taste decisions at recommended settings, 2 user-decided at the premise gate). Cross-phase themes: 4 (janitor-rigor, content-wrap-first, companion-as-product, seam-level re-verification). Codex CLI absent — all outside voices ran as independent Claude subagents (`[subagent-only]`; no cross-model consensus available).

**VERDICT: APPROVED** — premise gate answered by the user (option B); final approval gate closed via the user's continue instruction after the gate prompt errored, on the recommended approve-as-is path. The three taste decisions (separate companion states; managed-schema deferral to Phase 3; FB-before-YT as revisitable default) are two-way doors — override in PR review if desired.

Unresolved decisions: none blocking — open questions 1 (App Review logistics owner), 2 (materialize lead-time default), and 5 (scrub window / reveal-count alerting) are review inputs for the PR, not gates.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Approach B (tiered) over A (companion-only) / C (managed-first) | Mechanical | P1+P6 | A is a strict prefix of B; C inverts value/risk | A, C |
| 2 | CEO | Accept ICS-download micro-expansion into Phase 1 | Mechanical (blast-radius rule) | P2 | <5 files, no new infra, real operator delight | — |
| 3 | CEO | Defer email reminders, lead-time knob, VOD archival to TODOS | Mechanical | P2/P3 | outside blast radius or needs new infra | build-now |
| 4 | CEO | Idempotency key = client UUIDv4, not deterministic hash | Mechanical | P5 | deterministic hash collapses two intentional same-slot sessions | hash |
| 5 | CEO | Single serializeLiveSession() choke point | Mechanical | P5 | makes the never-leak test structural, not per-route | per-route shaping |
| 6 | CEO | Reveal decrypt failure → 409 + attention, never 500 | Mechanical | P1 | zero silent failures directive | raw 500 |
| 7 | CEO | PATCH reschedule must propagate to platform | Mechanical | P1 | local-only reschedule desyncs the public announcement | local-only |
| 8 | CEO | Cancel illegal from live (end, never cancel) | Mechanical | P5 | pinned in transition table | allow cancel |
| 9 | CEO | ARIES_LIVE_ABANDON_DRY_RUN first-enable convention | Mechanical | repo convention | abandon cancels platform objects — destructive sweep | no dry-run |
| 10 | CEO | Client-side stale-monitor warning from state_updated_at | Mechanical | P1 | dead worker can't self-report degradation | worker-only signal |
| 11 | CEO | Update CLAUDE.md guardrail #1 pool accounting in Phase 2 | Mechanical | repo convention | every sidecar pool is budgeted there | skip |
| 12 | CEO | Control room mobile-usable is acceptance, not nice-to-have | Mechanical | P1 | IG operators go live from their phone | desktop-only |
| 13 | CEO | Companion states stay separate from managed states | Taste (surfaced at gate) | P5 | detector-driven states are lossy; merging fakes precision | merged vocabulary |
| 14 | CEO-voice | Add Phase V validation gate + kill/continue metrics (subagent F1/F9) | **User-decided (premise gate → option B)** | — | user confirmed live-sessions direction WITH the validation gate | as-is / reframe / park |
| 15 | CEO-voice | Pull promo/follow-up generation into Phase 1 (subagent F3/F7) | Mechanical | P1+P6 | the differentiated piece is a button on an existing pipeline — deferring it was pure loss | keep in Phase 5 |
| 16 | CEO-voice | Demote FB managed to explicit go/no-go + state the Business-Suite delta (subagent F4) | Mechanical | P3 | symmetric posture with YT; the delta sentence is the honest bar | flagship-by-default |
| 17 | CEO-voice | Defer managed-mode tables/states to Phase 3's PR (subagent F5) | Taste (surfaced at gate) | P3+P5 | no dead schema on a no-go; state CHECK still ships wide to avoid re-migration | all-4-tables-in-Phase-0 |
| 18 | CEO-voice | Per-phase platform-doc re-verification item (subagent F8) | Mechanical | P1 | the API table is perishable; Meta has changed this exact surface repeatedly | trust the snapshot |
| 19 | CEO-voice | Phase V probes: Page eligibility + Slack connection (subagent F8) | Mechanical | P1 | both are cheap and both gate later phases' value | discover-at-build |
| 20 | CEO-voice | Document StreamYard/Restream as a considered alternative, not built (subagent F6c) | Mechanical | P3 | vendor+OAuth surface for unproven demand; delta is the content wrap | integrate now |
| 21 | CEO-voice | FB-before-YT stays the default but is revisitable at go/no-go (subagent F6b) | Taste (surfaced at gate) | P3 | Meta substrate reuse is real, but validation data may point at YT | hard-commit either way |
| 22 | CEO-voice | "Marketing moments" reframe NOT adopted (subagent F3) | **User-decided (premise gate)** | — | user chose live sessions + validation gate over the reframe; noted as the fallback shape if the kill-gate fires | reframe now |
| 23 | Design | Nav placement: primary sidebar section, adjacent to Calendar | Mechanical | P5 | workflow surface, not a setting; peers with Calendar/Posts | utilityItems |
| 24 | Design | Drawer create → navigate to session detail | Mechanical | P3 | the detail page is the session's home; hub round-trip adds a click at the moment of intent | stay-in-hub toast |
| 25 | Design | Reveal card masked-by-default with show/copy | Mechanical | security posture | protects screen-shares; copy works without ever showing | visible-by-default |
| 26 | Design | Recap uses insights stat idiom; abandoned state blame-free with one-tap reschedule | Mechanical | P5 + design-for-trust | numbers-first recap; no red shame state | stat-tile mosaic / error treatment |

### CEO dual-voices consensus table (`[subagent-only]` — Codex CLI absent)

```
Dimension                             Claude(primary)  Subagent   Consensus
1. Premises valid?                    partial (P1 bet) challenged RESOLVED at premise gate (user: B)
2. Right problem to solve?            yes-as-asked     reframe    RESOLVED at premise gate (user kept direction)
3. Scope calibration correct?         phased-OK        front-loaded ADOPTED-PARTIAL (schema deferral, row 17)
4. Alternatives sufficiently explored? 3 approaches    gaps found CONFIRMED gap → rows 20-21 adopted
5. Competitive/market risks covered?  honest ceilings  moat=content-wrap CONFIRMED → row 15 adopted
6. 6-month trajectory sound?          sound-with-flags dark-flag risk CONFIRMED risk → row 14 adopted
```
