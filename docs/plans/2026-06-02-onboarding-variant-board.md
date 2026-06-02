# First-post onboarding variant board — gstack-style pick / edit / rate, feeding an Aries + Honcho taste profile

> Status: draft plan (2026-06-02). New feature. On a new user's first sign-up, generate the first post as a gstack-style comparison board: **3 full-post creative variants per slot**, the user **picks one**, with gstack-style **edits** (regenerate / more-like-this / freeform edit) and a **1-5 star rating** per variant. The pick + ratings + edits feed BOTH a new Aries per-(tenant,user) **taste profile** (fast, biases the next brief) AND **Honcho** (durable, cross-session learning). **The remaining 6 posts of that first week are then generated *after* the pick, anchored to the chosen variant's style + the taste profile** — so the whole first week visibly matches the user's choice (they finish in the background while the user lands on the dashboard). Roadmap fit: Wave 2 `onboarding-wizard` increment; depends on nothing already in flight, but shares the `creative_assets` / `media` surface and the Honcho preference path.

## Context

Today a new user finishes the 5-step onboarding wizard (`frontend/aries-v1/onboarding-flow.tsx`, steps goal → business → website → brand → channels), authenticates, and `app/onboarding/resume/page.tsx:153-158` materializes the draft by calling `startSocialContentJob({ type: 'weekly_social_content' })`. That kicks the full 4-stage Hermes pipeline (research → strategy → production → publish) which generates **7 static posts** and drops them on the dashboard. The user's *first* experience of the product's creative is therefore a finished batch they had no hand in shaping — there is no "pick the direction you like" moment, and **Aries learns nothing about the user's taste** (grep for `taste` across `backend/` returns zero hits — there is no taste store at all).

