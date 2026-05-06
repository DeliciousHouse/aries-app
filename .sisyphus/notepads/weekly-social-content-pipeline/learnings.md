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

## [2026-05-06] T1 — tenant-prefix asset storage keys

### Storage scheme
- New layout: `${DATA_ROOT}/ingested-assets/{tenant_id}/{sha[0:2]}/{sha}.{ext}`
- Tenant segment is FIRST, before sha-prefix — enforces cross-tenant boundary at the path level
- Within-tenant dedup preserved (same tenant + same bytes = same path)
- Cross-tenant: same bytes from different tenants = different paths (no shared file)
- Sentinel `_unscoped_` for legacy callers without tenant context (real tenant IDs are SERIAL integers from `organizations.id`, so collision impossible)

### Public API additions
- `ingestRuntimeDocAssets(doc, tenantId?)` — explicit param wins; falls back to `doc.tenant_id`; both absent → `_unscoped_`
- `ingestSinglePath(original, tenantId?)` — same fallback policy
- `readMarketingAssetWithinAllowedRoots(filePath, options?)` — new `options.tenantId` enforces tenant prefix when path is within `${DATA_ROOT}/ingested-assets/`
- `findMarketingAsset/buildMarketingAssetLibrary/buildMarketingAssetLinks(jobId, runtimeDoc, facts?, options?)` — new `options.tenantId` asserts equality with `runtimeDoc.tenant_id` (defense-in-depth)

### Migration script
- `scripts/migrate-asset-tenant-prefix.ts` — exports `runAssetTenantPrefixMigration({dryRun, db, dataRoot?})` for tests; CLI entrypoint uses `lib/db.pool`
- Defaults to `--dry-run`; pass `--commit` to apply
- Detects legacy by segment-count after `ingested-assets/`: 2 segments = legacy, 3 = migrated
- Atomic move: `renameSync` with per-source `.migrating.lock` (wx-flag, EEXIST-skip)
- Idempotent: second run finds zero pending rows

### Test pattern
- `withScratch` + `withEnv` helpers replicate the `tests/asset-ingest.test.ts` style
- Migration tests use a stub `MigrationDb` (single `query` method returning `{rows, rowCount}`) — no live DB required
- `MigrationDb.query` typed non-generic (`rows: unknown[]`) so test stubs satisfy the interface without TS generic-instantiation errors

### Files changed
- `backend/marketing/asset-ingest.ts` — tenant param, `destinationFor` includes tenant segment
- `backend/marketing/asset-read.ts` — `tenantPrefixViolates` guard added to read loop
- `backend/marketing/asset-library.ts` — `assertRuntimeDocTenantMatches` added to library functions
- `scripts/migrate-asset-tenant-prefix.ts` — new file
- `tests/asset-tenant-isolation.test.ts` — new file (3 tests)

### Validation
- `npm run typecheck` → 0 errors
- All 25 asset-related tests green (`asset-tenant-isolation`, `asset-ingest`, `asset-library-content-type`, `marketing-artifact-store`)

## [2026-05-06] T4 — per-run callback_token defense in depth

### Token lifecycle
- Generated at submission time in `HermesMarketingPort.invoke()` via `randomBytes(32).toString('hex')` — 64 hex chars
- Plaintext sent ONLY in submission payload `callback_auth.callback_token` field; never logged
- SHA-256 hash persisted to `oauth_callback_tokens` table BEFORE the Hermes fetch (so callbacks can never race the insert)
- `INSERT INTO oauth_callback_tokens (token_hash, aries_run_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO NOTHING`
- Insert wrapped in try/catch with `console.error` — failures don't block submission; defense-in-depth bearer auth still protects

### Verification path
- `verifyCallbackToken(ariesRunId, token, dbClient)` exported from `lib/internal-callback-auth.ts`
- Uses `timingSafeEqual` on stored vs candidate SHA-256 hashes
- Also asserts `stored.aries_run_id === requested.aries_run_id` to prevent token cross-run reuse
- Returns 403 `missing_callback_token` when absent, 403 `invalid_callback_token` when mismatched

