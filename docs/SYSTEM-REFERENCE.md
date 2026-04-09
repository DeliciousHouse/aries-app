# Aries System Reference

Last refreshed Apr 08, 2026, 21:45 PDT.

## What changed today
- .github/workflows/deploy.yml
- .gitignore
- DOCKER.md
- PRODUCTION_HANDOFF.md
- README.md
- docker-compose.yml
- docs/SYSTEM-REFERENCE.md
- docs/automations/README.md
- docs/briefs/2026-04-08-brief.md
- package.json
- tailwind.config.ts
- CLAUDE.md
- app/api/business/profile/route.ts
- app/api/integrations/handlers.ts
- app/api/marketing/campaigns/route.ts
- app/api/marketing/jobs/[jobId]/approve/handler.ts
- app/api/marketing/jobs/[jobId]/assets/[assetId]/handler.ts
- app/api/marketing/jobs/[jobId]/brief/route.ts
- app/api/marketing/jobs/[jobId]/handler.ts
- app/api/marketing/jobs/[jobId]/workspace-assets/[assetId]/handler.ts
- app/api/marketing/jobs/handler.ts
- app/api/marketing/jobs/latest/handler.ts
- app/api/marketing/posts/route.ts
- app/api/marketing/reviews/[reviewId]/decision/route.ts
- app/api/marketing/reviews/[reviewId]/route.ts
- app/api/marketing/reviews/route.ts
- app/api/onboarding/draft/route.ts
- app/api/pipeline/url-preview/route.ts
- app/login/page-client.tsx
- app/onboarding/pipeline-intake/page.tsx

## Current architecture overview
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under backend/* and routes long-running execution through OpenClaw Gateway rather than direct browser workflow exposure.
- Local runtime state and typed adapters live across lib/*, hooks/*, specs/*, and workflows/* to preserve contract boundaries.
- Standalone Mission Control now lives outside the repo in /app/projects/aries-mission-control and reads /api/runtime/overview from its local runtime server.

## Module inventory
- app/ 107 files
- backend/ 73 files
- components/ 14 files
- hooks/ 17 files
- lib/ 19 files
- scripts/ 24 files
- skills/ 58 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage current repo changes, commit them to a backup branch, and create or update a backup pull request on the configured private GitHub remote.
- Aries overnight self-improvement — 30 1 * * * America/Los_Angeles — Rotate a nightly audit, apply low-risk cleanup, and log results to memory/YYYY-MM-DD.md.
- Aries daily brief — 0 8 * * * America/Los_Angeles — Generate the morning priorities/overnight activity/pending actions brief.
- Aries GitHub feedback connector — 0 7 * * * America/Los_Angeles — Sync GitHub issues, classify bug vs feature, route each pending item to the correct skill workflow, and update the processing log.
- Aries GitHub feedback daily summary — 0 18 * * * America/Los_Angeles — Deliver the daily batch summary for non-critical GitHub feedback items that were processed and logged.
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
- validate:homepage-perf: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
- validate:homepage-perf:mobile: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --form-factor=mobile --screenEmulation.mobile=true --throttling-method=simulate --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage-mobile.json
- automation:backup: node scripts/automations/private-repo-backup.mjs
- automation:self-improve: node scripts/automations/overnight-self-improve.mjs
- automation:daily-brief: node scripts/automations/daily-brief.mjs
- automation:feedback-connector: node scripts/automations/feedback-connector.mjs sync
- automation:feedback-summary: node scripts/automations/feedback-daily-summary.mjs
- automation:system-reference: node scripts/automations/rolling-system-reference.mjs
- automation:install: node scripts/automations/install-openclaw-crons.mjs
- automation:verify: node scripts/automations/verify-automations.mjs

## Known issues
- Cron registration is prepared but not auto-enabled until backup remote/delivery targets are confirmed.
- Daily brief and system reference depend on local markdown/task hygiene; the better the source docs, the sharper the briefs.
- Mission Control standalone app is still a shell around runtime overview data and awaits richer live API adapters for actions/transcripts.

## Working tree snapshot
- M .github/workflows/deploy.yml
- M .gitignore
- M AGENTS.md
- M DOCKER.md
- M MEMORY.md
- M PRIORITIES.md
- M SOUL.md
- M TOOLS.md
- M USER.md
- M docs/SYSTEM-REFERENCE.md
- M docs/briefs/2026-04-08-brief.md
- M next-env.d.ts
- M scripts/release/publish-image.sh
- D team/DELEGATION-RULES.md
- D team/forge/AGENTS.md
- D team/forge/BACKLOG.md
- D team/forge/HEARTBEAT.md
- D team/forge/IDENTITY.md
- D team/forge/MEMORY.md
- D team/forge/SOUL.md

## Reference date
- 2026-04-08
