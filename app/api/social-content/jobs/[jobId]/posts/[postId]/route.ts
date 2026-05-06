import { NextResponse } from 'next/server';

import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import {
  recordReviewItemCopyEdit,
  type RecordReviewItemCopyEditOptions,
} from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readOptionalCopyField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value;
}

export async function handlePatchSocialContentPost(
  jobId: string,
  postId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  recordOptions: RecordReviewItemCopyEditOptions = {},
) {
  const decodedJobId = decodeParam(jobId);
  const decodedPostId = decodeParam(postId);

  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantId } = tenantResult.tenantContext;
  if (!tenantId) {
    return NextResponse.json({ error: 'tenant_context_required' }, { status: 403 });
  }

  let payload: { headline?: unknown; supportingText?: unknown; editedBy?: unknown } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const headline = readOptionalCopyField(payload.headline);
  const supportingText = readOptionalCopyField(payload.supportingText);
  if (headline === undefined && supportingText === undefined) {
    return NextResponse.json({ error: 'no_edit_fields' }, { status: 400 });
  }

  const editedBy = typeof payload.editedBy === 'string' ? payload.editedBy.trim() || null : null;

  try {
    const result = await recordReviewItemCopyEdit(
      {
        tenantId,
        jobId: decodedJobId,
        reviewId: decodedPostId,
        headline,
        supportingText,
        editedBy,
      },
      recordOptions,
    );

    if (result.status === 'missing') {
      return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    }
    if (result.status === 'wrong_workspace') {
      return NextResponse.json({ error: 'review_not_found' }, { status: 404 });
    }
    if (result.status === 'invalid') {
      return NextResponse.json(
        { error: 'caption_invalid', reason: 'caption_invalid', validation_errors: result.errors },
        { status: 400 },
      );
    }

    invalidateMarketingJobStatus(result.review.jobId);
    return NextResponse.json({ review: result.review, edit: result.edit }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ jobId: string; postId: string }> },
) {
  const { jobId, postId } = await params;
  return handlePatchSocialContentPost(jobId, postId, req);
}