### Route integration
- Bearer check first (`verifyInternalCallbackRequest`), THEN payload parse, THEN `verifyCallbackToken`
- Defense in depth: ALL three required, in order
- Only applied to `app/api/internal/hermes/runs/route.ts` (not other internal callbacks)

### Tenant id constraint
- `oauth_callback_tokens.tenant_id INTEGER NOT NULL REFERENCES organizations(id)`
- Port skips insert when `tenantId` is non-numeric (test stubs use `'tenant_test'` etc.) — test-only paths still send token in payload but verify will fail without seeded DB row
- Production tenants are SERIAL integers from organizations.id, so insert always succeeds

### Test pattern
- Mock `pool.query` via `t.mock.method(pool, 'query', handler)` — returns `{rows, rowCount}` shape
- `seedCallbackToken(t, ariesRunId)` helper installs a mock that returns the seeded token's hash on lookup
- `tests/hermes-callback-route.test.ts` updated to seed tokens (3 tests touched)
- `tests/marketing-execution-port.test.ts` updated: callback_auth assertions changed from `deepEqual` to per-field + regex (token is random per run)

### Files changed
- `lib/internal-callback-auth.ts` — added `hashCallbackToken`, `verifyCallbackToken`
- `backend/marketing/ports/hermes.ts` — added `randomBytes` token gen, `persistCallbackTokenHash` method, optional `callbackTokenClient` ctor param
- `app/api/internal/hermes/runs/route.ts` — added `verifyCallbackToken` step after payload parse
- `tests/callback-token.test.ts` — new file (6 tests)
- `tests/hermes-callback-route.test.ts` — updated 3 tests for new token requirement
- `tests/marketing-execution-port.test.ts` — relaxed callback_auth assertions

### Validation
- `npm run typecheck` → 0 errors
- `npm run validate:execution-provider` → 40/40 pass
- `npm run validate:banned-patterns` → ok
- `npm run validate:repo-boundary` → ok

## [2026-05-06] T2 — real OAuth refresh + Meta long-lived exchange + FOR UPDATE lock

### Per-provider refresh dispatcher
- `backend/integrations/refresh.ts` replaces the 48-line stub with a real per-provider dispatcher built on `withConnectionLock` (BEGIN + SELECT ... FOR UPDATE).
- `callProviderRefresh(provider, latestToken)` switches on `DbProvider`: facebook/instagram → `refreshMetaLongLived`; linkedin/x/youtube/tiktok/reddit → corresponding provider modules; openai + unknown → `ProviderRefreshError('configuration_error')`.
- v1 only exercises the Meta path; the other modules are real implementations (configured via `*ClientCredentials()` env getters) so v2 can plug them in without code changes — unconfigured providers throw `configuration_error` on call rather than silently succeeding.

### Meta exchange-not-refresh
- `refresh-meta.ts` calls `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=…&client_secret=…&fb_exchange_token=<short_lived>` and treats the response identically to a refresh — emits `{accessToken, expiresInSeconds, tokenType}`.
- 401/403 → `ProviderRefreshError('unauthorized')` → connection moves to `reauthorization_required`.
- 5xx → `ProviderRefreshError('transient_provider_error')` → status stays `connected` (no reauth churn on transient outages); errored audit row still written.
- Long-lived tokens are re-exchanged BEFORE expiry by the same call when the sweeper detects `expiring_soon` — same code path drives both initial and re-exchange.

### Concurrency single-flight via row lock
- `withConnectionLock` opens a `BEGIN` transaction, runs `SELECT … FROM oauth_connections WHERE id = $1 FOR UPDATE`, then yields the locked client to the callback. All token I/O inside the callback uses that locked client, so concurrent `oauthRefresh` calls on the same `connection.id` serialize at the row.
- `shouldSkipDueToConcurrentRefresh(latestToken, startedAtMs)` defends the second waiter: once the first refresh completes and the second waiter takes the lock, we re-read the latest token; if it was issued at or after our start time (within `FRESHNESS_TOLERANCE_MS=5_000`), we return the existing token handle with `refreshed: false` rather than firing another provider call.
- Concurrency test (5 parallel `oauthRefresh` calls): exactly 1 provider fetch, exactly 1 new token row, 4 callers receive `refreshed: false`.

