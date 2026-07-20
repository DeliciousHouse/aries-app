# TODOS

## Feedback

### Make the feedback Google-Sheet mirror exactly-once (currently at-least-once)

**What:** Close the residual double-append window in `POST /api/feedback`: if the Composio Sheet append succeeds but the follow-up `recordSheetSync('synced')` DB write fails, the ledger stays `pending`/`failed`, so a later client retry appends a SECOND Sheet row. The DB stays single-row (upsert by `submission_id`), so the source of truth is correct — only the Sheet mirror can duplicate.

**Why:** The spec promises "one row per submission." Today that holds except in the narrow append-OK + ledger-write-fails + user-retries case. Low harm (every row carries Submission ID for trivial dedupe; DB is authoritative), but worth hardening.

**Context:** Raised by Copilot on PR #719 (`app/api/feedback/route.ts`). Two viable fixes: (a) persist an intermediate `sheet_sync_status='syncing'` BEFORE the append and treat `syncing` as non-appendable on retry (trades a possible lost mirror for no-dup); (b) switch the mirror to `GOOGLESHEETS_UPSERT_ROWS` keyed on the Submission ID column for true idempotency (preferred; needs the upsert action's verified schema + a key-column config + header awareness).

**Effort:** M
**Priority:** P3
**Depends on:** None

## Ship

### Triage auth and integrations full-suite failures seen during /ship

**What:** Fix the pre-existing auth and integrations test failures that block a clean `npm run test` even though they are not caused by the `qa/four-qa-commits` branch.

**Why:** Shipping from a branch while the base suite is already red makes every future PR noisier and hides real regressions behind unrelated failures.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. **2026-05-23 retriage:** `tests/auth/auth-tenant-membership.test.ts` and `tests/oauth-callback-runtime.test.ts` now pass in isolation — historical failures were test-ordering pollution from the full suite. Still failing: `tests/auth/integrations-tenant-context.test.ts` (tenant-context returning `disabled`/`pending_facebook`/`404`), `tests/auth/oauth-connect.test.ts` (4 of 10: tests 5/7/8 return 503/404, test 10 hits ECONNREFUSED in callback flow), `tests/integrations-status.test.ts` (`unknown`/`error` health states). Shared root cause: tests seed `oauthStore()` (in-memory) but handlers now read from Postgres via `dbGetConnection`/`dbGetPendingState`; also missing `META_APP_ID`/`META_APP_SECRET` in test env, and `toTenantIdInt` requires numeric tenant IDs. Fix: replace `seedConnectedProvider` calls with `t.mock.method(oauthDb, 'dbGetConnection'/'dbGetPendingState', ...)`, set `META_APP_ID` + `META_APP_SECRET` + `OAUTH_TOKEN_ENCRYPTION_KEY` via `withEnv`, and switch tenant IDs to numeric strings (`'1'`, `'2'`).

**Effort:** L
**Priority:** P0
**Depends on:** None

### Restore marketing runtime hydration and business-profile contract tests

**What:** Fix the pre-existing marketing read-model and hydration failures in the runtime/business-profile suites.

**Why:** These tests cover the customer-facing campaign workspace and brand-profile pipeline. Leaving them red means the repo cannot reliably catch regressions in the exact parts of the app users see.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. **2026-05-23 retriage:** `tests/marketing-competitor-canonical-flow.test.ts` and `tests/review-decision-idempotency.test.ts` were deleted in `637c2f0` (Lobster removal) — no longer applicable. `tests/tenant/business-profile.test.ts` now passes (27/27). Still failing: (a) `tests/frontend-api-layer.test.ts` 17 tests in 4 groups — execution mock seam mismatch (tests using `__ARIES_EXECUTION_TEST_INVOKER__`/`legacy-openclaw` env need to switch to `__setMarketingExecutionPortForTests` + a `MarketingExecutionPort` mock), tenant-scoped artifact path layout (fixtures must write under `ARTIFACT_STAGEn_CACHE_DIR/<tenantId>/<runId>/`), source-fingerprint gating (fixture brand profile needs `website_url` matching `runtimeDoc.inputs.brand_url`), plus minor copy/window/voice drift (tests 6/9/29); (b) `tests/marketing-brand-identity-parity.test.ts` (tests 1+2) and `tests/marketing-validated-runtime.test.ts` (test 1) — call `runScript('brand-profile-db-contract')` invoking a python script deleted with Lobster; replace with direct calls to `backend/marketing/validated-profile-store.ts` (`tenantBrandProfilePath`, `loadValidatedMarketingProfileDocs`) and `backend/tenant/business-profile.ts` helpers.

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

