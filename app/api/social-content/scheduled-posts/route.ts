import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import {
  loadTenantContextOrResponse,
  type TenantContextLoader,
} from '@/lib/tenant-context-http';

const ONBOARDING_REQUIRED = {
  status: 409,
  reason: 'onboarding_required',
  message: 'Complete tenant onboarding before viewing the scheduled-posts queue.',
} as const;

/**
 * A3 — the calendar planner's only read path. Returns the tenant's
 * `scheduled_posts` rows in a `scheduled_for` date range, joined to `posts`
 * for caption/platform/job_id, with the per-platform dispatch detail from the
 * P1.4 `scheduled_post_dispatches` child table.
 *
 * Also returns the `unscheduled` backlog (Codex KEY GAP / T13): approved posts
 * that have no `scheduled_posts` row, so the calendar can let an operator drag
 * a not-yet-scheduled post onto a cell. Keeping both in one route holds to the
 * plan's "the calendar's only read path" intent.
 *
 * `posts.job_id` is returned as the real stored value — never synthesized.
 */

export interface ScheduledPostsQueryable {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

interface ScheduledPostsRouteOptions {
  tenantContextLoader?: TenantContextLoader;
  queryable?: ScheduledPostsQueryable;
}

type DispatchDetail = {
  platform: string;
  status: string;
  dispatchedAt: string | null;
  errorAt: string | null;
  errorMessage: string | null;
};

type ScheduledPostResponseItem = {
  id: string;
  postId: string;
  jobId: string | null;
  tenantId: number;
  title: string;
  caption: string;
  platform: string | null;
  targetPlatforms: string[];
  scheduledFor: string;
  dispatchStatus: string;
  dispatchedAt: string | null;
  errorAt: string | null;
  errorMessage: string | null;
  updatedAt: string;
  dispatches: DispatchDetail[];
};

// Raw join row shape. scheduled_post_dispatches is aggregated into a JSON
// array so the whole queue comes back in one round trip.
type RawRow = {
  id: string | number | bigint;
  post_id: string | number | bigint;
  job_id: string | null;
  tenant_id: string | number;
  caption: string | null;
  platform: string | null;
  target_platforms: string[] | null;
  scheduled_for: string | Date;
  dispatch_status: string;
  dispatched_at: string | Date | null;
  error_at: string | Date | null;
  error_message: string | null;
  updated_at: string | Date | null;
  dispatches: Array<{
    platform: string;
    status: string;
    dispatched_at: string | null;
    error_at: string | null;
    error_message: string | null;
  }> | null;
};

type UnscheduledPostItem = {
  postId: string;
  jobId: string | null;
  title: string;
  caption: string;
  platform: string | null;
  imageUrl: string | null;
};

type RawUnscheduledRow = {
  id: string | number | bigint;
  job_id: string | null;
  caption: string | null;
  platform: string | null;
  image_url: string | null;
};

// Approved posts with NO scheduled_posts row — the backlog tray (T13). An
// approved post is one whose published_status OR legacy status is 'approved'.
// LEFT JOIN ... WHERE sp.id IS NULL is the "has no row" filter.
// Exported so the publish-posts synthesizer's regression test can assert
// synthesized posts actually land in this backlog without drifting from the
// real query.
export const UNSCHEDULED_POSTS_QUERY = `
  SELECT p.id, p.job_id, p.caption, p.platform,
    (SELECT CASE WHEN ca.storage_kind = 'external_url'
                 THEN ca.storage_key
                 ELSE ca.served_asset_ref
            END
       FROM creative_assets ca
       WHERE ca.tenant_id = p.tenant_id
         AND (ca.id::text = ANY(p.creative_asset_ids)
              OR ca.source_asset_id = ANY(p.creative_asset_ids))
         AND ca.storage_kind IN ('runtime_asset', 'ingested_asset', 'external_url')
         AND ca.orphaned_at IS NULL
         AND (CASE WHEN ca.storage_kind = 'external_url'
                   THEN ca.storage_key IS NOT NULL
                   ELSE ca.served_asset_ref IS NOT NULL
              END)
       ORDER BY ca.created_at DESC LIMIT 1) AS image_url
  FROM posts p
  LEFT JOIN scheduled_posts sp ON sp.post_id = p.id
  WHERE p.tenant_id = $1
    AND sp.id IS NULL
    AND (p.published_status = 'approved' OR p.status = 'approved')
  ORDER BY p.created_at DESC NULLS LAST, p.id DESC
  LIMIT 100
`;

const SCHEDULED_POSTS_QUERY = `
  SELECT
    sp.id,
    sp.post_id,
    sp.tenant_id,
    sp.scheduled_for,
    sp.target_platforms,
    sp.dispatch_status,
    sp.dispatched_at,
    sp.error_at,
    sp.error_message,
    sp.updated_at,
    p.job_id,
    p.caption,
    p.platform,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'platform', d.platform,
            'status', d.status,
            'dispatched_at', d.dispatched_at,
            'error_at', d.error_at,
            'error_message', d.error_message
          )
          ORDER BY d.platform
        )
        FROM scheduled_post_dispatches d
        WHERE d.scheduled_post_id = sp.id
      ),
      '[]'::json
    ) AS dispatches
  FROM scheduled_posts sp
  JOIN posts p ON p.id = sp.post_id AND p.tenant_id = sp.tenant_id
  WHERE sp.tenant_id = $1
    AND sp.scheduled_for >= $2
    AND sp.scheduled_for < $3
  ORDER BY sp.scheduled_for ASC
`;

function tenantIdToInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseRangeBound(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function toIso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function deriveTitle(caption: string): string {
  const firstLine = caption.split(/\r?\n/)[0]?.trim() ?? '';
  if (!firstLine) {
    return 'Scheduled post';
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function mapRow(row: RawRow): ScheduledPostResponseItem {
  const caption = row.caption ?? '';
  return {
    id: String(row.id),
    postId: String(row.post_id),
    jobId: row.job_id ?? null,
    tenantId: Number(row.tenant_id),
    title: deriveTitle(caption),
    caption,
    platform: row.platform ?? null,
    targetPlatforms: Array.isArray(row.target_platforms) ? row.target_platforms : [],
    scheduledFor: toIso(row.scheduled_for) ?? '',
    dispatchStatus: row.dispatch_status,
    dispatchedAt: toIso(row.dispatched_at),
    errorAt: toIso(row.error_at),
    errorMessage: row.error_message ?? null,
    updatedAt: toIso(row.updated_at) ?? '',
    dispatches: (row.dispatches ?? []).map((dispatch) => ({
      platform: dispatch.platform,
      status: dispatch.status,
      dispatchedAt: dispatch.dispatched_at,
      errorAt: dispatch.error_at,
      errorMessage: dispatch.error_message,
    })),
  };
}

export async function handleGetScheduledPosts(
  req: Request,
  options: ScheduledPostsRouteOptions = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(options.tenantContextLoader, {
    missingMembershipResponse: ONBOARDING_REQUIRED,
  });
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = tenantIdToInt(tenantResult.tenantContext.tenantId);
  if (tenantId === null) {
    return NextResponse.json(
      { error: 'Tenant context is not valid.', reason: 'invalid_tenant_context' },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const from = parseRangeBound(url.searchParams.get('from'));
  const to = parseRangeBound(url.searchParams.get('to'));
  if (!from || !to) {
    return NextResponse.json(
      {
        error: '`from` and `to` must both be ISO 8601 timestamps.',
        reason: 'invalid_date_range',
      },
      { status: 400 },
    );
  }
  if (from.getTime() >= to.getTime()) {
    return NextResponse.json(
      { error: '`from` must be earlier than `to`.', reason: 'invalid_date_range' },
      { status: 400 },
    );
  }

  const ownsPool = !options.queryable;
  const pooled = options.queryable ? null : await pool.connect();
  const client: ScheduledPostsQueryable = options.queryable ?? {
    query: ((sql: string, params: unknown[]) => pooled!.query(sql, params)) as unknown as ScheduledPostsQueryable['query'],
  };

  try {
    const result = await client.query(SCHEDULED_POSTS_QUERY, [
      tenantId,
      from.toISOString(),
      to.toISOString(),
    ]);
    const posts = (result.rows as RawRow[]).map(mapRow);

    const unscheduledResult = await client.query(UNSCHEDULED_POSTS_QUERY, [tenantId]);
    const unscheduled: UnscheduledPostItem[] = (unscheduledResult.rows as RawUnscheduledRow[]).map(
      (row) => {
        const caption = row.caption ?? '';
        return {
          postId: String(row.id),
          jobId: row.job_id ?? null,
          title: deriveTitle(caption),
          caption,
          platform: row.platform ?? null,
          imageUrl: row.image_url ?? null,
        };
      },
    );

    return NextResponse.json(
      {
        posts,
        unscheduled,
        range: { from: from.toISOString(), to: to.toISOString() },
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[social-content-scheduled-posts]', { tenantId, error: message });
    return NextResponse.json(
      { error: 'Failed to load the scheduled-posts queue.', reason: 'scheduled_posts_read_failed' },
      { status: 500 },
    );
  } finally {
    if (ownsPool && pooled) {
      pooled.release();
    }
  }
}

export async function GET(req: Request) {
  return handleGetScheduledPosts(req);
}
