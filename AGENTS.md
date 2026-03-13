# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Aries AI is a Next.js 15 (App Router) application that serves as a marketing automation platform. The frontend/API layer proxies all business logic to an external **n8n** workflow automation instance via webhooks. See `SETUP.md` and `README-runtime.md` for full documentation.

### Running the application

- **Dev server**: `npm run dev` (port 3000)
- **Build**: `npm run build`
- **Type check (lint)**: `npx tsc --noEmit` (no ESLint config exists in this repo)
- **Precheck**: `npm run precheck` (validates required files and npm scripts)

### Environment setup

1. Copy `.env.example` to `.env` and set `CODE_ROOT=/workspace`, `DATA_ROOT=/workspace/data`, `APP_BASE_URL=http://localhost:3000`.
2. Create data directories: `mkdir -p data/generated/draft data/generated/validated`
3. The `N8N_BASE_URL` and `N8N_API_KEY` env vars are required for API routes to proxy to n8n. Without a live n8n instance, the UI renders fully but API operations (onboarding, marketing jobs, publishing) return errors.
4. Meta/Facebook OAuth vars (`META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`) are optional.

### Testing

- The `tests/` directory contains TypeScript test suites that run via `npx tsx`. They require a live n8n instance and configured `CODE_ROOT`/`DATA_ROOT`. The gating suite (`tests/run-gating-suite.ts`) exercises tenant workspace generation/validation and n8n publish workflows.
- There is no Jest/Vitest/Mocha test runner configured. Tests are standalone TS scripts.
- Type checking via `npx tsc --noEmit` is the primary automated lint/check available without external dependencies.

### Key caveats

- **No `next.config.js`/`next.config.mjs`** — the project uses Next.js defaults.
- **No ESLint config** — `npx tsc --noEmit` is the only static analysis available.
- The `data/` directory is not in `.gitignore`; avoid committing generated runtime artifacts under `data/`.
- Node.js 22 is used in the Dockerfile; Node 18+ is the minimum.