This plan adds a deliberate first-creative moment: for the **first post only**, generate **3 competing full-post variants**, show them on an in-Aries comparison board (the product analog of gstack's `/design-shotgun`), let the user pick + rate + edit, and turn that interaction into a durable taste signal that biases every future generation. It is the highest-leverage place to capture taste because it is the one moment the user is already paying attention to creative and has no campaign running yet.

### The single most important architectural correction to the recon

The variants are produced by **Aries fanning out 3 independent Hermes runs** for the slot — exactly mirroring how gstack fans out 3 parallel subagents — **not** by changing the Hermes `aries-content-generator` contract (which today emits one image per `image_generate`). This keeps the entire feature inside the Aries repo: Hermes just receives three ordinary production submissions with different briefs/seeds. `submitRawRun` (`backend/marketing/ports/hermes.ts:459`) already does single-run submission with idempotency keys, callback tokens, and profile-scoped gateway routing; we call it three times in parallel with variant-labeled `ariesRunId`s and a shared `variant_batch_id` in `callback_context`. The `one_off_post` job type already routes through the per-stage profile pipeline (`usesPerStageProfilePipeline`, `hermes.ts:131-137`), and `regenerateCreativeAsNewRun` (`app/api/social-content/jobs/[jobId]/creatives/[creativeId]/regenerate/handler.ts:45-51`) is the exact precedent for submitting one new run scoped to a single creative — which is what every board "edit" becomes.

## Who cares

- **New users / Brendan's tenant** — the first creative becomes a choice, not a fait accompli. Picking + rating + editing builds ownership and trust on day one, and "the dashboard learned what I like" is a real retention hook.
- **Product** — every later screen (weekly board, review queue) inherits a populated taste profile, so generation quality compounds instead of resetting each campaign.
- **Eng** — the feature is additive and flag-gated; the variant fan-out, the taste store, and the Honcho write are three clean, independently testable layers, and the board reuses existing approval/preview/edit components.

## Decisions (locked — do not re-litigate)

1. **A "slot" is the whole first post.** 3 complete full-post variants (image + caption together); the user picks 1. **Only the first post is a variant board**; the other 6 posts of week 1 are single (non-variant) generations. The data model carries `slot_index` so multi-slot is a later widening, not a rewrite. (User decision.)
2. **Variants come from Aries fanning out 3 parallel Hermes runs.** No Hermes-repo change. Each run is an ordinary production submission with a variant-distinct brief; results are grouped by a `variant_batch_id`. (User decision.)
3. **Board interactions: pick + 1-5 stars + the full gstack edit set** (regenerate / "more like this" / freeform edit). Each edit is a new scoped Hermes run (the gstack "evolve" analog), reusing `regenerateCreativeAsNewRun`'s pattern. (User decision.)
4. **Dual taste store — Aries DB + Honcho.** The pick/ratings/edits write to BOTH: (a) a new Aries `marketing_taste_profile` table (fast, queried at brief-build time to bias generation), and (b) Honcho via the existing preference path (durable, cross-session, cross-surface learning). This is exactly the user's ask ("feed into the user's AND Honcho's taste-profile learning"). The Aries table is the read-time bias source; Honcho is the long-term memory. (User decision + recon.)
5. **Per-(tenant, user) scope.** Taste is keyed on `(tenant_id, user_id)` (mirroring `marketing_operator_creative_preferences`), so multi-user tenants don't blend tastes. Honcho already keys on `peer-user-{pseudonym}`.
6. **Behavioral flag `ARIES_ONBOARDING_VARIANT_BOARD_ENABLED`, default OFF.** Treated as enabled on `1|true|yes|on` (mirroring `isVideoPublishEnabled`, `synthesize-publish-posts.ts:115`). When OFF, onboarding is byte-identical to today (single weekly job, no board). Honcho writes stay additionally gated by the existing `HONCHO_WRITE_PREFERENCES_ENABLED`.
7. **First-impression latency is a feature constraint.** 3× parallel runs are ~same wall-clock as one (concurrent, async-polled) but 3× token cost; the board only appears once **all three** callbacks land (`variant_board_ready`), and an abandon/timeout path **auto-picks** so a draft never hangs in `materializing`.
8. **The remaining 6 posts are generated *after* the pick, anchored to the chosen variant.** The first week is two generation phases: Phase A = the 3 variants of post #1 (board). Phase B = posts #2-7, generated only **after** the user picks, **anchored** to the chosen variant's concrete style (its visual direction + tone, passed as a campaign style anchor) **and** the freshly-written taste profile — so the whole first week matches the choice, not just future weeks. Phase B runs in the background after the user lands on the dashboard (a "rest of your week is generating" state); it is NOT a variant board (single generation per post). Total first-week cost = 3 (variants) + 6 (anchored) = **9 generations**. (User decision.)

## Current State (VERIFIED — master, 2026-06-02)

**Onboarding flow:**
- `frontend/aries-v1/onboarding-flow.tsx` — `StepKey` (:35), `STEP_DEFINITIONS` 5 steps (:55-86): goal, business, website, brand, channels. Multi-step form; no generated-post surface today.
- `app/onboarding/resume/page.tsx:153-158` — after auth, calls `startSocialContentJob({ type: 'weekly_social_content' })`; draft status `draft → ready_for_auth → materializing → materialized` (`backend/onboarding/draft-store.ts:10-14`). Job generation is immediate, not deferred.
- `backend/social-content/defaults.ts:5-7` — `static_post_count = 7`.

**Generation + ingestion (reusable as-is):**
- `backend/marketing/ports/hermes.ts:459` `submitRawRun` (single run; idempotency key + callback token + profile gateway). `:131-137` `usesPerStageProfilePipeline` already true for `one_off_post`. `:57` `DEFAULT_RUN_TIMEOUT_MS = 120_000`. Poll-bridge runs in background after submit returns.
- `app/api/social-content/jobs/[jobId]/creatives/[creativeId]/regenerate/handler.ts:45-51` `regenerateCreativeAsNewRun` — precedent for one new run scoped to a single creative (the edit primitive).
- `backend/marketing/ingest-production-assets.ts:88-109` — `creative_assets` INSERT, idempotent on `(tenant_id, checksum) WHERE checksum IS NOT NULL`; `source_asset_id` is free-form (`:165-167`); `served_asset_ref = /api/internal/hermes/media/<id>` set atomically.
- `app/api/internal/hermes/media/[...path]/route.ts:138-172` `serveById` — per-tenant ownership enforced in SQL; reuse unchanged.
- `backend/creative-memory/generatedAssets.ts:47-68` — existing `variantKind` / `learning_lifecycle` pattern (`baseline`, `memory_assisted`); extend rather than invent.

**Taste store — NONE exists:**
- Grep `taste` across `backend/` → 0 hits. Only tenant-scoped marketing persistence today is `brand-kit.json` (`generated/validated/{tenantId}/brand-kit.json`, `backend/marketing/brand-kit.ts:1417-1433`) and the `marketing_operator_creative_preferences` table (`backend/marketing/operator-creative-preferences-store.ts:49-88`, upsert ON CONFLICT).
- Brief assembly bias-in points: `backend/social-content/workflow-request.ts:130-150` `resolveCreativeBriefs()` (fallback `[primaryGoal, offer, styleVibe, audience]`), and `backend/social-content/brand-kit-payload.ts:14-32` `SocialContentBrandPayload` (+ `resolveBrandVoice` :129) — no taste dimensions today.

**Honcho (reusable path):**
- `backend/memory/write-events.ts:899-974` `recordCreativeVoicePreferenceEvent` + `scheduleCreativeVoicePreferenceHonchoWrite` — `kind='preference'`, `peer-user-{pseudonym}`, `session-onboarding-{runId}`, `scrubPreferenceLabelForHoncho` (:871-882), idempotency keys (`honcho_write_idempotency_keys`), curator auto-approve (`explicit_user_intent` + confidence ≥ 0.85, `curator.ts:202-207`).
- Gate: `isHonchoWritePreferencesEnabled()` (`honcho-env.ts:29-33`, `HONCHO_WRITE_PREFERENCES_ENABLED`). Local Honcho `host.docker.internal:8000`, auth off (`honcho-http-transport.ts:4`).
- Readback for generation: `orchestrator.loadResearchMemoryContext({ peers, tokenBudget })` (`backend/memory/orchestrator.ts:47-86`); `submit-marketing-research-job.ts:70-73` is the call template.
- `ARIES_MEMORY_LABEL_REDACTION_V2=1` keeps creative descriptors ("Bold Minimalist") while scrubbing `<First Last>` names.

**UI + endpoint patterns (reusable):**
- `app/api/marketing/jobs/[jobId]/approve/handler.ts:94-299` — tenant validation via `loadTenantContextOrResponse` (409 `onboarding_required`), resolution + Honcho schedule; the model for a new pick/rate endpoint.
- `frontend/marketing/job-approve.tsx` (ReviewPreviewCard / bundle preview), `frontend/aries-v1/creative-action-drawer.tsx:89-116` (regenerate/edit URL builders, conditional-control gate), `frontend/aries-v1/review-item.tsx:98-120` (InlineCopyEditor for copy edits), `frontend/aries-v1/components.tsx` (StatusChip / EmptyStatePanel / LoadingStateGrid).
- `app/api/social-content/jobs/[jobId]/creative-voice-preference/handler.ts:30-54` — preference-store-write + Honcho-schedule in one handler; the closest existing twin of what we're building.
- **No interactive star-rating component exists** — must build (lucide `Star`).
- Flag parser convention: `isVideoPublishEnabled` (`synthesize-publish-posts.ts:115`).

## Architecture (target flow)

```
Onboarding wizard (5 steps unchanged) ── finish ──> auth ──> /onboarding/resume
   │  (flag ON + first job)                                         │
   ▼                                                                ▼
startFirstPostVariantBatch(tenant,user)            [flag OFF → existing weekly job, unchanged]
   │  fan out 3 runs via submitRawRun (variant_batch_id, slot_index=0, variant_index 0..2)
   ▼
Hermes aries-content-generator  ×3  (concurrent, ~1 run latency, 3× tokens)
   │  3 callbacks (out of order) → buffer in runtime doc
   ▼  when all 3 land → variant_board_ready = true
ingestProductionCreativeAssetsToDb  ×3   (creative_assets rows, grouped by variant_batch_id + variant_index)
   ▼
Onboarding board step (new): VariantBoard.tsx
   3 full-post cards (image via /api/internal/hermes/media/<id> + caption)
   per card: 1-5 stars · "more like this" · "regenerate" · freeform-edit
        edit → POST regenerate-as-new-run (scoped) → swaps that card when its callback lands
   ▼  user clicks Pick on one card
POST /api/onboarding/jobs/[jobId]/variants/pick
   { slotIndex, selectedVariantId, ratings:[{variantId,score}], edits:[...] }
   │
   ├─(1)─> upsert marketing_taste_profile  (tenant,user; dimensions + decay)   ← FAST read-time bias
   ├─(2)─> scheduleOnboardingVariantTasteSignalHoncho  (peer-user, session-onboarding, kind=preference)  ← DURABLE
   ├─(3)─> build campaign_style_anchor from the chosen variant (visual direction + tone + brief hash)
   ├─(4)─> PHASE B: generate posts #2-7 anchored to campaign_style_anchor + taste  (1 run of 6, background)
   └─(5)─> finalize: chosen variant → post #1; unchosen variants archived; resume to publish/dashboard
   ▼  (user is on the dashboard; posts #2-7 stream in as Phase B lands)
This week's 7 posts all reflect the pick.  Future weeks: resolveCreativeBriefs()/brand-kit-payload
   reads marketing_taste_profile + loadResearchMemoryContext(peers:[user]) reads Honcho → biased brief.
```

The taste profile is **written in two places on every pick** (Decision 4): the Aries DB row is the read-time bias used by the very next brief; Honcho is the durable store that survives across sessions and feeds research/strategy context. Decay (5%/week, computed at read time, mirroring gstack) lives in the Aries store. **The chosen variant also produces a `campaign_style_anchor`** (its concrete visual direction + tone, not just abstract decayed dimensions) that anchors Phase B's 6 posts so they match the picked post tightly — taste dimensions bias *future* weeks; the style anchor makes *this* week consistent.

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| 1 | Data + flag foundation: `ARIES_ONBOARDING_VARIANT_BOARD_ENABLED`, `marketing_taste_profile` table + store module, Honcho `recordOnboardingVariantTasteSignalEvent`, taste-read helper + decay | Critical | 1.5d / 3h | none |
| 2 | Variant fan-out: `startFirstPostVariantBatch` (3× `submitRawRun`), `variant_batch_id`/`variant_index` grouping in `creative_assets`, callback buffering → `variant_board_ready`, abandon/timeout auto-pick | High | 3d / 5h | 1 |
| 3 | Board UI + pick/rate/edit endpoint: `VariantBoard.tsx` (3 cards, stars, edit drawer), `POST /variants/pick`, edit = `regenerateCreativeAsNewRun`, wire into onboarding step + resume | High | 4d / 6h | 1, 2 |
| 4 | Phase-B anchored generation of posts #2-7 from the pick; taste write-through + bias-back + Honcho + decay; live verify; tests; ship | High | 3.5d / 5h | 1, 2, 3 |

```
1 ─┬─> 2 ──┐
   └────────┼─> 3 ──> 4
            └────────^
```

### Phase 1 — Data + flag foundation (Critical)

1. **Flag** `isOnboardingVariantBoardEnabled()` — copy `isVideoPublishEnabled` verbatim (`1|true|yes|on`). Document in CLAUDE.md / `.env.example` / `docker-compose.yml` (default `0`).
2. **`marketing_taste_profile` table** — new migration under `migrations/` (model on `connected_accounts` migration + `init-db.js` table style). Columns: `tenant_id`, `user_id`, `dimensions jsonb` (`{tone, visual_style, color_palette, density, ...}` each `{value, confidence, approved_count, rejected_count, last_seen}`), `updated_at`. PK `(tenant_id, user_id)`. Plus an append-only `marketing_taste_signal` event log (`tenant_id, user_id, job_id, variant_batch_id, slot_index, variant_id, picked bool, rating int, edit_ops jsonb, created_at`) for auditability + Honcho replay.
3. **Store module** `backend/marketing/taste-profile-store.ts` mirroring `operator-creative-preferences-store.ts`: `getTasteProfile(tenant,user)` (applies 5%/week decay at READ time), `applyTasteSignal(...)` (upsert dimensions, Laplace `confidence = approved/(approved+rejected+1)`, ON CONFLICT). Decay computed on read so the row only changes on write — same trick as gstack.
4. **Honcho writer** `recordOnboardingVariantTasteSignalEvent` + `scheduleOnboardingVariantTasteSignalHoncho` in `backend/memory/write-events.ts` — copy `recordCreativeVoicePreferenceEvent`: `kind='preference'`, claim `JSON.stringify({event:'variant_taste_signal', schema_version:1, slot_index, variant_id, rating, edit_ops, picked})`, `peer-user-{pseudonym}`, `session-onboarding-{runId}`, `scrubPreferenceLabelForHoncho` on any label, idempotency `[jobId,'variant_taste',variantId,rating,userPseudonym,ymd]`, gated on `isHonchoWritePreferencesEnabled()`. Keep claims < 200 chars (store ids + scores, not full copy).
5. **Taste-read helper** `loadTasteForBrief(tenant,user)` returning a small `taste_dimensions` object, plus extend `loadResearchMemoryContext` callers to optionally include `peer-user`.

**Acceptance:** migration applies; `applyTasteSignal` + decayed `getTasteProfile` unit-tested; Honcho writer auto-approves with `explicit_user_intent=true` and passes label scrubbing (mirror `verify-honcho-writes` V12-V14). All behind the flag; flag OFF → zero behavior change.

### Phase 2 — Variant fan-out generation (High)

1. **`startFirstPostVariantBatch(tenant, user, draft)`** (new, `backend/marketing/onboarding-variant-batch.ts`): when the flag is ON and this is the first onboarding job, instead of (or alongside) the weekly job, submit **3 `submitRawRun` production runs** for slot 0, each with: a variant-distinct brief (vary tone/visual-direction so they genuinely diverge — the gstack anti-convergence idea), `ariesRunId = {base}-v{0..2}`, and `callback_context = { variant_batch_id, slot_index:0, variant_index }`. Reuse `one_off_post` routing (`usesPerStageProfilePipeline`).
2. **Grouping in `creative_assets`** — add nullable `variant_batch_id text` + `variant_index int` columns (backward-compatible) rather than overloading `source_asset_id` (avoids the free-form collision risk). Extend `ingestProductionCreativeAssetsToDb` to persist them from `callback_context`.
3. **Callback buffering** — accumulate the 3 callbacks in the job runtime doc; only set `variant_board_ready=true` when all 3 (or the timeout fallback) have landed. Handles out-of-order delivery; idempotent on `variant_batch_id`+`variant_index`.
4. **Abandon/timeout fallback** — if the user never picks within N minutes (or leaves), auto-pick variant 0, mark the taste signal `implicit` (low confidence), and resume so the draft never hangs in `materializing`.

**Acceptance:** a flagged onboarding job fans out exactly 3 runs; all 3 creatives ingest with distinct `variant_batch_id`/`variant_index`; `variant_board_ready` flips only after all 3; out-of-order + duplicate callbacks don't double-insert; timeout auto-picks and resumes.

### Phase 3 — Board UI + pick/rate/edit endpoint (High)

1. **`frontend/aries-v1/variant-board.tsx`** — 3 full-post cards side by side (image via `serveById` URL + caption), each with: an interactive **1-5 star** widget (new, lucide `Star`), a **Pick** button, and an **edit drawer** (reuse `creative-action-drawer.tsx` URL-builder pattern + `review-item.tsx` `InlineCopyEditor`): **regenerate**, **more like this**, **freeform edit** (text → instruction). Reuse `ReviewPreviewCard`, `StatusChip`, `LoadingStateGrid`.
2. **Edits = new scoped runs** — each edit calls `regenerateCreativeAsNewRun` (already exists) with an instruction derived from the action; the card shows a loading state and swaps when that single run's callback lands. (gstack "evolve" analog; the new image is a new `creative_assets` row in the same batch.)
3. **`POST /api/onboarding/jobs/[jobId]/variants/pick`** — model on the approve handler: `loadTenantContextOrResponse` (409 `onboarding_required`), body `{ slotIndex, selectedVariantId, ratings:[{variantId,score}], edits:[...] }`. On success: write the taste signal (Phase 4), build the `campaign_style_anchor` from the chosen variant, **trigger Phase B generation of posts #2-7** (Phase 4), finalize the chosen variant as post #1, archive unchosen, resume the pipeline.
4. **Onboarding wiring** — add a conditional `first_post_variants` step to `STEP_DEFINITIONS` (after channels) that renders a "generating your first posts…" state and then the board once `variant_board_ready`; reached from `/onboarding/resume` after `startFirstPostVariantBatch`. Flag OFF → step absent, existing flow.

**Acceptance:** with the flag ON, a new user sees 3 distinct first-post variants, can rate each 1-5, regenerate / more-like-this / freeform-edit any card (new image swaps in), and pick one; the chosen post lands on the dashboard. Flag OFF → onboarding unchanged. **Rendered in Brendan's dashboard/onboarding is the only success signal** (per memory: DB/state/mock don't count).

