# Aries AI — Route Manifest

## Marketing Site (Public)

| Route | Page | Description |
|---|---|---|
| `/` | Landing | Hero, capability preview, CTAs |
| `/features` | Features | Full capability grid (12 cards) |
| `/documentation` | Documentation | Getting started, architecture, OpenClaw workflow boundary, integrations, security |
| `/api-docs` | API Reference | Endpoint reference with request/response shapes |
| `/contact` | Contact | Contact placeholder; `/api/contact` is intentionally not implemented in this runtime |

## App Shell (Authenticated)

| Route | Page | Description |
|---|---|---|
| `/dashboard` | Dashboard | Stat cards, recent marketing jobs, queue health |
| `/posts` | Posts | Create marketing jobs, dispatch publish events |
| `/calendar` | Calendar | Weekly schedule grid, sync configuration |
| `/platforms` | Platforms | Live OAuth broker status; token expiry shown only when the backend provides it |
| `/settings` | Settings | Read-only placeholder; live tenant settings API is not implemented |

## Internal App Routes

| Route | Page | Description |
|---|---|---|
| `/marketing/new-job` | New Marketing Job | Canonical `brand_campaign` creation form |
| `/marketing/job-status` | Job Status | Job monitoring |
| `/marketing/job-approve` | Job Approval | Human-in-the-loop approval |
| `/onboarding/start` | Onboarding Start | Tenant onboarding |
| `/onboarding/status` | Onboarding Status | Local onboarding runtime-status reader |

## API Routes

| Method | Route | Runtime Status | Backing Path |
|---|---|---|---|
| POST | `/api/contact` | `501` placeholder | Logs payload only; no workflow deployed |
| POST | `/api/demo` | OpenClaw parity stub | `parity/demo-start/workflow.lobster` |
| POST | `/api/sandbox/launch` | OpenClaw parity stub | `parity/sandbox-launch/workflow.lobster` |
| POST | `/api/waitlist` | `501` placeholder | Logs payload only; no workflow deployed |
| POST | `/api/events` | `501` placeholder | Logs payload only; no workflow deployed |
| POST | `/api/onboarding/start` | OpenClaw parity stub | `parity/onboarding-start/workflow.lobster` |
| GET | `/api/onboarding/status/:tenantId` | Local runtime lookup | `generated/draft|validated/...` artifacts |
| POST | `/api/marketing/jobs` | ✅ | `marketing-pipeline.lobster` via OpenClaw Gateway |
| GET | `/api/marketing/jobs/:jobId` | Local runtime lookup | `generated/draft/marketing-jobs/:jobId.json` |
| POST | `/api/marketing/jobs/:jobId/approve` | OpenClaw parity stub | `parity/marketing-approve/workflow.lobster` |
| POST | `/api/publish/dispatch` | OpenClaw parity stub | `parity/publish-dispatch/workflow.lobster` |
| POST | `/api/publish/retry` | OpenClaw parity stub | `parity/publish-retry/workflow.lobster` |
| GET | `/api/integrations` | ✅ | Live OAuth broker read model; no sync telemetry |
| POST | `/api/integrations/connect` | ✅ | OAuth flow |
| POST | `/api/integrations/disconnect` | ✅ | Provider disconnect |
| POST | `/api/integrations/sync` | ✅ | Provider sync |
| GET/POST | `/api/oauth/:provider/*` | ✅ | OAuth lifecycle |
| POST | `/api/calendar/sync` | OpenClaw parity stub | `parity/calendar-sync/workflow.lobster` |
| GET | `/api/platform-connections` | ✅ | Connection status with token health derived from `token_expires_at` |
