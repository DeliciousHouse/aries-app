import type { Pool } from 'pg';

import pool from '@/lib/db';
import { getDecryptedAccessTokenContextForTenantProvider } from './oauth-credentials';

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
export type MetaPlacement = 'feed' | 'story';

export function normalizeMetaPlacement(value: string | null | undefined): MetaPlacement {
  return typeof value === 'string' && value.trim().toLowerCase() === 'story' ? 'story' : 'feed';
}

export type MetaPublishRequest = {
  tenantId: string;
  provider: string;
  content: string;
  mediaUrls: string[];
  placement?: MetaPlacement;
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
  scheduledFor: string | null;
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<MetaPublishSuccess> {
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
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<string> {
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

export async function waitForInstagramContainerReady(args: {
  target: MetaPublishTarget;
  creationId: string;
  fetchImpl: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleepFn = args.sleepImpl ?? sleep;
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt += 1) {
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
    const backoffMs = CONTAINER_POLL_BACKOFF_MS[attempt] ?? 5000;
    await sleepFn(backoffMs);
  }
  throw new MetaPublishError(
    'instagram_container_timeout',
    'Instagram media container did not reach FINISHED within 60s',
    { status: 504, retryable: true },
  );
}

async function publishInstagram(args: {
  target: MetaPublishTarget;
  content: string;
  mediaUrls: string[];
  placement: MetaPlacement;
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

  const creationId = await createInstagramContainer({
    target: args.target,
    caption: args.content,
    mediaUrls: args.mediaUrls,
    placement: args.placement,
    fetchImpl: args.fetchImpl,
    safePrePublishAttempts: args.safePrePublishAttempts,
  });

  await waitForInstagramContainerReady({
    target: args.target,
    creationId,
    fetchImpl: args.fetchImpl,
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
  const scheduledFor = normalizeScheduledFor(request.scheduledFor ?? null);
  requireContentOrMedia(content, mediaUrls);

  if (placement === 'story') {
    // Stories are single-media and cannot be natively scheduled on either
    // platform. Fail closed before any Graph call so a misconfigured story
    // never silently posts as a feed item.
    if (mediaUrls.length !== 1) {
      throw new MetaPublishError(
        'story_single_media_required',
        'Story placement requires exactly one image. Carousels and text-only stories are not supported.',
        { status: 400 },
      );
    }
    if (scheduledFor) {
      throw new MetaPublishError(
        'story_scheduled_publish_not_supported',
        'Stories cannot be natively scheduled; publish a story live.',
        { status: 409 },
      );
    }
  }

  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const target = await resolveMetaPublishTarget(request.tenantId, provider);
  const safePrePublishAttempts = Math.min(Math.max(request.safePrePublishAttempts ?? 1, 1), 5);

  if (provider === 'facebook') {
    return publishFacebook({ target, content, mediaUrls, placement, scheduledFor, fetchImpl, safePrePublishAttempts });
  }
  return publishInstagram({ target, content, mediaUrls, placement, scheduledFor, fetchImpl, safePrePublishAttempts });
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