**/qa note 2026-05-07:** Partially addressed for onboarding drafts on `chore/preserve-local-pgadmin-compose` by `ab4fa6a` and regression-covered by `0680b67`; `POST /api/onboarding/draft` now falls back to `DATA_ROOT` when configured Postgres is unreachable.

**2026-05-23 retriage:** `tests/onboarding-draft-store.test.ts` now passes (3/3). `tests/password-reset.test.ts` now passes (9/9) — `resend` is installed. Still failing: `tests/onboarding-draft-route.test.ts` test 3 — `ab4fa6a` made `ECONNREFUSED` fall back silently, but the test's `withDraftEnv` deletes `DB_HOST` so `hasDatabaseConfig()` returns false and the `pool.query` mock is never invoked; rewrite the test to keep DB env vars set and inject a non-network error (`code: '28P01'`) so it tests the 503 redaction path for non-network errors. The auth/OAuth Postgres failure in `tests/auth/oauth-connect.test.ts` overlaps with the auth/integrations item above (`dbGetPendingState` in callback hits real socket).

### Repair public-surface contract tests for review copy and fallback responses

**What:** Bring the public review/copy contract tests back into sync with the shipped copy or restore the intended copy contract.

**Why:** These tests guard user-visible language and route behavior. When they drift, the app starts leaking internal phrasing or inconsistent fallback responses.

**Context:** Observed during `/ship` on branch `qa/four-qa-commits` on 2026-04-23. **2026-05-23: resolved.** `tests/review-surfaces-public.test.ts` — fixed `campaign-workspace.tsx:933` `eyebrow="Checkpoint"` → `eyebrow="Review"` (the only true offender) and removed three stale `Supporting materials` assertions for copy that never shipped. `tests/runtime-api-truth.test.ts` — the `/api/contact` assertion was already removed when the route was; no remaining failure. `tests/public-generated-routes.test.ts` test 4 — the 404 response was intentionally migrated to a branded HTML page (`app/[...publicPath]/route.ts` `NOT_FOUND_HTML`); test now asserts `text/html` + `/Page not found/`. All 7 tests across the two files now pass.

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

**2026-05-11 (shipped on branch):** Toggle + save in `frontend/aries-v1/creative-action-drawer.tsx`; `GET`/`PUT` `/api/social-content/jobs/:jobId/creative-voice-preference` persists to `marketing_operator_creative_preferences` (`scripts/init-db.js`). Honcho path: `recordCreativeVoicePreferenceEvent` / `scheduleCreativeVoicePreferenceHonchoWrite` in `backend/memory/write-events.ts` behind `HONCHO_WRITE_PREFERENCES_ENABLED`; curator requires `metadata.explicit_user_intent` for `preference` auto-approve; `scrubPreferenceLabelForHoncho` on labels. Tests: `tests/memory-write-events.test.ts` (Phase 3 block).

**What:** Wire Honcho writes when a user saves an explicit creative preference via a dedicated toggle. Write `kind=preference` to `peer-user-<userPseudonym>` under `session-curated-<jobId>`, auto-approved only if `explicit_user_intent=true` is present in the finding metadata. Extend curator (`backend/memory/curator.ts`) to gate on `explicit_user_intent`. Gate behind `HONCHO_WRITE_PREFERENCES_ENABLED`.

**Why:** User-stated creative preferences (voice, style, direction) are high-value first-party signal that should persist across campaigns. Inferring them from behavior is explicitly out of scope. This phase only ships when the operator has a clear affordance to express intent, so the writes are unambiguous.

**Context:** Plan: `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`, Phase 3. Verification assertions V12–V14 in the plan.

**Effort:** S
**Priority:** P2
**Depends on:** Phase 2 complete

