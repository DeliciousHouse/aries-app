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

`backend/openclaw/gateway-client.ts` is the bridge to OpenClaw. It invokes the gateway via `execFile` (CLI subprocess), not HTTP. Key types: `LobsterEnvelope` (workflow result with optional `requiresApproval`), `OpenClawWorkflowCallInput` (run a pipeline), `OpenClawResumeCallInput` (resume after approval). The gateway can return an approval-request pause state that the orchestrator must handle.

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

```bash
# Install (force dev mode — system may have NODE_ENV=production)
NODE_ENV=development npm ci

# Dev server (Turbopack is REQUIRED for Tailwind CSS v4)
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
- `npm run verify` wraps the fast regression suite with all needed env overrides — use this for quick validation.

## Key Directories

- `app/` — Next.js pages, layouts, and route handlers
- `app/api/` — API route handlers (auth, marketing, integrations, onboarding, tenant, oauth, publish, calendar)
- `backend/` — Server-side domain logic (marketing orchestration, onboarding, auth, integrations, OpenClaw gateway client)
- `lib/` — Shared runtime helpers: DB pool (`lib/db.ts`), auth helpers, tenant context, runtime path resolution
- `frontend/` — UI screen components organized by domain (`aries-v1/`, `marketing/`, `onboarding/`, `donor/`, `admin/`)
- `components/` — Shared UI primitives
- `lobster/` — Lobster workflow definitions (marketing pipeline stages)
- `workflows/` — OpenClaw workflow configs
- `scripts/` — Startup, verification, DB init, automation scripts
- `tests/` — Regression tests covering routes, API contracts, tenant isolation, marketing flows, OAuth, banned patterns
- `specs/` — Specification files resolved via `lib/runtime-paths.ts`
- `skills/` — Agent skill definitions for marketing AI agents (campaign-planner, creative-director, research, etc.)
- `scripts/automations/` — Cron-driven automations (backup, self-improve, daily brief, feedback sync); installed via `npm run automation:install`

## Tech Stack

- **Framework:** Next.js 16.1.7 with App Router and Turbopack
- **UI:** React 18, Tailwind CSS v4, motion (Framer Motion), Three.js/R3F, Recharts, Lucide icons
- **Auth:** next-auth v5 beta with Credentials + Google providers, tenant-aware JWT/session callbacks
- **Database:** PostgreSQL via `pg` pool (`lib/db.ts`)
- **Execution:** OpenClaw Gateway + Lobster workflows
- **TypeScript:** Strict mode, ES2022 target, bundler module resolution

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
