# Aries AI

Aries AI is a Next.js App Router application for marketing automation. It combines a public marketing site, an authenticated operator shell, and browser-safe internal APIs that hand execution off to an external OpenClaw Gateway while keeping runtime state on the server. The current repository ships the web runtime, route handlers, backend service layer, local runtime state helpers, and tests for the supported route contract.

## What the project includes

- **Public marketing pages** for the homepage, features, documentation, and API docs.
- **Authenticated operator pages** for dashboard, platforms, posts, calendar, and settings.
- **Workflow UIs** for onboarding, marketing job creation/status/approval, and OAuth provider connection flows.
- **Internal API routes** under `app/api/*` that validate requests, resolve auth and tenant context, and shape frontend-safe responses.
- **Backend services** under `backend/*` for onboarding, marketing jobs, auth/session checks, platform integrations, OpenClaw handoff, and runtime state management.
- **Local runtime persistence** backed by PostgreSQL plus generated files beneath `DATA_ROOT`.
- **Regression tests** covering route rendering, frontend API contracts, tenant isolation, marketing flow behavior, OAuth wiring, and banned-pattern assertions.

## Architecture at a glance

```text
Browser
  -> Next.js pages (`app/*`)
  -> Next.js route handlers (`app/api/*`)
      -> Aries backend services (`backend/*`, `lib/*`)
          -> OpenClaw Gateway for workflow execution
          -> PostgreSQL + runtime files under DATA_ROOT for state and read models
```

### Core runtime ideas

1. **Aries owns the browser boundary.** The UI talks only to Next.js pages and route handlers in this repo.
2. **Execution leaves through OpenClaw.** Long-running or workflow-style execution is delegated through the OpenClaw Gateway instead of exposing workflow infrastructure directly to the browser.
3. **The UI consumes safe read models.** Route handlers return frontend-safe payloads instead of leaking raw runtime files or internal workflow details.
4. **Tenant context matters.** Marketing, integrations, and approval flows are tenant-aware and are validated server-side.

## Tech stack

- **Framework:** Next.js App Router
- **Version currently pinned:** Next.js `16.2.3`
- **UI:** React 18, Tailwind CSS v4, custom frontend screens/components
- **Auth:** `next-auth` v5 beta plus tenant/auth runtime helpers
- **Data/storage:** PostgreSQL (`pg`) plus generated runtime files under `DATA_ROOT`
- **Execution boundary:** OpenClaw Gateway + Lobster workflow integration
- **Testing:** Node.js built-in test runner via `tsx --test`
- **Language/tooling:** TypeScript, tsx, PostCSS

## Current route surface

### Public pages

- `/`
- `/features`
- `/documentation`
- `/api-docs`
- `/login`

### Operator pages

- `/dashboard`
- `/platforms`
- `/posts`
- `/calendar`
- `/settings`

### Workflow pages

- `/onboarding/start`
- `/onboarding/pipeline-intake` (legacy redirect to `/onboarding/start`)
- `/onboarding/status`
- `/marketing/new-job`
- `/marketing/job-status`
- `/marketing/job-approve`
- `/oauth/connect/[provider]`

### API routes

#### Auth and OAuth
- `/api/auth/[...nextauth]`
- `/api/auth/oauth/[provider]/callback`
- `/api/auth/oauth/[provider]/connect`
- `/api/auth/oauth/[provider]/disconnect`
- `/api/auth/oauth/[provider]/reconnect`
- `/api/oauth/[provider]/start`
- `/api/oauth/[provider]/callback`
- `/api/oauth/[provider]/disconnect`
- `/api/oauth/[provider]/refresh`

#### Onboarding and marketing
- `/api/onboarding/start`
- `/api/onboarding/status/[tenantId]`
- `/api/marketing/jobs`
- `/api/marketing/jobs/[jobId]`
- `/api/marketing/jobs/[jobId]/approve`

#### Integrations and publishing
- `/api/integrations`
- `/api/integrations/connect`
- `/api/integrations/disconnect`
- `/api/integrations/sync`
- `/api/platform-connections`
- `/api/publish/dispatch`
- `/api/publish/retry`
- `/api/calendar/sync`

#### Tenant and internal support routes
- `/api/demo`
- `/api/internal/marketing/job-runtime`
- `/api/sandbox/launch`
- `/api/tenant/profiles`
- `/api/tenant/profiles/[userId]`
- `/api/tenant/workflows`
- `/api/tenant/workflows/[workflowId]/runs`
- `/api/tenant/approval-requests/[approvalRequestId]/approve`
- `/api/tenant/approval-requests/[approvalRequestId]/reject`

## Repository layout

```text
app/         Next.js pages, layouts, and route handlers
backend/     Server-side domain logic for onboarding, marketing, auth, integrations, and OpenClaw
components/  Shared UI primitives and redesign components
lib/         Shared runtime helpers, auth helpers, API utilities, and DB access
scripts/     Startup, verification, DB init, and repo validation scripts
tests/       Route, API, auth, and runtime regression coverage
lobster/     Lobster workflow-related assets and docs
skills/      Repository-specific skill docs
```

## Local development

### Prerequisites

- Node.js 18+
- npm
- PostgreSQL 16
- OpenClaw Gateway credentials for live workflow execution

### 1) Install dependencies

Because this environment may have `NODE_ENV=production` set at the OS level, install with development mode forced:

```bash
NODE_ENV=development npm ci
```

### 2) Create local environment overrides

```bash
cp .env.example .env
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/home/node/aries-app DATA_ROOT=/tmp/aries-data NODE_ENV=development
export OPENCLAW_GATEWAY_LOBSTER_CWD=aries-app/lobster  # installed OpenClaw gateway service from /home/node
export OPENCLAW_LOCAL_LOBSTER_CWD=/home/node/aries-app/lobster
export OPENCLAW_LOBSTER_CWD=/home/node/aries-app/lobster
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
export MARKETING_STATUS_PUBLIC=1
```

Use `OPENCLAW_GATEWAY_LOBSTER_CWD` as the path to `lobster/` relative to the OpenClaw gateway process, not relative to the Aries process. Use `lobster` when you start OpenClaw from `/home/node/aries-app`; use `aries-app/lobster` for the installed host gateway service that starts from `/home/node`. Keep `OPENCLAW_LOCAL_LOBSTER_CWD` / `OPENCLAW_LOBSTER_CWD` pointed at the absolute checkout path for local file reads and compatibility tooling. Run `npm run validate:openclaw-lobster` after gateway/config changes; it writes a diagnostic report under `.artifacts/openclaw-lobster-availability/` and fails with the fix hint if the `lobster` tool disappears again.

### 3) Start PostgreSQL

```bash
sudo pg_ctlcluster 16 main start
```

### 4) Initialize the database

```bash
npm run db:init
```

### 5) Start the dev server

Use **Turbopack**. In this repo, that is required for Tailwind CSS v4 processing, and `next.config.mjs` pins the app root so Next does not drift up to the parent workspace.

```bash
npm run dev
```

`MARKETING_STATUS_PUBLIC=1` is optional for local demo flows where teammates want to use the dashboard, campaign workspace, review queue, status pages, and asset routes without a full authenticated session. In that mode, Aries serves the latest runtime-backed marketing data directly so teammates can reproduce UI fixes locally instead of depending on a VM-only session.

## Docker Compose

The repo includes `docker-compose.yml`, `docker-compose.local.yml`, and a production `Dockerfile`. These files run the Aries app container, but they do **not** provision PostgreSQL or OpenClaw for you, so `DB_*` and `OPENCLAW_*` values still need to point at working services.

### Production release

Production deploy is triggered by pushing to `master`, but **only after** the GHCR image for that **exact commit SHA** is already published. The GitHub Actions Deploy workflow runs on the self-hosted deploy host, logs the local Docker daemon into GHCR, and then pulls `ghcr.io/<owner>/aries-app:<sha>`/`:latest` there; pushing `master` first without the image fails by design.

Step-by-step commands and environment variables: see **`DOCKER.md`** → *Production release (GHCR image before `master`)*. A short operational summary also lives in **`docs/SYSTEM-REFERENCE.md`** → *Production release (operational)*.

### Production-style local container run

1. Copy and fill in the environment file:

```bash
cp .env.example .env
```

2. Create the external Docker network expected by `docker-compose.yml` if it does not already exist:

```bash
docker network create docker-stack || true
```

3. Start the app with the local overrides file so localhost-oriented URL defaults and `host.docker.internal` are applied for host-based OpenClaw access. The base compose file now owns the production port publish, so this override does not create a second app instance:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml up --build -d aries-app
```

4. View logs or stop the stack when needed:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml logs -f aries-app
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml down
```

### Development container caveat

`docker-compose.local.yml` also defines an `aries-app-dev` service behind the `dev` profile, but its baked-in command is currently `npm run dev`, which does **not** add the required `--turbopack` flag for this repo. If you want to use the development container, override the command explicitly:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml run --rm --service-ports aries-app-dev sh -lc 'npx next dev -p 3000 --turbopack'
```

### Docker-specific notes

- The app container stores generated runtime artifacts under `/data`, which is a bind mount from `${ARIES_SHARED_DATA_ROOT:-/home/node/data}` on the host. Using a bind mount (not a Docker-managed named volume) is intentional: it lets host-side OpenClaw/Lobster and the Aries container read and write the same files at the same absolute paths.
- `docker-compose.yml` now publishes `${PORT:-3000}` for the main `aries-app` service because both deploys and local production-style runs depend on that host port existing.
- `docker-compose.local.yml` only layers in localhost-friendly URL defaults plus `OPENCLAW_GATEWAY_URL=http://host.docker.internal:3456`; it merges into the same `aries-app` service rather than creating a second production container.
- The Compose setup expects an external PostgreSQL instance; it does not include a Postgres service.
- For production-style Compose runs, `NODE_ENV` is set to `production` and the container starts with `npm run start`.

## Environment variables

### Required for live execution

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

### Common optional variables

- `ARIES_PROCESS_MANAGER` (`cluster` by default; set `node` for one-process rollback)
- `ARIES_WEB_CONCURRENCY` (`2` by default; positive integer or `max`)
- `DB_POOL_MAX` (`20` by default, per worker)
- `AUTH_TRUST_HOST`
- `OPENCLAW_SESSION_KEY`
- `OPENCLAW_GATEWAY_LOBSTER_CWD`
- `OPENCLAW_LOCAL_LOBSTER_CWD`
- `OPENCLAW_LOBSTER_CWD`
- `INTERNAL_API_SECRET`
- `LOG_LEVEL`
- `OAUTH_TOKEN_ENCRYPTION_KEY`
- OAuth client credentials:
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
  `X_CLIENT_ID`, `X_CLIENT_SECRET`,
  `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
- Meta runtime values: `META_PAGE_ID` and `META_ACCESS_TOKEN`

Aries derives generic OAuth callbacks from `APP_BASE_URL` for non-Meta providers:
- `${APP_BASE_URL}/api/auth/oauth/linkedin/callback`
- `${APP_BASE_URL}/api/auth/oauth/reddit/callback`
- `${APP_BASE_URL}/api/auth/oauth/tiktok/callback`
- `${APP_BASE_URL}/api/auth/oauth/x/callback`
- `${APP_BASE_URL}/api/auth/oauth/youtube/callback`

Meta publishing remains env-managed with `META_PAGE_ID` and `META_ACCESS_TOKEN`.

## Supported product flows

### Public marketing intake

The public client intake begins at `/onboarding/start`. The legacy `/onboarding/pipeline-intake` path redirects there for backwards compatibility.

### Tenant onboarding

The internal tenant-onboarding API remains exposed through `/api/onboarding/start`. Aries validates required fields like `tenant_id`, `tenant_type`, and `signup_event_id`, then delegates the onboarding workflow to OpenClaw. Status is later read through `/api/onboarding/status/[tenantId]` using runtime-safe summaries rather than raw file paths.

### Marketing job flow

The canonical marketing flow currently centers on the `brand_campaign` job type. A request to `/api/marketing/jobs` must provide both:

- `brandUrl`
- `competitorUrl`

Aries creates local runtime state for the job, delegates execution through OpenClaw, and exposes status/approval operations through:

- `/api/marketing/jobs/[jobId]`
- `/api/marketing/jobs/[jobId]/approve`
- `/marketing/new-job`
- `/marketing/job-status`
- `/marketing/job-approve`

### Platform integrations and OAuth

Aries includes a broker-style integrations surface for providers such as Meta, LinkedIn, Reddit, TikTok, X, and YouTube. The app exposes safe platform status data through `/api/integrations` and `/api/platform-connections`, while OAuth connect/reconnect/disconnect/callback handling stays inside Aries route handlers.

### Publishing and calendar sync

The runtime also includes route handlers for publishing dispatch/retry and calendar synchronization:

- `/api/publish/dispatch`
- `/api/publish/retry`
- `/api/calendar/sync`

These routes keep the browser-facing contract inside Aries while workflow execution is handled behind the OpenClaw boundary.

## Validation and testing

### Recommended quick verification

```bash
npm run verify
```

This runs the repo's fast regression suite with deterministic environment overrides.

### Other useful commands

```bash
npm run precheck
npm run typecheck
npm run validate:repo-boundary
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/**/*.test.ts
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
node scripts/check-banned-patterns.mjs
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
```

### Focused regression specs

Auth and signup:
- `tests/sign-up-form-submit-validity.regression-001.test.ts` guards the disabled-state contract for the signup submit button until full validation passes.
- `tests/login-form-validation.regression-010.test.ts` keeps inline validation and submit-disable behavior in place on the login screen.
- `tests/forgot-password-form-validation.regression-011.test.ts` covers the same contract on the forgot-password screen.
- `tests/signup-email-normalization.regression-017.test.ts` pins trim + lowercase email normalization before submission.

Homepage and marketing surfaces:
- `tests/homepage-meet-aries-step-chips.regression-013.test.ts` keeps the homepage Meet Aries workflow steps non-interactive and exposed with list semantics.
- `tests/homepage-request-access-validation.regression-013.test.ts` guards inline validation on the homepage request-access form.
- `tests/homepage-request-access-loading.regression-016.test.ts` preserves the loading state and disable behavior during submission.
- `tests/marketing-legacy-text-repair.regression-014.test.ts` covers legacy marketing-copy repair on workspace and business-profile read paths.

Onboarding and operator shell:
- `tests/onboarding-step-one-validation.regression-012.test.ts` blocks empty submits on onboarding step one before they fire.
- `tests/sidebar-account-menu-escape.regression-012.test.ts` preserves Escape-key dismissal for the desktop account menu.
- `tests/route-metadata-and-docs-anchors.regression-015.test.ts` pins route metadata and documentation anchor integrity, including the `support@sugarandleather.com` contact mailto.

Infrastructure and deploy:
- `tests/deploy-workflow-self-hosted.regression-015.test.ts` asserts the GitHub Actions deploy workflow stays on the self-hosted runner with HTTPS checkout.
- `tests/production-compose-port-publish.regression-016.test.ts` keeps the production port publish in `docker-compose.yml` so deploys do not silently lose host port 3000.

### Notes about test environment stability

- The environment may inject `APP_BASE_URL`, `NODE_ENV`, and database variables globally.
- OAuth tests rely on `APP_BASE_URL=https://aries.example.com`.
- Local dependency installation should force `NODE_ENV=development` so devDependencies are present.

