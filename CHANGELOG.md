# Changelog

All notable changes to this project will be documented in this file.

## [0.1.3.7] - 2026-05-14

### Added
- **Hermes research guidance via `last30days` skill.** Both `instructions()` branches in `backend/marketing/ports/hermes.ts` now instruct Hermes to use the `last30days` skill when researching the brand URL and competitor URL. Requires `SCRAPECREATORS_API_KEY` in the Hermes environment to return live data.

### Fixed
- **Workflow UI: runtime status fold-in (fixes navigational dead-end).** "View runtime status" previously routed to a bare `/dashboard/social-content/[jobId]` page with no back/forward/stage navigation and a blank Job ID form. The runtime status is now rendered as a "Runtime Status" view inside the campaign workspace shell (`frontend/aries-v1/campaign-workspace.tsx` + `campaign-workspace-state.ts`). Legacy `/social-content/status` and `/social-content/review` routes are left as-is (still linked from other surfaces; a separate broader PR can redirect them).

## [0.1.3.6] - 2026-05-14

### Fixed
- **Social-content sub-stages no longer strand when `approve_publish` skips the publish step.** The `approve_publish` publish-skip terminal path in `backend/marketing/hermes-callbacks.ts` was marking the job `completed` without sweeping in-flight social-content sub-stages — leaving `copy_production`, `image_briefing`, and `image_generation` perpetually `in_progress` (root cause of the `mkt_0735c3b1` stranding failure). A new `reconcileSocialContentIntermediateStages()` call in `backend/social-content/runtime-state.ts` runs immediately before the `completed` sentinel is written, sweeping any in-flight sub-stage to `completed`. **Known bounds:** (1) The sweep is only as good as the stage the callback reports — if Hermes ever sends an earlier `payload.stage`, later stages could still strand; worth a follow-up if that pattern appears. (2) The reconcile MUST run before the `completed` sentinel is set; ordering is currently correct and should be preserved.

## [0.1.3.5] - 2026-05-14

### Fixed
- **Hermes media route now enforces per-tenant ownership.** The `/api/internal/hermes/media/[...path]` route added in v0.1.3.4 deferred tenant-scoping (noted in a route `NOTE:` comment). This release closes that gap: `resolveHermesMediaTenantOwnership()` in `backend/marketing/runtime-state.ts` performs a sequential filesystem scan of the tenant's social-content run state to confirm the requested basename belongs to the authenticated tenant before serving the file. Cross-tenant requests receive 404 (not 403, to avoid leaking file existence). Path-traversal containment from v0.1.3.4 is preserved. No database fan-out — the scan is FS-only (guardrail #1). Covered by 7 unit tests including a path-traversal assertion.

## [0.1.3.4] - 2026-05-14

### Added
- **Hermes image bridge: generated images from social-content runs now render in the dashboard.** Two compounding bugs prevented dashboard images: (1) Hermes emits `creative_assets[].path` (host-absolute filesystem paths) but the schema expected `image_creatives[].artifact_url` (browser-loadable URLs) — a `bridgeHermesCreativeAssets()` function now maps the path to an authenticated internal URL; (2) there was no route to serve those files to the browser — a new session-authed, path-traversal-safe `/api/internal/hermes/media/[basename]` route reads from the Hermes image cache mount. `docker-compose.yml` and `docker-compose.local.yml` add a read-only bind-mount of `~/.hermes/cache/images` at `/hermes-media` inside the container.
- **`/api/internal/hermes/media` route** — session-authenticated image-serving route with path-traversal containment; tenant-ownership scoping is intentionally deferred (see route `NOTE:` comment and PR known follow-up).

## [0.1.3.3] - 2026-05-14

### Fixed
- **Social-content approval transition now uses an explicit per-stage allowlist.** The previous conditional had two logic gaps: research→production skip-forward was allowed, and strategy→strategy self-transition was not caught. Replaced with `SOCIAL_CONTENT_ALLOWED_APPROVAL` record mapping each run stage to exactly one valid approval stage; any other transition (skip, regression, unknown stage) returns `approval_stage_mismatch` and fails loud at the callback boundary instead of silently misrouting the pipeline.

## [0.1.3.2] - 2026-05-13

