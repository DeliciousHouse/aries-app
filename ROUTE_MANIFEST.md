# Aries AI — Route Manifest

This manifest lists the supported direct route contract for the current Aries runtime. Removed placeholder routes are intentionally omitted.

## Public routes

| Route | Surface | Purpose |
|---|---|---|
| `/` | Marketing site | Homepage and primary product narrative |
| `/features` | Marketing site | Capability overview for the current operator surface |
| `/documentation` | Marketing site | Runtime architecture, setup, and validation steps |
| `/api-docs` | Marketing site | Browser-safe API reference for the current UI contract |
| `/public-:brandSlug/campaign` | Public campaign page | Generated landing page backed by generated artifacts |

## Authenticated operator routes

| Route | Surface | Purpose |
|---|---|---|
| `/dashboard` | App shell | Operator overview |
| `/dashboard/social-content` | App shell | Weekly social content list and workspace entrypoint |
| `/dashboard/social-content/:postId` | App shell | Social content post workspace |
| `/dashboard/posts` | App shell | Publish controls |
| `/dashboard/calendar` | App shell | Calendar and sync controls |
| `/dashboard/results` | App shell | Runtime-backed results overview |
| `/dashboard/settings` | App shell | Tenant settings surface |
| `/review` | App shell | Review queue |
| `/review/:reviewId` | App shell | Review detail |

## Workflow routes

| Route | Surface | Purpose |
|---|---|---|
| `/onboarding/start` | Workflow | Start the premium client marketing intake |
| `/onboarding/pipeline-intake` | Workflow | Legacy redirect to `/onboarding/start` |
| `/onboarding/status` | Workflow | Read onboarding status |
| `/marketing/new-job` | Workflow | Create a weekly social content marketing job |
| `/marketing/job-status` | Workflow | Inspect marketing job status |
| `/marketing/job-approve` | Workflow | Resume approval-gated jobs |
| `/oauth/connect/:provider` | Workflow | Provider OAuth handoff and result page |

## UI-facing API routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/onboarding/start` | Start onboarding |
| `GET` | `/api/onboarding/status/:tenantId` | Read onboarding status |
| `POST` | `/api/marketing/jobs` | Start the canonical marketing flow |
| `GET` | `/api/marketing/jobs/:jobId` | Read job status |
| `POST` | `/api/marketing/jobs/:jobId/approve` | Resume an approval-gated job |
| `GET`, `PATCH` | `/api/marketing/schedule` | Read and update the weekly content-generation cadence (settings card) |
| `GET` | `/api/marketing/posting-times` | Read AI-derived per-platform posting times (settings card) |
| `POST` | `/api/marketing/posting-times/derive` | Force a fresh posting-time derivation (tenant admin; 404 when `ARIES_AI_POSTING_TIMES_ENABLED` is off) |
| `GET` | `/api/integrations` | Read integrations page data |
| `POST` | `/api/integrations/connect` | Start a platform connection |
| `POST` | `/api/integrations/disconnect` | Disconnect a platform |
| `POST` | `/api/integrations/sync` | Trigger a platform sync |
| `GET` | `/api/platform-connections` | Read connection health summaries |
| `GET`, `POST` | `/api/oauth/:provider/*` | OAuth lifecycle routes |
| `POST` | `/api/publish/dispatch` | Dispatch publish work |
| `POST` | `/api/publish/retry` | Retry publish work |
| `POST` | `/api/calendar/sync` | Trigger calendar sync |

## Verification commands

```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
node scripts/check-banned-patterns.mjs
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
```
