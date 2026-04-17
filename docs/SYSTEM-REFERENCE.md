# Aries System Reference

Last refreshed Apr 17, 2026, 00:00 PDT.

## What changed today
- backend/marketing/runtime-views.ts
- lib/simple-markdown.ts
- app/api/marketing/campaigns/route.ts
- app/api/marketing/jobs/[jobId]/delete/handler.ts
- app/api/marketing/jobs/[jobId]/restore/route.ts
- app/api/marketing/jobs/[jobId]/route.ts
- app/api/marketing/jobs/handler.ts
- app/onboarding/resume/page.tsx
- backend/marketing/orchestrator.ts
- backend/marketing/runtime-state.ts
- backend/openclaw/gateway-client.ts
- frontend/aries-v1/campaign-list.tsx
- hooks/use-runtime-campaigns.ts
- lib/api/aries-v1.ts
- tests/marketing-job-delete.test.ts
- app/api/marketing/jobs/[jobId]/assets/[assetId]/handler.ts
- app/materials/[jobId]/[assetId]/page.tsx
- backend/marketing/asset-library.ts
- backend/marketing/asset-read.ts
- tests/simple-markdown.test.ts
- frontend/aries-v1/campaign-workspace.tsx
- frontend/aries-v1/onboarding-flow.tsx
- frontend/aries-v1/review-item.tsx

## Current architecture overview
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under `backend/*` and routes long-running execution through OpenClaw Gateway.
- Local runtime state and typed adapters live across `lib/*`, `hooks/*`, `specs/*`, and `workflows/*` to preserve contract boundaries.
- Repo context and automation output should stay scoped to `aries-app` only.

## Module inventory
- app/ 117 files
- backend/ 75 files
- components/ 14 files
- hooks/ 17 files
- lib/ 25 files
- scripts/ 31 files
- skills/ 87 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage current repo changes, commit them to a backup branch, and create or update a backup pull request on the configured private GitHub remote.
- Aries overnight self-improvement — 0 4 * * * America/Los_Angeles — Pick one small additive nightly improvement, validate it, and log the shipped result to the nightly build log plus daily memory.
- Aries daily brief — 0 8 * * * America/Los_Angeles — Generate the morning priorities/overnight activity/pending actions brief.
- Aries daily standup — 30 8,13,17 * * 1-5 America/Los_Angeles — Generate the board-derived Aries chief standup, write the transcript and per-chief reports to /home/node/.openclaw/projects/shared/teams, and announce the concise operational summary.
- Aries standup watchdog — 50 8,13,17 * * 1-5 America/Los_Angeles — Verify that the current standup transcript and per-chief reports exist in /home/node/.openclaw/projects/shared/teams and that no forbidden local standup artifacts were recreated.
- Aries GitHub feedback connector — 0 7 * * * America/Los_Angeles — Sync GitHub issues, classify bug vs feature, route each pending item to the correct skill workflow, and update the processing log.
- Aries GitHub feedback daily summary — 0 18 * * * America/Los_Angeles — Deliver the daily batch summary for non-critical GitHub feedback items that were processed and logged.
- Aries CI watcher dispatcher — */15 * * * * America/Los_Angeles — Auto-spawn ao worker sessions for open ci-watcher issues filed by the remote CI watcher trigger, deduplicating against existing ao sessions by issue number.
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
- automation:ci-watcher-dispatch: node scripts/automations/ci-watcher-dispatch.mjs
- automation:system-reference: node scripts/automations/rolling-system-reference.mjs
- automation:install: node scripts/automations/install-openclaw-crons.mjs
- automation:verify: node scripts/automations/verify-automations.mjs

## Known issues
- Cron registration is prepared but not auto-enabled until backup remote and delivery targets are confirmed.
- Daily brief and system reference quality depends on current repo docs and task hygiene.
- Cross-project drift should be treated as a regression and removed instead of archived into active repo context.

## Working tree snapshot
- Working tree clean at refresh time.

## Reference date
- 2026-04-17
