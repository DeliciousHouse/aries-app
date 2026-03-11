import { NextResponse } from 'next/server';
import { approveMarketingJob } from '../../../../../../backend/marketing/jobs-approve';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const result = await approveMarketingJob({
      jobId,
      tenantId: payload.tenantId,
      approvedBy: payload.approvedBy,
      approvedStages: payload.approvedStages,
      resumePublishIfNeeded: payload.resumePublishIfNeeded
    });

    return NextResponse.json(
      {
        approval_status: result.status,
        jobId: result.jobId,
        tenantId: result.tenantId,
        resumedStage: result.resumedStage,
        completed: result.completed,
        wiring: result.wiring
      },
      { status: result.status === 'resumed' ? 200 : 400 }
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
