# Aries AI — Setup Instructions

## Prerequisites

- **Node.js 18+** and npm
- **n8n instance** with API access enabled
- Environment variables configured (see `.env.example`)

## Recommended container parity flow

```bash
# Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   N8N_BASE_URL=https://your-n8n-instance.com
#   N8N_API_KEY=your-api-key
#   CODE_ROOT=/app
#   DATA_ROOT=/data

# Build and run with parity compose stack
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Parity guarantees apply to this container-based flow.

## Optional host-node flow

```bash
npm install
cp .env.example .env
# For host execution, set CODE_ROOT/DATA_ROOT to host-valid paths (or leave unset).
npm run dev
```

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `N8N_BASE_URL` | ✅ | Base URL of your n8n instance (e.g. `https://n8n.example.com`) |
| `N8N_API_KEY` | ✅ | n8n API key for server-side workflow management |
| `CODE_ROOT` | Optional | Immutable code root inside container (default: `/app`) |
| `DATA_ROOT` | Optional | Writable runtime data root (default: `/data`) |
| `APP_BASE_URL` | Optional | Public URL of the Aries app (default: `http://localhost:3000`) |
| `NODE_ENV` | Optional | `development` or `production` |
| `PORT` | Optional | Server port (default: 3000) |
| `LOG_LEVEL` | Optional | Logging level (default: `info`) |
| `META_APP_ID` | Optional | Meta/Facebook app ID for OAuth |
| `META_APP_SECRET` | Optional | Meta/Facebook app secret |
| `META_REDIRECT_URI` | Optional | Meta OAuth callback URL |

## n8n Workflow Bindings

The following n8n webhooks are actively used by the API layer:

| API Route | n8n Webhook | Purpose |
|---|---|---|
| `/api/demo` | `/webhook/tenant-provisioning` | Demo tenant creation |
| `/api/sandbox/launch` | `/webhook/tenant-provisioning` | Sandbox provisioning |
| `/api/onboarding/start` | `/webhook/tenant-provisioning` | Tenant onboarding |
| `/api/marketing/jobs` | `/webhook/marketing-research` | Start marketing pipeline |
| `/api/marketing/jobs/:id/approve` | `/webhook/marketing-approval-resume` | Resume after approval |
| `/api/publish/dispatch` | `/webhook/aries/publish` | Cross-platform publishing |

**Not yet wired** (log-only stubs):
- `/api/contact` — no `contact-form` workflow in n8n
- `/api/waitlist` — no `waitlist-signup` workflow in n8n
- `/api/events` — no `event-tracking` workflow in n8n

## Frontend/Backend Wiring

```
Browser → /api/* (Next.js route handlers)
               ↓
         lib/api-service.ts (postToN8n)
               ↓
         N8N_BASE_URL/webhook/* (n8n workflows)
```

- **Frontend** calls internal `/api/*` routes only — never raw n8n webhooks
- **API layer** (`app/api/*/route.ts`) validates input, builds payloads, proxies to n8n
- **Service layer** (`lib/api-service.ts`) handles timeouts, error normalization, structured logging
- **Config** (`lib/config.ts`) reads env vars server-side — credentials never reach the browser

## Architecture

- **Marketing site**: `/`, `/features`, `/documentation`, `/api-docs`, `/contact`
- **App shell**: `/dashboard`, `/posts`, `/calendar`, `/platforms`, `/settings`
- **Navigation**: Marketing nav and app-shell nav are separate layouts (`MarketingLayout` vs `AppShellLayout`)
- **Design**: Dark-luxury tech aesthetic with Aries brand palette

See `ROUTE_MANIFEST.md` and `WEBHOOK_MANIFEST.md` for complete reference.

## Container parity workflow

Use base + local override so local and deployment run the same image contract:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Production-oriented deployments should provide image + env/secrets + a persistent mount for `/data`, without bind mounting the repo into `/app`.
