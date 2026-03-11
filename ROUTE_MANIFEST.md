# Aries AI — Route Manifest

## Marketing Site (Public)

| Route | Page | Description |
|---|---|---|
| `/` | Landing | Hero, capability preview, CTAs |
| `/features` | Features | Full capability grid (12 cards) |
| `/documentation` | Documentation | Getting started, architecture, n8n workflows, integrations, security |
| `/api-docs` | API Reference | Endpoint reference with request/response shapes |
| `/contact` | Contact | Contact form → POST `/api/contact` |

## App Shell (Authenticated)

| Route | Page | Description |
|---|---|---|
| `/dashboard` | Dashboard | Stat cards, recent marketing jobs, queue health |
| `/posts` | Posts | Create marketing jobs, dispatch publish events |
| `/calendar` | Calendar | Weekly schedule grid, sync configuration |
| `/platforms` | Platforms | OAuth connection management (7 platforms) |
| `/settings` | Settings | Tenant profile, session security |

## Internal App Routes

| Route | Page | Description |
|---|---|---|
| `/marketing/new-job` | New Marketing Job | Job creation form |
| `/marketing/job-status` | Job Status | Job monitoring |
| `/marketing/job-approve` | Job Approval | Human-in-the-loop approval |
| `/onboarding/start` | Onboarding Start | Tenant onboarding |
| `/onboarding/status` | Onboarding Status | Provisioning status |

## API Routes

| Method | Route | Wired to n8n? | Webhook Path |
|---|---|---|---|
| POST | `/api/contact` | ❌ Log-only | — |
| POST | `/api/demo` | ✅ | `/webhook/tenant-provisioning` |
| POST | `/api/sandbox/launch` | ✅ | `/webhook/tenant-provisioning` |
| POST | `/api/waitlist` | ❌ Log-only | — |
| POST | `/api/events` | ❌ Log-only | — |
| POST | `/api/onboarding/start` | ✅ | `/webhook/tenant-provisioning` |
| GET | `/api/onboarding/status/:tenantId` | ✅ | `/webhook/tenant-provisioning` |
| POST | `/api/marketing/jobs` | ✅ | `/webhook/marketing-research` |
| GET | `/api/marketing/jobs/:jobId` | ✅ | (file-based status) |
| POST | `/api/marketing/jobs/:jobId/approve` | ✅ | `/webhook/marketing-approval-resume` |
| POST | `/api/publish/dispatch` | ✅ | `/webhook/aries/publish` |
| POST | `/api/publish/retry` | ✅ | (retry logic) |
| GET | `/api/integrations` | ✅ | (provider registry) |
| POST | `/api/integrations/connect` | ✅ | OAuth flow |
| POST | `/api/integrations/disconnect` | ✅ | Provider disconnect |
| POST | `/api/integrations/sync` | ✅ | Provider sync |
| GET/POST | `/api/oauth/:provider/*` | ✅ | OAuth lifecycle |
| POST | `/api/calendar/sync` | ✅ | Calendar sync |
| GET | `/api/platform-connections` | ✅ | Connection status |
