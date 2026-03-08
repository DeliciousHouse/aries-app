# marketing-approve-screen-builder

## Summary
Updated `frontend/marketing/job-approve.tsx` as a thin contract-faithful approval screen.

## What was implemented
- Uses shared client helper: `createMarketingClient`.
- Approval action uses shared client endpoint call:
  - `client.approveJob(jobId, body)` → `POST /api/marketing/jobs/:jobId/approve`
- Uses shared contract types:
  - `PostMarketingJobApproveRequest`
  - `ApproveJobResult`
  - `GetMarketingJobStatusResponse`
  - `HardFailureError`
  - `UnhandledError`
  - `MarketingStage`

## Contract fidelity
- Request payload includes only contract-defined fields:
  - `tenantId`
  - `approvedBy`
  - `approvedStages` (optional)
  - `resumePublishIfNeeded` (optional)
- Stage choices limited to contract stages only:
  - `research`, `strategy`, `production`, `publish`
- No invented fields and no backend redesign/changes.

## UX behavior
- Inputs: `jobId`, `tenantId`, `approvedBy`.
- Optional stage checkboxes (empty means approve all).
- `Load job status` fetches current job via `client.getJob(jobId)`.
- `Approve job` submits approve request and refreshes status on non-error response.
- Explicit approval message shown:
  - Success when `approval_status === "resumed"`
  - Failure for `approval_status === "error"` or API error responses
- Raw JSON responses remain visible for operational debugging.

## Scope
- Updated only:
  - `frontend/marketing/job-approve.tsx`
  - `generated/draft/subagent-results/marketing-approve-screen-builder.json`
  - `generated/draft/subagent-logs/marketing-approve-screen-builder.md`
