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
import { analyticsProviderSelector, isXEnabled, isYouTubeEnabled } from '@/backend/integrations/providers/integration-config';

type AdapterBuilder = (ctx: InsightsAdapterContext) => InsightsAdapter;

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
 * when the X rollout flag is ON (ARIES_X_ENABLED) AND analytics is on Composio
 * (ANALYTICS_PROVIDER=composio). Reuses the existing isXEnabled flag — X insights
 * does not add a new flag. Default OFF on both axes → the X adapter never
 * activates and no Composio tool is ever executed.
 */
export function isXInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isXEnabled(env) && analyticsProviderSelector(env) === 'composio';
}

/**
 * Real off-switch for the Composio-backed YouTube insights path: active only when
 * the YouTube rollout flag is ON (ARIES_YOUTUBE_ENABLED) AND analytics is on
 * Composio (ANALYTICS_PROVIDER=composio). NEW flag (not ARIES_X_ENABLED). Default
 * OFF on both axes → the YouTube adapter never activates and no Composio tool is
 * ever executed; the previously registered throwing skeleton is gone.
 */
export function isYouTubeInsightsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isYouTubeEnabled(env) && analyticsProviderSelector(env) === 'composio';
}

const REGISTRY: Partial<Record<Platform, AdapterBuilder>> = {
  youtube: (ctx) => {
    if (!isYouTubeInsightsEnabled()) {
      throw new Error(
        'YouTube insights adapter is disabled: set ARIES_YOUTUBE_ENABLED=1 and ' +
        'ANALYTICS_PROVIDER=composio to enable Composio-backed YouTube analytics.',
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
        'ANALYTICS_PROVIDER=composio to enable Composio-backed X analytics.',
      );
    }
    return createXInsightsAdapter(ctx);
  },
  // instagram: (ctx) => createInstagramInsightsAdapter(ctx),  ← out of scope (#596/#597 = FB only)
};

/**
 * Returns true only if a live adapter is available for the platform. For
 * Facebook this also honors the ANALYTICS_PROVIDER=composio off-switch, so
 * callers (e.g. the integrations-sync handler) never route to a disabled path.
 */
export function hasAdapter(platform: Platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'facebook') return isFacebookInsightsEnabled(env);
  if (platform === 'x') return isXInsightsEnabled(env);
  if (platform === 'youtube') return isYouTubeInsightsEnabled(env);
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
