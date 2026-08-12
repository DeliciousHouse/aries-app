/**
 * Single publish chokepoint that routes an organic Facebook/Instagram publish
 * through the active provider seam, while staying byte-identical to the legacy
 * direct-Meta path when that provider is selected.
 *
 * The four live publish dispatch handlers used to call `publishToMetaGraph`
 * directly, which hardwired the direct-Meta path and made `PUBLISH_PROVIDER` /
 * `COMPOSIO_ENABLED` inert for organic publishing. They now call
 * `dispatchPublish`, which:
 *
 *  - when the effective provider is `direct_meta` (the shipped default), calls
 *    `publishToMetaGraph` DIRECTLY — the exact same call the handlers made
 *    before, so behaviour is unchanged until the Composio flags are flipped; and
 *  - otherwise routes through `getPublisherProvider().publishPost(...)` (Composio
 *    or the auto Composio→direct fallback) and maps the normalized
 *    `PublishResult` back into the `MetaPublishSuccess` shape the handlers
 *    already consume, so no downstream handler code changes.
 *
 * The handlers only ever dispatch posts that an Aries approval already cleared,
 * so the seam call passes `approved: true` (the provider's own publish guard).
 */

import {
  MetaPublishError,
  publishToMetaGraph,
  type MetaPublishRequest,
  type MetaPublishSuccess,
} from './meta-publishing';
import {
  effectivePublishProvider,
  getPublisherProvider,
  getPublisherProviderForPlatform,
  isComposioOnlyPublishPlatform,
} from './providers/provider-factory';
import type { PublisherProvider } from './providers/interfaces';
import { isComposioEnabled, type ProviderSelector } from './providers/integration-config';
import type { IntegrationPlatform, PublishResult } from './providers/types';
import { publishNeverReachedPlatform } from './publish-outcome';
import { redactTokenLikeString } from '../social-content/payload';

export function metaPlatform(provider: string): IntegrationPlatform {
  // Map the dispatch request's provider string to the integration platform the
  // provider seam services. X (Twitter), Reddit, LinkedIn and YouTube are each
  // their own Composio-only platform; Instagram maps to instagram; everything
  // else maps to facebook (the direct route's two-way split).
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'x') return 'x';
  if (normalized === 'reddit') return 'reddit';
  if (normalized === 'linkedin') return 'linkedin';
  if (normalized === 'youtube') return 'youtube';
  if (normalized === 'instagram') return 'instagram';
  return 'facebook';
}

/** Cap on the redacted raw-response string written to the missing-id log line. */
export const MISSING_ID_RAW_RESPONSE_MAX_CHARS = 2000;

const REDACTED = '[redacted]';

/**
 * True for object keys whose VALUE must never reach a log line. Matched on
 * word segments (so `accessToken`, `access_token` and `ACCESS-TOKEN` all hit),
 * mirroring the payload sanitizer's rule set.
 */
function sensitiveResponseKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = segments.join('');
  return (
    segments.includes('token') ||
    segments.includes('secret') ||
    segments.includes('password') ||
    segments.includes('auth') ||
    segments.includes('authorization') ||
    segments.includes('oauth') ||
    segments.includes('credential') ||
    segments.includes('credentials') ||
    segments.includes('cookie') ||
    compact === 'apikey' ||
    (segments.includes('api') && segments.includes('key'))
  );
}

function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-capped]';
  if (typeof value === 'string') return redactTokenLikeString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactForLog(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sensitiveResponseKey(key) ? REDACTED : redactForLog(entry, depth + 1);
  }
  return out;
}

/**
 * Render a provider's raw response for a diagnostic log line: secrets stripped,
 * length capped. Never throws — this runs on an already-failing path, and a
 * throw here would replace the caller's outcome-unknown MetaPublishError with an
 * unclassified one (which is exactly the failure mode that duplicates posts).
 *
 * Two-stage redaction, because the raw response is BOTH a third-party API body
 * and, on some brokers, an echo of our own request arguments:
 *  - key-named secrets (`access_token`, `clientSecret`, `authorization`, …) are
 *    dropped wholesale — a Meta Graph body, for example, can legitimately carry
 *    a Page access token alongside the post id; and
 *  - every remaining string is run through the shared `redactTokenLikeString`,
 *    which strips `Bearer …`, `sk-…`, `ya29.…`, `xox?-…`, `gh?_…` and sensitive
 *    URL query parameters, catching tokens that arrive under an innocent key.
 */
