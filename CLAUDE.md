# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aries AI is a Next.js 16 App Router application for marketing automation. It combines a public marketing site, an authenticated operator shell, and browser-safe internal APIs that delegate workflow execution to an external OpenClaw Gateway while keeping runtime state on the server.

## Architecture

```
Browser
  -> Next.js pages (app/*)
  -> Next.js route handlers (app/api/*)
      -> Aries backend services (backend/*, lib/*)
          -> OpenClaw Gateway for workflow execution (via CLI subprocess)
          -> PostgreSQL + runtime files under DATA_ROOT for state and read models
```

**Key architectural rules:**
- Aries owns the browser boundary. The UI talks only to Next.js route handlers.
- Long-running/workflow execution is delegated through the OpenClaw Gateway — never exposed directly to the browser.
- Route handlers return frontend-safe payloads; never leak raw runtime files or internal workflow details.
- All marketing, integrations, and approval flows are tenant-aware and validated server-side.

**Path alias:** `@/*` maps to the repo root (configured in tsconfig.json).

**Runtime paths:** `lib/runtime-paths.ts` resolves `CODE_ROOT` (repo checkout) and `DATA_ROOT` (generated runtime artifacts) with fallback logic for container vs local environments. Generated data lives under `DATA_ROOT/generated/` with `draft/` and `validated/` subdirectories.

### Gateway Client Pattern

`backend/openclaw/gateway-client.ts` is the bridge to OpenClaw. It invokes the gateway via `execFile` (CLI subprocess), not HTTP. Key types: `LobsterEnvelope` (workflow result with optional `requiresApproval`), `OpenClawWorkflowCallInput` (run a pipeline), `OpenClawResumeCallInput` (resume after approval). When a stage returns `requiresApproval`, the orchestrator persists the paused envelope via `approval-store.ts` and later calls the gateway again with `OpenClawResumeCallInput` carrying the approval decision — callers should never assume a workflow ran to completion on a single invocation.

### Marketing Pipeline (4-Stage Lobster Workflow)

The core domain flow is a 4-stage marketing pipeline defined in `lobster/marketing-pipeline.lobster`:
1. **Research** (`stage-1-research`) — competitor analysis, ad library scraping
2. **Strategy** (`stage-2-strategy`) — campaign strategy from research
3. **Production** (`stage-3-production`) — creative/content generation
4. **Publish & Optimize** (`stage-4-publish-optimize`) — publishing and performance tracking

Each stage can pause for human approval. `backend/marketing/orchestrator.ts` drives the pipeline: starts stages via the gateway client, collects artifacts, manages approval checkpoints, and records state transitions. Approval records are persisted via `backend/marketing/approval-store.ts`.

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

## Active operational guardrails

These rules are here because they already bit this repo.

1. **DB fan-out and endpoint latency:** Do not add `Promise.all` around PostgreSQL or gateway-backed call chains until you have checked `DB_POOL_MAX` and benchmarked the full endpoint, not just the helper. More parallel queries can make an isolated function faster while making the customer-facing request slower through pool contention. For production launch-scale, treat total database pressure as `ARIES_WEB_CONCURRENCY * DB_POOL_MAX` per container.
2. **Parallel-agent duplicate work:** Before any agent ships or opens a PR from a parallel worktree, run `npm run guardrails:agent`. It performs `git fetch origin`, detects the base branch, compares `HEAD` to `origin/<base>`, and warns when the branch has no unique diff or looks like duplicate already-landed work.
3. **Codex worker prompt stalls:** If Codex or AO workers appear to run forever with no output, inspect tmux before assuming the task is hard. Codex can block on a model-upgrade prompt; select `Use existing model` with Down + Enter, then resume monitoring.
4. **Initial scale target:** Optimize the first production profile for about 50 people/users, not just a single happy-path demo. Use `ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10` as the first container profile unless the database connection budget says otherwise, and validate with the 50-concurrent smoke check in `DOCKER.md`.

## Key Directories

Non-obvious layout notes (the rest is discoverable by browsing):

- `backend/` vs `lib/` — `backend/` holds domain logic (marketing orchestrator, onboarding, gateway client, approval store); `lib/` is for shared runtime helpers consumed by both `app/` and `backend/` (DB pool, auth, tenant context, runtime path resolution). Route handlers should import domain code from `backend/`, not inline it.
- `frontend/` vs `components/` — `frontend/` is screen-level components grouped by domain (`marketing/`, `onboarding/`, `donor/`, `admin/`, `aries-v1/`); `components/` is shared primitives.
- `lobster/` vs `workflows/` — `lobster/` holds `.lobster` workflow definitions consumed by the gateway (e.g. `marketing-pipeline.lobster`); `workflows/` holds OpenClaw workflow configs that wire those definitions into the gateway.
- `specs/` — resolved via `lib/runtime-paths.ts`, not imported directly by path.
- `skills/` — marketing agent skill definitions (campaign-planner, creative-director, research, etc.) executed by the gateway, not TypeScript modules.
- `scripts/automations/` — cron-driven jobs installed via `npm run automation:install`.

## Tech Stack Notes

Most of the stack (React, Tailwind, Recharts, etc.) is discoverable from `package.json`. The non-obvious constraints:

- **Next.js 16** App Router with **Turbopack required** (Tailwind v4 breaks under webpack).
- **next-auth v5 beta** — session is enriched with tenant claims in JWT callbacks; do not read user info without going through `getTenantContext()`.
- **PostgreSQL** via `pg` pool in `lib/db.ts` — no ORM.
- **Imports use `@/*`** rooted at the repo (e.g. `@/backend/...`, `@/lib/...`).

## Banned Patterns

`scripts/check-banned-patterns.mjs` enforces that certain strings never appear in key files. Banned terms include: `n8n`, `parity-stub`, `placeholder response/error`, `not yet wired`, `missing workflow wiring`, `intentionally disabled until`. Run `npm run validate:banned-patterns` to check.

## Protected Systems

- **OpenClaw** is Brendan-only for writes. Agents may read/inspect/analyze but not modify gateway config, cron/scheduler, agent registration, or runtime config without explicit approval.

## Environment Variables

Required: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `APP_BASE_URL`, `NEXTAUTH_URL`, `AUTH_URL`

Local dev defaults:
```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/home/node/openclaw/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
```

## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

## GBrain Configuration (configured by /setup-gbrain)
- Engine: postgres/Supabase
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-04-26
- MCP registered: yes
- Memory sync: off
- Current repo policy: read-write
- Semantic embeddings: configured with OpenAI text-embedding-3-large (1536 dimensions)
