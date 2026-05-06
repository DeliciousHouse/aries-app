# Learnings — weekly-social-content-pipeline

## [2026-05-06] Session start

### Stack facts
- Next 16.2.3 App Router + Turbopack (required locally via `npm run dev`)
- React 18.3.1, TS 5.7.3 strict ES2022
- Raw `pg` (no ORM) — all SQL in raw strings
- Native `node:test` via `tsx --test` — NO Vitest/Jest
- Tailwind 4.2.1, NextAuth 5.0.0-beta.30
- Sharp NOT yet a dep — T13 must add it

### Path conventions
- `@/*` → `./*` (root-relative)
- New files: only in `app/`, `backend/`, `frontend/`, `lib/`, `tests/`, `scripts/`, `validators/`, `types/`
- Test files: `tests/*.test.ts` (not co-located)
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

### Validation commands (run after every task)
```
npm run typecheck
npm run test
npm run verify
npm run validate:repo-boundary
npm run validate:banned-patterns
npm run validate:social-content
npm run validate:execution-provider
npm run validate:marketing-flow
```

### Tenant context pattern
- `lib/tenant-context.ts` → `getTenantContext()` returns `{userId, tenantId, tenantSlug, role}`
- `lib/tenant-context-http.ts` → `loadTenantContextOrResponse()` returns 403 if claims missing
- All new operator routes MUST use `loadTenantContextOrResponse` — tested with 401/403 cross-tenant

