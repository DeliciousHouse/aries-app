# Aries System Reference

Last refreshed Apr 14, 2026, 03:53 PDT.

## What changed today
- backend/marketing/artifact-collector.ts
- backend/marketing/dashboard-content.ts
- backend/marketing/orchestrator.ts
- docker-compose.local.yml
- docker-compose.yml
- lobster/bin/_approval_bridge
- lobster/bin/_stage4_common.py
- lobster/bin/ad-designer
- lobster/bin/launch-review-preview
- lobster/marketing-pipeline.lobster

## Current architecture overview
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under `backend/*` and routes long-running execution through OpenClaw Gateway.
- Local runtime state and typed adapters live across `lib/*`, `hooks/*`, `specs/*`, and `workflows/*` to preserve contract boundaries.
- Repo context and automation output should stay scoped to `aries-app` only.

## Module inventory
- app/ 108 files
- backend/ 74 files
- components/ 14 files
- hooks/ 17 files
- lib/ 21 files
- scripts/ 27 files
- skills/ 79 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage current repo changes, commit them to a backup branch, and create or update a backup pull request on the configured private GitHub remote.
- Aries overnight self-improvement — 0 4 * * * America/Los_Angeles — Pick one small additive nightly improvement, validate it, and log the shipped result to the nightly build log plus daily memory.
- Aries daily brief — 0 8 * * * America/Los_Angeles — Generate the morning priorities/overnight activity/pending actions brief.
- Aries daily standup — 30 8,13,17 * * 1-5 America/Los_Angeles — Generate the board-derived Aries chief standup, write the transcript and per-chief reports to /home/node/.openclaw/projects/shared/teams, and announce the concise operational summary.
- Aries standup watchdog — 50 8,13,17 * * 1-5 America/Los_Angeles — Verify that the current standup transcript and per-chief reports exist in /home/node/.openclaw/projects/shared/teams and that no forbidden local standup artifacts were recreated.
- Aries GitHub feedback connector — 0 7 * * * America/Los_Angeles — Sync GitHub issues, classify bug vs feature, route each pending item to the correct skill workflow, and update the processing log.
- Aries GitHub feedback daily summary — 0 18 * * * America/Los_Angeles — Deliver the daily batch summary for non-critical GitHub feedback items that were processed and logged.
- Aries runtime error intake — 5,35 * * * * America/Los_Angeles — Scan Aries runtime and automation health, normalize failures into the runtime incident log, and announce the concise detection/resolution summary.
- Aries runtime error repair loop — 10,40 * * * * America/Los_Angeles — Work the highest-priority repairable runtime incident with a bounded fix loop, validate the result, and announce the concise resolution or escalation summary.
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
- lint: tsc --noEmit && node scripts/check-banned-patterns.mjs && node scripts/check-repo-boundary.mjs
- test: tsx --test tests/*.test.ts tests/**/*.test.ts
- test:e2e: tsx --test tests/frontend-api-layer.test.ts tests/marketing-flow-smoke.test.ts tests/onboarding-runtime-cutover.test.ts tests/public-marketing-pages.test.ts tests/runtime-api-truth.test.ts tests/runtime-pages.test.ts
- db:init: node scripts/init-db.js
- verify: node scripts/verify-regression-suite.mjs
- validate:public-routes: tsx --test tests/runtime-pages.test.ts tests/public-marketing-pages.test.ts
- validate:banned-patterns: node scripts/check-banned-patterns.mjs
- validate:marketing-flow: APP_BASE_URL=https://aries.example.com tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
- validate:repo-boundary: node scripts/check-repo-boundary.mjs
- validate:homepage-perf: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:8100 --only-categories=performance --preset=desktop --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
- validate:homepage-perf:mobile: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:8100 --only-categories=performance --form-factor=mobile --screenEmulation.mobile=true --throttling-method=simulate --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage-mobile.json
- automation:backup: node scripts/automations/private-repo-backup.mjs
- automation:self-improve: node scripts/automations/overnight-self-improve.mjs
- automation:daily-brief: node scripts/automations/daily-brief.mjs
- automation:feedback-connector: node scripts/automations/feedback-connector.mjs sync
- automation:feedback-summary: node scripts/automations/feedback-daily-summary.mjs
- automation:runtime-error-intake: node scripts/automations/runtime-error-intake.mjs scan
- automation:system-reference: node scripts/automations/rolling-system-reference.mjs
- automation:install: node scripts/automations/install-openclaw-crons.mjs
- automation:verify: node scripts/automations/verify-automations.mjs

## Known issues
- Cron registration is prepared but not auto-enabled until backup remote and delivery targets are confirmed.
- Daily brief and system reference quality depends on current repo docs and task hygiene.
- Cross-project drift should be treated as a regression and removed instead of archived into active repo context.

## Working tree snapshot
- M .env.example
- M AGENTS.md
- M CLAUDE.md
- M DELEGATION-RULES.md
- M DOCKER.md
- M IDENTITY.md
- M MEMORY.md
- M PRIORITIES.md
- M PRODUCTION_HANDOFF.md
- M PROTECTED_SYSTEMS.md
- M README-runtime.md
- M README.md
- M RUNTIME.md
- M SOUL.md
- M TOOLS.md
- D data/org-chart.json
- D docs/briefs/2026-03-29-brief.md
- D docs/briefs/2026-04-04-brief.md
- D docs/briefs/2026-04-07-brief.md
- D docs/briefs/2026-04-09-brief.md

## Reference date
- 2026-04-14
