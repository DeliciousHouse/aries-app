# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aries AI is a Next.js 16 App Router application for marketing automation. It combines a public marketing site, an authenticated operator shell, and browser-safe internal APIs that submit workflow execution to Hermes while keeping runtime state on the server.

## Architecture

```
Browser
  -> Next.js pages (app/*)
  -> Next.js route handlers (app/api/*)
      -> Aries backend services (backend/*, lib/*)
 -> Hermes Gateway for workflow execution callbacks
          -> PostgreSQL + runtime files under DATA_ROOT for state and read models
```

**Key architectural rules:**
- Aries owns the browser boundary. The UI talks only to Next.js route handlers.
- Long-running/workflow execution is delegated through Hermes callbacks — never exposed directly to the browser.
- Route handlers return frontend-safe payloads; never leak raw runtime files or internal workflow details.
- All marketing, integrations, and approval flows are tenant-aware and validated server-side.

**Path alias:** `@/*` maps to the repo root (configured in tsconfig.json).

**Runtime paths:** `lib/runtime-paths.ts` resolves `CODE_ROOT` (repo checkout) and `DATA_ROOT` (generated runtime artifacts) with fallback logic for container vs local environments. Generated data lives under `DATA_ROOT/generated/` with `draft/` and `validated/` subdirectories.

### Execution Provider Pattern

Hermes is the sole execution provider (`ARIES_EXECUTION_PROVIDER=hermes`, `ARIES_MARKETING_EXECUTION_PROVIDER=hermes`; these env vars are retained as forward-compatible selectors). Aries creates an execution run record before submitting to Hermes, passes `${APP_BASE_URL}/api/internal/hermes/runs` as the callback URL, and authenticates callbacks with `INTERNAL_API_SECRET`. Hermes callbacks are idempotent and are the source of truth for marketing progress. The execution-provider seam (`backend/execution/`, `backend/marketing/execution-port.ts`) is kept as a single-provider abstraction.

### Marketing Pipeline (4-Stage Workflow)

The core domain flow is a 4-stage marketing pipeline executed by Hermes:
1. **Research** (`stage-1-research`) — competitor analysis, ad library scraping
2. **Strategy** (`stage-2-strategy`) — social content strategy from research
3. **Production** (`stage-3-production`) — creative/content generation
4. **Publish & Optimize** (`stage-4-publish-optimize`) — publishing and performance tracking

Each stage can pause for human approval. `backend/marketing/orchestrator.ts` drives the pipeline: starts stages via the Hermes execution port, collects artifacts, manages approval checkpoints, and records state transitions. Approval records are persisted via `backend/marketing/approval-store.ts`.

**Resumability rule:** Stages must preserve partial artifacts on rate-limit or transient gateway failures so a resume can pick up where it left off. Do not discard work on a non-fatal stage error — persist what completed, surface the failure, and let the orchestrator decide whether to retry. This rule exists because of past Veo render rate-limit incidents that lost completed creative on retry.

### Auth & Tenant Model

Auth uses next-auth v5 (`auth.ts` at repo root) with Credentials + Google providers. Sessions are enriched with tenant claims (`tenantId`, `tenantSlug`, `role`) via JWT callbacks. `lib/tenant-context.ts` provides `getTenantContext()` which first checks session claims, then falls back to a DB lookup. Tenant roles: `tenant_admin`, `tenant_analyst`, `tenant_viewer`. All authenticated API routes should resolve tenant context server-side.

## Build and Dev Commands

> **Turbopack is required.** `npm run dev` passes `--turbo`; running `next dev` without it silently breaks Tailwind v4 styling. Same applies to `next build`.

> **Pre-push gate:** `npm run verify` is the canonical fast regression suite and bakes in the env overrides tests need. Run it before pushing any change that touches routes, backend, or lib.

