# Aries Runtime (Local Direct Architecture)

Aries is a Next.js runtime that serves the public marketing site, the authenticated operator shell, and a browser-safe internal API. The app accepts browser requests on `/` and `/api/*`, validates and shapes those requests inside Next.js route handlers, then either reads local runtime state or calls OpenClaw for execution.

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
- `GET /api/marketing/jobs/latest`
- `GET /api/marketing/jobs/:jobId`
- `POST /api/marketing/jobs/:jobId/approve`
- `GET|PATCH /api/business/profile`
- `GET /api/integrations`
- `POST /api/integrations/connect`
- `POST /api/integrations/disconnect`
- `POST /api/integrations/sync`
- `GET /api/platform-connections`
- `GET|POST /api/oauth/:provider/*`
- `POST /api/publish/dispatch`
- `POST /api/publish/retry`
- `POST /api/calendar/sync`
- `GET /api/tenant/workflows`
- `POST /api/tenant/workflows/:workflowId/runs`
- `GET|POST /api/tenant/profiles`
- `POST /api/tenant/approval-requests/:approvalRequestId/approve`
- `POST /api/tenant/approval-requests/:approvalRequestId/reject`

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
   export OPENCLAW_GATEWAY_LOBSTER_CWD=aries-app/lobster
   export OPENCLAW_LOCAL_LOBSTER_CWD=/home/node/openclaw/aries-app/lobster
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
- `OPENCLAW_GATEWAY_LOBSTER_CWD`
- `OPENCLAW_LOCAL_LOBSTER_CWD`
- `OPENCLAW_LOBSTER_CWD`
- `INTERNAL_API_SECRET`
- `LOG_LEVEL`
- `OAUTH_TOKEN_ENCRYPTION_KEY`
- OAuth client credentials:
  `META_APP_ID`, `META_APP_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
  `X_CLIENT_ID`, `X_CLIENT_SECRET`,
  `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
- Instagram runtime values: `META_PAGE_ID` and `META_ACCESS_TOKEN`

OAuth callbacks are generated from `APP_BASE_URL` using:
- `${APP_BASE_URL}/api/auth/oauth/facebook/callback`
- `${APP_BASE_URL}/api/auth/oauth/linkedin/callback`
- `${APP_BASE_URL}/api/auth/oauth/reddit/callback`
- `${APP_BASE_URL}/api/auth/oauth/tiktok/callback`
- `${APP_BASE_URL}/api/auth/oauth/x/callback`
- `${APP_BASE_URL}/api/auth/oauth/youtube/callback`

Facebook uses the generic OAuth broker with `META_APP_ID` and `META_APP_SECRET`.
Instagram remains env-managed with `META_PAGE_ID` and `META_ACCESS_TOKEN`.

## Marketing workflow contracts

### Client-facing campaign flow (`/api/marketing/jobs*`)
- `POST /api/marketing/jobs` always runs the monolithic `marketing-pipeline.lobster` contract (`run` then `resume`), not atomic stage workflows.
- `payload.brandUrl` is required and normalized to an HTTPS website URL.
- `payload.competitorUrl` is optional, but when present it must be an HTTPS website URL and cannot be a Facebook/Meta locator URL.
- If `competitorUrl` is absent, orchestration falls back to the normalized `brandUrl` for pipeline compatibility.
- Request payload fields are normalized and then hydrated with tenant defaults from persisted business profile data.

### Approval lifecycle (`POST /api/marketing/jobs/:jobId/approve`)
- Start flow creates the first checkpoint at `strategy` (`workflow_step_id: approve_stage_2`).
- Approvals advance checkpoints in order: `approve_stage_2` -> `approve_stage_3` -> `approve_stage_4`.
- Publish can add a second paused-launch checkpoint (`workflow_step_id: approve_stage_4_publish`) before completion.
- If a resume token state is missing in Lobster runtime, Aries reseeds by replaying to the checkpoint and retries once.

### Atomic tenant workflow adapters (`/api/tenant/workflows/*`)
- `GET /api/tenant/workflows` lists workflow IDs from `backend/openclaw/workflow-catalog.ts`.
- `POST /api/tenant/workflows/:workflowId/runs` executes a single adapter workflow and returns `202` on accepted execution.
- These adapters are intentionally separate from client marketing jobs. Use them for tenant-scoped stage execution APIs.
- `/api/tenant/approval-requests/:id/approve|reject` currently returns `501 workflow_approval_not_supported`.

### Atomic workflow input constraints

| Workflow ID | Required input contract |
|---|---|
| `marketing_stage1_research` | At least one locator: `competitor_url`, `competitor`, `facebook_page_url`, `competitor_facebook_url`, `ad_library_url`, or `meta_page_id` |
| `marketing_stage2_strategy_review` | `brand_url` plus either `run_id` (stage-1 cache) or `research_output` |
| `marketing_stage2_strategy_finalize` | `run_id` |
| `marketing_stage3_production_review` | `run_id` (stage-2 cache) or `strategy_handoff` |
| `marketing_stage3_production_finalize` | `run_id` |
| `marketing_stage4_publish_review` | `run_id` (stage-3 cache) or `production_handoff` |
| `marketing_stage4_publish_finalize` | `run_id` |

Deprecated payload transports are rejected with `openclaw_gateway_request_invalid` (examples: `stage1SummaryBase64`, `strategyHandoffBase64`, `productionHandoffPath`, `productionHandoffBase64`).

## Business profile behavior

- `GET /api/business/profile` resolves data from tenant context plus persisted generated files.
- Brand kit source precedence is: latest marketing runtime document, then validated brand-kit file.
- Brand voice/style fallback can come from the latest workspace brief when explicit business-profile fields are missing.
- In public mode (`MARKETING_STATUS_PUBLIC=1`), unauthenticated profile reads/writes are file-backed and tenant IDs are derived from normalized website URL.

## Troubleshooting quick map

| Symptom / error reason | Likely cause | Action |
|---|---|---|
| `onboarding_required` (409) | Missing tenant membership/session for protected flow | Complete onboarding/auth, or use public mode only for local preview |
| `competitor_url must be ...` (400) | Competitor URL is non-HTTPS, localhost/IP, or Meta/social URL | Provide canonical competitor website URL |
| `missing_required_fields:brandUrl` (400) | Campaign creation payload omitted `brandUrl` | Send normalized `brandUrl` |
| `approval_not_available` (409) | Job is not waiting on active checkpoint or approval ID mismatch | Refresh status and approve current checkpoint only |
| `openclaw_gateway_not_configured` / `openclaw_gateway_unreachable` (503) | Gateway env/config/path mismatch | Verify `OPENCLAW_GATEWAY_URL`, token, and Lobster cwd env vars |
| `workflow_approval_not_supported` (501) | Called tenant approval-request endpoints expecting Aries-side resolution | Resolve approval through OpenClaw flow; use job approval endpoint for marketing |

## Validation

Run these commands from the repo root after `npm ci`.

Prefer `npm run verify` for a single fast regression gate; it executes the first three checks with deterministic environment overrides.

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