### Phase 4 — Phase-B anchored generation + taste write-through + Honcho + bias-back + ship (High)

1. **Dual write on pick** — the pick endpoint calls `applyTasteSignal` (Aries DB) AND `scheduleOnboardingVariantTasteSignalHoncho` (Honcho) for the picked variant (strong signal) and each rating (graded signal); edits recorded as `edit_ops`.
2. **Phase B — generate posts #2-7 anchored to the pick.** Build a `campaign_style_anchor` from the chosen variant (its visual direction + tone + the brief that produced it). Submit one anchored production run for the remaining 6 posts (reuse the weekly production path) with the anchor injected into the brief so they match the chosen post; runs in the **background** after the pick (the user is already on the dashboard). The 6 posts stream onto the dashboard as the run lands; an idempotent `variant_batch_id`/job-scoped guard prevents a replay from double-generating. Edge: if the user heavily edited the chosen variant, the anchor is built from the *final edited* creative, not the original.
3. **Bias-back (future weeks)** — `resolveCreativeBriefs` (`workflow-request.ts:130-150`) and `resolveBrandVoice`/`SocialContentBrandPayload` (`brand-kit-payload.ts`) read `loadTasteForBrief` and prepend high-confidence dimensions; the weekly Hermes dispatch context adds `peer-user` taste history via `loadResearchMemoryContext`. Decay keeps stale taste from over-biasing. (Style anchor = *this* week's consistency; taste dimensions = *future* weeks' bias.)
4. **Live verify** on the real VM via `/browse`: run a flagged onboarding, confirm the board renders 3 variants, pick+rate+edit, the chosen post lands AND posts #2-7 stream in matching the pick, and that a follow-up weekly job's brief shows the learned taste; confirm the Honcho write landed (local Honcho `host.docker.internal:8000`).
5. **Ship** — `/ship`, bump VERSION + CHANGELOG; full CI-exact suite before push.