```bash
# Install (force dev mode — system may have NODE_ENV=production)
NODE_ENV=development npm ci

# Dev server
npm run dev

# Type check
npm run typecheck

# Lint (typecheck + banned pattern check)
npm run lint

# Quick regression suite (deterministic env overrides built in)
npm run verify

# Run all tests
APP_BASE_URL=https://aries.example.com tsx --test tests/*.test.ts tests/**/*.test.ts

# Run a single test file
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/some-test.test.ts

# E2E subset
npm run test:e2e

# Marketing flow tests specifically
npm run validate:marketing-flow

# Database init
npm run db:init

# Pre-flight check
npm run precheck
```

**Test environment notes:**
- Tests use Node.js built-in test runner via `tsx --test` (not Jest/Vitest).
- Many tests require `APP_BASE_URL=https://aries.example.com` to be set.
- `npm run verify` wraps the fast regression suite with all needed env overrides and runs `npm run guardrails:agent` first.
- `npm run test:concurrent` runs the full TypeScript test set with `--test-concurrency=8`; use it before shipping work that changes routes, backend services, process management, or shared helpers.
- `npm run validate:execution-provider` is the focused Hermes callback/execution-port gate.
- `npm run validate:social-content` is the focused weekly social-content gate.

## Active operational guardrails

These rules are here because they already bit this repo.

1. **DB fan-out and endpoint latency:** Do not add `Promise.all` around PostgreSQL or gateway-backed call chains until you have checked `DB_POOL_MAX` and benchmarked the full endpoint, not just the helper. More parallel queries can make an isolated function faster while making the customer-facing request slower through pool contention. For production launch-scale, treat total database pressure as `ARIES_WEB_CONCURRENCY * DB_POOL_MAX` per container.
2. **Parallel-agent duplicate work:** Before any agent ships or opens a PR from a parallel worktree, run `npm run guardrails:agent`. It performs `git fetch origin`, detects the base branch, compares `HEAD` to `origin/<base>`, and warns when the branch has no unique diff or looks like duplicate already-landed work.
3. **Codex worker prompt stalls:** If Codex or AO workers appear to run forever with no output, inspect tmux before assuming the task is hard. Codex can block on a model-upgrade prompt; select `Use existing model` with Down + Enter, then resume monitoring.
4. **Initial scale target:** Optimize the first production profile for about 50 people/users, not just a single happy-path demo. Use `ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10` as the first container profile unless the database connection budget says otherwise, and validate with the 50-concurrent smoke check in `DOCKER.md`.
5. **Hermes is a POLLED API — delivery must be a standing process, never a per-request promise.** Hermes `/v1/runs` never invokes the submission's `callback_url`; Aries must poll runs to completion itself. The legacy in-process "poll-bridge" (`backend/marketing/ports/hermes.ts::runPollBridge`, still present as a best-effort fast path) was a `void this.runPollBridge(...)` fire-and-forget spawned by the submitting request — it did not survive the prod request lifecycle, so completed runs were never ingested and the stale-run reaper failed every marketing job (systemic outage, no success 2026-05-27 → fix). Durable delivery is the **Hermes reconciler** (`backend/marketing/hermes-reconciler.ts` + `scripts/hermes-reconciler-worker.ts`), spawned by `start-runtime.mjs` as a sibling of the Next.js cluster (same model as the stale-run reaper). It re-discovers in-flight marketing execution runs from disk every `ARIES_RECONCILER_INTERVAL_MS` (default 60s) and ingests finished ones via the same idempotent `handleHermesRunCallback` path (deterministic `event_id = reconcile-<hermesRunId>`). Gated by `ARIES_RECONCILER_ENABLED` (default ON). Reconciler delivery must always beat the reaper's tightest stage threshold (strategy 5 min). The reconciler **prevents** future loss; un-reaping historical `failed_stale` runs writes prod state and is a separate, sign-off-gated backfill (`hermes-callbacks.ts` drops callbacks for `state==='failed'` docs). Per-tick scan cost is bounded by an mtime window (`ARIES_RECONCILER_MAX_RECORD_AGE_MS`, default 24h) so it does not scale with all runs ever created; disk-level retention of old terminal `execution-runs/*.json` (nothing deletes them yet) remains a sign-off-gated follow-up (extend `hermes-kanban-gc-worker`).

