# Aries System Reference

Last refreshed Apr 04, 2026, 21:45 PDT.

## What changed today
- scripts/automations/manifest.mjs
- scripts/automations/private-repo-backup.mjs
- skills/aries-private-repo-backup/SKILL.md
- MEMORY.md
- docker-compose.yml
- docs/briefs/2026-04-04-brief.md
- skills/README.md

## Current architecture overview
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under backend/* and routes long-running execution through OpenClaw Gateway rather than direct browser workflow exposure.
- Local runtime state and typed adapters live across lib/*, hooks/*, specs/*, and workflows/* to preserve contract boundaries.
- Standalone Mission Control now lives outside the repo in /app/projects/aries-mission-control and reads /api/runtime/overview from its local runtime server.

## Module inventory
- app/ 104 files
- backend/ 71 files
- components/ 14 files
- hooks/ 17 files
- lib/ 18 files
- scripts/ 16 files
- skills/ 44 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage current repo changes, commit them to a backup branch, and create or update a backup pull request on the configured private GitHub remote.
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
- validate:homepage-perf: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
- validate:homepage-perf:mobile: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --form-factor=mobile --screenEmulation.mobile=true --throttling-method=simulate --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage-mobile.json
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
- Working tree clean at refresh time.

## Reference date
- 2026-04-04
