# Review Queue v2 — diff, brand-fit, risk flags, history, revision brief, publish summary

> Status: draft plan (2026-06-01). Roadmap area [3] ("make the Review Queue the emotional center"), Phase 2, priority 5 / build-first #5. Behind `ARIES_REVIEW_QUEUE_V2_ENABLED` (default OFF). **Reconciles RECON 5:** the decision endpoints it called "missing" already exist (`app/api/marketing/reviews/[reviewId]/decision/route.ts` handles `approve | changes_requested | reject`; `app/api/marketing/jobs/[jobId]/approve/route.ts` exists). This plan does NOT re-plan decision plumbing — it adds the v2 review-surface intelligence on top of it.

## Context

The Review Queue is where a human decides whether anything Aries generated is allowed to go live. The guardrail "nothing publishes without human approval" is enforced *here*. Today that surface is thin: `frontend/aries-v1/review-item.tsx` renders a status chip, a copy editor, content sections, three decision buttons, and a flat decision-history list. The reviewer is asked to approve with almost no decision support — no way to see *what changed* between revisions, no signal for *how on-brand* the copy is, no surfaced *risk* (unverifiable claims, platform-limit breaches, missing citations, off-brand tone), no one-click way to send the asset back with a specific revision direction, and no final "here is exactly what publishing will do" confirmation before the approve click that triggers a live Meta post.

This epic turns that surface into a decision cockpit while changing **zero** publishing behavior. Every new element is *read-only decision support* plus one *revision-request* path that reuses the existing regenerate plumbing. The approve/changes/reject buttons, the resume-the-pipeline semantics, and the "approve = the pipeline advances" contract are unchanged. We are making the human's approval *better-informed*, not more automatic.

Six features, all absent from `review-item.tsx` today:
1. **Side-by-side version diff** — `currentVersion` vs `previousVersion` (the type already carries both; `previousVersion` is always `undefined` today — we populate it).
2. **Brand-fit score** — a 0–100 heuristic comparing the copy against the tenant brand-kit voice/offer/palette signals (`backend/marketing/brand-kit.ts` already normalizes these).
3. **Risk flags** — claims / risky-promises / platform-issue / missing-citations / off-brand, computed server-side, fail-soft (advisory, never auto-blocking).
4. **Approval history (who / when / why)** — already has a `history` array; v2 makes it complete and legible (actor, timestamp in tenant zone, decision, note).
5. **One-click revision brief** — "warmer / shorter / more premium / less hype" preset directives that attach to a `changes_requested` decision and (for creative assets) seed a regenerate via the existing `/regenerate` endpoint.
6. **Final publish summary** — exact platforms / copy / media / scheduled time / approval state, shown before the approve that resumes the publish stage.

## Who cares

- **Operators / @sugarandleather** — they are the single human gate before a live post. Right now they approve nearly blind. Brand-fit + risk flags + the publish summary are the difference between "I clicked approve" and "I saw exactly what would publish and that it's on-brand and claim-safe."
- **Product** — "the Review Queue is the emotional center" is a roadmap headline. A thin approve button is not a center.
- **Trust framing** — "Aries is safety-first; nothing goes live without approval, and every publish action is traceable." Risk flags + publish summary + complete history *are* that traceability, rendered.

## Decisions (locked — do not re-litigate)

