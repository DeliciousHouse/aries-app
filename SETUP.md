# Aries AI — Setup

## What this setup covers

This setup is for the current direct Aries architecture:
- Next.js public pages and operator pages
- internal `/api/*` route handlers
- Hermes-native weekly social content execution
- Postgres plus runtime files for persisted state and read models

It does not document removed placeholder routes or legacy workflow-engine references.

## Prerequisites

- Node.js 18+
- npm
- PostgreSQL 16
- Hermes Gateway credentials plus an internal callback secret for live execution

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
export CODE_ROOT=/home/node/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
export ARIES_EXECUTION_PROVIDER=hermes ARIES_MARKETING_EXECUTION_PROVIDER=hermes
export HERMES_GATEWAY_URL=http://127.0.0.1:8642 HERMES_API_SERVER_KEY=replace-me HERMES_SESSION_KEY=main
export INTERNAL_API_SECRET=replace-me
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
export NEXTAUTH_SECRET=replace-me
export MARKETING_STATUS_PUBLIC=1
```

If you are also testing Aries-managed OAuth providers, add:

```bash
export OAUTH_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)"
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

`MARKETING_STATUS_PUBLIC=1` is optional, but it makes local review/status links easier to exercise while wiring the weekly social content workflow.

## Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `APP_BASE_URL` | ✅ | Public origin used by the app and callback URL generation |
| `INTERNAL_API_SECRET` | ✅ | Shared secret for Hermes callbacks to `/api/internal/hermes/runs` |
| `HERMES_GATEWAY_URL` | ✅ | Base URL for Aries execution submissions into Hermes |
| `HERMES_API_SERVER_KEY` | ✅ | Bearer token for Hermes `/v1/runs` |
| `HERMES_SESSION_KEY` | ✅ | Session key used for Hermes-submitted runs |
| `DB_HOST` | ✅ | Postgres host |
| `DB_PORT` | ✅ | Postgres port |
| `DB_USER` | ✅ | Postgres user |
| `DB_PASSWORD` | ✅ | Postgres password |
| `DB_NAME` | ✅ | Postgres database |
| `NEXTAUTH_URL` | ✅ | Canonical Auth.js URL |
| `AUTH_URL` | ✅ | Alias for the Auth.js public origin |
| `NEXTAUTH_SECRET` | ✅ | Auth.js signing secret |
| `AUTH_TRUST_HOST` | ✅ | Trust forwarded host headers behind a proxy |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | ✅ for Aries-managed OAuth providers | Stable 32-byte base64 key for encrypting OAuth tokens; generate with `openssl rand -base64 32` |
| `ARIES_EXECUTION_PROVIDER` | Optional | Defaults to `hermes`; set `legacy-openclaw` only for deprecated flows |
| `ARIES_MARKETING_EXECUTION_PROVIDER` | Optional | Defaults to `hermes`; set `legacy-openclaw` only for deprecated flows |
| `LOG_LEVEL` | Optional | Runtime log level |

### Weekly media auth boundary

- Weekly social content image/video generation does not require an Aries-side ChatGPT / OpenAI connection. Hermes owns ChatGPT/OpenAI auth for weekly media work.
- Text planning can run without media generation when image/video is disabled in the request.

### Legacy OpenClaw/Lobster variables (deprecated)

Keep these only when intentionally running legacy `brand_campaign` compatibility flows:

- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_SESSION_KEY`
- `ARTIFACT_PIPELINE_CWD`
- `ARTIFACT_PIPELINE_GATEWAY_CWD`
- `ARTIFACT_PIPELINE_LOCAL_CWD`
- `ARTIFACT_STAGE1_CACHE_DIR`
- `ARTIFACT_STAGE2_CACHE_DIR`
- `ARTIFACT_STAGE3_CACHE_DIR`
- `ARTIFACT_STAGE4_CACHE_DIR`
- `LOBSTER_MEDIA_GATEWAY_ENABLED`
- `GEMINI_API_KEY`

## Runtime execution model

```text
Browser
  -> Next.js page route or /api route
  -> request validation + tenant/session resolution
  -> Aries service layer
      -> Hermes /v1/runs and authenticated callbacks for execution
      -> Postgres/runtime files for state reads and writes
```

### Current UI-facing API routes

| Route | Purpose |
|---|---|
| `POST /api/onboarding/start` | Start tenant onboarding |
| `GET /api/onboarding/status/:tenantId` | Read onboarding status from runtime state |
| `POST /api/social-content/jobs` | Start Hermes-native weekly social content generation |
| `GET /api/social-content/jobs/:jobId` | Read weekly social content job status |
| `POST /api/social-content/jobs/:jobId/approve` | Approve optional render/publish stages |
| `GET /api/integrations` | Read platform connection cards |
| `POST /api/integrations/connect` | Start a provider connection |
| `POST /api/integrations/disconnect` | Remove a provider connection |
| `POST /api/integrations/sync` | Request a provider sync |
| `GET /api/platform-connections` | Read summarized platform connection health |
| `GET|POST /api/oauth/:provider/*` | OAuth lifecycle routes |
| `POST /api/publish/dispatch` | Submit a publish dispatch request |
| `POST /api/publish/retry` | Retry publish work |
| `POST /api/calendar/sync` | Request calendar synchronization |

### Weekly social content operational flow

1. Client calls `POST /api/social-content/jobs`.
2. Aries submits the run to Hermes with tenant-scoped callback metadata.
3. Hermes sends authenticated status callbacks to `POST /api/internal/hermes/runs`.
4. Aries updates runtime state and UI-safe read models.
5. User reviews the weekly content calendar and post outputs.
6. User approves optional video render/publish actions.

## Verification

Prefer `npm run verify` for a single fast regression gate; it runs the first three checks with deterministic environment overrides.

Use `npm run validate:execution-provider` after changing Hermes callback, run-store, or marketing execution-port behavior. Use `npm run validate:social-content` after changing weekly social-content payloads, routes, or operator copy.

### 1. Public-route smoke checks
```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
```

### 2. Banned-pattern check
```bash
node scripts/check-banned-patterns.mjs
```

### 3. Social-content smoke path
```bash
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/social-content-weekly-defaults.test.ts tests/social-content-execution-contract.test.ts tests/marketing-job-route.smoke.test.ts
```

### 4. Legacy marketing compatibility checks
```bash
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
```

### 5. Homepage performance audit
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
