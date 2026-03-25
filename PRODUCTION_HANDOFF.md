# Aries AI — Production Deployment Handoff

This document provides the operational runbook and deployment checklist for the Aries AI platform.

## Deployment Checklist

### 1. Environment Configuration
- [ ] Provision a PostgreSQL 16 instance.
- [ ] Provision an OpenClaw Gateway instance.
- [ ] Configure all required environment variables (see `SETUP.md`).
- [ ] Ensure `NODE_ENV=production` for the production build.

### 2. Database Initialization
- [ ] Export `DB_*` environment variables.
- [ ] Run `npm run db:init` to create the schema.

### 3. Application Build
- [ ] Run `npm ci` (ensure `NODE_ENV=production` is set if devDependencies are not needed).
- [ ] Run `npm run build` to create the Next.js production bundle.

### 4. OpenClaw Workflow Sync
- [ ] Ensure Lobster workflows in `./lobster` are synchronized with the OpenClaw Gateway.
- [ ] Verify that `LOBSTER_STAGE*` cache directories are writable by the application process.

## Operational Runbook

### Starting the Platform
```bash
npm run start
```
The application will be available at the origin defined in `APP_BASE_URL`.

### Monitoring and Health Checks
- **Public Routes:** Verify `/`, `/features`, `/documentation`, and `/api-docs` are responding with 200 OK.
- **Internal APIs:** Use `npm run verify` to run the regression suite against the live (or staging) environment.
- **Logs:** Monitor standard output for runtime errors.

### Troubleshooting
- **Database Connection Issues:** Verify `DB_HOST`, `DB_PORT`, and credentials.
- **Workflow Failures:** Check `OPENCLAW_GATEWAY_URL` connectivity and ensure the gateway has the correct `OPENCLAW_GATEWAY_TOKEN`.
- **UI Drift:** Run `npm run typecheck` to ensure the frontend models still match the backend contracts.

## Validation Evidence
The current repository state has been validated against 73 regression tests covering:
- Route rendering and layout integrity.
- Frontend-to-backend API contract alignment.
- Tenant isolation and security boundaries.
- Multi-stage marketing job orchestration.
- Onboarding flow success paths.
