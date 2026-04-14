# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `.dockerignore`

## Deployment contract
- Application code is baked into the image and mounted internally at `/app`.
- Writable runtime data lives under `/data` only.
- Production runtime uses Docker named volumes for `/data`.
- Source bind mounts are development-only.

## Production release

For `aries-app`, deploy by publishing the image for the exact commit SHA first, then pushing that same commit to `master`.
The GitHub Actions deploy workflow expects `ghcr.io/delicioushouse/aries-app:<sha>` to exist before SSH deploy.

## Build
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml build
```

## Required environment
- `APP_BASE_URL`
- `ARIES_APP_IMAGE` (optional image/tag override, default: `aries-app:local`)
- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_SESSION_KEY` (optional; default `main`)
- `OPENCLAW_LOBSTER_CWD` (optional)
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_URL`
- `AUTH_URL`
- `AUTH_TRUST_HOST`
- `NEXTAUTH_SECRET`

## Run
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

To pin a specific private GHCR tag without editing compose files:
```bash
ARIES_APP_IMAGE=ghcr.io/<owner-or-org>/aries-app:<tag> \
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

## Stop
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

## Notes
- Production should not bind mount the repository into `/app`.
- Keep real secrets out of git.
- The runtime contract remains `CODE_ROOT=/app` and `DATA_ROOT=/data`.
- Workflow execution is delegated through OpenClaw.
