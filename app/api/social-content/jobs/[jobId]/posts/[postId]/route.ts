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

  const connectionSource = options.queryable ?? pool;
  const pooled = connectionSource.connect ? await connectionSource.connect() : null;
  const wrapPooled: DeletePostQueryable = {
    query: ((sql: string, params: unknown[]) => pooled!.query(sql, params)) as unknown as DeletePostQueryable['query'],
  };
  const client: DeletePostQueryable = pooled ? wrapPooled : options.queryable!;
  let transactionFinished = false;

  try {
    await client.query('BEGIN', []);
    // Lock the scheduled owner before any canonical post mutation. The worker
    // claim takes this same lock, making cancel-vs-claim a single winner race.
    const scheduledOwner = await client.query(
      `SELECT id,
              dispatch_status,
              EXISTS (
                SELECT 1
                  FROM scheduled_post_dispatches dispatch
                 WHERE dispatch.scheduled_post_id = scheduled_posts.id
                   AND dispatch.status IN ('dispatched', 'manual_reconciliation')
              ) AS has_terminal_dispatch_evidence
         FROM scheduled_posts
        WHERE post_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [postIdInt, tenantId],
    );

    const dispatchStatus = scheduledOwner.rows[0]?.['dispatch_status'];
    const hasTerminalDispatchEvidence = scheduledOwner.rows[0]?.['has_terminal_dispatch_evidence'] === true;
    if (
      (dispatchStatus !== undefined && dispatchStatus !== 'pending')
      || hasTerminalDispatchEvidence
    ) {
      await client.query('COMMIT', []);
      transactionFinished = true;
      return NextResponse.json(
        dispatchStatus === 'in_flight'
          ? { error: 'Dispatch is in progress — cannot delete post mid-flight.', reason: 'dispatch_in_flight' }
          : { error: 'Scheduled post is not cancellable.', reason: 'dispatch_not_cancellable' },
        { status: 409 },
      );
    }

    // Check post exists and belongs to tenant. Capture the generation-time style
    // lens (PR2) BEFORE the row is gone so a delete can teach tenant taste.
    const lookup = await client.query(
      'SELECT id, tenant_id, style_dimension, style_value FROM posts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [postIdInt, tenantId],
    );
    if ((lookup.rowCount ?? lookup.rows.length) === 0 || lookup.rows.length === 0) {
      await client.query('COMMIT', []);
      transactionFinished = true;
      return NextResponse.json({ error: 'Post not found.', reason: 'post_not_found' }, { status: 404 });
    }
    const deletedPostRow = lookup.rows[0] as { style_dimension?: string | null; style_value?: string | null };

    // Cascade: remove scheduled_posts row first, then the post itself.
    const schedDel = scheduledOwner.rows[0]
      ? await client.query(
          `DELETE FROM scheduled_posts
            WHERE id = $1::bigint
              AND dispatch_status = 'pending'
              AND NOT EXISTS (
                SELECT 1
                  FROM scheduled_post_dispatches dispatch
                 WHERE dispatch.scheduled_post_id = scheduled_posts.id
                   AND dispatch.status IN ('dispatched', 'manual_reconciliation')
              )`,
          [scheduledOwner.rows[0]['id']],
        )
      : { rows: [], rowCount: 0 };
    const scheduledPostDeleted = (schedDel.rowCount ?? 0) > 0;
    if (scheduledOwner.rows[0] && !scheduledPostDeleted) {
      await client.query('ROLLBACK', []);
      transactionFinished = true;
      return NextResponse.json(
        { error: 'Scheduled post is not cancellable.', reason: 'dispatch_not_cancellable' },
        { status: 409 },
      );
    }

    await client.query(
      'DELETE FROM posts WHERE id = $1 AND tenant_id = $2',
      [postIdInt, tenantId],
    );

    await client.query('COMMIT', []);
    transactionFinished = true;

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
    if (!transactionFinished) await client.query('ROLLBACK', []).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error('[social-content-post-delete]', { jobId, postId, error: message });
    return NextResponse.json(
      { error: 'Failed to delete post.', reason: 'post_delete_failed' },
      { status: 500 },
    );
  } finally {
    if (pooled) {
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