export function formatRawResponseForLog(
  raw: unknown,
  maxChars: number = MISSING_ID_RAW_RESPONSE_MAX_CHARS,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(redactForLog(raw)) ?? String(raw);
  } catch {
    return '[unserializable]';
  }
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}…[truncated ${serialized.length - maxChars} chars]`;
}

export interface DispatchPublishDeps {
  /** Resolves the effective provider selector. Defaults to env-based selection. */
  selector?: () => ProviderSelector;
  /** Direct-Meta publish. Defaults to the real `publishToMetaGraph`. */
  directPublish?: (request: MetaPublishRequest) => Promise<MetaPublishSuccess>;
  /** Provider seam factory. Defaults to the platform-aware `getPublisherProviderForPlatform`. */
  publisherProvider?: () => PublisherProvider;
  /** Reports whether Composio is enabled. Defaults to env-based `isComposioEnabled`. */
  composioEnabled?: () => boolean;
}

export async function dispatchPublish(
  request: MetaPublishRequest,
  deps: DispatchPublishDeps = {},
): Promise<MetaPublishSuccess> {
  const selector = deps.selector ?? effectivePublishProvider;
  const directPublish = deps.directPublish ?? publishToMetaGraph;
  const composioEnabled = deps.composioEnabled ?? isComposioEnabled;

  // Resolve the platform early so the routing decision is made in one place.
  const platform = metaPlatform(request.provider);
  const composioOnly = isComposioOnlyPublishPlatform(platform);

  // Composio-only platforms (x, reddit, linkedin, youtube) require Composio to be enabled.
  // Reject with a terminal 400 before any provider is contacted so the handlers
  // classify this as definitely-never-posted (safe to surface, never auto-retry,
  // and the direct-Meta path is NEVER a fallback for these platforms).
  if (composioOnly && !composioEnabled()) {
    throw new MetaPublishError(
      'provider_not_configured',
      `Publishing to ${platform} requires Composio to be enabled (COMPOSIO_ENABLED=true).`,
      { status: 400, retryable: false },
    );
  }

  // Fast path for non-composio-only platforms: the shipped default (direct_meta).
  // FB/IG publishing is byte-identical to the pre-seam call under direct_meta.
  // Composio-only platforms (x, reddit, linkedin, youtube) skip this branch
  // entirely — they never take the direct-Meta path regardless of the global selector.
  if (!composioOnly && selector() === 'direct_meta') {
    return directPublish(request);
  }

  // For composio-only platforms, always use the Composio publisher. For
  // selector-driven platforms that reach here (composio / auto mode), the
  // platform-aware factory delegates to the selector as before.
  const provider = (deps.publisherProvider ?? (() => getPublisherProviderForPlatform(platform)))();

  let result: PublishResult;
  try {
    result = await provider.publishPost({
      tenantId: request.tenantId,
      platform,
      content: request.content,
      mediaUrls: request.mediaUrls,
      placement: request.placement,
      mediaType: request.mediaType,
      mediaMetadata: request.mediaMetadata,
      scheduledFor: request.scheduledFor ?? null,
      // The handlers only dispatch already-approved posts; the seam still enforces
      // its own guard, so make the cleared approval explicit.
      approved: true,
      dryRun: false,
    });
  } catch (error) {
    // Pre-publish / explicit-failure errors mean the post never went live —
    // surface them unchanged so the handlers classify them as
    // definitely-never-posted (safe to roll back + retry).
    if (publishNeverReachedPlatform(error)) {
      throw error;
    }
    // Otherwise the broker may already have created the post: this is
    // OUTCOME-UNKNOWN. Raise a MetaPublishError(outcomeUnknown) so the handlers
    // leave the platform claim in place and NEVER auto-retry (a retry of a
    // publish that secretly succeeded is a duplicate post — CLAUDE.md).
    throw new MetaPublishError(
      'provider_publish_outcome_unknown',
      `Publish via the configured provider for ${platform} failed after the action was attempted; the post may already be live.`,
      { status: 502, outcomeUnknown: true },
    );
  }

  const scheduled = result.status === 'scheduled';
  if (!scheduled && !result.externalPostId) {
    // The provider reported a live publish but returned no post id. The post is
    // very likely live (the action was accepted), so this is outcome-unknown, NOT
    // a clean failure: persisting an empty id would corrupt records, and a retry
    // would duplicate. Mirror the direct path's 2xx-without-id handling.
    //
    // LOG THE RAW RESPONSE. This branch used to discard `result.rawResponse`
    // entirely, which made every occurrence a schema archaeology exercise: the
    // LinkedIn `x_restli_id` incident (a live post with no recorded id) needed
    // the broker's toolkit schema diffed by hand because the one artifact that
    // would have named the missing key was thrown away here. The payload is
    // redacted and length-capped by formatRawResponseForLog.
    console.warn('[publish-dispatch] provider reported success with no post id', {
      platform,
      provider: result.provider,
      tenantId: request.tenantId,
      status: result.status,
      // Key NAMES, not values — this is schema, and it is the fastest possible
      // answer to "which key should we have been reading?". Bounded so a
      // pathological body cannot flood the log on its own.
      rawResponseKeys:
        result.rawResponse && typeof result.rawResponse === 'object' && !Array.isArray(result.rawResponse)
          ? Object.keys(result.rawResponse as Record<string, unknown>).slice(0, 40)
          : null,
      rawResponse: formatRawResponseForLog(result.rawResponse),
    });
    throw new MetaPublishError(
      'provider_publish_missing_id',
      `Publish via ${result.provider} for ${platform} reported success but returned no post id (status=${result.status}); the post may already be live.`,
      { status: 502, outcomeUnknown: true },
    );
  }

  return {
    provider: result.platform === 'instagram' ? 'instagram' : 'facebook',
    mode: scheduled ? 'scheduled' : 'live',
    platformPostId: result.externalPostId ?? '',
    scheduledFor: request.scheduledFor ?? null,
    // The direct path returns its oauth_connections id here; for a provider-routed
    // publish the connection secret lives provider-side, so return a stable,
    // non-secret marker. (This field is only echoed in the handlers' JSON
    // responses, not persisted to the posts row.)
    connectionId: `${result.provider}:${platform}`,
  };
}
