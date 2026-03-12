# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`

## Build
```bash
docker compose build
```

## Run
```bash
docker compose up -d
```

App will be available at `http://localhost:3000`.

## Stop
```bash
docker compose down
```

## Notes
- Uses Node 22 Alpine.
- Builds Next.js app with `npm run build` and runs with `npm run start`.
- Uses the same application image for local Docker and production-style deployment.
- Persists writable tenant/job artifacts in the named volume mounted at `/data/generated` via `ARIES_DATA_ROOT=/data/generated`.
- Keeps source code and read-only runtime assets (`app`, `backend`, `specs`, `n8n`, `templates`, `validators`) in the image rather than bind-mounting the repo into the container.
- Keep real secrets out of git; inject via environment at deploy time.
