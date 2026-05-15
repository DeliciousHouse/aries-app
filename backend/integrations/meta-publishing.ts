import type { Pool } from 'pg';

import pool from '@/lib/db';
import { getDecryptedAccessTokenContextForTenantProvider } from './oauth-credentials';

const META_GRAPH_HOST = 'https://graph.facebook.com';
const META_PROVIDERS = new Set(['meta', 'facebook', 'instagram']);

export type SupportedMetaProvider = 'facebook' | 'instagram';

export type MetaPublishRequest = {
  tenantId: string;
  provider: string;
  content: string;
  mediaUrls: string[];
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

  constructor(code: string, message: string, options?: { status?: number; retryable?: boolean }) {
    super(message);
    this.name = 'MetaPublishError';
    this.code = code;
    this.status = options?.status ?? 400;
    this.retryable = options?.retryable ?? false;
  }
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

function requireStringField(record: Record<string, unknown>, key: string, code: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MetaPublishError(code, `Meta response missing required field: ${key}`, { status: 502 });
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

async function publishFacebook(args: {
  target: MetaPublishTarget;
  content: string;
  mediaUrls: string[];
  scheduledFor: string | null;
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<MetaPublishSuccess> {
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

  const published = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/feed`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: postParams,
  });

  return {
    provider: 'facebook',
    mode: args.scheduledFor ? 'scheduled' : 'live',
    platformPostId: requireStringField(published, 'id', 'facebook_publish_missing_id'),
    scheduledFor: args.scheduledFor,
    connectionId: args.target.connectionId,
  };
}

async function createInstagramContainer(args: {
  target: MetaPublishTarget;
  caption: string;
  mediaUrls: string[];
  fetchImpl: typeof fetch;
  safePrePublishAttempts: number;
}): Promise<string> {
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

async function publishInstagram(args: {
  target: MetaPublishTarget;
  content: string;
  mediaUrls: string[];
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
    fetchImpl: args.fetchImpl,
    safePrePublishAttempts: args.safePrePublishAttempts,
  });

  const published = await requestGraphJson({
    pathname: `${encodeURIComponent(args.target.externalAccountId)}/media_publish`,
    accessToken: args.target.accessToken,
    fetchImpl: args.fetchImpl,
    params: { creation_id: creationId },
  });

  return {
    provider: 'instagram',
    mode: 'live',
    platformPostId: requireStringField(published, 'id', 'instagram_publish_missing_id'),
    scheduledFor: null,
    connectionId: args.target.connectionId,
  };
}

export async function publishToMetaGraph(request: MetaPublishRequest): Promise<MetaPublishSuccess> {
  const provider = normalizeMetaProvider(request.provider);
  const content = request.content.trim();
  const mediaUrls = normalizeMediaUrls(request.mediaUrls);
  const scheduledFor = normalizeScheduledFor(request.scheduledFor ?? null);
  requireContentOrMedia(content, mediaUrls);

  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const target = await resolveMetaPublishTarget(request.tenantId, provider);
  const safePrePublishAttempts = Math.min(Math.max(request.safePrePublishAttempts ?? 1, 1), 5);

  if (provider === 'facebook') {
    return publishFacebook({ target, content, mediaUrls, scheduledFor, fetchImpl, safePrePublishAttempts });
  }
  return publishInstagram({ target, content, mediaUrls, scheduledFor, fetchImpl, safePrePublishAttempts });
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
    `INSERT INTO posts (tenant_id, content, platform_post_id, scheduled_at, published_status)
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
