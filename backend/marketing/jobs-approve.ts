import { approveMarketingJob as orchestratorApprove } from './orchestrator';
import { loadMarketingJobRuntime } from './runtime-state';
export type { ApproveMarketingJobRequest, ApproveMarketingJobResponse } from './orchestrator';

export async function approveMarketingJob(
  input: any
): Promise<any> {
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
