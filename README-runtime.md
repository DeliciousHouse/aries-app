# Aries Runtime Shell (Local)

This is the thinnest runnable app shell for Aries on `http://localhost:3000`.

## What it serves
- Frontend screens:
  - `/onboarding/start`
  - `/onboarding/status`
  - `/marketing/new-job`
  - `/marketing/job-status`
  - `/marketing/job-approve`
  - `/platforms`
  - `/settings`
- API endpoints:
  - `POST /api/onboarding/start`
  - `GET /api/onboarding/status/:tenantId`
  - `POST /api/marketing/jobs`
  - `GET /api/marketing/jobs/:jobId`
  - `POST /api/marketing/jobs/:jobId/approve`
  - `POST /api/publish/dispatch`
  - `GET /api/integrations`
  - `GET /api/platform-connections`
  - `POST /api/contact` (`501` placeholder)
  - `POST /api/waitlist` (`501` placeholder)
  - `POST /api/events` (`501` placeholder)

## Setup
1. Copy env template:
   - `cp .env.example .env`
2. Set at minimum:
   - `CODE_ROOT` (default `/app` in containers)
   - `DATA_ROOT` (default `/data` in containers)
   - `N8N_BASE_URL`
   - `N8N_API_KEY`
3. Install dependencies:
   - `npm install`

## Recommended container parity flow
- Immutable runtime code and assets are inside `/app`.
- Mutable runtime artifacts are written under `/data/generated/...`.
- Local and production both run from the same built image; only env/secrets/data mount differ.

Use the parity compose baseline plus local override:
- `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build`
- Optional hot reload service: `docker compose -f docker-compose.yml -f docker-compose.local.yml --profile dev up -d aries-app-dev`

Parity guarantees apply to this container-based flow.

## Optional host-node flow
- Dev: `npm run dev`
- Build: `npm run build`
- Start: `npm run start`
- Precheck: `npm run precheck`

If running directly on host Node, set `CODE_ROOT` and `DATA_ROOT` to host-valid paths (or leave unset to use defaults).

## Notes
- API routes are thin wrappers around existing backend logic under `./backend`.
- `/settings` is a read-only placeholder because `/api/tenant-admin/settings` is not implemented in this runtime.
- `/platforms` loads live OAuth broker state on mount and only shows token expiry when the backend has a real expiry timestamp.
- `/api/onboarding/status/:tenantId`, `GET /api/marketing/jobs/:jobId`, and some marketing approval fallback behavior are local runtime readers/fallbacks, not direct workflow status queries.
- No workflow/contract redesign is introduced by this shell.
- `PROJECT_ROOT` is treated as legacy compatibility fallback only.