### Fixed
- **Weekly social-content posts now surface on /dashboard/posts and /dashboard/calendar.** Two wiring gaps prevented the content from reaching the dashboard list endpoints. (1) `parseSocialContentWorkflowOutput` only recognised the `weekly_content_plan` (snake_case) key in Hermes production output, but Hermes actually emits `weeklyPlan` (camelCase); it now accepts either. (2) `buildCampaignWorkspaceView` computed the raw dashboard but never applied `buildSocialContentDashboardProjection`, so posts/assets/calendar events synthesised from the social-content runtime were dropped before the list endpoints read the result. Both gaps are now closed and covered by a regression test.
- **Default weekly post count is now 7 (was 3) to match the "weekly content" product framing.** The new-job form, backend default scope, and workflow request all now default to 7 static posts per week so a fresh run produces a full week of content without the operator needing to manually adjust the count.

## [0.1.3.1] - 2026-05-13

### Fixed
- **Marketing research/strategy stages timed out after 120s against real Hermes runs.** `backend/marketing/ports/hermes.ts` falls back to a 120_000ms code default when `HERMES_RUN_TIMEOUT_MS` is unset, and `docker-compose.yml` was passing the env through with no default, so prod always inherited 120s. On populated tenants the Hermes research agent routinely takes 3-8 minutes, so Aries marked the stage failed before Hermes finished and the operator saw an opaque "did not reach a terminal status" error. Compose default is now `${HERMES_RUN_TIMEOUT_MS:-600000}` (10 min) — per-tenant `.env` overrides still win. After this lands: research/strategy completes against real workloads, no operator action required beyond the redeploy.

## [0.1.3.0] - 2026-05-13

### Fixed
- **Weekly social-content pipeline halted at Stage 1→2 transition because Hermes resume payload had no `input` field.** v0.1.2.9 fixed the upstream contract but the social-content resume branch in `backend/marketing/ports/hermes.ts` still returned a structured object (action/resume_token/approval_step) without the `input` string Hermes `/v1/runs` requires. Approving "Continue to brand analysis" produced HTTP 400 "No user message found in input" and the pipeline never reached Strategy/Production/Publish. Resume payload now serializes a prompt string (workflow key, action, run id, approval step, resume token, approve flag, job id, tenant id, approval id) plus `instructions` and `session_id` mirroring the run path. After this lands: approving research advances Strategy live, the full 4-stage flow completes, and posts surface on /dashboard/posts + /dashboard/calendar.
- **Review-decision endpoint returned 500 on every retry against a failed-state job.** `resolveMarketingApproval`'s outer catch in `backend/marketing/orchestrator.ts` called `handleFailure` which is typed `never` and always rethrows. Any error from `resumeMarketingPipeline` (Hermes network failures, stale resume tokens, `workflow_deny_failed` throws) escaped as an unhandled exception, skipped `assertApprovalResult`, fell through `mapAriesExecutionError`, and produced a generic 500 — which matched every prod campaign's current state (5/5 failed). The outer catch now returns a structured `{status: 'error', reason}` so `assertApprovalResult` converts it to a clean `RuntimeReviewDecisionError(400)` the route handler maps correctly. New regression test in `tests/review-decision-failure-paths.test.ts` walks an approval to Stage 4, stubs `resumePipeline` to throw `hermes_unreachable`, and asserts no uncaught exception + a 4xx surface error.

### Changed
- Removed `gh_config` named volume from `docker-compose.yml`. The web container no longer mounts `/home/node/.config/gh` from a shared volume — `gh` auth state is no longer expected to persist across container restarts.

### Removed
- Archived `docs/product/aries-ai-prd-audit.md` and `docs/product/aries-ai-prd-audit-critical-verification.md` into `docs/audits/2026-05-12-prd-audit*.md` (history preserved via `git mv`). The PRD was a confusing three-document set where two of the three were point-in-time snapshots competing with the live PRD; the audits now live in a clearly historical directory. The live PRD picked up targeted §9.4 (Hermes poll-bridge note), §15.5 (debt status), and §16.3/§19.5 (campaign→posts terminology backlog acknowledgment) updates.

## [0.1.2.9] - 2026-05-13

