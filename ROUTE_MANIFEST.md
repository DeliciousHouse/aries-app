# Aries AI — Route Manifest

## Marketing Site (Public)

| Route | Page | Description |
|---|---|---|
| `/` | Landing | Redesigned hero, execution-boundary overview, and operator CTAs |
| `/features` | Features | Redesigned capability grid for workflow, platform, and security features |
| `/documentation` | Documentation | Runtime overview, local setup, and OpenClaw workflow boundary |
| `/api-docs` | API Reference | Browser-safe internal API reference with frontend-facing request/response shapes |
| `/contact` | Contact | Contact placeholder; `/api/contact` is intentionally not implemented in this runtime |

## App Shell (Authenticated)

| Route | Page | Description |
|---|---|---|
| `/dashboard` | Dashboard | Redesigned operator overview with stat cards, recent jobs, and quick actions |
| `/posts` | Posts | Guidance surface that points operators back to the canonical marketing job publish flow |
| `/calendar` | Calendar | Calendar sync controls and scheduling guidance |
| `/platforms` | Platforms | Live OAuth broker status; token expiry shown only when the backend provides it |
| `/settings` | Settings | Read-only placeholder; live tenant settings API is not implemented |

## Internal App Routes

| Route | Page | Description |
|---|---|---|
| `/marketing/new-job` | New Marketing Job | Redesigned canonical `brand_campaign` creation flow |
| `/marketing/job-status` | Job Status | Redesigned job monitoring with stage and repair guidance |
| `/marketing/job-approve` | Job Approval | Redesigned human-in-the-loop approval controls |
| `/onboarding/start` | Onboarding Start | Redesigned tenant onboarding launch flow |
| `/onboarding/status` | Onboarding Status | Browser-safe onboarding status reader with artifact summaries |
| `/oauth/connect/:provider` | OAuth Handoff | Branded Aries OAuth connect/reconnect/result surface |

## API Routes

| Method | Route | Runtime Status | Backing Path |
|---|---|---|---|
| POST | `/api/contact` | `501` explicit unavailable | Logs payload only; no workflow deployed |
| POST | `/api/demo` | OpenClaw parity stub | `parity/demo-start/workflow.lobster` |
| POST | `/api/sandbox/launch` | OpenClaw parity stub | `parity/sandbox-launch/workflow.lobster` |
| POST | `/api/waitlist` | `501` explicit unavailable | Logs payload only; no workflow deployed |
| POST | `/api/events` | `501` explicit unavailable | Logs payload only; no workflow deployed |
| POST | `/api/onboarding/start` | OpenClaw parity stub | `parity/onboarding-start/workflow.lobster` |
| GET | `/api/onboarding/status/:tenantId` | Local runtime lookup | Frontend-safe provisioning + artifact summary |
| POST | `/api/marketing/jobs` | ✅ | Aries-managed stage orchestration: Stage 1 research + Stage 2 strategy review |
| GET | `/api/marketing/jobs/:jobId` | Aries runtime read model | Frontend-safe job status, approval, and publish-config view |
| POST | `/api/marketing/jobs/:jobId/approve` | ✅ | Resume the persisted job into the next real stage workflow checkpoint |
| POST | `/api/publish/dispatch` | OpenClaw parity stub | `parity/publish-dispatch/workflow.lobster` |
| POST | `/api/publish/retry` | OpenClaw parity stub | `parity/publish-retry/workflow.lobster` |
| GET | `/api/integrations` | ✅ | Live OAuth broker read model; no sync telemetry |
| POST | `/api/integrations/connect` | ✅ | OAuth flow |
| POST | `/api/integrations/disconnect` | ✅ | Provider disconnect |
| POST | `/api/integrations/sync` | ✅ | Provider sync |
| GET/POST | `/api/oauth/:provider/*` | ✅ | OAuth lifecycle |
| POST | `/api/calendar/sync` | OpenClaw parity stub | `parity/calendar-sync/workflow.lobster` |
| GET | `/api/platform-connections` | ✅ | Connection status with token health derived from `token_expires_at` |
