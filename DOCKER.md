# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml` (parity baseline: image + env + data volume)
- `docker-compose.local.yml` (local-only overrides)
- `.dockerignore`

## Deployment contract (parity-safe)
- Application code is baked into the image and mounted internally at `/app`.
- Writable runtime data lives under `/data` only.
- Production/parity runtime uses Docker named volumes for `/data` (no source bind mount required).
- Source bind mounts are dev-only (`aries-app-dev` profile) and must not be required for normal runtime.

## Build
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml build
```

## Required environment
- `APP_BASE_URL`
- `ARIES_APP_IMAGE` (optional image/tag override, default: `aries-app:local`)
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_URL`
- `AUTH_URL` (same value as `NEXTAUTH_URL`)
- `AUTH_TRUST_HOST` (`true` for trusted proxy deployments)
- `NEXTAUTH_SECRET`
- `N8N_BASE_URL`
- `N8N_API_KEY`

## Run (parity runtime)
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

To pin a specific private GHCR tag without editing compose files:
```bash
ARIES_APP_IMAGE=ghcr.io/<owner-or-org>/aries-app:<tag> \
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

App will be available at `http://localhost:3000`.

## External Postgres schema
- Production uses an external Postgres instance. Do not add an embedded Postgres service to the production compose file.
- The current auth code expects these tables to exist before first sign-in:
  - `organizations`
  - `users`
- Auth.js is currently using JWT sessions without a database adapter, so `sessions` and `accounts` tables are not required.
- Initialize the schema once against the target database before enabling auth flows:

```bash
npm run db:init
```

## Optional hot reload
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile dev up -d aries-app-dev
```

## Stop
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

## Notes
- Uses Node 22 Alpine.
- Builds Next.js app with `npm run build` and runs with `npm run start`.
- Production-oriented runtime mounts only `/data` for persistent artifacts (`/data/generated/...`).
- Production should not bind mount the repository into `/app`.
- Keep real secrets out of git; inject via environment at deploy time.
- The app runtime contract remains `CODE_ROOT=/app` and `DATA_ROOT=/data`.

## Image distribution (private GHCR)
```bash
# authenticate once for private package access
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

# tag and push the exact image contract used for parity runtime
docker tag aries-app:local ghcr.io/<owner-or-org>/aries-app:<tag>
docker push ghcr.io/<owner-or-org>/aries-app:<tag>
```

## Directory classification
- Runtime source: `app/`, `backend/`, `frontend/`, `lib/`, `scripts/`, `publish/`, `templates/`, `validators/`.
- Runtime read-only assets: `public/`, `specs/`, `n8n/`.
- Build artifacts: `.next/`, `node_modules/`, `tsconfig.tsbuildinfo`, logs.
- Persistent runtime data: `/data/generated/draft/**` and `/data/generated/validated/**`.
- Docs/non-runtime reference: markdown at repo root and `skills/`.
