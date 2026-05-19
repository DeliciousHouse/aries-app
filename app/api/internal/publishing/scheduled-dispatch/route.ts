import { verifyInternalCallbackRequest } from '@/lib/internal-callback-auth';
import { publishToMetaGraph, isMetaProvider, MetaPublishError } from '@/backend/integrations/meta-publishing';
import { toSignedPublicUrl } from '@/app/api/publish/dispatch/handler';
import pool from '@/lib/db';
import path from 'node:path';

type ScheduledDispatchBody = {
  tenant_id?: string;
  post_id?: string;
  platforms?: string[];
  content?: string;
  media_urls?: string[];
};

async function readBody(req: Request): Promise<ScheduledDispatchBody> {
  try {
    return (await req.json()) as ScheduledDispatchBody;
  } catch {
    return {};
  }
}

async function resolveMediaUrls(postId: string, tenantId: string): Promise<string[]> {
  const result = await pool.query<{ storage_key: string; storage_kind: string }>(
    `SELECT ca.storage_key, ca.storage_kind
     FROM creative_assets ca
     WHERE ca.tenant_id = $1
       AND ca.storage_kind IN ('hermes', 'local', 'url')
       AND ca.storage_key IS NOT NULL
       AND ca.orphaned_at IS NULL
     ORDER BY ca.id DESC
     LIMIT 4`,
    [tenantId],
  );
  // Return internal Hermes media URLs that will be signed below
  return result.rows
    .filter((r) => r.storage_key)
    .map((r) => {
      if (r.storage_kind === 'url') return r.storage_key;
      const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
      return `${appBase}/api/internal/hermes/media/${r.storage_key}`;
    });
}

export async function POST(req: Request): Promise<Response> {
  const authResult = verifyInternalCallbackRequest(req);
  if (!authResult.ok) {
    return new Response(JSON.stringify({ error: authResult.reason }), {
      status: authResult.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body = await readBody(req);
  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : '';
  if (!tenantId) {
    return new Response(JSON.stringify({ error: 'missing_tenant_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const platforms = Array.isArray(body.platforms) ? body.platforms.filter((p) => typeof p === 'string') : [];
  const content = typeof body.content === 'string' ? body.content : '';
  const postId = typeof body.post_id === 'string' ? body.post_id : '';

  // Prefer explicit media_urls, otherwise look up creative assets for the tenant
  let rawMediaUrls: string[] = Array.isArray(body.media_urls)
    ? body.media_urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : [];

  if (rawMediaUrls.length === 0 && postId) {
    rawMediaUrls = await resolveMediaUrls(postId, tenantId);
  }

  // Sign media URLs so Meta Graph API can fetch them
  const signedMediaUrls = rawMediaUrls.map((url) => {
    const basename = path.basename(url);
    if (!basename || basename.includes('..')) return url;
    return toSignedPublicUrl(url, tenantId, basename);
  });

  const results: Array<{ provider: string; ok: boolean; error?: string }> = [];

  for (const platform of platforms) {
    if (!isMetaProvider(platform)) {
      results.push({ provider: platform, ok: false, error: 'unsupported_provider' });
      continue;
    }
    try {
      const published = await publishToMetaGraph({
        tenantId,
        provider: platform,
        content,
        mediaUrls: signedMediaUrls,
      });
      results.push({ provider: platform, ok: true });

      // Update post status to published
      if (postId) {
        await pool.query(
          `UPDATE posts SET published_status = 'published', platform_post_id = $2, published_at = now()
           WHERE id = $1 AND tenant_id = $3`,
          [postId, published.platformPostId, tenantId],
        );
      }
    } catch (error) {
      const errMsg = error instanceof MetaPublishError
        ? `${error.code}: ${error.message}`
        : String((error as Error).message || error);
      results.push({ provider: platform, ok: false, error: errMsg });

      if (postId && error instanceof MetaPublishError && !error.retryable) {
        await pool.query(
          `UPDATE posts SET published_status = 'failed' WHERE id = $1 AND tenant_id = $2`,
          [postId, tenantId],
        ).catch(() => {});
      }

      // Re-throw so the worker can classify the failure as retryable or not
      throw error;
    }
  }

  return new Response(JSON.stringify({ status: 'ok', results }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });
}
