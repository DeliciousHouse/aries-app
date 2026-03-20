import { NextResponse } from 'next/server';

import { getMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign status.',
} as const;

export async function handleGetMarketingJobStatus(
  jobId: string,
  tenantContextLoader?: TenantContextLoader
) {
  // Dev/staging bypass: skip tenant auth when MARKETING_STATUS_PUBLIC is set
  const statusPublic = process.env.MARKETING_STATUS_PUBLIC === '1' || process.env.MARKETING_STATUS_PUBLIC === 'true';

  if (!statusPublic) {
    const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
      missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
    });
    if ('response' in tenantResult) {
      return tenantResult.response;
    }
  }

  try {
    const result = getMarketingJobStatus(jobId);
    if (!statusPublic && result.tenantId) {
      const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
        missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
      });
      if (!('response' in tenantResult) && result.tenantId !== tenantResult.tenantContext.tenantId) {
        return NextResponse.json(
          {
            error: 'Marketing job not found.',
            reason: 'marketing_job_not_found',
          },
          { status: 404 }
        );
      }
    }

    return NextResponse.json(
      {
        jobId: result.jobId,
        marketing_job_state: result.state,
        marketing_job_status: result.status,
        marketing_stage: result.currentStage,
        marketing_stage_status: result.stageStatus,
        updatedAt: result.updatedAt,
        needs_attention: result.needsAttention,
        approvalRequired: result.approvalRequired,
        summary: result.summary,
        stageCards: result.stageCards,
        artifacts: result.artifacts,
        timeline: result.timeline,
        approval: result.approval,
        reviewBundle: result.reviewBundle,
        publishConfig: result.publishConfig,
        nextStep: result.nextStep,
        repairStatus: result.repairStatus,
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
