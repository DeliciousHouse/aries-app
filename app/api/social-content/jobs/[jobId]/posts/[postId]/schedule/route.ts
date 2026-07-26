import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import {
  normalizeTargetPlatforms,
  parseScheduledForIso,
  ScheduledPostDispatchEvidenceError,
  ScheduledPostInFlightError,
  ScheduledPostManualReconciliationError,
  ScheduledPostTenantMismatchError,
  upsertScheduledPost,
  type ScheduledPostQueryable,
} from '@/backend/social-content/scheduled-posts';
import {
  loadTenantContextOrResponse,
  type TenantContextLoader,
} from '@/lib/tenant-context-http';
import { scheduleScheduledPostHonchoWrite } from '@/backend/memory/write-events';
import { findLatestMarketingApprovalRecord } from '@/backend/marketing/approval-store';
import { loadSocialContentJobRuntime, asRecord, asString } from '@/backend/marketing/runtime-state';

/**
 * Read the parent campaign's end date out of the marketing runtime document.
 * Returns a Date for one-off campaigns whose payload carries a valid UTC ISO
 * timestamp under `inputs.request.oneOff.campaignEndDate`; returns null for
 * weekly campaigns and for any malformed/missing oneOff payload. The null path
 * preserves the legacy weekly behaviour -- the worker treats NULL as "no end
 * date" and never blocks these rows.
 */
async function resolveCampaignEndDateForJob(jobId: string): Promise<Date | null> {
  const doc = await loadSocialContentJobRuntime(jobId);
  if (!doc || (doc.job_type !== 'one_off_post' && doc.job_type !== 'one_off_campaign')) {
    return null;
  }
  const request = asRecord(doc.inputs.request);
  const oneOff = request ? asRecord(request.oneOff) : null;
  const raw = oneOff ? asString(oneOff.campaignEndDate) : null;
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

const ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before scheduling social content posts.',
} as const;

const POST_NOT_FOUND = {
  error: 'Social content post not found.',
  reason: 'social_content_post_not_found',
} as const;

const PUBLISH_REQUIRES_APPROVAL = {
  error: 'No approved publish approval record found for this job.',
  reason: 'publish_requires_approval',
} as const;

// Resolves whether the job has an approved `publish`-stage approval record.
// Injectable so route tests can exercise the gate without a file-backed store.
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

type PostLookupQueryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{
    rows: Array<{ id: string | number | bigint; tenant_id: string | number }>;
    rowCount: number | null;
  }>;
};

export type ScheduleRouteQueryable = ScheduledPostQueryable & PostLookupQueryable & {
  connect?: () => Promise<ScheduleRouteQueryable & { release: () => void }>;
};

interface ScheduleRouteOptions {
  tenantContextLoader?: TenantContextLoader;
  queryable?: ScheduleRouteQueryable;
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

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function handlePatchScheduleSocialContentPost(
  jobId: string,
  postId: string,
  req: Request,
  options: ScheduleRouteOptions = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(options.tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = tenantIdToInt(tenantResult.tenantContext.tenantId);
  if (tenantId === null) {
    return NextResponse.json(POST_NOT_FOUND, { status: 404 });
  }

  const postIdInt = postIdToInt(postId);
  if (postIdInt === null) {
    return NextResponse.json(POST_NOT_FOUND, { status: 404 });
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'Request body must be an object.', reason: 'invalid_request_body' },
      { status: 400 },
    );
  }
  const { scheduled_at, platforms } = body as { scheduled_at?: unknown; platforms?: unknown };

  const scheduledFor = parseScheduledForIso(scheduled_at);
  if (!scheduledFor) {
    return NextResponse.json(
      {
        error: '`scheduled_at` must be an ISO 8601 timestamp.',
        reason: 'invalid_scheduled_at',
      },
      { status: 400 },
    );
  }

  const normalizedPlatforms = normalizeTargetPlatforms(platforms);
  if (!normalizedPlatforms || normalizedPlatforms.length === 0) {
    return NextResponse.json(
      {
        error: '`platforms` must be a non-empty array of supported target platforms.',
        reason: 'invalid_platforms',
      },
      { status: 400 },
    );
  }

  const connectionSource = options.queryable ?? pool;
  const pooled = connectionSource.connect ? await connectionSource.connect() : null;
  const wrapPooled: ScheduleRouteQueryable = {
    query: ((sql: string, params: unknown[]) =>
      (pooled as unknown as ScheduleRouteQueryable).query(sql, params)) as ScheduleRouteQueryable['query'],
  };
  const client: ScheduleRouteQueryable = pooled ? wrapPooled : options.queryable!;
  const transactionEnabled = pooled !== null;
  let transactionFinished = !transactionEnabled;

