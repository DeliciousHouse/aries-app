import { NextResponse } from 'next/server';

import { approveMarketingJob } from '@/backend/marketing/orchestrator';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
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
  let payload: {
    approvedBy?: unknown;
    approvedStages?: Array<'research' | 'strategy' | 'production' | 'publish'>;
    approvalId?: unknown;
    resumePublishIfNeeded?: boolean;
    publishConfig?: {
      platforms?: string[];
      livePublishPlatforms?: string[];
      videoRenderPlatforms?: string[];
    };
  } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  try {
    const doc = loadMarketingJobRuntime(jobId);
    if (!doc) {
      return NextResponse.json(
        {
          error: 'Marketing job not found.',
          reason: 'marketing_job_not_found',
        },
        { status: 404 }
      );
    }
    const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
      missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
    });
    if ('response' in tenantResult) {
      return tenantResult.response;
    }
    const resolvedTenantId = tenantResult.tenantContext.tenantId;
    const result = await approveMarketingJob({
      jobId,
      tenantId: resolvedTenantId,
      approvedBy: typeof payload.approvedBy === 'string' ? payload.approvedBy : '',
      approvedStages: payload.approvedStages,
      approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : undefined,
      resumePublishIfNeeded: payload.resumePublishIfNeeded,
      publishConfig: payload.publishConfig
        ? {
            platforms: payload.publishConfig.platforms,
            live_publish_platforms: payload.publishConfig.livePublishPlatforms,
            video_render_platforms: payload.publishConfig.videoRenderPlatforms,
          }
        : undefined,
    }, doc);

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
          error: 'This campaign is not waiting on an active approval checkpoint.',
          reason: result.reason,
        },
        { status: 409 }
      );
    }

    if (result.reason === 'approval_stage_not_selected') {
      return NextResponse.json(
        {
          error: 'The current approval checkpoint was not selected.',
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
        approvalId: result.approvalId,
        reason: result.reason,
        jobStatusUrl: `/marketing/job-status?jobId=${encodeURIComponent(result.jobId)}`,
      },
      {
        status:
          result.reason === 'workflow_missing_for_route'
            ? 501
            : result.status === 'resumed' || result.status === 'already_resolved'
              ? 200
              : 400,
      }
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
      return NextResponse.json(
        {
          error: error.message,
          reason: error.code,
        },
        { status }
      );
    }
    if (message.startsWith('workflow_missing_for_route:')) {
      return NextResponse.json(
        {
          error: message,
          reason: 'workflow_missing_for_route',
        },
        { status: 501 }
      );
    }
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 }
    );
  }
}
