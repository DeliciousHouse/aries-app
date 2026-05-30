import type { Pool } from 'pg';

import pool from '@/lib/db';
import { getDecryptedAccessTokenContextForTenantProvider } from './oauth-credentials';
import { validateMediaForSurface, type MediaMetadata } from './meta-media-validation';

const META_GRAPH_HOST = 'https://graph.facebook.com';
const META_PROVIDERS = new Set(['meta', 'facebook', 'instagram']);

export type SupportedMetaProvider = 'facebook' | 'instagram';

/**
 * Where a post lands. 'feed' is the default permanent post (photo/feed on FB,
 * a FEED media container on IG). 'story' is the 24h ephemeral format: FB
 * /{page}/photo_stories and IG media_type=STORIES. Stories are single-media
 * and cannot be natively scheduled, so the story branch rejects multi-media
 * and scheduledFor. Image stories only — video stories need video upload,
 * which this path does not implement.
 */
export type MetaPlacement = 'feed' | 'story' | 'reel';
export type MetaMediaType = 'image' | 'video';

export function normalizeMetaPlacement(value: string | null | undefined): MetaPlacement {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'story' || v === 'reel' ? v : 'feed';
}

export function normalizeMetaMediaType(value: string | null | undefined): MetaMediaType {
  return typeof value === 'string' && value.trim().toLowerCase() === 'video' ? 'video' : 'image';
}

export type MetaPublishRequest = {
  tenantId: string;
  provider: string;
  content: string;
  mediaUrls: string[];
  placement?: MetaPlacement;
  /** image (default) or video. Selects the VIDEO/REELS/STORIES media branches. */
  mediaType?: MetaMediaType;
  /**
   * Optional per-media width/height/duration from Hermes. When provided for a
   * video surface, `validateMediaForSurface` enforces Meta's aspect/duration
   * constraints fail-closed; when absent for a video surface, validation rejects
   * (never assumes). Indexed positionally against `mediaUrls`.
   */
  mediaMetadata?: Array<{ widthPx?: number | null; heightPx?: number | null; durationSeconds?: number | null }>;
  scheduledFor?: string | null;
  fetchImpl?: typeof fetch;
  db?: Pool;
  safePrePublishAttempts?: number;
};

export type MetaPublishSuccess = {
  provider: SupportedMetaProvider;
  mode: 'live' | 'scheduled';
  platformPostId: string;
  scheduledFor: string | null;
  connectionId: string;
};

export type PersistPublishRecordResult = {
  postId: string;
  publishedStatus: 'scheduled' | 'published' | 'unverified';
};

export class MetaPublishError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  /**
   * True when the Meta Graph API accepted the final publish call (2xx) but Aries
   * could not confirm the resulting post id. The post MAY be live — the outcome
   * is unknown. Callers must NOT roll back the platform claim and must NOT
   * auto-retry: a retry of a publish that secretly succeeded is a duplicate post.
   * False (the default) means the failure happened before/instead of a confirmed
   * publish acceptance — the post definitely never went live and is safe to retry.
   */
  readonly outcomeUnknown: boolean;

  constructor(
    code: string,
    message: string,
    options?: { status?: number; retryable?: boolean; outcomeUnknown?: boolean },
  ) {
    super(message);
    this.name = 'MetaPublishError';
    this.code = code;
    this.status = options?.status ?? 400;
    this.retryable = options?.retryable ?? false;
    this.outcomeUnknown = options?.outcomeUnknown ?? false;
  }
}

/**
 * The two outcome classes a Meta publish failure can fall into. The publish
 * handlers must treat them oppositely:
 *
 *   'definitely_never_posted' — a requestGraphJson network/HTTP/4xx failure (or
 *   any pre-publish failure). The Graph publish call never succeeded, so the
 *   post never went live. Safe to roll back the platform claim and retry.
 *
 *   'outcome_unknown' — the Graph publish call was accepted (2xx) but Aries got
 *   no post id back. The post MAY be live. The claim must be LEFT in place,
 *   surfaced as needs_manual_reconciliation, and NEVER auto-retried — a retry of
 *   a publish that secretly succeeded is a duplicate post.
 */
