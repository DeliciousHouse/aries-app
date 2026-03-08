# marketing-job-status-screen-builder

## Summary
Implemented a thin `frontend/marketing/job-status.tsx` screen focused on status lookup only.

## What was changed
- Uses shared client helper: `createMarketingClient({ baseUrl }).getJob(jobId)`.
- Calls `GET /api/marketing/jobs/:jobId` by job id.
- Handles loading and request/runtime error states.
- Renders contract status fields:
  - `marketing_stage`
  - `marketing_job_status`
- Adds derived `approval_pending` as `true` when:
  - `marketing_job_status === "awaiting_approval"`, or
  - current stage status is `awaiting_approval`.
- Conditionally renders only-if-present response extras:
  - `repair_status`
  - `next_step`
  - `latest_artifacts`
  - `latest_messages`

## Scope check
- Updated only the requested three files.
- No backend redesign or backend file changes.
- No new mandatory API fields introduced.