### Fixed
- **Weekly social content pipeline stalled after research because the Hermes approval contract was wrong.** Commit `eacbdca` tried to fix the prior "Hermes returns `completed` after research and skips strategy/production/publish" bug by encoding an explicit 4-stage requires_approval contract, but it sent `approval.stage="brand"` and `approval.workflowStepId="strategy"|"production"|"publish"|"publish_review"` — none of which are valid identifiers in Aries. `parseApproval` drops the research callback (rejected with `missing_approval_payload`), and on the default-on poll-bridge path the stage gets silently rewritten to `"production"` which produces a malformed checkpoint that skips the `strategy` stage entirely. The frontend `approvalStepToView` returns `null` for the bad workflow_step_id, so the "Continue to brand analysis" CTA never renders. Restore the canonical identifiers proven by `tests/marketing-hermes-callback-flow.test.ts` (`approval_step` in {approve_weekly_plan, approve_post_copy, approve_publish}; `workflowStepId` in {approve_stage_2, approve_stage_3, approve_stage_4, approve_stage_4_publish}) and add `approval_step` to the schema hint. Every downstream component (parser, validator, approval-store, jobs-status projection, frontend view-mapper, friendly first-checkpoint CTA gate) was already wired for these exact identifiers; the fix flips the upstream instructions to match. Live behaviour after this lands: research completes, workspace shows "Continue to brand analysis" with a working approve-and-continue button, strategy fires, production fires, publish fires, posts surface in the dashboard.
- **Onboarding submitters landed on a "Welcome Back" login page they had no account for.** After completing the 5-step unauthenticated onboarding flow and clicking "Save and continue", new users were sent to `/login?callbackUrl=/onboarding/resume...&draftSaved=1&businessName=...` where the primary heading reads "Welcome Back / Sign in to your Aries AI account". The "create one" link was small text at the bottom. The login page now server-side redirects to `/signup` with all query params preserved when `draftSaved=1` and `callbackUrl` starts with `/onboarding/resume`, so first-time onboarders land on Create Account instead of Sign In.
- **Competitor URL validation error leaked the raw server field name.** The inline error on the Goal step was `competitor_url must be the competitor's website, not a Facebook or Ad Library URL` but the visible UI label is "Competitor website". Replaced both error constants in `lib/marketing-competitor.ts` (and their copies in `lobster/bin/meta-ads-extractor`) with user-facing copy ("Competitor website must point to the competitor's site..." / "Competitor website must be a valid HTTPS URL") and updated the four test assertions that pin the literal.
- **"Other" goal radio on onboarding did not focus its custom-outcome textarea.** Clicking "Other" revealed the "Describe your business outcome goal" input but left focus on the radio, so the user had to click into the input manually. Added a transition-keyed `useEffect` that focuses the input only when goal flips into `Other` (not on initial draft hydration when Other is already selected).

## [0.1.2.8] - 2026-05-12

### Added
- **Nightly marketing-pipeline synthetic regression gate.** New automation job `aries-nightly-marketing-synthetic` (runs daily at 02:00 America/Los_Angeles) invokes `scripts/automations/nightly-marketing-synthetic.mjs` which verifies prod liveness (`/` + `/api/health/db`), runs `validate:marketing-flow` (orchestrator + Hermes four-stage fan-out contract), and runs `validate:execution-provider` (Hermes adapter + callback route contract). Emits a single-line JSON summary on stdout and exits non-zero on any failure so the cron orchestrator can route failures. Supports `--preflight` and `--dry-run` for `verify-automations` parity.
- **Post-deploy canary configuration.** `scripts/canary/config.json` documents the canonical production URL (`https://aries.sugarandleather.com`), the page list to monitor (`/`, `/signup`, `/dashboard`, `/dashboard/posts`, `/marketing/new-job`, `/onboarding`), API health endpoints, performance thresholds (LCP 3500ms, FCP 2000ms, 2x perf regression alert), and the standard `/canary` invocations. `scripts/canary/README.md` is the operator entry point; `/canary` writes its reports under `.gstack/canary-reports/` (gitignored).
- Marketing orchestrator now fans out a one-shot Hermes completion into all four marketing-pipeline stages. When Hermes returns a single `completed` callback whose `output` carries per-stage entries (either an array of `{stage, run_id, summary, …}` records, or a record with a `stages` sub-object), `applyHermesMarketingCallback` walks `STAGE_ORDER` (`research → strategy → production → publish`), records each stage's artifacts/summary on its own `MarketingStageRecord`, clears the approval checkpoint, and — if `publish` is included — finalizes the job (`state=completed`, `current_stage=publish`) and schedules the publish→honcho write. Single-stage callbacks fall through to the existing path unchanged, and already-terminal stage records are left alone, so late/duplicate one-shot callbacks cannot regress state. This unblocks any Hermes workflow variant that produces the full four-stage marketing result in a single run instead of one callback per stage.