### Repo boundary guard

`npm run validate:repo-boundary` fails if protected `aries-app` surfaces pick up sibling-project names in file paths or file contents. It is there to catch cross-project drift before it spreads through source, docs, or agent context files.

## Working conventions

- Prefer the Next.js route handlers in `app/api/*` as the UI contract.
- Keep browser-facing responses safe and typed; avoid leaking runtime internals.
- Treat OpenClaw as the execution boundary.
- Use the repo verification scripts and targeted tests to keep docs and implementation aligned.

## Project TODO list

- [ ] Review and expand `.env.example` so local setup is fully self-serve and matches the documented overrides.
- [ ] Audit route documentation and tests for stale references to removed pages such as `/contact` so the documented route surface stays accurate.
- [ ] Document tenant-auth expectations for operator routes in one canonical place.
- [ ] Expand API documentation for tenant profile, approval request, and workflow-run endpoints.
- [ ] Add a concise architecture diagram for frontend engineers onboarding to the repo.
- [ ] Add CI-visible checks that validate docs examples against the actual route/file surface.
- [ ] Document provider-specific OAuth configuration and scopes for each supported integration.
- [ ] Add examples for local OpenClaw development and failure-mode troubleshooting.
- [ ] Publish sample request/response payloads for onboarding, marketing status, integrations, publish, and calendar flows.

