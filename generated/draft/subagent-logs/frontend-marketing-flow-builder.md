# frontend-marketing-flow-builder

## Scope handled
- Updated only marketing UI files under `./frontend/marketing`.
- Used existing shared contracts/client/runtime types only.
- No backend or contract redesign performed.

## Changes made

### `frontend/marketing/new-job.tsx`
- Improved UX copy for flow handoff.
- Added clearer success state with accepted badge.
- Added direct links to both job status and approval screens after successful creation.
- Preserved request validation and error handling; kept API usage via existing marketing client.

### `frontend/marketing/job-status.tsx`
- Improved status page messaging for loading/error/success.
- Added rendering for:
  - `repair_status`
  - `next_step`
  - stage-by-stage status list
- Added next-step guidance text for known next-step values.
- Used shared runtime value sets (`marketing_job_status_values`, `repair_status_values`, `next_step_values`) for safe badge rendering.

### `frontend/marketing/job-approve.tsx`
- Added robust error handling on status load + approve action (`try/catch` with surfaced request error).
- Kept existing visual design while improving feedback states.
- Added summarized live status rendering:
  - job status (with badge)
  - current stage
  - repair status (with badge)
  - next step + guidance
  - stage status list
- Preserved raw JSON details sections for debugability.

### `frontend/marketing/state-view.ts` (new helper)
- Added shared helper for parsing/deriving marketing state hints from `marketing_job_state` + `marketing_stage_status`:
  - ordered stage status rows
  - `repair_status` extraction
  - `next_step` extraction
  - guidance text mapping for known next-step values

## Verification
- Ran `npx tsc --noEmit` from repo root (`aries-platform-bootstrap`) with no errors.
