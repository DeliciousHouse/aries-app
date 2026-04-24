import { NextResponse } from 'next/server';

import type { MarketingApprovalSummary, MarketingJobStatusResponse } from '@/backend/marketing/jobs-status';
import { getMarketingJobStatusCached } from '@/backend/marketing/jobs-status';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { buildCampaignWorkspaceView } from '@/backend/marketing/workspace-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing brand campaign status.',
} as const;

const MARKETING_JOB_NOT_FOUND_RESPONSE = {
  error: 'Marketing job not found.',
  reason: 'marketing_job_not_found',
} as const;

function alignApprovalWithWorkspace(
  approval: MarketingApprovalSummary | null,
  workflowState: Awaited<ReturnType<typeof buildCampaignWorkspaceView>>['workflowState'],
  publishBlockedReason: Awaited<ReturnType<typeof buildCampaignWorkspaceView>>['publishBlockedReason'],
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
  workflowState: Awaited<ReturnType<typeof buildCampaignWorkspaceView>>['workflowState'],
) {
  return workflowState === 'revisions_requested' ? false : approvalRequired;
}

function alignNextStepWithWorkspace(
  nextStep: MarketingJobStatusResponse['nextStep'],
  workflowState: Awaited<ReturnType<typeof buildCampaignWorkspaceView>>['workflowState'],
) {
  return workflowState === 'revisions_requested' ? 'wait_for_completion' : nextStep;
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

  const runtimeDoc = await loadMarketingJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== tenantResult.tenantContext.tenantId) {
    console.warn('[marketing-job-not-found]', {
      jobId,
      cause: runtimeDoc ? 'tenant_mismatch' : 'runtime_doc_missing',
    });
    return NextResponse.json(MARKETING_JOB_NOT_FOUND_RESPONSE, { status: 404 });
  }

  try {
    const { payload: result, cacheStatus } = await getMarketingJobStatusCached(tenantResult.tenantContext.tenantId, jobId);
    const workspaceView = await buildCampaignWorkspaceView(jobId);

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
      { status: 200, headers: { 'x-cache': cacheStatus } }
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
