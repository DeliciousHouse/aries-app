# Aries System Reference

Last refreshed Apr 12, 2026, 19:26 PDT.

## What changed today
- No git-tracked file changes detected since local midnight.

## Current architecture overview
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under backend/* and routes long-running execution through OpenClaw Gateway rather than direct browser workflow exposure.
- Local runtime state and typed adapters live across lib/*, hooks/*, specs/*, and workflows/* to preserve contract boundaries.
- Standalone Mission Control deploys as a separate image and reads /api/runtime/overview from its local runtime server.

## Module inventory
- app/ 108 files
- backend/ 73 files
- components/ 14 files
- hooks/ 17 files
- lib/ 21 files
- scripts/ 26 files
- skills/ 82 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage current repo changes, commit them to a backup branch, and create or update a backup pull request on the configured private GitHub remote.
- Aries overnight self-improvement — 0 4 * * * America/Los_Angeles — Pick one small additive nightly improvement, validate it, and log the shipped result to the nightly build log plus daily memory.
- Aries daily brief — 0 8 * * * America/Los_Angeles — Generate the morning priorities/overnight activity/pending actions brief.
- Aries GitHub feedback connector — 0 7 * * * America/Los_Angeles — Sync GitHub issues, classify bug vs feature, route each pending item to the correct skill workflow, and update the processing log.
- Aries GitHub feedback daily summary — 0 18 * * * America/Los_Angeles — Deliver the daily batch summary for non-critical GitHub feedback items that were processed and logged.
- Aries rolling system reference — 45 21 * * * America/Los_Angeles — Update docs/SYSTEM-REFERENCE.md with architecture, inventory, cron jobs, and known issues.
- Aries daily standup — 0 9 * * 1-5 America/Los_Angeles — Generate a board-based daily standup transcript with per-lane chief reports, workspace verification, and blocker visibility.
- Aries weekly review — 0 14 * * 5 America/Los_Angeles — Generate the Friday weekly review from live board, git, cron, backlog, and service-health truth, save it under memory/reviews, and optionally email the HTML version.

## Runtime scripts
- dev: next dev -p 8100 --turbopack
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
- validate:homepage-perf: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:8100 --only-categories=performance --preset=desktop --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
- validate:homepage-perf:mobile: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:8100 --only-categories=performance --form-factor=mobile --screenEmulation.mobile=true --throttling-method=simulate --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage-mobile.json
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
- M  .env.example
- M DELEGATION-RULES.md
- M  IDENTITY.md
- M  MEMORY.md
- MM PRIORITIES.md
- M  SOUL.md
- MM data/feedback-processing-log.json
- AM data/nightly-build-log.json
- M  docker-compose.yml
- M  docs/SYSTEM-REFERENCE.md
- M docs/briefs/2026-03-29-brief.md
- M docs/briefs/2026-04-04-brief.md
- A  docs/briefs/2026-04-10-brief.md
- A  docs/briefs/2026-04-11-brief.md
- M frontend/aries-v1/components.tsx
- M  frontend/aries-v1/presenters/calendar-presenter.tsx
- A  incubator/micro-saas/2026-04-11-pingpage/brief.md
- A  incubator/micro-saas/2026-04-11-pingpage/prototype/package.json
- A  incubator/micro-saas/2026-04-11-pingpage/prototype/pingpage.config.json
- A  incubator/micro-saas/2026-04-11-pingpage/prototype/server.mjs

## Reference date
- 2026-04-12