## Key Directories

Non-obvious layout notes (the rest is discoverable by browsing):

- `backend/` vs `lib/` — `backend/` holds domain logic (marketing orchestrator, onboarding, execution port, approval store); `lib/` is for shared runtime helpers consumed by both `app/` and `backend/` (DB pool, auth, tenant context, runtime path resolution). Route handlers should import domain code from `backend/`, not inline it.
- `frontend/` vs `components/` — `frontend/` is screen-level components grouped by domain (`marketing/`, `onboarding/`, `donor/`, `admin/`, `aries-v1/`); `components/` is shared primitives.
- `backend/execution/` — the Hermes execution surface (`provider-factory`, `providers/hermes`, `workflow-catalog`, `route-helpers`) consumed by route handlers; `backend/marketing/execution-port.ts` is the marketing-pipeline Hermes port.
- `specs/` — resolved via `lib/runtime-paths.ts`, not imported directly by path.
- `skills/` — marketing agent skill definitions (campaign-planner, creative-director, research, etc.) executed by the gateway, not TypeScript modules.
- `scripts/automations/` — holds three long-lived sidecar workers, each self-scheduling via `setInterval` and each run as a single-replica `restart: unless-stopped` service in `docker-compose.yml` (the app-calling ones point `APP_BASE_URL` at the in-network `http://aries-app:3000` to skip the public DNS+TLS round-trip; no external cron required):
  - `scheduled-posts-worker.mjs` — drains the `scheduled_posts` table and POSTs due rows to `/api/internal/publishing/scheduled-dispatch` every 60 seconds (`aries-scheduled-posts-worker` service). This is the publish back-half.
  - `weekly-job-trigger-worker.ts` — atomically claims due rows in the `marketing_schedule` table and starts a `weekly_social_content` job per opted-in tenant via `POST /api/internal/marketing/weekly-trigger` (`aries-weekly-trigger-worker` service, `tsx`-run). Gated by `ARIES_WEEKLY_TRIGGER_ENABLED` (default OFF — ships dormant); tick interval is `ARIES_WEEKLY_TRIGGER_INTERVAL_MS` (default 15 min). Cadence rows are managed with the `scripts/marketing/upsert-marketing-schedule.ts` CLI. The `marketing_schedule` table (one row per tenant: `day_of_week`, `hour_of_day`, `timezone`, `enabled`, `last_triggered_at` claim marker) ships in `scripts/init-db.js` (applied on container start) plus `migrations/` for record.
  - `draft-expiry-sweep-worker.ts` — expires STRANDED pre-publish posts (no `scheduled_posts` row, `published_at IS NULL`, `platform_post_id IS NULL` (never reached Meta), canonical `published_status` in `draft`/`in_review`/`approved`, `updated_at` older than the age window) by setting `published_status='expired'` (and the legacy `status` mirror), so the unscheduled-approved backlog the dashboard "backlog tray" surfaces stops growing without bound once the weekly trigger fans out (the "36 stranded approved IG posts" symptom). Keys on the canonical `published_status`, NOT the legacy `status` mirror (which defaults to `'draft'` on Meta-native-scheduled posts → would false-positive-expire a live post). DB-only (no app round-trip); idempotent + batched; logic in `backend/marketing/draft-expiry-sweep.ts`. The `aries-draft-expiry-sweep-worker` service is `tsx`-run, gated by `ARIES_DRAFT_EXPIRY_ENABLED` (default OFF — ships dormant). It is the complement of the stale-run reaper, which reaps stranded *job docs on disk*; this sweep expires stranded *post rows in the DB*.
- `DOCKER.md` — container build/runtime profiles and the 50-concurrent smoke check referenced by guardrail #4.

## Tech Stack Notes

Most of the stack (React, Tailwind, Recharts, etc.) is discoverable from `package.json`. The non-obvious constraints:

