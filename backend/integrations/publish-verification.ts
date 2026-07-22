import type { Pool } from 'pg';

import { stampInsightsPostAttribution } from '../insights/sync/attribution-writer';
import { getDecryptedAccessTokenForTenantProvider } from './oauth-credentials';

export type PublishedStatus = 'published' | 'unverified';

export type PublishVerificationStatus = 'published' | 'unverified' | 'skipped';

export type PublishVerificationReason =
  | 'graph_404'
  | 'graph_5xx'
  | 'graph_4xx'
  | 'graph_id_mismatch'
  | 'graph_network_error'
  | 'graph_invalid_response'
  | 'page_token_unavailable'
  | 'persistence_error';

const META_PROVIDERS = new Set(['meta', 'facebook', 'instagram']);

function metaGraphVersion(): string {
  const raw = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractPlatformPostId(primaryOutput: unknown): string | null {
  if (!primaryOutput || typeof primaryOutput !== 'object' || Array.isArray(primaryOutput)) {
    return null;
  }
  const record = primaryOutput as Record<string, unknown>;
  return (
    readStringField(record, 'platform_post_id')
    || readStringField(record, 'post_id')
    || readStringField(record, 'id')
  );
}

export type VerifyMetaPostExistsArgs = {
  platformPostId: string;
  pageToken: string;
  fetchImpl?: typeof fetch;
};

export type VerifyMetaPostExistsResult =
  | { verified: true }
  | { verified: false; reason: PublishVerificationReason };

export async function verifyMetaPostExists(
  args: VerifyMetaPostExistsArgs,
): Promise<VerifyMetaPostExistsResult> {
  const url = new URL(
    `https://graph.facebook.com/${metaGraphVersion()}/${encodeURIComponent(args.platformPostId)}`,
  );
  url.searchParams.set('access_token', args.pageToken);

  const fetchImpl = args.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET' });
  } catch {
    return { verified: false, reason: 'graph_network_error' };
  }

  if (response.status === 404) {
    return { verified: false, reason: 'graph_404' };
  }
  if (response.status >= 500) {
    return { verified: false, reason: 'graph_5xx' };
  }
  if (!response.ok) {
    return { verified: false, reason: 'graph_4xx' };
  }

  let parsed: { id?: unknown } | null = null;
  try {
    parsed = (await response.json()) as { id?: unknown };
  } catch {
    return { verified: false, reason: 'graph_invalid_response' };
  }

  const responseId = typeof parsed?.id === 'string' ? parsed.id : '';
  if (responseId !== args.platformPostId) {
    return { verified: false, reason: 'graph_id_mismatch' };
  }
  return { verified: true };
}

export type PersistPublishedPostArgs = {
  tenantId: number;
  caption: string;
  platformPostId: string;
  publishedAt: Date;
  publishedStatus: PublishedStatus;
  /** Stable key derived from (marketing_job_id, stage, asset_index, platform). Used for idempotency. */
  idempotencyKey?: string | null;
  /** Normalized platform name (e.g. 'facebook', 'instagram'). Stored for idempotency index lookups. */
  platform?: string | null;
  /** Marketing job ID for correlating posts back to marketing jobs. */
  jobId?: string | null;
  /**
   * Creative-asset ids of the image(s) actually published with this post.
   * Each entry must match either `creative_assets.id` (uuid) or the Hermes-side
   * `creative_assets.source_asset_id` ('img_1', ...) — the same forms the
   * scheduled-dispatch resolver (`resolveMediaUrls`) joins on. Persisted to
   * `posts.creative_asset_ids` so per-post media scoping is exact instead of
   * falling back to job-scope. Empty/omitted leaves the column at its '{}'
   * default and the resolver keeps its job-scoped fallback.
   */
  creativeAssetIds?: string[] | null;
};

