# Image stories — make the Hermes content pipeline emit + Aries publish IG/FB image stories

**Status:** Open for build. Authored 2026-05-31.
**Scope decision (Brendan, 2026-05-31):** ship the **no-Veo image-story slice**. Video / Reels / video-stories are **deferred** behind the Veo/Vertex AI auth dependency (see Out of Scope).
**Related landed work:** `#520 story-reel-video-publishing` (built the Aries publish surfaces + `surface`/`media_type` schema + `ARIES_VIDEO_PUBLISH_ENABLED` flag).

---

## Context

`#520` shipped the Aries side of multi-surface publishing: the Meta Graph branches for stories already exist and handle **image** stories today — FB `/{page}/photo_stories` (`backend/integrations/meta-publishing.ts:466-475`) and the IG `STORIES` container with image media (`:514`, `:531`, `:609`). Aries also already ingests an entry's `placement` and maps it to a `surface` (`backend/marketing/hermes-callbacks.ts:1376-1377`, `normalizeScheduleSurface(entry.placement)`), and the publish-posts synthesizer carries `surface`/`media_type` end to end. The `ARIES_VIDEO_PUBLISH_ENABLED` flag only strips `surface===reel || media_type===video` (`backend/marketing/synthesize-publish-posts.ts:445`) — **image stories are NOT gated by that flag.**

What is missing is everything *upstream* of Aries: the Hermes content-generator (`~/.hermes/profiles/aries-content-generator/skills/social-media`) plans only image **feed** posts. It emits no `placement: 'story'` entries, so Aries never receives a story to publish. And the Aries→Hermes weekly payload (`backend/social-content/payload.ts`, `staticPostCount: 7`) asks only for a flat post count with no surface mix.

There is also a hard Meta product constraint: **stories cannot be natively scheduled.** `validateMediaForSurface` rejects a `scheduledFor` on a story (`backend/integrations/meta-media-validation.ts:113-114`, `story_scheduled_publish_not_supported`). The weekly pipeline schedules feed posts via the `scheduled_posts` table + the worker. Stories must publish **live** (a "publish now" path), not via the scheduler. The plan must handle that split, because Brendan asked for "scheduling and creating stories and posts" and the scheduling half does not apply to stories on Meta.

## Who cares

- **Brendan / operators** — wants IG/FB stories as part of the weekly content, not just feed posts. Stories are a primary engagement surface.
- **Aries publish owners** — the publish path is built but dead until content carries `placement: 'story'`.

## Decisions (locked)

1. **Image stories only. No Veo.** Video/Reels/video-stories are deferred — they need Vertex AI / Google Cloud auth that is not configured (`gcloud` ADC unauthed; `GOOGLE_API_KEY` commented in the Hermes `.env`). Do not wire `veo-video-runtime` here.
2. **Stories publish live, not scheduled.** Meta rejects scheduled stories. The plan adds a story dispatch path; it does NOT try to schedule stories into `scheduled_posts` with a future time.
3. **No new Aries publish-path code for image stories.** `#520` already ships it. This plan verifies it end-to-end and fixes only gaps found, but the center of gravity is the Hermes content side + the request payload + the story-dispatch wiring.
4. **`ARIES_VIDEO_PUBLISH_ENABLED` stays OFF.** Image stories don't need it; flipping it on does nothing for image stories and would only enable the (unbuilt-content) video path.

## Current State (VERIFIED — file:line)

- **Aries ingest of placement → surface:** `hermes-callbacks.ts:1376-1377` (`normalizeScheduleSurface(entry.placement)`; entry-level surface is the default, `platform_targets` may override).
- **Aries publishes image stories:** `meta-publishing.ts:466-475` (FB `/photo_stories` image), `:514/:531/:590-609` (IG `STORIES` container, image branch).
- **Story scheduling is blocked by Meta:** `meta-media-validation.ts:113-114`.
- **Flag does not gate image stories:** `synthesize-publish-posts.ts:445` strips only `reel`/`video`.
- **Weekly request payload has no surface mix:** `backend/social-content/payload.ts:154-203` (`staticPostCount` only; `backend/social-content/types.ts:132` default 7).
- **Hermes weekly skill emits no story placement:** `~/.hermes/profiles/aries-content-generator/skills/social-media/*` — no `placement`/`story`/`surface` references.

## Architecture (data flow to verify/build)

```
Aries weekly request (payload.ts)
   + NEW: requested surface mix (e.g. N feed + M story)
        |
        v
Hermes content-generator `social-media` skill
   + NEW: plan M image-story entries; emit placement:'story', media_type:'image'
     in the content_package (+ the per-asset prompt/intendedUse it already emits)
        |
        v
Hermes production callback -> Aries hermes-callbacks.ts
   (ALREADY maps entry.placement -> surface; ingests creative_assets)
        |
        v
synthesize-publish-posts.ts  (ALREADY carries surface/media_type; image-story not stripped)
        |
        +-- feed posts  -> scheduled_posts table -> worker -> scheduled-dispatch (scheduled)
        +-- story posts -> NEW live-dispatch path (Meta rejects scheduled stories)
                              -> meta-publishing photo_stories / IG STORIES (ALREADY built)
```

