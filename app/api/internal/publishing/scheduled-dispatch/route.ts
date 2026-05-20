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

// Minimal queryable surface so route tests can inject a fake DB.
export type DispatchQueryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

async function readBody(req: Request): Promise<ScheduledDispatchBody> {
  try {
    return (await req.json()) as ScheduledDispatchBody;
  } catch {
    return {};
  }
}

// Resolve creative assets for the *specific* scheduled post, not just the
// tenant. Assets are linked to a post through the post's job_id matching
// creative_assets.source_job_id; scoping by tenant_id alone published the
// wrong post's images on a tenant with more than one post in flight.
//
// storage_kind values come from the creative_assets CHECK constraint:
//   - 'runtime_asset'  — Aries-generated (ingest-production-assets.ts).
//     storage_key is a host filesystem path (not servable); served_asset_ref
//     is the servable '/api/internal/hermes/media/<basename>' ref.
//   - 'ingested_asset' — operator upload (upload-replace.ts). Same: the
//     servable ref is served_asset_ref when set.
//   - 'external_url'   — the asset already lives at a public URL; storage_key
//     holds that URL and is returned as-is.
//   - 'none'           — no usable media, excluded.
// served_asset_ref is the canonical servable reference used everywhere else
// (workspace-views.ts previewUrl, creative-memory eligibility); rebuilding a
// URL from storage_key — as the old code did — produced a path that pointed
// at the host filesystem, not a fetchable URL.
export async function resolveMediaUrls(
  postId: string,
  tenantId: string,
  db: DispatchQueryable = pool,
): Promise<string[]> {
  const result = await db.query<{
    storage_key: string | null;
    storage_kind: string;
    served_asset_ref: string | null;
  }>(
    `SELECT ca.storage_key, ca.storage_kind, ca.served_asset_ref
     FROM creative_assets ca
     JOIN posts p ON p.job_id = ca.source_job_id AND p.tenant_id = ca.tenant_id
     WHERE p.id = $1
       AND ca.tenant_id = $2
       AND p.job_id IS NOT NULL
       AND ca.storage_kind IN ('runtime_asset', 'ingested_asset', 'external_url')
       AND ca.orphaned_at IS NULL
     ORDER BY ca.id DESC
     LIMIT 4`,
    [postId, tenantId],
  );

  const appBase = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return result.rows
    .map((r) => {
      // An external_url asset already is a fetchable URL.
      if (r.storage_kind === 'external_url') {
        return r.storage_key && r.storage_key.trim() ? r.storage_key.trim() : null;
      }
      // runtime_asset / ingested_asset: serve via the Hermes media route using
      // the relative served_asset_ref. Skip rows with no servable ref rather
      // than guessing a path from the host-side storage_key.
      const ref = r.served_asset_ref?.trim();
      if (!ref) return null;
      if (/^https?:\/\//i.test(ref)) return ref;
      return `${appBase}${ref.startsWith('/') ? '' : '/'}${ref}`;
    })
    .filter((url): url is string => Boolean(url));
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

  // Each platform is attempted independently and its outcome recorded, so a
  // cross-post that succeeds on one platform and fails on another reports the
  // truth per platform. The worker maps `retryable` onto per-platform child
  // rows; a non-retryable failure is terminal, a retryable one is re-claimed
  // on a later pass.
  const results: Array<{
    provider: string;
    ok: boolean;
    error?: string;
    retryable?: boolean;
  }> = [];

  for (const platform of platforms) {
    if (!isMetaProvider(platform)) {
      // Unsupported provider can never succeed — terminal, not retryable.
      results.push({ provider: platform, ok: false, error: 'unsupported_provider', retryable: false });
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
      // A non-Meta error (e.g. a transient network throw) is treated as
      // retryable; a MetaPublishError carries its own retryable flag.
      const retryable = error instanceof MetaPublishError ? error.retryable : true;
      results.push({ provider: platform, ok: false, error: errMsg, retryable });

      if (postId && error instanceof MetaPublishError && !error.retryable) {
        await pool.query(
          `UPDATE posts SET published_status = 'failed' WHERE id = $1 AND tenant_id = $2`,
          [postId, tenantId],
        ).catch(() => {});
      }
      // Do NOT abort the loop: a later platform may still succeed, and the
      // worker needs every platform's outcome to write per-platform state.
    }
  }

  const anyOk = results.some((r) => r.ok);
  const anyRetryable = results.some((r) => !r.ok && r.retryable);
  // 202 when at least one platform was dispatched; 502 when every platform
  // failed and at least one is retryable; 422 when all failures are terminal.
  const status = anyOk ? 202 : anyRetryable ? 502 : 422;

  return new Response(JSON.stringify({ status: anyOk ? 'ok' : 'error', results }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
