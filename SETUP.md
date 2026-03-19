# Aries AI — Setup Instructions

## Prerequisites

- **Node.js 18+** and npm
- **Repo-managed workflow artifacts** available under `workflows/`
- Environment variables configured (see `.env.example`)

## Recommended container parity flow

```bash
# Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   CODE_ROOT=/app
#   DATA_ROOT=/data
#   OPENCLAW_GATEWAY_URL=http://host.docker.internal:18789
#   OPENCLAW_GATEWAY_TOKEN=...

# Build and run with parity compose stack
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Parity guarantees apply to this container-based flow.

## Optional host-node flow

```bash
NODE_ENV=development npm ci
cp .env.example .env
# For host execution, set CODE_ROOT/DATA_ROOT to host-valid paths (or leave unset).
npx next dev -p 3000 --turbopack
```

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | ✅ | Base URL of the OpenClaw Gateway Aries should call for workflow execution |
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | Bearer token for the OpenClaw Gateway |
| `OPENCLAW_SESSION_KEY` | Optional | Gateway session key (default: `main`) |
| `OPENCLAW_LOBSTER_CWD` | Optional | Workspace-relative directory containing Lobster workflows (default: `lobster`) |
| `CODE_ROOT` | Optional | Immutable code root inside container (default: `/app`) |
| `DATA_ROOT` | Optional | Writable runtime data root (default: `/data`) |
| `APP_BASE_URL` | Optional | Public URL of the Aries app (default: `http://localhost:3000`) |
| `NEXTAUTH_URL` | Recommended | Canonical public URL for Auth.js callbacks (example: `https://aries.sugarandleather.com`) |
| `AUTH_URL` | Optional | Auth.js alias for canonical URL; set same value as `NEXTAUTH_URL` |
| `AUTH_TRUST_HOST` | Recommended in production | Set `true` behind a trusted reverse proxy/load balancer so Auth.js accepts forwarded host headers |
| `NODE_ENV` | Optional | `development` or `production` |
| `PORT` | Optional | Server port (default: 3000) |
| `INTERNAL_API_SECRET` | Optional | Reserved for trusted internal callbacks; the marketing pipeline no longer relies on an internal runtime-artifact creation route |
| `LOG_LEVEL` | Optional | Logging level (default: `info`) |
| `META_APP_ID` | Optional | Meta/Facebook app ID for OAuth |
| `META_APP_SECRET` | Optional | Meta/Facebook app secret |
| `META_REDIRECT_URI` | Optional | Meta OAuth callback URL |

## OpenClaw Workflow Bindings

The following OpenClaw-bound workflows are actively used by the API layer:

| API Route | Repo Workflow | Purpose |
|---|---|---|
| `/api/demo` | `parity/demo-start/workflow.lobster` | Demo tenant creation parity stub |
| `/api/sandbox/launch` | `parity/sandbox-launch/workflow.lobster` | Sandbox provisioning parity stub |
| `/api/onboarding/start` | `parity/onboarding-start/workflow.lobster` | Tenant onboarding parity stub |
| `/api/marketing/jobs` | `stage-1-research/workflow.lobster` + `stage-2-strategy/review-workflow.lobster` | Create a job, execute research, execute strategy, and pause at strategy approval |
| `/api/marketing/jobs/:id/approve` | Stage-specific finalize/review workflows under `stage-2`, `stage-3`, and `stage-4` | Resume the persisted job through the next real checkpoint |
| `/api/publish/dispatch` | `parity/publish-dispatch/workflow.lobster` | Publish parity stub until a route-shaped stage-4 pipeline exists |
| `/api/publish/retry` | `parity/publish-retry/workflow.lobster` | Publish repair / retry parity stub |
| `/api/calendar/sync` | `parity/calendar-sync/workflow.lobster` | Calendar synchronization parity stub |
| `/api/integrations/sync` | `parity/integrations-sync/workflow.lobster` | Platform sync parity stub |

**Not yet wired** (explicit `501` placeholders that still log payloads):
- `/api/contact` — no contact intake workflow yet
- `/api/waitlist` — no waitlist signup workflow yet
- `/api/events` — no event tracking workflow yet

## Frontend/Backend Wiring

```
Browser → /api/* (Next.js route handlers)
               ↓
      OpenClaw Gateway client OR local read-model/status view
               ↓
 `backend/openclaw/*` + backend read-model/status logic
```

- **Frontend** calls internal `/api/*` routes only
- **API layer** (`app/api/*/route.ts`) validates input, then either calls OpenClaw Gateway, reads Aries-owned runtime state, or returns an explicit unavailable/error response
- **Frontend-safe contracts** avoid exposing workflow artifact paths or raw backend envelopes to browser code
- **Authoritative workflow definitions** live in the OpenClaw workspace, not the Aries runtime image

## Architecture

- **Marketing site**: `/`, `/features`, `/documentation`, `/api-docs`, `/contact`
- **App shell**: `/dashboard`, `/posts`, `/calendar`, `/platforms`, `/settings`
- **Workflow screens**: `/onboarding/start`, `/onboarding/status`, `/marketing/new-job`, `/marketing/job-status`, `/marketing/job-approve`
- **Navigation**: Marketing nav and app-shell nav are separate layouts with redesigned shells
- **Design**: Dark glass + neon-accent operator aesthetic rebuilt in-repo from the visual reference

See `ROUTE_MANIFEST.md` and `WEBHOOK_MANIFEST.md` for complete reference.

## Container parity workflow

Use base + local override so local and deployment run the same image contract:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Production-oriented deployments should provide image + env/secrets + a persistent mount for `/data`, without bind mounting the repo into `/app`.