## [0.1.2.7] - 2026-05-12

### Fixed
- Marketing pipeline runs were stranded indefinitely at `research/in_progress` because Hermes's `/v1/runs` API is OpenAI-style polled and **does not invoke the `callback_url`** field that Aries sends. The marketing port submitted the run, returned `kind: 'submitted'`, and waited for a callback that never arrived. Within 5 minutes Hermes would GC the orphaned run, leaving the campaign stuck forever (`isPipelineActive` true, dashboard "Generate this week's content" button disabled, no progress through strategy/production/publish). Added a poll-bridge in `HermesMarketingPort`: after submission, a background task polls `GET /v1/runs/{id}` until terminal, then invokes `handleHermesRunCallback` directly (bypassing the HTTP route and auth since we are already inside the trusted backend). Default-on; disable in tests with `HERMES_POLL_BRIDGE_ENABLED=0`.

## [0.1.2.6] - 2026-05-12

### Fixed
- Weekly social content marketing pipeline was failing immediately at the research stage with HTTP 400 from Hermes (`"No user message found in input"`). `HermesMarketingPort.submissionPayload` for `social_content_weekly` was sending the structured workflow request (`{input: {brand, objective, competitor, ...}, workflow_key, workflow_version, ...}`) as top-level fields, but Hermes's `/v1/runs` is an OpenAI-style chat-completions endpoint that requires `input` to be a string. The brand_campaign path already serialized to a string via `prompt()` and worked; the social-content path bypassed that path and never got migrated. Now both paths serialize the structured request into a prompt string (with `Workflow:`, `Aries run ID:`, `Request (JSON):` lines), keep the workflow key/version/run id in `callback_context` for the callback, and use the same `instructions()` schema spec. The "Generate this week's content" button on the dashboard now actually starts a run instead of failing in 24 ms.

## [0.1.2.5] - 2026-05-12

### Fixed
- Hermes execution adapter was silently 501-ing every non-demo workflow because `HERMES_SUPPORTED_RUN_WORKFLOWS` in `backend/execution/providers/hermes.ts` was hardcoded to `['demo_start']`. PR #258 made Hermes the default provider for all `runAriesWorkflow` callers (calendar sync, sandbox launch, integrations sync, publish retry/dispatch, onboarding start, tenant workflow runs) but never widened the allowlist, so every one of those routes returned HTTP 501 `not_implemented` with the gateway healthy and configured. Marketing was unaffected because it uses a separate `HermesMarketingPort`. The allowlist now derives from `ARIES_WORKFLOWS` in `workflow-catalog.ts`, so the catalog is the single source of truth — any new workflow key added there is automatically reachable through Hermes.
- Hermes adapter's fallback `instructionsForWorkflow()` now communicates the same `{status, output, message}` envelope schema that `demo_start` uses, so the gateway agent gets actionable instructions regardless of workflow key (previously it only got "reply with JSON only" with no schema spec).

## [0.1.2.4] - 2026-05-11

### Added
- Engineering plan for Aries Honcho continuous profile writes (`docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md`). Maps the four day-to-day write surfaces (approvals/rejections, publishing/performance, UI preferences, pipeline stages 2-4) to the v1 plan's already-designed peers and sessions. Three rollout phases (P1 = strategy approvals + creative rejections, P2 = publishing + performance feedback, P3 = explicit UI preferences). Passed `/plan-eng-review` with 7 architecture decisions locked in (peer mapping, user pseudonym salt reuse, idempotency table, structured reason codes, single `write-events.ts` ingestion module, Phase 2 load test, in-process best-effort writes).
- TODOS.md entries for the three rollout phases. Phase 1 effort revised from M to L after the eng review locked in scope.

## [0.1.2.3] - 2026-05-11

### Changed
- `npm run verify` now catches Next.js 16 route-handler type errors before push. The verify gate runs `next typegen` (generates `.next/types/**/*.ts` route constraints) then `tsc --noEmit` as a pre-suite step, closing the CI gap that required hotfix PR #284.
- `npm run typecheck` and `npm run lint` also run `next typegen` first, so route-handler `RouteHandlerConfig<Route>` constraint violations are visible regardless of which gate the developer uses locally.
- Added `## Deploy Configuration` to CLAUDE.md with the production URL and health-check command, enabling `/land-and-deploy` canary checks against the live environment.

## [0.1.2.2] - 2026-05-07

