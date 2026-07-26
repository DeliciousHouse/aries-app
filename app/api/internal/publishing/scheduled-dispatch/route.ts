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
import { stampInsightsPostAttribution } from '@/backend/insights/sync/attribution-writer';
import pool from '@/lib/db';

type ScheduledDispatchBody = {
  tenant_id?: string;
  post_id?: string;
  scheduled_post_id?: string;
  dispatch_attempt_token?: string;
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

type DispatchTransactionClient = DispatchQueryable & { release?: () => void };
type DispatchDatabase = DispatchQueryable & {
  connect?: () => Promise<DispatchTransactionClient>;
};

async function withDispatchTransaction<T>(
  db: DispatchDatabase,
  run: (client: DispatchTransactionClient) => Promise<T>,
): Promise<T> {
  let ownsClient = false;
  let client: DispatchTransactionClient;
  if (typeof db.connect === 'function') {
    client = await db.connect();
    ownsClient = true;
  } else {
    client = db;
  }
  try {
    await client.query('BEGIN', []);
    const result = await run(client);
    await client.query('COMMIT', []);
    return result;
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release?.();
  }
}

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
  mediaType: 'image' | 'video' = 'image',
): Promise<string[]> {
  // Media-type scoping (2026-07-13 incident follow-up): a VIDEO post must only
  // resolve video assets, and an image post must never pick up a video. The
  // legacy unscoped fallback join handed a reel post every asset its job
  // produced — a reel then failed `single_media_required ... received 2` (or
  // worse, resolved a feed IMAGE as its only media) and retried every worker
  // tick until campaign end.
  const mediaTypeClause =
    mediaType === 'video'
      ? `AND ca.media_type = 'video'`
      : `AND ca.media_type IS DISTINCT FROM 'video'`;
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
      ${mediaTypeClause}
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

// ---------------------------------------------------------------------------
// Unattended-publish guards (2026-07-13 duplicate-post incident).
//
// The scheduled-dispatch route is the LAST unattended chokepoint before a
// post reaches a platform, so structural duplicate-protection lives here:
//
//   1. Duplicate-caption block (terminal): another post with the identical
//      trimmed caption already published to the same tenant+platform inside
//      the window → this dispatch can only create a visible duplicate; fail
//      it permanently. Window: ARIES_DUPLICATE_CAPTION_WINDOW_DAYS (default
//      14; 0 disables). Captions shorter than MIN_GUARDED_CAPTION_LENGTH are
//      exempt (too generic to treat as identity).
//
//   2. Same-platform spacing defer (retryable): the tenant published to this
//      platform less than ARIES_SAME_PLATFORM_MIN_SPACING_MINUTES ago
//      (default 30; 0 disables) → defer, the worker re-claims later. This
//      makes an N-posts-at-one-instant burst structurally impossible at the
//      publish boundary regardless of upstream scheduling bugs, and keeps
//      Meta's spam heuristics (FB error 368) from tripping.
//
// Both guards are FAIL-OPEN: any query error logs and admits the publish —
// a guard outage must never stop legitimate delivery. Manual "Publish now"
// uses a different route and is intentionally not guarded (human intent).

const MIN_GUARDED_CAPTION_LENGTH = 20;

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  return Number.parseInt(trimmed, 10);
}

export function duplicateCaptionWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.ARIES_DUPLICATE_CAPTION_WINDOW_DAYS, 14);
}

export function samePlatformSpacingMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.ARIES_SAME_PLATFORM_MIN_SPACING_MINUTES, 30);
}

export type PublishGuardVerdict = { blocked: 'duplicate' | 'spacing'; detail: string };

/**
 * Resolve the per-platform guard verdicts for one dispatch request. Returns a
 * map keyed by lowercase platform name; platforms absent from the map are
 * admitted. Duplicate beats spacing. Fail-open on any DB error.
 */
