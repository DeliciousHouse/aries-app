# Changelog

All notable changes to this project will be documented in this file.

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
