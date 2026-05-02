import { NextResponse } from 'next/server';

import { cancelAriesWorkflow } from '@/backend/execution';
import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import {
  isPipelineActive,
  loadMarketingJobRuntime,
  softDeleteMarketingJob,
  restoreMarketingJob,
} from '@/backend/marketing/runtime-state';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

// Separate copy for each verb so a user hitting the restore endpoint
// pre-onboarding doesn't see a misleading "before deleting a campaign"
// message. The status / reason are identical; only the user-facing message
// differs per call site.
const DELETE_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before deleting a campaign.',
} as const;

const RESTORE_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before restoring a campaign.',
} as const;

type DeletePermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: 'forbidden' }
  | { allowed: false; reason: 'not_found' };

/**
 * Encodes the delete / restore permission rule:
 *
 *   - tenant_admin users may delete or restore any campaign in their tenant
 *   - Any user may delete or restore a campaign they themselves created
 *     (tracked via `created_by` on the runtime document)
 *   - Everyone else is forbidden
 *
 * Campaigns that predate the `created_by` field are treated as admin-only,
 * since we can't authoritatively attribute them to a creator.
 */
function evaluateDeletePermission(input: {
  tenantId: string;
  role: string;
  userId: string;
  docTenantId: string;
  docCreatedBy: string | null | undefined;
}): DeletePermissionDecision {
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

export async function handleDeleteMarketingJob(
  jobId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: DELETE_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const doc = await loadMarketingJobRuntime(jobId);
  if (!doc) {
    return NextResponse.json(
      { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
      { status: 404 },
    );
  }

  const decision = evaluateDeletePermission({
    tenantId: tenantResult.tenantContext.tenantId,
    role: tenantResult.tenantContext.role,
    userId: tenantResult.tenantContext.userId,
    docTenantId: doc.tenant_id,
    docCreatedBy: doc.created_by,
  });

  if (!decision.allowed) {
    if (decision.reason === 'not_found') {
      // Never confirm existence cross-tenant.
      return NextResponse.json(
        { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        error: 'You do not have permission to delete this campaign.',
        reason: 'marketing_job_delete_forbidden',
      },
      { status: 403 },
    );
  }

  const wasActive = isPipelineActive(doc);

  const updated = await softDeleteMarketingJob({
    jobId,
    tenantId: tenantResult.tenantContext.tenantId,
    deletedBy: tenantResult.tenantContext.userId,
  });

  if (!updated) {
    // Treat a disappearing doc between load and save as a 404. Concurrent
    // writes or a caller that deleted the runtime file from underneath us
    // are extremely rare but shouldn't produce a 500.
    return NextResponse.json(
      { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
      { status: 404 },
    );
  }

  // If the pipeline was mid-run when the delete landed, best-effort ask the
  // gateway to abort the in-flight Lobster run so the orchestrator does not
  // finish the current stage before the soft-cancel boundary check picks up.
  // The call swallows errors internally; soft-delete succeeds regardless.
  if (wasActive) {
    await cancelAriesWorkflow({ correlationId: jobId }).catch(() => {});
  }

  invalidateMarketingJobStatus(jobId);

  return NextResponse.json(
    {
      jobId,
      deletedAt: updated.deleted_at ?? null,
      deletedBy: updated.deleted_by ?? null,
      softCancelRequestedAt: updated.soft_cancel_requested_at ?? null,
    },
    { status: 200 },
  );
}

export async function handleRestoreMarketingJob(
  jobId: string,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: RESTORE_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  const doc = await loadMarketingJobRuntime(jobId);
  if (!doc) {
    return NextResponse.json(
      { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
      { status: 404 },
    );
  }

  // Same rule applies to restore: only admins or the original creator may
  // un-delete. Keeps the audit story symmetrical.
  const decision = evaluateDeletePermission({
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
        error: 'You do not have permission to restore this campaign.',
        reason: 'marketing_job_restore_forbidden',
      },
      { status: 403 },
    );
  }

  const updated = await restoreMarketingJob({
    jobId,
    tenantId: tenantResult.tenantContext.tenantId,
  });

  if (!updated) {
    return NextResponse.json(
      { error: 'Campaign not found.', reason: 'marketing_job_not_found' },
      { status: 404 },
    );
  }

  invalidateMarketingJobStatus(jobId);

  return NextResponse.json(
    {
      jobId,
      restored: !updated.deleted_at,
    },
    { status: 200 },
  );
}
