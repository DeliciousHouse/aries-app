# Aries System Reference

Last refreshed May 4, 2026, 16:00 UTC.

## What changed today
- README.md
- DOCKER.md
- docs/SYSTEM-REFERENCE.md
- scripts/automations/rolling-system-reference.mjs

## Current architecture overview

### Hermes-Native Execution (Default)
- Next.js App Router runtime serves the public site, authenticated operator shell, and browser-safe internal APIs.
- Backend domain logic lives under `backend/*` and routes long-running execution through Hermes by default.
- `backend/execution/*` owns the general execution provider boundary; the Hermes adapter wires the supported Hermes workflow set and is the default for all active workflows.
- Social content execution uses `backend/marketing/execution-port.ts`; `ARIES_MARKETING_EXECUTION_PROVIDER=hermes` (the default) submits `social_content_weekly` runs (version `2026-05-social-content-weekly-v1`) to Hermes and advances runtime state from authenticated `/api/internal/hermes/runs` callbacks.
- Weekly media generation is Hermes-native: Aries sends abstract media requests, Hermes owns ChatGPT/OpenAI auth, and text planning can still run without media generation.
- Local runtime state and typed adapters live across `lib/*`, `hooks/*`, `specs/*`, and `workflows/*` to preserve contract boundaries.
- Repo context and automation output should stay scoped to `aries-app` only.

### Provider Compatibility (Legacy)
- The legacy OpenClaw/Lobster adapter is **opt-in only** and not used by default. It is kept for backward-compatibility on flows that have not yet been migrated.
- Enable explicitly with `ARIES_EXECUTION_PROVIDER=legacy-openclaw` (general execution) or `ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw` (marketing). When unset, Hermes is selected.
- `ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw` only affects the legacy `brand_campaign` compatibility flow. The `weekly_social_content` job type is Hermes-only regardless of this setting — the provider is chosen by job type, not env var.
- The legacy adapter is reserved for onboarding or `brand_campaign` compatibility paths. New code should not depend on it.

## Module inventory
- app/ 130 files
- backend/ 103 files
- components/ 4 files
- hooks/ 17 files
- lib/ 28 files
- scripts/ 38 files
- skills/ 76 files
- workflows/ 4 files

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles — Stage current repo changes, commit them to a backup branch, and create or update a backup pull request on the configured private GitHub remote.
- Aries overnight self-improvement — 0 4 * * * America/Los_Angeles — Pick one small additive nightly improvement, validate it, and log the shipped result to the nightly build log plus daily memory.
- Aries daily brief — 0 8 * * * America/Los_Angeles — Generate the morning priorities/overnight activity/pending actions brief.
- Aries daily standup — 30 8,13,17 * * 1-5 America/Los_Angeles — Generate the board-derived Aries chief standup, write the transcript and per-chief reports to /home/node/.openclaw/projects/shared/team/meetings, and announce the concise operational summary.
- Aries standup watchdog — 50 8,13,17 * * 1-5 America/Los_Angeles — Verify that the current standup transcript and per-chief reports exist in /home/node/.openclaw/projects/shared/team/meetings and that no forbidden local standup artifacts were recreated.
- Aries GitHub feedback connector — 0 7 * * * America/Los_Angeles — Sync GitHub issues, classify bug vs feature, route each pending item to the correct skill workflow, and update the processing log.
- Aries GitHub feedback daily summary — 0 18 * * * America/Los_Angeles — Deliver the daily batch summary for non-critical GitHub feedback items that were processed and logged.
- Aries CI watcher dispatcher — */15 * * * * America/Los_Angeles — Auto-spawn ao worker sessions for open ci-watcher issues filed by the remote CI watcher trigger, deduplicating against existing ao sessions by issue number.
- Aries runtime error intake — 5,35 * * * * America/Los_Angeles — Scan Aries runtime and automation health, normalize failures into the runtime incident log, and announce the concise detection/resolution summary.
- Aries runtime error repair loop — 10,40 * * * * America/Los_Angeles — Work the highest-priority repairable runtime incident with a bounded fix loop, validate the result, and announce the concise resolution or escalation summary.
- Aries rolling system reference — 45 21 * * * America/Los_Angeles — Update docs/SYSTEM-REFERENCE.md with architecture, inventory, cron jobs, and known issues.
- Aries daily standup — 0 9 * * 1-5 America/Los_Angeles — Generate a board-based daily standup transcript with per-lane chief reports, workspace verification, and blocker visibility.
- Aries weekly review — 0 14 * * 5 America/Los_Angeles — Generate the Friday weekly review from live board, git, cron, backlog, and service-health truth, save it under memory/reviews, and optionally email the HTML version.

## Runtime scripts
- dev: next dev --turbopack
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
- validate:execution-provider: APP_BASE_URL=https://aries.example.com tsx --test tests/execution-provider-selection.test.ts tests/execution-hermes-adapter.test.ts tests/hermes-callback-route.test.ts tests/execution-run-store.test.ts tests/marketing-execution-port.test.ts tests/marketing-hermes-callback-flow.test.ts tests/social-content-execution-contract.test.ts
- validate:social-content: APP_BASE_URL=https://aries.example.com tsx --test tests/social-content-execution-contract.test.ts tests/social-content-weekly-defaults.test.ts tests/social-content-approve-route.test.ts tests/integrations-openai-safety.test.ts tests/social-content-new-job-screen.test.ts tests/marketing-job-route.smoke.test.ts tests/runtime-pages.test.ts tests/docs-social-content-guidance.test.ts tests/social-content-public-copy.test.ts
- validate:marketing-flow: APP_BASE_URL=https://aries.example.com tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
- validate:repo-boundary: node scripts/check-repo-boundary.mjs
- validate:homepage-perf: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
- validate:homepage-perf:mobile: mkdir -p .artifacts && CI=1 npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --form-factor=mobile --screenEmulation.mobile=true --throttling-method=simulate --no-enable-error-reporting --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage-mobile.json
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
- The Hermes general execution adapter does not implement every legacy workflow; onboarding or `brand_campaign` compatibility paths that still require Lobster should opt in explicitly via `ARIES_EXECUTION_PROVIDER=legacy-openclaw`. See the "Provider Compatibility (Legacy)" section above.

## Working tree snapshot
- Docs-only refresh branch updated setup/runtime docs for Hermes-native weekly social content and kept legacy OpenClaw/Lobster notes in deprecated sections.

## Reference date
- 2026-05-04
