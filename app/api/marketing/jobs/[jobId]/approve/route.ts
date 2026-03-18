import { NextResponse } from 'next/server';
import { approveMarketingJob } from '../../../../../../backend/marketing/jobs-approve';
import { OpenClawGatewayError } from '../../../../../../backend/openclaw/gateway-client';

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
        wiring: result.wiring,
        reason: result.reason
      },
      {
        status:
          result.reason === 'workflow_missing_for_route'
            ? 501
            : result.status === 'resumed'
              ? 200
              : 400
      }
    );
  } catch (error) {
    if (error instanceof OpenClawGatewayError) {
      const status =
        error.code === 'openclaw_gateway_unauthorized'
          ? 401
          : error.code === 'openclaw_gateway_unreachable' || error.code === 'openclaw_gateway_not_configured'
            ? 503
            : error.status || 500;
      return NextResponse.json(
        {
          error: error.message,
          reason: error.code
        },
        { status }
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
