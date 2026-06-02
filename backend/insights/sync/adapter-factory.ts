/**
 * backend/insights/sync/adapter-factory.ts
 *
 * Maps a platform string to its singleton InsightsAdapter instance.
 *
 * To add a new platform:
 *   1. Create backend/insights/adapters/<platform>/index.ts
 *   2. Register it in REGISTRY below.
 *   3. TypeScript will flag anything that needs updating.
 */

import type { Platform } from '../platforms/registry';
import type { InsightsAdapter } from '../adapters/_adapter.types';
import { youTubeInsightsAdapter } from '../adapters/youtube/index';

const REGISTRY: Partial<Record<Platform, InsightsAdapter>> = {
  youtube: youTubeInsightsAdapter,
  // instagram: instagramInsightsAdapter,  ← Phase 4+
  // facebook:  facebookInsightsAdapter,   ← Phase 4+
};

/** Returns true only if a live adapter is registered for the platform. */
export function hasAdapter(platform: Platform): boolean {
  return platform in REGISTRY && REGISTRY[platform] != null;
}

/**
 * Returns the adapter for a given platform.
 * Throws if no adapter has been registered (e.g. a platform in the DB
 * that doesn't have an adapter yet).
 */
export function getAdapter(platform: Platform): InsightsAdapter {
  const adapter = REGISTRY[platform];
  if (!adapter) {
    throw new Error(
      `No insights adapter registered for platform "${platform}". ` +
      `Add one to backend/insights/sync/adapter-factory.ts.`,
    );
  }
  return adapter;
}
