import { NextResponse } from 'next/server';
import { getMarketingJobStatus } from '../../../../../backend/marketing/jobs-status';

export async function GET(
  _req: Request,
  { params }: { params: { jobId: string } }
) {
  try {
    const result = getMarketingJobStatus(params.jobId);
    return NextResponse.json(
      {
        jobId: result.jobId,
        tenantId: result.tenantId,
        marketing_job_state: result.state,
        marketing_job_status: result.status,
        marketing_stage: result.currentStage,
        marketing_stage_status: result.stageStatus,
        updatedAt: result.updatedAt,
        runtimePath: result.runtimePath
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