**Acceptance:** pick/ratings/edits persist to both stores; **posts #2-7 of the first week are generated after the pick and visibly match the chosen variant's style**; a subsequent week's brief demonstrably reflects the picked direction; Honcho shows the `variant_taste_signal` preference under `peer-user`. `full-suite` green. Flag flipped to `1` in prod only after the rendered-dashboard screenshot is approved.

## Feature flag

**`ARIES_ONBOARDING_VARIANT_BOARD_ENABLED`** — rollout switch for the first-post variant board. `1|true|yes|on` = enabled. Default **OFF**. When OFF, onboarding runs the existing single weekly job with no board (byte-identical to today). When ON, the first onboarding job fans out 3 variant runs for slot 0, shows the board, and writes taste signals to the Aries `marketing_taste_profile` table and to Honcho (the latter still additionally gated by `HONCHO_WRITE_PREFERENCES_ENABLED`). Process-wide (all tenants in the container). Document alongside the other `ARIES_*_ENABLED` flags in CLAUDE.md.

## User-visible success bar (rendered UI only)

Done = **with the flag ON, a brand-new user's onboarding shows a 3-variant first-post board, the user picks/rates/edits, the chosen post renders on the dashboard, the remaining 6 posts of that first week generate from the pick and visibly match it, and a later week is biased by the taste profile** — verified by screenshot in the live dashboard:
- The onboarding board renders 3 genuinely different full-post variants (image + caption), not 3 near-duplicates.
- Each card has a working 1-5 star control and regenerate / more-like-this / freeform-edit; an edit swaps that card's image.
- Picking finalizes that post; it appears on the dashboard.
- **Posts #2-7 of the same first week then stream in, anchored to the chosen variant's style (same visual direction/tone) — the whole first week looks like the pick.**
- A follow-up weekly job's creative reflects the learned taste (e.g. the picked tone/visual direction shows up), and Honcho holds the `variant_taste_signal`.

