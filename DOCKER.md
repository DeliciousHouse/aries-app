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

## Production release (GHCR image before `master`)

**Rule:** For `aries-app`, merging or pushing to `master` is the deploy trigger, but **only after** the GHCR image for **that exact commit SHA** is already published and pullable.

The GitHub Actions **Deploy** workflow runs on every push to `master`. It resolves the image as `ghcr.io/<repository_owner>/aries-app:<github.sha>` and **verifies the tag exists in GHCR** before SSH deploy. If the image is missing, the workflow fails by design.

### Release sequence

1. Export the required publish environment variables (see exact block below). Ensure you are on the commit you intend to ship; `scripts/release/publish-image.sh` tags the image with `git rev-parse HEAD`.
2. Run `scripts/release/publish-image.sh` from a clean working tree so GHCR receives `:SHA` and `:<DEFAULT_BRANCH>` tags for that commit.
3. Push **the same commit** to `origin master` (for example `git push origin master`). This triggers auto-deploy of that SHA to the VM.
4. GitHub Actions completes SSH deploy using the verified image ref.

### Publish commands (exact)

Use a machine with Docker Buildx and permission to push to `ghcr.io/delicioushouse/aries-app`. Set `GHCR_TOKEN` (and optionally `GHCR_USERNAME`) if `docker login ghcr.io` is not already satisfied.

```bash
export BUILDX_BUILDER="multiarch"
export GHCR_OWNER="delicioushouse"
export GHCR_IMAGE="ghcr.io/delicioushouse/aries-app"
export OCI_SOURCE_REPO="DeliciousHouse/aries-app"
export IMAGE_DESCRIPTION="Aries app runtime image"
export DEFAULT_BRANCH="master"

cd ~/docker-stack/aries-app
bash scripts/release/publish-image.sh
git push origin master
```

Notes:

- `BUILDX_BUILDER` is the Buildx builder name your environment uses for multi-platform pushes; create or select it with `docker buildx` before running the script if needed.
- The `cd` path is the operator’s canonical checkout on the publish host; adjust only if your layout differs.
- `git push origin master` must advance `master` to the **same** `HEAD` that was just published (no extra local commits after publish without re-running the script).

### Failure mode

If application code is pushed to `master` **before** the matching GHCR image `ghcr.io/delicioushouse/aries-app:<that-commit-sha>` exists (or is inaccessible to the workflow), **deploy fails by design** at the “Verify GHCR tag exists” step.

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
- `OPENCLAW_LOBSTER_CWD` (optional; default `lobster`)
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
- Aries now delegates workflow execution to OpenClaw Gateway; the app image itself should not be the authoritative workflow execution root.

## Image distribution (private GHCR)
```bash
# authenticate once for private package access
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

# tag and push the exact image contract used for parity runtime
docker tag aries-app:local ghcr.io/<owner-or-org>/aries-app:<tag>
docker push ghcr.io/<owner-or-org>/aries-app:<tag>
```

## Directory classification
- Runtime source: `app/`, `backend/`, `frontend/`, `lib/`, `scripts/`, `templates/`, `validators/`.
- Runtime read-only assets: `public/`, `specs/`.
- Build artifacts: `.next/`, `node_modules/`, `tsconfig.tsbuildinfo`, logs.
- Persistent runtime data: `/data/generated/draft/**` and `/data/generated/validated/**`.
- Docs/non-runtime reference: markdown at repo root, `skills/`, `workflows/`, and `lobster/` templates.
