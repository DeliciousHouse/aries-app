# Subagent Log: frontend-wireup-validator

## Task
Validate all 5 frontend screens + shared components against frozen contracts/types and shared clients.

## Actions completed
1. Located and reviewed all relevant contract and client files.
2. Reviewed all 5 screen implementations.
3. Reviewed shared component/type files used by those screens.
4. Checked for:
   - shared type imports
   - shared client endpoint usage
   - undefined/non-contract field references
   - ad hoc request shapes
5. Wrote required result artifacts.

## Key findings
- Shared client usage is consistent across all screens.
- No ad hoc request shape construction outside typed shared-client calls.
- Contract drift exists in 3 screens due to local extension/casting to fields not in frozen contracts.

## Failed files and why
- `frontend/onboarding/start.tsx`: success path checks `onboarding_status` (contract uses `status` for success).
- `frontend/onboarding/status.tsx`: reads `repair_status`, `next_step`, `latest_message` not present in `OnboardingStatusSuccess`.
- `frontend/marketing/job-status.tsx`: reads `repair_status`, `next_step`, `latest_artifacts`, `latest_messages` not present in `GetMarketingJobStatusResponse`.

## Final status
**FAIL** (5 pass, 3 fail).
