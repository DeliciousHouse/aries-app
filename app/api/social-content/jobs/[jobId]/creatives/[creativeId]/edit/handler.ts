import { NextResponse } from 'next/server';

import type { MarketingExecutionPort } from '@/backend/marketing/execution-port';
import { isImageEditEnabled } from '@/backend/marketing/image-edit-env';
import { editCreativeAsImageEdit } from '@/backend/marketing/regenerate-creative';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

const SOCIAL_CONTENT_ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before editing social content creatives.',
} as const;

const NOT_FOUND_BODY = {
  error: 'Social content job not found.',
  reason: 'social_content_job_not_found',
} as const;

export type HandleEditCreativeOptions = {
  port?: MarketingExecutionPort;
};

export async function handleEditCreative(
  jobId: string,
  creativeId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  options?: HandleEditCreativeOptions,
) {
  // Flag gate FIRST — when OFF the endpoint is invisible: a real 404 before any
  // auth/tenant resolution, so it never touches the DB and never discloses that
  // an auth-gated edit route exists (matches the native-reply convention).
  if (!isImageEditEnabled()) {
    return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
  }

  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader, {
    missingMembershipResponse: SOCIAL_CONTENT_ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  let body: { instruction?: unknown; source_run_id?: unknown; sourceRunId?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const instruction = typeof body.instruction === 'string' ? body.instruction : '';
  const explicitSourceRunId =
    typeof body.source_run_id === 'string'
      ? body.source_run_id
      : typeof body.sourceRunId === 'string'
        ? body.sourceRunId
        : undefined;

  const result = await editCreativeAsImageEdit({
    jobId,
    creativeId,
    tenantId: tenantResult.tenantContext.tenantId,
    editInstruction: instruction,
    sourceRunId: explicitSourceRunId,
    port: options?.port,
  });

  // Defense-in-depth: the top-of-handler flag gate already 404s when OFF, and
  // editCreativeAsImageEdit re-reads the same ARIES_IMAGE_EDIT_ENABLED, so this
  // branch is unreachable in normal flow. Kept for type-exhaustiveness and any
  // direct caller — a `disabled` result still maps to the invisible 404.
  if (result.kind === 'disabled') {
    return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
  }

  if (result.kind === 'job_not_found' || result.kind === 'tenant_mismatch') {
    return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
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
      edited: true,
    },
    { status: 202 },
  );
}
