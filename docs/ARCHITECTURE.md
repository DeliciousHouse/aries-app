# Aries AI — Architecture

## Overview

Aries AI is a Next.js 16 App Router application for weekly social content automation. It combines a public marketing site, an authenticated operator shell, and browser-safe internal APIs that hand execution off to Hermes while keeping runtime state in PostgreSQL.

## Request and data flow

```
Browser
  └─> Next.js pages (app/*)
        └─> Next.js route handlers (app/api/*)
              └─> Aries backend services (backend/*, lib/*)
                    ├─> Hermes gateway  →  /api/internal/hermes/runs callbacks
                    └─> PostgreSQL + DATA_ROOT files
```

1. **Browser** talks only to Next.js pages and route handlers inside this repo.
2. **Route handlers** validate the request, resolve auth/tenant context, call a backend service, and return a typed, frontend-safe response.
3. **Backend services** (`backend/*`) own domain logic for onboarding, marketing, auth, integrations, and execution.
4. **Hermes** ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) is the sole execution provider. Long-running workflows are submitted to `HERMES_GATEWAY_URL/v1/runs`. Hermes posts authenticated status callbacks to `POST /api/internal/hermes/runs`, which advances runtime state inside Aries.
5. **PostgreSQL** stores durable state: users, organizations, tenant memberships, OAuth tokens, creative assets, execution run records, and publish state.
6. **`DATA_ROOT`** is a writable bind mount for generated draft and validated artifacts produced by Hermes callbacks.

## Repository layout

```
app/         Next.js pages, layouts, and route handlers (UI contract lives here)
backend/     Server-side domain logic
  auth/        Auth helpers, tenant membership queries
  execution/   Execution provider boundary (Hermes adapter + run store)
  integrations/ OAuth token lifecycle, provider adapters, publishing normalization
  marketing/   Social content pipeline orchestration
  onboarding/  Tenant onboarding domain
  social-content/ Weekly content job handlers
  tenant/      Tenant profile and workflow management
  video/       Video artifact helpers
components/  Shared UI primitives
lib/         Shared runtime helpers — DB pool, auth helpers, tenant context, crypto
scripts/     Startup, DB init, validation, and repo-guard scripts
tests/       Route, API, auth, and runtime regression coverage
```

## Authenticated operator pages

All operator routes require a valid next-auth v5 session with resolved tenant context. Middleware enforces authentication at the edge; route handlers additionally call `loadTenantContextForUser` to verify tenant membership before touching tenant-scoped data.

Operator pages:

| Route | Purpose |
|---|---|
| `/dashboard` | Operator overview |
| `/dashboard/campaigns` | Campaign list and workspace |
| `/dashboard/posts` | Publish controls |
| `/dashboard/calendar` | Scheduling calendar |
| `/dashboard/settings` | Tenant settings |
| `/review`, `/review/:reviewId` | Content review queue |

## OAuth routes

Aries implements a broker-style OAuth surface for all supported providers:

| Pattern | Purpose |
|---|---|
| `/api/auth/[...nextauth]` | next-auth v5 session routes |
| `/api/auth/oauth/[provider]/callback` | OAuth authorization code exchange |
| `/api/auth/oauth/[provider]/connect` | Start a new provider connection |
| `/api/auth/oauth/[provider]/disconnect` | Remove a connection |
| `/api/auth/oauth/[provider]/reconnect` | Force token refresh / reauth |
| `/api/oauth/[provider]/start` | Build the authorization URL and redirect |
| `/api/oauth/[provider]/callback` | Callback landing page |
| `/api/oauth/[provider]/refresh` | Refresh an existing token |
| `/oauth/connect/[provider]` | UI handoff and result page |

OAuth tokens (LinkedIn, X, YouTube, Reddit, TikTok) are encrypted with `OAUTH_TOKEN_ENCRYPTION_KEY` before storage. Meta publishing uses long-lived `META_PAGE_ID` / `META_ACCESS_TOKEN` env vars managed outside the Aries OAuth broker.

## Hermes callback execution boundary

Aries does not execute workflows itself — Hermes does. Aries' only standing processes are lightweight delivery/maintenance side-processes (the run reconciler, stale-run reaper, and kanban GC). The execution boundary is:

