# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Aries AI is a Next.js 15 marketing automation platform. The main service is a Next.js app on port 3000 that proxies business logic to an external n8n workflow engine. See `SETUP.md` and `README-runtime.md` for full setup docs.

### Critical: NODE_ENV override

The Cloud Agent VM sets `NODE_ENV=production` at the system level. You **must** override it when running the dev server:

```bash
NODE_ENV=development CODE_ROOT=/workspace DATA_ROOT=/workspace/data npx next dev -p 3000
```

Without `NODE_ENV=development`, PostCSS/Tailwind CSS v4 processing fails and all pages return 500.

### Dev server

- **Start**: `NODE_ENV=development CODE_ROOT=/workspace DATA_ROOT=/workspace/data npx next dev -p 3000`
- **Build**: `NODE_ENV=production CODE_ROOT=/workspace DATA_ROOT=/workspace/data npx next build`
- Pages compile on-demand in dev mode; first hit to each route takes 200-800ms.
- `CODE_ROOT` and `DATA_ROOT` default to `/app` and `/data` (container paths). Override to `/workspace` and `/workspace/data` for local dev.

### Environment variables

All required env vars are injected as Cloud Agent secrets (see `CLOUD_AGENT_ALL_SECRET_NAMES`). The `.env` file is only needed if secrets are missing. Key required vars: `N8N_BASE_URL`, `N8N_API_KEY`. See `.env.example` for the full list.

### No ESLint config

This repo has no ESLint configuration. TypeScript checking can be done with `npx tsc --noEmit`, but expect pre-existing type errors in the codebase (especially in `.next/types/` generated files and JSX resolution). The `next build` command performs its own type-checking and linting pass.

### Tests

Test suites in `tests/` are custom TypeScript scripts (not jest/vitest). They require a running n8n instance and data directories. Run with `npx tsx tests/<suite>.ts`. These are integration tests that depend on external services.

### Package manager

Uses **npm** with `package-lock.json`. Always use `npm install` (not pnpm/yarn).
