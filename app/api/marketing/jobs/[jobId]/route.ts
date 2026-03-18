import { NextResponse } from 'next/server';
import { getMarketingJobStatus } from '../../../../../backend/marketing/jobs-status';

function needsAttention(status: string) {
  return [
    'error',
    'failed',
    'blocked',
    'needs_repair',
    'hard_failure',
    'rejected',
  ].includes(status);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const result = getMarketingJobStatus(jobId);
    return NextResponse.json(
      {
        jobId: result.jobId,
        tenantId: result.tenantId,
        marketing_job_state: result.state,
        marketing_job_status: result.status,
        marketing_stage: result.currentStage,
        marketing_stage_status: result.stageStatus,
        updatedAt: result.updatedAt,
        needs_attention: needsAttention(result.status)
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
