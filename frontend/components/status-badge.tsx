import type {
  marketing_job_status,
  onboarding_status,
  provisioning_status,
  repair_status
} from '../types/runtime';

type SharedStatus = onboarding_status | provisioning_status | marketing_job_status | repair_status;

export interface StatusBadgeProps {
  status: SharedStatus;
}

const toneByStatus: Record<SharedStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  accepted: 'info',
  duplicate: 'warning',
  validated: 'success',
  needs_repair: 'warning',
  ok: 'success',
  error: 'danger',
  in_progress: 'info',
  not_found: 'warning',
  pass: 'success',
  fail: 'danger',
  unknown: 'neutral',
  running: 'info',
  completed: 'success',
  success: 'success',
  failed: 'danger',
  blocked: 'danger',
  ready: 'success',
  awaiting_approval: 'warning',
  ready_for_production: 'info',
  resumed: 'info',
  rejected: 'danger',
  retry_scheduled: 'warning',
  retry_complete: 'success',
  hard_failure: 'danger',
  required: 'warning',
  patched: 'info',
  rerun_passed: 'success',
  rerun_failed: 'danger',
  exhausted: 'danger',
  not_required: 'neutral'
};

export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  return (
    <span data-status={status} data-tone={toneByStatus[status]}>
      {status}
    </span>
  );
}

export default StatusBadge;
