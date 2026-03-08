# marketing-new-job-screen-builder

## Scope
Updated the thin frontend new-job screen for marketing to use shared client/contracts and to explicitly handle loading/success/error with a status-link handoff.

## Changes made
- Updated `./frontend/marketing/new-job.tsx`.
- Kept submit payload strictly aligned to `PostMarketingJobsRequest`:
  - `tenantId` (required)
  - `jobType` (from `MarketingJobType`)
  - `payload` (optional JSON object)
- Uses shared `createMarketingClient(...).createJob(...)` and shared contract types.
- Added explicit UI states:
  - **loading** via `submitting`
  - **error** via `errorText` (including API error payloads)
  - **success** via typed `StartJobAccepted` state
- Added post-success link to job status screen:
  - `./job-status?jobId=<accepted jobId>`

## Contract adherence
- No invented request fields.
- No backend changes.
- No file edits outside assigned scope.
