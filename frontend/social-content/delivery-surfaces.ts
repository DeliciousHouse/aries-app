/**
 * What the weekly form can honestly promise this tenant (AA-217 v2, deliverable A).
 *
 * CONTRACT — why this exists:
 * "Image stories", "Render video after approval" and "Reel audio" are Facebook /
 * Instagram surfaces. LinkedIn, X and Reddit have none of them, so for a tenant
 * connected only to those, `scope.story_count` is clamped to 0 by synthesis and
 * the weekly reel companion never fires — silently. The intake form still asked
 * for a story count and offered a reel, and the operator found out by counting
 * what did not arrive. The owner's words: "the ui should say so".
 *
 * This module is the pure decision behind that copy: given the tenant's
 * connected platforms, which weekly surfaces are actually deliverable, and what
 * sentence states it. No React, no fetching — the screen supplies the platform
 * list and renders the result, so the rule is unit-testable and the same answer
 * can be reused by any other surface later.
 *
 * TRUTHFULNESS RULE (reviewer-required): the sentence names the tenant's ACTUAL
 * platforms. A LinkedIn-only tenant must never be told about X and Reddit.
 *
 * UNKNOWN IS NOT "FEED-ONLY": when the platform list is empty — integrations
 * still loading, the request failed, or the tenant genuinely has nothing
 * connected — this returns `known: false` and every caller must render exactly
 * today's form. Disabling controls on a failed fetch would invent a restriction
 * the tenant does not have, which is the same class of untruth in the other
 * direction.
 */

import {
  META_PUBLISH_PLATFORMS,
  CROSSPOST_PLATFORMS,
} from '@/backend/integrations/providers/integration-config';
import {
  filterKnownPlatforms,
  platformDisplayLabel,
  platformsPhrase,
} from '@/backend/social-content/platform-copy-directives';

/** Canonical rendering order: Meta first (the legacy primaries), then the rest. */
const PLATFORM_ORDER: readonly string[] = [...META_PUBLISH_PLATFORMS, ...CROSSPOST_PLATFORMS];

const META_SURFACE_PLATFORMS: ReadonlySet<string> = new Set<string>(META_PUBLISH_PLATFORMS);

// Labels and phrasing come from the shared map so the form, the report and the
// calendar cannot drift into three spellings of the same network.
export { platformDisplayLabel as deliveryPlatformLabel, platformsPhrase as deliveryPlatformsPhrase };

export type WeeklyDeliverySurfaces = {
  /**
   * False when we could not determine the tenant's platforms. Callers MUST fall
   * back to the unchanged form — never to a restriction.
   */
  known: boolean;
  /** The tenant's connected publishable platforms, canonical order, enum members only. */
  platforms: string[];
  /** At least one connected Facebook / Instagram channel: stories and reels are real. */
  hasMetaSurface: boolean;
  /** Known platforms, none of them Meta: this week is feed posts only. */
  feedOnly: boolean;
  /** The one sentence the form renders. Null unless `feedOnly`. */
  notice: string | null;
};

const UNKNOWN: WeeklyDeliverySurfaces = Object.freeze({
  known: false,
  platforms: [],
  hasMetaSurface: false,
  feedOnly: false,
  notice: null,
});

/**
 * Resolve the deliverable surfaces from a tenant's connected platform keys.
 *
 * `connectedPlatforms` is whatever the caller has — typically the `platform`
 * field of every integration card in `connection_state === 'connected'`. Values
 * that are not publish platforms (`openai`, `meta_ads`, `youtube`…) are dropped
 * by `filterKnownPlatforms`, which is also the injection boundary: only enum
 * members ever reach the rendered sentence.
 */
export function resolveWeeklyDeliverySurfaces(
  connectedPlatforms: readonly string[] | null | undefined,
): WeeklyDeliverySurfaces {
  if (!connectedPlatforms) return UNKNOWN;
  const known = filterKnownPlatforms(connectedPlatforms);
  if (known.length === 0) return UNKNOWN;

  const platforms = PLATFORM_ORDER.filter((p) => known.includes(p));
  const hasMetaSurface = platforms.some((p) => META_SURFACE_PLATFORMS.has(p));
  if (hasMetaSurface) {
    return { known: true, platforms, hasMetaSurface: true, feedOnly: false, notice: null };
  }

  const phrase = platformsPhrase(platforms);
  return {
    known: true,
    platforms,
    hasMetaSurface: false,
    feedOnly: true,
    notice:
      `Stories and reels publish to Facebook and Instagram only.`
      + ` ${phrase} ${platforms.length === 1 ? 'receives' : 'receive'} feed posts, so this week will be feed-only.`,
  };
}
