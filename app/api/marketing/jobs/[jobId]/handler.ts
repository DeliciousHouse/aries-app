import { NextResponse } from 'next/server';

import { getMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign status.',
} as const;

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

export async function handleGetMarketingJobStatus(
  jobId: string,
  tenantContextLoader?: TenantContextLoader
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  try {
    const result = getMarketingJobStatus(jobId);
    if (result.state !== 'not_found' && (result.tenantId === null || result.tenantId !== tenantResult.tenantContext.tenantId)) {
      return NextResponse.json(
        {
          error: 'Marketing job not found.',
          reason: 'marketing_job_not_found',
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        jobId: result.jobId,
        marketing_job_state: result.state,
        marketing_job_status: result.status,
        marketing_stage: result.currentStage,
        marketing_stage_status: result.stageStatus,
        updatedAt: result.updatedAt,
        needs_attention: needsAttention(result.status),
        approvalRequired: result.approvalRequired,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