async function stampPublishedPostAttributionBestEffort(
  args: PersistPublishedPostArgs,
  postId: string,
  db: Pool,
  platformPostId = args.platformPostId,
): Promise<void> {
  if (!args.platform) return;
  try {
    await stampInsightsPostAttribution({
      db,
      tenantId: args.tenantId,
      ariesPostId: postId,
      platform: args.platform,
      platformPostId,
    });
  } catch (error) {
    // Attribution is additive analytics metadata. A transient write failure
    // must never turn a confirmed platform publish into an application error.
    console.warn('[publish-verification] insights attribution stamp failed', {
      tenantId: args.tenantId,
      postId,
      platform: args.platform,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Lookup an existing posts row by idempotency key. Returns the row if found,
 * null otherwise. Callers should check this before inserting to short-circuit
 * duplicate publishes without relying solely on the unique constraint.
 */
export async function findPostByIdempotencyKey(args: {
  tenantId: number;
  platform: string;
  idempotencyKey: string;
}, db: Pool): Promise<{ postId: string; platformPostId: string | null } | null> {
  const result = await db.query<{ id: string | number; platform_post_id: string | null }>(
    `SELECT id, platform_post_id FROM posts
     WHERE tenant_id = $1 AND platform = $2 AND idempotency_key = $3
     LIMIT 1`,
    [args.tenantId, args.platform, args.idempotencyKey],
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return { postId: String(row.id), platformPostId: row.platform_post_id ?? null };
}

async function repairExistingPlatformPostIdFirstWriteWins(
  args: PersistPublishedPostArgs,
  existing: { postId: string; platformPostId: string | null },
  db: Pool,
): Promise<string> {
  if (existing.platformPostId) return existing.platformPostId;

  const platform = args.platform;
  const idempotencyKey = args.idempotencyKey;
  if (!platform || !idempotencyKey) return args.platformPostId;

  const repaired = await db.query<{ platform_post_id: string | null }>(
    `UPDATE posts
        SET platform_post_id = COALESCE(platform_post_id, $1),
            updated_at = CASE WHEN platform_post_id IS NULL THEN now() ELSE updated_at END
      WHERE id = $2
        AND tenant_id = $3
        AND platform = $4
        AND idempotency_key = $5
      RETURNING platform_post_id`,
    [args.platformPostId, existing.postId, args.tenantId, platform, idempotencyKey],
  );
  return repaired.rows?.[0]?.platform_post_id ?? args.platformPostId;
}

async function reconcileExistingPublishedPost(
  args: PersistPublishedPostArgs,
  existing: { postId: string; platformPostId: string | null },
  db: Pool,
): Promise<{ postId: string }> {
  const platformPostId = await repairExistingPlatformPostIdFirstWriteWins(args, existing, db);
  await stampPublishedPostAttributionBestEffort(
    args,
    existing.postId,
    db,
    platformPostId,
  );
  return { postId: existing.postId };
}

export async function persistPublishedPost(
  args: PersistPublishedPostArgs,
  db: Pool,
): Promise<{ postId: string }> {
  // Short-circuit via idempotency key before attempting insert (avoids constraint violation noise)
  if (args.idempotencyKey && args.platform) {
    const existing = await findPostByIdempotencyKey(
      { tenantId: args.tenantId, platform: args.platform, idempotencyKey: args.idempotencyKey },
      db,
    );
    if (existing) {
      return reconcileExistingPublishedPost(args, existing, db);
    }
  }

  // Normalize creative-asset ids: drop blanks/dupes so the column is either a
  // clean set of ids or an empty array (column default). An empty array is a
  // valid text[] literal and keeps resolveMediaUrls on its job-scoped fallback.
  const creativeAssetIds = Array.from(
    new Set(
      (args.creativeAssetIds ?? [])
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );

  let insertResult;
  try {
    insertResult = await db.query<{ id: string | number }>(
      `INSERT INTO posts (tenant_id, job_id, caption, platform_post_id, published_at, published_status, platform, idempotency_key, creative_asset_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        args.tenantId,
        args.jobId ?? null,
        args.caption,
        args.platformPostId,
        args.publishedAt.toISOString(),
        args.publishedStatus,
        args.platform ?? null,
        args.idempotencyKey ?? null,
        creativeAssetIds,
      ],
    );
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '23505') {
      throw error;
    }
    if (args.idempotencyKey && args.platform) {
      const existing = await findPostByIdempotencyKey(
        { tenantId: args.tenantId, platform: args.platform, idempotencyKey: args.idempotencyKey },
        db,
      );
      if (existing) {
        return reconcileExistingPublishedPost(args, existing, db);
      }
    }
    throw new Error('publish_verification_persist_failed:unique_violation_winner_not_found');
  }

  const row = insertResult.rows?.[0];
  if (!row?.id) {
    // Race: another concurrent insert won. Re-query to return the existing row.
    if (args.idempotencyKey && args.platform) {
      const existing = await findPostByIdempotencyKey(
        { tenantId: args.tenantId, platform: args.platform, idempotencyKey: args.idempotencyKey },
        db,
      );
      if (existing) {
        return reconcileExistingPublishedPost(args, existing, db);
      }
    }
    throw new Error('publish_verification_persist_failed:no_id_returned');
  }
  const postId = String(row.id);
  await stampPublishedPostAttributionBestEffort(args, postId, db);
  return { postId };
}

export async function updatePostPublishedStatus(
  postId: string,
  publishedStatus: PublishedStatus,
  db: Pool,
): Promise<void> {
  await db.query(
    `UPDATE posts SET published_status = $1, updated_at = now() WHERE id = $2`,
    [publishedStatus, postId],
  );
}

export type PublishVerificationDispatchArgs = {
  tenantId: string;
  provider: string;
  caption: string;
  primaryOutput: unknown;
  pool: Pool;
  fetchImpl?: typeof fetch;
  pageTokenLookup?: (tenantId: string, provider: string) => Promise<string | null>;
  /** Stable idempotency key for the posts row. Prevents duplicate DB rows on retry. */
  idempotencyKey?: string | null;
  /** Marketing job ID for correlating posts back to marketing jobs. */
  jobId?: string | null;
  /**
   * Creative-asset ids of the image(s) published with this post, persisted to
   * `posts.creative_asset_ids` so the scheduled-dispatch resolver scopes media
   * per-post instead of falling back to job-scope. See PersistPublishedPostArgs.
   */
  creativeAssetIds?: string[] | null;
};

export type PublishVerificationResult = {
  status: PublishVerificationStatus;
  platformPostId: string | null;
  postId: string | null;
  reason: PublishVerificationReason | null;
  /** ISO timestamp used when persisting a `posts` row (for Honcho idempotency keys). */
  publishedAt: string | null;
};

async function defaultPageTokenLookup(tenantId: string, provider: string): Promise<string | null> {
  const oauthProvider = provider === 'meta' ? 'facebook' : provider;
  const handle = await getDecryptedAccessTokenForTenantProvider(tenantId, oauthProvider);
  return handle?.accessToken ?? null;
}

export async function runPublishVerification(
  args: PublishVerificationDispatchArgs,
): Promise<PublishVerificationResult> {
  const platformPostId = extractPlatformPostId(args.primaryOutput);
  if (!platformPostId) {
    return { status: 'skipped', platformPostId: null, postId: null, reason: null, publishedAt: null };
  }

  if (!META_PROVIDERS.has(args.provider)) {
    return { status: 'skipped', platformPostId, postId: null, reason: null, publishedAt: null };
  }

  const tenantIdNum = Number.parseInt(args.tenantId, 10);
  if (!Number.isFinite(tenantIdNum) || tenantIdNum < 1) {
    return { status: 'skipped', platformPostId, postId: null, reason: null, publishedAt: null };
  }

  const lookup = args.pageTokenLookup ?? defaultPageTokenLookup;
  const pageToken = await lookup(args.tenantId, args.provider);

  const publishedAt = new Date();

  const normalizedPlatform = args.provider === 'meta' ? 'facebook' : args.provider;

  if (!pageToken) {
    const persisted = await persistPublishedPost(
      {
        tenantId: tenantIdNum,
        jobId: args.jobId ?? null,
        caption: args.caption,
        platformPostId,
        publishedAt,
        publishedStatus: 'unverified',
        platform: normalizedPlatform,
        idempotencyKey: args.idempotencyKey ?? null,
        creativeAssetIds: args.creativeAssetIds ?? null,
      },
      args.pool,
    );
    return {
      status: 'unverified',
      platformPostId,
      postId: persisted.postId,
      reason: 'page_token_unavailable',
      publishedAt: publishedAt.toISOString(),
    };
  }

  const persisted = await persistPublishedPost(
    {
      tenantId: tenantIdNum,
      jobId: args.jobId ?? null,
      caption: args.caption,
      platformPostId,
      publishedAt,
      publishedStatus: 'unverified',
      platform: normalizedPlatform,
      idempotencyKey: args.idempotencyKey ?? null,
      creativeAssetIds: args.creativeAssetIds ?? null,
    },
    args.pool,
  );

  const verification = await verifyMetaPostExists({
    platformPostId,
    pageToken,
    fetchImpl: args.fetchImpl,
  });

  if (verification.verified) {
    await updatePostPublishedStatus(persisted.postId, 'published', args.pool);
    return {
      status: 'published',
      platformPostId,
      postId: persisted.postId,
      reason: null,
      publishedAt: publishedAt.toISOString(),
    };
  }

  return {
    status: 'unverified',
    platformPostId,
    postId: persisted.postId,
    reason: verification.reason,
    publishedAt: publishedAt.toISOString(),
  };
}