### Added
- Onboarding "Brand identity" step now has the wiring to show real LLM analysis (brand voice, offer, positioning, audience, tone of voice, style vibe) instead of the truncated meta-description text the heuristic scraper produced. The enrichment lives behind the `ARIES_BRAND_ENRICHMENT_ENABLED` flag (off by default) and routes through Hermes; until the flag is flipped, the step renders the existing scraper output unchanged.

### For contributors
- Added `backend/marketing/brand-kit-enrich.ts` as the Hermes-backed enrichment helper. It submits a structured JSON-schema prompt to `/v1/runs`, sync-polls until terminal, and returns typed failure reasons (disabled, not_configured, unreachable, timeout, run_failed, output_invalid) so callers can fall back to the scraper-only path on any error.
- Extended `OnboardingDraftPreview.brandKitPreview` and `UrlPreviewBrandKitPreview` with `positioning`, `audience`, `toneOfVoice`, `styleVibe` (all nullable). The draft-store sanitizer round-trips them.
- New regression: `tests/brand-kit-enrich.test.ts` covers all six failure modes plus the happy path.
- Compose now reads `ARIES_BRAND_ENRICHMENT_ENABLED`, `HERMES_BRAND_ANALYSIS_SESSION_KEY`, and `HERMES_BRAND_ANALYSIS_TIMEOUT_MS` through env with sensible defaults.

## [0.1.2.0] - 2026-04-23

### Added
- Shared inline form validation across auth and onboarding. Fields now show real-time "Enter a valid email address"-style feedback and the submit button stays disabled until every input actually satisfies its contract.
- Review workspace recovery screen. When a review deep link resolves to a review your current workspace does not own, you now see a clear explanation plus "Open review queue" and "Open campaigns" next steps instead of a blank page.

### Fixed
- Review detail deep links survive the login redirect, so opening a shared `/review/[reviewId]` URL while signed out lands you back on that exact review after auth, not the dashboard.
- Onboarding handoff and navigation: the resume page honors pending state, browser history no longer strands you on a broken step, and step-one validation blocks empty submits before they fire.
- Dashboard campaign-start failures now surface a visible error banner instead of silently swallowing the failure.
- Contact page replaces the "Contact intake is not available yet" dead end with a `support@sugarandleather.com` mailto action, so users can actually reach support.
- Homepage request-access form validates inputs inline and keeps the submit disabled until the form is valid, with a dedicated loading state while the request is in flight.
- Forgot-password and login screens share the same inline validation contract as signup, removing divergent error copy across auth forms.
- Signup email addresses are normalized (trim + lowercase) before submission so duplicate-account checks match the real stored identity.
- Docker production port publish moved into `docker-compose.yml` base so deploys and production-style runs expose `${PORT:-3000}` without depending on the local override being layered in.
- CI deploy workflow checks out over HTTPS with the workflow token, unblocking the self-hosted deploy host when SSH origin access is not available.

### For contributors
- Added `lib/form-validation.ts` as the shared primitive behind inline validation (`EMAIL_ADDRESS_REGEX`, `isValidEmailAddress`, `getRequiredFieldError`, `getEmailFieldError`, `useDisabledUntilValid`).
- Added `frontend/aries-v1/review-recovery.ts` as the workspace-recovery state builder consumed by the review detail screen.
- Added GitHub issue templates (`.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`) so incoming bug and feature reports arrive with consistent structure.
- New regression specs pinned to this wave: `tests/login-form-validation.regression-010.test.ts`, `tests/forgot-password-form-validation.regression-011.test.ts`, `tests/onboarding-step-one-validation.regression-012.test.ts`, `tests/homepage-request-access-validation.regression-013.test.ts`, `tests/route-metadata-and-docs-anchors.regression-015.test.ts`, `tests/deploy-workflow-self-hosted.regression-015.test.ts`, `tests/homepage-request-access-loading.regression-016.test.ts`, `tests/production-compose-port-publish.regression-016.test.ts`, `tests/signup-email-normalization.regression-017.test.ts`.

## [0.1.1.0] - 2026-04-23

### Fixed
- Blocked signup submission until full name, email, and password all satisfy real validation requirements.
- Removed false click affordance from the homepage Meet Aries workflow chips and exposed them as non-interactive list semantics.
- Added Escape dismissal to the desktop account menu while preserving click-outside close behavior.
- Repaired stale encoded marketing text on campaign workspace and business-profile read paths before UI and API consumers render it.
