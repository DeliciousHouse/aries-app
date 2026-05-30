# Story / Reel / Video PUBLISHING to Facebook + Instagram

> Status: draft plan (2026-05-30). Epic. This is **WRITING** video/ephemeral content to Meta — distinct from issue #513, which **READS** story insights. Do not conflate the two; this plan never touches `backend/insights/*`.

## Context

Aries' weekly social pipeline today publishes exactly two shapes: a single-image (or multi-image carousel) **feed** post on Instagram, and an image/carousel/text **feed** post on Facebook. The Meta publish module already grew an image **Story** branch (`MetaPlacement = 'feed' | 'story'`), but that branch is image-only, is not wired through the scheduling worker, and there is no video path at all. So every motion-first surface — IG Reels, IG video Stories, FB video, FB video Stories — is dark.

This epic adds **video as a first-class media type** and lights up the motion surfaces: IG Reels (`media_type=REELS`), IG video Stories, FB video posts, and FB video Stories. It threads a new `surface` axis (`feed`/`story`/`reel`) and the existing `media_type` (`image`/`video`) end-to-end: Hermes publish-stage payload → callback ingestion → `posts`/`scheduled_posts` → the scheduled-posts worker → the dispatch route → `publishToMetaGraph`. It also adds the video-specific Graph upload dance (async container poll for IG, resumable/chunked upload for FB video) and the media validation (codec/aspect/duration/size) Meta enforces per surface.

This is an **L feature, not a flag.** It adds a Graph upload protocol that does not exist in the codebase (FB resumable video upload, IG video-container status polling that is materially slower than image containers), a new media-validation layer, a `media_type=video` Hermes contract dependency, and three new publish branches. A boolean env flag gates *rollout*, but the work is multi-PR and cannot be a one-line toggle.

## Who cares

- **Operators / the @sugarandleather tenant** — Reels and Stories are where Meta's organic reach now lives; feed-only means the highest-distribution surfaces are unused.
- **Product** — "weekly social content OS" that cannot post a Reel or a video Story is missing the table-stakes 2026 formats.
- **Eng** — the existing image-Story branch in `meta-publishing.ts:297-335,403-413` is half-wired (no worker plumbing); shipping video without finishing that plumbing leaves two dead code paths.

## Decisions (locked — do not re-litigate)