- **Next.js 16** App Router with **Turbopack required** (Tailwind v4 breaks under webpack).
- **next-auth v5 beta** — session is enriched with tenant claims in JWT callbacks; do not read user info without going through `getTenantContext()`.
- **PostgreSQL** via `pg` pool in `lib/db.ts` — no ORM.
- **Imports use `@/*`** rooted at the repo (e.g. `@/backend/...`, `@/lib/...`).

## Commit & PR Conventions

This repo uses Conventional Commits with a scope (e.g. `fix(ci): ...`, `refactor(workspace): ...`, `feat(marketing): ...`). Match the existing style — `git log --oneline -20` is the source of truth. Keep subjects in the imperative and under ~70 chars; put detail in the body.

## Banned Patterns

`scripts/check-banned-patterns.mjs` enforces that certain strings never appear in key files. Banned terms include: `n8n`, `parity-stub`, `placeholder response/error`, `not yet wired`, `missing workflow wiring`, `intentionally disabled until`. Run `npm run validate:banned-patterns` to check.

## Deploy Configuration

- platform: docker (self-hosted via GitHub Actions Deploy workflow)
- production.url: https://aries.sugarandleather.com
- deploy.workflow: .github/workflows/deploy.yml
- health.check: curl -sf https://aries.sugarandleather.com -o /dev/null -w "%{http_code}"

## Environment Variables

Required for Hermes-native local/runtime setup: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `APP_BASE_URL`, `HERMES_GATEWAY_URL`, `HERMES_API_SERVER_KEY`, `INTERNAL_API_SECRET`, `NEXTAUTH_URL`, `AUTH_URL`, `NEXTAUTH_SECRET`

