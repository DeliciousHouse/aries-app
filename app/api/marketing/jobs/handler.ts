import { NextResponse } from 'next/server';

import { startMarketingJob } from '@/backend/marketing/jobs-start';
import { OpenClawGatewayError } from '@/backend/openclaw/gateway-client';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before starting a brand campaign.',
} as const;

export async function handlePostMarketingJobs(
  req: Request,
  tenantContextLoader?: TenantContextLoader
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let payload: { jobType?: unknown; payload?: Record<string, unknown> } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const result = await startMarketingJob({
      tenantId: tenantResult.tenantContext.tenantId,
      jobType: payload.jobType as 'brand_campaign',
      payload: payload.payload ?? {},
    });

    return NextResponse.json(
      {
        marketing_job_status: result.status,
        jobId: result.jobId,
        jobType: result.jobType,
        approvalRequired: result.approvalRequired,
        jobStatusUrl: `/marketing/job-status?jobId=${encodeURIComponent(result.jobId)}`,
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
        error: message,
      },
      { status: 500 }
    );
  }
}
