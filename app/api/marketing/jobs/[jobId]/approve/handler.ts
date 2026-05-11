import { NextResponse } from 'next/server';

import { mapAriesExecutionError } from '@/backend/execution';
import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { approveMarketingJob, denyMarketingJob } from '@/backend/marketing/orchestrator';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { isApprovalDenialReasonCode } from '@/backend/memory/curator';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const MARKETING_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before approving brand campaigns.',
} as const;

type ResponseDialect = 'marketing' | 'social-content';
type SocialContentApprovalStep =
  | 'approve_weekly_plan'
  | 'approve_post_copy'
  | 'approve_image_creatives'
  | 'approve_video_script'
  | 'approve_video_render'
  | 'approve_publish';

function sanitizeMessage(message: string, dialect: ResponseDialect): string {
  if (dialect !== 'social-content') {
    return message;
  }
  return message
    .replace(/Campaign/g, 'Social content')
    .replace(/campaign/g, 'social content')
    .replace(/Marketing job/g, 'Social content job')
    .replace(/marketing job/g, 'social content job');
}

function buildApproveResponse(
  dialect: ResponseDialect,
  result: {
    status: string;
    jobId: string;
    resumedStage?: string | null;
    completed?: boolean;
    approvalId?: string | null;
    reason?: string;
  },
) {
  const normalizedStatus = dialect === 'social-content' && (result.status === 'resumed' || result.status === 'denied')
    ? 'submitted'
    : result.status;
  const encodedJobId = encodeURIComponent(result.jobId);
  const base = {
    approval_status: normalizedStatus,
    jobId: result.jobId,
    resumedStage: result.resumedStage,
    completed: result.completed,
    approvalId: result.approvalId,
    reason: result.reason ?? 'unknown',
    jobStatusUrl:
      dialect === 'social-content'
        ? `/social-content/status?jobId=${encodedJobId}`
        : `/marketing/job-status?jobId=${encodedJobId}`,
  };

  if (dialect === 'marketing') {
    return base;
  }

  return {
    ...base,
    social_content_approval_status: base.approval_status,
    jobType: 'weekly_social_content',
  };
}

function stageFromSocialApprovalStep(step: string): 'strategy' | 'production' | 'publish' | null {
  if (step === 'approve_weekly_plan') {
    return 'strategy';
  }
  if (step === 'approve_publish') {
    return 'publish';
  }
  if (
    step === 'approve_post_copy'
    || step === 'approve_image_creatives'
    || step === 'approve_video_script'
    || step === 'approve_video_render'
  ) {
    return 'production';
  }
  return null;
}