Optional safety flags:
- `ARIES_MEMORY_LABEL_REDACTION_V2=1` — switches `scrubPreferenceLabelForHoncho` (`backend/memory/write-events.ts`) from the legacy broad `[A-Z][a-z]+\s+[A-Z][a-z]+` regex to a narrow first-name-denylist heuristic. Preserves creative descriptors like "Bold Minimalist" / "Quiet Luxury" while still scrubbing `<FirstName> <LastName>` pairs. Default OFF (legacy behavior) until rollout. Email redaction is unchanged in both modes.
- `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1` — when Hermes emits `requires_approval` for strategy/production/publish, Aries synthesizes an `ai-orchestrator` approval from the callback handler and resumes the pipeline without a human click. Closes the autonomous E2E loop. Process-wide — affects ALL tenants in this container. Default ON in `docker-compose.yml` (single-tenant prod, autonomous mode); set to `0` to require human approval clicks again.
- `ARIES_BRAND_ENRICHMENT_ENABLED=1` — enables LLM-backed brand-kit enrichment via Hermes (`extractEnrichAndSaveTenantBrandKit`). Persists `positioning`, `audience`, `tone_of_voice`, and `style_vibe` to `brand-kit.json`; wires them into the weekly Hermes payload. Default ON in `docker-compose.yml` (single-tenant prod). Set to `0` to disable enrichment and use scraped-only brand kit.
- `ARIES_SOCIAL_COPY_FINALIZE_ENABLED=1` — enables the post-creative `social_copy_finalize` stage after image approval. Aries treats `1`, `true`, `yes`, or `on` as enabled; when the flag is unset/off, the orchestrator skips `social_copy_finalize`, marks it skipped, and continues with the legacy publish path. Ship this flag default OFF and leave it OFF until the Hermes-side `social_copy_finalize` workflow is registered and quality-evaluated; Hermes workflow registration itself remains out of scope for Aries.
- `ARIES_VIDEO_PUBLISH_ENABLED=1` — rollout switch for video / Reel / Story video publishing to Facebook + Instagram. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, `synthesizePublishPostsFromContentPackage` strips schedule entries whose `placement` is `reel` or whose `media_type` is `video` (a reel has no image fallback, so that post/platform target is skipped); image/feed posts are unaffected so the campaign still succeeds. When ON, video/Reel/Story-video entries persist with the new `surface` (`feed`/`story`/`reel`) + `media_type` axes and dispatch through the new Meta Graph video branches (IG `media_type=VIDEO|REELS|STORIES` container + extended poll; FB `/videos` file_url + `/video_stories` start/finish). Per-surface media validation (`backend/integrations/meta-media-validation.ts`) is metadata-driven from Hermes width/height/duration and fails closed. Leave OFF until the Hermes side emits `media_type:"video"` + per-asset video metadata (separate repo).
- `ARIES_ONBOARDING_VARIANT_BOARD_ENABLED=1` — rollout switch for the first-post onboarding variant board → taste profile (`docs/plans/2026-06-02-onboarding-variant-board.md`). Aries treats `1`, `true`, `yes`, or `on` as enabled (`isOnboardingVariantBoardEnabled`, `backend/onboarding/variant-board-env.ts`). Default OFF. When OFF, onboarding runs the existing single weekly job with no board (byte-identical to today). When ON, a new user's first post is generated as a 3-variant board (Aries fans out 3 `submitRawRun` Hermes runs — no Hermes contract change); the user picks one, rates 1-5, and can regenerate / more-like-this / freeform-edit; the pick + ratings + edits write taste to BOTH the new Aries `marketing_taste_profile` table (read-time bias, 5%/week decay computed at read in `backend/marketing/taste-profile-store.ts`) AND Honcho (durable, via `recordOnboardingVariantTasteSignalEvent` — the Honcho leg is still additionally gated by `HONCHO_WRITE_PREFERENCES_ENABLED`), and the remaining week-1 posts are anchored to the chosen variant. Process-wide (all tenants in the container). Keep OFF until the rendered onboarding/dashboard is screenshot-verified per the plan's success bar.
- `ARIES_TEST_REQUIRES_INFRA_ENABLED=1` — opt-in switch for running the requires-infra (live-Postgres) test split locally. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, the live-DB test files (indexed in `tests/REQUIRES_INFRA.md`) self-skip with `t.skip('database env not configured')` via the shared `requireDbEnvOrSkip` guard (`tests/helpers/requires-infra.ts`), exactly as the `full-suite` CI gate expects. When ON **and** `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` point at a reachable Postgres, `npm run test:requires-infra` runs those files for real. This flag is read **only by the test harness, never by the app runtime, and never set by CI** — so it lives here + `.env.example` and is deliberately kept out of `docker-compose.yml`. `npm run test:requires-infra-report` prints the self-contained vs requires-infra split without running anything.
- `ARIES_AUTOSCHEDULE_ON_APPROVAL=1` — the **safe alternative to `ARIES_AUTO_APPROVE_MARKETING_PIPELINE`**. Aries treats `1`, `true`, `yes`, or `on` as enabled (`autoScheduleOnApprovalEnabled`, `backend/marketing/hermes-callbacks.ts`). Default OFF. When OFF, a job's already-approved posts only auto-schedule under the no-review autonomous flag, so with approval-gating on (the safe prod setting) approved posts strand. When ON, once a **human** approves the publish gate, the week's posts auto-schedule to both Instagram and Facebook. The hook is one guard at the single completion convergence point (`synthesizePublishPostsOnCompletion` in `backend/marketing/hermes-callbacks.ts`), so it is correct for human-approve, auto-approve, multi-stage, and reconciler-delivered completions, fires once per terminal callback, and is idempotent on re-delivery (`upsertScheduledPost ON CONFLICT(post_id)`). Default OFF in `docker-compose.yml` (`ARIES_AUTOSCHEDULE_ON_APPROVAL:-0`).
- `ARIES_WEEKLY_TRIGGER_ENABLED=1` — rollout switch for the weekly-content cadence (`docs/plans/2026-06-04-weekly-social-content-automation.md`). Aries treats `1`, `true`, `yes`, or `on` as enabled (`weeklyTriggerEnabled`, `scripts/automations/weekly-job-trigger-worker.ts`). Default OFF. When OFF, the `aries-weekly-trigger-worker` docker-compose service exits at startup and ships dormant. When ON, the worker atomically claims due rows in the `marketing_schedule` table (conditional `UPDATE` on `last_triggered_at`, safe across concurrent ticks and multiple containers) and starts a `weekly_social_content` job per opted-in tenant on its configured day/hour/timezone via `POST /api/internal/marketing/weekly-trigger` (`INTERNAL_API_SECRET` auth; the app process owns the Hermes submission). A failed submit reverts the claim so the week is retried, not lost; a server-side idempotency guard collapses a re-fire onto the existing job. Cadence is managed with the validated CLI `scripts/marketing/upsert-marketing-schedule.ts` (preserves omitted fields on a partial edit). Default OFF in `docker-compose.yml` (`ARIES_WEEKLY_TRIGGER_ENABLED:-0`).
- `ARIES_WEEKLY_TRIGGER_INTERVAL_MS` — tick interval (ms) for the `aries-weekly-trigger-worker` self-scheduling loop. Default `900000` (15 minutes); a non-positive or unparseable value falls back to the default. Set in `docker-compose.yml` (`ARIES_WEEKLY_TRIGGER_INTERVAL_MS:-900000`). Only meaningful when `ARIES_WEEKLY_TRIGGER_ENABLED` is on.
- `ARIES_REAPER_AWAITING_APPROVAL_THRESHOLD_MS` — the window (ms) before the stale-run reaper reaps a job that is correctly *waiting for a human* at an approval gate. Default `604800000` (7 days); previously such jobs were reaped at the 5-minute strategy stage threshold, which broke human-in-the-loop approval (`DEFAULT_AWAITING_APPROVAL_THRESHOLD_MS`, `backend/marketing/stale-run-reaper.ts`). Jobs are still reaped eventually so a genuinely wedged gate is caught, with a loud log. An explicit force-reap override (CLI `--threshold-ms` or the `STALE_RUN_REAPER_THRESHOLD_MS` env var) still wins over this awaiting-approval window.
- `ARIES_DRAFT_EXPIRY_ENABLED=1` — rollout switch for the draft-expiry sweep (`aries-draft-expiry-sweep-worker` / `backend/marketing/draft-expiry-sweep.ts`). Aries treats `1`, `true`, `yes`, or `on` as enabled (`draftExpiryEnabled`). Default OFF. When OFF, the worker exits-to-idle (no restart loop, no DB writes) and ships dormant. When ON, every tick it expires STRANDED pre-publish posts — a post with **no** `scheduled_posts` row (never reached the publish queue), `published_at IS NULL` (never went live), `platform_post_id IS NULL` (never reached Meta), a canonical `published_status` of `draft`/`in_review`/`approved`, and `updated_at` older than the age window — by setting `published_status='expired'` + `status='expired'` + `expired_at=now()`. It keys on the canonical `published_status` (not the legacy `status` mirror, which defaults to `'draft'` on Meta-native-scheduled posts and would otherwise false-positive-expire a live post). This removes them from the operator's approval/backlog trays **without publishing stale content**, stopping the unscheduled-approved backlog (the "36 stranded approved IG posts" symptom) from growing once the weekly trigger fans out. It is the DB-row complement of the stale-run reaper (which reaps stranded job docs on disk). Idempotent (an expired post no longer matches the predicate), batched, and every mutating statement re-checks the full predicate so a post that gets scheduled/published mid-sweep is skipped. **Before first enabling in prod, run one cycle with `ARIES_DRAFT_EXPIRY_DRY_RUN=1`** to observe candidate counts read-only, then flip it back to commit. Default OFF in `docker-compose.yml` (`ARIES_DRAFT_EXPIRY_ENABLED:-0`). Requires the `'expired'` status value + `expired_at` column from `scripts/init-db.js` (applied on container start).
- `ARIES_DRAFT_EXPIRY_DRY_RUN=1` — when truthy, every draft-expiry tick runs read-only: it counts candidates (total + per-tenant) and logs them but mutates nothing. The safe first step when enabling the sweep in prod (flip `ARIES_DRAFT_EXPIRY_ENABLED=1` + `ARIES_DRAFT_EXPIRY_DRY_RUN=1` for one observation cycle, then set `DRY_RUN=0`). Default OFF (the sweep commits when enabled, matching the other workers). Only meaningful when `ARIES_DRAFT_EXPIRY_ENABLED` is on.
- `ARIES_DRAFT_EXPIRY_AGE_DAYS` — how many days a pre-publish post must sit untouched (`updated_at < now() - age`) before it is eligible to expire. Default `14`; a non-positive or unparseable value falls back. A generous window so a post actively being reviewed is never expired out from under the operator. Only meaningful when `ARIES_DRAFT_EXPIRY_ENABLED` is on.
- `ARIES_DRAFT_EXPIRY_INTERVAL_MS` — tick interval (ms) for the `aries-draft-expiry-sweep-worker` self-scheduling loop. Default `21600000` (6 hours); a non-positive or unparseable value falls back to the default. Only meaningful when `ARIES_DRAFT_EXPIRY_ENABLED` is on.
- `ARIES_FEED_LOGO_COMPOSITE_ENABLED=1` — rollout switch for compositing the **real** brand logo onto generated single-image FEED creatives (`isFeedLogoCompositeEnabled`, `backend/social-content/feed-logo-composite-env.ts`). Aries treats `1`/`true`/`yes`/`on` as enabled. Default OFF. When OFF, ingest is byte-identical to today and the image brief keeps its `Brand logo: <url>` instruction (the model draws a logo). When ON: (1) `ingestProductionCreativeAssetsToDb` composites the brand kit's materialized logo onto eligible single-image feed assets via `applyBrandFrame` (`backend/creative-memory/frame-overlay.ts`, border-off + a luminance-sampled conditional feathered scrim so the light mark reads on bright photo regions), **replacing** the raw row's bytes (one row, `storage_kind='ingested_asset'`, framed checksum, self-referential `served_asset_ref` — so IG publish posts the framed image; the #555 surface); and (2) `buildProductionResumeContext` drops the `Brand logo:` line and tells the model **not** to draw a logo (else the final image carries two). Requires the brand kit's `logo_file_path` (downloaded during brand-kit enrichment; backfill existing tenants with `scripts/marketing/materialize-tenant-logo.ts --tenant N` / `--all` / `--logo-file <path>`). Framing is best-effort/non-fatal: any failure falls back to the raw bytes so publish is never blocked. Process-wide; default OFF in `docker-compose.yml`. **Screenshot-verify a freshly generated + published post on a live tenant before flipping in prod** (only rendered output counts).

Required when working on Aries-managed OAuth providers: `OAUTH_TOKEN_ENCRYPTION_KEY`. Weekly social content media generation does not use an Aries-side OpenAI client or secret; Hermes owns media auth and execution.

Hermes image serving (set both together; see `docker-compose.yml` volumes):
- `HERMES_IMAGE_CACHE_DIR` — host-side path to the Hermes image cache (default `/home/node/.hermes/profiles/aries-content-generator/cache/images` — the profile-scoped cache the three-profile content generator writes to; the legacy `/home/node/.hermes/cache/images` is no longer written by the marketing pipeline); bind-mounted read-only into the container as `HERMES_IMAGE_CACHE_MOUNT`.
- `HERMES_IMAGE_CACHE_MOUNT` — in-container mount point for the Hermes image cache (default `/hermes-media`); read by `app/api/internal/hermes/media/[...path]/route.ts` to stream generated images to authenticated browser sessions, and by `backend/marketing/ingest-production-assets.ts` which resolves every Hermes-reported `path` to `<mount>/<basename>` before reading. If the mount points at the wrong host directory, production-callback creative_assets ingestion silently inserts zero rows and the operator dashboard shows "No launch items".

Local dev defaults:
```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/home/node/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
```

## gstack (REQUIRED)

gstack is required for all AI-assisted work in this repo. Verify with `test -d ~/.claude/skills/gstack/bin`. Install/usage instructions live in the global `~/.claude/CLAUDE.md`. Use `/browse` for all web browsing.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
