import { NextResponse } from 'next/server';

import { getMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { findLatestMarketingJobIdForTenant } from '@/backend/marketing/runtime-state';
import { buildCampaignWorkspaceView } from '@/backend/marketing/workspace-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign status.',
} as const;

function alignApprovalWithWorkspace(
  approval: ReturnType<typeof getMarketingJobStatus>['approval'],
  workflowState: ReturnType<typeof buildCampaignWorkspaceView>['workflowState'],
  publishBlockedReason: ReturnType<typeof buildCampaignWorkspaceView>['publishBlockedReason'],
) {
  if (!approval || workflowState !== 'revisions_requested') {
    return approval;
  }

  return {
    ...approval,
    status: 'changes_requested',
    message: publishBlockedReason || 'Resolve requested revisions before workflow approval can resume.',
    actionLabel: undefined,
    actionHref: undefined,
  };
}

function alignApprovalRequiredWithWorkspace(
  approvalRequired: boolean,
  workflowState: ReturnType<typeof buildCampaignWorkspaceView>['workflowState'],
) {
  return workflowState === 'revisions_requested' ? false : approvalRequired;
}

function alignNextStepWithWorkspace(
  nextStep: ReturnType<typeof getMarketingJobStatus>['nextStep'],
  workflowState: ReturnType<typeof buildCampaignWorkspaceView>['workflowState'],
) {
  return workflowState === 'revisions_requested' ? 'wait_for_completion' : nextStep;
}

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

  if (!tenantId) {
    return NextResponse.json(
      {
        error: 'Marketing job not found.',
        reason: 'marketing_job_not_found',
      },
      { status: 404 }
    );
  }

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
  const workspaceView = buildCampaignWorkspaceView(latestJobId);
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
      approvalRequired: alignApprovalRequiredWithWorkspace(result.approvalRequired, workspaceView.workflowState),
      summary: result.summary,
      stageCards: result.stageCards,
      artifacts: result.artifacts,
      timeline: result.timeline,
      approval: alignApprovalWithWorkspace(result.approval, workspaceView.workflowState, workspaceView.publishBlockedReason),
      reviewBundle: result.reviewBundle,
      campaignBrief: workspaceView.campaignBrief,
      workflowState: workspaceView.workflowState,
      statusHistory: workspaceView.statusHistory,
      brandReview: workspaceView.brandReview,
      strategyReview: workspaceView.strategyReview,
      creativeReview: workspaceView.creativeReview,
      publishConfig: result.publishConfig,
      nextStep: alignNextStepWithWorkspace(result.nextStep, workspaceView.workflowState),
      repairStatus: result.repairStatus,
      dashboard: workspaceView.dashboard,
    },
    { status: 200 }
  );
}
