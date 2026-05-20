import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import {
  ScheduledPostTenantMismatchError,
  normalizeTargetPlatforms,
  parseScheduledForIso,
  upsertScheduledPost,
  type ScheduledPostQueryable,
} from '@/backend/social-content/scheduled-posts';
import {
  loadTenantContextOrResponse,
  type TenantContextLoader,
} from '@/lib/tenant-context-http';
import { scheduleScheduledPostHonchoWrite } from '@/backend/memory/write-events';
import { findLatestMarketingApprovalRecord } from '@/backend/marketing/approval-store';

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

export type ScheduleRouteQueryable = ScheduledPostQueryable & PostLookupQueryable;

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
        error: '`platforms` must be a non-empty array of "facebook" or "instagram".',
        reason: 'invalid_platforms',
      },
      { status: 400 },
    );
  }

  const ownsPool = !options.queryable;
  const pooled = options.queryable ? null : await pool.connect();
  const wrapPooled: ScheduleRouteQueryable = {
    query: ((sql: string, params: unknown[]) => pooled!.query(sql, params)) as unknown as ScheduleRouteQueryable['query'],
  };
  const client: ScheduleRouteQueryable = options.queryable ?? wrapPooled;

  try {
    const lookup = await client.query(
      'SELECT id, tenant_id FROM posts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [postIdInt, tenantId],
    );
    if ((lookup.rowCount ?? lookup.rows.length) === 0 || lookup.rows.length === 0) {
      console.warn('[social-content-schedule]', {
        jobId,
        postId,
        cause: 'post_not_found_or_tenant_mismatch',
      });
      return NextResponse.json(POST_NOT_FOUND, { status: 404 });
    }

    // Publish-approval gate: a post may only be queued for auto-publish once a
    // human has approved the publish stage. Mirrors the marketing publish path
    // (publish-facebook/handler.ts) so the contract stays consistent.
    const resolveApproval = options.publishApprovalResolver ?? defaultPublishApprovalResolver;
    const hasApproval = await resolveApproval({
      jobId,
      tenantId: String(tenantResult.tenantContext.tenantId),
    });
    if (!hasApproval) {
      console.warn('[social-content-schedule]', {
        jobId,
        postId,
        cause: 'publish_requires_approval',
      });
      return NextResponse.json(PUBLISH_REQUIRES_APPROVAL, { status: 409 });
    }

    const persisted = await upsertScheduledPost(client, {
      tenantId,
      postId: postIdInt,
      scheduledFor,
      platforms: normalizedPlatforms,
    });

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
    if (ownsPool && pooled) {
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
