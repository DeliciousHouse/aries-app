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

function metaPlatform(provider: string): IntegrationPlatform {
  // Map the dispatch request's provider string to the integration platform the
  // provider seam services. X (Twitter), Reddit, LinkedIn and YouTube are each
  // their own Composio-only platform; Instagram maps to instagram; everything
  // else maps to facebook (the direct route's two-way split). Without the
  // explicit cases, 'x'/'reddit'/'linkedin'/'youtube' would fall through to
  // 'facebook' and be sent to a Facebook Page. None reaches the direct_meta fast
  // path (normalizeMetaProvider throws a terminal 400), and
  // DirectMetaProvider.supports() is false for them, so they can never post to FB.
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'x') return 'x';
  if (normalized === 'reddit') return 'reddit';
  if (normalized === 'linkedin') return 'linkedin';
  if (normalized === 'youtube') return 'youtube';
  if (normalized === 'instagram') return 'instagram';
  return 'facebook';
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
