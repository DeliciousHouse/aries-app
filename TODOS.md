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

**/qa note 2026-05-07:** Partially addressed for onboarding drafts on `chore/preserve-local-pgadmin-compose` by `ab4fa6a` and regression-covered by `0680b67`; `POST /api/onboarding/draft` now falls back to `DATA_ROOT` when configured Postgres is unreachable. The broader auth/OAuth and missing-package failures in this TODO remain open.

### Repair public-surface contract tests for review copy and fallback responses

**What:** Bring the public review/copy contract tests back into sync with the shipped copy or restore the intended copy contract.

**Why:** These tests guard user-visible language and route behavior. When they drift, the app starts leaking internal phrasing or inconsistent fallback responses.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. Failures included `tests/review-surfaces-public.test.ts` (unexpected `Checkpoint` and missing `Supporting materials` copy), `tests/runtime-api-truth.test.ts` (`/api/contact` unavailable response no longer matches `/not configured/i` expectation), and `tests/public-generated-routes.test.ts` (404 content type returned `text/html; charset=utf-8` instead of `text/plain; charset=utf-8`). These failures are outside the four QA commits prepared for this PR.

**Effort:** M
**Priority:** P0
**Depends on:** None

## Aries × Hermes × Honcho architecture rollout

Design reference and full backlog: `docs/plans/2026-05-08-aries-hermes-honcho-architecture.md`.

**2026-05-09:** `.env.example` and `docker-compose.yml` document/pass Honcho + `ARIES_RESEARCH_*` + `HERMES_RESEARCH_*` vars. `backend/marketing/orchestrator.ts` `runResearchStage` calls `submitMarketingResearchMemoryJob` when `ARIES_RESEARCH_ENABLED` is truthy. `dispatchResearchJob` posts `callbackUrl` to `/api/internal/aries-research/callback` (matches `app/api/internal/aries-research/callback`).

**2026-05-09 (architecture rollout):** Onboarding Honcho seed runs once per org after the dashboard gate (`lib/auth-user-journey.ts` → `maybeSeedOnboardingMemoryForTenant`, column `organizations.onboarding_memory_seeded_at`). Review queue: `GET /api/tenant/research/review-queue` (tenant_admin) lists `aries_research_findings` with `queue_for_review`. `HonchoHttpTransport` uses `HONCHO_DATA_PLANE_JWT` for routine paths when set, control-plane JWT for workspace create/delete. `backend/tenant/organization-lifecycle.ts` exposes `archiveHonchoWorkspaceForOrganizationId` for tenant teardown ordering. Remaining: server-side JWT minting (if Honcho exposes a mint endpoint), Hermes `aries-research` profile (cross-repo), full verification harness suite from the plan doc.

**2026-05-11:** v2 continuous-profile-writes plan authored. Four write surfaces identified (creative approvals/rejections, social publishing/performance, UI preference signals, pipeline stages 2-4). Three rollout phases defined. See `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`.

### Honcho write Phase 1 — Strategy approvals and creative rejections

**What:** Wire Honcho writes at two explicit approval events: (1) user approves the strategy stage (`approveMarketingJob` in `backend/marketing/orchestrator.ts:1996`), writing `kind=fact` to `session-strategy-<jobId>` against `peer-brand`; (2) user denies any stage (`denyMarketingJob`, `orchestrator.ts:2012`), two writes: content record to `peer-brand`/`peer-policy` and audit record to `peer-approver-<userPseudonym>`. Denial form uses structured `denial_reason_code` enum — no free text reaches Honcho. Add idempotency via `honcho_write_idempotency_keys` Postgres table. Implement `backend/memory/write-events.ts` as the single ingestion module with off-response-path writes (2s timeout). Extend `pseudonymForUser` in `backend/memory/pseudonym.ts` to use `'aries-user:'` domain separator. Extend curator (`backend/memory/curator.ts`) to conditionally auto-approve `rejected_angle` when the user supplied an explicit `denial_reason_code`. Gate behind `HONCHO_WRITE_APPROVALS_ENABLED`.

