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

## Run (parity runtime)
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

App will be available at `http://localhost:3000`.

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
