import type {
  marketing_job_status,
  onboarding_status,
  provisioning_status,
  repair_status
} from '../types/runtime';

type SharedStatus = onboarding_status | provisioning_status | marketing_job_status | repair_status;
type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export interface StatusBadgeProps {
  status: SharedStatus;
}

const toneByStatus: Record<SharedStatus, StatusTone> = {
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

const labelByStatus: Record<SharedStatus, string> = {
  accepted: 'Accepted',
  duplicate: 'Duplicate',
  validated: 'Validated',
  needs_repair: 'Needs repair',
  ok: 'OK',
  error: 'Error',
  in_progress: 'In progress',
  not_found: 'Not found',
  pass: 'Pass',
  fail: 'Fail',
  unknown: 'Unknown',
  running: 'Running',
  completed: 'Completed',
  success: 'Success',
  failed: 'Failed',
  blocked: 'Blocked',
  ready: 'Ready',
  awaiting_approval: 'Awaiting approval',
  ready_for_production: 'Ready for production',
  resumed: 'Resumed',
  rejected: 'Rejected',
  retry_scheduled: 'Retry scheduled',
  retry_complete: 'Retry complete',
  hard_failure: 'Hard failure',
  required: 'Required',
  patched: 'Patched',
  rerun_passed: 'Rerun passed',
  rerun_failed: 'Rerun failed',
  exhausted: 'Exhausted',
  not_required: 'Not required'
};

function stateGroupFor(status: SharedStatus): 'retry' | 'empty' | 'active' | 'done' | 'error' | 'neutral' {
  if (status === 'retry_scheduled' || status === 'retry_complete') {
    return 'retry';
  }

  if (status === 'not_found' || status === 'not_required' || status === 'unknown') {
    return 'empty';
  }

  if (status === 'in_progress' || status === 'running' || status === 'resumed') {
    return 'active';
  }

  if (
    status === 'success' ||
    status === 'completed' ||
    status === 'ready' ||
    status === 'ok' ||
    status === 'validated' ||
    status === 'pass' ||
    status === 'rerun_passed'
  ) {
    return 'done';
  }

  if (
    status === 'error' ||
    status === 'failed' ||
    status === 'hard_failure' ||
    status === 'fail' ||
    status === 'rerun_failed' ||
    status === 'blocked' ||
    status === 'rejected' ||
    status === 'exhausted'
  ) {
    return 'error';
  }

  return 'neutral';
}

export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const label = labelByStatus[status];

  return (
    <span
      role="status"
      aria-label={`Status: ${label}`}
      data-status={status}
      data-tone={toneByStatus[status]}
      data-state-group={stateGroupFor(status)}
    >
      {label}
    </span>
  );
}

export default StatusBadge;
