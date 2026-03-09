import { marketing_stage_values, next_step_values, repair_status_values } from '../types/runtime';

export type StageStatusRow = {
  stage: string;
  status: string;
};

export type MarketingStateHints = {
  stageStatuses: StageStatusRow[];
  repairStatus?: string;
  nextStep?: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractRepairStatus(stateObj: Record<string, unknown>): string | undefined {
  const direct = asString(stateObj.repair_status);
  if (direct && repair_status_values.includes(direct as (typeof repair_status_values)[number])) return direct;

  const repairObj = stateObj.repair;
  if (isObjectRecord(repairObj)) {
    const nested = asString(repairObj.status);
    if (nested && repair_status_values.includes(nested as (typeof repair_status_values)[number])) return nested;
  }

  return undefined;
}

function extractNextStep(stateObj: Record<string, unknown>): string | undefined {
  const direct = asString(stateObj.next_step) ?? asString(stateObj.nextStep);
  if (direct && next_step_values.includes(direct as (typeof next_step_values)[number])) return direct;
  return undefined;
}

export function parseMarketingState(marketingJobState: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(marketingJobState) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getMarketingStateHints(
  marketingJobState: string,
  marketingStageStatus: Record<string, string>
): MarketingStateHints {
  const orderedKnownStages = marketing_stage_values
    .map((stage) => ({ stage, status: marketingStageStatus[stage] }))
    .filter((row) => typeof row.status === 'string');

  const otherStageStatuses = Object.entries(marketingStageStatus)
    .filter(([stage]) => !marketing_stage_values.includes(stage as (typeof marketing_stage_values)[number]))
    .map(([stage, status]) => ({ stage, status }));

  const hints: MarketingStateHints = {
    stageStatuses: [...orderedKnownStages, ...otherStageStatuses]
  };

  const parsedState = parseMarketingState(marketingJobState);
  if (!parsedState) return hints;

  hints.repairStatus = extractRepairStatus(parsedState);
  hints.nextStep = extractNextStep(parsedState);

  return hints;
}

export function nextStepGuidance(nextStep: string | undefined): string | null {
  switch (nextStep) {
    case 'wait_for_completion':
      return 'Workflow is still running. Reload status in a few moments.';
    case 'submit_approval':
      return 'Approval is required. Continue in the approval screen.';
    case 'resume_approved_stages':
      return 'The job can resume after approval. Submit approval when ready.';
    case 'invoke_marketing_repair':
      return 'A repair action is required before the workflow can continue.';
    case 'retry_with_next_attempt':
      return 'Retry is scheduled or available. Recheck status after the next attempt.';
    case 'provide_production_outputs':
      return 'Collect and publish production outputs before closing the workflow.';
    case 'fix_publish_targets':
      return 'Publish target configuration needs correction.';
    case 'check_onboarding_status':
      return 'Verify onboarding status before proceeding.';
    default:
      return null;
  }
}