export type MetaPublishFailureClass = 'definitely_never_posted' | 'outcome_unknown';

/**
 * Classify a thrown publish error into one of the two outcome classes. Only a
 * MetaPublishError carrying `outcomeUnknown` is treated as outcome-unknown;
 * every other error (including non-MetaPublishError throws) is treated as
 * definitely-never-posted, which is the safe-to-retry default.
 */
export function classifyMetaPublishFailure(error: unknown): MetaPublishFailureClass {
  if (error instanceof MetaPublishError && error.outcomeUnknown) {
    return 'outcome_unknown';
  }
  return 'definitely_never_posted';
}

/**
 * The Meta publish codes that mean "the tenant's Meta connection is broken and
 * must be reconnected" — distinct from a malformed request (permanent) or a
 * transient gateway hiccup (transient). Surfaced to operators as a
 * reconnect-your-account signal rather than an opaque "publish failed".
 */
const META_AUTH_FAILURE_CODES: ReadonlySet<string> = new Set([
  'oauth_token_missing',
  'external_account_missing',
]);

/**
 * The full failure taxonomy, derived (not stored) from a MetaPublishError's
 * existing fields. Distinct from the 2-class `MetaPublishFailureClass` above,
 * which only encodes the publish-acceptance axis:
 *
 *   'outcome_unknown' — the publish call was accepted (2xx) but no post id was
 *   confirmed. NEVER auto-retry (a retry of a publish that secretly succeeded is
 *   a duplicate). Wins over every other kind. Mirrors `outcomeUnknown`.
 *
 *   'auth' — the tenant's Meta connection is missing/expired. Terminal like any
 *   other `retryable:false` failure, but operator-actionable: reconnect the
 *   account. Does NOT change the retry policy beyond what `retryable:false`
 *   already does.
 *
 *   'transient' — a network/5xx/rate-limit/container-timeout failure flagged
 *   `retryable`. Safe for the worker to re-claim on a later pass.
 *
 *   'permanent' — a malformed request, unsupported operation, or any other
 *   non-retryable failure (including non-MetaPublishError throws). Terminal.
 */
export type MetaPublishFailureKind = 'transient' | 'permanent' | 'auth' | 'outcome_unknown';

/**
 * Classify a thrown publish error into the 4-class taxonomy. Precedence:
 * outcome-unknown (never retry) → auth (reconnect) → transient (retryable) →
 * permanent (terminal). A non-MetaPublishError throw is treated as permanent
 * here; the dispatch route independently treats raw non-Meta throws as
 * retryable at the call site — that route behavior is unchanged by this fn.
 */
export function classifyMetaPublishFailureKind(error: unknown): MetaPublishFailureKind {
  if (error instanceof MetaPublishError && error.outcomeUnknown) {
    return 'outcome_unknown';
  }
  if (error instanceof MetaPublishError && META_AUTH_FAILURE_CODES.has(error.code)) {
    return 'auth';
  }
  if (error instanceof MetaPublishError && error.retryable) {
    return 'transient';
  }
  return 'permanent';
}

type MetaGraphResponse = Record<string, unknown>;

type MetaPublishTarget = {
  provider: SupportedMetaProvider;
  accessToken: string;
  connectionId: string;
  externalAccountId: string;
};

function metaGraphVersion(): string {
  const raw = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
  return raw.startsWith('v') ? raw : `v${raw}`;
}

export function isMetaProvider(provider: string): boolean {
  return META_PROVIDERS.has(provider.trim().toLowerCase());
}

