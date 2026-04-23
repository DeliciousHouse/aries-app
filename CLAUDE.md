# CLAUDE.md

Guidance for Claude Code in this repository.

## Project Overview

Aries AI is a Next.js 16 App Router app for marketing automation. Public marketing site + authenticated operator shell + browser-safe internal APIs that delegate workflow execution to an external OpenClaw Gateway while keeping runtime state on the server.

## Architecture

```
Browser
  -> Next.js pages (app/*)
  -> Next.js route handlers (app/api/*)
      -> Aries backend services (backend/*, lib/*)
          -> OpenClaw Gateway (via CLI subprocess) for workflow execution
          -> PostgreSQL + runtime files under DATA_ROOT
```

**Rules:**
- UI talks only to Next.js route handlers.
- Long-running/workflow execution goes through the OpenClaw Gateway — never exposed to the browser.
- Route handlers return frontend-safe payloads; never leak raw runtime files.
- All flows are tenant-aware and validated server-side.

**Path alias:** `@/*` maps to the repo root.

**Runtime paths:** `lib/runtime-paths.ts` resolves `CODE_ROOT` (repo) and `DATA_ROOT` (generated artifacts). Generated data lives under `DATA_ROOT/generated/{draft,validated}/`.

### Gateway Client

`backend/openclaw/gateway-client.ts` bridges to OpenClaw via `execFile` (CLI subprocess, not HTTP).
- `LobsterEnvelope` — workflow result, optionally `requiresApproval`
- `OpenClawWorkflowCallInput` — run a pipeline
- `OpenClawResumeCallInput` — resume after approval
- On `requiresApproval`, the orchestrator persists the paused envelope via `approval-store.ts` and resumes later. Never assume single-invocation completion.

### Marketing Pipeline

4-stage Lobster workflow in `lobster/marketing-pipeline.lobster`:
1. `stage-1-research` — competitor analysis, ad library scraping
2. `stage-2-strategy` — campaign strategy
3. `stage-3-production` — creative/content generation
4. `stage-4-publish-optimize` — publishing and performance tracking

Each stage can pause for approval. `backend/marketing/orchestrator.ts` drives it; approvals persist via `backend/marketing/approval-store.ts`.

### Auth & Tenants

next-auth v5 (`auth.ts` at repo root), Credentials + Google. Sessions are enriched with `tenantId`, `tenantSlug`, `role` via JWT callbacks. Always use `lib/tenant-context.ts` → `getTenantContext()` (checks session claims, falls back to DB). Roles: `tenant_admin`, `tenant_analyst`, `tenant_viewer`.

## Build & Dev Commands

> **Turbopack required.** `npm run dev` passes `--turbo`; running `next dev`/`next build` without it silently breaks Tailwind v4.
>
> **Pre-push gate:** `npm run verify` — canonical fast regression suite with env overrides baked in. Run before pushing any change to routes/backend/lib.

```bash
NODE_ENV=development npm ci   # system may have NODE_ENV=production
npm run dev
npm run typecheck
npm run lint                  # typecheck + banned pattern check
npm run verify                # fast regression suite
npm run test:e2e
npm run validate:marketing-flow
npm run db:init
npm run precheck
```

Tests use Node's built-in runner via `tsx --test` (not Jest/Vitest). Most require `APP_BASE_URL=https://aries.example.com`; `npm run verify` sets it for you.

## Key Directories

- `backend/` — domain logic (marketing orchestrator, onboarding, gateway client, approval store). Route handlers import from here.
- `lib/` — shared runtime helpers (DB pool, auth, tenant context, runtime paths).
- `frontend/` — screen-level components by domain (`marketing/`, `onboarding/`, `donor/`, `admin/`, `aries-v1/`).
- `components/` — shared primitives.
- `lobster/` — `.lobster` workflow definitions consumed by the gateway.
- `workflows/` — OpenClaw workflow configs wiring Lobster definitions into the gateway.
- `skills/` — marketing agent skill definitions executed by the gateway (not TS modules).
- `specs/` — resolved via `lib/runtime-paths.ts`.
- `scripts/automations/` — cron jobs installed via `npm run automation:install`.

## Tech Stack Gotchas

- **Next.js 16** App Router, Turbopack required (Tailwind v4 breaks under webpack).
- **next-auth v5 beta** — never read user info directly; go through `getTenantContext()`.
- **PostgreSQL** via `pg` pool in `lib/db.ts` — no ORM.

## Banned Patterns

`scripts/check-banned-patterns.mjs` blocks: `n8n`, `parity-stub`, `placeholder response/error`, `not yet wired`, `missing workflow wiring`, `intentionally disabled until`. Check with `npm run validate:banned-patterns`.

## Protected Systems

**OpenClaw** is Brendan-only for writes. Read/inspect/analyze freely, but do not modify gateway config, cron/scheduler, agent registration, or runtime config without explicit approval.

## Environment

Required: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `DB_{HOST,PORT,USER,PASSWORD,NAME}`, `APP_BASE_URL`, `NEXTAUTH_URL`, `AUTH_URL`

Local dev defaults:
```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/home/node/openclaw/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
```

## gstack

gstack skills (`/qa`, `/ship`, `/review`, `/investigate`, `/browse`) are required. If missing, install per global `~/.claude/CLAUDE.md`. Use `/browse` for all web browsing.
