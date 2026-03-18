# Aries AI — Workflow Manifest

Aries now treats OpenClaw Gateway as the execution boundary. The app does not
own runtime workflow execution locally; it calls OpenClaw and reads back
results or parity-stub responses.

## Active OpenClaw Workflow Targets

| API Route | OpenClaw Workflow Target | Mode |
|---|---|---|
| `/api/marketing/jobs` | `marketing-pipeline.lobster` | real |
| `/api/demo` | `parity/demo-start/workflow.lobster` | stub |
| `/api/sandbox/launch` | `parity/sandbox-launch/workflow.lobster` | stub |
| `/api/onboarding/start` | `parity/onboarding-start/workflow.lobster` | stub |
| `/api/marketing/jobs/:jobId/approve` | `parity/marketing-approve/workflow.lobster` | stub |
| `/api/publish/dispatch` | `parity/publish-dispatch/workflow.lobster` | stub |
| `/api/publish/retry` | `parity/publish-retry/workflow.lobster` | stub |
| `/api/calendar/sync` | `parity/calendar-sync/workflow.lobster` | stub |
| `/api/integrations/sync` | `parity/integrations-sync/workflow.lobster` | stub |

## Placeholder Endpoints

These routes still return explicit `501` placeholders after logging the payload:

| API Route | Expected Future Workflow |
|---|---|
| `/api/contact` | contact intake workflow |
| `/api/waitlist` | waitlist signup workflow |
| `/api/events` | event tracking workflow |