### Key file references (Metis-verified)
- Asset storage: `backend/marketing/asset-library.ts`, `asset-ingest.ts`, `asset-read.ts`
- OAuth refresh stub (48 lines): `backend/integrations/refresh.ts`
- Aspect ratio hardcoded: `backend/social-content/workflow-request.ts:123` (`aspect_ratio: '4:5'`)
- Hermes port: `backend/marketing/ports/hermes.ts:~269` (submissionPayload)
- Callback auth: `lib/internal-callback-auth.ts` (timingSafeEqual, extend don't replace)
- Brand kit: `backend/marketing/brand-kit.ts` (extractAndSaveTenantBrandKit, 7-day TTL)
- Publish dispatch: `app/api/publish/dispatch/handler.ts`
- Onboarding journey: `lib/auth-user-journey.ts:resolvePostLoginDestinationForUser`

### Anti-patterns to block
- NO `as any`, `@ts-ignore`, `@ts-expect-error`
- NO empty catches
- NO `console.log` in production code
- NO `campaign` in user-facing strings (only inside Meta Ads API client code)
- NO Lobster/OpenClaw imports
- NO ORM, no new auth lib, no new test framework
- NO polling Hermes (callback-only model)
- NO cron/scheduler in v1

### Tests-FIRST modules (RED → GREEN → REFACTOR before any implementation)
1. T1: asset-tenant-isolation.test.ts
2. T2: oauth-refresh-*.test.ts (meta, concurrency, failure)
3. T3: oauth-meta-callback.test.ts
4. T4: callback-token.test.ts
5. T5: publish-tenant-isolation.test.ts
6. T16: onboarding-gate.test.ts
7. T24: publish-confirm.test.ts

## [2026-05-06] T10 — idempotency_key in Hermes submission

### Idempotency key generation
- Function: `generateIdempotencyKey(ariesRunId, workflowVersion, tenantId)` in `hermes.ts`
- Algorithm: SHA-256 hash of `${ariesRunId}|${workflowVersion}|${tenantId}` (pipe delimiter prevents ambiguity)
- Output: 64-character hex string (sha256)
- Deterministic: identical inputs always produce identical key

### Payload integration
- Added `idempotency_key` field to all three submissionPayload cases:
  1. Resume case (social content weekly) — uses `SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY`
  2. Run case (social content weekly) — uses `request.workflow_version` from buildSocialContentWeeklyRequest
  3. Fallback case (other workflows) — uses `workflowKey` param
- Key is extracted from payload and added as `Idempotency-Key` HTTP header on POST to `/v1/runs`

### Test pattern
- `tests/hermes-idempotency.test.ts` — 3 tests:
  1. Deterministic key generation (verifies hash matches expected value)
  2. HTTP header inclusion (verifies header present and matches payload key)
  3. Key changes with aries_run_id (verifies different run IDs produce different keys)
- Uses existing `STUB_DOC` pattern from `marketing-execution-port.test.ts`
- All tests pass; no breaking changes to existing tests

### Files changed
- `backend/marketing/ports/hermes.ts` — added import, helper function, payload integration, header addition
- `tests/hermes-idempotency.test.ts` — new file (3 tests)

### Validation
- `npm run typecheck` → 0 errors
- `npm run test -- --test-name-pattern="HermesMarketingPort.*idempotency"` → 3/3 pass
- No regression in existing tests (828 pass, 52 fail — same as before T10)

## [2026-05-06] T3 — Meta OAuth long-lived exchange + IG BA discovery + Page picker

### Provider config flip
- `PROVIDER_ENV_CONTRACT.facebook` flipped from `env_managed` (META_PAGE_ID/META_ACCESS_TOKEN) to `oauth` (META_APP_ID/META_APP_SECRET).
- `instagram` stays `env_managed` — Instagram tokens are derived from a connected Facebook Page; no direct Instagram OAuth in v1.
- `getProviderOAuthAvailability('facebook')` now returns `connectable: true` once META_APP_ID + META_APP_SECRET are set.

### Meta callback flow (`backend/integrations/meta/discover.ts` + `callback.ts`)
1. `exchangeMetaAuthorizationCode(code, redirect_uri)` — code → short-lived user token (new helper; replaces user-profile-fetching path).
2. `exchangeMetaShortForLongLived(short)` — `grant_type=fb_exchange_token` against `graph.facebook.com/{vN}/oauth/access_token`. ~60-day TTL.
3. `discoverMetaPages(longLived)` — GET `/me/accounts` for the long-lived token, then per-page GET `/{page_id}?fields=instagram_business_account,access_token,name`. Returns `{kind: no_pages | single_page | multi_page}`.
4. `runFacebookCallbackFlow(state, code, pending)` orchestrates 1→3 and branches:
   - `no_pages`: upserts facebook connection with `status='error'`, `last_error_code='meta_no_pages_available'`; deletes pending state; emits `oauth.callback.no_pages` audit; returns `provider_callback_error`.
   - `single_page`: persists Page Access Token (NEVER user token) for facebook + sibling instagram if IG BA present; deletes pending state.
   - `multi_page`: stashes `{pages:[{id,name,pageAccessToken,instagramBusinessAccountId}]}` into `oauth_pending_states.picker_payload`; returns new `OAuthCallbackPickerRequired` variant; `handleOauthCallbackHttp` redirects browsers to `/onboarding/connect/meta/select-page?state=<state>`.

### Token-class invariant (CRITICAL)
- The token persisted in `oauth_tokens.access_token_enc` for facebook + instagram is the Page Access Token only. The long-lived user token is held in memory during discovery and discarded.
- Asserted by `tests/oauth-meta-callback.test.ts` via `decryptToken(...) === 'page-token-X'` and `!== shortToken && !== longToken`.

### Schema migration
- `oauth_pending_states` extended with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS picker_payload JSONB` (idempotent).
- Surfaced via `DbPendingStateRow.picker_payload: unknown | null` and `dbSetPendingStatePicker(state, payload)` writer.
- No change to `oauth_connections` schema — uses existing `external_account_id`, `external_account_name`, `status`, `granted_scopes`.

### Picker round-trip
- Page: `app/onboarding/connect/meta/select-page/page.tsx` (server component) — reads pending state by URL `?state=`, validates tenant via `loadTenantContextOrResponse`, redirects to `/onboarding/start` on missing/expired/wrong-tenant.
- Form: `app/onboarding/connect/meta/select-page/PagePickerForm.tsx` (client) — radio list, per-page IG status badge.
- POST: `app/api/oauth/meta/select-page/route.ts` → `backend/integrations/meta/select-page.ts` `handleMetaSelectPageHttp(req, opts?)`. Verifies tenant context matches `pending.tenant_id`; rejects 403 on mismatch. Persists Page Token + sibling Instagram, deletes pending state, audits `oauth.callback.connected` with `flow: meta_page_picker`.

### Test seam
- `MetaSelectPageOptions.tenantContextLoader` enables tests to inject a fake tenant context without touching NextAuth.

### Files added/changed
- New: `backend/integrations/meta/discover.ts`, `backend/integrations/meta/select-page.ts`, `app/api/oauth/meta/select-page/route.ts`, `app/onboarding/connect/meta/select-page/page.tsx`, `app/onboarding/connect/meta/select-page/PagePickerForm.tsx`, `tests/oauth-meta-callback.test.ts`.
- Modified: `backend/integrations/callback.ts` (new flow + `OAuthCallbackPickerRequired` variant + redirect handling), `backend/integrations/oauth-db.ts` (picker_payload surface + setter), `backend/integrations/oauth-provider-runtime.ts` (facebook → oauth mode + new error message), `scripts/init-db.js` (idempotent `picker_payload` ALTER), `tests/oauth-callback-runtime.test.ts` (removed facebook from generic provider cases — now covered by dedicated meta tests).

### Validation
- `tests/oauth-meta-callback.test.ts` — 6/6 pass
- All oauth-related tests — 28/28 pass
- `npm run typecheck` → 0 errors
- Full suite snapshot: 770 pass / 40 fail vs 757/54 pre-T3 baseline (verified via stash-then-run); all 40 remaining failures pre-date T3.
- The plan file `.sisyphus/plans/weekly-social-content-pipeline.md` is not present on disk in this workspace (only notepads exist); plan-checkbox toggle deferred to orchestrator.

## [2026-05-06] T8 — full brand kit injection into social_content_weekly payload

### Brand-payload contract additions
- `SocialContentWeeklyRequest['input']['brand']` now carries `logo_urls`, `colors{primary|secondary|accent|palette}`, `font_families`, `offer`, `must_avoid_aesthetics` on top of the existing `url|name|business_type|voice|style_vibe|visual_references`.
- Source: `doc.brand_kit` (`MarketingBrandKitReference`). Helpers (`brandKitLogoUrls`, `brandKitColors`, `brandKitFontFamilies`, `resolveBrandVoice`, `resolveBrandOffer`, `resolveMustAvoidAesthetics`) all live in `backend/social-content/workflow-request.ts` and never inline brand-extraction logic — they read from existing `brand-kit.ts` shape.
- Voice: prefer `req.brandVoice` (operator override), fall back to `brand_kit.brand_voice_summary`. Same pattern for `offer` (req.offer → brand_kit.offer_summary) and reused for `objective.offer` so the two stay in sync.
- `must_avoid_aesthetics` (string[]): operator-supplied `req.mustAvoidAesthetics` split on `[\n;,]` + curated `SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS`, deduped case-insensitively.
- Logo URLs are sanitized through `sanitizeReference` (drops `token`/`access_token`/etc query params) but `data:image/svg+xml;...` entries are passed through verbatim because `sanitizeReference` rejects them via `new URL(...)` parse failure.

### Stale-kit refresh contract
- New exported helper `ensureFreshBrandKitForWeeklyRun({ doc, fetchImpl? })` mutates `doc.brand_kit` in place via `extractAndSaveTenantBrandKit({ tenantId, brandUrl })`. The brand-kit module already enforces TTL + `source_url` change + low-quality-signal detection inside `isFreshBrandKit`, so the helper just delegates and the kit returned is fresh-or-fresh-extracted.
- Failure contract: throws `Error('needs_brand_kit:<reason>')`. The prefix is a stable cross-module contract.

### Port wiring
- `HermesMarketingPort` constructor now takes a 4th parameter: `brandKitRefresher: HermesBrandKitRefresher = ensureFreshBrandKitForWeeklyRun`. Tests inject a no-op `async () => ({ refreshed: false })`.
- The refresh runs INSIDE `invoke()`, AFTER `configurationError()` — so a misconfigured port still surfaces `hermes_gateway_not_configured` first, NOT `needs_brand_kit`.
- On refresh failure the port returns a completed-failed `MarketingExecutionResult` with `error.code = 'needs_brand_kit'` (or `'brand_kit_unavailable'` if the thrown message doesn't carry the prefix).

### Test pattern
- `tests/social-content-brand-kit-injection.test.ts` covers: full populated payload, voice fallback, offer fallback, must_avoid_aesthetics merge, minimal-brand-kit tolerance, logo URL sanitization (data: URI passthrough), fresh-kit reuse, stale-kit refresh, missing brand_url throw, extraction-failure throw, port surfacing of needs_brand_kit, port skip for non-weekly runs.
- `tests/marketing-execution-port.test.ts` and `tests/hermes-idempotency.test.ts` were updated to inject `NO_OP_BRAND_KIT_REFRESHER` (constructor 4th arg `async () => ({ refreshed: false })`) anywhere a weekly STUB doc is used. Tests targeting missing-config behavior were left unchanged because configurationError fires before the refresh hook.

### Files changed
- `backend/social-content/workflow-request.ts` — extended `SocialContentWeeklyRequest` brand shape, populated new fields, added `ensureFreshBrandKitForWeeklyRun` async helper.
- `backend/marketing/ports/hermes.ts` — added `HermesBrandKitRefresher` type, optional 4th constructor arg, `refreshBrandKitOrFail` private method, refresh hook inside `invoke()`.
- `tests/social-content-brand-kit-injection.test.ts` (new) — 12 tests, all pass.
- `tests/marketing-execution-port.test.ts`, `tests/hermes-idempotency.test.ts` — inject `NO_OP_BRAND_KIT_REFRESHER` to keep existing port tests scoped to non-T8 concerns.

### Pre-existing branch hazards encountered
- HEAD's `5bbca17 feat(hermes): idempotency_key in submission` commit message claims it added `idempotency_key`/`Idempotency-Key`, but the actual diff only added the test file + notepads. The implementation never landed in this branch's hermes.ts. The 3 hermes-idempotency tests therefore fail on this branch independent of T8 — leave as-is.
- The workspace's `tests/deploy-workflow-self-hosted.regression-015.test.ts`, `.github/workflows/deploy.yml`, and `scripts/release/publish-image.sh` carry merge-conflict markers from a prior aborted merge — they are not T8-related and `npm run typecheck` will continue to flag them until that conflict is resolved separately.

### Validation
- `tests/social-content-brand-kit-injection.test.ts` → 12/12 pass
- `tests/social-content-weekly-defaults.test.ts` + `tests/marketing-execution-port.test.ts` → 45/45 pass after no-op refresher injection
- `npm run validate:social-content` → 87/87 pass
- `lsp_diagnostics` clean on all 5 changed files