DB rows, state files, or passing tests do **not** count on their own — the rendered onboarding + dashboard does.

## Testing + CI-exact verify

| Layer | What |
|-------|------|
| Unit (self-contained) | flag parser (`1/true/yes/on` ⇒ on); `applyTasteSignal` Laplace + 5%/week read-time decay; `getTasteProfile` decayed output; brief bias injection ordering |
| Unit | callback buffering (out-of-order + duplicate ⇒ single board-ready, no double-insert); abandon/timeout auto-pick |
| Honcho (verify-honcho-writes) | `variant_taste_signal` auto-approves with `explicit_user_intent`; label scrubbing on descriptors; idempotency (V12-V14 template) |
| requires-infra (live DB) | `marketing_taste_profile` + `marketing_taste_signal` migration + upsert + creative_assets variant grouping (gate behind `ARIES_TEST_REQUIRES_INFRA_ENABLED`) |
| Render (manual, live) | flagged onboarding via `/browse`: 3-variant board, pick+rate+edit, dashboard render, next-job bias; before/after screenshots |
| Regression | full suite green with flag OFF (proves zero behavior change) and ON |

CI-exact before push: `npm run typecheck` · `npm run lint` · the new test files via `tsx --test` · `npm run verify` · `npm run test:concurrent` (touches orchestrator/ports/ingest). Append the new self-contained tests to `scripts/verify-regression-suite.mjs`.

