# TODOS

## Ship

### Triage auth and integrations full-suite failures seen during /ship

**What:** Fix the pre-existing auth and integrations test failures that block a clean `npm run test` even though they are not caused by the `qa/four-qa-commits` branch.

**Why:** Shipping from a branch while the base suite is already red makes every future PR noisier and hides real regressions behind unrelated failures.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. Failures included `tests/auth/auth-tenant-membership.test.ts` (`organization_slug_generation_failed`), `tests/auth/integrations-tenant-context.test.ts` (tenant-context assertions returning `disabled`, `pending_facebook`, or `404` instead of expected values), `tests/auth/oauth-connect.test.ts` (503/404 responses plus `ECONNREFUSED 127.0.0.1:5432` in callback flow), `tests/integrations-status.test.ts` (unexpected `unknown` / `error` health states), and `tests/oauth-callback-runtime.test.ts` (`META_APP_ID` expectation mismatch). These failures were present in the full suite during `/ship`; they were not part of the four QA commits being prepared for PR.

**Effort:** L
**Priority:** P0
**Depends on:** None

### Restore marketing runtime hydration and business-profile contract tests

**What:** Fix the pre-existing marketing read-model and hydration failures in the runtime/business-profile suites.

**Why:** These tests cover the customer-facing campaign workspace and brand-profile pipeline. Leaving them red means the repo cannot reliably catch regressions in the exact parts of the app users see.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. Failures included `tests/frontend-api-layer.test.ts` (brand review hydration, legacy runtime docs without `brand_kit`, stage-log asset resolution, strategy approval state, upload-only brand review reopening, and brand-voice backfill), `tests/tenant/business-profile.test.ts` (`marketingPayloadDefaultsFromBusinessProfile derives defaults from validated brand analysis sources`), `tests/marketing-brand-identity-parity.test.ts`, `tests/marketing-competitor-canonical-flow.test.ts`, `tests/marketing-validated-runtime.test.ts`, and `tests/review-decision-idempotency.test.ts`. The most suspicious overlaps with this branch were re-run in a clean `origin/master` worktree and failed there too, confirming they are pre-existing base-branch failures, not regressions introduced by the four QA commits.

**Effort:** XL
**Priority:** P0
**Depends on:** None

### Fix environment-coupled test failures that require Postgres or missing packages

**What:** Make the suite self-contained or document/boot the required services so tests stop failing on missing infra and missing packages.

**Why:** A test suite that depends on an undeclared local database or a missing module is worse than no signal. It burns time and trains everyone to ignore red builds.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. `tests/onboarding-draft-route.test.ts` and `tests/onboarding-draft-store.test.ts` failed with `ECONNREFUSED 127.0.0.1:5432`. `tests/password-reset.test.ts` failed because `lib/email.ts` could not resolve the `resend` module. `tests/auth/oauth-connect.test.ts` also hit a direct Postgres connection failure in the callback flow. Fix by either bootstrapping the required backing services in test mode, mocking them, or making the test harness fail fast with a clearer prerequisite message.

**Effort:** M
**Priority:** P0
**Depends on:** None

### Repair public-surface contract tests for review copy and fallback responses

**What:** Bring the public review/copy contract tests back into sync with the shipped copy or restore the intended copy contract.

**Why:** These tests guard user-visible language and route behavior. When they drift, the app starts leaking internal phrasing or inconsistent fallback responses.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. Failures included `tests/review-surfaces-public.test.ts` (unexpected `Checkpoint` and missing `Supporting materials` copy), `tests/runtime-api-truth.test.ts` (`/api/contact` unavailable response no longer matches `/not configured/i` expectation), and `tests/public-generated-routes.test.ts` (404 content type returned `text/html; charset=utf-8` instead of `text/plain; charset=utf-8`). These failures are outside the four QA commits prepared for this PR.

**Effort:** M
**Priority:** P0
**Depends on:** None

## Completed
