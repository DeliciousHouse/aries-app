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
- Keep real secrets out of git; inject via environment at deploy time.