### Honcho preference label scrub — narrow over-aggressive name redaction

**What:** Replace or narrow the `[A-Z][a-z]+\s+[A-Z][a-z]+` heuristic in `scrubPreferenceLabelForHoncho` (`backend/memory/write-events.ts`). Today any two title-cased words become `[redacted_name]` before the Honcho claim is written.

**Why:** Operator-authored creative voice labels are descriptors, not user PII. Real values like `Bold Minimalist`, `Modern Bauhaus`, `Dark Academia`, `Quiet Luxury` get silently scrubbed before reaching memory, weakening retrieval signal for future creative work. DB and UI keep the real label, so it's invisible to the operator — only memory matching degrades.

**Context:** Surfaced in post-hoc review of PR #293 (2026-05-11). Drawer placeholder is lowercase so happy-path testing missed it. Consider dropping the name-scrub entirely (this field is not user-authored) or replacing with a stricter signal (e.g. only redact when adjacent to other PII markers).

**Status (2026-05-12, rollout pending):** Narrow first-name-denylist heuristic implemented in `backend/memory/write-events.ts` (`scrubPreferenceLabelForHoncho`) and gated behind env flag `ARIES_MEMORY_LABEL_REDACTION_V2=1`. Regression + behavior tests in `tests/memory-label-redaction.test.ts`. Email redaction unchanged.

**Update (2026-06-09):** the shipped container now defaults this **ON** — `docker-compose.yml` pins `ARIES_MEMORY_LABEL_REDACTION_V2:-1` (v2 narrow heuristic), so prod runs v2. The *code* default when the env var is entirely unset is still the legacy v1 broad regex. Set `0` to force legacy v1. Remaining rollout work: confirm v2 behavior on the live tenant and decide whether to graduate (make v2 unconditional + delete the v1 branch).

**Effort:** XS
**Priority:** P3
**Depends on:** None

## Publishing

## Completed

### Harden Meta publish failure taxonomy

**What:** Split the single catch around the Meta publish call into two outcome
classes instead of one. Today `requestGraphJson` failures and
`*_publish_missing_id` (a 2xx Graph response with no post id) collapse into one
error path and are treated uniformly.

**Why:** The two failure modes need opposite handling. A `requestGraphJson`
network/HTTP failure means the post definitely never went live — safe to roll
back the platform claim and retry. A `*_publish_missing_id` means Graph
accepted the call but Aries cannot confirm the post id — the outcome is
unknown, so the claim must be left in place, surfaced as
`needs_manual_reconciliation`, and never auto-retried (auto-retry risks a
duplicate post).

**Context:** Surfaced reviewing the publish path during the
`creative_asset_ids` work (2026-05-20). Its own small PR (~1-2 hrs); keep it
out of unrelated changes.

**How it shipped:** `MetaPublishError` gained an `outcomeUnknown` flag, set
only on the two final-publish missing-id codes (`facebook_publish_missing_id`,
`instagram_publish_missing_id`). `classifyMetaPublishFailure()` maps any error
to `definitely_never_posted` | `outcome_unknown`. The FB/IG publish handlers
branch on it: definitely-never-posted rolls back the platform claim and stays
retryable; outcome-unknown leaves the claim in place, returns HTTP 502 with
`status: needs_manual_reconciliation` and `retryable: false`, and never
auto-retries. The final publish calls remain one-shot.

**Effort:** S
**Priority:** P2
**Depends on:** None

**Completed:** fix/publish-failure-taxonomy (2026-05-21)

### Populate posts.creative_asset_ids so per-post media scoping activates

**What:** Make the weekly social pipeline write each post's own creative asset ids into `posts.creative_asset_ids` when it creates `posts` rows. Today the column is `'{}'` on every row and no code writes it.

**Why:** v0.1.4.0's `resolveMediaUrls` (finding F1) scopes scheduled-post media per-post via `creative_asset_ids`, but with the column empty it falls back to job scope — so a multi-image weekly job can still publish a wrong or mixed image for a given post. The per-post mechanism is in place and inert until the column is populated; this closes the wrong-media bug for real.

