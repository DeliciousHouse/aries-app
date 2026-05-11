import type { Pool } from 'pg';

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
  content: string;
  platformPostId: string;
  publishedAt: Date;
  publishedStatus: PublishedStatus;
};

export async function persistPublishedPost(
  args: PersistPublishedPostArgs,
  db: Pool,
): Promise<{ postId: string }> {
  const insertResult = await db.query<{ id: string | number }>(
    `INSERT INTO posts (tenant_id, content, platform_post_id, published_at, published_status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      args.tenantId,
      args.content,
      args.platformPostId,
      args.publishedAt.toISOString(),
      args.publishedStatus,
    ],
  );

  const row = insertResult.rows?.[0];
  const postId = row?.id;
  if (postId === undefined || postId === null) {
    throw new Error('publish_verification_persist_failed:no_id_returned');
  }
  return { postId: String(postId) };
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
  content: string;
  primaryOutput: unknown;
  pool: Pool;
  fetchImpl?: typeof fetch;
  pageTokenLookup?: (tenantId: string, provider: string) => Promise<string | null>;
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

  if (!pageToken) {
    const persisted = await persistPublishedPost(
      {
        tenantId: tenantIdNum,
        content: args.content,
        platformPostId,
        publishedAt,
        publishedStatus: 'unverified',
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
      content: args.content,
      platformPostId,
      publishedAt,
      publishedStatus: 'unverified',
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
