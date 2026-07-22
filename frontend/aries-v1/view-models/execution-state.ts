import type { RuntimePostListItem } from '@/lib/api/aries-v1';

export function isFailedExecutionState(
  state: RuntimePostListItem['executionState'],
): boolean {
  return state === 'failed' || state === 'failed_stale';
}

export function failedJobLabel(
  stageLabel: string | null | undefined,
): string {
  const stage = stageLabel?.trim();
  if (!stage) {
    return 'Job failed';
  }

  return `${stage.charAt(0).toUpperCase()}${stage.slice(1).toLowerCase()} failed`;
}
