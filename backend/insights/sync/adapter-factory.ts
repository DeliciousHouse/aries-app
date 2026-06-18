/**
 * backend/insights/sync/adapter-factory.ts
 *
 * Maps a platform string to its InsightsAdapter instance.
 *
 * Adapters are produced by per-platform builder functions so a platform that
 * needs per-tenant connection context (e.g. Facebook, X, and YouTube via
 * Composio, which need the Composio `connectedAccountId`) can be constructed
 * bound to that context.
 *
 * To add a new platform:
 *   1. Create backend/insights/adapters/<platform>/index.ts
 *   2. Register a builder in REGISTRY below.
 *   3. TypeScript will flag anything that needs updating.
 */

import type { Platform } from '../platforms/registry';
import type { InsightsAdapter, InsightsAdapterContext } from '../adapters/_adapter.types';
import { createYouTubeInsightsAdapter } from '../adapters/youtube/index';
import { createFacebookInsightsAdapter } from '../adapters/facebook/index';
import { createXInsightsAdapter } from '../adapters/x/index';
import { createRedditInsightsAdapter } from '../adapters/reddit/index';
import { createLinkedInInsightsAdapter } from '../adapters/linkedin/index';
import { analyticsProviderSelector, isXEnabled, isYouTubeEnabled, isRedditEnabled, isLinkedInEnabled, isComposioEnabled } from '@/backend/integrations/providers/integration-config';

type AdapterBuilder = (ctx: InsightsAdapterContext) => InsightsAdapter;

/**
 * Platforms that are ALWAYS Composio-backed for analytics — they have no
 * direct-Meta analytics path and are therefore independent of the global
 * ANALYTICS_PROVIDER selector. Their enablement is keyed on COMPOSIO_ENABLED
 * (not on ANALYTICS_PROVIDER, which governs facebook/instagram only).
 *
 * NOTE: youtube IS in this set (it has a working insights adapter) even though
 * it is absent from the publish-only set COMPOSIO_ONLY_PUBLISH_PLATFORMS in
 * backend/integrations/providers/provider-factory.ts. The two sets are
 * intentionally separate and must NOT be merged — analytics and publish have
 * different activation axes.
 */
const COMPOSIO_ONLY_ANALYTICS_PLATFORMS = new Set<Platform>(['x', 'reddit', 'linkedin', 'youtube']);

/** True when the platform's analytics are exclusively Composio-backed. */
export function isComposioOnlyAnalyticsPlatform(platform: string): boolean {
  return COMPOSIO_ONLY_ANALYTICS_PLATFORMS.has(platform as Platform);
}

/**
 * Real off-switch for the Composio-backed Facebook insights path: only active
 * when ANALYTICS_PROVIDER=composio. When it is anything else (the default
 * direct_meta), the FB adapter never activates and no Composio analytics tool
 * is ever executed.
 */
export function isFacebookInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return analyticsProviderSelector(env) === 'composio';
}

/**
 * Real off-switch for the Composio-backed X (Twitter) insights path: active only
 * when the X rollout flag is ON (ARIES_X_ENABLED) AND Composio is enabled
 * (COMPOSIO_ENABLED=true). X is a composio-only platform — it has no direct-Meta
 * analytics path — so its gate is COMPOSIO_ENABLED, not ANALYTICS_PROVIDER.
 * Reuses the existing isXEnabled flag — X insights does not add a new flag.
 * Default OFF on both axes → the X adapter never activates and no Composio tool
 * is ever executed.
 */
export function isXInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isXEnabled(env) && isComposioEnabled(env);
}

/**
 * Real off-switch for the Composio-backed YouTube insights path: active only when
 * the YouTube rollout flag is ON (ARIES_YOUTUBE_ENABLED) AND Composio is enabled
 * (COMPOSIO_ENABLED=true). YouTube is a composio-only platform — so its gate is
 * COMPOSIO_ENABLED, not ANALYTICS_PROVIDER. NEW flag (not ARIES_X_ENABLED).
 * Default OFF on both axes → the YouTube adapter never activates and no Composio
 * tool is ever executed; the previously registered throwing skeleton is gone.
 */
export function isYouTubeInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isYouTubeEnabled(env) && isComposioEnabled(env);
}

/**
 * Real off-switch for the Composio-backed Reddit insights path: active only when
 * the Reddit rollout flag is ON (ARIES_REDDIT_ENABLED) AND Composio is enabled
 * (COMPOSIO_ENABLED=true). Reddit is a composio-only platform — so its gate is
 * COMPOSIO_ENABLED, not ANALYTICS_PROVIDER. REUSES the existing isRedditEnabled
 * flag from the Reddit publish path (#641) — Reddit insights does NOT add a new
 * flag. Default OFF on both axes → the Reddit adapter never activates and no
 * Composio tool is ever executed.
 */
export function isRedditInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isRedditEnabled(env) && isComposioEnabled(env);
}

