import { isLinkedInEnabled, isRedditEnabled, isXEnabled, isYouTubeEnabled } from '@/backend/integrations/providers/integration-config';

type ScheduledPostQueryExecutor = {
  query: (sql: string, params: unknown[]) => Promise<{
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

export type ScheduledPostQueryable = ScheduledPostQueryExecutor & {
  /**
   * Pools expose connect(); transaction-bound clients do not. Direct callers
   * provide a pool so this helper can own a canonical-first transaction;
   * callers already inside a transaction may pass that transaction client.
   */
  connect?: () => Promise<ScheduledPostQueryExecutor & { release: () => void }>;
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
// overwritten so an extended deadline takes effect immediately; a row that
// goes from event_campaign back to weekly correctly clears the end date. The
// parent lock + child reset are one statement so a terminal row becomes a
// clean, executable pending generation rather than a cosmetic date change.
const UPSERT_SCHEDULED_POST_SQL = `
  WITH existing AS MATERIALIZED (
    SELECT id, tenant_id, dispatch_status
      FROM scheduled_posts
     WHERE post_id = $1
     FOR UPDATE
  ),
  terminal_dispatch_evidence AS MATERIALIZED (
    SELECT 1
      FROM scheduled_post_dispatches dispatch
      JOIN existing ON existing.id = dispatch.scheduled_post_id
     WHERE existing.tenant_id = $2
       AND dispatch.status IN ('dispatched', 'manual_reconciliation')
     FOR UPDATE OF dispatch
  ),
  reset_dispatches AS (
    DELETE FROM scheduled_post_dispatches dispatch
      USING existing
      WHERE dispatch.scheduled_post_id = existing.id
        AND existing.tenant_id = $2
        AND existing.dispatch_status IN ('pending', 'failed')
        AND NOT EXISTS (SELECT 1 FROM terminal_dispatch_evidence)
      RETURNING dispatch.id
  ),
  updated AS (
    UPDATE scheduled_posts
       SET scheduled_for = $3,
           target_platforms = $4,
           campaign_end_date = $5,
           surface = $6,
           media_type = $7,
           width_px = $8,
           height_px = $9,
           duration_seconds = $10,
           dispatch_status = 'pending',
           dispatch_attempt_token = NULL,
           dispatch_claimed_at = NULL,
           dispatch_started_at = NULL,
           next_attempt_at = NULL,
           dispatched_at = NULL,
           error_at = NULL,
           error_message = NULL,
           updated_at = now()
     WHERE id = (SELECT id FROM existing)
       AND tenant_id = $2
       AND dispatch_status IN ('pending', 'failed')
       AND NOT EXISTS (SELECT 1 FROM terminal_dispatch_evidence)
       AND (SELECT count(*) FROM reset_dispatches) >= 0
     RETURNING id, post_id, tenant_id, scheduled_for, target_platforms, updated_at
  ),
  inserted AS (
    INSERT INTO scheduled_posts (
      post_id, tenant_id, scheduled_for, target_platforms, campaign_end_date,
      surface, media_type, width_px, height_px, duration_seconds, updated_at
    )
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()
     WHERE NOT EXISTS (SELECT 1 FROM existing)
    ON CONFLICT (post_id) DO NOTHING
    RETURNING id, post_id, tenant_id, scheduled_for, target_platforms, updated_at
  )
  SELECT id, post_id, tenant_id, scheduled_for, target_platforms, updated_at FROM updated
  UNION ALL
  SELECT id, post_id, tenant_id, scheduled_for, target_platforms, updated_at FROM inserted
`;

function normalizeTimestamp(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

async function upsertScheduledPostInCanonicalTransaction(
  queryable: ScheduledPostQueryable,
  input: UpsertScheduledPostInput,
  { canonicalLockHeld = false }: { canonicalLockHeld?: boolean } = {},
): Promise<ScheduledPostRecord> {
  // Every writer locks the canonical post before inspecting or mutating its
  // scheduled owner. This is deliberately a separate statement inside the
  // transaction: a same-statement CTE snapshot can still race a canonical
  // delete, while this row lock serializes both writers.
  if (!canonicalLockHeld) {
    const canonical = await queryable.query(
      `SELECT id
         FROM posts
        WHERE id = $1
          AND tenant_id = $2
        FOR UPDATE`,
      [input.postId, input.tenantId],
    );
    if ((canonical.rowCount ?? canonical.rows.length) === 0 || canonical.rows.length === 0) {
      throw new ScheduledPostTenantMismatchError(input.tenantId, input.postId);
    }
  }

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
    ) => Promise<{
      rows: Array<{
        dispatch_status?: string;
        has_manual_reconciliation?: boolean;
        has_terminal_dispatch_evidence?: boolean;
      }>;
      rowCount: number | null;
    }>)(
      `SELECT owner.dispatch_status,
              EXISTS (
                SELECT 1
                  FROM scheduled_post_dispatches dispatch
                 WHERE dispatch.scheduled_post_id = owner.id
                   AND dispatch.status IN ('dispatched', 'manual_reconciliation')
              ) AS has_terminal_dispatch_evidence,
              EXISTS (
                SELECT 1
                  FROM scheduled_post_dispatches dispatch
                 WHERE dispatch.scheduled_post_id = owner.id
                   AND dispatch.status = 'manual_reconciliation'
              ) AS has_manual_reconciliation
         FROM scheduled_posts owner
        WHERE owner.post_id = $1
          AND owner.tenant_id = $2
        LIMIT 1`,
      [input.postId, input.tenantId],
    );
    if (
      statusResult.rows[0]?.dispatch_status === 'manual_reconciliation'
      || statusResult.rows[0]?.has_manual_reconciliation === true
    ) {
      throw new ScheduledPostManualReconciliationError(input.tenantId, input.postId);
    }
    if (
      statusResult.rows[0]?.dispatch_status === 'dispatched'
      || statusResult.rows[0]?.has_terminal_dispatch_evidence === true
    ) {
      throw new ScheduledPostDispatchEvidenceError(input.tenantId, input.postId);
    }
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

export async function upsertScheduledPost(
  queryable: ScheduledPostQueryable,
  input: UpsertScheduledPostInput,
  options: { canonicalLockHeld?: boolean } = {},
): Promise<ScheduledPostRecord> {
  const transactionBound = typeof (queryable as { release?: unknown }).release === 'function';
  if (typeof queryable.connect !== 'function' || transactionBound) {
    // pg PoolClient inherits connect() from ClientBase, so release() is the
    // reliable signal that this is already transaction-bound rather than a
    // pool. Route callers can attest that canonical is already locked; other
    // transaction clients acquire it here before touching the schedule owner.
    return upsertScheduledPostInCanonicalTransaction(queryable, input, options);
  }

  const client = await queryable.connect();
  let transactionFinished = false;
  try {
    await client.query('BEGIN', []);
    // Pool callers cannot bypass the canonical lock: this helper owns both the
    // transaction and its lock order regardless of a caller-supplied option.
    const record = await upsertScheduledPostInCanonicalTransaction(client, input);
    await client.query('COMMIT', []);
    transactionFinished = true;
    return record;
  } catch (error) {
    if (!transactionFinished) {
      await client.query('ROLLBACK', []).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
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

export class ScheduledPostManualReconciliationError extends Error {
  readonly tenantId: number;
  readonly postId: number;
  constructor(tenantId: number, postId: number) {
    super(`scheduled_post_manual_reconciliation: post_id=${postId}`);
    this.name = 'ScheduledPostManualReconciliationError';
    this.tenantId = tenantId;
    this.postId = postId;
  }
}

export class ScheduledPostDispatchEvidenceError extends Error {
  readonly tenantId: number;
  readonly postId: number;
  constructor(tenantId: number, postId: number) {
    super(`scheduled_post_dispatch_evidence: post_id=${postId}`);
    this.name = 'ScheduledPostDispatchEvidenceError';
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
