# Aries Runtime Shell (Local)

This is the thinnest runnable app shell for Aries on `http://localhost:3000`.

## What it serves
- Frontend screens:
  - `/onboarding/start`
  - `/onboarding/status`
  - `/marketing/new-job`
  - `/marketing/job-status`
  - `/marketing/job-approve`
- API endpoints:
  - `POST /api/onboarding/start`
  - `GET /api/onboarding/status/:tenantId`
  - `POST /api/marketing/jobs`
  - `GET /api/marketing/jobs/:jobId`
  - `POST /api/marketing/jobs/:jobId/approve`

## Setup
1. Copy env template:
   - `cp .env.example .env.local`
2. Set at minimum:
   - `PROJECT_ROOT`
   - `N8N_BASE_URL`
   - `N8N_API_KEY`
3. Install dependencies:
   - `npm install`

## Run
- Dev: `npm run dev`
- Build: `npm run build`
- Start: `npm run start`
- Precheck: `npm run precheck`

## Notes
- API routes are thin wrappers around existing backend logic under `./backend`.
- No workflow/contract redesign is introduced by this shell.
