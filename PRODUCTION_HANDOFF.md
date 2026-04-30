# Aries App — Production Deployment Handoff

This document is the concise production runbook for `aries-app`.

## Release flow

1. Merge or push the target commit to `master`, or manually dispatch Deploy with `image_tag` and `git_ref` set to the full commit SHA.
2. Let the GitHub Actions Deploy workflow build/publish `ghcr.io/delicioushouse/aries-app:<sha>` for that exact commit.
3. Let the self-hosted deploy host pull the pinned image and force-recreate the `aries-app` service.

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
- [ ] Confirm the Deploy workflow published and pulled the target SHA image.

### Validation
- [ ] Verify core public routes respond.
- [ ] Run `npm run verify` in staging or equivalent validation environment.
- [ ] Check logs for runtime errors after deploy.

## Troubleshooting
- Database issues: verify `DB_*` settings.
- Workflow issues: verify `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN`.
- UI drift: run `npm run typecheck` and `npm run verify`.
