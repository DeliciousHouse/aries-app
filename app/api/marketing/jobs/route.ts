import { NextResponse } from 'next/server';
import { startMarketingJob } from '../../../../backend/marketing/jobs-start';
import { OpenClawGatewayError, type LobsterEnvelope } from '../../../../backend/openclaw/gateway-client';

export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const result = await startMarketingJob(payload);
    return NextResponse.json(
      {
        marketing_job_status: result.status,
        jobId: result.jobId,
        tenantId: result.tenantId,
        jobType: result.jobType,
        wiring: result.wiring
      },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof OpenClawGatewayError) {
      const status =
        error.code === 'openclaw_gateway_unauthorized'
          ? 401
          : error.code === 'openclaw_gateway_unreachable' || error.code === 'openclaw_gateway_not_configured'
            ? 503
            : error.status || 500;
      return NextResponse.json({ error: message, reason: error.code }, { status });
    }
    if (message.startsWith('workflow_missing_for_route:')) {
      return NextResponse.json({ error: message, reason: 'workflow_missing_for_route' }, { status: 501 });
    }
    if (message.startsWith('missing_required_fields:') || message.startsWith('unsupported_job_type:')) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: message
      },
      { status: 500 }
    );
  }
}
