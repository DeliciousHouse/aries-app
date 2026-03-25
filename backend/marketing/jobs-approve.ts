import { approveMarketingJob as orchestratorApprove } from './orchestrator';
import { loadMarketingJobRuntime } from './runtime-state';
import type { ApproveMarketingJobRequest, ApproveMarketingJobResponse } from './orchestrator';
export type { ApproveMarketingJobRequest, ApproveMarketingJobResponse } from './orchestrator';

export async function approveMarketingJob(
  input: ApproveMarketingJobRequest
): Promise<ApproveMarketingJobResponse> {
  const doc = loadMarketingJobRuntime(input.jobId);
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
