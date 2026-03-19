import { NextResponse } from 'next/server';

import { approveMarketingJob } from '@/backend/marketing/jobs-approve';
import { OpenClawGatewayError } from '@/backend/openclaw/gateway-client';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before approving brand campaigns.',
} as const;

export async function handleApproveMarketingJob(
  jobId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let payload: {
    approvedBy?: unknown;
    approvedStages?: Array<'research' | 'strategy' | 'production' | 'publish'>;
    resumePublishIfNeeded?: boolean;
  } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const result = await approveMarketingJob({
      jobId,
      tenantId: tenantResult.tenantContext.tenantId,
      approvedBy: typeof payload.approvedBy === 'string' ? payload.approvedBy : '',
      approvedStages: payload.approvedStages,
      resumePublishIfNeeded: payload.resumePublishIfNeeded,
    });

    if (result.reason === 'tenant_mismatch' || result.reason === 'job_not_found') {
      return NextResponse.json(
        {
          error: 'Marketing job not found.',
          reason: 'marketing_job_not_found',
        },
        { status: 404 }
      );
    }

    if (result.reason === 'missing_approved_by') {
      return NextResponse.json(
        {
          error: 'approvedBy is required.',
          reason: result.reason,
        },
        { status: 400 }
      );
    }

    if (result.reason === 'approval_not_available') {
      return NextResponse.json(
        {
          error: 'This campaign is not waiting on a live launch approval token.',
          reason: result.reason,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        approval_status: result.status,
        jobId: result.jobId,
        resumedStage: result.resumedStage,
        completed: result.completed,
        reason: result.reason,
        jobStatusUrl: `/marketing/job-status?jobId=${encodeURIComponent(result.jobId)}`,
      },
      {
        status:
          result.reason === 'workflow_missing_for_route'
            ? 501
            : result.status === 'resumed'
              ? 200
              : 400,
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
          reason: error.code,
        },
        { status }
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
