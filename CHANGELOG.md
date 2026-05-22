# Changelog

All notable changes to this project will be documented in this file.

## v0.1.7.1 — chore(automations): remove openclaw-era cron tooling

Removes the dead automation tooling that was registered into an external openclaw cron runtime that no longer exists. None of it could run for an OSS or self-hosted deployment: the cron installer shelled out to the `openclaw` CLI, and several jobs read board state from hardcoded `~/.openclaw` paths. Deleted 15 `scripts/automations/` scripts plus their support library (the cron installer, manifest, daily-standup/brief, weekly-review, overnight-self-improve, rolling-system-reference, runtime-error intake, GitHub-feedback connector, ci-watcher-dispatch, private-repo-backup, staging-deploy, nightly-marketing-synthetic, verify-automations), the 13 matching openclaw-era cron skills under `skills/` including the whole `skills/operations/` directory and the openclaw cron templates, the tests covering the removed scripts, and the 10 `automation:*` npm scripts. `scheduled-posts-worker.mjs` — the worker that drains the `scheduled_posts` table and publishes due posts to Meta — is kept along with its four tests; it has no openclaw coupling and runs on any scheduler. The `bug-triage` and `feature-pipeline` skills are kept, with their references to the removed `feedback-connector`/`staging-deploy` scripts replaced by direct equivalents. `CLAUDE.md`, `docs/SYSTEM-REFERENCE.md`, `memory/README.md`, and `skills/index.json` were updated to drop references to the removed tooling, and the marketing runtime-error bridge's `validationCommand` now points at the still-valid `npm run validate:marketing-flow`. Lint, typecheck, and the `npm run verify` regression gate all pass.

## v0.1.7.0 — fix(security): close three CSO audit findings — issue-agent gating, SHA-pinned actions, SSRF-safe fetch

Resolves the three HIGH-severity findings from the 2026-05-22 CSO security audit. The `issue-agent-fix` workflow previously launched a write-capable autonomous coding agent on every newly opened public GitHub issue, embedding the untrusted issue title and body straight into the agent prompt — a prompt-injection path into a workflow with `contents`/`issues`/`pull-requests` write scope. The workflow now triggers only on a maintainer-applied `agent:fix` label (or manual dispatch), and the issue title/body are fenced with explicit untrusted-input delimiters and an instruction never to follow directives inside them. Third-party GitHub Actions in the three privileged workflows (`anthropics/claude-code-action`, `docker/login-action`, `docker/setup-buildx-action`) are pinned to full commit SHAs instead of mutable tags, so a retargeted tag or compromised action release cannot reach repository write tokens or the self-hosted runner. The URL-preview brand-kit extraction path is now SSRF-hardened: a new `lib/ssrf-safe-fetch.ts` helper resolves DNS and rejects any address in a private, loopback, link-local, CGNAT, or unique-local range (IPv4 and IPv6, including the cloud metadata IP and IPv4-mapped forms), follows redirects manually with per-hop revalidation, and is wired into every server-side fetch in `brand-kit.ts` so attacker-controlled stylesheet URLs and redirect chains can no longer probe internal infrastructure. The url-preview route also rejects IPv6 literal hosts as defense-in-depth. Twelve regression tests cover the new helper; typecheck, lint, and the `npm run verify` gate all pass.

## v0.1.6.6 — chore(deps): modernize dependencies and upgrade to React 19

Three dependency cleanups in one pass. The unused `three`, `@react-three/fiber`, and `@react-three/drei` packages — dead weight with zero imports anywhere in the app — are removed, along with `@types/three`. `lucide-react` is upgraded to v1, which dropped all brand icons; the five brand glyphs the app still used (Facebook, Instagram, LinkedIn, YouTube, Chrome) are now inline SVG components in `frontend/aries-v1/brand-icons.tsx`, drop-in compatible with the lucide icon API. React and React DOM are upgraded from 18.3 to 19, along with their type packages and `react-test-renderer`; the React 19 type changes (the removed global `JSX` namespace, stricter element `props` typing) were resolved across the affected files. Typecheck, lint, the regression suite, and a full Turbopack production build all pass.

## v0.1.6.5 — fix(security): return literal error codes from profile route handlers

