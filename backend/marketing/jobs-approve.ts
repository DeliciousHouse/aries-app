import { approveMarketingJob as approveMarketingCheckpoint, type ApproveMarketingJobRequest, type ApproveMarketingJobResponse } from './orchestrator';
import { loadMarketingJobRuntime } from './runtime-state';

export type { ApproveMarketingJobRequest, ApproveMarketingJobResponse };

export async function approveMarketingJob(input: ApproveMarketingJobRequest): Promise<ApproveMarketingJobResponse> {
  const job = loadMarketingJobRuntime(input.jobId);
  if (!job) {
    return {
      status: 'error',
      jobId: input.jobId,
      tenantId: input.tenantId,
      resumedStage: null,
      completed: false,
      reason: 'job_not_found',
    };
  }

  return approveMarketingCheckpoint(input, job);
}
