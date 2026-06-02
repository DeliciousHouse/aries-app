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

## Key Directories

Non-obvious layout notes (the rest is discoverable by browsing):

- `backend/` vs `lib/` — `backend/` holds domain logic (marketing orchestrator, onboarding, execution port, approval store); `lib/` is for shared runtime helpers consumed by both `app/` and `backend/` (DB pool, auth, tenant context, runtime path resolution). Route handlers should import domain code from `backend/`, not inline it.
- `frontend/` vs `components/` — `frontend/` is screen-level components grouped by domain (`marketing/`, `onboarding/`, `donor/`, `admin/`, `aries-v1/`); `components/` is shared primitives.
- `backend/execution/` — the Hermes execution surface (`provider-factory`, `providers/hermes`, `workflow-catalog`, `route-helpers`) consumed by route handlers; `backend/marketing/execution-port.ts` is the marketing-pipeline Hermes port.
- `specs/` — resolved via `lib/runtime-paths.ts`, not imported directly by path.
- `skills/` — marketing agent skill definitions (campaign-planner, creative-director, research, etc.) executed by the gateway, not TypeScript modules.
- `scripts/automations/` — holds `scheduled-posts-worker.mjs`, the worker that drains the `scheduled_posts` table and POSTs due rows to `/api/internal/publishing/scheduled-dispatch` every 60 seconds. The script self-schedules via `setInterval`; the `aries-scheduled-posts-worker` service in `docker-compose.yml` runs it as a long-lived sidecar (single replica, `restart: unless-stopped`, points `APP_BASE_URL` at the in-network `http://aries-app:3000` to skip the public DNS+TLS round-trip on every tick). No external cron required.
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
