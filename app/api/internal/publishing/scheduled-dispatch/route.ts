import { verifyInternalCallbackRequest } from '@/lib/internal-callback-auth';
import {
  isMetaProvider,
  MetaPublishError,
  classifyMetaPublishFailureKind,
  type MetaPublishFailureKind,
} from '@/backend/integrations/meta-publishing';
import { dispatchPublish } from '@/backend/integrations/publish-dispatch';
import { isLinkedInEnabled, isRedditEnabled, isXEnabled, isYouTubeEnabled } from '@/backend/integrations/providers/integration-config';
import { toSignedPublicUrl } from '@/app/api/publish/dispatch/handler';
import { resolveSignableBasename } from '@/backend/marketing/signable-basename';
import { recomputeAndPersistPendingApprovalCount } from '@/backend/marketing/runtime-views';
import pool from '@/lib/db';

type ScheduledDispatchBody = {
  tenant_id?: string;
  post_id?: string;
  platforms?: string[];
  content?: string;
  media_urls?: string[];
  surface?: string;
  media_type?: string;
  width_px?: number | null;
  height_px?: number | null;
  duration_seconds?: number | null;
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
// tenant and not the whole job. A weekly job fans out into ~7 posts; scoping
// only by the post's job_id returns every image the job generated for any one
// of its posts. The per-POST link is `posts.creative_asset_ids`, a text[] of
// the asset ids that belong to that one post.
//
// `posts.creative_asset_ids` entries may be either `creative_assets.id`
// (a uuid, stored as text) or the Hermes-side `creative_assets.source_asset_id`
// ('img_1', 'img_2', ...) — the per-post ordinal from the production contract.
// The join matches either form so the populated path is correct regardless of
// which id producers write.
//
// CRITICAL: the source_asset_id ('img_N') ordinal is NOT unique — EVERY job
// reuses img_1, img_2, ... So the ordinal branch MUST be scoped to the post's
// own job (`ca.source_job_id = p.job_id`); without it, an ordinal-form post
// matches the same-ordinal asset of every other job for the tenant, and
// resolveMediaUrls returns several cross-campaign images → Instagram publishes
// a wrong multi-image CAROUSEL (createInstagramContainer treats >1 url as a
// carousel). The uuid branch (`ca.id`) is globally unique, so it stays unscoped.
// synthesize-publish-posts.ts writes the ordinal form by default, so this is the
// common path, not an edge case.
//
// `posts.creative_asset_ids` is populated by the publish/synthesize writers
// (synthesize-publish-posts.ts, publish-verification.ts, the fb/ig publish
// handlers) and backfilled for pre-existing rows by
// scripts/backfill-creative-asset-ids.mjs. The populated per-post join is the
// primary path.
//
// Fallback (D2): when `creative_asset_ids` is empty — a legacy row predating
// those writers, or a multi-asset legacy row the backfill left untouched — fall
// back to the job-scoped join on `posts.job_id = creative_assets.source_job_id`.
// Kept as a safety net for genuinely-empty rows; it fires only when no per-post
// ids are recorded.
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
     FROM posts p
     JOIN creative_assets ca
       ON ca.tenant_id = p.tenant_id
      AND ca.storage_kind IN ('runtime_asset', 'ingested_asset', 'external_url')
      AND ca.orphaned_at IS NULL
      AND (
        -- Per-POST link: the asset id is listed in posts.creative_asset_ids,
        -- matched against either the uuid id (globally unique) or the Hermes
        -- source_asset_id ordinal (job-scoped — 'img_N' repeats across jobs).
        (
          p.creative_asset_ids IS NOT NULL
          AND array_length(p.creative_asset_ids, 1) > 0
          AND (ca.id::text = ANY(p.creative_asset_ids)
               OR (ca.source_asset_id = ANY(p.creative_asset_ids)
                   AND ca.source_job_id = p.job_id))
        )
        -- Fallback: no per-post ids recorded — scope to the post's job.
        OR (
          (p.creative_asset_ids IS NULL OR array_length(p.creative_asset_ids, 1) IS NULL)
          AND p.job_id IS NOT NULL
          AND ca.source_job_id = p.job_id
        )
      )
     WHERE p.id = $1
       AND p.tenant_id = $2
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

// Roll a set of per-platform dispatch outcomes up into the single
// posts.published_status. A cross-post dispatches to several platforms
// independently; the parent posts row must NOT be demoted to 'failed'
// because one platform failed while another went live.
//   - 'published' — at least one platform was dispatched.
//   - 'failed'    — every platform failed AND no failure is retryable
//     (every failure is terminal), so no later worker pass will change it.
//   - null        — leave posts.published_status untouched: either there
//     were no platforms, or a retryable failure remains and the worker's
//     next pass can still drive the post to a terminal state.
export type PostStatusDecision = 'published' | 'failed' | null;

export function planPostStatusUpdate(
  results: ReadonlyArray<{ ok: boolean; retryable?: boolean }>,
): PostStatusDecision {
  if (results.length === 0) return null;
  if (results.some((r) => r.ok)) return 'published';
  const anyRetryable = results.some((r) => !r.ok && r.retryable);
  return anyRetryable ? null : 'failed';
}

// Derive the per-platform `retryable` flag from a caught publish error.
//   - A MetaPublishError carries its own retryable flag (outcome-unknown video
//     timeouts, auth, etc.).
//   - Any other error that EXPLICITLY carries `retryable === false` (the
//     IntegrationError family: a permanent Composio broker verdict such as a
//     Reddit SUBREDDIT_NOEXIST, or a capability/guard error) is honored as
//     terminal, so it self-terminates instead of the worker re-claiming and
//     re-failing it every tick.
//   - Everything else (a raw network throw, an unrecognized error) DEFAULTS TO
//     RETRYABLE (fail-safe): only an explicit `false` buries a failure.
export function deriveDispatchRetryable(error: unknown): boolean {
  if (error instanceof MetaPublishError) return error.retryable;
  if (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === false
  ) {
    return false;
  }
  return true;
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

  // Publish shape forwarded by the worker. 'feed'/'reel'/'story' map to the
  // MetaPlacement axis; image/video select the media branch. Default feed/image
  // for legacy worker rows that don't forward the fields.
  const surfaceRaw = typeof body.surface === 'string' ? body.surface.trim().toLowerCase() : '';
  const surface: 'feed' | 'story' | 'reel' =
    surfaceRaw === 'story' || surfaceRaw === 'reel' ? surfaceRaw : 'feed';
  const mediaType: 'image' | 'video' =
    typeof body.media_type === 'string' && body.media_type.trim().toLowerCase() === 'video'
      ? 'video'
      : 'image';

  // Per-media dimensions/duration forwarded from scheduled_posts (populated by a
  // later ingest/synthesize step; NULL today). Build mediaMetadata ONLY for a
  // video surface with all three present — never fabricate (the validator fails
  // closed on missing video metadata, which is the intended behavior).
  const widthPx = typeof body.width_px === 'number' && Number.isFinite(body.width_px) ? body.width_px : null;
  const heightPx = typeof body.height_px === 'number' && Number.isFinite(body.height_px) ? body.height_px : null;
  const durationSeconds = typeof body.duration_seconds === 'number' && Number.isFinite(body.duration_seconds) ? body.duration_seconds : null;
  const mediaMetadata: Array<{ widthPx: number; heightPx: number; durationSeconds: number }> | undefined =
    mediaType === 'video' && widthPx !== null && heightPx !== null && durationSeconds !== null
      ? [{ widthPx, heightPx, durationSeconds }]
      : undefined;

  // Prefer explicit media_urls, otherwise look up creative assets for the tenant
  let rawMediaUrls: string[] = Array.isArray(body.media_urls)
    ? body.media_urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : [];

  if (rawMediaUrls.length === 0 && postId) {
    rawMediaUrls = await resolveMediaUrls(postId, tenantId);
  }

  // Sign media URLs so Meta Graph API can fetch them. Resolve id-addressed
  // internal URLs to their on-disk basename before signing (Option A);
  // sequential — one PK lookup per URL, no Promise.all fan-out (guardrail #1).
  const signedMediaUrls: string[] = [];
  for (const url of rawMediaUrls) {
    const basename = await resolveSignableBasename(url, tenantId);
    if (!basename) {
      signedMediaUrls.push(url);
      continue;
    }
    signedMediaUrls.push(toSignedPublicUrl(url, tenantId, basename));
  }

  // Each platform is attempted independently and its outcome recorded, so a
  // cross-post that succeeds on one platform and fails on another reports the
  // truth per platform. The worker maps `retryable` onto per-platform child
  // rows; a non-retryable failure is terminal, a retryable one is re-claimed
  // on a later pass.
  //
  // KNOWN double-publish window (F5b): there is a narrow crash window between
  // Meta committing a post and this route recording the platform's outcome.
  // If the process dies after publishToMetaGraph's Graph POST succeeds but
  // before the worker's post-publish transaction writes the 'dispatched'
  // child row, the stale-in_flight reclaim re-dispatches that platform and
  // Meta gets a second, duplicate post.
  //
  // This is NOT closed with a Graph-side idempotency key: the Meta Graph
  // publishing endpoints (/feed, /media_publish) accept no idempotency or
  // dedupe parameter — there is nothing to thread. posts.idempotency_key and
  // its unique index are a DB-side dedupe on the post-hoc verification INSERT
  // (publish-verification.ts), not a Graph-call guard. Forcing a key through
  // publishToMetaGraph would be dead weight Meta ignores. The window is left
  // open deliberately; closing it would need a Meta-side dedupe primitive
  // that does not exist, or a pre-publish reservation handshake that is out
  // of scope here. The reclaim window (10 min) bounds exposure; a duplicate
  // is rare (requires a crash inside that sub-second gap).
  const results: Array<{
    provider: string;
    ok: boolean;
    error?: string;
    retryable?: boolean;
    // Informational failure taxonomy so the worker can surface *why* a terminal
    // row failed (e.g. an expired token → reconnect). Does NOT change the retry
    // policy — `retryable` alone drives pending-vs-failed.
    kind?: MetaPublishFailureKind;
  }> = [];

  // Tracks the platform_post_id of the first platform that went live, so the
  // aggregate posts write below can record one. Per-platform truth lives in
  // scheduled_post_dispatches; posts.published_status is only an OR-rollup.
  let firstPublishedPostId: string | null = null;

  for (const platform of platforms) {
    // X (Twitter), Reddit, LinkedIn and YouTube are Composio-only publish targets
    // (no direct-Meta path), so none is an `isMetaProvider`; accept each only when
    // its rollout flag is on. OFF (default) keeps the exact `unsupported_provider`
    // terminal result as before.
    const isXPublish = platform.trim().toLowerCase() === 'x' && isXEnabled();
    const isRedditPublish = platform.trim().toLowerCase() === 'reddit' && isRedditEnabled();
    const isLinkedInPublish = platform.trim().toLowerCase() === 'linkedin' && isLinkedInEnabled();
    const isYouTubePublish = platform.trim().toLowerCase() === 'youtube' && isYouTubeEnabled();
    if (!isMetaProvider(platform) && !isXPublish && !isRedditPublish && !isLinkedInPublish && !isYouTubePublish) {
      // Unsupported provider can never succeed — terminal, not retryable.
      results.push({ provider: platform, ok: false, error: 'unsupported_provider', retryable: false, kind: 'permanent' });
      continue;
    }
    try {
      const published = await dispatchPublish({
        tenantId,
        provider: platform,
        content,
        mediaUrls: signedMediaUrls,
        placement: surface,
        mediaType,
        mediaMetadata,
      });
      results.push({ provider: platform, ok: true });
      if (firstPublishedPostId === null && published.platformPostId) {
        firstPublishedPostId = published.platformPostId;
      }
    } catch (error) {
      const errMsg = error instanceof MetaPublishError
        ? `${error.code}: ${error.message}`
        : String((error as Error).message || error);
      const retryable = deriveDispatchRetryable(error);
      // Derive the failure taxonomy for surfacing only. A raw non-Meta throw is
      // 'permanent' per the classifier, but the route still treats it as
      // retryable above (network blips re-claim) — the two are independent.
      const kind = classifyMetaPublishFailureKind(error);
      results.push({ provider: platform, ok: false, error: errMsg, retryable, kind });
      // Do NOT abort the loop: a later platform may still succeed, and the
      // worker needs every platform's outcome to write per-platform state.
      // Do NOT write posts.published_status here — a per-platform write would
      // clobber a sibling platform's 'published' (FB succeeds, IG fails on the
      // same cross-post). The single OR-rollup write happens after the loop.
    }
  }

  const anyOk = results.some((r) => r.ok);
  const anyRetryable = results.some((r) => !r.ok && r.retryable);

  // Roll the per-platform outcomes up into one posts.published_status write.
  const postStatus = planPostStatusUpdate(results);
  let dispatchedJobId: string | null = null;
  if (postId && postStatus === 'published') {
    const updated = await pool
      .query<{ job_id: string | null }>(
        `UPDATE posts
       SET published_status = 'published',
           platform_post_id = COALESCE($2, platform_post_id),
           published_at = COALESCE(published_at, now())
       WHERE id = $1 AND tenant_id = $3
       RETURNING job_id`,
        [postId, firstPublishedPostId, tenantId],
      )
      .catch(() => null);
    dispatchedJobId = updated?.rows?.[0]?.job_id ?? null;
  } else if (postId && postStatus === 'failed') {
    const updated = await pool
      .query<{ job_id: string | null }>(
        `UPDATE posts SET published_status = 'failed' WHERE id = $1 AND tenant_id = $2 RETURNING job_id`,
        [postId, tenantId],
      )
      .catch(() => null);
    dispatchedJobId = updated?.rows?.[0]?.job_id ?? null;
  }
  // A publish flips posts.published_status, which feeds the campaign-list
  // dashboard's published/scheduled/live counts (via countPublishedPostsForJob).
  // Refresh the denormalized dashboard_list_projection (+ pending count) so the
  // campaign list reflects the publish without re-hydrating every job on read.
  // Non-fatal: a recompute failure must never fail the dispatch response.
  if (dispatchedJobId) {
    await recomputeAndPersistPendingApprovalCount(dispatchedJobId).catch(() => {});
  }
  // 202 when at least one platform was dispatched; 502 when every platform
  // failed and at least one is retryable; 422 when all failures are terminal.
  const status = anyOk ? 202 : anyRetryable ? 502 : 422;

  return new Response(JSON.stringify({ status: anyOk ? 'ok' : 'error', results }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
