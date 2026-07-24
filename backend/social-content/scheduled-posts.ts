import { isLinkedInEnabled, isRedditEnabled, isXEnabled, isYouTubeEnabled } from '@/backend/integrations/providers/integration-config';

export type ScheduledPostQueryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{
    rows: Array<{
      id: string | number | bigint;
      post_id: string | number | bigint;
      tenant_id: string | number;
      scheduled_for: string | Date;
      target_platforms: string[];
      updated_at: string | Date;
    }>;
    rowCount: number | null;
  }>;
};

export interface UpsertScheduledPostInput {
  tenantId: number;
  postId: number;
  scheduledFor: Date;
  platforms: string[];
  /** Publish surface mirrored onto scheduled_posts (feed|story|reel). Default 'feed'. */
  surface?: 'feed' | 'story' | 'reel';
  /** Media type mirrored onto scheduled_posts (image|video). Default 'image'. */
  mediaType?: 'image' | 'video';
  /** Per-media video dims mirrored onto scheduled_posts. NULL today. */
  widthPx?: number | null;
  heightPx?: number | null;
  durationSeconds?: number | null;
  /**
   * UTC instant when publishing must stop for this row's parent campaign. NULL
   * means "no end date" -- the legacy weekly_social_content behaviour. Set by
   * the schedule route for one-off event campaigns; the scheduled-posts worker
   * filters at claim-time on (campaign_end_date IS NULL OR >= NOW()).
   */
  campaignEndDate?: Date | null;
}

export interface ScheduledPostRecord {
  id: string;
  postId: string;
  tenantId: number;
  scheduledFor: string;
  platforms: string[];
  updatedAt: string;
}

// $5 is the campaign_end_date UTC instant (null for weekly campaigns -- the
// worker treats NULL as "no end date"). On a re-schedule the column is
// overwritten with EXCLUDED.campaign_end_date so an extended deadline takes
// effect immediately; a row that goes from event_campaign back to weekly (rare,
// future cancellation flow) correctly clears the end date.
const UPSERT_SCHEDULED_POST_SQL = `
  INSERT INTO scheduled_posts (post_id, tenant_id, scheduled_for, target_platforms, campaign_end_date, surface, media_type, width_px, height_px, duration_seconds, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
  ON CONFLICT (post_id) DO UPDATE
    SET scheduled_for = EXCLUDED.scheduled_for,
        target_platforms = EXCLUDED.target_platforms,
        campaign_end_date = EXCLUDED.campaign_end_date,
        surface = EXCLUDED.surface,
        media_type = EXCLUDED.media_type,
        width_px = EXCLUDED.width_px,
        height_px = EXCLUDED.height_px,
        duration_seconds = EXCLUDED.duration_seconds,
        -- A (re)schedule resets any retry backoff: an operator moving a
        -- backed-off row expects the new time to be honored, not silently
        -- skipped until the old next_attempt_at passes.
        next_attempt_at = NULL,
        updated_at = now()
    WHERE scheduled_posts.tenant_id = EXCLUDED.tenant_id
      AND scheduled_posts.dispatch_status <> 'in_flight'
  RETURNING id, post_id, tenant_id, scheduled_for, target_platforms, updated_at
`;