## Rollback

- **Flag:** `ARIES_ONBOARDING_VARIANT_BOARD_ENABLED=0` ⇒ onboarding reverts to the single weekly job, no board, no variant runs, no taste writes. Instant, no redeploy.
- **Code:** all changes additive — new flag, new tables (nullable `creative_assets` columns), new store/Honcho-writer/endpoint/component, a conditional onboarding step. Reverting the commit restores today's flow exactly.
- **Data:** taste tables are append/upsert and read-only-biasing; dropping them degrades to no-taste generation, no campaign impact. Honcho writes are idempotent and gated.

## Risks

- **Cost/latency at the most latency-sensitive moment (first impression).** First week = 3 variant runs (Phase A) + 6 anchored runs (Phase B) = 9 generations vs 7 today (~+2 net, since the picked variant replaces one of the 7). Mitigation: Phase A's 3 runs are concurrent (~1-run wall-clock); the board only shows on `variant_board_ready`; **Phase B runs in the background after the pick** (user already on the dashboard), so it adds no perceived wait to the board moment; an explicit "generating the rest of your week…" state covers it. Only post #1 is a board (not all 7), capping the variant fan-out.
- **Out-of-order / duplicate callbacks** for the 3 parallel runs. Mitigation: buffer all 3 in the runtime doc keyed by `variant_batch_id`+`variant_index`; idempotent ingest on checksum.
- **Abandonment** — user leaves before picking. Mitigation: timeout auto-pick (variant 0, implicit low-confidence signal) so the draft resumes; never hang in `materializing`.
- **Orphan unchosen variants** accumulate in `creative_assets` (3-9 per onboarding, ×retries). Mitigation: tag rows with `variant_batch_id`; archive (not serve) unchosen on pick; optional batch cleanup later.
- **Edits cost extra runs.** Each regenerate/more-like-this/freeform = one more Hermes run. Mitigation: per-card edits regenerate only that card; cap edit count in the UI; reuse `regenerateCreativeAsNewRun`.
- **Two taste stores can drift** (Aries DB vs Honcho). Mitigation: single write path (the pick endpoint) writes both atomically-ish; Aries DB is the read-time source of truth for biasing, Honcho is durable memory — different roles, so divergence is tolerable, and the `marketing_taste_signal` log lets Honcho be rebuilt.
- **Honcho session-kind reuse** — reuse the existing `session-onboarding-{runId}` + `peer-user` (already supported); do NOT invent a new `SessionRef.kind` (recon flagged a 422 risk). Keep `runId` stable across the onboarding flow.
- **Multi-user tenant** — key on `(tenant_id, user_id)` so a teammate's taste doesn't overwrite the owner's.
- **New star-rating component** is net-new UI; keep it tiny and accessible (keyboard + aria), follow the a11y patterns the repo already enforces (heading-order/unique-title work in recent ships).

