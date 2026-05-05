# Aries App — Production Deployment Handoff

This document is the concise production runbook for `aries-app`.

## Release flow

1. Merge or push the target commit to `master`, or manually dispatch Deploy with `image_tag` and `git_ref` set to the full commit SHA.
2. Let the GitHub Actions Deploy workflow build/publish `ghcr.io/delicioushouse/aries-app:<sha>` for that exact commit.
3. Let the self-hosted deploy host pull the pinned image and force-recreate the `aries-app` service.

## Deployment checklist

### Environment
- [ ] Provision PostgreSQL.
- [ ] Provision Hermes Gateway access.
- [ ] Configure required environment variables.
- [ ] Ensure `NODE_ENV=production`.

Required variables for Hermes-native weekly social content:

- `APP_BASE_URL`
- `INTERNAL_API_SECRET`
- `HERMES_GATEWAY_URL`
- `HERMES_API_SERVER_KEY`
- `HERMES_SESSION_KEY`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `NEXTAUTH_URL`
- `AUTH_URL`
- `NEXTAUTH_SECRET`
- `AUTH_TRUST_HOST`
- `OAUTH_TOKEN_ENCRYPTION_KEY`

Media generation requirement:

- [ ] Configure `OPENAI_CLIENT_ID` and `OPENAI_CLIENT_SECRET` for the ChatGPT / OpenAI integration.
- [ ] Set a stable 32-byte base64 `OAUTH_TOKEN_ENCRYPTION_KEY` before any OAuth connections are created; generate one with `openssl rand -base64 32`.
- [ ] Confirm ChatGPT / OpenAI integration is connected before enabling image/video generation.
- [ ] If OpenAI is not connected, run text-only planning (media disabled) until connection is fixed.

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

### Weekly social content runtime flow

1. Client submits `POST /api/social-content/jobs`.
2. Aries submits run request to Hermes.
3. Hermes sends callbacks to `POST /api/internal/hermes/runs`.
4. Aries updates runtime state/status for weekly posts.
5. User reviews weekly content and approves optional render/publish actions.

## Troubleshooting
- Database issues: verify `DB_*` settings.
- Workflow issues: verify `HERMES_GATEWAY_URL`, `HERMES_API_SERVER_KEY`, and `INTERNAL_API_SECRET`.
- Media-generation issues: verify `OPENAI_CLIENT_ID`, `OPENAI_CLIENT_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`, and ChatGPT / OpenAI connection status in Integrations.
- UI drift: run `npm run typecheck` and `npm run verify`.