export async function resolvePublishGuards(args: {
  db: DispatchQueryable;
  tenantId: string;
  postId: string;
  platforms: string[];
  content: string;
  /**
   * Publish surface of the dispatching post. The duplicate-caption guard is
   * surface-scoped: the image-story promotion DELIBERATELY reuses the feed
   * post's caption verbatim on the same platform (surface='story'), so a
   * platform-wide caption match would terminally block every promoted story
   * as a "duplicate" of its own feed sibling. A feed post only duplicates a
   * prior feed post, a story a prior story, etc.
   */
  surface: 'feed' | 'story' | 'reel';
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<Map<string, PublishGuardVerdict>> {
  const verdicts = new Map<string, PublishGuardVerdict>();
  const platformKeys = [...new Set(args.platforms.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (platformKeys.length === 0) return verdicts;
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;

  const dupWindowDays = duplicateCaptionWindowDays(env);
  const caption = args.content.trim();
  if (dupWindowDays > 0 && caption.length >= MIN_GUARDED_CAPTION_LENGTH) {
    try {
      const dup = await args.db.query<{ platform: string }>(
        `SELECT DISTINCT platform FROM posts
          WHERE tenant_id = $1
            AND platform = ANY($2)
            AND id::text <> $3
            AND published_status = 'published'
            AND published_at > now() - make_interval(days => $4::int)
            AND btrim(caption) = $5
            AND surface = $6`,
        [args.tenantId, platformKeys, args.postId, dupWindowDays, caption, args.surface],
      );
      for (const row of dup.rows) {
        verdicts.set(String(row.platform).toLowerCase(), {
          blocked: 'duplicate',
          detail: `identical caption already published to ${row.platform} within ${dupWindowDays}d`,
        });
      }
    } catch (err) {
      console.warn('[scheduled-dispatch] duplicate-caption guard failed — admitting (fail-open)', {
        postId: args.postId,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  const spacingMinutes = samePlatformSpacingMinutes(env);
  if (spacingMinutes > 0) {
    try {
      const recent = await args.db.query<{ platform: string; last_published: string | Date | null }>(
        `SELECT platform, max(published_at) AS last_published FROM posts
          WHERE tenant_id = $1
            AND platform = ANY($2)
            AND id::text <> $3
            AND published_at IS NOT NULL
          GROUP BY platform`,
        [args.tenantId, platformKeys, args.postId],
      );
      for (const row of recent.rows) {
        const key = String(row.platform).toLowerCase();
        if (verdicts.has(key)) continue; // duplicate verdict wins
        const last = row.last_published ? new Date(row.last_published) : null;
        if (!last || !Number.isFinite(last.getTime())) continue;
        const ageMs = now.getTime() - last.getTime();
        if (ageMs >= 0 && ageMs < spacingMinutes * 60 * 1000) {
          const waitMinutes = Math.ceil((spacingMinutes * 60 * 1000 - ageMs) / 60000);
          verdicts.set(key, {
            blocked: 'spacing',
            detail: `last ${row.platform} publish ${Math.floor(ageMs / 60000)}m ago; spacing ${spacingMinutes}m — retry in ~${waitMinutes}m`,
          });
        }
      }
    } catch (err) {
      console.warn('[scheduled-dispatch] spacing guard failed — admitting (fail-open)', {
        postId: args.postId,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  return verdicts;
}

// Roll a set of per-platform dispatch outcomes up into the single
// posts.published_status. A cross-post dispatches to several platforms
// independently; the parent posts row must NOT be demoted to 'failed'
// because one platform failed while another went live.
//   - 'published' — at least one platform was dispatched.
//   - 'unverified'— at least one provider submission may already be live.
//   - 'failed'    — every platform failed AND no failure is retryable
//     (every failure is terminal), so no later worker pass will change it.
//   - null        — leave posts.published_status untouched: either there
//     were no platforms, or a retryable failure remains and the worker's
//     next pass can still drive the post to a terminal state.
export type PostStatusDecision = 'published' | 'failed' | 'unverified' | null;

export function planPostStatusUpdate(
  results: ReadonlyArray<{ ok: boolean; retryable?: boolean; kind?: string }>,
): PostStatusDecision {
  if (results.length === 0) return null;
  if (results.some((r) => r.ok)) return 'published';
  if (results.some((r) => r.kind === 'outcome_unknown')) return 'unverified';
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
//   - Everything else defaults to retryable for legacy direct callers. The
//     route's provider loop uses classifyScheduledDispatchFailure below, which
//     is stricter once provider submission may have started.
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

/**
 * Fail-closed provider outcome matrix for the route/worker contract. An
 * unclassified throw after dispatchPublish starts may conceal an accepted
 * submission, so only an adapter's explicit retryability proof can rearm it.
 */
export function classifyScheduledDispatchFailure(error: unknown): {
  kind: MetaPublishFailureKind;
  retryable: boolean;
} {
  if (error instanceof MetaPublishError) {
    const kind = classifyMetaPublishFailureKind(error);
    return { kind, retryable: kind === 'outcome_unknown' ? false : error.retryable };
  }

  const explicitRetryable =
    typeof error === 'object' && error !== null && 'retryable' in error
      ? (error as { retryable?: unknown }).retryable
      : undefined;
  if (explicitRetryable === true) return { kind: 'transient', retryable: true };
  if (explicitRetryable === false) return { kind: 'permanent', retryable: false };
  return { kind: 'outcome_unknown', retryable: false };
}

export type ScheduledDispatchResult = {
  provider: string;
  ok: boolean;
  platformPostId?: string;
  error?: string;
  retryable?: boolean;
  // Failure taxonomy is part of the safety contract: outcome_unknown always
  // quarantines even if a buggy adapter also reports retryable=true.
  kind?: MetaPublishFailureKind;
};

export function buildScheduledDispatchSuccessResult(
  provider: string,
  platformPostId: string,
): ScheduledDispatchResult {
  return {
    provider,
    ok: true,
    ...(platformPostId ? { platformPostId } : {}),
  };
}

export function firstSuccessfulPlatformPostId(results: ScheduledDispatchResult[]): string | null {
  return results.find((result) => result.ok && result.platformPostId)?.platformPostId ?? null;
}

export async function isScheduledDispatchAttemptOwned(args: {
  db: DispatchQueryable;
  tenantId: string;
  postId: string;
  scheduledPostId: string;
  attemptToken: string;
}): Promise<boolean> {
  const result = await args.db.query(
    `SELECT 1 AS owned
       FROM scheduled_posts
      WHERE id = $1::bigint
        AND post_id = $2::bigint
        AND tenant_id = $3::int
        AND dispatch_status = 'in_flight'
        AND dispatch_attempt_token = $4
      LIMIT 1`,
    [args.scheduledPostId, args.postId, args.tenantId, args.attemptToken],
  );
  return (result.rowCount ?? result.rows.length) === 1;
}

/**
 * Fence provider I/O for one immutable worker claim. The parent row is the
 * serialization point: only the first request for a live attempt token stamps
 * dispatch_started_at and may cross the provider boundary.
 */
export async function claimScheduledDispatchProviderSubmission(args: {
  db: DispatchDatabase;
  tenantId: string;
  postId: string;
  scheduledPostId: string;
  attemptToken: string;
}): Promise<{ owned: boolean; claimed: boolean }> {
  return withDispatchTransaction(args.db, async (client) => {
    const owner = await client.query<{
      dispatch_status: string;
      dispatch_attempt_token: string | null;
      dispatch_started_at: string | null;
    }>(
      `SELECT dispatch_status, dispatch_attempt_token, dispatch_started_at
         FROM scheduled_posts
        WHERE id = $1::bigint
          AND post_id = $2::bigint
          AND tenant_id = $3::int
        FOR UPDATE`,
      [args.scheduledPostId, args.postId, args.tenantId],
    );
    const row = owner.rows[0];
    if (
      !row
      || row.dispatch_status !== 'in_flight'
      || row.dispatch_attempt_token !== args.attemptToken
    ) {
      return { owned: false, claimed: false };
    }
    if (row.dispatch_started_at !== null) {
      return { owned: true, claimed: false };
    }

    const claimed = await client.query(
      `UPDATE scheduled_posts
          SET dispatch_started_at = clock_timestamp()
        WHERE id = $1::bigint
          AND dispatch_status = 'in_flight'
          AND dispatch_attempt_token = $2
          AND dispatch_started_at IS NULL
        RETURNING dispatch_started_at`,
      [args.scheduledPostId, args.attemptToken],
    );
    return {
      owned: true,
      claimed: (claimed.rowCount ?? claimed.rows.length) === 1,
    };
  });
}

export async function finalizeScheduledDispatchAttempt(args: {
  db: DispatchDatabase;
  tenantId: string;
  postId: string;
  scheduledPostId: string;
  attemptToken: string;
  postStatus: PostStatusDecision;
  results: ScheduledDispatchResult[];
}): Promise<{ owned: boolean; jobId: string | null }> {
  if (args.postStatus === null) return { owned: true, jobId: null };

  const firstPublishedPostId = firstSuccessfulPlatformPostId(args.results);
  return withDispatchTransaction(args.db, async (client) => {
    // Canonical parent first, then scheduled owner: schedule/delete/finalize all
    // use this order, preventing deadlocks and eliminating a delete/finalize gap.
    const canonicalPost = await client.query(
      `SELECT id
         FROM posts
        WHERE id = $1::bigint
          AND tenant_id = $2::int
        FOR UPDATE`,
      [args.postId, args.tenantId],
    );
    if ((canonicalPost.rowCount ?? canonicalPost.rows.length) !== 1) {
      return { owned: false, jobId: null };
    }

    // A stale finalizer that waits behind a reclaim observes the replacement
    // token before touching canonical state or Insights attribution.
    const owner = await client.query<{
      dispatch_status: string;
      dispatch_attempt_token: string | null;
    }>(
      `SELECT dispatch_status, dispatch_attempt_token
         FROM scheduled_posts
        WHERE id = $1::bigint
          AND post_id = $2::bigint
          AND tenant_id = $3::int
        FOR UPDATE`,
      [args.scheduledPostId, args.postId, args.tenantId],
    );
    const ownerRow = owner.rows[0];
    if (
      !ownerRow
      || ownerRow.dispatch_status !== 'in_flight'
      || ownerRow.dispatch_attempt_token !== args.attemptToken
    ) {
      return { owned: false, jobId: null };
    }

    // Published is monotonic. A later sibling/provider finalizer must not erase
    // either a canonical success or durable dispatched child evidence.
    const updated = await client.query<{ job_id: string | null }>(
      `UPDATE posts
          SET published_status = CASE
                WHEN posts.published_status = 'published'
                  OR $3 = 'published'
                  OR EXISTS (
                    SELECT 1
                      FROM scheduled_post_dispatches dispatch
                     WHERE dispatch.scheduled_post_id = $5::bigint
                       AND dispatch.status = 'dispatched'
                  )
                  THEN 'published'
                  ELSE $3
                  END,
              platform_post_id = COALESCE(platform_post_id, $2),
              published_at = CASE
                  WHEN posts.published_status = 'published'
                    OR $3 = 'published'
                  OR EXISTS (
                    SELECT 1
                      FROM scheduled_post_dispatches dispatch
                     WHERE dispatch.scheduled_post_id = $5::bigint
                       AND dispatch.status = 'dispatched'
                  )
                THEN COALESCE(published_at, now())
                ELSE published_at
              END
        WHERE id = $1
          AND tenant_id = $4
        RETURNING job_id`,
      [args.postId, firstPublishedPostId, args.postStatus, args.tenantId, args.scheduledPostId],
    );

    const owned = (updated.rowCount ?? updated.rows.length) === 1;
    if (!owned) return { owned: false, jobId: null };

    if (args.postStatus === 'published') {
      for (const result of args.results) {
        if (!result.ok || !result.platformPostId) continue;
        await stampInsightsPostAttribution({
          db: client,
          tenantId: args.tenantId,
          ariesPostId: args.postId,
          platform: result.provider,
          platformPostId: result.platformPostId,
        });
      }
    }

    return { owned: true, jobId: updated.rows[0]?.job_id ?? null };
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
  const scheduledPostId = typeof body.scheduled_post_id === 'string' ? body.scheduled_post_id.trim() : '';
  const attemptToken = typeof body.dispatch_attempt_token === 'string' ? body.dispatch_attempt_token.trim() : '';

  if (postId && (!/^\d+$/.test(scheduledPostId) || !attemptToken)) {
    return new Response(JSON.stringify({ error: 'missing_dispatch_attempt' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (postId) {
    let providerClaim: { owned: boolean; claimed: boolean };
    try {
      providerClaim = await claimScheduledDispatchProviderSubmission({
        db: pool,
        tenantId,
        postId,
        scheduledPostId,
        attemptToken,
      });
    } catch {
      return new Response(JSON.stringify({ error: 'dispatch_ownership_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!providerClaim.owned) {
      return new Response(JSON.stringify({
        status: 'stale_attempt',
        results: platforms.map((provider) => ({
          provider,
          ok: false,
          error: 'stale_dispatch_attempt',
          retryable: true,
        })),
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!providerClaim.claimed) {
      return new Response(JSON.stringify({
        status: 'attempt_already_started',
        results: platforms.map((provider) => ({
          provider,
          ok: false,
          error: 'dispatch_attempt_already_started',
          retryable: false,
          kind: 'outcome_unknown' as MetaPublishFailureKind,
        })),
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

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
    rawMediaUrls = await resolveMediaUrls(postId, tenantId, pool, mediaType);
  }

  // A video post with no video asset can never publish — fail it terminally
  // NOW instead of letting the media validator reject it retryably on every
  // worker tick until campaign end (last week's reel spent days retrying at
  // 60s cadence). Image posts keep the legacy behavior (FB text-only posts
  // are legitimate with zero media).
  if (mediaType === 'video' && rawMediaUrls.length === 0) {
    const results = platforms.map((platform) => ({
      provider: platform,
      ok: false,
      error: 'no_video_asset: video post has no ingested video creative to publish',
      retryable: false,
      kind: 'permanent' as MetaPublishFailureKind,
    }));
    return new Response(JSON.stringify({ status: 'error', results }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
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
  // The provider fence above is durable before this loop starts. If the route
  // or worker dies after a provider accepts but before outcome persistence,
  // the stale row is parked for manual reconciliation rather than republished.
  // Preserve each provider's confirmed id in the response so the worker can
  // commit it to the matching scheduled_post_dispatches child row.
  const results: ScheduledDispatchResult[] = [];

  // Unattended-publish guards (duplicate caption + same-platform spacing).
  // Resolved once per request; fail-open (empty map) on any error.
  const publishGuards = postId
    ? await resolvePublishGuards({ db: pool, tenantId, postId, platforms, content, surface })
    : new Map<string, PublishGuardVerdict>();

  for (const platform of platforms) {
    const guard = publishGuards.get(platform.trim().toLowerCase());
    if (guard?.blocked === 'duplicate') {
      // A confirmed duplicate can never become correct by retrying — terminal.
      results.push({
        provider: platform,
        ok: false,
        error: `duplicate_content_blocked: ${guard.detail}`,
        retryable: false,
        kind: 'permanent',
      });
      continue;
    }
    if (guard?.blocked === 'spacing') {
      // Not a failure — just too soon after the previous publish. Retryable so
      // the worker re-claims the row once the spacing window has passed.
      results.push({
        provider: platform,
        ok: false,
        error: `same_platform_spacing_deferred: ${guard.detail}`,
        retryable: true,
      });
      continue;
    }
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
      results.push(buildScheduledDispatchSuccessResult(platform, published.platformPostId));
    } catch (error) {
      const errMsg = error instanceof MetaPublishError
        ? `${error.code}: ${error.message}`
        : String((error as Error).message || error);
      const classification = classifyScheduledDispatchFailure(error);
      results.push({
        provider: platform,
        ok: false,
        error: errMsg,
        retryable: classification.retryable,
        kind: classification.kind,
      });
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
  // Preserve the legacy aggregate mirror: posts.platform_post_id records only
  // the first successful provider id; per-platform truth lives in child rows.
  let dispatchedJobId: string | null = null;
  if (postId) {
    try {
      const finalized = await finalizeScheduledDispatchAttempt({
        db: pool,
        tenantId,
        postId,
        scheduledPostId,
        attemptToken,
        postStatus,
        results,
      });
      if (!finalized.owned) {
        const reconciliationResults: ScheduledDispatchResult[] = results.map((result) => ({
          provider: result.provider,
          ok: false,
          error: 'canonical_finalization_lost_attempt_ownership',
          retryable: false,
          kind: 'outcome_unknown',
        }));
        return new Response(JSON.stringify({
          status: 'finalization_failed',
          results: reconciliationResults,
        }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      dispatchedJobId = finalized.jobId;
    } catch (finalizationError) {
      console.error('[scheduled-dispatch] canonical finalization failed', finalizationError);
      // Provider success is external fact even when our canonical/Insights
      // transaction rolls back. Preserve each confirmed provider outcome so
      // the owning worker can durably record the successful child and provider
      // id, then reconcile canonical published truth without another provider
      // POST. Rewriting a known success to outcome_unknown discards the only
      // duplicate-prevention evidence available after this response.
      const finalizationMessage = finalizationError instanceof Error
        ? finalizationError.message
        : String(finalizationError);
      return new Response(JSON.stringify({
        status: 'finalization_failed',
        error: `canonical_finalization_failed:${finalizationMessage}`,
        results,
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
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
