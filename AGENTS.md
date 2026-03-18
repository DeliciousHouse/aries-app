# AGENTS.md

## Cursor Cloud specific instructions

### Service overview

**Aries AI** is a Next.js 15 (App Router) marketing automation platform that delegates workflow execution to an external OpenClaw Gateway. See `SETUP.md` and `README-runtime.md` for canonical setup docs.

### Dev server

The dev server **must** use Turbopack (`--turbopack` flag) because the project uses Tailwind CSS v4 with `@tailwindcss/postcss`, and the default webpack bundler in Next.js 15.5 fails to process `@import "tailwindcss"` in `app/globals.css`. Run:

```
npx next dev -p 3000 --turbopack
```

### Environment variable gotcha

The VM has system-level env vars (e.g. `NODE_ENV=production`, `DB_HOST=n8n-postgres`, `APP_BASE_URL`) injected at the OS level. These **override** values in `.env` because `dotenv` does not overwrite existing env vars. When running commands locally, explicitly export overrides:

```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass DB_NAME=aries_dev
export CODE_ROOT=/workspace DATA_ROOT=/tmp/aries-data NODE_ENV=development
export APP_BASE_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 AUTH_URL=http://localhost:3000 AUTH_TRUST_HOST=true
```

### npm install requires `NODE_ENV=development`

Because the system sets `NODE_ENV=production`, running bare `npm ci` skips devDependencies (TypeScript, tsx, Tailwind, PostCSS). Always use:

```
NODE_ENV=development npm ci
```

### PostgreSQL

A local PostgreSQL 16 instance is used for development. Start it with:

```
sudo pg_ctlcluster 16 main start
```

Database: `aries_dev`, user: `aries_user`, password: `aries_pass`. Initialize schema with `npm run db:init` (after exporting correct `DB_*` env vars).

### Running tests

Tests use Node.js built-in test runner via `tsx`:

```
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/**/*.test.ts
```

Two tests in `tests/auth/oauth-connect.test.ts` assert redirect URIs contain `aries.example.com`. If `APP_BASE_URL` from the system env leaks in, those tests fail. Set `APP_BASE_URL=https://aries.example.com` when running tests.

### Type checking

```
./node_modules/.bin/tsc --noEmit
```

### Key scripts (from `package.json`)

| Script | Command |
|---|---|
| `npm run dev` | `next dev -p 3000` (add `--turbopack` manually) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | `tsx --test tests/**/*.test.ts` |
| `npm run db:init` | Initialize PostgreSQL schema |
| `npm run precheck` | Verify required files exist |
