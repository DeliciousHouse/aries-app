import { approveSocialContentJob as orchestratorApprove } from './orchestrator';
import { loadSocialContentJobRuntime } from './runtime-state';
import type { ApproveSocialContentJobRequest, ApproveSocialContentJobResponse } from './orchestrator';
export type { ApproveSocialContentJobRequest, ApproveSocialContentJobResponse } from './orchestrator';

export async function approveSocialContentJob(
  input: ApproveSocialContentJobRequest
): Promise<ApproveSocialContentJobResponse> {
  const doc = await loadSocialContentJobRuntime(input.jobId);
  if (!doc) {
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'job_not_found',
    };
  }
  return orchestratorApprove(input, doc);
}
