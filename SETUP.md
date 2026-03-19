# Aries AI — Setup

## What this setup covers

This setup is for the current direct Aries architecture:
- Next.js public pages and operator pages
- internal `/api/*` route handlers
- OpenClaw as the execution boundary
- Postgres plus runtime files for persisted state and read models

It does not document removed placeholder routes or legacy workflow-engine references.

## Prerequisites

- Node.js 18+
- npm
- PostgreSQL 16
- OpenClaw Gateway credentials for live execution

## Install

Because the VM sets `NODE_ENV=production` at the OS level, install dependencies like this:

```bash
NODE_ENV=development npm ci
```

## Local environment

Copy the template and export local overrides before running the app:

```bash
cp .env.example .env
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
```

## Database

Start PostgreSQL and initialize the schema:

```bash
sudo pg_ctlcluster 16 main start
npm run db:init
```

## Run the app

Use Turbopack for local development:

```bash
npx next dev -p 3000 --turbopack
```

## Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | ✅ | Base URL for Aries execution calls into OpenClaw |
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | Bearer token for OpenClaw Gateway |
| `DB_HOST` | ✅ | Postgres host |
| `DB_PORT` | ✅ | Postgres port |
| `DB_USER` | ✅ | Postgres user |
| `DB_PASSWORD` | ✅ | Postgres password |
| `DB_NAME` | ✅ | Postgres database |
| `APP_BASE_URL` | ✅ | Public origin used by the app and route generation |
| `NEXTAUTH_URL` | Recommended | Canonical Auth.js URL |
| `AUTH_URL` | Recommended | Alias for the Auth.js public origin |
| `AUTH_TRUST_HOST` | Recommended | Trust forwarded host headers behind a proxy |
| `OPENCLAW_SESSION_KEY` | Optional | OpenClaw session key; defaults to `main` |
| `OPENCLAW_LOBSTER_CWD` | Optional | Workspace-relative directory for Lobster workflows |
| `INTERNAL_API_SECRET` | Optional | Secret for trusted internal callbacks |
| `LOG_LEVEL` | Optional | Runtime log level |

## Runtime execution model

```text
Browser
  -> Next.js page route or /api route
  -> request validation + tenant/session resolution
  -> Aries service layer
      -> OpenClaw Gateway for execution
      -> Postgres/runtime files for state reads and writes
```

### Current UI-facing API routes

| Route | Purpose |
|---|---|
| `POST /api/onboarding/start` | Start tenant onboarding |
| `GET /api/onboarding/status/:tenantId` | Read onboarding status from runtime state |
| `POST /api/marketing/jobs` | Start the canonical `brand_campaign` flow |
| `GET /api/marketing/jobs/:jobId` | Read marketing job status |
| `POST /api/marketing/jobs/:jobId/approve` | Resume an approval-gated marketing run |
| `GET /api/integrations` | Read platform connection cards |
| `POST /api/integrations/connect` | Start a provider connection |
| `POST /api/integrations/disconnect` | Remove a provider connection |
| `POST /api/integrations/sync` | Request a provider sync |
| `GET /api/platform-connections` | Read summarized platform connection health |
| `GET|POST /api/oauth/:provider/*` | OAuth lifecycle routes |
| `POST /api/publish/dispatch` | Submit a publish dispatch request |
| `POST /api/publish/retry` | Retry publish work |
| `POST /api/calendar/sync` | Request calendar synchronization |

## Verification

### 1. Public-route smoke checks
```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
```

### 2. Banned-pattern check
```bash
node scripts/check-banned-patterns.mjs
```

### 3. Marketing-flow smoke path
```bash
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
```

### 4. Homepage performance audit
Start the app:
```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
npx next dev -p 3000 --turbopack
```
Then run:
```bash
mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
```
