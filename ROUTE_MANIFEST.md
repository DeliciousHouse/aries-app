# Aries AI — Route Manifest

This manifest lists the supported direct route contract for the current Aries runtime. Removed placeholder routes are intentionally omitted.

## Public routes

| Route | Surface | Purpose |
|---|---|---|
| `/` | Marketing site | Homepage and primary product narrative |
| `/features` | Marketing site | Capability overview for the current operator surface |
| `/documentation` | Marketing site | Runtime architecture, setup, and validation steps |
| `/api-docs` | Marketing site | Browser-safe API reference for the current UI contract |
| `/public-:brandSlug/campaign` | Public campaign page | Generated landing page backed by Lobster stage outputs |

## Authenticated operator routes

| Route | Surface | Purpose |
|---|---|---|
| `/dashboard` | App shell | Operator overview |
| `/dashboard/campaigns` | App shell | Campaign list and workspace entrypoint |
| `/dashboard/campaigns/:campaignId` | App shell | Campaign workspace |
| `/dashboard/posts` | App shell | Publish controls |
| `/dashboard/calendar` | App shell | Calendar and sync controls |
| `/dashboard/results` | App shell | Runtime-backed results overview |
| `/dashboard/settings` | App shell | Tenant settings surface |
| `/review` | App shell | Review queue |
| `/review/:reviewId` | App shell | Review detail |

## Workflow routes

| Route | Surface | Purpose |
|---|---|---|
| `/onboarding/start` | Workflow | Start tenant onboarding |
| `/onboarding/status` | Workflow | Read onboarding status |
| `/marketing/new-job` | Workflow | Create a `brand_campaign` marketing job |
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
| `GET` | `/api/marketing/jobs/latest` | Read latest job status for the active tenant |
| `POST` | `/api/marketing/jobs/:jobId/approve` | Resume an approval-gated job |
| `GET` | `/api/marketing/jobs/:jobId/assets/:assetId` | Read a generated marketing asset stream |
| `GET` | `/api/marketing/posts` | Read tenant-scoped posts and publish inventory feed |
| `GET` | `/api/marketing/campaigns` | Read tenant campaign list view model |
| `GET` | `/api/marketing/reviews` | Read pending tenant review queue items |
| `GET` | `/api/marketing/reviews/:reviewId` | Read a single tenant review item |
| `POST` | `/api/marketing/reviews/:reviewId/decision` | Record approve/reject/changes_requested decision |
| `GET` | `/api/integrations` | Read integrations page data |
| `POST` | `/api/integrations/connect` | Start a platform connection |
| `POST` | `/api/integrations/disconnect` | Disconnect a platform |
| `POST` | `/api/integrations/sync` | Trigger a platform sync |
| `GET` | `/api/platform-connections` | Read connection health summaries |
| `GET`, `POST` | `/api/oauth/:provider/*` | OAuth lifecycle routes |
| `POST` | `/api/publish/dispatch` | Dispatch publish work |
| `POST` | `/api/publish/retry` | Retry publish work |
| `POST` | `/api/calendar/sync` | Trigger calendar sync |

## Marketing inventory notes

- `/api/marketing/posts` is the inventory contract used by the posts dashboard and should be treated as the canonical "ready now" feed.
- The response is sourced from `backend/marketing/dashboard-content.ts` and includes normalized `campaigns`, `posts`, `assets`, `publishItems`, `calendarEvents`, and aggregated status counts.
- Route handlers under `/api/marketing/*` are tenant-scoped via `loadTenantContextOrResponse`, with a documented dev/staging bypass on selected job routes when `MARKETING_STATUS_PUBLIC=1|true`: `POST /api/marketing/jobs`, `GET /api/marketing/jobs/:jobId`, `POST /api/marketing/jobs/:jobId/approve`, and `GET /api/marketing/jobs/:jobId/assets/:assetId`.
- `GET /api/marketing/jobs/latest` is single-job status oriented; `GET /api/marketing/posts` is cross-job inventory oriented.

## Verification commands

```bash
./node_modules/.bin/tsx --test tests/runtime-pages.test.ts
node scripts/check-banned-patterns.mjs
APP_BASE_URL=https://aries.example.com ./node_modules/.bin/tsx --test tests/marketing-job-flow.test.ts tests/onboarding-marketing-contracts.test.ts
mkdir -p .artifacts && npx --yes lighthouse http://127.0.0.1:3000 --only-categories=performance --preset=desktop --chrome-flags='--headless=new --no-sandbox --disable-dev-shm-usage' --output=json --output-path=.artifacts/lighthouse-homepage.json
```
