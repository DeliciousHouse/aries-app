# Aries System Reference

Last refreshed Mar 30, 2026, 21:45 PDT.

## What changed today
- .env.example
- .gitignore
- AGENTS.md
- Dockerfile
- HEARTBEAT.md
- IDENTITY.md
- MEMORY.md
- OPERATING_STRUCTURE.md
- OVERNIGHT_LOG.md
- PRIORITIES.md
- README-runtime.md
- README.md
- ROADMAP.md
- SETUP.md
- SOUL.md
- USER.md
- app/api/business/profile/route.ts
- app/api/integrations/handlers.ts
- app/api/marketing/campaigns/route.ts
- app/api/marketing/jobs/[jobId]/brief/route.ts
- app/api/marketing/jobs/[jobId]/handler.ts
- app/api/marketing/jobs/[jobId]/workspace-assets/[assetId]/handler.ts
- app/api/marketing/jobs/[jobId]/workspace-assets/[assetId]/route.ts
- app/api/marketing/jobs/handler.ts
- app/api/marketing/jobs/latest/handler.ts
- app/api/marketing/posts/route.ts
- app/api/marketing/reviews/[reviewId]/decision/route.ts
- app/api/marketing/reviews/[reviewId]/route.ts
- app/api/marketing/reviews/route.ts
- app/api/pipeline/url-preview/route.ts

## Current architecture overview
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under backend/* and routes long-running execution through OpenClaw Gateway rather than direct browser workflow exposure.
- Local runtime state and typed adapters live across lib/*, hooks/*, specs/*, and workflows/* to preserve contract boundaries.
- Standalone Mission Control now lives outside the repo in /app/projects/aries-mission-control and reads /api/runtime/overview from its local runtime server.

## Module inventory
- app/ 100 files
- backend/ 61 files
- components/ 14 files
- hooks/ 17 files
- lib/ 16 files
- scripts/ 16 files
- skills/ 29 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage, commit, and push repo state to the configured private GitHub remote.
- Aries overnight self-improvement — 30 1 * * * America/Los_Angeles — Rotate a nightly audit, apply low-risk cleanup, and log results to memory/YYYY-MM-DD.md.
- Aries daily brief — 0 8 * * * America/Los_Angeles — Generate the morning priorities/overnight activity/pending actions brief.
- Aries rolling system reference — 45 21 * * * America/Los_Angeles — Update docs/SYSTEM-REFERENCE.md with architecture, inventory, cron jobs, and known issues.

## Runtime scripts
- dev: next dev -p 3000 --turbopack
- build: next build
- start: node scripts/start-runtime.mjs
- precheck: node scripts/runtime-precheck.mjs
- workspace:verify: node scripts/verify-canonical-workspace.mjs
- workspace:inventory: node scripts/inventory-paperclip-workspaces.mjs
- typecheck: tsc --noEmit
- lint: tsc --noEmit && node scripts/check-banned-patterns.mjs
- test: tsx --test tests/*.test.ts tests/**/*.test.ts
- test:e2e: tsx --test tests/frontend-api-layer.test.ts tests/marketing-flow-smoke.test.ts tests/onboarding-runtime-cutover.test.ts tests/public-marketing-pages.test.ts tests/runtime-api-truth.test.ts tests/runtime-pages.test.ts
- db:init: node scripts/init-db.js
- verify: node scripts/verify-regression-suite.mjs
- validate:public-routes: tsx --test tests/runtime-pages.test.ts tests/public-marketing-pages.test.ts
- validate:banned-patterns: node scripts/check-banned-patterns.mjs
- validate:marketing-flow: APP_BASE_URL=https://aries.example.com tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
- validate:homepage-perf: mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
- automation:backup: node scripts/automations/private-repo-backup.mjs
- automation:self-improve: node scripts/automations/overnight-self-improve.mjs
- automation:daily-brief: node scripts/automations/daily-brief.mjs
- automation:system-reference: node scripts/automations/rolling-system-reference.mjs
- automation:install: node scripts/automations/install-openclaw-crons.mjs
- automation:verify: node scripts/automations/verify-automations.mjs

## Known issues
- Cron registration is prepared but not auto-enabled until backup remote/delivery targets are confirmed.
- Daily brief and system reference depend on local markdown/task hygiene; the better the source docs, the sharper the briefs.
- Mission Control standalone app is still a shell around runtime overview data and awaits richer live API adapters for actions/transcripts.

## Working tree snapshot
- M app/api/marketing/jobs/[jobId]/handler.ts
- M app/api/marketing/jobs/handler.ts
- M app/api/marketing/jobs/latest/handler.ts
- M backend/marketing/dashboard-content.ts
- M  backend/marketing/orchestrator.ts
- M backend/marketing/publish-review.ts
- M  backend/marketing/runtime-state.ts
- MM backend/marketing/workspace-views.ts
- M backend/openclaw/gateway-client.ts
- M backend/tenant/business-profile.ts
- M docker-compose.yml
- M lib/api/marketing.ts
- MM tests/frontend-api-layer.test.ts
- M tests/marketing-gateway-logging.test.ts
- M tests/marketing-public-mode.test.ts

## Reference date
- 2026-03-30