1. **Decision endpoints are reused as-is.** `recordMarketingReviewDecision` (`backend/marketing/runtime-views.ts:1994`) and the route at `app/api/marketing/reviews/[reviewId]/decision/route.ts` already accept `approve | changes_requested | reject` + `note` + `approvalId`. The only addition is an optional `revisionBrief` field threaded through the existing `note` channel — no new decision verb.
2. **All v2 intelligence is server-computed and read-only.** Brand-fit, risk flags, and diff are derived in `runtime-views.ts` when the `RuntimeReviewItem` is built, returned as new optional fields, and *rendered* in `review-item.tsx`. No client-side scoring (must be testable + deterministic). They are **advisory** — a high-risk flag never disables the approve button. The human still decides. (Auto-blocking would be a publishing-policy decision, out of scope; see roadmap [14].)
3. **Revision brief reuses regenerate, does not invent a new pipeline.** The four presets map to directive strings appended to the `changes_requested` note (always) and, for creative-asset items only, to the body of the existing `POST /api/social-content/jobs/:jobId/creatives/:creativeId/regenerate` call (`creative-action-drawer.tsx:347`, URL builder `regenerateCreativeUrl` at `:106`). No new Hermes contract for copy; the strategist already re-reads operator notes on resume.
4. **`previousVersion` is sourced from the runtime edit-state + history, not a new store.** `backend/marketing/runtime-edit-state.ts` already persists prior headline/supporting-text edits per review item (`ReviewItemEdit` carries `headline`/`supportingText` overrides plus a `previous` `{headline, supportingText}` snapshot — its docstring exists explicitly to power "previous draft diffs"). The diff's "previous" side is the last persisted edit (or the original generated copy when no edit exists). **Note:** `ReviewItemEdit.previous` is only `{headline, supportingText}`, while the `RuntimeReviewItem.previousVersion` shape also needs `id`/`label`/`cta`/`notes` — the builder synthesizes those by carrying them from `currentVersion`. No new schema.
5. **Risk flags are heuristic + sourced, never an LLM call.** Platform-limit flags come from the existing `validateCaption` (`backend/social-content/caption-validator.ts:33`). Claims / risky-promises / off-brand / missing-citations are bounded keyword/regex heuristics over the copy + brand-kit signals. This keeps them deterministic, testable, and free of a per-render gateway hop (CLAUDE.md guardrail #1: no new fan-out on the hot review path). **`validateCaption` only accepts the narrow `Channel` union `'instagram_feed' | 'facebook_feed'`, while `RuntimeReviewItem.channel` is a free-form `string`** — `evaluateRiskFlags` maps the item channel to that union and fail-soft skips the `platform` flag for any unmapped channel (never throws).
6. **Flag gates rendering only.** `ARIES_REVIEW_QUEUE_V2_ENABLED=0` ⇒ the API still returns the new fields (cheap, pure), but `review-item.tsx` does not render the v2 panels and falls back to today's exact layout. This lets us ship the compute + tests first and flip UI independently, and gives an instant revert.
7. **No autonomous anything.** Nothing here publishes, approves, or regenerates without an explicit human click. The publish summary is the *last thing the human sees before* clicking approve, not a substitute for it.

## Current State (VERIFIED — branch @ v0.1.13.18)

**Review queue list — `frontend/aries-v1/review-queue.tsx`:**
- Reads `useRuntimeReviews()` (`hooks/use-runtime-reviews.ts`); renders cards already showing `item.currentVersion.label`, `item.history.length` ("Decision history"), `item.channel`, `item.placement`. The view-model is richer than the card uses.

**Review detail — `frontend/aries-v1/review-item.tsx` (736 lines):**
- `InlineCopyEditor` (line 98) autosaves headline/supporting-text via `review.updateCopy`.
- Decision flow `applyDecision` (line 379) posts `approve | changes_requested | reject` with a required note for destructive actions (`isDestructiveActionBlocked`); reject `confirm()`s; a 1s submit floor guards double-click (line ~397).
- Renders preview, sections (with `brandKitVisuals` swatches/fonts), the decision panel, and a flat **Decision history** panel (`ShellPanel eyebrow="History"`) sorting `reviewItem.history` by `at` with `formatInTenantZone`.
- **No diff panel, no brand-fit, no risk flags, no revision-brief presets, no publish summary.** `previousVersion` is in the type but never read.

**View-model — `backend/marketing/runtime-views.ts` (2203 lines):**
- `RuntimeReviewItem` type (line 125) already has `currentVersion`, optional `previousVersion` (line 147), `lastDecision`, `sections`, `attachments`, `history`. `previousVersion` is set to `undefined` in every builder (`stageReviewItem`@592 sets it at 619; `creativeReviewItem`@628 sets it at 655; `publishPreviewReviewItems`@697 sets it at 733; plus 1150).
- `recordMarketingReviewDecision` (line 1994), `lookupMarketingReviewItemForTenant` (line 1967), and `resolveRuntimeReviewItem` (line 1512) are the live decision/read paths. `lookupMarketingReviewItemForTenant` already loads `runtimeDoc` (so `normalizeBrandKitSignals(runtimeDoc.brand_kit)` and `getReviewItemEdit(jobId, tenantId, reviewId)` are reachable at the return point).
- `runtime-edit-state.ts` (`getReviewItemEdit(jobId, tenantId, reviewId)`:123, `recordReviewItemEdit`:99, `loadReviewEditState`:59) persists prior copy edits — the source for the diff's "previous" side.
- `reviewBundle.platformPreviews` (consumed at `publishPreviewReviewItems`:707, with `preview.mediaAssets` / `preview.assetLinks`) already carries per-platform display title / summary / media assets — the source for the publish summary. **`reviewBundle` lives on the `status` object (`getMarketingJobStatus`), which is built inside `buildReviewItemsForJob` (line 1289) but is NOT surfaced up to `lookupMarketingReviewItemForTenant` / `resolveRuntimeReviewItem`** — so the publish-summary enrichment must either (a) thread `status`/`reviewBundle` through to the lookup return point, or (b) derive the summary from the publish-stage item's own already-populated `attachments`/`sections` (which `publishPreviewReviewItems` already fills from `platformPreviews`). The latter avoids a second `getMarketingJobStatus` build; the builder picks (b) unless the per-target fields it needs are absent from the item, in which case it threads `status` through.

**API + types:**
- `lib/api/aries-v1.ts:96` mirrors `RuntimeReviewItem` for the browser (incl. optional `previousVersion`); `ReviewItemResponse` (line 255) wraps `{ review }`. `lib/api/marketing.ts:316` defines `MarketingReviewSection` / `:334` `MarketingReviewAttachment`.
- `app/api/marketing/reviews/[reviewId]/route.ts` GET returns `{ review: lookup.review }` **verbatim** (line 41) — so additive optional fields on `RuntimeReviewItem` flow to the browser with **no route change**.
- `app/api/marketing/reviews/[reviewId]/decision/route.ts` validates exactly `approve | changes_requested | reject` and `actedBy`; reads `note` + `approvalId`; calls `recordMarketingReviewDecision`.

**Risk + brand signal sources that already exist:**
- `validateCaption` (`backend/social-content/caption-validator.ts:33`) → `caption_too_long`, `too_many_hashtags`, `caption_empty` per `instagram_feed` / `facebook_feed`.
- `normalizeBrandKitSignals` (`backend/marketing/brand-kit.ts:1267`, already imported in `runtime-views.ts:16`) → `brand_voice_summary`, `offer_summary`, `tone_of_voice`, `palette`, `font_families`.

**Tests already present:** `tests/review-inline-edit.test.ts`, `tests/review-flow-destructive-guards.test.ts` (asserts `isDestructiveActionBlocked`), `tests/review-creative-action-drawer.test.ts`, `tests/marketing/review-queue-skips-failed-jobs.test.ts` (last is in the fast suite, `scripts/verify-regression-suite.mjs:111`).

## Architecture (target data flow)

```
GET /api/marketing/reviews/:reviewId   (route returns { review } verbatim — no route change)
  → lookupMarketingReviewItemForTenant (runtime-views.ts:1967)  [already loads runtimeDoc]
       builds RuntimeReviewItem, then ENRICHES with:
         ├─ previousVersion   ← getReviewItemEdit(jobId, tenantId, reviewId) prior edit (or original copy)  [reuse]
         │                       (synthesize id/label/cta/notes from currentVersion; edit-state stores only headline/supportingText)
         ├─ diff              ← computeReviewDiff(current, previous)                 [NEW pure fn]
         ├─ brandFit          ← scoreBrandFit(copy, normalizeBrandKitSignals(runtimeDoc.brand_kit))  [NEW pure fn]
         ├─ riskFlags         ← evaluateRiskFlags(copy, channel, brandSignals)      [NEW pure fn]
         │                       (platform flags map item.channel → Channel union, then delegate to validateCaption; fail-soft) [reuse]
         └─ publishSummary    ← buildPublishSummary(item.attachments/sections | reviewBundle, scheduledFor) [NEW pure fn]
  → ReviewItemResponse { review: { …, diff?, brandFit?, riskFlags?, publishSummary? } }
       │
       ▼
review-item.tsx  (when ARIES_REVIEW_QUEUE_V2_ENABLED)
   ├─ <VersionDiffPanel current previous diff />
   ├─ <BrandFitBadge score band reasons />
   ├─ <RiskFlagsPanel flags />            (advisory — does NOT disable Approve)
   ├─ <RevisionBriefPresets onSelect />   → seeds note + (creative) regenerate body
   ├─ … existing decision buttons (unchanged) …
   ├─ <ApprovalHistoryPanel history />    (upgraded legibility)
   └─ <PublishSummaryPanel publishSummary /> (shown for publish-stage items, above Approve)

POST /api/marketing/reviews/:reviewId/decision
   body { action, actedBy, note, approvalId, revisionBrief? }   ← revisionBrief folded into note
   (unchanged decision semantics)
```

## Child phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Compute layer: pure scoring/diff/risk/summary fns + types (server, no UI) | Critical | 4h / 1.5h | none |
| B | Wire enrichment into `RuntimeReviewItem` builders + API types; tests | High | 3h / 1h | A |
| C | UI panels behind flag: diff, brand-fit, risk, history upgrade | High | 5h / 2h | B |
| D | Revision-brief presets → note + regenerate seed | High | 3h / 1h | C |
| E | Publish-summary panel (publish-stage items) | Medium | 3h / 1h | B, C |
| F | Flag wiring, docs, route-manifest, live verify on tenant, ship | Medium | 3h / 1h | C, D, E |

**Sequencing:** A first (everything reads the pure fns). B threads them into the existing view-model and locks the API contract. C/E render. D depends on C (presets live in the decision panel). F last.

```
A ─> B ─┬─> C ─┬─> D ──┐
        │      └───────┼─> F
        └─> E ─────────┘
```

---

### A — Compute layer (Critical, 4h)

**New file `backend/marketing/review-intelligence.ts`** — all pure, all unit-testable, no I/O, no gateway:

1. `computeReviewDiff(current, previous)` → `{ headline: DiffSegments; supportingText: DiffSegments; cta: DiffSegments; changed: boolean }`. Word-level LCS diff (small, deterministic; no dependency — implement inline). `changed:false` when previous is absent or identical.
2. `scoreBrandFit(copy, brandSignals)` → `{ score: 0–100; band: 'strong' | 'fair' | 'weak'; reasons: string[] }`. Heuristic, additive/subtractive over: voice-keyword overlap with `brand_voice_summary` / `tone_of_voice`, offer-term presence from `offer_summary`, hype-marker penalty, all-caps/excess-exclamation penalty. Deterministic; documented weights; reasons are operator-readable ("Mentions the core offer", "Tone reads more hype than the brand voice").
3. `evaluateRiskFlags(copy, channel, brandSignals)` → `RiskFlag[]` where `RiskFlag = { kind: 'claim' | 'risky_promise' | 'platform' | 'missing_citation' | 'off_brand'; severity: 'info' | 'warn'; message: string; evidence?: string }`.
   - `platform`: map the item's free-form `channel` string onto the `validateCaption` `Channel` union (`'instagram_feed' | 'facebook_feed'`); when it maps, delegate to `validateCaption({ channel, text, hashtags })` and map its codes (reuse, not re-implement); when it does NOT map (e.g. story/reel/unknown channels), fail-soft and emit no `platform` flag. Never throws.
   - `claim`: bounded regex for superlatives/absolutes ("best", "guaranteed", "#1", "clinically", "proven") **without** an accompanying source/link.
   - `risky_promise`: outcome/result promises ("you will", "results in X days", "100%").
   - `missing_citation`: a `claim` hit with no URL/citation present in copy or attachments.
   - `off_brand`: low brand-fit band OR presence of a tenant must-avoid term (when available in brand signals).
   - Empty array is valid (clean copy). Never throws.
4. `buildPublishSummary(source, scheduledFor, channel, copy)` → `{ targets: Array<{ platform; surface; copyPreview; mediaCount; mediaThumbUrl? }>; scheduledFor; approvalState }` derived purely from the publish-stage item's already-populated `attachments`/`sections` (filled from `reviewBundle.platformPreviews` by `publishPreviewReviewItems`) — or, when those lack a needed per-target field, from a `reviewBundle` threaded in by Phase B. No new fetch inside this pure fn.

**Types** added to the same file and re-exported through `lib/api/marketing.ts` (so both server and browser share them): `ReviewDiff`, `BrandFitScore`, `RiskFlag`, `ReviewPublishSummary`.

**Acceptance:** unit table green (Phase A tests below). `npm run typecheck` clean. No file in `app/`, `frontend/`, or any route imports changed yet.

### B — Wire enrichment into the view-model (High, 3h)

**`backend/marketing/runtime-views.ts`:**
1. Extend `RuntimeReviewItem` (line 125) with optional `diff?: ReviewDiff; brandFit?: BrandFitScore; riskFlags?: RiskFlag[]; publishSummary?: ReviewPublishSummary;`.
2. In `lookupMarketingReviewItemForTenant` (line 1967) — after the item is resolved via `resolveRuntimeReviewItem`, before the `{ status: 'ok', review }` return — populate `previousVersion` from `getReviewItemEdit(jobId, tenantId, reviewId)` (reuse `runtime-edit-state.ts`): the prior persisted edit becomes `previousVersion` (synthesize `id`/`label`/`cta`/`notes` from `currentVersion`, since the edit-state row stores only `headline`/`supportingText`); when none, leave `undefined` and `diff.changed:false`.
3. Call the four Phase-A fns to fill `diff` / `brandFit` / `riskFlags` / `publishSummary`. Brand signals via the already-imported `normalizeBrandKitSignals(runtimeDoc.brand_kit)`. For `publishSummary`, derive from the item's own `attachments`/`sections` when sufficient; otherwise have `lookupMarketingReviewItemForTenant` build `status = await getMarketingJobStatus(jobId)` once and pass `status.reviewBundle` to `buildPublishSummary` (this is a single-item lookup, so the extra `getMarketingJobStatus` is bounded and off the list path). **Compute only on single-item lookup, NOT on the list** (`listMarketingReviewQueueForTenant`:1945) — the list is already the perf-sensitive path (CLAUDE.md social-content list-perf memory). The queue card needs only counts/labels it already has.
4. Mirror the new optional fields into `lib/api/aries-v1.ts:96` `RuntimeReviewItem`. (The GET route returns `{ review }` verbatim, so no route change is needed.)

**Tests (`tests/review-intelligence-enrichment.test.ts`, NEW):** a fixture runtime doc + edit-state → `lookupMarketingReviewItemForTenant` returns populated `diff`/`brandFit`/`riskFlags`; a clean fixture returns `riskFlags: []`, `brandFit.band:'strong'`; list lookup does NOT populate them (perf guard assertion).

**Acceptance:** API JSON for a real review item carries the four fields; list endpoint shape unchanged; `npm run typecheck` clean.

### C — UI panels behind flag (High, 5h)

**`frontend/aries-v1/review-item.tsx`** + small new sibling components (`frontend/aries-v1/review-v2/`):
1. Add a client-readable flag accessor — `app/review/[reviewId]/page.tsx` is an async server component (it already calls `handleGetMarketingReviewItem` server-side), so read `process.env.ARIES_REVIEW_QUEUE_V2_ENABLED` there and pass `v2Enabled` as a screen prop to `AriesReviewItemScreen`. When OFF, render today's exact layout.
2. `<VersionDiffPanel>` — side-by-side current/previous with the `diff` segments highlighted (added/removed). Hidden when `diff.changed === false`.
3. `<BrandFitBadge>` — score ring + band label + collapsible reasons. Calm/editorial, not a gamified meter.
4. `<RiskFlagsPanel>` — grouped by kind, `warn` amber / `info` muted; each shows message + evidence. **Renders above the decision buttons; does not disable them.** Empty ⇒ a quiet "No risks flagged" line (positive trust signal).
5. Upgrade the existing **Decision history** panel into `<ApprovalHistoryPanel>`: keep the existing sort + tenant-zone formatting (`formatInTenantZone` / `tenantZoneAbbreviation`), add explicit who / when / decision / why columns; "why" is the note.

**Acceptance (user-visible):** with the flag ON, on a real creative review item in the operator dashboard, the reviewer sees a diff vs the prior edit, a brand-fit badge, a risk-flags panel (or "No risks flagged"), and a legible who/when/why history — all rendered, on `aries.sugarandleather.com`. Flag OFF ⇒ pixel-identical to today.

### D — Revision-brief presets (High, 3h)

**`frontend/aries-v1/review-item.tsx` decision panel + new `frontend/aries-v1/review-v2/revision-brief.tsx`:**
1. Four preset chips — **Warmer**, **Shorter**, **More premium**, **Less hype** — above the note textarea. Selecting one appends a canonical directive sentence to the note (operator can edit/stack). Selection state is visible; presets are additive.
2. The presets satisfy the existing "comment required for changes_requested/reject" guard (`isDestructiveActionBlocked` — a preset *is* a comment), so `changes_requested` becomes one click + confirm.
3. For **creative-asset** items only (`reviewType === 'creative' && assetId`), a "Request changes + regenerate" affordance posts the `changes_requested` decision AND fires the existing `POST /…/creatives/:creativeId/regenerate` (reuse `regenerateCreativeUrl`, `creative-action-drawer.tsx:106`) with the directive in the body. Copy-only items (brand/strategy/workflow_approval) get note-only — no regenerate.
4. Thread an optional `revisionBrief?: { preset: string; directive: string }` through `submitDecision` → the decision route. The route folds `revisionBrief.directive` into `note` server-side (no new decision verb; back-compat preserved). Update `app/api/marketing/reviews/[reviewId]/decision/route.ts` to accept and merge the optional field.

**Acceptance (user-visible):** clicking "Shorter" then "Request changes" on a creative item records a `changes_requested` decision whose note contains the directive (visible in the upgraded history panel) and, for a creative asset, triggers a regenerate run — all rendered/observable in the dashboard. No autonomous regenerate without the click.

### E — Publish-summary panel (Medium, 3h)

**`frontend/aries-v1/review-v2/publish-summary.tsx` + `review-item.tsx`:**
1. For items whose `workflowStage === 'publish'` (or `publishSummary` present), render `<PublishSummaryPanel>` directly above the decision buttons: per-target platform · surface · exact copy preview · media count + thumbnail · scheduled time (tenant zone) · approval state. This is the "exactly what publishing will do" confirmation.
2. Brand-URL guardrail: any CTA/destination shown must render `aries.sugarandleather.com`, never bare `sugarandleather.com` — the summary echoes whatever the bundle holds; add a render-time assertion in tests that the wrong host never appears.

**Acceptance (user-visible):** on a publish-stage review item, the operator sees a full publish summary (platforms/copy/media/time/approval) before the approve click that resumes the publish stage.

### F — Flag + docs + verify + ship (Medium, 3h)

1. `ARIES_REVIEW_QUEUE_V2_ENABLED` (default OFF): document in `CLAUDE.md` "Environment Variables", `.env.example`, `docker-compose.yml`. Accept `1|true|yes|on` (match existing flag parsing convention — confirmed across `orchestrator.ts:525`, `synthesize-publish-posts.ts:117`, `hermes-callbacks.ts:1037`, etc.).
2. `ROUTE_MANIFEST.md`: no new routes (reuses `/review`, `/review/:reviewId`, the decision + regenerate routes); add a note that the review surfaces gain v2 panels under the flag.
3. Live verify on the production tenant with the flag ON in a scratch shell: a real creative review item renders diff + brand-fit + risk + history; a publish-stage item renders the publish summary; a "Shorter + request changes" round-trips. Per the user-visible-completion memory: only rendered-in-dashboard counts.
4. `/ship-triage-deploy`; bump `VERSION` (minor — new optional contract fields + UI) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ review surface pixel-identical to today, new API fields inert; flag ON ⇒ all six features render on `aries.sugarandleather.com`; `full-suite` gate green.

## Feature flag

`ARIES_REVIEW_QUEUE_V2_ENABLED` — rollout switch for the Review Queue v2 decision-support panels (side-by-side version diff, brand-fit score, advisory risk flags, upgraded who/when/why approval history, one-click revision-brief presets, and the final publish summary). Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, the review-item API still returns the (cheap, pure) `diff`/`brandFit`/`riskFlags`/`publishSummary` fields but `review-item.tsx` renders the exact pre-v2 layout. When ON, the v2 panels render. All v2 signals are **advisory** — a risk flag or weak brand-fit never disables the Approve button; the human still decides, and nothing publishes or regenerates without an explicit click. Process-wide (affects all tenants in this container). Set to `0` for an instant revert to the legacy review surface.

## Data / contract changes

- **No DB migration.** `previousVersion` reuses `runtime-edit-state.ts`; all v2 fields are derived at read time.
- **Additive API fields** on `RuntimeReviewItem` (server `runtime-views.ts` + browser `lib/api/aries-v1.ts`): `diff?`, `brandFit?`, `riskFlags?`, `publishSummary?` — all optional, so old clients/tests pass through. The GET route returns `{ review }` verbatim, so no route change is needed for the read path.
- **Decision route** gains optional `revisionBrief?: { preset; directive }`, folded into the existing `note`. No new decision verb; existing callers unaffected.
- New shared types in `lib/api/marketing.ts`: `ReviewDiff`, `BrandFitScore`, `RiskFlag`, `ReviewPublishSummary`.

## Testing plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit | `computeReviewDiff`: identical ⇒ `changed:false`; word add/remove ⇒ segments; missing previous ⇒ no diff | +3 |
| Unit | `scoreBrandFit`: on-voice copy ⇒ `strong`; hype/all-caps ⇒ penalty + reasons; offer-term presence bumps score; deterministic | +4 |
| Unit | `evaluateRiskFlags`: clean ⇒ `[]`; over-limit IG caption ⇒ `platform` (via `validateCaption`); unmapped channel ⇒ NO `platform` flag (fail-soft); "guaranteed best" ⇒ `claim`+`missing_citation`; "you will lose 10lbs" ⇒ `risky_promise`; weak brand-fit ⇒ `off_brand` | +6 |
| Unit | `buildPublishSummary`: bundle/attachments ⇒ per-target rows; brand URL is `aries.sugarandleather.com`, bare host never appears | +2 |
| Integration | `lookupMarketingReviewItemForTenant` populates all four fields on single lookup; `listMarketingReviewQueueForTenant` does NOT (perf guard) | +2 |
| Integration | decision route folds `revisionBrief.directive` into `note`; legacy body (no `revisionBrief`) unchanged | +2 |
| UI (component) | flag OFF ⇒ no v2 panels (legacy markup); flag ON ⇒ diff/brand-fit/risk/history render; risk flag does NOT disable Approve | +3 |
| UI (component) | revision preset appends directive to note; "Shorter + request changes" on creative fires regenerate; copy-only item is note-only | +2 |
| Live (manual) | tenant review item renders all six features in the dashboard; publish-stage item shows publish summary | manual |

**~24 automated + 1 manual.** New test files (`review-intelligence.test.ts`, `review-intelligence-enrichment.test.ts`, `review-v2-panels.test.ts`, `review-revision-brief.test.ts`) allowlisted in `scripts/verify-regression-suite.mjs`. All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run verify` (fast regression suite, includes the allowlisted new files) before ship; the **`full-suite` CI gate (required on master)** is the real backstop that executes every test file. Note: `npm run test:concurrent` runs only a fixed 3-file subset (`agent-operational-guardrails`, `production-process-concurrency`, `post-workspace-state`) — it will NOT exercise the new review-v2 tests, so do not rely on it for this change; rely on `verify` + `full-suite`. Existing `tests/review-inline-edit.test.ts` / `review-flow-destructive-guards.test.ts` / `review-creative-action-drawer.test.ts` must stay green (the v2 fields are optional — assert no regression).

## Resumability / idempotency

- All v2 compute is pure and stateless — recomputed on each read; nothing to resume.
- The revision-brief regenerate path reuses the existing regenerate endpoint, which is already idempotent on `new_run_id`; a double-click is guarded by the existing 1s submit floor (`review-item.tsx:~397`) and the drawer's submit lock.
- Decision semantics are untouched, so the existing approval idempotency (stale `approvalId` ⇒ no-op, `runtime-views.ts`) still holds.

## Rollout

- **Flag default OFF.** Land A+B (compute + contract, invisible) first; soak the API shape. Then land C/D/E (UI). Flip `ARIES_REVIEW_QUEUE_V2_ENABLED=1` in `docker-compose.yml` only after the live-tenant render check passes.
- **Instant revert:** set the flag to `0` — the review surface returns to today's layout with no redeploy of logic.

## Out of scope

- **Auto-blocking on risk flags / publishing policies** (e.g. "off-brand cannot be approved", "claims require sign-off") — that is a policy/RBAC feature (roadmap [14]); v2 flags are advisory only.
- **LLM-scored brand-fit or risk** — v2 is deterministic heuristics; an LLM grader is a separate, gated follow-up (would add a hot-path gateway hop, CLAUDE.md guardrail #1).
- **Multi-revision version timeline** beyond current-vs-previous — diff is two-way; an N-version history viewer is later.
- **Copy regenerate via Hermes for brand/strategy items** — revision brief is note-only for those; only creative-asset regenerate exists today and is reused.
- **Queue-list-level scoring** — intelligence is per-item-lookup only, to protect list latency.
- **Video / Reel / Story publish surfaces** — already shipped behind `ARIES_VIDEO_PUBLISH_ENABLED` (#520); v2 only *summarizes* whatever the publish bundle holds and does not add or change publish surfaces.
- **Meta failure taxonomy / reconnect / creative_asset_ids backfill** — already shipped (#519); v2 does not touch publish-result plumbing.
- **Memory-candidate surfacing from rejected directions** — that belongs to the memory screen (roadmap [4]).
- **Brand palette/type redesign of the review surface** — that is roadmap [5]; v2 keeps the current dark theme.

## Risks

- **Brand-fit feels arbitrary.** A heuristic score can read as noise. Mitigation: always show the `reasons[]` so the number is explainable; band labels ("strong/fair/weak") over a bare number; document weights; tune against real tenant copy during the live check.
- **Risk-flag false positives erode trust.** Over-flagging "best"/"guaranteed" annoys. Mitigation: `info` vs `warn` severities, advisory-only (never blocks), evidence shown so the operator can dismiss with one glance; conservative regex.
- **Channel-mapping gap on platform flags.** `validateCaption` only knows `instagram_feed`/`facebook_feed`; the item channel is free-form. Mitigation: explicit channel map + fail-soft skip (no `platform` flag rather than a wrong one) for unmapped channels; covered by a dedicated unit test.
- **Publish-summary source seam.** `reviewBundle` is not surfaced to the lookup return point. Mitigation: derive from the item's already-populated `attachments`/`sections` first; only build `getMarketingJobStatus` once (single-item path only) when those are insufficient — never on the list.
- **Perf on the read path.** Extra computes per item lookup. Mitigation: all pure, no I/O on the pure fns, single-item only (never the list); benchmark the item endpoint, not just the helper (CLAUDE.md guardrail #1).
- **Contract drift from widening the type.** Adding optional fields is safe, but the browser mirror in `lib/api/aries-v1.ts` must stay in sync. Mitigation: shared types in `lib/api/marketing.ts`; typecheck gate; the enrichment test asserts the API shape.
- **Revision brief silently no-ops for copy items.** If an operator expects a regenerate on a strategy item, nothing renders. Mitigation: presets clearly scoped — regenerate affordance only appears for creative-asset items; copy items show note-only.

## Files reference

| File | Change | Phase |
|------|--------|-------|
| `backend/marketing/review-intelligence.ts` | NEW: `computeReviewDiff`, `scoreBrandFit`, `evaluateRiskFlags`, `buildPublishSummary` + types | A |
| `lib/api/marketing.ts` | export `ReviewDiff`/`BrandFitScore`/`RiskFlag`/`ReviewPublishSummary` | A |
| `backend/marketing/runtime-views.ts` (`RuntimeReviewItem`:125, lookup:1967) | add optional fields; populate `previousVersion` from edit-state; enrich on single lookup only; thread `status.reviewBundle` to `buildPublishSummary` only when item fields insufficient | B |
| `lib/api/aries-v1.ts:96` | mirror new optional fields | B |
| `frontend/aries-v1/review-item.tsx` | flag gate + mount v2 panels; upgrade history panel | C,D,E |
| `frontend/aries-v1/review-v2/version-diff.tsx` | NEW | C |
| `frontend/aries-v1/review-v2/brand-fit-badge.tsx` | NEW | C |
| `frontend/aries-v1/review-v2/risk-flags.tsx` | NEW | C |
| `frontend/aries-v1/review-v2/revision-brief.tsx` | NEW | D |
| `frontend/aries-v1/review-v2/publish-summary.tsx` | NEW | E |
| `app/review/[reviewId]/page.tsx` | pass `v2Enabled` flag prop to screen (already a server component) | C |
| `app/api/marketing/reviews/[reviewId]/decision/route.ts` | accept optional `revisionBrief`, fold into `note` | D |
| `docker-compose.yml`, `.env.example`, `CLAUDE.md`, `ROUTE_MANIFEST.md` | document `ARIES_REVIEW_QUEUE_V2_ENABLED` | F |
| `tests/review-intelligence.test.ts` | NEW (pure fns) | A |
| `tests/review-intelligence-enrichment.test.ts` | NEW (view-model wiring + perf guard) | B |
| `tests/review-v2-panels.test.ts` | NEW (flag on/off render, advisory-not-blocking) | C |
| `tests/review-revision-brief.test.ts` | NEW (preset→note, creative regenerate) | D |
| `scripts/verify-regression-suite.mjs`, `VERSION`, `CHANGELOG.md` | allowlist + bump | F |

## Related

- **Reconciles RECON 5:** decision endpoints already exist; this plan adds the v2 surface, not the plumbing RECON 5 thought was missing.
- Roadmap [4] memory screen, [5] brand redesign, [14] roles/policies — adjacent surfaces this deliberately does not absorb.
- Already-shipped, deliberately not re-planned: #519 (Meta failure taxonomy + reconnect + creative_asset_ids backfill), #520 (video/Reel/Story-video publish surfaces). v2 only *summarizes* the publish bundle; it adds no publish surfaces and touches no publish-result plumbing.
- CLAUDE.md guardrails honored: list-perf (per-item-only compute), pool fan-out #1 (no new I/O on the pure fns; at most one bounded `getMarketingJobStatus` on the single-item path), brand URL (`aries.sugarandleather.com` asserted in publish-summary tests), approval-gated (advisory flags never auto-block; no autonomous publish/regenerate), `MARKETING_STATUS_PUBLIC` never touched.