export function normalizeMetaProvider(provider: string): SupportedMetaProvider {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'meta' || normalized === 'facebook') return 'facebook';
  if (normalized === 'instagram') return 'instagram';
  throw new MetaPublishError('unsupported_provider', `Unsupported publish provider: ${provider}`, { status: 400 });
}

function normalizeScheduledFor(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    throw new MetaPublishError('invalid_scheduled_for', '`scheduled_for` must be an ISO 8601 timestamp.', { status: 400 });
  }
  return candidate.toISOString();
}

function normalizeMediaUrls(value: string[]): string[] {
  return value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function requireContentOrMedia(content: string, mediaUrls: string[]): void {
  if (content.trim().length === 0 && mediaUrls.length === 0) {
    throw new MetaPublishError('missing_content', 'Either `content` or `media_urls` is required.', { status: 400 });
  }
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  code: string,
  options?: { outcomeUnknown?: boolean },
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MetaPublishError(code, `Meta response missing required field: ${key}`, {
      status: 502,
      outcomeUnknown: options?.outcomeUnknown ?? false,
    });
  }
  return value.trim();
}

async function resolveMetaPublishTarget(tenantId: string, provider: SupportedMetaProvider): Promise<MetaPublishTarget> {
  const handle = await getDecryptedAccessTokenContextForTenantProvider(tenantId, provider);
  if (!handle?.accessToken) {
    throw new MetaPublishError('oauth_token_missing', `No connected ${provider} publish token is available for this tenant.`, { status: 409 });
  }
  if (!handle.externalAccountId) {
    throw new MetaPublishError('external_account_missing', `No connected ${provider} account id is available for this tenant.`, { status: 409 });
  }
  return {
    provider,
    accessToken: handle.accessToken,
    connectionId: handle.connectionId,
    externalAccountId: handle.externalAccountId,
  };
}

async function parseGraphResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function graphEndpoint(pathname: string): string {
  return `${META_GRAPH_HOST}/${metaGraphVersion()}/${pathname.replace(/^\/+/, '')}`;
}

const MAX_429_RETRIES = 5;
const RETRY_AFTER_CAP_S = 60;

function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  // HTTP-date format
  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime())) {
    const deltaMs = asDate.getTime() - Date.now();
    return Math.max(0, Math.min(Math.ceil(deltaMs / 1000), RETRY_AFTER_CAP_S));
  }
  // Seconds format
  const asSeconds = Number.parseFloat(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(Math.ceil(asSeconds), RETRY_AFTER_CAP_S);
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestGraphJson(args: {
  pathname: string;
  params?: Record<string, string>;
  accessToken: string;
  fetchImpl: typeof fetch;
  method?: 'GET' | 'POST';
}): Promise<MetaGraphResponse> {
  const method = args.method ?? 'POST';
  const url = new URL(graphEndpoint(args.pathname));
  const params = new URLSearchParams();
  params.set('access_token', args.accessToken);
  for (const [key, value] of Object.entries(args.params ?? {})) params.set(key, value);

  let lastError: MetaPublishError | null = null;

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
    let response: Response;
    try {
      if (method === 'GET') {
        url.search = params.toString();
        response = await args.fetchImpl(url, { method: 'GET' });
      } else {
        response = await args.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
      }
    } catch (error) {
      throw new MetaPublishError('graph_network_error', String((error as Error).message || error), { status: 502, retryable: true });
    }

    const parsed = await parseGraphResponse(response);
    if (response.ok) return parsed;

    const graphError = parsed.error as Record<string, unknown> | undefined;
    const message = typeof graphError?.message === 'string' && graphError.message.trim().length > 0
      ? graphError.message.trim()
      : `Meta Graph API request failed with status ${response.status}`;

    // Handle 429 with Retry-After backoff (bounded retry budget)
    if (response.status === 429) {
      lastError = new MetaPublishError('graph_rate_limited', message, { status: 429, retryable: true });
      if (attempt < MAX_429_RETRIES) {
        const retryAfterS = parseRetryAfterSeconds(response.headers);
        const backoffMs = retryAfterS !== null
          ? retryAfterS * 1000
          : Math.min(1000 * (2 ** attempt), RETRY_AFTER_CAP_S * 1000);
        await sleep(backoffMs);
        continue;
      }
      // Exceeded retry budget
      throw lastError;
    }

    throw new MetaPublishError('graph_api_error', message, {
      status: response.status >= 400 && response.status < 600 ? response.status : 502,
      retryable: response.status >= 500,
    });
  }

  // Should not reach here, but satisfy TypeScript
  throw lastError ?? new MetaPublishError('graph_api_error', 'Unknown error after retry loop', { status: 502 });
}