## Out of scope

- **Changing the Hermes `aries-content-generator` contract** to emit N variants — explicitly avoided (Decision 2); fan-out stays Aries-side.
- **Multi-slot boards** (3 variants for each of several posts) — data model supports `slot_index`, but MVP is 1 slot.
- **A standalone post-onboarding "remix any post from 3 variants" surface** — this plan is onboarding-only; the weekly board is a later roadmap item that can reuse this machinery.
- **Cross-tenant taste aggregation / market-signal learning** in Honcho — keep taste in `peer-user` only.
- **Orphan-variant cleanup job** — tag now, build the sweeper later if volume warrants.
- **Brand-token (brand-v2) work** — independent; the board inherits whatever theme ships.

## Related

- gstack `/design-shotgun` — the UX reference (3 variants, board-as-chooser, stars, evolve/remix, `taste-profile.json` with confidence + 5%/week decay). This plan is its Aries-native, multi-tenant, durable analog.
- `docs/plans/2026-06-01-brand-design-tokens.md` — house-style reference + the `ARIES_*_ENABLED` flag pattern.
- Memory: `project-honcho-writes-already-live` (local Honcho auth off, reachable), `feedback-user-visible-completion` (rendered dashboard is the only PASS), `project-hermes-agent-decomposition` (3-profile content generator), `feedback-treat-as-production`.
- CLAUDE.md guardrails honored: default-OFF flag, rendered-UI success bar, full CI-exact suite before push, resumability (buffer + auto-pick, never lose partial creative), tenant-scoped server-side validation.
