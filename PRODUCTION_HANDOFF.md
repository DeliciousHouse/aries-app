# Aries App — Production Deployment Handoff

This document is the concise production runbook for `aries-app`.

## Release flow

1. Publish the container image for the exact commit SHA to GHCR.
2. Push that same commit to `master`.
3. Let the GitHub Actions deploy workflow pull the verified image and restart the `aries-app` service.

## Deployment checklist

### Environment
- [ ] Provision PostgreSQL.
- [ ] Provision OpenClaw Gateway access.
- [ ] Configure required environment variables.
- [ ] Ensure `NODE_ENV=production`.

### Database
- [ ] Export `DB_*` variables.
- [ ] Run `npm run db:init` once against the target database.

### Application
- [ ] Run `npm ci`.
- [ ] Run `npm run build`.
- [ ] Confirm the image for the target SHA is available in GHCR.

### Validation
- [ ] Verify core public routes respond.
- [ ] Run `npm run verify` in staging or equivalent validation environment.
- [ ] Check logs for runtime errors after deploy.

## Troubleshooting
- Database issues: verify `DB_*` settings.
- Workflow issues: verify `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN`.
- UI drift: run `npm run typecheck` and `npm run verify`.
