import { NextResponse } from 'next/server';

import { retryFailedResearchStage } from '@/backend/marketing/orchestrator';
import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const RETRY_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before retrying a campaign.',
} as const;

type RetryPermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: 'forbidden' }
  | { allowed: false; reason: 'not_found' };

/**
 * Same permission shape as delete/restore: admins can retry anything in their
 * tenant; the original creator can retry their own campaign; nobody else.
 * Campaigns from before `created_by` was tracked are admin-only.
 */
function evaluateRetryPermission(input: {
  tenantId: string;
  role: string;
  userId: string;
  docTenantId: string;
  docCreatedBy: string | null | undefined;
}): RetryPermissionDecision {
  if (input.docTenantId !== input.tenantId) {
    return { allowed: false, reason: 'not_found' };
  }
  if (input.role === 'tenant_admin') {
    return { allowed: true };
  }
  if (input.docCreatedBy && input.docCreatedBy === input.userId) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'forbidden' };
}

export async function handleRetryResearchStage(
  jobId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: RETRY_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  // Load the doc once to authorize the request before calling the orchestrator.
  // This load is purely for the tenant + role permission check. The
  // orchestrator's retryFailedResearchStage re-loads the doc to operate on
  // a fresh copy; there is NO runtime-doc lock in this codebase (only
  // approval-checkpoint locks elsewhere). A concurrent retry from two tabs
  // is rare and the worst case is one of them ends up as a no-op against an
  // already-reset stage record — both clients hard-reload either way.
  const doc = await loadMarketingJobRuntime(jobId);
  if (!doc) {
    return NextResponse.json(
      { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
      { status: 404 },
    );
  }

  const decision = evaluateRetryPermission({
    tenantId: tenantResult.tenantContext.tenantId,
    role: tenantResult.tenantContext.role,
    userId: tenantResult.tenantContext.userId,
    docTenantId: doc.tenant_id,
    docCreatedBy: doc.created_by,
  });
  if (!decision.allowed) {
    if (decision.reason === 'not_found') {
      return NextResponse.json(
        { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        error: 'You do not have permission to retry this campaign.',
        reason: 'marketing_job_retry_forbidden',
      },
      { status: 403 },
    );
  }

  const result = await retryFailedResearchStage(jobId);
  if (!result.ok) {
    const statusByReason = {
      not_found: 404,
      not_failed: 409,
      wrong_stage: 409,
      execution_failed: 502,
    } as const;
    const status = statusByReason[result.reason];
    return NextResponse.json(
      {
        error: result.message,
        reason: `marketing_job_retry_${result.reason}`,
      },
      { status },
    );
  }

  invalidateMarketingJobStatus(jobId);

  return NextResponse.json(
    {
      jobId: result.jobId,
      retryStatus: result.status,
    },
    { status: 200 },
  );
}

// Exported for tests so the per-tenant permission rule can be exercised in
// isolation without spinning up an HTTP request.
export const __evaluateRetryPermissionForTests = evaluateRetryPermission;