## Child issues / phases

| # | Phase | Priority | Depends on |
|---|---|---|---|
| A | End-to-end audit: confirm an image-story content_package (hand-crafted fixture) publishes through Aries to FB/IG live. Find any real gap in the "already built" publish path. | P0 | none |
| B | Aries request payload: extend the weekly payload to request a surface mix (feed count + story count), defaulting story count to 0 (no behavior change until Hermes supports it). | P0 | A |
| C | Hermes `social-media` skill: plan + emit M image-story entries (`placement:'story'`, image media) in the content_package, sized by the requested story count. | P0 | A, B |
| D | Story dispatch: image stories must publish live, not schedule. Add a story-dispatch path (operator "publish story now" and/or a near-real-time dispatch) that bypasses `scheduled_posts` future-time scheduling; surface stories distinctly in the dashboard. | P0 | A |
| E | Lock it in: end-to-end with a real tenant — Hermes generates a story, it appears in the dashboard, operator approves, it publishes live to IG/FB; confirm in Brendan's dashboard (user-visible PASS). | P0 | B,C,D |

### Phase A — publish-path audit (do first)
Build a fixture image-story content_package (placement:'story', image asset) and drive it through `hermes-callbacks` ingest → `synthesize-publish-posts` → the Meta publish branch, mocking the Graph calls. Confirm: surface resolves to `story`; `validateMediaForSurface` passes for an image story (single-media, no `scheduledFor`); the IG `STORIES` / FB `photo_stories` branch is selected. Fix any real gap. **Acceptance:** a story fixture reaches the correct Meta branch with no `scheduledFor`.

### Phase B — request a surface mix
Extend `payload.ts`/`types.ts` so the weekly request can ask for `storyCount` (default 0). Default-0 means zero behavior change until C lands. **Acceptance:** payload carries `storyCount`; existing feed-only flows unchanged; `staticPostCount` semantics preserved (see [[project-social-content-defaults]]).

### Phase C — Hermes emits image stories
In the `aries-content-generator` `social-media` skill, plan `storyCount` image-story entries and emit them in the content_package with `placement:'story'` + image media + the prompt/intendedUse the skill already emits per asset. **Acceptance:** a real weekly run with `storyCount>0` produces story entries Aries ingests as `surface:'story'`.

### Phase D — live story dispatch
Stories can't schedule (Meta). Add a dispatch path: stories don't go into `scheduled_posts` with a future time; instead an operator publishes them live (a "publish story now" action) or they dispatch near-real-time on approval. Surface stories distinctly from scheduled feed posts in the dashboard so the operator understands the difference. **Acceptance:** a story never gets a future `scheduled_posts` row; publishing a story hits the live Meta story branch.

### Phase E — prod verification
Real tenant, real run: Hermes generates an image story → dashboard shows it → operator approves → publishes live to IG/FB. Confirmed in Brendan's dashboard (see [[feedback-user-visible-completion]], [[feedback-treat-as-production]]).

## Testing Plan

| Layer | What | How |
|---|---|---|
| Publish path | image story → correct Meta branch, no scheduledFor | fixture content_package + mocked Graph (Phase A) |
| Ingest | entry.placement:'story' → surface:'story' | hermes-callbacks unit test |
| Payload | storyCount default 0, plumbed | payload.ts unit test |
| Dispatch | story never scheduled with future time; live publish | dispatch unit test |
| E2E | real tenant story publishes live | manual prod verify (Phase E) |

## Out of Scope (deferred — Veo/Vertex dependency)

- **Video / Reels / video-stories.** Need Vertex AI / Google Cloud auth (not configured: `gcloud` ADC unauthed, `GOOGLE_API_KEY`/`GEMINI_API_KEY` commented in `~/.hermes/.env`). `veo-video-runtime` exists but can't run without it. Once auth is provisioned, a follow-up plan wires the planner → `veo-video-runtime` (capture width/height/duration) → flip `ARIES_VIDEO_PUBLISH_ENABLED=1`. The Aries publish path for video stories/reels is already built (`#520`).
- Honcho writes (already live — auth off, no JWT needed) and honcho-performance-insights (blocked on #513 + Meta insights scopes) — unrelated.

## Files Reference

| File | Role |
|---|---|
| `backend/integrations/meta-publishing.ts:466-609` | FB photo_stories + IG STORIES image branches (built) |
| `backend/integrations/meta-media-validation.ts:113-127` | story not-schedulable + image-story validation |
| `backend/marketing/hermes-callbacks.ts:1376-1377` | placement → surface ingest (built) |
| `backend/marketing/synthesize-publish-posts.ts:445` | flag strips reel/video only (image story passes) |
| `backend/social-content/payload.ts`, `types.ts` | weekly request payload (add storyCount) |
| `~/.hermes/profiles/aries-content-generator/skills/social-media/` | Hermes weekly-content skill (emit story entries) |
