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
export CODE_ROOT=/home/node/openclaw/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
export OPENCLAW_GATEWAY_LOBSTER_CWD=aries-app/lobster
export OPENCLAW_LOCAL_LOBSTER_CWD=/home/node/openclaw/aries-app/lobster
export OPENCLAW_LOBSTER_CWD=/home/node/openclaw/aries-app/lobster
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
export MARKETING_STATUS_PUBLIC=1
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
npm run dev
```

`MARKETING_STATUS_PUBLIC=1` is optional, but it makes local review/status links easier to exercise while wiring the campaign workflow.

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
| `OPENCLAW_GATEWAY_LOBSTER_CWD` | Optional | Gateway-facing Lobster cwd (`aries-app/lobster` in containerized/local gateway mode) |
| `OPENCLAW_LOCAL_LOBSTER_CWD` | Optional | Local filesystem Lobster cwd used for local file resolution |
| `OPENCLAW_LOBSTER_CWD` | Optional | Backward-compatible default Lobster cwd |
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
| `GET /api/marketing/jobs/latest` | Read latest marketing job status for current tenant |
| `GET /api/marketing/jobs/:jobId` | Read marketing job status |
| `POST /api/marketing/jobs/:jobId/approve` | Resume an approval-gated marketing run |
| `GET|PATCH /api/business/profile` | Read/update persisted business profile fields |
| `GET /api/integrations` | Read platform connection cards |
| `POST /api/integrations/connect` | Start a provider connection |
| `POST /api/integrations/disconnect` | Remove a provider connection |
| `POST /api/integrations/sync` | Request a provider sync |
| `GET /api/platform-connections` | Read summarized platform connection health |
| `GET|POST /api/oauth/:provider/*` | OAuth lifecycle routes |
| `POST /api/publish/dispatch` | Submit a publish dispatch request |
| `POST /api/publish/retry` | Retry publish work |
| `POST /api/calendar/sync` | Request calendar synchronization |
| `GET /api/tenant/workflows` | List tenant workflow adapters and backing pipelines |
| `POST /api/tenant/workflows/:workflowId/runs` | Run one adapter workflow for current tenant |

## Operational runbooks

### 1. Start a campaign job (client-facing monolithic flow)

`POST /api/marketing/jobs` always starts the monolithic `marketing-pipeline.lobster` run/resume flow.

```bash
curl -sS -X POST "http://localhost:3000/api/marketing/jobs" \
  -H "content-type: application/json" \
  --data '{
    "jobType": "brand_campaign",
    "payload": {
      "brandUrl": "https://brand.example",
      "competitorUrl": "https://competitor.example"
    }
  }'
```

Notes:
- `payload.brandUrl` is required.
- `payload.competitorUrl` is optional, but if provided it must be a canonical HTTPS website URL (not Facebook/Ad Library).
- Public local mode can bypass tenant auth checks for status/approval/profile flows when `MARKETING_STATUS_PUBLIC=1`.

### 2. Advance an approval checkpoint

```bash
curl -sS -X POST "http://localhost:3000/api/marketing/jobs/<jobId>/approve" \
  -H "content-type: application/json" \
  --data '{
    "approvedBy": "operator@example.com",
    "approvedStages": ["strategy"]
  }'
```

Checkpoint order is:
- `approve_stage_2` (strategy)
- `approve_stage_3` (production)
- `approve_stage_4` (publish review)
- Optional `approve_stage_4_publish` for paused publish creation

### 3. Run an atomic tenant workflow adapter

Use this for adapter-level execution APIs, not for client campaign jobs.

```bash
curl -sS -X POST "http://localhost:3000/api/tenant/workflows/marketing_stage2_strategy_review/runs" \
  -H "content-type: application/json" \
  --data '{
    "idempotencyKey": "demo-stage2-1",
    "inputs": {
      "brand_url": "https://brand.example",
      "run_id": "run-stage1"
    }
  }'
```

### 4. Read or patch business profile defaults

```bash
curl -sS "http://localhost:3000/api/business/profile"
curl -sS -X PATCH "http://localhost:3000/api/business/profile" \
  -H "content-type: application/json" \
  --data '{
    "websiteUrl": "https://brand.example",
    "businessName": "Brand Example",
    "primaryGoal": "Generate qualified demos",
    "competitorUrl": "https://competitor.example"
  }'
```

In authenticated mode, writes require `tenant_admin`. In public mode, writes are file-backed and tenant ID is derived from website URL.

## Common pitfalls

| Symptom | Why it happens | Fix |
|---|---|---|
| `missing_required_fields:brandUrl` | Campaign create payload omitted brand URL | Provide `payload.brandUrl` |
| `competitor_url must be ...` | Competitor URL is non-HTTPS, localhost/IP, or social/Meta URL | Provide canonical competitor website URL |
| `approval_not_available` | Approval called for wrong or stale checkpoint | Fetch latest job status and approve the current stage |
| `openclaw_gateway_not_configured` / `openclaw_gateway_unreachable` | Gateway URL/token/cwd mismatch | Verify `OPENCLAW_GATEWAY_URL`, token, and Lobster cwd vars |
| `workflow_approval_not_supported` | Called `/api/tenant/approval-requests/*` expecting Aries-side resolution | Route approvals through the OpenClaw process; use marketing job approval endpoint for campaigns |

## Verification

Prefer `npm run verify` for a single fast regression gate; it runs the first three checks with deterministic environment overrides.

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