async function withSafePrePublishRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  const maxAttempts = Math.min(Math.max(attempts, 1), 5);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!(error instanceof MetaPublishError) || !error.retryable || attempt >= maxAttempts) throw error;
    }
  }
  throw lastError;
}

async function publishFacebookVideo(args: {
  target: MetaPublishTarget;
  content: string;
  mediaUrls: string[];
  scheduledFor: string | null;
  fetchImpl: typeof fetch;
}): Promise<MetaPublishSuccess> {
  // FB feed video via the non-resumable file_url form: Hermes provides a public
  // asset_url, so POST /{page}/videos?file_url=... is a single call. (Resumable
  // start/transfer/finish is reserved for an oversize fallback not in scope
  // here.) scheduled_publish_time is honored for feed video (FB allows it).
  const params: Record<string, string> = { file_url: args.mediaUrls[0] };
  if (args.content.trim().length > 0) params.description = args.content.trim();
  if (args.scheduledFor) {
    params.published = 'false';
    params.scheduled_publish_time = String(Math.floor(new Date(args.scheduledFor).getTime() / 1000));
  }

  // One-shot create. /videos has no idempotency key, so a 2xx with no id is
  // outcome-unknown (the video MAY be live), never auto-retried.
  const published = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/videos`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params,
  });

  return {
    provider: 'facebook',
    mode: args.scheduledFor ? 'scheduled' : 'live',
    platformPostId: requireStringField(published, 'id', 'facebook_video_publish_missing_id', { outcomeUnknown: true }),
    scheduledFor: args.scheduledFor,
    connectionId: args.target.connectionId,
  };
}

async function publishFacebookVideoStory(args: {
  target: MetaPublishTarget;
  mediaUrls: string[];
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<MetaPublishSuccess> {
  // Step 1: start an upload session. With a public file_url the finish phase can
  // run directly; start is safe to retry (no story exists yet) and yields the
  // resumable handle (video_id).
  const started = await withSafePrePublishRetry(() => requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/video_stories`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: { upload_phase: 'start' },
  }), args.safePrePublishAttempts);
  const videoId = requireStringField(started, 'video_id', 'facebook_video_story_start_missing_id');

  // Step 2: finish — one-shot, never auto-retried. video_id is the resumable
  // handle: a resume re-issues finish (idempotent on an already-finished video)
  // rather than re-uploading. A 2xx with no post id is outcome-unknown.
  const finished = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/video_stories`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: { upload_phase: 'finish', video_id: videoId, video_url: args.mediaUrls[0] },
  });
  const storyPostId =
    typeof finished.post_id === 'string' && finished.post_id.trim().length > 0
      ? finished.post_id.trim()
      : typeof finished.id === 'string' && finished.id.trim().length > 0
        ? finished.id.trim()
        // video_stories finish returns { success: true } with no post id on many
        // accounts — treat a successful finish as outcome-unknown (the story MAY
        // be live) keyed on the video_id rather than failing the publish.
        : (() => {
            if (finished.success === true || finished.success === 'true') return videoId;
            return requireStringField(finished, 'post_id', 'facebook_video_story_finish_missing_id', { outcomeUnknown: true });
          })();

  return {
    provider: 'facebook',
    mode: 'live',
    platformPostId: storyPostId,
    scheduledFor: null,
    connectionId: args.target.connectionId,
  };
}

async function publishFacebookPhotoStory(args: {
  target: MetaPublishTarget;
  mediaUrls: string[];
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<MetaPublishSuccess> {
  // Step 1: upload the single photo unpublished to get a photo id (safe to
  // retry — no story exists yet).
  const upload = await withSafePrePublishRetry(() => requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/photos`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: { url: args.mediaUrls[0], published: 'false' },
  }), args.safePrePublishAttempts);
  const photoId = requireStringField(upload, 'id', 'facebook_story_photo_upload_missing_id');

  // Step 2: publish it as a story. One-shot — /photo_stories has no idempotency
  // key, so this must never be auto-retried. A 2xx with no post id means the
  // outcome is unconfirmed (outcomeUnknown), not "definitely never posted".
  const published = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/photo_stories`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: { photo_id: photoId },
  });
  // FB photo_stories returns { success, post_id }; tolerate `id` as a fallback.
  const storyPostId =
    typeof published.post_id === 'string' && published.post_id.trim().length > 0
      ? published.post_id.trim()
      : requireStringField(published, 'id', 'facebook_story_publish_missing_id', { outcomeUnknown: true });

  return {
    provider: 'facebook',
    mode: 'live',
    platformPostId: storyPostId,
    scheduledFor: null,
    connectionId: args.target.connectionId,
  };
}

async function publishFacebook(args: {
  target: MetaPublishTarget;
  content: string;
  mediaUrls: string[];
  placement: MetaPlacement;
  mediaType: MetaMediaType;
  mediaMetadata: MediaMetadata[];
  scheduledFor: string | null;
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<MetaPublishSuccess> {
  // Fail-closed media validation before any Graph call (video aspect/duration,
  // single-media for stories/reels). Reels are an IG-only surface — reject here.
  if (args.placement === 'reel') {
    throw new MetaPublishError('facebook_reel_not_supported', 'Reels are an Instagram-only surface in this Aries path.', { status: 400 });
  }
  validateMediaForSurface({
    media: args.mediaMetadata,
    surface: args.placement,
    mediaType: args.mediaType,
    scheduledFor: args.scheduledFor,
  });

  if (args.mediaType === 'video') {
    if (args.placement === 'story') {
      return publishFacebookVideoStory({
        target: args.target,
        mediaUrls: args.mediaUrls,
        fetchImpl: args.fetchImpl,
        safePrePublishAttempts: args.safePrePublishAttempts,
      });
    }
    return publishFacebookVideo({
      target: args.target,
      content: args.content,
      mediaUrls: args.mediaUrls,
      scheduledFor: args.scheduledFor,
      fetchImpl: args.fetchImpl,
    });
  }

  if (args.placement === 'story') {
    return publishFacebookPhotoStory({
      target: args.target,
      mediaUrls: args.mediaUrls,
      fetchImpl: args.fetchImpl,
      safePrePublishAttempts: args.safePrePublishAttempts,
    });
  }

  const attachedMediaIds: string[] = [];
  for (const mediaUrl of args.mediaUrls) {
    const upload = await withSafePrePublishRetry(() => requestGraphJson({
      pathname: `${encodeURIComponent(args.target.externalAccountId)}/photos`,
      accessToken: args.target.accessToken,
      fetchImpl: args.fetchImpl,
      params: { url: mediaUrl, published: 'false' },
    }), args.safePrePublishAttempts);
    attachedMediaIds.push(requireStringField(upload, 'id', 'facebook_media_upload_missing_id'));
  }

  const postParams: Record<string, string> = {};
  if (args.content.trim().length > 0) postParams.message = args.content.trim();
  attachedMediaIds.forEach((id, index) => {
    postParams[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
  });
  if (args.scheduledFor) {
    postParams.published = 'false';
    postParams.scheduled_publish_time = String(Math.floor(new Date(args.scheduledFor).getTime() / 1000));
  }

  // Final publish call — one-shot. The Graph feed API has no idempotency key,
  // so this must never be auto-retried. A 2xx response with no post id means
  // the outcome is unconfirmed (outcomeUnknown), not "definitely never posted".
  const published = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/feed`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: postParams,
  });

  return {
    provider: 'facebook',
    mode: args.scheduledFor ? 'scheduled' : 'live',
    platformPostId: requireStringField(published, 'id', 'facebook_publish_missing_id', { outcomeUnknown: true }),
    scheduledFor: args.scheduledFor,
    connectionId: args.target.connectionId,
  };
}

