# shared-ui-helper-builder

## Summary
Validated and finalized minimal shared UI helpers for status, error, and next-step rendering using canonical shared frontend runtime/error types.

## Files in scope
- `frontend/components/status-badge.tsx`
- `frontend/components/error-panel.tsx`
- `frontend/components/next-step-card.tsx`
- `generated/draft/subagent-results/shared-ui-helper-builder.json`
- `generated/draft/subagent-logs/shared-ui-helper-builder.md`

## Implementation notes
- `StatusBadge` accepts only shared runtime status unions:
  - `onboarding_status | provisioning_status | marketing_job_status | repair_status`
- `ErrorPanel` accepts only `BackendError` and renders kind-specific branches:
  - `validation_error`, `repair_error`, `hard_failure`
- `NextStepCard` accepts only canonical `next_step` values.
- No new backend schema/contract fields were introduced.
- No non-requested files were modified.
