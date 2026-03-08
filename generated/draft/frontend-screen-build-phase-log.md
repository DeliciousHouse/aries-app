# Frontend Screen Build Validation Phase Log

## Scope
Validated 5 frontend screens and 3 shared components against frozen frontend contracts/types and shared API clients.

## Inputs reviewed
- `frontend/api/contracts/onboarding.ts`
- `frontend/api/contracts/marketing.ts`
- `frontend/api/client/onboarding.ts`
- `frontend/api/client/marketing.ts`
- `frontend/onboarding/start.tsx`
- `frontend/onboarding/status.tsx`
- `frontend/marketing/new-job.tsx`
- `frontend/marketing/job-status.tsx`
- `frontend/marketing/job-approve.tsx`
- `frontend/components/next-step-card.tsx`
- `frontend/components/status-badge.tsx`
- `frontend/components/error-panel.tsx`

## Endpoint/client compliance
All five screens use shared clients only:
- Onboarding start: `client.start` -> `POST /api/onboarding/start`
- Onboarding status: `client.status` -> `GET /api/onboarding/status/:tenantId`
- Marketing new job: `client.createJob` -> `POST /api/marketing/jobs`
- Marketing job status: `client.getJob` -> `GET /api/marketing/jobs/:jobId`
- Marketing approve: `client.approveJob` + `client.getJob`

No ad hoc `fetch` request shapes were found in the five screens.

## Contract/type findings
### Failures
1. `frontend/onboarding/start.tsx`
   - References `result?.onboarding_status === 'ok'` for success branch.
   - Frozen success contract is `OnboardingStartSuccess` with `status: 'ok'` (not `onboarding_status`).

2. `frontend/onboarding/status.tsx`
   - Adds `OnboardingStatusSuccessWithOptionalFields` with non-contract fields:
     - `repair_status`
     - `next_step`
     - `latest_message`

3. `frontend/marketing/job-status.tsx`
   - Adds `OptionalContractExtras` with non-contract fields:
     - `repair_status`
     - `next_step`
     - `latest_artifacts`
     - `latest_messages`

### Passes
- `frontend/marketing/new-job.tsx`
- `frontend/marketing/job-approve.tsx`
- Shared components (`next-step-card`, `status-badge`, `error-panel`) are type-consistent with shared local runtime/error types and do not use ad hoc API calls.

## Overall result
- Checked: 8 files (5 screens + 3 shared components)
- Pass: 5
- Fail: 3
- Final: **FAIL** (due to frozen-contract field drift in 3 screens)