Closes the last two CodeQL `js/stack-trace-exposure` alerts (#8 and #13). v0.1.6.4 cleaned the unexpected/500 path, but the domain-error 400/422 branches in `business/profile` and `tenant/profiles` still returned the caught error's `.message` to the client, which CodeQL traces back to error data. Those branches now return literal error codes (`invalid_role`, `missing_required_fields:email`, `invalid_website_url`, and similar) and imported constants instead of the raw message. The `business/profile` `errorStatus` helper is replaced with `classifyClientError`, which maps each known error to a safe code plus HTTP status in one place. Two dynamic suffixes are dropped: the bad timezone value on `invalid_timezone` errors, and the inner failure detail on `brand_kit_fetch_failed` errors — both were error-derived and not needed by the frontend.

## v0.1.6.4 — fix(security): stop leaking error detail on profile route 500s

Completes the v0.1.6.3 error-exposure work. CodeQL still flagged three profile route handlers (`business/profile`, `tenant/profiles`, `tenant/profiles/[userId]`) for `js/stack-trace-exposure`: v0.1.6.3 genericized the authentication-error paths, but the database-operation catch blocks still returned raw `error.message` to the client on unexpected failures. Those 500-path responses now return a generic "An unexpected error occurred"; known domain error codes (field validation, `tenant_not_found`, `invalid_role`, `brand_kit_*`) are still returned literally so the frontend contract is unchanged. The full error and stack trace are now logged server-side, so debuggability is preserved. Closes CodeQL alerts #8, #13, and #14.

## v0.1.6.3 — fix(security): resolve CodeQL ReDoS and error-exposure findings

Fixes the open CodeQL code-scanning security findings. The email-validation regex in the forgot-password, reset-password, and early-access routes had ambiguous quantifier overlap that allowed polynomial-time backtracking on crafted input (a denial-of-service vector); it is replaced with a non-backtracking pattern that requires a properly dotted domain. Nine API route handlers (calendar sync, integrations, publish dispatch/retry, Facebook/Instagram publish, tenant profiles, business profile) returned raw error messages to clients, leaking internal error detail; they now return generic messages. Two findings in the deleted `lobster/` Python files were already resolved by the v0.1.6.0 OpenClaw removal. The `postcss` Dependabot advisory is resolved by the batched dependency PR.

## v0.1.6.2 — chore(deps): batched dependency updates

Consolidates routine dependency updates into a single change: `three` 0.183→0.184, `motion` 12.38→12.40, `pg` 8.20→8.21, `postcss` 8.5.11→8.5.15, `tailwindcss` and `@tailwindcss/postcss` 4.2→4.3, `@types/node` 22→25, plus the `actions/checkout` (v5→v6) and `actions/setup-node` (v4→v6) GitHub Actions. Typecheck, lint, the verify suite, and a full production build all pass. Three Dependabot updates were intentionally excluded as breaking and deferred to dedicated follow-ups: `react-dom` 19 (a React 18→19 migration is its own project), `@react-three/drei` 10 (requires `@react-three/fiber` 9 and React 19), and `lucide-react` 1.x (its v1 removed the Facebook/Instagram/LinkedIn/YouTube brand icons the app imports).

## v0.1.6.1 — docs: link to the Hermes execution agent

The self-hosting documentation now links to Hermes, the execution agent that Aries hands long-running workflow execution to. The README "What's not in this repository" section, `docs/SELF_HOSTING.md` prerequisites, and `docs/ARCHITECTURE.md` all point to https://github.com/NousResearch/hermes-agent so anyone self-hosting Aries can run their own Hermes endpoint.

## v0.1.6.0 — refactor: remove legacy OpenClaw/Lobster and prepare the repo for open source

The legacy OpenClaw/Lobster execution path is fully removed and the repository is prepared for an open-source release. Hermes is now the sole execution provider — `backend/openclaw/`, the `lobster/` pipeline, the legacy provider adapters, and the `marketing-pipeline.lobster` machinery are gone, and `provider-factory.ts` resolves to Hermes unconditionally. The lobster-named artifact-cache environment variables were renamed to neutral names (`LOBSTER_STAGE*_CACHE_DIR` to `ARTIFACT_STAGE*_CACHE_DIR`, `OPENCLAW_LOBSTER_CWD` to `ARTIFACT_PIPELINE_CWD`, and similar) while keeping their default filesystem paths intact. The dead `brand_campaign` job type — which only ever ran on the Lobster engine — was removed along with its multi-stage approval test, leaving `weekly_social_content` as the sole job type. For the open-source release the repo now carries an Apache-2.0 LICENSE and NOTICE, governance and community files (SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, GOVERNANCE, SUPPORT, TRADEMARKS, ACCEPTABLE_USE), `.github/` CODEOWNERS, Dependabot config, and structured issue and PR templates, six public docs under `docs/` (architecture, self-hosting, deployment, OAuth scopes, security model, commercial positioning), a README rewritten for a public audience, and package.json open-source metadata. Internal operator scaffolding (`.ralph/`, `.sisyphus/`, `qa-reports/`, `memory/`) is no longer tracked.

## v0.1.5.6 — fix(media): trust the creative_assets table for Hermes media ownership

The `/api/internal/hermes/media` route proved tenant ownership by filesystem-scanning marketing runtime documents for the image basename, recognizing only the social-content and `weekly_content_plan` document shapes. Brand-campaign jobs store generated images under `stages.production.primary_output.artifacts.creative_assets`, a shape the scan did not walk, so the route returned "Not found" for legitimately owned assets — every calendar backlog thumbnail and every creative-review image for those jobs failed to load. `tenantOwnsHermesMediaBasename` now also consults the `creative_assets` table, the authoritative record of which tenant owns which asset, so any asset row owned by the tenant resolves regardless of runtime-document shape.

## v0.1.5.5 — fix(calendar): five UX and accessibility fixes for the scheduling calendar

Live QA of the publish calendar surfaced five issues, all now fixed. Backlog posts could only be scheduled by mouse drag — the drag handles announced themselves to screen readers as keyboard-operable, but no `KeyboardSensor` was registered, so Space and Enter did nothing; the calendar now registers a keyboard drag sensor, and each backlog tile carries an explicit "Schedule" button reachable by mouse and keyboard alike. The calendar page blocked its entire render behind a slow campaigns fetch, leaving a 20-30 second blank screen; it now renders as soon as the queue data is ready, and the campaign strip shows its own loading state. The event modal gained a "Publish now" action for pending or failed posts, which queues the post for the next dispatch pass and confirms before closing. Backlog tiles now show the post's image thumbnail instead of caption text alone.

## v0.1.5.4 — fix(marketing): ingest generated images into creative_assets

Completed Hermes pipelines now ingest their generated images instead of silently dropping every one. The creative-asset ingest's `INSERT ... ON CONFLICT (tenant_id, checksum)` omitted the `WHERE checksum IS NOT NULL` predicate of the partial unique index it targets, so PostgreSQL could not infer the index and rejected every row — every completed campaign ingested zero `creative_assets`, leaving synthesized posts without media. The clause now repeats the predicate, so each image persists and posts carry their real images. Verified against the live database, not a mock.

## v0.1.5.3 — fix(marketing): completed pipelines populate the calendar + publish-items count + failure taxonomy

Three marketing fixes that, together, make a completed Hermes pipeline actually surface its work and make publish failures honest.

**Completed pipelines now create posts.** v0.1.5.1 and v0.1.5.2 added creative-asset ingestion and publish-post synthesis, but a real end-to-end campaign still produced zero posts — root-caused to two ordering/guard bugs in the publish-completion callback. The creative-asset ingestion ran before the completion writer had populated the production stage's output on the runtime document, so it read an empty stage and ingested nothing; it now runs after the stage output is written. And the post synthesizer deferred whenever the publish stage carried any `publish_package` at all — but the Hermes publish agent commonly returns a thin, plan-only `publish_package` (cadence and schedule notes, no per-post previews or media) that nothing downstream can turn into posts. The synthesizer now defers only for a `publish_package` a consumer can actually use, and synthesizes posts otherwise. A completed pipeline now ingests its creative assets and creates the posts that reach the calendar.

**The dashboard "Publish items" count reflects real posts.** The campaign dashboard's publish-items counter was driven by a runtime-document projection that did not see the `posts` table, so it read zero even when a campaign had real posts. It now counts the actual `posts` rows for the campaign — four completed campaigns that previously showed "Publish items 0" now report their true counts.

**Meta publish failures are split into two honest outcome classes.** A failed Meta publish call previously collapsed every error into one generic failure, hiding whether the post had definitely not gone out or whether its outcome was simply unknown (for example, a response lost after the post may have been created). `MetaPublishError` now carries an `outcomeUnknown` flag, set only on the final-publish missing-id codes, and the Facebook and Instagram publish handlers branch on it so an operator can tell a safe-to-retry failure from one that needs manual verification before retrying.

## v0.1.5.2 — fix(marketing): synthesize approved publish posts so completed pipelines populate the calendar

Closes the last gap in the Hermes-native marketing pipeline: a completed pipeline reported "publish complete" but produced no launch items and nothing the scheduled-posts calendar could show.

**The publish contract was never reimplemented for Hermes.** The legacy OpenClaw publish path emitted a `publish_package` that Aries' launch consumers read; the Hermes-native pipeline never emits it, and no Hermes instruction defines that schema. What Hermes *does* produce reliably is the `content_package` — per-post copy (hook, body, CTA, hashtags, platforms) carried on the production stage — and the rendered images, ingested into `creative_assets` by the v0.1.5.1 fix. Neither became a `posts` row, so a completed pipeline left the operator with an empty launch view and an empty calendar.

**Completed Hermes pipelines now synthesize calendar-ready posts.** When the publish stage completes and Hermes supplied no `publish_package`, the callback synthesizes one `posts` row per content_package entry per target platform, linking each to its rendered image via `creative_asset_ids`. The posts are created approved — consistent with this deployment's autonomous mode, which has no human approval click in the pipeline — so they immediately appear in the calendar's unscheduled backlog and are ready to schedule and publish. The schedule route also gates on an approved `publish`-stage approval record, which the autonomous run never creates, so the synthesizer writes that record too; without it a synthesized post would be rejected at scheduling time. Both halves are idempotent: a replayed callback creates no duplicate posts (via the per-post unique index) and no duplicate approval record (via a deterministic record id). The synthesizer defers entirely when a real `publish_package` is ever present, so the legacy consumer path is never double-served.

## v0.1.5.1 — fix(marketing): resolve Hermes creative_assets via the image mount

A scoped bug fix for a silent publish-output regression: a completed Hermes pipeline reported "publish complete" but the operator dashboard showed "Generated assets 0 / No launch items", and nothing reached the launch view.

**The cause was a path the container could not read.** When the production stage completes, the callback ingests each generated image into the `creative_assets` table by reading the file Hermes reports. Hermes reports that file as a path on the *Hermes host*. The three-profile Hermes routing (v0.1.3.53) moved the content generator's image output into a profile-scoped cache directory — `<hermes>/profiles/aries-content-generator/cache/images/` — that is not the directory bind-mounted into the Aries container. The container can only read the Hermes image cache through its `/hermes-media` mount, keyed by basename. So every ingest `readFile` hit a host path the container has never seen, threw `ENOENT`, was caught and counted as skipped, and the stage finished having inserted zero rows. The single asset that ever ingested did so only during a brief window when Hermes still mirrored images to the legacy cache dir.

**The fix resolves Hermes paths through the mount, and repoints the mount.** Ingestion now takes the basename of whatever path Hermes reports and resolves it against `HERMES_IMAGE_CACHE_MOUNT` — the same basename-keyed approach the `/api/internal/hermes/media` route already uses to serve those images to the browser — with path-traversal guards, so a host path is never read directly. The `docker-compose` Hermes-cache bind mount default now points at the profile cache directory the content generator actually writes to, so the images are reachable from the container. Verified against the live regressed campaign: ingestion goes from 0 of 7 images to 7 of 7. A regression test stands up a temporary mount and feeds the exact host-path shape Hermes emits; it fails without the fix and passes with it.

**This fix only takes effect after a container recreate** — the `docker-compose` mount change must reach the running container.

## v0.1.5.0 — feat(scheduling): calendar planner UI and per-post media scoping

The calendar planner, plus the change that activates v0.1.4.0's dormant per-post media resolver. v0.1.4.0 made the scheduled-posts engine sound; this release builds the operator-facing planner on top of it and closes the last wrong-media gap in the publish path.

**Operators can now see and steer the publish queue.** `/dashboard/calendar` is a week/month grid fed by the real `scheduled_posts` table — every tile is a genuine queued post with a real dispatch status, not a runtime campaign-step event. Operators drag a tile to a new day to reschedule it, and drag approved-but-unscheduled posts onto the grid from a backlog tray to schedule them for the first time; both paths go through the same publish-approval gate, so nothing reaches Meta without sign-off. The calendar shows only real queued rows, so it starts empty and fills as posts are scheduled — no invented entries. The campaign status strip stays fed by the runtime campaigns. A new read endpoint, `GET /api/social-content/scheduled-posts`, is the calendar's single tenant-scoped, date-range-filtered data path; it returns each post's real `job_id`, the per-platform dispatch detail from `scheduled_post_dispatches`, and the unscheduled-approved backlog.

**Scheduling is timezone-correct.** Each tenant has a business timezone — an explicit operator selection in business-profile settings, persisted to both the `business_profiles` table and the file-backed profile record, validated as a real IANA zone, and falling back to a fixed default when unset. The calendar grid, every timestamp label, and the schedule input all render and convert in that one zone, so a post scheduled for 11pm tenant-time lands on the correct grid cell for an operator in any browser timezone. A new `lib/format-timestamp.ts` consolidates five copy-pasted timestamp formatters into one DST-safe module: wall-clock-to-UTC conversion uses `date-fns-tz` with an explicit DST policy, and the `RescheduleDrawer` — built earlier but never mounted — is now mounted from the calendar and reads its `datetime-local` input in the tenant zone rather than the browser zone.

**Multi-image weekly jobs now publish the right image per post.** v0.1.4.0's `resolveMediaUrls` scopes scheduled-post media per post via `posts.creative_asset_ids`, but the publish stage never wrote that column — every row was `'{}'`, so the resolver silently fell back to job scope and a multi-post weekly job could still publish a wrong or mixed image. The publish stage now writes each post's own creative asset ids when it creates the `posts` row, activating the per-post resolver for real and closing the wrong-media bug.

## v0.1.4.0 — fix(scheduling): engine-soundness pass for the scheduled-posts publish queue

Thirteen fixes hardening the scheduled-posts engine so a post placed on the queue actually publishes correctly. The scheduling queue, worker, and dispatch path already existed but carried latent bugs that never fired only because the queue had no rows — this release makes the engine sound before the calendar planner UI (Phase 2) starts writing to it.

**Publishing now requires approval.** The schedule route accepted any post; it now rejects scheduling a post that has no approved publish approval, so nothing reaches Meta without sign-off.

**The worker no longer breaks against the real database.** Two schema drifts are reconciled: the worker and `meta-publishing.ts` referenced a `posts.content` column that production had renamed to `caption`, and `init-db.js` was missing `job_id` plus five other `posts` columns production already had. The worker's row-claim query also locked the nullable side of an outer join — which PostgreSQL rejects outright — now fixed to lock only the queued row.

**Scheduled posts publish the right images.** Dispatch resolved creative assets by tenant only, so a tenant with several posts in flight could publish the wrong post's images. It now resolves per post — matching the post's own asset ids, falling back to job scope when none are recorded — and filters on the storage kinds the asset table actually uses.

**Cross-posting tracks each platform independently.** A scheduled post going to both Facebook and Instagram shared a single status, so a Facebook success plus an Instagram failure could not be represented. Per-platform dispatch state now lives in a new `scheduled_post_dispatches` table, and a partially successful post is no longer reported as failed.

**A crash mid-publish no longer fakes success.** The worker previously marked a row `dispatched` before calling Meta, so a crash left a post that never went out looking sent. Rows now pass through an `in_flight` state and only reach `dispatched` after Meta confirms; a row stuck `in_flight` is reclaimable. The narrow remaining double-publish window — a crash after Meta confirms but before the database commits — is documented in the worker; Meta's publish API exposes no idempotency key to close it fully.

## v0.1.3.55 — fix(marketing): retry-safe publish claims + correct job_type label

Three small marketing fixes from the Phase B follow-up list.

**#34 — A failed Meta publish no longer permanently blocks a retry.** The Instagram and Facebook publish handlers claim a per-platform slot on the publish approval *before* calling the Meta Graph API, so two concurrent requests can't double-post. Previously that claim was never released, so any publish failure (rate limit, network error, transient Meta error) left the platform marked `consumed` forever and every retry was rejected with `publish_approval_already_consumed`. New `releaseMarketingApprovalPlatformClaim` (`backend/marketing/approval-store.ts`) rolls the claim back under the approval lock when `publishToMetaGraph` fails; a post that went live but only failed verification keeps its claim. The provider-availability and no-content checks now run before consumption so those failures never leak a claim either. A swallowed rollback lock-error is logged with the approval and platform ids so a stuck claim stays diagnosable.

**#38 — Honest coverage for the missing-approval-payload callback.** `tests/hermes-callback-route.test.ts` had a test named "rejects malformed approval payloads" that actually fed a present-but-wrong-stage approval — which the route correctly rejects as `approval_stage_mismatch` (already covered by two other tests), not `missing_approval_payload`. The test now omits the approval envelope entirely, so it genuinely exercises the `missing_approval_payload` path.

**#41 — Weekly jobs are labelled `weekly_social_content`, not `brand_campaign`.** `job_type` on the marketing runtime document was hardcoded to `brand_campaign` for every job, disagreeing with `inputs.request.jobType` (which drives the pipeline) on weekly social-content jobs. It is now derived from `payload.jobType` with the exact strict equality `requestedJobTypeFromDoc()` uses, so the label can never disagree with the pipeline driver. The type widened to `'brand_campaign' | 'weekly_social_content'`.

**Known limitation:** because the rollback re-enables retries of a non-idempotent publish, a publish call that succeeds at Meta but throws before returning (lost HTTP response, or a 200 with a malformed body) can be retried and double-post. This is the inherent trade-off of unblocking stuck retries — the prior "never roll back" behavior avoided it only by guaranteeing a stuck claim instead.

## v0.1.3.54 — fix(marketing): terminate the weekly publish stage instead of looping it

The v0.1.3.53 three-profile cutover introduced a publish-stage loop. `buildWeeklyPublishInstructions` always told Hermes to return `requires_approval`, with no terminal path — so after the resume→run conversion, every publish run re-emitted an approval request, the orchestrator re-created the checkpoint, and auto-approve looped the publish stage indefinitely. A weekly campaign would never reach `completed`.

**Fix (`backend/marketing/ports/hermes.ts`)**

New `buildWeeklyPublishFinalizeInstructions` returns a terminal `completed` envelope with no approval object. The publish-stage instruction selection now branches on the resume's `workflowStepId`: the final publish approval (`approve_stage_4_publish`) gets the terminal finalize instructions; the first publish run keeps the normal instructions that emit the in-stage approval checkpoint. The orchestrator's existing publish-completion path then closes the job once the publish run returns a non-`requires_approval` envelope.

## v0.1.3.53 — refactor(marketing): three-profile Hermes routing for the weekly social pipeline

The weekly social-content pipeline ran every stage — research, strategy, production, publish — through one monolithic Hermes agent. That single agent structurally regressed: told to generate images it dropped copywriting; the strategy stage wrote JSON instead of reasoning. This release routes each stage to a dedicated Hermes profile so each agent does one job well.

**Per-profile routing (`backend/marketing/ports/hermes.ts`)**

Each marketing stage now targets its own Hermes profile gateway:
- research → `aries-research` (web/search tools)
- strategy + publish → `aries-strategist` (pure reasoning, no tools)
- production → `aries-content-generator` (`image_gen` toolset)

The target profile is derived from the stage the orchestrator already passes, so no orchestrator change is needed. Every per-profile gateway URL/key env var falls back to `HERMES_GATEWAY_URL` / `HERMES_API_SERVER_KEY` — a deployment that has not set the per-profile vars behaves exactly as the historical single-gateway setup.

**Per-stage instruction builders**

`buildHermesInstructions` for the weekly workflow is split into four short per-stage builders behind `buildHermesStageInstructions(workflowKey, stage)`. Each ships only its stage's contract: the strategist builder carries no `image_generate` text, the production builder carries no research tool policy.

**Resume → independent run**

A resume token issued by one profile's gateway cannot resume on another. An approved weekly strategy/production/publish transition is now dispatched as a fresh `action: run` POST on the stage's dedicated profile, carrying the prior stage's output as input. A weekly denial short-circuits before any POST — the denying stage's run has already completed, so there is nothing to cancel; the orchestrator records the denied state locally.

**Config**

`docker-compose.yml` wires `aries-strategist` (gateway port 8654) and `aries-content-generator` (port 8655); the research stage stays on the default gateway. `.env.example` documents all six per-profile vars.

## v0.1.3.52 — fix(publishing): poll Instagram media container until FINISHED before publish

Instagram's Graph API requires the media container to reach `FINISHED` before `/media_publish` is called. Previously `publishInstagram` called `/media_publish` immediately after `createInstagramContainer()`, causing `graph_api_error: "Media ID is not available"` when the container was still `IN_PROGRESS` (campaign mkt_d166d5e6).

**Fix (`backend/integrations/meta-publishing.ts`)**

New exported helper `waitForInstagramContainerReady` polls `GET /{creationId}?fields=status_code` in a loop before the `/media_publish` call:
- `FINISHED` or `PUBLISHED` — returns immediately, proceed to publish.
- `ERROR` or `EXPIRED` — throws `MetaPublishError('instagram_container_failed', ..., { status: 422, retryable: false })`.
- `IN_PROGRESS` or unexpected — waits and polls again.
- Backoff schedule: 2s, 3s, 4s, then 5s per poll; 15 attempts max (~60s budget).
- Timeout throws `MetaPublishError('instagram_container_timeout', ..., { status: 504, retryable: true })`.
- Accepts optional `sleepImpl` for fast test injection; defaults to module-internal `sleep()`.

**Tests (`tests/meta-publishing.test.ts`)** — 3 new tests:
- `IN_PROGRESS x2 then FINISHED` — resolves, confirms poll called 3 times, `media_publish` called once.
- `ERROR status` — throws `instagram_container_failed`.
- `Never FINISHED` — throws `instagram_container_timeout` after 15 exhausted attempts.
Existing Instagram container test updated to handle the poll call (3 total fetch calls, not 2).

## v0.1.3.52 — fix(marketing): production copy + brand-kit operator precedence + caption fallback

Three regressions introduced in v0.1.3.49 (Phase A image generation) are fixed.

**Regression 1 — Production stage dropped content_package[] (empty captions) (`backend/marketing/ports/hermes.ts`, `backend/social-content/workflow-request.ts`)**

The PRODUCTION STAGE EXECUTION CONTRACT clause in `buildHermesInstructions()` stated "Returning content_package without artifacts.creative_assets is a violation". The LLM read this as either/or and returned images but dropped post copy entirely, causing blank captions on FB/IG. The clause is rewritten to require BOTH artifacts:
- `content_package[]` — one entry per post with: `post_number`, `theme`, `hook`, `body`, `cta`, `hashtags` (array of 3-6 tags), `platforms`, `format`, `visual_prompt`.
- `artifacts.creative_assets[]` — one generated image per post.

The clause now states explicitly: "You MUST return content_package AND artifacts.creative_assets. One without the other is incomplete." Applied to both the weekly social-content branch and the generic branch. The same output contract block in `buildProductionResumeContext()` is extended to describe both required sections including the content_package schema with hashtags.

**Regression 2 — Brand enrichment overrode operator-supplied styleVibe (`backend/marketing/brand-kit-enrich.ts`, `backend/marketing/brand-kit.ts`, `backend/social-content/workflow-request.ts`)**

`ARIES_BRAND_ENRICHMENT_ENABLED=1` LLM enrichment was overwriting `style_vibe` and `tone_of_voice` in brand-kit.json even when the operator had explicitly provided `styleVibe` and `brandVoice` in the campaign request. Fixed by adding `OperatorBrandKitOverrides` to `applyBrandKitEnrichment()` with precedence: operator request > existing brand kit > LLM enrichment. `extractEnrichAndSaveTenantBrandKit()` accepts optional `operatorOverrides`. `ensureFreshBrandKitForWeeklyRun()` extracts `styleVibe`/`brandVoice` from the doc's request and threads them through. Enrichment only fills fields the operator left blank.

**Regression 3 — Publish handlers posted empty captions when social-copy.json absent (`app/api/marketing/jobs/[jobId]/publish-facebook/handler.ts`, `publish-instagram/handler.ts`)**

When `ARIES_SOCIAL_COPY_FINALIZE_ENABLED=0` (the current production default), `loadSocialCopyArtifact()` returns null and the handler had no further fallback, posting empty captions. Both handlers now fall back to `runtimeDoc.stages.production.primary_output.content_package[]`: pick the post matching the platform (`platforms` array), fall back to first post, build caption as `${hook}\n\n${body}\n\n${cta}` + hashtags joined with spaces. social-copy.json remains the first-choice path.

Tests: `tests/marketing/build-hermes-instructions.test.ts` extended with 10 new assertions for `content_package`, `creative_assets`, and `hashtags` in both contract branches. New `tests/marketing/brand-kit-operator-precedence.test.ts` (10 tests). New `tests/marketing/publish-handler-caption-fallback.test.ts` (11 tests).

## v0.1.3.51 — fix(publishing): posts.caption column name + per-platform approval consumption

Two downstream bugs that blocked the final FB+IG publish step for multi-platform campaigns:

**Bug 1 — Schema mismatch in publish-verification (`backend/integrations/publish-verification.ts`)**
The INSERT statement referenced a `content` column that does not exist in the `posts` table; the correct column is `caption`. This caused the SQL write to fail after a successful Meta API publish, and the catch block in the publish handlers masked the error as `publish_failed`. Fixed by renaming the column reference and updating the `PersistPublishedPostArgs` type accordingly. Also added `job_id` to the INSERT (previously NULL) so posts can be correlated back to their marketing job.

**Bug 2 — Approval consumed by first platform, blocking second (`publish-facebook/handler.ts`, `publish-instagram/handler.ts`)**
A single `publish`-stage approval is synthesized for multi-platform campaigns. Both platform handlers consumed the approval wholesale (`record.status = 'consumed'`), so whichever ran second returned `publish_requires_approval`. Fixed using Option A (per-platform tracking): added `consumed_platforms: string[]` to `MarketingApprovalRecord`. Each platform handler now checks and appends its own platform key. The record status is flipped to `consumed` only when all platforms from `publish_config.live_publish_platforms` have been registered. Existing records without this field are backfilled to `[]` in `normalizeMarketingApprovalRecord`.

**Additional**: idempotency keys in the posts INSERT now include the platform (`mkt_<job>:publish:<platform>:1`) so FB and IG rows never collide on the UNIQUE constraint.

Tests: `tests/publish-verification.test.ts` updated for renamed fields; new `tests/marketing/publish-approval-consumption.test.ts` covers per-platform accumulation, final consumption, duplicate-platform rejection, and legacy-record backfill.

## v0.1.3.50 — fix(marketing): ingest production creative_assets into DB + workspace view

Phase A (v0.1.3.49 / PR #385) shipped image_generate so the production stage now calls Hermes and writes PNGs to disk. However, no code path read `doc.stages.production.primary_output.artifacts.creative_assets[]` and wrote to the `creative_assets` DB table, leaving the workspace view with empty assets even when 6 PNGs were present on disk.

This release closes the ingest gap:
- New `backend/marketing/ingest-production-assets.ts` module exports `ingestProductionCreativeAssetsToDb` which reads each `creative_assets` entry, computes SHA-256, and upserts into the DB with `ON CONFLICT (tenant_id, checksum) DO NOTHING`. Sequential awaits, per-row try/catch — batch never aborts on a single bad row.
- `backend/marketing/hermes-callbacks.ts` production-completed branch calls the new ingest function before `ingestSocialContentStageMedia`. Wrapped in try/catch; callback remains idempotent.
- `backend/marketing/workspace-views.ts` `buildCampaignWorkspaceView` queries `creative_assets WHERE source_type='generated_by_aries'` after building the creative review and merges DB-backed assets into `creativeReview.assets[]` so publish handlers and the dashboard can find approved creatives.
- 6 new unit tests in `tests/marketing/ingest-production-assets.test.ts` covering SQL shape, ON CONFLICT, per-row error isolation, and empty-path skipping.

## [0.1.3.48] - 2026-05-19

### Fixed
- fix(marketing): bridge-side completing-stage detection. Hermes inconsistently emits two completing-stage shapes — transition descriptors ("research_to_strategy") for research-stage completion, and BARE current-stage names ("strategy" when strategy run finishes) for strategy-stage completion. v0.1.3.47 handled the transition descriptor case in the pre-filter, but the bare-current-stage case still hit `approval_stage_mismatch` (validator wants the NEXT stage, not the current one). v0.1.3.48 adds a second-pass mapping in `buildBridgeCallbackPayload` where we know the current `run.stage`: when `approval.stage === run.stage`, remap via the completing→next table. Pre-filter still handles transition descriptors; bridge is now the per-run-stage disambiguator. Tests extended from 15 → 21 cases covering both Hermes emission shapes per stage transition. Verified against tenant-15 campaign mkt_0029a41b — research → strategy advance worked (v0.1.3.47); strategy → production blocked by this issue.

## [0.1.3.47] - 2026-05-19

### Fixed
- fix(marketing): move all `approval.stage` normalization into the single pre-filter at `workflowOutputFromRunRecord`, where the actual mangling was happening. v0.1.3.43 and v0.1.3.46 patched the wrong layer (`buildBridgeCallbackPayload`) and never actually fired end-to-end because an earlier defensive default-to-`"production"` fallback in `workflowOutputFromRunRecord` (existed since well before v0.1.3.43) was silently mapping anything outside `{plan, creative, video, publish, strategy, production}` to `"production"` — turning both the transition descriptor `"research_to_strategy"` and the bare completing-stage `"research"` into `"production"` before the bridge's normalization ever ran. The bridge then mapped `"production"` → `"publish"` via its completing→next map, and `validateApprovalTransition` rejected with `approval_stage_mismatch` for every brand_campaign / marketing_pipeline job since the regression landed. v0.1.3.47 puts the full normalization at the chokepoint: parse `X_to_Y` first, then accept canonical next-stage names, then fall back through the completing→next map, then default to `"production"` only for truly unknown shapes. Bridge reverts to a pass-through (no double-mapping). Confirmed against tenant-15 campaigns `mkt_43800cee`, `mkt_a8c03f06`, `mkt_34a16faf` (same root cause). Tests updated from 12 → 15 cases covering canonical pass-through, transition parsing, completing-stage mapping, and unknown-stage defense. Long-term fix remains Hermes adopting the v0.1.3.45 shared protocol package so the wire shape is enforced by Zod.

## [0.1.3.46] - 2026-05-19

### Fixed
- fix(marketing): extend `approval.stage` normalization in `buildBridgeCallbackPayload` to handle transition-descriptor shape (`"research_to_strategy"`, `"strategy_to_production"`, `"strategy_to_creative"`, `"production_to_publish"`). v0.1.3.43 closed the bare-completing-stage path (`"research"` → `"strategy"`) but Hermes actually emits the transition descriptor `"X_to_Y"` in prod (verified against `/v1/runs/run_8379acbd1c524b6f89eb066ef77dea80` output on tenant-15 campaign `mkt_a8c03f06-3b86-4557-a442-50996907d741`). That shape wasn't in v0.1.3.43's `COMPLETING_TO_NEXT_STAGE` map, fell through unchanged, and `validateApprovalTransition` rejected with `approval_stage_mismatch` — same symptom as the original v0.1.3.43 incident, different root cause. Fix anchors a `^[a-z][a-z0-9]*_to_([a-z][a-z0-9]*)$` regex ahead of the existing map: transition descriptors get parsed to their next-stage capture group; bare completing-stage names still hit the v0.1.3.43 map; unknown shapes still pass through unchanged. Test file extended from 6 → 12 cases covering all three known emission shapes plus malformed-input defenses (trailing underscore, uppercase, undefined). Social-content-weekly still bypasses this path via its `approvalStep`-based allowlist. Long-term fix remains Hermes adopting the v0.1.3.45 shared protocol package so the wire shape is enforced by Zod, not by a regex shim.

## [0.1.3.45] - 2026-05-19

### Added
- feat(admin): marketing job debug panel at `/admin/marketing/jobs/[jobId]/debug`. Server-rendered Next.js page gated to `tenant_admin` role. Surfaces full job state, per-stage timeline (status, started/ended UTC with local tooltip, duration, Hermes run ID, errors), Aries↔Hermes run-ID mapping table, expandable JSON viewers for submission input/hermes output/approval records per stage, "Copy curl" button per stage generating a reproduction command for Hermes `/v1/runs`, admin-gated "Retry Stage" button with confirm modal for research/strategy/production stages (publish blocked — irreversible), and a gateway ping button. Backed by two new internal routes: `GET /api/internal/admin/marketing/jobs/[jobId]/state` (full state dump including execution runs and approval records, tokens stripped) and `POST /api/internal/admin/marketing/jobs/[jobId]/stages/[stage]/retry` (re-submits a stage via the execution port). Strict tenant isolation on all paths — job not found returns 404 (not 403) for cross-tenant probes. `INTERNAL_API_SECRET` is never leaked to the browser; curl reproduction uses the env-var name as a placeholder. Adds `tests/admin-marketing-debug-route.test.ts` covering: route exports, fixture job shape, curl command secret redaction, approval record listing.
- feat(protocol): shared `@aries/hermes-protocol` package (`packages/aries-hermes-protocol/`) containing Zod schemas + TypeScript types for the Aries ↔ Hermes wire format. `PROTOCOL_VERSION = "1.1.0"`. `approval.stage` next-stage-to-gate convention encoded as `ApprovalStageSchema`. `protocol_version` is required (semver-validated) on submission payloads and optional-but-validated on inbound callbacks; major-version mismatches rejected fail-loud. `stopped` status added to `CallbackStatusSchema` (maps to `cancelled` internally). `submitRawRun` injects `protocol_version` at the chokepoint so no caller can accidentally omit it. Drift gate (`scripts/validate-protocol-drift.mjs`, wired into `npm run lint`) asserts: no inline type redeclarations in `backend/`, `HermesRunCallbackPayloadSchema.safeParse()` is called at runtime, no inline validator-shaped functions bypass Zod. 20 tests pass.

## [0.1.3.43] - 2026-05-19

### Fixed
- fix(marketing): normalize `approval.stage` from completing-stage → next-stage convention at the Hermes port boundary. Hermes emits `output.approval.stage` as the stage that just finished (e.g. `"research"` when research completes and pauses for strategy approval); Aries' `validateApprovalTransition` expects the stage gate to open (e.g. `"strategy"`). Without this normalization every `brand_campaign` / `marketing_pipeline` job hit `approval_stage_mismatch`, the run_id was never stored, and the stale-run reaper killed the job at +600 s. Confirmed root cause for 5+ failed_stale campaigns on tenant-15 today (affected jobs: `mkt_43800cee`, `mkt_89bec5df`, `mkt_2d92adff`, `mkt_ac24a07a`). Fix is a single normalization map (`research→strategy`, `strategy→production`, `production→publish`; terminal `publish` and unknown stages pass through unchanged) applied in `buildBridgeCallbackPayload` before constructing the approval object. Social-content-weekly is unaffected — it uses a separate `approvalStep`-based allowlist path in the validator. Recovery: failed_stale jobs are unrecoverable (run_id was never stored); Brendan should resubmit fresh campaigns — they will succeed with this fix.

## [0.1.3.42] - 2026-05-19

### Added
- feat(integrations): reconnect flow for Meta scope upgrades — detects connected Facebook integrations whose stored `granted_scopes` are missing `pages_show_list` (the new wider scope set from v0.1.3.37) and surfaces a yellow "Update permissions" badge on the integrations card. Clicking opens a confirmation dialog then redirects through the standard OAuth broker with `auth_type=reauthenticate` so Facebook forces full re-consent rather than a silent token link. The callback re-runs page discovery so the user can confirm or switch their connected Page. Badge clears once the new scopes are stored.

## [0.1.3.41] - 2026-05-19

### Added
- feat(tests): end-to-end Meta publish smoke test (`scripts/smoke-meta-publish.ts`, `npm run smoke:meta-publish`). Accepts `--tenant <id>`, `--provider instagram|facebook`, and `--dry-run` flags. Resolves a recent approved creative from runtime state, mints a signed public media URL, probes URL reachability without auth, then calls the publish route via HTTP. In `--dry-run` mode stops before the actual Meta Graph call and emits the full payload for inspection. Includes unit tests for payload-builder helpers (`tests/smoke-meta-publish.test.ts`).

## [0.1.3.40] - 2026-05-19

### Added
- feat(publishing): failure-state UX and retry for Meta publish — maps Meta API error codes to user-facing messages in the Instagram publish drawer (token expired → "Reconnect Meta to publish"; rate limit → "Try again in a moment"; page permission revoked → "Re-authorize Meta"; media unreachable → "Try regenerating creative"; caption policy violation → edit hint). Raw Meta error codes are never exposed to users. Transient errors (rate-limit, 5xx, network) surface a Retry button in the drawer; token/permission errors surface a "Reconnect Meta" link to `/oauth/connect/instagram?mode=reconnect`. After the drawer closes on error, a persistent banner on the post card shows "Last attempt failed: <reason> · Retry · Dismiss" so the user can recover without reopening the drawer. Publish handler now returns structured `{code, message, retryable, retryAfterSeconds}` error objects instead of generic 500s.

## [0.1.3.39] - 2026-05-19

### Added
- feat(publishing): cron-driven scheduled-posts worker that drains the `scheduled_posts` table every minute, dispatching due rows to the Meta publish pipeline via an internal auth-gated route. Adds `dispatch_status`, `dispatched_at`, `error_at`, `error_message` columns to `scheduled_posts` with a partial index on pending rows. Retries once on transient 5xx/network errors; permanently fails on 4xx (token revoked, page deleted). Idempotent — uses `SELECT ... FOR UPDATE SKIP LOCKED` to prevent double-dispatch across parallel worker instances.

## [0.1.3.38] - 2026-05-19

### Added
- feat(publishing): immediate Facebook Page publish UI — "Publish to Facebook" button on launch-ready publish items with `platform=facebook`, `FacebookPublishDrawer` component, and `POST /api/marketing/jobs/[jobId]/publish-facebook` server route that resolves caption from social-copy.json `facebook_feed` channel, signs the approved creative image URL via the public media proxy, and publishes directly to Meta Graph API with `provider=facebook`.

## [0.1.3.37] - 2026-05-19

### Fixed
- fix(integrations): request the Page-listing and Instagram-publish scopes during Meta OAuth so `/me/accounts` actually returns the user's Pages. Was failing with `meta_no_pages_available` because only `pages_manage_posts` was requested, and `/me/accounts` requires `pages_show_list` to enumerate Pages. Adds `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `business_management`, `instagram_basic`, `instagram_content_publish` to the Facebook provider's default scopes; aligns Instagram provider scopes for the co-provisioned IG-via-FB connection. Permissions are already enabled in the Meta app (Standard Access for app admins/testers); no App Review required for current admin tenants.

## [0.1.3.36] - 2026-05-19

### Added
- feat(publishing): immediate Instagram publish UI — "Publish to Instagram" button on launch-ready publish items, `InstagramPublishDrawer` component, and `POST /api/marketing/jobs/[jobId]/publish-instagram` server route that resolves caption from social-copy.json, signs the approved creative image URL via the v0.1.3.35 public media proxy, and publishes directly to Meta Graph API.

## [0.1.3.35] - 2026-05-19

### Added
- feat(publishing): HMAC-signed short-lived public media proxy so Meta Graph API (esp. Instagram) can fetch creative images during publish dispatch.

## [0.1.3.34] - 2026-05-19

### Added
- feat(marketing): badge campaigns generated with a previous brand-kit version on the campaign list.

## [0.1.3.33] - 2026-05-19

### Added
- feat(integrations): surface connected Facebook Page name + Switch page button on integrations card.

## [0.1.3.32] - 2026-05-18

### Fixed
- fix(social-content): manual new-job form defaults to 6 image creatives, matching backend default (was 2).

## [0.1.3.31] - 2026-05-18

### Fixed
- **`resolveMarketingApproval` now records `state='failed'` on gateway errors.** Regression from be82ed8 (v0.1.3.0): the catch path returned `{status:'error'}` for clean 4xx handling but dropped the `recordFailure` call, leaving the runtime doc stuck in `'running'` on gateway errors. Re-adds `recordFailure(doc, checkpoint.stage, error)` before the structured-error return so the legacy-openclaw path correctly persists failed state.

## [0.1.3.30] - 2026-05-18

### Changed
- **`MarketingExecutionPort` now exposes a public `submitRawRun()` surface** alongside `getCallbackUrl()` and `getSessionKey()`. `submitSocialCopyFinalizeRun` in the orchestrator calls `port.submitRawRun()` instead of duck-typing into private `HermesMarketingPort` internals (`gatewayUrl`, `authHeader`, `fetchImpl`, `sessionKey`, `persistCallbackTokenHash`, `runPollBridge`). All existing behavior — callback token hashing, idempotency keys, gateway error handling, poll-bridge kickoff — is preserved unchanged.

### Added
- `tests/marketing/marketing-execution-port-submit-run.test.ts` — covers `getCallbackUrl`, `getSessionKey`, and `submitRawRun` for both `social_content_weekly` and `social_copy_finalize` workflow keys, plus error paths (gateway unreachable, HTTP 4xx, missing config).

## [0.1.3.29] - 2026-05-18

### Added
- **Social-copy finalize pipeline stage** (feature-flagged, default-OFF via `ARIES_SOCIAL_COPY_FINALIZE_ENABLED`). After image creatives are approved and before video stages, a new `social_copy_finalize` Hermes workflow receives generated images, brand kit, and onboarding marketing focus and returns image-aware captions, hashtags, and CTAs per post. Results surface on `MarketingDashboardPost` (caption/hashtags/cta/copyWarnings) and render in `DashboardPostCard` and `DashboardAssetCard` (reverse-lookup via relatedPostIds). Caption validator enforces per-platform character caps; one retry on invalid responses with constraint feedback; partial results preserved on transient failure so a resume picks up where it left off.
- `backend/social-content/social-copy-store.ts` — atomic per-post write with merge preservation for resume idempotency.
- `backend/social-content/copy-finalize-request.ts` — Hermes workflow request builder (`SOCIAL_COPY_FINALIZE_WORKFLOW_KEY`).
- `backend/social-content/copy-finalize-handler.ts` — handler with caption validator and retry logic.

### Changed
- **DRY refactor:** extracted `backend/social-content/brand-kit-payload.ts` shared helper; `buildSocialContentWeeklyRequest` and `buildProductionResumeContext` now both call it. Closes the pattern that caused v0.1.3.25's silent field-drop on `MarketingBrandKitReference` growth. Byte-shape regression tests in `tests/social-content/brand-kit-payload.test.ts` confirm no behavior change.

### Notes
- Hermes-side workflow `social_copy_finalize` registration and LLM quality eval are prereqs before flipping the flag to `1` in `docker-compose.yml`. The PR ships the Aries-side wiring, UI, and tests only.

## [0.1.3.28] - 2026-05-18

### Fixed
- **Social-content status page now renders all image previews, not just the first 4.** The Assets, Posts, and Publish-queue columns in `frontend/marketing/job-status.tsx` each applied a hardcoded `slice(0, 4)` cap before mapping to card components. At `image_creative_count: 3` this was invisible; after the v0.1.3.27 bump to 6, two creatives were silently dropped from the visible list. The cap is removed — all items from the backend are now rendered. The grid layout scrolls naturally for any count.

## [0.1.3.27] - 2026-05-17

### Fixed
- **`DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount` in `backend/social-content/types.ts` was still 3 after v0.1.3.26, so the UI-side normalize step (`normalizeWeeklySocialContentPayload` in `payload.ts:158-161`) baked 3 into the saved job doc before the workflow-side `SOCIAL_CONTENT_DEFAULT_SCOPE` ever got consulted.** Verified live on hermes-dev / tenant 16 with job `mkt_ee5b212a-8c34-4b0f-8a54-3151c150e644`: dashboard rendered 3 image creatives, Hermes payload had `scope.image_creative_count: 3` and `media_requests[0].count: 3` — both defaults must track together. Bumps `types.ts:DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount` from 3 → 6 to match `defaults.ts:SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count` so a UI-triggered weekly run with no explicit count actually delivers 6 creatives per the 7-post weekly framing.

## [0.1.3.26] - 2026-05-17

### Changed
- **Weekly social-content runs now generate 6 image creatives by default (was 3), one per static post.** `static_post_count: 7` minus the 1 video script slot leaves 6 static posts that need imagery — the prior default of 3 underdelivered, leaving 4 of the 7 posts without a matching creative. The hard cap also moves from 3 to 6 so operator-supplied `imageCreativeCount: 9` no longer silently clamps to 3. Per-tenant Hermes/Veo image budget doubles (3→6 per weekly run); at 50 tenants this is 300 images/week vs 150. Hermes production-stage tool policy has no per-call cap, so no Hermes prompt change is needed.
- **DRY: `MAX_IMAGE_CREATIVE_COUNT` and `MAX_VIDEO_RENDER_COUNT` now live in `backend/social-content/defaults.ts`** as `SOCIAL_CONTENT_MAX_IMAGE_CREATIVE_COUNT` / `SOCIAL_CONTENT_MAX_VIDEO_RENDER_COUNT`. `payload.ts` and `workflow-request.ts` import the shared constants instead of redefining their own — future cap changes are a one-line edit, not three.

## [0.1.3.25] - 2026-05-17

### Fixed
- **Enrichment fields now win over stale onboarding-derived `req.X` values in Hermes payload builders.** v0.1.3.23 wired `brandKit.style_vibe`, `brandKit.tone_of_voice`, and `brandKit.brand_voice_summary` into the Hermes payload with "operator override wins" semantics, but `req.styleVibe` and `req.brandVoice` are pre-populated at onboarding from heuristic fallbacks (e.g. `"Balanced and professional with neutral clarity"`) rather than operator input — so the stale fallbacks were stomping the LLM-derived signal. Inverted priority for these two fields: enrichment wins when non-null; `req.X` falls back only when enrichment is absent. `tone_of_voice` now always appends as a `Tone: <list>.` suffix when present, even alongside an operator-set voice. Surfaced by post-deploy verification on the hermes-dev / alecferrismusic.com sparse-profile tenant.

## [0.1.3.24] - 2026-05-17

### Changed
- **Enable `ARIES_BRAND_ENRICHMENT_ENABLED` by default in `docker-compose.yml`.** The enrichment plumbing shipped in v0.1.3.23 was env-gated OFF for safe rollout; this flips the default to ON so the weekly social-content workflow and URL-preview route persist LLM-derived `positioning`, `audience`, `tone_of_voice`, and `style_vibe` to `brand-kit.json`. Set `ARIES_BRAND_ENRICHMENT_ENABLED=0` in your environment to disable.

## [0.1.3.23] - 2026-05-17

### Added
- **Enrichment fields from `enrichBrandKitWithGemini` now persist to `brand-kit.json` and flow into the Hermes weekly social-content payload.** Previously the LLM-generated `positioning`, `audience`, `tone_of_voice`, and `style_vibe` fields were computed for the URL-preview card and immediately discarded — the weekly run re-scraped from scratch each time and sent Hermes only the HTML-derived `brand_voice_summary` and `offer_summary`. Four new `string | null` fields on `TenantBrandKit` and `MarketingBrandKitReference` give the enrichment a persistent home.
- **`extractEnrichAndSaveTenantBrandKit` wrapper** in `backend/marketing/brand-kit.ts`: fast path reuses a fresh, already-enriched kit (skipping the LLM call); slow path scrapes, enriches, and persists. Both the `ensureFreshBrandKitForWeeklyRun` weekly kick-off and the `url-preview` route now call this wrapper, so the preview card and the Hermes payload read from the same persisted source.
- **`applyBrandKitEnrichment`** pure merge helper in `backend/marketing/brand-kit-enrich.ts`: enrichment wins per-field when present, null-coalesces to base otherwise.
- **`marketingBrandKitReferenceFromTenantBrandKit`** exported helper in `backend/marketing/runtime-state.ts`: DRYs the three previous inline `MarketingBrandKitReference` literal builders in `orchestrator.ts`, `runtime-state.ts`, and `workflow-request.ts` into one call site that auto-includes any future `TenantBrandKit` additions.

### Changed
- **Hermes weekly payload now carries enrichment-derived brand signals.** `resolveBrandStyleVibe` (new) and `resolveBrandAudience` (new) feed `brand.style_vibe` and `objective.audience` from the persisted brand kit, with operator-note fields winning when set. `resolveBrandVoice` (updated) appends a `"Tone: <tone_of_voice>."` suffix when both voice and tone are present from the kit; operator-supplied `brandVoice` skips the suffix entirely. `resolveBrandOffer` (fixed) now passes `brandKit.positioning` as the positioning argument instead of reusing `offer_summary` as a surrogate.
- **`backward-compat`** `normalizePersistedBrandKit` defaults all four new fields to `null` when loading old `brand-kit.json` files that predate this release — no migration step required.

## [0.1.3.22] - 2026-05-17

### Fixed
- **Hermes research-stage agent looped on local-workspace tools until 600s timeout.** The `instructions()` prompt in `backend/marketing/ports/hermes.ts` did not enumerate allowed or forbidden tools, so the research agent — even after successfully scraping the brand URL and running web searches — frequently looped on `read_file`, `search_files`, and `terminal` until the `did not reach a terminal status` timeout fired. Added an explicit tool policy forbidding `read_file`, `search_files`, `write_file`, and `execute_code`, plus a 6-total-tool-call cap, to both the weekly social-content block and the generic block. A snapshot test now asserts the forbid clause is present in both branches of `buildHermesInstructions`. PR #351 patched the median symptom (thin payloads sending less context); this stops the underlying agent-loop class that persisted even with a rich payload.

## [0.1.3.21] - 2026-05-17

### Changed
- **CLAUDE.md cleanup.** Dropped the stale `## Protected Systems: OpenClaw is Brendan-only` directive — OpenClaw was removed and replaced by Hermes; the line misled past agents researching gateway config.

## [0.1.3.20] - 2026-05-17

### Changed
- **Tenants with sparse brand profile fields now keep working when the Hermes research stage runs.** Tenants whose Business Profile leaves `notes` blank (the minimum-config path through onboarding) previously sent Hermes a thin request — no `brand.notes` field at all and an inline `brand.name` fallback to `brand_kit.brand_name` that worked but wasn't centrally documented. With a thin payload, the research agent scraped the site successfully then looped on `read_file`/`search_files`/`terminal` tool calls until the 600s `did not reach a terminal status` timeout fired. Two new `resolve*` helpers in `backend/social-content/workflow-request.ts` close the gap: `resolveBusinessName` formalizes the existing brand-kit fallback into a named helper, and the new `resolveNotes` falls back to a 300-char-truncated `brand_voice_summary` when operator notes are null. A new `notes: string` field on `SocialContentWeeklyBrandPayload` carries the fallback into the request payload Hermes serializes as part of its prompt. Operator-supplied values still win when present.

- **`SOCIAL_CONTENT_WEEKLY_WORKFLOW_VERSION` bumped to `v2`.** The Hermes idempotency key (`generateIdempotencyKey(ariesRunId, workflow_version, tenantId)`) does not include a payload hash. Without a version bump, the same `ariesRunId` retried after this fallback change could have served a stale pre-fallback cached result. The version bump invalidates the cache so the new fallback path actually exercises on retry.

## [0.1.3.19] - 2026-05-16

### Fixed
- **Hermes media route 404 on legitimate tenant-owned image creatives.** `/api/internal/hermes/media/<basename>` checks tenant ownership via `tenantOwnsHermesMediaBasename`, which previously walked ONLY `social_content_runtime.stages[X].output.weekly_content_plan.image_creatives`. When auto-approve fires on the production→publish gate, the social-content runtime stages get overwritten with the resume-context payload (NOT the production result), so the bridged image_creatives live only in `doc.stages[stage].primary_output` (marketing-side). Ownership check returned false, route returned 404, dashboard <img> tags rendered as broken. Mirrors the v0.1.3.16 dashboard projection fallback. Adds `marketingStagesContainBasename` that walks `doc.stages[stage].primary_output.weekly_content_plan.image_creatives` as a secondary ownership source.

## [0.1.3.18] - 2026-05-16

### Fixed
- **Hardcoded `Math.min(2, ...)` cap in `weeklyMediaDemand` overrode the default image_creative_count and pinned every weekly run to 2 images.** `backend/marketing/orchestrator.ts:273` ignored both the v0.1.3.17 default bump (3) and any tenant-side override, because the outer clamp was `Math.min(2, integerPayloadValue(...))`. Net result: dashboard `imageAds` could never exceed 2 regardless of config. Fix: replace the literal `2` with `SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count` so the orchestrator clamp tracks the defaults module as the single source of truth.

## [0.1.3.17] - 2026-05-16

### Changed
- **Default weekly image creative count: 2 → 3.** `SOCIAL_CONTENT_DEFAULT_SCOPE.image_creative_count` and `DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount` both bumped from 2 to 3. `MAX_IMAGE_CREATIVE_COUNT` in `payload.ts` and `workflow-request.ts` also raised to 3 to match. The autonomous goal-loop verifier expects ≥ 3 image creatives per weekly run; the previous default of 2 left every clean autonomous run one short. All asserting tests updated (5 sites across `marketing-execution-port.test.ts` and `social-content-weekly-defaults.test.ts`).

### Fixed
- **Publish stage left with `completed_at: null` on every publish-skip run.** When publishing is disabled (Meta not connected), the existing publish-skip branch in `applyHermesMarketingCallback` sets `doc.state = 'completed'` but never marked the publish stage record itself complete. Downstream consumers expecting a populated `stages.publish.completed_at` (audit-trail UI, the goal-loop hook) saw null and treated the run as incomplete. Fix: when the publish-skip branch fires, set `publish.status = 'completed'`, `publish.completed_at = now`, `started_at = now` if missing, and a one-line summary `"Publish skipped: publishing not requested."`. Idempotent — only fires when status isn't already `completed`.

## [0.1.3.16] - 2026-05-16

### Fixed
- **Dashboard `Generated assets` count stuck at 0 even when Hermes generated image creatives on disk.** Today's autonomous E2E (`mkt_d6817de2`, v0.1.3.15) completed all 4 stages cleanly with 2 generated images cached at `~/.hermes/cache/images/*.png` and bridged correctly into `doc.stages.production.primary_output.weekly_content_plan.image_creatives`. But the dashboard still showed `Generated assets: 0` / `imageAds: 0` because `latestSocialProjection` (`backend/social-content/dashboard-projection.ts:255`) read ONLY from `social_content_runtime.stages[X].output` — and those slots end up with the resume-context payload (not the production result) after auto-approve fires on the production → publish gate (`workflow_step_id: approve_image_creatives`). The marketing-side bridge writes the canonical `weekly_content_plan.image_creatives` into `doc.stages[stage].primary_output` via `markStageCompleted`, but the social-content-runtime side gets overwritten by the next callback's context.

  Fix: `latestSocialProjection` now also walks `runtimeDoc.stage_order` and parses each `doc.stages[stage].primary_output` via `parseSocialContentWorkflowOutput`, filling any field the social-content runtime didn't supply. The runtime stays the primary source — the marketing-side stages are a strict fallback used only for fields the runtime left empty. Defensive guards: `Array.isArray(runtimeDoc.stage_order)` and `runtimeDoc.stages?.[marketingStage]` so test fixtures without these keys still work.

## [0.1.3.15] - 2026-05-16

### Added
- **Autonomous-mode auto-approve for the weekly marketing pipeline.** When Hermes emits `requires_approval` for the strategy / production / publish gates and the new `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1` flag is set (default ON in `docker-compose.yml`), Aries synthesizes an `ai-orchestrator` approval directly from `applyHermesMarketingCallback`. Same code path a UI click would take — same `approveMarketingJob` → `resolveMarketingApproval` → `finalizeStrategyAndRunProductionReview` resume chain — just triggered from inside the callback instead of from `app/api/marketing/jobs/[jobId]/approve`. Closes the autonomous E2E loop introduced when v0.1.3.14's `maybeAutoAdvanceNextStage` only covered the `status:completed` Hermes path; today's run `mkt_ac24a07a` came back with `requires_approval` and stalled at the 5-min stale-run-reaper threshold because no Aries-side mechanism resolved the checkpoint.

  Reentrancy verified safe: `withExecutionRunLock` is keyed on `aries_run_id` (`run-store.ts:271`); `port.resumePipeline()` creates a new run record before submitting (`ports/hermes.ts:309`), so the next-stage callback acquires a different lock. `withMarketingApprovalLock` (`approval-store.ts:338`) plus the in-lock record re-read at `orchestrator.ts:1823` keeps a parallel UI click safe — auto-approve treats `approval_not_available` and `approval_resolution_in_progress` returns as benign no-ops. Failure path appends to history and logs `auto_approve_failed` / `auto_approve_threw`; it does NOT call `recordStageFailure` on the awaiting-approval stage, because `resolveMarketingApproval`'s catch already restores the checkpoint via `restoreApprovalCheckpointAfterFailure` (`orchestrator.ts:2070-2103`) — adding stage failure would conflict and strand the doc. The reaper is the catch-all if auto-approve genuinely cannot resolve the gate.

  9 unit tests in `tests/marketing/callback-auto-approve.test.ts`: flag-off default, strategy and production auto-approve, publish-skip no-op, approve-throws path, both idempotent error paths (`approval_not_available`, `approval_resolution_in_progress`), missing-checkpoint guard, missing-tenant guard. Plan + opus eng review (verdict APPROVED_WITH_CHANGES, all 5 required changes applied) saved in `plans/marketing-auto-approve.md`.

## [0.1.3.14] - 2026-05-16

### Fixed
- **Marketing pipeline stalled at research when Hermes returned `status:completed` without `requires_approval` (no progression to strategy).** Today's live E2E (`mkt_89bec5df`, v0.1.3.13) completed research cleanly at 10:53:54 UTC and never started strategy. The orchestrator's stage-advance path lives only in the approval-resume code (`finalizeStrategyAndRunProductionReview` et al.), which throws `missing_*_resume_token` when called without an approval token. With no approval emitted and no auto-advance path, the runtime state file stuck at `running/research/completed` until the stale-run reaper killed it 12.85 min later. Root cause traced to `backend/marketing/hermes-callbacks.ts:937` `markJobCompleted` — it only flips `doc.state` to `completed` when `stage === 'publish'`; non-publish stages get marked complete with no follow-on action.

  Fix: defense-in-depth on the Aries side so the pipeline survives Hermes returning either `requires_approval` (existing path) OR `completed` without approval (new path).

  - **New port verb `MarketingExecutionPort.submitNextStage`** alongside `runPipeline` and `resumePipeline`. Submits the next stage as a fresh run (creates a new `ExecutionRunRecord`), not a resume — bypasses the resume-token requirement.
  - **New helper `maybeAutoAdvanceNextStage`** in `hermes-callbacks.ts`. Fires inside the `payload.status === 'completed'` branch when (a) stage in {research, strategy, production}, (b) no approval payload present, (c) next stage status == `not_started`, (d) doc not terminal, (e) `doc.tenant_id` present. Marks next stage `in_progress` + `started_at` + saves doc **before** submitting so any racing callback or retry sees a non-`not_started` status. On submission failure, records `auto_advance_submit_failed` to the doc and logs structured error.
  - **Hermes payload prefix** — `submissionPayload` injects `Starting stage: ${stage}` into the prompt and `auto_advance: true` into `callback_context` when the submission carries a `starting_stage` argument, so Hermes targets the requested stage rather than restarting from research.
  - **Test coverage** — 9 unit tests in `tests/marketing/callback-auto-advance.test.ts` cover all 6 documented risks from the planning doc (R1 double-submit, R2 multi-stage payload, R3 publish-skip flow, R4 publish-no-op guard, R5 idempotency, R6 missing-resume-token path) plus M1 (tenant context propagation), M4 (try/catch with `auto_advance_submit_failed`), and submit-throws failure path.

  Plan + two-pass review (sonnet eng-review + opus architectural review picking Option A over Option B) recorded in `plans/aries-stage-auto-advance.md`. All gates green: `npm run verify`, `npm run validate:execution-provider` (51 tests), `npm run validate:social-content` (91 tests).

## [0.1.3.13] - 2026-05-16

### Fixed
- **Stale-run reaper cron was never installed (PR #334 follow-up).** PR #334 shipped `scripts/reap-stale-runs.ts` and added `aries-marketing-stale-run-reaper` to the OpenClaw cron manifest, but `npm run automation:install` was never run post-merge, and there is no traditional Linux cron inside the container (`crontab: executable file not found in $PATH`). The manifest's install path calls `openclaw cron add`, which is not available in the container runtime at all. A 30-minute window confirmed zero reaper log lines while a stuck job (mkt_2d92adff) sat past the 10-min research threshold — manual `docker exec ... reap-stale-runs.ts --apply` reaped it immediately, proving the script works but the trigger was absent.

  Fix: mirrors the existing `partner-attribution-outbox-worker` pattern. A new in-process side-process `scripts/stale-run-reaper-worker.ts` is spawned by `scripts/start-runtime.mjs` (both cluster and single-node paths) when `ARIES_REAPER_ENABLED=1`. `docker-compose.yml` defaults `ARIES_REAPER_ENABLED=1` and `ARIES_REAPER_INTERVAL_MS=300000` (5 min), matching the manifest's `*/5 * * * *` schedule. The worker calls `runStaleRunReaper({ dataRoot, dryRun: false })` on each tick and logs `[stale-run-reaper]` lines only when jobs are reaped or errors occur. Shutdown is clean: SIGTERM to the worker on SIGINT/SIGTERM to the primary process.

## [0.1.3.12] - 2026-05-16

### Fixed

- **Stage-gated PNG path fallback for production callbacks (no Stage 1→2 regression).** The schema-agnostic PNG path harvester (`harvestPngPathsRecursively`) and supporting helpers (`isHermesCacheImagePath`, `buildCreativesFromPngFallback`) are re-introduced from PR #341, but now gated strictly to `stage === 'production'` via a new `stage` parameter on `bridgeHermesCreativeAssets`. Research, strategy, and publish callbacks bypass the fallback walker entirely. This eliminates the regression vector from PR #341: a research callback containing competitor screenshot URLs or other image-like strings in `cache/images`-looking paths could match `isHermesCacheImagePath` and inject phantom `image_creatives`, which disrupted the `markStageAwaitingApproval` data that drives the Stage 1→2 "Continue to brand analysis" UI card. `countRecognizedImagesInOutputRecord` also gains Shape 4 (the same walker) for the fail-loud `hermes_image_generation_unrecognized` gate — safe because that function is only called within the production-stage callback path. Live evidence: job `mkt_de108fd2-5b31-4329-9136-0230b822ae17` (v0.1.3.11) rendered two PNGs to `/home/node/.hermes/cache/images/` but the dashboard showed "Generated assets 0 / Image ads 0 / Posts 0" because the un-gated bridge on v0.1.3.11 lacked the fallback; this release restores it with the production-only gate. 11 new tests in `tests/hermes-image-projection-stage-gated.test.ts` cover all four production shapes, the regression path (research with competitor PNG URLs), strategy passthrough, publish passthrough, deduplication, and the fail-loud no-phantom assertion.

## [0.1.3.11] - 2026-05-15

### Reverted
- **Revert v0.1.3.10 PR #341 (schema-agnostic PNG path fallback)** — the fallback worked on its own but live E2E (mkt_2d92adff) showed Stage 1 → 2 UI transition stopped surfacing the "Continue to brand analysis" approval card after this PR landed. The previous run on v0.1.3.9 (mkt_10fd7f1b) successfully walked through all four stages via the UI buttons. Reverting restores Stage 1 → 2 UI behavior. The original image-projection gap (PNGs render to disk but `Generated assets 0` in workspace) returns and needs a separate forward-fix that doesn't disturb the research-callback processing path.

## [0.1.3.9] - 2026-05-15

### Added
- **Real Meta and Instagram publish dispatch (#327).** `app/api/publish/dispatch/handler.ts` now invokes the Graph API for real publishes instead of returning stub responses. Approval enforcement is hard-required: every publish dispatch must present a valid, unconsumed `marketing_approval_record` (atomic consume via DB transaction) — no approval → HTTP 403 with `publish_requires_approval`. Retry path (`app/api/publish/retry/handler.ts`) is now idempotent via a new unique index on `posts (tenant_id, platform, idempotency_key)` plus pre-Graph short-circuit when a successful post row already exists. `requestGraphJson()` (`backend/integrations/meta-publishing.ts`) retries 429s with `Retry-After` backoff (capped, bounded retry budget). Migration: `migrations/20260515120000_posts_idempotency_key.sql`. Covered by 10 new tests in `publish-dispatch-approval.test.ts`.
- **Hermes image bridge multi-schema tolerance + canonical schema in resume prompt (#337).** `bridgeHermesCreativeAssets` in `backend/marketing/hermes-callbacks.ts` now accepts THREE Hermes output shapes: legacy `image_creatives[]`, `artifacts.creative_assets[]` (May-13 working shape), and `artifacts.images[].filePath` (May-15 emerging shape). Schema variance is inherent because Hermes is a pure LLM agent with no enforced output contract. `buildProductionResumeContext` in `backend/marketing/workflow-request.ts` now shows Hermes the canonical `creative_assets` JSON schema verbatim in the resume rich-prompt — defense in depth so Hermes prefers the recognized shape. New `productionCallbackImageGenerationUnrecognized` check fails loud with code `hermes_image_generation_unrecognized` when `media_requests` count > 0 but zero recognized images surface across any known shape. 13 new tests in `hermes-image-bridge-multischema.test.ts` and `hermes-image-generation-fail-loud.test.ts`.
- **Video render artifact ingest from Hermes cache (#326).** `backend/social-content/media-ingest.ts` now ingests `social_content_weekly` video outputs into local `DATA_ROOT` mirroring the existing image-ingest pattern. Source allowlist narrowed to explicit Hermes cache dirs (`~/.hermes/cache/videos` only — not `~/.hermes` broadly) for tenant isolation. ReDoS hardening: replaced ambiguous slug regex with split anchored passes + 256-char input cap. Bonus fix: `approve_video_render` and `approve_video_script` no longer misclassified as `production`-stage approvals (`backend/execution/hermes-callbacks.ts`).
- **Stale-run reaper for stuck marketing jobs (#334).** New `aries-marketing-stale-run-reaper` cron (every 5 min) sweeps `running` jobs whose latest progress timestamp exceeds per-stage thresholds (research 10m, strategy 5m, production 90m, publish 5m — env overridable). Mutates to `failed_stale` with structured code `marketing_job_stalled`. Closes the `mkt_e6d7d734`-style "frozen forever" failure mode.

### Fixed
- **Brand-kit: stale "handcrafted leather goods" copy purged from active profiles (#335).** `repairStaleMarketingOffer` in `backend/marketing/brand-kit.ts` runs in the business-profile projection, workspace brief normalization, and social-content request builder paths. Removes the stale descriptor while preserving real coaching-network offer text. Idempotent dry-run/apply script `scripts/repair-stale-brand-offers.ts`. Also fixed: `creative_briefs` in image `media_requests` no longer leak the raw stale offer (was constructed pre-repair).
- **CI: deploy.yml actions bumped past Node 20 deprecation cutoff (#333).** `actions/checkout` v4→v5.0.1, `docker/login-action` v3→v4.1.0, `docker/setup-buildx-action` v3→v4.0.0 across deploy, PR-agent autofix, and issue-agent-fix workflows. checkout intentionally held at v5.0.1 (not v6) to avoid the credential-persistence behavior shift.

## [0.1.3.8] - 2026-05-15

### Fixed
- **Gating: failed runs no longer block new weekly content runs.** `Generate this week's content` was disabled whenever any run existed — including terminal-failed runs — because the guard used a raw "any in-progress run" check that did not exclude terminal states. The fix threads a new `executionState` field through `backend/marketing/runtime-views.ts`, uses `isPipelineActive()` to exclude terminal states (`failed`, `cancelled`, `timed_out`), and updates `frontend/aries-v1/generate-this-week.ts` and `lib/api/aries-v1.ts` accordingly. The campaigns list also previously mislabelled failed runs as "Campaign in progress" — that label now reflects the actual terminal state. Covered by expanded tests in `dashboard-generate-week-trigger.test.ts`, `dashboard-home-view-model.test.ts`, and `calendar-view-model.test.ts`.
- **Image generation: rich per-image prompts + fail-loud verification.** Hermes was silently completing production callbacks that contained only `image_creatives` prompt entries (no rendered image files) — meaning the `image_generate` tool call was quietly skipped and the dashboard showed zero images. The fix has two parts: (1) `backend/social-content/workflow-request.ts` now injects a rich per-image context block into every production resume sent to Hermes — including N-of-M framing, brand voice/palette/must-avoid constraints from research output, creative strategy, and platform-aware aspect ratio — so Hermes has the context it needs to actually call `image_generate`; (2) `backend/marketing/hermes-callbacks.ts` and `backend/marketing/ports/hermes.ts` now reject production callbacks whose `image_creatives` entries lack rendered image paths, returning a 422 so the run fails loud rather than silently completing with no images. No Hermes-side changes required. Covered by 11 new tests in `social-content-rich-prompts-and-failloud.test.ts`.

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
