import { NextResponse } from 'next/server';

import type { MarketingExecutionPort } from '@/backend/marketing/execution-port';
import { regenerateCreativeAsNewRun } from '@/backend/marketing/regenerate-creative';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const SOCIAL_CONTENT_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before regenerating social content creatives.',
} as const;

export type HandleRegenerateCreativeOptions = {
  port?: MarketingExecutionPort;
};

export async function handleRegenerateCreative(
  jobId: string,
  creativeId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  options?: HandleRegenerateCreativeOptions,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: SOCIAL_CONTENT_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: { source_run_id?: unknown; sourceRunId?: unknown } = {};
  try {
    body = (await req.json()) as { source_run_id?: unknown; sourceRunId?: unknown };
  } catch {
    body = {};
  }

  const explicitSourceRunId =
    typeof body.source_run_id === 'string'
      ? body.source_run_id
      : typeof body.sourceRunId === 'string'
        ? body.sourceRunId
        : undefined;

  const result = await regenerateCreativeAsNewRun({
    jobId,
    creativeId,
    tenantId: tenantResult.tenantContext.tenantId,
    sourceRunId: explicitSourceRunId,
    port: options?.port,
  });

  if (result.kind === 'job_not_found' || result.kind === 'tenant_mismatch') {
    return NextResponse.json(
      {
        error: 'Social content job not found.',
        reason: 'social_content_job_not_found',
      },
      { status: 404 },
    );
  }

  if (result.kind === 'invalid_input') {
    return NextResponse.json(
      {
        error: result.message,
        reason: result.code,
      },
      { status: 400 },
    );
  }

  if (result.kind === 'failed') {
    return NextResponse.json(
      {
        error: result.message,
        reason: result.code,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      status: 'submitted',
      jobId: result.jobId,
      creativeId: result.sourceCreativeId,
      new_run_id: result.ariesRunId,
      source_run_id: result.sourceRunId,
      source_creative_id: result.sourceCreativeId,
      hermes_run_id: result.hermesRunId,
    },
    { status: 202 },
  );
}