**Why:** These are the lowest-risk write surfaces. Both have explicit user intent. Both flow through existing approval infrastructure (`approval-store.ts`). They produce the highest-value signal for future research context: what creative directions were rejected and what strategy facts the operator approved.

**Context:** Plan: `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`, Phase 1. Write entry points: `backend/marketing/orchestrator.ts:1996` (approve) and `backend/marketing/orchestrator.ts:2012` (deny). Curator: `backend/memory/curator.ts:136-151`. Verification assertions V0-V6 in the plan. Tests: `tests/memory-write-events.test.ts`.

**Effort:** L
**Priority:** P1
**Depends on:** `HONCHO_ENABLED=true` (already live in prod)

_Effort revised from M after eng review locked in 7 architecture decisions._

### Honcho write Phase 2 — Publishing events and performance feedback

**2026-05-11 (shipped on branch):** Implemented behind `HONCHO_WRITE_PUBLISH_ENABLED` (`backend/memory/honcho-env.ts`): publish verification queues `constraint` to research findings; scheduled posts auto-approve to `peer-policy`; Hermes publish-stage completion queues scrubbed `research_conclusion` when a verifiable `https` source URL is present. `persistQueuedFinding` threads the caller DB pool for tests and transactional consistency. Tests: `tests/memory-write-events.test.ts` (Phase 2 block), `tests/publish-verification.test.ts` (`publishedAt`).

**What:** Wire Honcho writes at three publish-surface events: (1) `runPublishVerification` returns `verified` in `app/api/publish/dispatch/handler.ts:83`, writing `kind=constraint` to `peer-policy` (queued for review); (2) `upsertScheduledPost` succeeds in `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:142`, writing `kind=constraint` to `peer-policy` (auto-approve, first-party explicit action); (3) Hermes publish-stage callback `markJobCompleted` in `backend/marketing/hermes-callbacks.ts:188`, writing `kind=research_conclusion` to `peer-market-signal-<topicPseudonym>` (queue for review). Add idempotency keying: `sha256(jobId + stage + platform + publishedAtDate)`. Add platform-post-ID scrubber before curator. Gate behind `HONCHO_WRITE_PUBLISH_ENABLED`.

**Why:** Publishing and performance data are the most operationally durable signals in the pipeline. A record of which content was approved for which channel on which date, and what performance it produced, is exactly the kind of constraint that should influence future strategy and production stage runs.

**Context:** Plan: `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`, Phase 2. Verification assertions V6-V9 in the plan. Higher write volume than Phase 1, hence the idempotency requirement. Honcho unavailability must remain a silent degradation, not a user-visible error.

**Effort:** M
**Priority:** P2
**Depends on:** Phase 1 complete, `HONCHO_WRITE_APPROVALS_ENABLED=true` validated in prod

### Honcho write Phase 3 — Explicit UI preference signals

**What:** Wire Honcho writes when a user saves an explicit creative preference via a dedicated toggle (not yet built). Write `kind=preference` to `peer-user-<userPseudonym>` under `session-curated-<jobId>`, auto-approved only if `explicit_user_intent=true` is present in the finding metadata. Extend curator (`backend/memory/curator.ts`) to gate on `explicit_user_intent`. Gate behind `HONCHO_WRITE_PREFERENCES_ENABLED`. Phase 3 is blocked on UI work: the preference toggle surface must exist before this can ship.

**Why:** User-stated creative preferences (voice, style, direction) are high-value first-party signal that should persist across campaigns. Inferring them from behavior is explicitly out of scope. This phase only ships when the operator has a clear affordance to express intent, so the writes are unambiguous.

**Context:** Plan: `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`, Phase 3. No current UI surface in `frontend/aries-v1/creative-action-drawer.tsx` supports this. Verification assertions V10-V12 in the plan. Do not implement the write path until the toggle UI exists and is merged.

**Effort:** S (write path only, after UI exists)
**Priority:** P2
**Depends on:** Phase 2 complete, preference toggle UI built and merged

## Completed