function normalizeTimestamp(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export async function upsertScheduledPost(
  queryable: ScheduledPostQueryable,
  input: UpsertScheduledPostInput,
): Promise<ScheduledPostRecord> {
  const result = await queryable.query(UPSERT_SCHEDULED_POST_SQL, [
    input.postId,
    input.tenantId,
    input.scheduledFor.toISOString(),
    input.platforms,
    input.campaignEndDate ? input.campaignEndDate.toISOString() : null,
    input.surface ?? 'feed',
    input.mediaType ?? 'image',
    input.widthPx ?? null,
    input.heightPx ?? null,
    input.durationSeconds ?? null,
  ]);
  if ((result.rowCount ?? result.rows.length) === 0 || result.rows.length === 0) {
    const statusResult = await (queryable.query as unknown as (
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Array<{ dispatch_status?: string }>; rowCount: number | null }>)(
      `SELECT dispatch_status FROM scheduled_posts WHERE post_id = $1 AND tenant_id = $2 LIMIT 1`,
      [input.postId, input.tenantId],
    );
    if (statusResult.rows.length > 0) {
      // The conflict UPDATE is atomic with the ownership check. Even if the
      // publish completes between it and this diagnostic SELECT, return 409 so
      // the operator retries from fresh terminal state rather than mistaking a
      // no-op for a successful reschedule.
      throw new ScheduledPostInFlightError(input.tenantId, input.postId);
    }
    // Tenant guard: WHERE clause prevented update; surface typed error so
    // the route returns 404 rather than leaking the cross-tenant attempt.
    throw new ScheduledPostTenantMismatchError(input.tenantId, input.postId);
  }
  const row = result.rows[0];
  return {
    id: String(row.id),
    postId: String(row.post_id),
    tenantId: Number(row.tenant_id),
    scheduledFor: normalizeTimestamp(row.scheduled_for),
    platforms: Array.isArray(row.target_platforms) ? row.target_platforms : [],
    updatedAt: normalizeTimestamp(row.updated_at),
  };
}

export class ScheduledPostInFlightError extends Error {
  readonly tenantId: number;
  readonly postId: number;
  constructor(tenantId: number, postId: number) {
    super(`scheduled_post_in_flight: post_id=${postId}`);
    this.name = 'ScheduledPostInFlightError';
    this.tenantId = tenantId;
    this.postId = postId;
  }
}

export class ScheduledPostTenantMismatchError extends Error {
  readonly tenantId: number;
  readonly postId: number;
  constructor(tenantId: number, postId: number) {
    super(`Scheduled post tenant mismatch for post_id=${postId}`);
    this.name = 'ScheduledPostTenantMismatchError';
    this.tenantId = tenantId;
    this.postId = postId;
  }
}

export const ALLOWED_TARGET_PLATFORMS = ['facebook', 'instagram', 'x', 'reddit', 'linkedin', 'youtube'] as const;
export type AllowedTargetPlatform = (typeof ALLOWED_TARGET_PLATFORMS)[number];

/**
 * The platforms an operator can schedule a post to RIGHT NOW. `'x'` (Twitter),
 * `'reddit'`, `'linkedin'` and `'youtube'` are each valid targets only while
 * their rollout flag (`ARIES_X_ENABLED` / `ARIES_REDDIT_ENABLED` /
 * `ARIES_LINKEDIN_ENABLED` / `ARIES_YOUTUBE_ENABLED`) is on; computed at call
 * time so a flag flip takes effect without a restart. When all are OFF (the
 * default) the allowed set is byte-identical to facebook+instagram, so an
 * `x`/`reddit`/`linkedin`/`youtube` schedule request still fails
 * `invalid_platforms` exactly as before.
 */
function allowedTargetPlatforms(): ReadonlySet<AllowedTargetPlatform> {
  const allowed = new Set<AllowedTargetPlatform>(['facebook', 'instagram']);
  if (isXEnabled()) allowed.add('x');
  if (isRedditEnabled()) allowed.add('reddit');
  if (isLinkedInEnabled()) allowed.add('linkedin');
  if (isYouTubeEnabled()) allowed.add('youtube');
  return allowed;
}

export function normalizeTargetPlatforms(value: unknown): AllowedTargetPlatform[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const allowed = allowedTargetPlatforms();
  const seen = new Set<AllowedTargetPlatform>();
  const result: AllowedTargetPlatform[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const normalized = entry.trim().toLowerCase();
    if (!allowed.has(normalized as AllowedTargetPlatform)) {
      return null;
    }
    const platform = normalized as AllowedTargetPlatform;
    if (!seen.has(platform)) {
      seen.add(platform);
      result.push(platform);
    }
  }
  return result;
}

export function parseScheduledForIso(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = new Date(trimmed);
  if (Number.isNaN(candidate.getTime())) {
    return null;
  }
  return candidate;
}