/**
 * Real off-switch for the Composio-backed LinkedIn insights path (#647): active
 * only when the LinkedIn rollout flag is ON (ARIES_LINKEDIN_ENABLED) AND Composio
 * is enabled (COMPOSIO_ENABLED=true). LinkedIn is a composio-only platform — so
 * its gate is COMPOSIO_ENABLED, not ANALYTICS_PROVIDER. Reuses the existing
 * isLinkedInEnabled flag — LinkedIn insights does NOT add a new flag. Default OFF
 * on both axes → the LinkedIn adapter never activates and no Composio tool is
 * ever executed.
 */
export function isLinkedInInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLinkedInEnabled(env) && isComposioEnabled(env);
}

const REGISTRY: Partial<Record<Platform, AdapterBuilder>> = {
  youtube: (ctx) => {
    if (!isYouTubeInsightsEnabled()) {
      throw new Error(
        'YouTube insights adapter is disabled: set ARIES_YOUTUBE_ENABLED=1 and ' +
        'COMPOSIO_ENABLED=true to enable Composio-backed YouTube analytics.',
      );
    }
    return createYouTubeInsightsAdapter(ctx);
  },
  facebook: (ctx) => {
    if (!isFacebookInsightsEnabled()) {
      throw new Error(
        'Facebook insights adapter is disabled: set ANALYTICS_PROVIDER=composio ' +
        'to enable Composio-backed Facebook analytics.',
      );
    }
    return createFacebookInsightsAdapter(ctx);
  },
  x: (ctx) => {
    if (!isXInsightsEnabled()) {
      throw new Error(
        'X insights adapter is disabled: set ARIES_X_ENABLED=1 and ' +
        'COMPOSIO_ENABLED=true to enable Composio-backed X analytics.',
      );
    }
    return createXInsightsAdapter(ctx);
  },
  reddit: (ctx) => {
    if (!isRedditInsightsEnabled()) {
      throw new Error(
        'Reddit insights adapter is disabled: set ARIES_REDDIT_ENABLED=1 and ' +
        'COMPOSIO_ENABLED=true to enable Composio-backed Reddit analytics.',
      );
    }
    return createRedditInsightsAdapter(ctx);
  },
  linkedin: (ctx) => {
    if (!isLinkedInInsightsEnabled()) {
      throw new Error(
        'LinkedIn insights adapter is disabled: set ARIES_LINKEDIN_ENABLED=1 and ' +
        'COMPOSIO_ENABLED=true to enable Composio-backed LinkedIn analytics.',
      );
    }
    return createLinkedInInsightsAdapter(ctx);
  },
  // instagram: (ctx) => createInstagramInsightsAdapter(ctx),  ← out of scope (#596/#597 = FB only)
};

/**
 * Per-platform predicate dispatcher that accepts an untyped string. True when a
 * live insights adapter is enabled for the given platform in the supplied env.
 *
 * This is the single source-of-truth bridge between ensure-account.ts (which
 * builds the bridged-platform list from strings) and the typed `is<P>InsightsEnabled`
 * predicates above. By routing through this function, ensure-account.ts can never
 * silently drift from the adapter's own enablement conditions.
 *
 *   facebook  → ANALYTICS_PROVIDER=composio
 *   x         → ARIES_X_ENABLED + COMPOSIO_ENABLED
 *   youtube   → ARIES_YOUTUBE_ENABLED + COMPOSIO_ENABLED
 *   reddit    → ARIES_REDDIT_ENABLED + COMPOSIO_ENABLED
 *   linkedin  → ARIES_LINKEDIN_ENABLED + COMPOSIO_ENABLED
 *   anything else → false
 */
export function isPlatformInsightsEnabled(platform: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'facebook') return isFacebookInsightsEnabled(env);
  if (platform === 'x') return isXInsightsEnabled(env);
  if (platform === 'youtube') return isYouTubeInsightsEnabled(env);
  if (platform === 'reddit') return isRedditInsightsEnabled(env);
  if (platform === 'linkedin') return isLinkedInInsightsEnabled(env);
  return false;
}

/**
 * Returns true only if a live adapter is available for the platform. For
 * Facebook this also honors the ANALYTICS_PROVIDER=composio off-switch, so
 * callers (e.g. the integrations-sync handler) never route to a disabled path.
 */
export function hasAdapter(platform: Platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'facebook') return isFacebookInsightsEnabled(env);
  if (platform === 'x') return isXInsightsEnabled(env);
  if (platform === 'youtube') return isYouTubeInsightsEnabled(env);
  if (platform === 'reddit') return isRedditInsightsEnabled(env);
  if (platform === 'linkedin') return isLinkedInInsightsEnabled(env);
  return platform in REGISTRY && REGISTRY[platform] != null;
}

/**
 * Returns the adapter for a given platform, bound to the supplied connection
 * context (Composio-backed adapters need it; others ignore it).
 * Throws if no adapter is registered, or if the platform's adapter is disabled
 * by its off-switch (e.g. Facebook without ANALYTICS_PROVIDER=composio).
 */
export function getAdapter(
  platform: Platform,
  ctx: InsightsAdapterContext = {},
): InsightsAdapter {
  const builder = REGISTRY[platform];
  if (!builder) {
    throw new Error(
      `No insights adapter registered for platform "${platform}". ` +
      `Add one to backend/insights/sync/adapter-factory.ts.`,
    );
  }
  return builder(ctx);
}
