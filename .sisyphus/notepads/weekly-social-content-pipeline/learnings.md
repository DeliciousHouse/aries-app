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
