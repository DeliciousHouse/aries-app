# Aries Runtime (Local Direct Architecture)

Aries is a Next.js 15 runtime that serves the public marketing site, the authenticated operator shell, and a browser-safe internal API. The app accepts browser requests on `/` and `/api/*`, validates and shapes those requests inside Next.js route handlers, then either reads local runtime state or calls OpenClaw for execution.

## Direct architecture

```text
Browser
  -> public pages (`/`, `/features`, `/documentation`, `/api-docs`)
  -> operator pages (`/dashboard`, `/dashboard/campaigns`, `/dashboard/posts`, `/dashboard/calendar`, `/dashboard/results`, `/dashboard/settings`, `/review`)
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
- `/dashboard/campaigns`
- `/dashboard/campaigns/:campaignId`
- `/dashboard/posts`
- `/dashboard/calendar`
- `/dashboard/results`
- `/dashboard/settings`
- `/review`
- `/review/:reviewId`
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

## Optional host-node flow
- Dev: `npm run dev`
- Build: `npm run build`
- Start: `npm run start`
- Precheck: `npm run precheck`
- Verify regression suite: `npm run verify`

Use the same `npm run verify` command locally and in CI for the fast runtime regression gate.

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
   export CODE_ROOT=/home/node/openclaw/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
   export OPENCLAW_LOBSTER_CWD=/home/node/openclaw/aries-app/lobster
   export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
   export MARKETING_STATUS_PUBLIC=1
   ```
4. Initialize the database when needed:
   ```bash
   npm run db:init
   ```
5. Start the dev server with Turbopack:
   ```bash
   npm run dev
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
- `OAUTH_TOKEN_ENCRYPTION_KEY`
- OAuth client credentials:
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
  `X_CLIENT_ID`, `X_CLIENT_SECRET`,
  `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
- Meta runtime values: `META_PAGE_ID` and `META_ACCESS_TOKEN`

OAuth callbacks are generated from `APP_BASE_URL` for non-Meta providers:
- `${APP_BASE_URL}/api/auth/oauth/linkedin/callback`
- `${APP_BASE_URL}/api/auth/oauth/reddit/callback`
- `${APP_BASE_URL}/api/auth/oauth/tiktok/callback`
- `${APP_BASE_URL}/api/auth/oauth/x/callback`
- `${APP_BASE_URL}/api/auth/oauth/youtube/callback`

Meta publishing remains env-managed with `META_PAGE_ID` and `META_ACCESS_TOKEN`.

## Validation

Run these commands from the repo root after `npm ci`.

Prefer `npm run verify` for a single fast regression gate; it executes the current targeted checks with deterministic environment overrides.

### Public-route smoke checks
```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
```

### Banned-pattern check
```bash
node scripts/check-banned-patterns.mjs
```

### Repo-boundary check
```bash
npm run validate:repo-boundary
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