  try {
    if (transactionEnabled) await client.query('BEGIN', []);
    const lookup = await client.query(
      `SELECT id, tenant_id, surface, media_type, width_px, height_px, duration_seconds
         FROM posts
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [postIdInt, tenantId],
    );
    if ((lookup.rowCount ?? lookup.rows.length) === 0 || lookup.rows.length === 0) {
      if (transactionEnabled) {
        await client.query('COMMIT', []);
        transactionFinished = true;
      }
      console.warn('[social-content-schedule]', {
        jobId,
        postId,
        cause: 'post_not_found_or_tenant_mismatch',
      });
      return NextResponse.json(POST_NOT_FOUND, { status: 404 });
    }
    // The post's own surface/media_type/dims are authoritative — mirror them onto
    // the scheduled_posts row so an image story (or reel) dispatches on the right
    // Meta surface instead of defaulting to 'feed', and validateMediaForSurface
    // has real width/height/duration_seconds at dispatch time.
    const postRow = lookup.rows[0] as {
      surface?: unknown;
      media_type?: unknown;
      width_px?: unknown;
      height_px?: unknown;
      duration_seconds?: unknown;
    } | undefined;
    const postSurfaceRaw = typeof postRow?.surface === 'string' ? postRow.surface.trim().toLowerCase() : '';
    const postSurface: 'feed' | 'story' | 'reel' =
      postSurfaceRaw === 'story' || postSurfaceRaw === 'reel' ? postSurfaceRaw : 'feed';
    const postMediaType: 'image' | 'video' =
      typeof postRow?.media_type === 'string' && postRow.media_type.trim().toLowerCase() === 'video' ? 'video' : 'image';
    const toDimPx = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const postWidthPx = toDimPx(postRow?.width_px);
    const postHeightPx = toDimPx(postRow?.height_px);
    const postDurationSeconds = toDimPx(postRow?.duration_seconds);

    // Publish-approval gate: a post may only be queued for auto-publish once a
    // human has approved the publish stage. Mirrors the marketing publish path
    // (publish-facebook/handler.ts) so the contract stays consistent.
    const resolveApproval = options.publishApprovalResolver ?? defaultPublishApprovalResolver;
    const hasApproval = await resolveApproval({
      jobId,
      tenantId: String(tenantResult.tenantContext.tenantId),
    });
    if (!hasApproval) {
      if (transactionEnabled) {
        await client.query('COMMIT', []);
        transactionFinished = true;
      }
      console.warn('[social-content-schedule]', {
        jobId,
        postId,
        cause: 'publish_requires_approval',
      });
      return NextResponse.json(PUBLISH_REQUIRES_APPROVAL, { status: 409 });
    }

    // Event campaigns carry a UTC end date the worker filters on at claim
    // time; weekly campaigns leave it null (the worker treats NULL as "no end
    // date"). Resolved once per schedule call; cheap and idempotent.
    const campaignEndDate = await resolveCampaignEndDateForJob(jobId);

    const persisted = await upsertScheduledPost(client, {
      tenantId,
      postId: postIdInt,
      scheduledFor,
      platforms: normalizedPlatforms,
      campaignEndDate,
      surface: postSurface,
      mediaType: postMediaType,
      widthPx: postWidthPx,
      heightPx: postHeightPx,
      durationSeconds: postDurationSeconds,
    });

    if (transactionEnabled) {
      await client.query('COMMIT', []);
      transactionFinished = true;
    }

    scheduleScheduledPostHonchoWrite({
      tenantCtx: {
        tenantId: String(tenantResult.tenantContext.tenantId),
        tenantSlug: tenantResult.tenantContext.tenantSlug,
        userId: tenantResult.tenantContext.userId,
        role: tenantResult.tenantContext.role,
      },
      jobId,
      postId: String(persisted.postId),
      platforms: persisted.platforms,
      scheduledForIso: persisted.scheduledFor,
    });

    return NextResponse.json(
      {
        jobId,
        postId: persisted.postId,
        scheduledAt: persisted.scheduledFor,
        platforms: persisted.platforms,
        updatedAt: persisted.updatedAt,
      },
      { status: 200 },
    );
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK', []).catch(() => {});
    if (error instanceof ScheduledPostInFlightError) {
      return NextResponse.json(
        { error: 'This post is already being published.', reason: 'scheduled_post_in_flight' },
        { status: 409 },
      );
    }
    if (error instanceof ScheduledPostManualReconciliationError) {
      return NextResponse.json(
        {
          error: 'This post may already be live and must be checked manually before rescheduling.',
          reason: 'scheduled_post_manual_reconciliation',
        },
        { status: 409 },
      );
    }
    if (error instanceof ScheduledPostDispatchEvidenceError) {
      return NextResponse.json(
        {
          error: 'This post has already been published to at least one platform and cannot be queued again.',
          reason: 'scheduled_post_dispatch_evidence',
        },
        { status: 409 },
      );
    }
    if (error instanceof ScheduledPostTenantMismatchError) {
      return NextResponse.json(POST_NOT_FOUND, { status: 404 });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[social-content-schedule]', {
      jobId,
      postId,
      error: message,
    });
    return NextResponse.json(
      { error: 'Failed to update scheduled post.', reason: 'scheduled_post_write_failed' },
      { status: 500 },
    );
  } finally {
    if (pooled) {
      pooled.release();
    }
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ jobId: string; postId: string }> },
) {
  const { jobId, postId } = await params;
  return handlePatchScheduleSocialContentPost(jobId, postId, req);
}

type DeleteScheduleQueryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  connect?: () => Promise<DeleteScheduleQueryable & { release: () => void }>;
};

interface DeleteScheduleOptions {
  tenantContextLoader?: TenantContextLoader;
  queryable?: DeleteScheduleQueryable;
  publishApprovalResolver?: PublishApprovalResolver;
}

export async function handleDeleteScheduleSocialContentPost(
  jobId: string,
  postId: string,
  options: DeleteScheduleOptions = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(options.tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = tenantIdToInt(tenantResult.tenantContext.tenantId);
  if (tenantId === null) {
    return NextResponse.json(POST_NOT_FOUND, { status: 404 });
  }

  const postIdInt = postIdToInt(postId);
  if (postIdInt === null) {
    return NextResponse.json(POST_NOT_FOUND, { status: 404 });
  }

  const connectionSource = options.queryable ?? pool;
  const pooled = connectionSource.connect ? await connectionSource.connect() : null;
  const wrapPooled: DeleteScheduleQueryable = {
    query: ((sql: string, params: unknown[]) => pooled!.query(sql, params)) as unknown as DeleteScheduleQueryable['query'],
  };
  const client: DeleteScheduleQueryable = pooled ? wrapPooled : options.queryable!;
  let transactionFinished = false;

  try {
    await client.query('BEGIN', []);
    const lookup = await client.query(
      'SELECT id, tenant_id FROM posts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [postIdInt, tenantId],
    );
    if ((lookup.rowCount ?? lookup.rows.length) === 0 || lookup.rows.length === 0) {
      await client.query('COMMIT', []);
      transactionFinished = true;
      return NextResponse.json(POST_NOT_FOUND, { status: 404 });
    }

    const resolveApproval = options.publishApprovalResolver ?? defaultPublishApprovalResolver;
    const hasApproval = await resolveApproval({
      jobId,
      tenantId: String(tenantResult.tenantContext.tenantId),
    });
    if (!hasApproval) {
      await client.query('COMMIT', []);
      transactionFinished = true;
      return NextResponse.json(PUBLISH_REQUIRES_APPROVAL, { status: 409 });
    }

    // Serialize cancellation against the worker's parent-row claim. Whichever
    // transaction gets this lock first determines the only valid outcome.
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
    if (scheduledOwner.rows.length === 0) {
      await client.query('COMMIT', []);
      transactionFinished = true;
      return NextResponse.json(
        { error: 'Scheduled post not found.', reason: 'scheduled_post_not_found' },
        { status: 404 },
      );
    }
    const dispatchStatus = scheduledOwner.rows[0]!['dispatch_status'];
    const hasTerminalDispatchEvidence = scheduledOwner.rows[0]!['has_terminal_dispatch_evidence'] === true;
    if (dispatchStatus !== 'pending' || hasTerminalDispatchEvidence) {
      await client.query('COMMIT', []);
      transactionFinished = true;
      return NextResponse.json(
        dispatchStatus === 'in_flight'
          ? { error: 'Dispatch is in progress — cannot cancel mid-flight.', reason: 'dispatch_in_flight' }
          : { error: 'Scheduled post is not cancellable.', reason: 'dispatch_not_cancellable' },
        { status: 409 },
      );
    }

    const del = await client.query(
      `DELETE FROM scheduled_posts
        WHERE id = $1::bigint
          AND dispatch_status = 'pending'
          AND NOT EXISTS (
            SELECT 1
              FROM scheduled_post_dispatches dispatch
             WHERE dispatch.scheduled_post_id = scheduled_posts.id
               AND dispatch.status IN ('dispatched', 'manual_reconciliation')
          )`,
      [scheduledOwner.rows[0]!['id']],
    );
    if ((del.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK', []);
      transactionFinished = true;
      return NextResponse.json(
        { error: 'Dispatch changed while cancellation was pending.', reason: 'dispatch_in_flight' },
        { status: 409 },
      );
    }

    await client.query('COMMIT', []);
    transactionFinished = true;

    return NextResponse.json(
      { jobId, postId, deletedAt: new Date().toISOString() },
      { status: 200 },
    );
  } catch (error) {
    if (!transactionFinished) await client.query('ROLLBACK', []).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error('[social-content-schedule-delete]', { jobId, postId, error: message });
    return NextResponse.json(
      { error: 'Failed to delete scheduled post.', reason: 'scheduled_post_delete_failed' },
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
  return handleDeleteScheduleSocialContentPost(jobId, postId);
}