## Project roadmap

### Near term

- Stabilize and simplify local developer onboarding.
- Eliminate stale route/docs references and tighten the canonical runtime contract.
- Improve README/API docs so new contributors can understand the supported surface quickly.
- Strengthen verification around runtime-safe API responses and tenant isolation.

### Mid term

- Mature platform connection management with clearer token health, reconnect, and sync telemetry.
- Broaden typed frontend API clients and shared response schemas.
- Improve operator shell workflows for marketing job review, approvals, and recovery paths.
- Add stronger observability around OpenClaw execution results, retries, and approval gates.

### Longer term

- Expand the number of first-class marketing and publishing workflows supported through the same route boundary.
- Formalize runtime state schemas and lifecycle guarantees for generated artifacts.
- Grow tenant administration capabilities around profiles, workflows, approvals, and auditability.
- Evolve the repo into a more fully documented platform runtime with clearer separation of public marketing, operator operations, and execution orchestration.

## Additional repository docs

- `CHANGELOG.md` — versioned release notes (what shipped, in user-facing language)
- `VERSION` — canonical version string used by `package.json` and release tagging
- `TODOS.md` — tracked follow-up work, including known test-infrastructure debt
- `SETUP.md` — setup and environment reference
- `DOCKER.md` — container, compose, and GHCR release reference
- `PRODUCTION_HANDOFF.md` — concise production deployment runbook
- `docs/SYSTEM-REFERENCE.md` — living architecture reference refreshed by the automation cron
- `skills/README.md` — local skills documentation
- `lobster/README.md` and `lobster/bin/README.md` — Lobster-related notes

## Summary

If you are new to the project, the safest mental model is:

1. Run the app as a Next.js runtime.
2. Use Turbopack locally.
3. Treat `app/api/*` as the browser contract.
4. Treat `backend/*` and `lib/*` as the server-side application boundary.
5. Treat OpenClaw as the execution engine beyond Aries.
6. Use the test suite and verification scripts to keep code, docs, and route behavior in sync.