**Context:** Surfaced by the adversarial review during `/ship` of `fix/scheduling-engine-soundness` (2026-05-20). The pipeline's production/publish stage is where `posts` rows are created. This is Phase 2 (calendar planner) scope — the planner is only honest once each calendar tile maps to its true image.

**Effort:** M
**Priority:** P1
**Depends on:** None

**Completed:** v0.1.5.0 (2026-05-21)

- [ ] Add a component test for `PublishNowButton` (calendar-presenter.tsx) — stub `fetch`, assert success confirmation, error state, and the delayed modal close. (Deferred from Copilot review on PR #400.)

- [ ] Refactor Hermes media addressing to be ID-based. `/api/internal/hermes/media/[...path]` currently identifies assets by basename (last URL path segment) and proves ownership by string-matching `regexp_replace` over `served_asset_ref` / `storage_key`. v0.1.5.6 patched the ownership symptom but the design is still basename-coupled. Proper fix: make the route URL `/api/internal/hermes/media/<creative_assets.id>`, turn ownership into a primary-key + `tenant_id` lookup, and serve the file from `storage_key`. Update the `served_asset_ref` written at ingest (`backend/marketing/ingest-production-assets.ts`) and every consumer — calendar backlog thumbnails, creative-review previews, `scheduled-dispatch` media resolution. Removes basename coupling, the dual-column regex match, and basename-collision risk. (Logged 2026-05-21 after v0.1.5.6.)


### CI infra — Autofix 401 + CodeQL flake runbook (RESOLVED)

**Resolved** by `docs/plans/2026-05-30-ci-codeql-stabilization.md` (Phase 1 + Phase 4). The autofix-side
`HTTP 401: Bad credentials` on `gh label create` is now hardened: both `pr-agent-autofix-automerge.yml`
and `issue-agent-fix.yml` wrap label creation in a best-effort `ensure_label` helper (3 retries with
backoff, then `::warning::` and `return 0`) so a transient labels-API flake can no longer abort the
maintenance/fix run. Label creation is idempotent (`--force`) and the labels already exist in the repo.

**Branch protection reminder:** `master` requires only the `full-suite` check, **not** the `CodeQL`
rollup (`gh api repos/:owner/:repo/branches/master/protection --jq '.required_status_checks.contexts'`
=> `["full-suite"]`). CodeQL is advisory, so the flake signatures below never block a merge.

**CodeQL flake runbook (re-trigger, do not panic):**
- **Rollup says `failure` in <5s but every sub-job is green** (#330 pattern): GitHub status-aggregation
  race. Re-run failed checks from the Actions UI, or push an empty commit. Nothing to fix in-repo. Not a
  merge blocker.
- **`Prepare` stuck `queued` post-merge** (#336 pattern): orphaned check run. Ignore (the PR already
  merged) or cancel the run for tidiness.
- **`terminal prompts disabled` on CodeQL checkout** (PR #438 pattern): `actions/checkout` lost its
  token context on CodeQL's *own* default-setup checkout. Re-trigger with a push. The in-repo
  `pr-agent`/`issue-agent` checkouts are unaffected — they pass `GH_TOKEN` explicitly.

**Security-tab recommendations for Brendan (out of band, not landable code):**
- If #421's `Analyze (python)` resolves to a phantom Python target (PR #404 removed the only `.py`
  files), remove Python from CodeQL default-setup languages so the phantom job stops being scheduled.
- Confirm Copilot Autofix for CodeQL is intentionally on/off; the `Prepare`/`Agent` jobs only appear
  when it is enabled.

**Priority:** P3 hygiene — code portion done; remaining items (#279/#280/#330/#336/#421 issue triage,
Security-tab toggles) are GitHub-side actions tracked in the plan, executed by Brendan.
**Source:** Investigated 2026-05-23 (deferred); hardened 2026-05-30 via the CI/CodeQL stabilization plan.

### Honcho continuous-profile-writes — flip HONCHO_ENABLED and Phase 1 flag in prod

**What:** Phase 1 implementation code is ALREADY shipped on master (`scheduleMarketingApprovalHonchoWrites` wired at `backend/marketing/orchestrator.ts:2064`, `recordApprovalEvent`/`recordDenialEvent` in `backend/memory/write-events.ts`, env gate `HONCHO_WRITE_APPROVALS_ENABLED` in `backend/memory/honcho-env.ts`, tests in `tests/memory-write-events.test.ts`). What is NOT done is enabling it in production: `HONCHO_ENABLED=false` and `HONCHO_WRITE_APPROVALS_ENABLED=false` are the docker-compose.yml defaults.

**Why:** To start capturing strategy approvals + creative rejections into Honcho per the v2 continuous-profile-writes plan.

**Prerequisites before flipping:**
1. `HONCHO_BASE_URL` set in production `.env` (currently blank default).
2. `HONCHO_CONTROL_PLANE_JWT` and `HONCHO_DATA_PLANE_JWT` set in prod `.env`.
3. `ARIES_TENANT_PSEUDONYM_SALT` set in prod `.env`.
4. Confirm `honcho_write_idempotency_keys` Postgres table exists or add migration to `scripts/init-db.js`.
5. Smoke test that the Honcho backend at `HONCHO_BASE_URL` accepts a write before flipping prod gate.

**Fix:** After prerequisites are confirmed, edit `docker-compose.yml`:
```
HONCHO_ENABLED: ${HONCHO_ENABLED:-true}
HONCHO_WRITE_APPROVALS_ENABLED: ${HONCHO_WRITE_APPROVALS_ENABLED:-true}
```
And ship as its own PR.

**Resolved:** The flag flip has since landed — `docker-compose.yml` now defaults `HONCHO_ENABLED: ${HONCHO_ENABLED:-true}` and `HONCHO_WRITE_APPROVALS_ENABLED: ${HONCHO_WRITE_APPROVALS_ENABLED:-true}` (flipped ON 2026-05-24 per the compose comment above those lines).

**Priority:** P2 (gated on user decision + prod creds)
**Source:** Discovered 2026-05-23 during /goal P6 investigation. Asked user; user replied "do what's next" — deferred per that direction.

### Honcho Phase 2 + Phase 3 — branches need land

**What:** TODOS lines 81-103 note that Phase 2 (publishing events + performance feedback) and Phase 3 (UI preference signals) have code "shipped on branch" but never landed to master. Find those branches (likely named `feat/honcho-phase-2-...` and `feat/honcho-phase-3-...`) and either land them or close them out.

**Why:** Dangling unmerged work rots. If the design is still valid, ship; if not, close.

**Resolved:** Phase 2 + Phase 3 code is on master (`recordPerformanceEvent` in `backend/memory/write-events.ts`, the `creative-voice-preference` route, and the `aries-honcho-performance-worker` sidecar) and both gates default ON in `docker-compose.yml` (`HONCHO_WRITE_PUBLISH_ENABLED` / `HONCHO_WRITE_PREFERENCES_ENABLED`).

**Priority:** P3 (after Phase 1 flag flip lands)
**Source:** Surfaced 2026-05-23 during /goal P6 investigation.

## Multi-workspace membership (deferred from 2026-07-03 plan review)

### Per-workspace notification preferences

**What:** Let a user configure notification settings (e.g. Slack approval pings, email digests) per workspace membership rather than globally per account.

**Why:** Once one account can belong to N workspaces (docs/plans/2026-07-03-multi-workspace-membership.md), a consultant in 3 client workspaces will want different notification behavior per client. No notification-preference surface exists today, so this needs its own design, not a column bolted onto `organization_memberships`.

**Effort:** M
**Priority:** P3
**Depends on:** Multi-workspace membership Phases 0–3 shipped and flag-ON.

### Org-deletion self-service UI

**What:** Operator-facing UI to delete/archive a workspace (today deletion is `backend/tenant/organization-lifecycle.ts` invoked manually).

**Why:** The multi-workspace plan's Phase 4 makes org deletion SAFE (membership cascade + active-pointer repair) but ships no UI for it. Abandoned orphan workspaces accumulate as identity cruft (orgs 8/58/59 from the 2026-07-03 incident are examples).

**Effort:** M
**Priority:** P3
**Depends on:** Multi-workspace membership Phase 4 (lifecycle repair) shipped.
