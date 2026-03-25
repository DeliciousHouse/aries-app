import { NextResponse } from 'next/server';

import { getMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { findLatestMarketingJobIdForTenant } from '@/backend/marketing/runtime-state';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign status.',
} as const;

export async function handleGetLatestMarketingJobStatus(
  tenantContextLoader?: TenantContextLoader
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const tenantId = tenantResult.tenantContext.tenantId;
  const latestJobId = findLatestMarketingJobIdForTenant(tenantId);
  if (!latestJobId) {
    return NextResponse.json(
      {
        error: 'Marketing job not found.',
        reason: 'marketing_job_not_found',
      },
      { status: 404 }
    );
  }

  const result = getMarketingJobStatus(latestJobId);
  return NextResponse.json(
    {
      jobId: result.jobId,
      tenantName: result.tenantName,
      brandWebsiteUrl: result.brandWebsiteUrl,
      campaignWindow: result.campaignWindow,
      durationDays: result.durationDays,
      plannedPostCount: result.plannedPostCount,
      createdPostCount: result.createdPostCount,
      assetPreviewCards: result.assetPreviewCards,
      calendarEvents: result.calendarEvents,
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
}
