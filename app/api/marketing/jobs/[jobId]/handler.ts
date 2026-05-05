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

type ResponseDialect = 'marketing' | 'social-content';

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

function socialContentCalendarLabel(durationDays?: number | null): string {
  return typeof durationDays === 'number' && Number.isFinite(durationDays) && durationDays > 0
    ? `${durationDays}-day content calendar`
    : 'weekly content calendar';
}

function replaceCampaignTerms(value: string, calendarLabel = socialContentCalendarLabel()): string {
  return value
    .replace(/30-day launch calendar/gi, calendarLabel)
    .replace(/30-day content calendar/gi, calendarLabel)
    .replace(/launch calendar/gi, calendarLabel)
    .replace(/campaign window/gi, calendarLabel)
    .replace(/launch campaign/gi, 'Start weekly content plan')
    .replace(/Campaign workspace/g, 'Content workspace')
    .replace(/Campaign brief/g, 'Content brief')
    .replace(/Campaign proposal/g, 'Weekly content plan')
    .replace(/Launch calendar/g, calendarLabel)
    .replace(/Marketing pipeline/g, 'Social content pipeline')
    .replace(/marketing pipeline/g, 'social content pipeline')
    .replace(/Marketing job/g, 'Social content job')
    .replace(/marketing job/g, 'social content job')
    .replace(/Ad creatives/g, 'Post creatives')
    .replace(/ad creatives/g, 'post creatives')
    .replace(/Campaign/g, 'Social content')
    .replace(/campaign/g, 'social content');
}

function socialContentSummary(
  summary: MarketingJobStatusResponse['summary'],
  durationDays: number | null,
): MarketingJobStatusResponse['summary'] {
  const calendarLabel = socialContentCalendarLabel(durationDays);
  const rewrittenSubheadline = replaceCampaignTerms(summary.subheadline, calendarLabel);
  const weeklySubheadline = new RegExp(calendarLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(rewrittenSubheadline)
    ? rewrittenSubheadline
    : rewrittenSubheadline
      ? `${rewrittenSubheadline} Weekly updates use a ${calendarLabel}.`
      : `Weekly updates use a ${calendarLabel}.`;
  return {
    headline: replaceCampaignTerms(summary.headline, calendarLabel),
    subheadline: weeklySubheadline,
  };
}

function socialContentApproval(
  approval: MarketingApprovalSummary | null,
  durationDays: number | null,
): MarketingApprovalSummary | null {
  if (!approval) {
    return null;
  }
  const calendarLabel = socialContentCalendarLabel(durationDays);
  return {
    ...approval,
    title: replaceCampaignTerms(approval.title, calendarLabel),
    message: replaceCampaignTerms(approval.message, calendarLabel),
    actionLabel: approval.actionLabel ? replaceCampaignTerms(approval.actionLabel, calendarLabel) : undefined,
  };
}

function buildResponsePayload(
  dialect: ResponseDialect,
  result: Awaited<ReturnType<typeof getMarketingJobStatusCached>>['payload'],
  workspaceView: Awaited<ReturnType<typeof buildCampaignWorkspaceView>>,
) {
  const base = {
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
    reason: result.reason,
    message: result.message,
    dashboard: workspaceView.dashboard,
  };

  if (dialect === 'marketing') {
    return base;
  }

  const socialPayload = {
    ...base,
    jobType: 'weekly_social_content',
    summary: socialContentSummary(base.summary, base.durationDays),
    approval: socialContentApproval(base.approval, base.durationDays),
    social_content_job_state: base.marketing_job_state,
    social_content_job_status: base.marketing_job_status,
    social_content_stage: base.marketing_stage,
    social_content_stage_status: base.marketing_stage_status,
    contentBrief: base.campaignBrief,
  };

  return socialPayload;
}

export async function handleGetMarketingJobStatus(
  jobId: string,
  tenantContextLoader?: TenantContextLoader,
  options?: { responseDialect?: ResponseDialect },
) {
  const dialect = options?.responseDialect ?? 'marketing';
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

    return NextResponse.json(buildResponsePayload(dialect, result, workspaceView), {
      status: 200,
      headers: { 'x-cache': cacheStatus },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
