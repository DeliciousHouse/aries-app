/**
 * backend/insights/platforms/registry.ts
 *
 * Canonical list of supported analytics platforms.
 *
 * To add a new platform (e.g. TikTok):
 *   1. Add it to SUPPORTED_PLATFORMS below.
 *   2. TypeScript will highlight every spot that needs updating (capabilities.ts, adapter factory, etc.).
 */

export const SUPPORTED_PLATFORMS = ['youtube', 'instagram', 'facebook', 'x'] as const;

/** Union type — 'youtube' | 'instagram' | 'facebook' | 'x' */
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Runtime guard: narrows an unknown string to Platform. */
export function isSupportedPlatform(value: string): value is Platform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

/** Human-readable display labels for UI use. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
};

/** Icon identifiers used by the frontend icon registry (Phase 10). */
export const PLATFORM_ICON_IDS: Record<Platform, string> = {
  youtube: 'youtube',
  instagram: 'instagram',
  facebook: 'facebook',
  x: 'x',
};
