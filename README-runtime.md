# Aries Runtime (Local Direct Architecture)

Aries is a Next.js 15 runtime that serves the public marketing site, the authenticated operator shell, and a browser-safe internal API. The app accepts browser requests on `/` and `/api/*`, validates and shapes those requests inside Next.js route handlers, then either reads local runtime state or calls OpenClaw for execution.

## Direct architecture

```text
Browser
  -> public pages (`/`, `/features`, `/documentation`, `/api-docs`)
  -> operator pages (`/dashboard`, `/platforms`, `/settings`, `/posts`, `/calendar`)
  -> workflow pages (`/onboarding/*`, `/marketing/*`, `/oauth/connect/:provider`)
  -> Next.js route handlers (`app/api/*`)
      -> Aries domain services (`backend/*`, `lib/*`)
          -> OpenClaw Gateway for execution
          -> Postgres + runtime files under DATA_ROOT for read models and state
```

## Supported route surface

### Public pages
- `/`
- `/features`
- `/documentation`
- `/api-docs`

### Operator and workflow pages
- `/dashboard`
- `/platforms`
- `/settings`
- `/posts`
- `/calendar`
- `/onboarding/start`
- `/onboarding/status`
- `/marketing/new-job`
- `/marketing/job-status`
- `/marketing/job-approve`
- `/oauth/connect/:provider`

### Internal API contract used by the UI
- `POST /api/onboarding/start`
- `GET /api/onboarding/status/:tenantId`
- `POST /api/marketing/jobs`
- `GET /api/marketing/jobs/:jobId`
- `POST /api/marketing/jobs/:jobId/approve`
- `GET /api/integrations`
- `POST /api/integrations/connect`
- `POST /api/integrations/disconnect`
- `POST /api/integrations/sync`
- `GET /api/platform-connections`
- `GET|POST /api/oauth/:provider/*`
- `POST /api/publish/dispatch`
- `POST /api/publish/retry`
- `POST /api/calendar/sync`

This document intentionally excludes removed placeholder endpoints and unsupported public intake routes.

## Local setup

1. Install dependencies with dev dependencies enabled:
   ```bash
   NODE_ENV=development npm ci
   ```
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
3. Export local overrides so VM-level environment variables do not leak into the app:
   ```bash
   export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
   export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
   export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
   ```
4. Initialize the database when needed:
   ```bash
   npm run db:init
   ```
5. Start the dev server with Turbopack:
   ```bash
   npx next dev -p 3000 --turbopack
   ```

## Required environment variables for live execution

- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `APP_BASE_URL`
- `NEXTAUTH_URL`
- `AUTH_URL`

Optional but commonly used:
- `OPENCLAW_SESSION_KEY`
- `OPENCLAW_LOBSTER_CWD`
- `INTERNAL_API_SECRET`
- `LOG_LEVEL`
- provider OAuth credentials such as `META_APP_ID`, `META_APP_SECRET`, and `META_REDIRECT_URI`

## Validation

Run these commands from the repo root after `npm ci`.

### Public-route smoke checks
```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
```

### Banned-pattern check
```bash
node scripts/check-banned-patterns.mjs
```

### Marketing-flow smoke path
```bash
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
```

### Homepage performance audit
1. Start the app locally:
   ```bash
   export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
   export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
   export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
   npx next dev -p 3000 --turbopack
   ```
2. In another shell, run Lighthouse:
   ```bash
   mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
   ```