1. Aries submits a run to Hermes: `POST HERMES_GATEWAY_URL/v1/runs` with `Authorization: Bearer HERMES_API_SERVER_KEY`.
2. Hermes `/v1/runs` is a **polled** API — it executes the workflow asynchronously but does not invoke the submission's `callback_url`. The durable Hermes run reconciler side-process (`backend/marketing/hermes-reconciler.ts`, spawned by `start-runtime.mjs`) polls in-flight runs to completion and, for each finished run, feeds the same idempotent callback path internally (deterministic `event_id = reconcile-<hermesRunId>`). The external `POST APP_BASE_URL/api/internal/hermes/runs` route (`Authorization: Bearer INTERNAL_API_SECRET`) remains the trusted ingestion boundary for callbacks.
3. The callback route (`app/api/internal/hermes/runs/route.ts`) verifies the bearer token with a constant-time compare, validates the payload, verifies a per-run callback token (SHA-256 hash stored in the DB), then calls `handleHermesRunCallback` to advance job state and read models.

`HERMES_API_SERVER_KEY` and `INTERNAL_API_SECRET` are intentionally separate secrets: the first is outbound (Aries → Hermes), the second is inbound (Hermes → Aries).

For the weekly social content marketing pipeline, Aries routes execution across three Hermes profiles:

| Stage | Hermes profile | Gateway env var |
|---|---|---|
| Research | `aries-research` | `HERMES_RESEARCH_GATEWAY_URL` (defaults to main gateway) |
| Strategy + publish | `aries-strategist` | `HERMES_STRATEGIST_GATEWAY_URL` |
| Content generation | `aries-content-generator` | `HERMES_CONTENT_GATEWAY_URL` |

A single-gateway deployment can leave all three profile vars blank; each falls back to `HERMES_GATEWAY_URL`.

## PostgreSQL runtime state

All durable state lives in PostgreSQL. The schema is initialized by `npm run db:init` (`scripts/init-db.js`). Key tables:

- `users` — user accounts, password hashes, organization membership
- `organizations` — tenant organizations
- `oauth_tokens` — encrypted provider tokens with expiry metadata
- `platform_connections` — provider connection health and sync state
- `creative_assets` — Hermes-owned generated media metadata
- `execution_runs` — run records with callback token hashes, status, and result payload
- `marketing_jobs` / `social_content_jobs` — job tracking and status read models
- `publish_items` — per-item publish state and retry metadata
- `calendar_events` — scheduled post calendar entries

## Marketing pipeline

The weekly social content pipeline is Aries's primary production workflow:

1. Client calls `POST /api/social-content/jobs` with tenant and job parameters.
2. `backend/marketing/` orchestrates run submission to Hermes.
3. Hermes posts callbacks as each stage completes (research → strategy → content generation → media generation → publish).
4. Each callback updates `execution_runs`, `marketing_jobs`, and related read models.
5. The operator reviews content at `/review` and approves optional publish steps via `POST /api/social-content/jobs/:jobId/approve`.
6. Publishing dispatches through `POST /api/publish/dispatch`, which normalizes content through provider adapters and submits to the live provider APIs.

Weekly media generation (images, video) is executed inside Hermes using ChatGPT/OpenAI auth owned by Hermes. Aries sends abstract media requests and receives populated asset records via callback. Text-only planning runs without media generation enabled.

## Publishing and integration surfaces

Aries supports publishing to Facebook, Instagram (via Meta), LinkedIn, X, YouTube, TikTok, and Reddit. Each provider has a typed adapter in `backend/integrations/adapters/` that normalizes the `PublishDispatchEvent` into the provider's required payload shape.

Publish, retry, and calendar sync routes:

- `POST /api/publish/dispatch` — submit publish work
- `POST /api/publish/retry` — retry a failed publish item
- `POST /api/calendar/sync` — synchronize the scheduled post calendar

## Process model

The production container runs `scripts/start-runtime.mjs`, which defaults to Node cluster mode (`ARIES_PROCESS_MANAGER=cluster`) with `ARIES_WEB_CONCURRENCY=2` workers. A stale-run reaper side-process marks stuck marketing jobs `failed_stale` every 5 minutes. A Hermes kanban GC side-process archives completed tasks on a configurable interval. A Hermes run reconciler side-process (`ARIES_RECONCILER_ENABLED=1`, default ON) re-discovers in-flight marketing runs every `ARIES_RECONCILER_INTERVAL_MS` (default 60s) and ingests any Hermes has finished, via the same idempotent callback path; it is the durable delivery mechanism that drives polled Hermes runs to completion (see the Hermes callback execution boundary below).

Health and readiness:

- `GET /` — container liveness
- `GET /api/health/db` — returns pool stats and round-trip latency; use as the load-balancer readiness probe
