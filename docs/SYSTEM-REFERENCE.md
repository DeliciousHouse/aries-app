# Aries System Reference

Last refreshed Apr 13, 2026, 00:00 PDT.

## What changed since last refresh
- Backup snapshot committed (68c7cdd) with 84 files including .env.example, DELEGATION-RULES.md, IDENTITY.md, MEMORY.md, SOUL.md, PRIORITIES.md updates.
- Automation scripts updated: daily-standup.mjs, install-openclaw-crons.mjs, manifest.mjs.
- Next.js bumped from 16.1.7 to 16.2.3 (npm_and_yarn dependabot, #83).
- Onboarding postgres migration review fixes landed (#82).
- Onboarding draft/business-profile persistence to PostgreSQL shipped (#81).
- Frontend website changes merged (#80) including marketing hero orbit sync, docs/chrome updates, init-db tweak.
- Working tree has merge conflicts in data/feedback-processing-log.json, scripts/automations/install-openclaw-crons.mjs, scripts/automations/manifest.mjs (UU state).
- Incubator micro-SaaS projects moved out of `aries-app` into standalone repos under `/home/node/.openclaw/projects/incubator/`.

## Current architecture overview
- Next.js 16 App Router runtime serves the public marketing site, authenticated operator shell, and browser-safe internal APIs on port 8100.
- Backend domain logic lives under backend/* and routes long-running execution through OpenClaw Gateway (CLI subprocess, not HTTP).
- 4-stage Lobster marketing pipeline (research, strategy, production, publish-optimize) with approval checkpoints driven by backend/marketing/orchestrator.ts.
- Auth via next-auth v5 with Credentials + Google providers; tenant-aware RBAC with roles: tenant_admin, tenant_analyst, tenant_viewer.
- Local runtime state and typed adapters live across lib/*, hooks/*, specs/*, and workflows/*.
- Standalone Mission Control deploys as a separate image and reads /api/runtime/overview.
- PostgreSQL for persistent state; runtime files under DATA_ROOT for generated artifacts.

## Module inventory
- app/ 107 files (routes, API handlers, layouts)
- backend/ 73 files (domain logic, integrations, auth, marketing, onboarding, tenant, video)
- frontend/ 88 files (UI components, presenters, services, types)
- components/ 14 files (shared React components)
- hooks/ 17 files (React hooks)
- lib/ 21 files (runtime paths, tenant context, utilities)
- scripts/ 26 files (automation, build, verification)
- tests/ 56 test files
- skills/ 49 skill directories
- workflows/ 4 files
- lobster/ marketing pipeline definitions

## Active cron jobs
- Aries private repo backup — 15 */6 * * * America/Los_Angeles
- Aries overnight self-improvement — 0 4 * * * America/Los_Angeles
- Aries daily brief — 0 8 * * * America/Los_Angeles
- Aries GitHub feedback connector — 0 7 * * * America/Los_Angeles
- Aries GitHub feedback daily summary — 0 18 * * * America/Los_Angeles
- Aries rolling system reference — 45 21 * * * America/Los_Angeles
- Aries daily standup — 0 9 * * 1-5 America/Los_Angeles
- Aries weekly review — 0 14 * * 5 America/Los_Angeles

## Runtime scripts
- dev: next dev -p 8100 --turbopack
- build: next build
- start: node scripts/start-runtime.mjs
- precheck: node scripts/runtime-precheck.mjs
- workspace:verify: node scripts/verify-canonical-workspace.mjs
- typecheck: tsc --noEmit
- lint: tsc --noEmit && node scripts/check-banned-patterns.mjs
- test: tsx --test tests/*.test.ts tests/**/*.test.ts
- test:e2e: tsx --test (6 e2e test files)
- db:init: node scripts/init-db.js
- verify: node scripts/verify-regression-suite.mjs
- validate:public-routes: tsx --test tests/runtime-pages.test.ts tests/public-marketing-pages.test.ts
- validate:banned-patterns: node scripts/check-banned-patterns.mjs
- validate:marketing-flow: APP_BASE_URL=https://aries.example.com tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
- automation:install: node scripts/automations/install-openclaw-crons.mjs
- automation:verify: node scripts/automations/verify-automations.mjs

## Priority blockers (from PRIORITIES.md)
1. workflow-target-contract-drift — workflow catalog vs tested marketing pipeline contract disagree
2. stub-routes-still-exposed — UI-facing stub routes make supported surface look broader than reality
3. route-and-doc-drift — route manifests and runtime docs lag the executable app

## Known issues
- Merge conflicts in working tree: data/feedback-processing-log.json, scripts/automations/install-openclaw-crons.mjs, scripts/automations/manifest.mjs (UU state — need resolution).
- Daily brief and system reference depend on local markdown/task hygiene.
- Mission Control standalone app awaits richer live API adapters.
- Current phase: freeze-production-contract.

## Working tree snapshot
- M app/api/marketing/jobs/handler.ts
- UU data/feedback-processing-log.json
- AA data/nightly-build-log.json
- AA docs/briefs/2026-04-12-brief.md
- M frontend/aries-v1/review-item.tsx
- M frontend/marketing/new-job.tsx
- AA scripts/automations/daily-standup.mjs
- UU scripts/automations/install-openclaw-crons.mjs
- UU scripts/automations/manifest.mjs
- Incubator micro-SaaS source now lives outside this repo at `/home/node/.openclaw/projects/incubator/`.

## Reference date
- 2026-04-13