export async function handleApproveMarketingJob(
  jobId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  options?: { responseDialect?: ResponseDialect },
) {
  const dialect = options?.responseDialect ?? 'marketing';
  let payload: {
    approvedBy?: unknown;
    approved?: unknown;
    approvalStep?: unknown;
    approvedStages?: Array<'research' | 'strategy' | 'production' | 'publish'>;
    approvalId?: unknown;
    resumePublishIfNeeded?: boolean;
    denialReasonCode?: unknown;
    denialNote?: unknown;
    note?: unknown;
    memoryActorUserId?: unknown;
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
    const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
      missingMembershipResponse: MARKETING_ONBOARDING_REQUIRED,
    });
    if ('response' in tenantResult) {
      return tenantResult.response;
    }
    const resolvedTenantId = tenantResult.tenantContext.tenantId;
    const memoryActorUserId =
      typeof payload.memoryActorUserId === 'string' && payload.memoryActorUserId.trim().length > 0
        ? payload.memoryActorUserId.trim()
        : tenantResult.tenantContext.userId;
    const tenantSlug = tenantResult.tenantContext.tenantSlug;
    const memoryActorRole = tenantResult.tenantContext.role;
    const rawDenialCode = typeof payload.denialReasonCode === 'string' ? payload.denialReasonCode.trim() : '';
    const denialReasonCode =
      rawDenialCode && isApprovalDenialReasonCode(rawDenialCode) ? rawDenialCode : undefined;
    const denialNoteRaw =
      typeof payload.denialNote === 'string'
        ? payload.denialNote
        : typeof payload.note === 'string'
          ? payload.note
          : undefined;
    const denialNote =
      typeof denialNoteRaw === 'string' && denialNoteRaw.trim().length > 0 ? denialNoteRaw.trim() : undefined;

    const doc = await loadMarketingJobRuntime(jobId);
    if (!doc) {
      return NextResponse.json(
        {
          error: sanitizeMessage('Marketing job not found.', dialect),
          reason: 'marketing_job_not_found',
        },
        { status: 404 },
      );
    }
    const approvalStep =
      typeof payload.approvalStep === 'string'
      && stageFromSocialApprovalStep(payload.approvalStep)
      ? (payload.approvalStep as SocialContentApprovalStep)
      : undefined;
    const mappedApprovalStage = approvalStep ? stageFromSocialApprovalStep(approvalStep) : null;
    const approvedStages = Array.isArray(payload.approvedStages) && payload.approvedStages.length > 0
      ? payload.approvedStages
      : mappedApprovalStage
        ? [mappedApprovalStage]
        : undefined;
    const approved = typeof payload.approved === 'boolean' ? payload.approved : true;

    const result = approved
      ? await approveMarketingJob(
        {
          jobId,
          tenantId: resolvedTenantId,
          approvedBy: typeof payload.approvedBy === 'string' ? payload.approvedBy : '',
          approvedStages,
          approvalStep,
          approved,
          approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : undefined,
          resumePublishIfNeeded: payload.resumePublishIfNeeded,
          publishConfig: payload.publishConfig
            ? {
                platforms: payload.publishConfig.platforms,
                live_publish_platforms: payload.publishConfig.livePublishPlatforms,
                video_render_platforms: payload.publishConfig.videoRenderPlatforms,
              }
            : undefined,
          memoryActorUserId,
          tenantSlug,
          memoryActorRole,
        },
        doc,
      )
      : await denyMarketingJob(
        {
          jobId,
          tenantId: resolvedTenantId,
          deniedBy: typeof payload.approvedBy === 'string' ? payload.approvedBy : '',
          approvalId: typeof payload.approvalId === 'string' ? payload.approvalId : undefined,
          denialReasonCode,
          denialNote,
          publishConfig: payload.publishConfig
            ? {
                platforms: payload.publishConfig.platforms,
                live_publish_platforms: payload.publishConfig.livePublishPlatforms,
                video_render_platforms: payload.publishConfig.videoRenderPlatforms,
              }
            : undefined,
          memoryActorUserId,
          tenantSlug,
          memoryActorRole,
        },
        doc,
      );

    if (result.reason === 'tenant_mismatch' || result.reason === 'job_not_found') {
      return NextResponse.json(
        {
          error: sanitizeMessage('Marketing job not found.', dialect),
          reason: 'marketing_job_not_found',
        },
        { status: 404 },
      );
    }

    if (result.reason === 'missing_approved_by') {
      return NextResponse.json(
        {
          error: 'approvedBy is required.',
          reason: result.reason,
        },
        { status: 400 },
      );
    }

    if (result.reason === 'approval_not_available') {
      return NextResponse.json(
        {
          error: sanitizeMessage('This campaign is not waiting on an active approval checkpoint.', dialect),
          reason: result.reason,
        },
        { status: 409 },
      );
    }

    if (result.reason === 'approval_stage_not_selected') {
      return NextResponse.json(
        {
          error: 'The current approval checkpoint was not selected.',
          reason: result.reason,
        },
        { status: 409 },
      );
    }

    invalidateMarketingJobStatus(jobId);

    return NextResponse.json(buildApproveResponse(dialect, result), {
      status:
        result.reason === 'workflow_missing_for_route'
          ? 501
          : dialect === 'social-content' && (result.status === 'resumed' || result.status === 'denied')
            ? 202
            : result.status === 'resumed' || result.status === 'already_resolved' || result.status === 'denied'
            ? 200
            : 400,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mapped = mapAriesExecutionError(error);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
    if (message.startsWith('workflow_missing_for_route:')) {
      return NextResponse.json(
        {
          error: message,
          reason: 'workflow_missing_for_route',
        },
        { status: 501 },
      );
    }
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