async function createInstagramContainer(args: {
  target: MetaPublishTarget;
  caption: string;
  mediaUrls: string[];
  placement: MetaPlacement;
  mediaType: MetaMediaType;
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<string> {
  if (args.mediaType === 'video') {
    // Video container: feed -> media_type=VIDEO, reel -> REELS, story -> STORIES.
    // All carry video_url (never image_url). Caption is sent for feed/reel; IG
    // ignores captions on stories so it is omitted there.
    const igMediaType = args.placement === 'reel' ? 'REELS' : args.placement === 'story' ? 'STORIES' : 'VIDEO';
    const params: Record<string, string> = {
      video_url: args.mediaUrls[0],
      media_type: igMediaType,
    };
    if (args.placement !== 'story' && args.caption.trim().length > 0) {
      params.caption = args.caption.trim();
    }
    const created = await withSafePrePublishRetry(() => requestGraphJson({
      pathname: `${encodeURIComponent(args.target.externalAccountId)}/media`,
      accessToken: args.target.accessToken,
      fetchImpl: args.fetchImpl,
      params,
    }), args.safePrePublishAttempts);
    return requireStringField(created, 'id', 'instagram_video_container_missing_id');
  }
  if (args.placement === 'story') {
    // IG image story: a single STORIES-typed container. Stories ignore the
    // feed caption, so it is intentionally not sent.
    const created = await withSafePrePublishRetry(() => requestGraphJson({
      pathname: `${encodeURIComponent(args.target.externalAccountId)}/media`,
      accessToken: args.target.accessToken,
      fetchImpl: args.fetchImpl,
      params: { image_url: args.mediaUrls[0], media_type: 'STORIES' },
    }), args.safePrePublishAttempts);
    return requireStringField(created, 'id', 'instagram_story_container_missing_id');
  }
  if (args.mediaUrls.length === 1) {
    const created = await withSafePrePublishRetry(() => requestGraphJson({
      pathname: `${encodeURIComponent(args.target.externalAccountId)}/media`,
      accessToken: args.target.accessToken,
      fetchImpl: args.fetchImpl,
      params: {
        image_url: args.mediaUrls[0],
        ...(args.caption.trim().length > 0 ? { caption: args.caption.trim() } : {}),
      },
    }), args.safePrePublishAttempts);
    return requireStringField(created, 'id', 'instagram_container_missing_id');
  }

  const childIds: string[] = [];
  for (const mediaUrl of args.mediaUrls) {
    const child = await withSafePrePublishRetry(() => requestGraphJson({
      pathname: `${encodeURIComponent(args.target.externalAccountId)}/media`,
      accessToken: args.target.accessToken,
      fetchImpl: args.fetchImpl,
      params: { image_url: mediaUrl, is_carousel_item: 'true' },
    }), args.safePrePublishAttempts);
    childIds.push(requireStringField(child, 'id', 'instagram_carousel_child_missing_id'));
  }

  const parent = await withSafePrePublishRetry(() => requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/media`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      ...(args.caption.trim().length > 0 ? { caption: args.caption.trim() } : {}),
    },
  }), args.safePrePublishAttempts);
  return requireStringField(parent, 'id', 'instagram_carousel_missing_id');
}

const CONTAINER_POLL_BACKOFF_MS = [2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
const CONTAINER_POLL_MAX_ATTEMPTS = 15;

// Video containers transcode materially slower than image containers (often
// well past the ~60s image budget). Poll up to ~5min at 5s steps for video,
// while images keep the existing tight budget.
const VIDEO_CONTAINER_POLL_MAX_ATTEMPTS = 60;
const VIDEO_CONTAINER_POLL_BACKOFF_MS = 5000;

export async function waitForInstagramContainerReady(args: {
  target: MetaPublishTarget;
  creationId: string;
  fetchImpl: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** 'video' uses the extended ~5min poll budget; 'image' (default) the ~60s budget. */
  mediaType?: MetaMediaType;
}): Promise<void> {
  const sleepFn = args.sleepImpl ?? sleep;
  const isVideo = args.mediaType === 'video';
  const maxAttempts = isVideo ? VIDEO_CONTAINER_POLL_MAX_ATTEMPTS : CONTAINER_POLL_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await requestGraphJson({
      pathname: args.creationId,
      params: { fields: 'status_code' },
      accessToken: args.target.accessToken,
      fetchImpl: args.fetchImpl,
      method: 'GET',
    });
    const statusCode = typeof result.status_code === 'string' ? result.status_code : '';
    if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') return;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new MetaPublishError(
        'instagram_container_failed',
        `Instagram media container reached terminal failure state: ${statusCode}`,
        { status: 422, retryable: false },
      );
    }
    // IN_PROGRESS or unexpected — wait and poll again
    const backoffMs = isVideo
      ? VIDEO_CONTAINER_POLL_BACKOFF_MS
      : (CONTAINER_POLL_BACKOFF_MS[attempt] ?? 5000);
    await sleepFn(backoffMs);
  }
  throw new MetaPublishError(
    'instagram_container_timeout',
    isVideo
      ? 'Instagram video media container did not reach FINISHED within the video poll budget'
      : 'Instagram media container did not reach FINISHED within 60s',
    { status: 504, retryable: true },
  );
}

async function publishInstagram(args: {
  target: MetaPublishTarget;
  content: string;
  mediaUrls: string[];
  placement: MetaPlacement;
  mediaType: MetaMediaType;
  mediaMetadata: MediaMetadata[];
  scheduledFor: string | null;
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<MetaPublishSuccess> {
  if (args.mediaUrls.length === 0) {
    throw new MetaPublishError('instagram_media_required', 'Instagram publishing requires at least one public image URL.', { status: 400 });
  }
  if (args.scheduledFor) {
    throw new MetaPublishError('instagram_scheduled_publish_not_supported', 'Instagram scheduled publishing is not enabled in this Aries path yet; keep approval intact and publish Instagram live after review.', { status: 409 });
  }

  // Fail-closed media validation before any Graph call. For video surfaces this
  // enforces aspect/duration/single-media from Hermes metadata; for image it is
  // a light single-media check on stories (the heavy story guards live in
  // publishToMetaGraph).
  validateMediaForSurface({
    media: args.mediaMetadata,
    surface: args.placement,
    mediaType: args.mediaType,
    scheduledFor: args.scheduledFor,
  });

  const creationId = await createInstagramContainer({
    target: args.target,
    caption: args.content,
    mediaUrls: args.mediaUrls,
    placement: args.placement,
    mediaType: args.mediaType,
    fetchImpl: args.fetchImpl,
    safePrePublishAttempts: args.safePrePublishAttempts,
  });

  await waitForInstagramContainerReady({
    target: args.target,
    creationId,
    fetchImpl: args.fetchImpl,
    mediaType: args.mediaType,
  });

  // Final publish call — one-shot. The Graph media_publish endpoint has no
  // idempotency key, so this must never be auto-retried. A 2xx response with no
  // post id means the outcome is unconfirmed (outcomeUnknown), not "definitely
  // never posted".
  const published = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/media_publish`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: { creation_id: creationId },
  });

  return {
    provider: 'instagram',
    mode: 'live',
    platformPostId: requireStringField(published, 'id', 'instagram_publish_missing_id', { outcomeUnknown: true }),
    scheduledFor: null,
    connectionId: args.target.connectionId,
  };
}

export async function publishToMetaGraph(request: MetaPublishRequest): Promise<MetaPublishSuccess> {
  const provider = normalizeMetaProvider(request.provider);
  const content = request.content.trim();
  const mediaUrls = normalizeMediaUrls(request.mediaUrls);
  const placement = normalizeMetaPlacement(request.placement);
  const mediaType = normalizeMetaMediaType(request.mediaType);
  const scheduledFor = normalizeScheduledFor(request.scheduledFor ?? null);
  requireContentOrMedia(content, mediaUrls);

  // Build positional per-media metadata for the validator. Hermes supplies
  // width/height/duration alongside each asset_url; absent metadata for a video
  // surface is rejected fail-closed inside validateMediaForSurface.
  const mediaMetadata: MediaMetadata[] = mediaUrls.map((url, i) => ({
    url,
    widthPx: request.mediaMetadata?.[i]?.widthPx ?? null,
    heightPx: request.mediaMetadata?.[i]?.heightPx ?? null,
    durationSeconds: request.mediaMetadata?.[i]?.durationSeconds ?? null,
  }));

  if (placement === 'story' || placement === 'reel') {
    // Stories and reels are single-media and cannot be natively scheduled on
    // either platform. Fail closed before any Graph call so a misconfigured
    // entry never silently posts as a feed item.
    if (mediaUrls.length !== 1) {
      throw new MetaPublishError(
        `${placement}_single_media_required`,
        `${placement} placement requires exactly one media item. Carousels and text-only ${placement} posts are not supported.`,
        { status: 400 },
      );
    }
    if (scheduledFor) {
      throw new MetaPublishError(
        `${placement}_scheduled_publish_not_supported`,
        `${placement} placement cannot be natively scheduled; publish live.`,
        { status: 409 },
      );
    }
  }

  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const target = await resolveMetaPublishTarget(request.tenantId, provider);
  const safePrePublishAttempts = Math.min(Math.max(request.safePrePublishAttempts ?? 1, 1), 5);

  if (provider === 'facebook') {
    return publishFacebook({ target, content, mediaUrls, placement, mediaType, mediaMetadata, scheduledFor, fetchImpl, safePrePublishAttempts });
  }
  return publishInstagram({ target, content, mediaUrls, placement, mediaType, mediaMetadata, scheduledFor, fetchImpl, safePrePublishAttempts });
}

export async function persistScheduledPublishRecord(args: {
  tenantId: string;
  content: string;
  platformPostId: string;
  scheduledFor: string;
  db?: Pool;
}): Promise<PersistPublishRecordResult> {
  const tenantIdNum = Number.parseInt(args.tenantId, 10);
  if (!Number.isFinite(tenantIdNum) || tenantIdNum < 1) {
    throw new MetaPublishError('invalid_tenant_id', 'Tenant id must be a positive integer to persist a scheduled publish record.', { status: 400 });
  }

  const db = args.db ?? pool;
  const result = await db.query<{ id: string | number }>(
    `INSERT INTO posts (tenant_id, caption, platform_post_id, scheduled_at, published_status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantIdNum, args.content, args.platformPostId, args.scheduledFor, 'scheduled'],
  );
  const row = result.rows?.[0];
  if (!row?.id) {
    throw new MetaPublishError('scheduled_publish_persist_failed', 'Scheduled publish row was not persisted.', { status: 500 });
  }
  return { postId: String(row.id), publishedStatus: 'scheduled' };
}
