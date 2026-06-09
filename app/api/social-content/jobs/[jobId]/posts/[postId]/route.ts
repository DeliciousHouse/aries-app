import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { invalidateMarketingJobStatus } from '@/backend/marketing/jobs-status';
import {
  recordReviewItemCopyEdit,
  type RecordReviewItemCopyEditOptions,
} from '@/backend/marketing/runtime-views';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { findLatestMarketingApprovalRecord } from '@/backend/marketing/approval-store';
import { recordPostEditTasteSignal } from '@/backend/marketing/review-edit-taste';

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

type DeletePostQueryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  connect?: () => Promise<DeletePostQueryable & { release: () => void }>;
};

export type PublishApprovalResolver = (input: {
  jobId: string;
  tenantId: string;
}) => boolean | Promise<boolean>;

const defaultPublishApprovalResolver: PublishApprovalResolver = ({ jobId, tenantId }) =>
  findLatestMarketingApprovalRecord({
    marketingJobId: jobId,
    tenantId,
    marketingStage: 'publish',
    statuses: ['approved'],
  }) !== null;

interface DeletePostOptions {
  tenantContextLoader?: TenantContextLoader;
  queryable?: DeletePostQueryable;
  publishApprovalResolver?: PublishApprovalResolver;
}

function postIdToInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    return null;
  }
  return parsed;
}

function tenantIdToInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export async function handleDeleteSocialContentPost(
  jobId: string,
  postId: string,
  options: DeletePostOptions = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(options.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantId: tenantIdStr } = tenantResult.tenantContext;
  if (!tenantIdStr) {
    return NextResponse.json({ error: 'tenant_context_required' }, { status: 403 });
  }
  const tenantId = tenantIdToInt(tenantIdStr);
  if (tenantId === null) {
    return NextResponse.json({ error: 'post_not_found', reason: 'post_not_found' }, { status: 404 });
  }

  const postIdInt = postIdToInt(decodeURIComponent(postId));
  if (postIdInt === null) {
    return NextResponse.json({ error: 'post_not_found', reason: 'post_not_found' }, { status: 404 });
  }

  const resolveApproval = options.publishApprovalResolver ?? defaultPublishApprovalResolver;
  const hasApproval = await resolveApproval({ jobId, tenantId: tenantIdStr });
  if (!hasApproval) {
    return NextResponse.json(
      { error: 'No approved publish approval record found for this job.', reason: 'publish_requires_approval' },
      { status: 409 },
    );
  }

  const ownsPool = !options.queryable;
  const pooled = options.queryable ? null : await pool.connect();
  const wrapPooled: DeletePostQueryable = {
    query: ((sql: string, params: unknown[]) => pooled!.query(sql, params)) as unknown as DeletePostQueryable['query'],
  };
  const client: DeletePostQueryable = options.queryable ?? wrapPooled;

  try {
    // Check post exists and belongs to tenant. Capture the generation-time style
    // lens (PR2) BEFORE the row is gone so a delete can teach tenant taste.
    const lookup = await client.query(
      'SELECT id, tenant_id, style_dimension, style_value FROM posts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [postIdInt, tenantId],
    );
    if ((lookup.rowCount ?? lookup.rows.length) === 0 || lookup.rows.length === 0) {
      return NextResponse.json({ error: 'Post not found.', reason: 'post_not_found' }, { status: 404 });
    }
    const deletedPostRow = lookup.rows[0] as { style_dimension?: string | null; style_value?: string | null };

    // Refuse if any scheduled row is in_flight — worker has already started the Meta call.
    const inFlightCheck = await client.query(
      "SELECT dispatch_status FROM scheduled_posts WHERE post_id = $1 AND tenant_id = $2 LIMIT 1",
      [postIdInt, tenantId],
    );
    if (inFlightCheck.rows.length > 0 && inFlightCheck.rows[0]!['dispatch_status'] === 'in_flight') {
      return NextResponse.json(
        { error: 'Dispatch is in progress — cannot delete post mid-flight.', reason: 'dispatch_in_flight' },
        { status: 409 },
      );
    }

    // Cascade: remove scheduled_posts row first, then the post itself.
    const schedDel = await client.query(
      'DELETE FROM scheduled_posts WHERE post_id = $1 AND tenant_id = $2',
      [postIdInt, tenantId],
    );
    const scheduledPostDeleted = (schedDel.rowCount ?? 0) > 0;

    await client.query(
      'DELETE FROM posts WHERE id = $1 AND tenant_id = $2',
      [postIdInt, tenantId],
    );

    // PR2 Phase 3: deleting a post is a structural rejection of its creative —
    // teach tenant taste on the stamped visual-style lens. Best-effort +
    // flag-gated (no-op when OFF or unstamped); never blocks the delete.
    await recordPostEditTasteSignal({
      tenantId: tenantIdStr,
      dimension: deletedPostRow.style_dimension ?? null,
      value: deletedPostRow.style_value ?? null,
      outcome: 'rejected',
    });

    invalidateMarketingJobStatus(jobId);

    return NextResponse.json(
      { jobId, postId, scheduledPostDeleted, postDeleted: true },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[social-content-post-delete]', { jobId, postId, error: message });
    return NextResponse.json(
      { error: 'Failed to delete post.', reason: 'post_delete_failed' },
      { status: 500 },
    );
  } finally {
    if (ownsPool && pooled) {
      pooled.release();
    }
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ jobId: string; postId: string }> },
) {
  const { jobId, postId } = await params;
  return handleDeleteSocialContentPost(jobId, postId);
}