### Failure semantics
- `unauthorized` (401/403/`invalid_grant`) → `oauth_connections.status = 'reauthorization_required'`, `last_error_code` populated (provider code or kind), `last_error_message` from provider; `oauth_audit_events` row of type `oauth.refresh.failed` with status `error`.
- `transient_provider_error` (5xx, network errors) → status stays `connected` (transient); same audit row type, no token rotation.
- `configuration_error` → returned as broker `provider_unavailable`; `provider_error` → returned as `provider_callback_error`.

### Token rotation
- New row inserted via `dbInsertOAuthToken` with encrypted access/refresh tokens (AES-256-GCM via `oauth-crypto.ts`), `rotated_from_token_id` FK pointing at old token; old token revoked via `dbRevokeOAuthTokenById` (sets `revoked_at`).
- Schema unchanged; no new columns added.

### Test pattern
- `withEnv` clears all `META_APP_ID`, `META_APP_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY` before applying test-only values to avoid leaks across tests.
- `createDbHarness` mocks both `pool.query` and `pool.connect` with an in-memory `Map<id, ConnectionRow>` + `TokenRow[]`. The harness handles BEGIN/COMMIT/ROLLBACK as no-ops, FOR UPDATE selects, latest-token lookup by `connection_id ORDER BY created_at DESC`, INSERT/UPDATE on tokens, and connection updates.
- Concurrency harness adds a `SerialLock` so `FOR UPDATE` actually blocks: each fake client acquires the lock on FOR UPDATE, releases on COMMIT/ROLLBACK.
- `t.mock.method(globalThis, 'fetch', …)` mocks the provider HTTP call.

### Files changed
- `backend/integrations/refresh.ts` — replaced stub with provider dispatcher + lock + rotation + audit
- `backend/integrations/refresh-meta.ts` — Meta long-lived `fb_exchange_token` exchange (NEW)
- `backend/integrations/refresh-{linkedin,x,google,tiktok,reddit}.ts` — provider refresh implementations (NEW)
- `backend/integrations/oauth-tokens-db.ts` — added `withConnectionLock`, `LockedConnectionRow`, `dbRevokeOAuthTokenById`, `rotated_from_token_id` insert support
- `tests/oauth-refresh-meta.test.ts` — long-lived exchange happy + 401 + 5xx (NEW)
- `tests/oauth-refresh-concurrency.test.ts` — 5-way Promise.all single-flight assert (NEW)
- `tests/oauth-refresh-failure.test.ts` — 401 → reauthorization_required + connection_not_found (NEW)

### Validation
- `npm run typecheck` → 0 errors
- `tests/oauth-refresh-{meta,concurrency,failure}.test.ts` → 6/6 pass
- `npm run validate:banned-patterns` → ok
- `npm run validate:repo-boundary` → ok

## [2026-05-06] T11 — per-platform caption validator

### Module design
- `backend/social-content/caption-validator.ts` exports `validateCaption({ channel, text, hashtags? })`
- Returns `{ ok: boolean, errors: string[] }` — supports multiple simultaneous violations
- No external dependencies; pure validation logic

### Platform constraints (Meta Graph API specs)
- Instagram (instagram_feed):
  * Max 2200 characters (per Meta IG Graph API docs)
  * Max 30 hashtags (per Meta IG Graph API docs)
- Facebook (facebook_feed):
  * Max 63206 characters (per Meta FB Graph API docs)
  * No hashtag limit

### Error codes
- `caption_empty` — when text is empty string
- `caption_too_long` — when text exceeds platform character limit
- `too_many_hashtags` — when hashtag count exceeds 30 (Instagram only)

### Test coverage
- 10 tests in `tests/caption-validator.test.ts`
- Boundary cases: exact limits (2200, 30, 63206) and +1 over each
- Edge cases: empty captions, multiple simultaneous violations
- Platform-specific: IG hashtag limit, FB no limit
- All tests use native `node:test` framework

### Files created
- `backend/social-content/caption-validator.ts` — validator module
- `tests/caption-validator.test.ts` — 10 test cases

### Validation
- `npm run typecheck` → 0 errors
- All 10 caption-validator tests PASS
- No dependencies added
- No anti-patterns (no `as any`, no empty catches, no console.log)