1. **Both repos in scope.** Brendan owns Aries + Hermes. Hermes must emit `media_type: "video"` + `placement` + a video `asset_url`; Aries persists/validates/publishes. Ship as one coherent unit to avoid the Aries-ahead / Hermes-behind failure mode.
2. **Surface axis = `feed | story | reel`**, orthogonal to `media_type = image | video`. `posts.media_type` already exists (`scripts/init-db.js:429`); add a new `surface` column rather than overloading `media_type`. Stories can be image **or** video; Reels are always video; feed can be image or video.
3. **Reuse the existing Facebook-Login + Graph v21.0 token path** (`backend/integrations/meta/discover.ts`, `getDecryptedAccessTokenContextForTenantProvider`). No new OAuth scope is required for *publishing* video/Reels/Stories — `pages_manage_posts` + `instagram_content_publish` (already requested) cover it. (Insights scopes are #513's problem, not this plan's.)
4. **No Meta-side scheduling for video Stories or Reels.** The `scheduled_posts` worker is the only "post tomorrow 09:00" mechanism; it fires live at the scheduled instant. FB *feed* video may keep `scheduled_publish_time`; IG and all Stories/Reels publish live.
5. **FB video Stories use `/video_stories` (resumable upload + finish), not `/photo_stories`.** Image Stories keep the existing `/photo_stories` branch unchanged.
6. **Resumability is mandatory (CLAUDE.md).** Video upload is multi-step and slow; a transient failure mid-upload must preserve the uploaded container/video id and resume, never re-upload from scratch and never re-publish a confirmed post.
7. **Rollout flag `ARIES_VIDEO_PUBLISH_ENABLED`** (default OFF) gates whether `surface in (reel)` / `media_type='video'` entries are persisted+dispatched. It is a rollout switch over a large feature, **not** the feature itself.

## Current State (VERIFIED — master @ v0.1.13.15)

**Publish module — `backend/integrations/meta-publishing.ts`:**
- `MetaPlacement = 'feed' | 'story'` (line 19); `MetaPublishRequest` has `placement?` but **no `mediaType`** (lines 25-35).
- IG feed: two-step `POST /{ig}/media` → poll → `POST /{ig}/media_publish` (`createInstagramContainer:395`, `waitForInstagramContainerReady:454`, `publishInstagram:489`). All container creation uses **`image_url`** only (lines 410, 419, 433) — no `video_url`, no `media_type=REELS`, no `media_type=VIDEO`.
- IG Story branch exists but is **image-only**: `media_type: 'STORIES'` + `image_url` (line 410). The module header comment (lines 11-18) explicitly says "Image stories only — video stories need video upload, which this path does not implement."
- FB feed: `/{page}/photos` (unpublished) → `/{page}/feed` with `attached_media` (`publishFacebook:337`). FB Story: `/{page}/photos` → `/{page}/photo_stories` (`publishFacebookPhotoStory:297`). **No `/videos` or `/video_stories` path.**
- Container poll budget: `CONTAINER_POLL_MAX_ATTEMPTS=15`, ~60s total (lines 451-452). Video containers routinely take longer than 60s to transcode — this budget is too small for video.
- Single-media + scheduling guards fail closed for Story (lines 548-566): exactly-one-media, no `scheduledFor`. `publishInstagram` rejects any `scheduledFor` (line 501).
- The `outcomeUnknown` / `MetaPublishFailureClass` machinery (lines 50-104) is the resumability contract: a 2xx with no post id must NOT be auto-retried. Video publish must honor the same classification.

**Hermes callback ingestion — `backend/marketing/hermes-callbacks.ts`:**
- `WeeklyScheduleEntry` (line 1428) has `post_number?`, `recommended_day?`, `platforms?: string[]`, `platform_targets?: Array<{ platform?: string }>`. **No `placement`, no `media_type`.**
- `readWeeklySchedule()` (line 1435) reads `stages.publish.primary_output.schedule` (fallback `weekly_schedule`).
- The schedule loop (lines 1371-1387) reads only `platforms` / `platform_targets[].platform` + `recommended_day` — it discards any placement/media_type the strategist emits.
- (The `placement` fields at lines 60/84/215/336/390 are the **creative-asset** placement string, a different concept — do not confuse with schedule-entry placement.)

**Post synthesis — `backend/marketing/synthesize-publish-posts.ts`:**
- `INSERT_SYNTHESIZED_POST_SQL` (line 101) inserts `media_type` (already a column) but hardcodes it; no `surface`. Idempotency key is `${jobId}:${postNumber}:${platform}` (line 353) — **collides** if the same post number yields both a feed and a reel on one platform.
- `ON CONFLICT (tenant_id, platform, idempotency_key)` (line 109).

**Auto-schedule — `backend/marketing/auto-schedule.ts`:**
- `PLATFORM_POSTING_DEFAULTS` (line 91): `instagram {hour:11,minute:0,staggerMinutes:0}`, `facebook {hour:13,minute:0,staggerMinutes:5}`. Flat per-platform — **no surface dimension.**

**Worker — `scripts/automations/scheduled-posts-worker.mjs`:**
- `CLAIM_ROW_SQL` (line 57) selects `sp.id, sp.post_id, sp.tenant_id, sp.target_platforms, p.caption, p.platform_post_id` — **no `surface`, no `media_type`.**
- Dispatch body (line 253) sends only `{ tenant_id, post_id, platforms, content }` — surface/media_type are NOT forwarded.
- Claim → release connection → network publish → fresh connection for post-publish write (lines 358-402): the pool-safe pattern (no DB client held across the Graph call). Video upload latency must stay inside this connection-free window.

**Dispatch route — `app/api/internal/publishing/scheduled-dispatch/route.ts`:**
- Parses `tenant_id, platforms, content, post_id, media_urls` from body (lines 151-165). **No `placement`/`surface`/`media_type`.**
- Calls `publishToMetaGraph({ tenantId, provider, content, mediaUrls })` (line 221) — never passes `placement`, so every dispatch is feed.

**Schema — `scripts/init-db.js`:**
- `posts.media_type TEXT NOT NULL DEFAULT 'image'` (line 429); `creative_assets.media_type` CHECK already allows `'video'` (line 182).
- No `surface` column on `posts` or `scheduled_posts`.
- Migrations dir tail: `20260515120000_posts_idempotency_key.sql` (latest).

**Prior thinking:** `~/.gstack/projects/DeliciousHouse-aries-app/draft-spec-stories.md` (image-Stories MVP, parked at Phase 4) explicitly **defers video Stories to "v0.1.13.x"** — this plan is that deferred work plus Reels and FB video. The insights spec (`specs/20260530-...-insights-meta-fb-ig-stories.md` = #513) is READ-side and out of scope here.

## Architecture (target data flow)

```
Hermes strategist + content-generator
  schedule[].platform_targets[]: { platform, placement: feed|story|reel, media_type: image|video, asset_url }
        │  (video asset_url points to a 9:16 / 16:9 MP4 in the Hermes media cache)
        ▼
backend/marketing/hermes-callbacks.ts
  WeeklyScheduleEntry gains { placement, media_type }  ──>  readWeeklySchedule() preserves them
        │
        ▼
backend/marketing/synthesize-publish-posts.ts
  INSERT posts (… media_type, surface …)   idempotency_key = jobId:postNo:platform:surface
        │
        ▼
backend/marketing/auto-schedule.ts
  PLATFORM_POSTING_DEFAULTS[platform][surface]  ──>  scheduled_posts (… surface, media_type mirrored …)
        │
        ▼  (every 60s)
scripts/automations/scheduled-posts-worker.mjs
  CLAIM_ROW_SQL selects sp.surface, p.media_type  ──>  dispatch body { …, surface, media_type }
        │
        ▼
app/api/internal/publishing/scheduled-dispatch/route.ts
  publishToMetaGraph({ …, placement: surface, mediaType })
        │
        ▼
backend/integrations/meta-publishing.ts  (NEW video branches)
   ├─ validateMediaForSurface(mediaUrls, surface, mediaType)   ← NEW (codec/aspect/duration/size)
   ├─ IG video feed  : POST /media media_type=VIDEO video_url  → poll(extended) → media_publish
   ├─ IG Reel        : POST /media media_type=REELS video_url  → poll(extended) → media_publish
   ├─ IG video Story : POST /media media_type=STORIES video_url→ poll(extended) → media_publish
   ├─ FB video feed  : POST /{page}/videos (resumable) → finish[+scheduled_publish_time]
   └─ FB video Story : POST /{page}/video_stories start→transfer→finish
        │
        ▼
graph.facebook.com/v21.0  (Page token + ig_business_account from meta/discover.ts)
```

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Schema + contract: `surface` columns, idempotency key, `WeeklyScheduleEntry` + ingestion | Critical | 2h / 30m | none |
| B | Media validation layer (`validateMediaForSurface`) | High | 3h / 1h | A |
| C | IG video publish — feed VIDEO + Reel + video Story (extended container poll) | High | 8h / 3h | A, B |
| D | FB video publish — `/videos` resumable + `/video_stories` | High | 10h / 4h | A, B |
| E | Worker + dispatch-route plumbing (surface/media_type end-to-end) + auto-schedule surface dimension | High | 4h / 1.5h | A |
| F | Hermes side: strategist emits reel/video entries; content-generator renders 9:16/16:9 MP4 | High | 6h / — (separate repo) | A (contract) |
| G | Rollout flag, docs, live E2E on tenant 15, ship | Medium | 4h / 1.5h | C, D, E, F |

**Sequencing:** A first (everything depends on the surface axis + contract). B before C/D (publish branches call the validator). C and D parallel (independent Graph paths). E parallel with C/D (pure plumbing). F parallel from day 1 (Hermes lead time; gated on A's contract shape). G last (needs real Hermes video output to verify live).

```
A ─┬─> B ─┬─> C ──┐
   │      └─> D ──┼─> G
   ├─> E ─────────┘
   └─> F (Hermes, parallel) ──> G
```

---

### A — Schema + contract (Critical, 2h)

**Implementation:**
1. New migration `migrations/20260531120000_posts_surface.sql`:
   ```sql
   ALTER TABLE posts ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'feed'
     CHECK (surface IN ('feed','story','reel'));
   ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'feed'
     CHECK (surface IN ('feed','story','reel'));
   ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image'
     CHECK (media_type IN ('image','video'));
   ```
   `scheduled_posts.surface` + `media_type` are denormalized so worker dispatch does not JOIN `posts` at claim time (it already LEFT JOINs for caption, but mirroring keeps the dispatch shape stable and lets a partial index target pending rows by surface). Mirror the columns in `scripts/init-db.js` for fresh installs.
2. `backend/marketing/hermes-callbacks.ts`: extend `WeeklyScheduleEntry` (line 1428) with `placement?: 'feed' | 'story' | 'reel'` and `media_type?: 'image' | 'video'`, and add the same to `platform_targets[]`. Update the loop (lines 1371-1387) to carry `placement` (default `'feed'`) and `media_type` (default `'image'`) per platform into the ordinal map, alongside `recommended_day`.
3. Backward compat: absent `placement` ⇒ `'feed'`; absent `media_type` ⇒ `'image'`. A reel entry with `media_type` missing is a contract violation — log + skip (do not silently post an image reel).

**Acceptance:** `\d posts` shows `surface` with CHECK; all pre-existing rows `surface='feed'`. A fixture callback carrying `placement:'reel', media_type:'video'` round-trips into `readWeeklySchedule()` output with both fields preserved; a legacy callback with neither yields `feed`/`image`.

### B — Media validation layer (High, 3h)

**Implementation:** New `validateMediaForSurface(mediaUrls, surface, mediaType)` in `meta-publishing.ts` (or a sibling `meta-media-validation.ts`). Fail-closed before any Graph call, mirroring the existing Story guards (lines 548-566). Enforce Meta's per-surface constraints:
- **IG Reel / IG video Story:** exactly 1 video; aspect 9:16 (Reels accept 0.01–10 but 9:16 is required for full-screen); duration 3s–90s (Reels) / ≤60s (Story); MP4/MOV, H.264, AAC; ≤ ~1GB.
- **IG video feed:** 1 video, 4:5–16:9, 3s–60s.
- **FB video feed:** 1 video; ≤ ~10GB / 240min (we cap far lower, e.g. ≤4min); MP4 preferred.
- **FB video Story:** 1 video, 9:16, ≤60s.
- **Story (any):** still exactly 1 media, no `scheduledFor` (extend the existing guard to cover video).
- Aspect/duration are validated from Hermes-provided metadata (Hermes emits `width`/`height`/`duration_seconds` alongside `asset_url`) — Aries does not download+probe the file. Missing metadata ⇒ reject (fail closed), do not assume.

**Acceptance:** unit table: a 9:16 30s MP4 passes for Reel; a 1:1 image fails for Reel (`media_type_mismatch`); a 120s video fails for Story (`duration_exceeds_story_limit`); a 2-video array fails for any Story/Reel (`single_media_required`). All throw `MetaPublishError` with `status:400`, `retryable:false`.

### C — IG video publish (High, 8h)

**Implementation:**
1. Add `mediaType?: 'image' | 'video'` to `MetaPublishRequest` (line 25) and thread through `publishToMetaGraph` (line 540) → `publishInstagram` (line 489) → `createInstagramContainer` (line 395).
2. Widen `MetaPlacement` to `'feed' | 'story' | 'reel'`; update `normalizeMetaPlacement` (line 21) to accept `'reel'`. **Per CLAUDE.md memory "Widening union → grep inequalities": grep every `=== 'story'` / `=== 'feed'` / `!== 'feed'` in the module and call sites after widening — literal-inequality checks won't be caught by TS.**
3. `createInstagramContainer`: when `mediaType==='video'`, send `video_url` (not `image_url`) plus `media_type=VIDEO` (feed), `media_type=REELS` (reel), or `media_type=STORIES` (video story). Call `validateMediaForSurface` first.
4. Extend the container poll for video: video containers transcode slowly. Add a separate `VIDEO_CONTAINER_POLL_MAX_ATTEMPTS` / longer cap (target ~5min, e.g. up to 60 attempts with 5s backoff) — keep image at the existing 60s budget. Reuse `waitForInstagramContainerReady`'s `FINISHED`/`ERROR`/`EXPIRED` handling.
5. Final `media_publish` is the one-shot, never-auto-retried call — preserve `outcomeUnknown:true` on the missing-id path (line 534). Container creation + poll are the safe-to-retry pre-publish steps (wrap in `withSafePrePublishRetry` like the image path).

**Resumability:** if the process dies after container creation but before `media_publish`, the container id is the resumable handle. Persist the `creation_id` on the `scheduled_post_dispatches` row (or a new nullable `posts.last_media_container_id`) so a resume polls the existing container instead of re-uploading the video. Do not re-create a container on retry of a confirmed-published post.

**Acceptance:** against tenant 15, an IG Reel publishes from a real 9:16 MP4 and appears in the Reels tab; an IG video Story appears in the 24h tray; a forced kill between container-ready and `media_publish` resumes without re-uploading; a 2xx-no-id leaves the claim in `needs_manual_reconciliation`, not retried.

### D — FB video publish (High, 10h)

**Implementation:** FB video does NOT reuse `/photos`. Two new paths:
1. **FB video feed → `/{page}/videos`** with resumable upload: `start` (file size) → `transfer` chunks → `finish`. For MVP, if Hermes provides a public `asset_url`, use the simpler **`file_url` non-resumable** form (`POST /{page}/videos?file_url=...&description=...`) and reserve chunked resumable for the size-cap fallback. `scheduled_publish_time` may be set on feed (FB allows scheduled video).
2. **FB video Story → `/{page}/video_stories`**: `start` (returns `video_id` + `upload_url`) → upload the bytes → `finish` (`upload_phase=finish`, `video_id`). One-shot finish = the never-auto-retry boundary (`outcomeUnknown`).
3. Route `publishFacebook` (line 337) on `(placement, mediaType)`: image feed/story unchanged; `mediaType==='video'` + `feed` → `/videos`; `+ story` → `/video_stories`.

**Resumability:** the FB `video_id` from `start` is the resumable handle — persist it, and on resume re-issue `finish` (idempotent on a video already finished) rather than re-uploading. Honor `outcomeUnknown` on a `finish` that returns 2xx with no usable post id.

**Pool guardrail (CLAUDE.md #1):** the FB resumable transfer is multi-request and slow; it MUST run in the worker's connection-free window (between claim-release and post-publish write, `scheduled-posts-worker.mjs:381`). Do not hold a `pool.connect()` client across the upload.

**Acceptance:** a FB video feed post publishes from a real MP4 and is visible on the Page; a FB video Story appears; a kill mid-transfer resumes via the persisted `video_id`; scheduled FB video honors `scheduled_publish_time`.

### E — Worker + dispatch plumbing + auto-schedule surface dimension (High, 4h)

**Implementation:**
1. `scheduled-posts-worker.mjs` `CLAIM_ROW_SQL` (line 57): add `sp.surface, sp.media_type` (and/or `p.media_type`) to the SELECT.
2. Dispatch body (line 253): add `surface` and `media_type`.
3. Route (`scheduled-dispatch/route.ts`): parse `surface`/`media_type` from body (after line 165), pass `placement: surface, mediaType` into `publishToMetaGraph` (line 221).
4. `synthesize-publish-posts.ts`: add `surface` to `INSERT_SYNTHESIZED_POST_SQL` (line 101) and write the Hermes-provided `media_type`; change idempotency key (line 353) to `${jobId}:${postNumber}:${platform}:${surface}` so a feed + reel on the same post number/platform don't collide (the `ON CONFLICT` index already keys on `idempotency_key`). **Per CLAUDE.md memory: grep for any literal parse of the old `jobId:postNo:platform` key shape** (`parsePostNumberFromIdempotencyKey`, hermes-callbacks.ts:1393) and update it to tolerate the 4th segment.
5. `auto-schedule.ts` `PLATFORM_POSTING_DEFAULTS` (line 91): nest by surface, e.g. `instagram: { feed:{...}, story:{...}, reel:{...} }`, and have `computeAutoScheduleSlots` pick by `(platform, surface)`. Mirror `surface`/`media_type` into the `scheduled_posts` insert it drives.

**Acceptance:** a callback with 7 feed + 1 reel + 1 story produces 9 `posts` + 9 `scheduled_posts` rows with correct `surface`/`media_type`; the worker forwards both fields; the route passes them through; idempotency replay of the mixed callback is a no-op (no duplicate rows).

### F — Hermes side (High, separate repo)

**Implementation (tracked here for coherence):**
1. **Strategist** (`aries-strategist`): emit reel/video-story schedule entries with `platform_targets[].placement` + `media_type:"video"` + a `recommended_day`.
2. **Content-generator** (`aries-content-generator`): when `media_type:"video"`, render a 9:16 (Reel/Story) or 16:9/4:5 (feed) MP4 via the video-gen path; emit `asset_url` + `width`/`height`/`duration_seconds` metadata (B depends on these).
3. Persist video assets into the Hermes media cache so `backend/marketing/ingest-production-assets.ts` resolves them via `HERMES_IMAGE_CACHE_MOUNT` (same mechanism as images; confirm video MIME passes the media route `app/api/internal/hermes/media/[...path]/route.ts`).

**Acceptance:** a fresh one_off on tenant 15 produces ≥1 video schedule entry per platform with valid metadata; the asset resolves through the media mount and streams to the browser preview.

### G — Rollout flag + docs + live E2E + ship (Medium, 4h)

**Implementation:**
1. `ARIES_VIDEO_PUBLISH_ENABLED` (default OFF): when OFF, `readWeeklySchedule()` strips `placement:'reel'` and `media_type:'video'` entries before persist (campaign still succeeds on image/feed). Document in `CLAUDE.md` "Environment Variables" and `.env.example` + `docker-compose.yml`.
2. Live E2E on tenant 15: one real IG Reel, one IG video Story, one FB video post, one FB video Story.
3. `/ship-triage-deploy`; bump `VERSION` (minor — new column + contract field + Graph paths) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ zero video rows persisted, feed unaffected; flag ON ⇒ all four live posts verified rendered (per memory: only rendered-on-platform counts as done); `full-suite` gate green.

## Testing Plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit | `WeeklyScheduleEntry` parse: placement+media_type present / absent / reel-missing-media_type | +4 |
| Unit | `normalizeMetaPlacement('reel')` + grep-verified union widening (no stale `=== 'story'`) | +2 |
| Unit | `validateMediaForSurface`: reel ok / image-for-reel fail / 120s-story fail / 2-media-story fail / missing-metadata fail | +5 |
| Unit | idempotency key now `jobId:postNo:platform:surface`; `parsePostNumberFromIdempotencyKey` tolerates 4th segment | +3 |
| Unit | `PLATFORM_POSTING_DEFAULTS` slot pick by `(platform, surface)` | +3 |
| Integration (fake fetch) | IG Reel: container `media_type=REELS video_url` → extended poll → `media_publish` | +2 |
| Integration (fake fetch) | IG video Story container; 2xx-no-id ⇒ `outcomeUnknown` (not retried) | +2 |
| Integration (fake fetch) | FB `/videos` file_url path; FB `/video_stories` start→finish; resume re-issues finish via persisted video_id | +3 |
| Integration | worker `CLAIM_ROW_SQL` selects surface/media_type; dispatch body forwards them; route passes `placement`+`mediaType` | +3 |
| Integration | mixed callback (7 feed + 1 reel + 1 story) → 9 posts/scheduled_posts correctly typed; replay no-op | +2 |
| Live-DB | tenant-scoped synth insert + auto-schedule against real DB (precedent: `tests/marketing/ingest-production-assets-live-db.test.ts`) | +1 |
| E2E (live, manual) | IG Reel, IG video Story, FB video, FB video Story all render on @sugarandleather | manual |

**~30 automated + 4 manual.** New test files allowlisted in `scripts/verify-regression-suite.mjs`. All tests set `APP_BASE_URL=https://aries.example.com`; run `npm run verify` then `npm run test:concurrent` before ship (touches routes + worker + backend).

## Rollback

- **Schema:** additive + idempotent (`ADD COLUMN IF NOT EXISTS ... DEFAULT 'feed'`). Reverse: `ALTER TABLE posts DROP COLUMN surface;` (+ `scheduled_posts` surface/media_type). No data loss.
- **Flag:** `ARIES_VIDEO_PUBLISH_ENABLED=0` strips video entries at ingestion — instant kill switch, feed path untouched.
- **Hermes:** stop emitting `media_type:"video"` — independent, no Aries deploy.
- **Stuck dispatch row:** existing cancel UX + `UPDATE scheduled_posts SET dispatch_status='failed' WHERE id=X`. A video container that timed out is terminal-skippable; never re-`media_publish` an `outcomeUnknown` row.

## Out of Scope

- **Story/Reel INSIGHTS / analytics** — that is issue #513 (READ side); this plan is publish-only.
- **TikTok / YouTube Shorts** video (separate OAuth + content shape; `backend/integrations/adapters/tiktok.ts` is unrelated scaffold).
- **Multi-clip / edited / music-overlay / sticker / interactive Stories** (poll, link, mention).
- **Per-tenant cadence config, multiple reels/day, Story Highlights, carousel video.**
- **Operator manual video upload** (pipeline-generated only).
- **Probing video bytes server-side** — validation is metadata-driven from Hermes.

## Files Reference

| File | Change | Phase |
|------|--------|-------|
| `migrations/20260531120000_posts_surface.sql` | NEW: `surface` on posts+scheduled_posts, `media_type` on scheduled_posts | A |
| `scripts/init-db.js` (≈line 429) | mirror `surface`/`media_type` for fresh installs | A |
| `backend/marketing/hermes-callbacks.ts:1371-1387,1428` | `WeeklyScheduleEntry` + loop carry placement/media_type | A |
| `backend/integrations/meta-publishing.ts:19,21,25,395-449,489-538` | widen `MetaPlacement`, add `mediaType`, IG VIDEO/REELS/STORIES branches, extended video poll | C |
| `backend/integrations/meta-publishing.ts:297-393` | FB `/videos` + `/video_stories` branches | D |
| `backend/integrations/meta-media-validation.ts` | NEW: `validateMediaForSurface` | B |
| `backend/marketing/synthesize-publish-posts.ts:101,353` | add `surface`, 4-segment idempotency key | E |
| `backend/marketing/auto-schedule.ts:91` | nest `PLATFORM_POSTING_DEFAULTS` by surface | E |
| `scripts/automations/scheduled-posts-worker.mjs:57,253` | claim + forward surface/media_type | E |
| `app/api/internal/publishing/scheduled-dispatch/route.ts:151-165,221` | parse + pass placement/mediaType | E |
| `backend/marketing/ingest-production-assets.ts:46` | accept video assets via media mount | F |
| `docker-compose.yml`, `.env.example`, `CLAUDE.md` | document `ARIES_VIDEO_PUBLISH_ENABLED` | G |
| `tests/meta-publishing-video.test.ts` | NEW (IG/FB video branches + outcomeUnknown) | C,D |
| `tests/meta-media-validation.test.ts` | NEW | B |
| `tests/hermes-callback-video-surface.test.ts` | NEW | A,E |
| `tests/marketing-auto-schedule.test.ts` | +surface slot tests | E |
| `scripts/verify-regression-suite.mjs`, `VERSION`, `CHANGELOG.md` | allowlist + bump | G |

## Related

- Draft `~/.gstack/projects/DeliciousHouse-aries-app/draft-spec-stories.md` — image-Stories MVP; explicitly defers video Stories to here.
- Issue #513 — story/post/account **insights** (READ). Disjoint from this publish epic.
- CLAUDE.md guardrails honored: pool fan-out #1 (no DB client across video upload), resumability (container/video_id persisted, `outcomeUnknown` never re-published), Turbopack (no build changes), tenant-scoping (token via `getDecryptedAccessTokenContextForTenantProvider`).
