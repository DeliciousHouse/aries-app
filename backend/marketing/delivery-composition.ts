/**
 * What this tenant's week ACTUALLY delivers — the truthfulness marker (AA-217 v2, deliverable A).
 *
 * CONTRACT — why this exists:
 * `scope.story_count` and the weekly reel companion are Meta-only surfaces.
 * LinkedIn, X and Reddit have no story and no reel in this pipeline, so for a
 * tenant whose connected platforms are those, synthesis silently zeroes the
 * story budget (`synthesize-publish-posts.ts`, the `alternateMode` clamp) and
 * the orchestrator silently declines to fire the reel companion. The operator
 * asked for N stories and a reel, got a feed-only week, and NOTHING anywhere
 * said so. That is the gap the owner named: "the ui should say so".
 *
 * This module is the one place that records the difference between what was
 * requested and what the tenant's platforms can carry, and the one place that
 * renders it into a sentence. Every UI surface reads the sentence from here, so
 * the report, the status subheadline and the history line cannot drift apart.
 *
 * WHERE IT LIVES AND WHY IT SURVIVES:
 * on `doc.stages.publish.outputs.delivery_composition`. That map is the one
 * stage field the publish-FINALIZE run cannot erase:
 *   - `markStageCompleted` (runtime-state.ts) does
 *     `record.outputs = input.outputs ?? record.outputs`, and every callback
 *     completion (`markJobCompleted`, the multi-stage fan-out) passes only
 *     `primaryOutput` — so `outputs` is carried through untouched while
 *     `primary_output` is OVERWRITTEN by the finalize response (the failure mode
 *     documented at ports/hermes.ts PUBLISH_FINALIZE_SCHEDULE_CARRY_THROUGH).
 *   - the orchestrator's own publish completion (orchestrator.ts
 *     `advancePublishStage`) passes `outputs: { ...publishStage.outputs, ... }`,
 *     i.e. a spread that preserves pre-existing keys.
 *   - `markStageRequiresChannelConnection` is likewise called with
 *     `outputs: doc.stages.publish.outputs`.
 * `primary_output` would have been the wrong home: a finalize run that omitted
 * the key would silently erase the marker, and the marker is the keystone of
 * deliverable A. Pinned by tests/delivery-composition-marker.test.ts, which
 * drives the REAL runtime-state writers rather than asserting the intent.
 *
 * Note `resolveStageOutput` prefers a non-empty `outputs` map over
 * `primary_output` — that is why this marker is only ever written for the
 * `publish` stage, which has no `resolveStageOutput` caller (only `strategy`
 * and `production` do: workspace-views.ts, asset-library.ts, publish-review.ts).
 *
 * INJECTION POSTURE: `platforms` holds enum members only — the caller passes the
 * list resolved by `resolvePrimaryPublishPlatforms`, and it is re-filtered here
 * through `filterKnownPlatforms`. Nothing tenant-authored reaches the sentence.
 */

import {
  filterKnownPlatforms,
  platformDisplayLabel,
  platformsPhrase,
} from '@/backend/social-content/platform-copy-directives';

import { appendHistory, type SocialContentJobRuntimeDocument } from './runtime-state';

/** The key this marker occupies inside `stages.publish.outputs`. */
export const DELIVERY_COMPOSITION_KEY = 'delivery_composition';

/**
 * Why the week is feed-only. One value today; it is a string union rather than a
 * boolean so a future reason (e.g. a tenant that disabled stories) reads
 * distinctly in the stored doc instead of overloading this one.
 */
export type DeliveryCompositionReason = 'no_story_or_reel_surface_on_platforms';

export type DeliveryComposition = {
  /** The platforms this week was actually synthesized for. Enum members only. */
  platforms: string[];
  /** `scope.story_count` as the operator asked for it. */
  stories_requested: number;
  /** How many story posts the week really produced. Zero is the whole point. */
  stories_delivered: number;
  /**
   * True when the weekly reel companion would have fired for a Meta tenant but
   * was skipped for this one. False when reels were off for this deployment
   * anyway — claiming a skip that never had anything to skip is its own small
   * lie.
   */
  reel_companion_skipped: boolean;
  reason: DeliveryCompositionReason;
  at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
}

/**
 * Read the marker back off a runtime doc. Tolerant by design: the doc is
 * persisted JSON that predates this field on every existing job, and a status
 * handler must never throw over a shape it does not recognise.
 */
export function readDeliveryComposition(
  doc: Pick<SocialContentJobRuntimeDocument, 'stages'> | null | undefined,
): DeliveryComposition | null {
  const outputs = doc?.stages?.publish?.outputs;
  if (!isRecord(outputs)) return null;
  const raw = outputs[DELIVERY_COMPOSITION_KEY];
  if (!isRecord(raw)) return null;

  const platforms = filterKnownPlatforms(Array.isArray(raw.platforms) ? raw.platforms : []);
  if (platforms.length === 0) return null;

  return {
    platforms,
    stories_requested: readNonNegativeInt(raw.stories_requested),
    stories_delivered: readNonNegativeInt(raw.stories_delivered),
    reel_companion_skipped: raw.reel_companion_skipped === true,
    reason: 'no_story_or_reel_surface_on_platforms',
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

/**
 * Record what this week will actually deliver, and say it in the job history too
 * (the history line is what an operator reading the timeline sees).
 *
 * Returns the marker it wrote, or `null` when there is nothing to disclose —
 * i.e. the tenant asked for no stories AND no reel was skipped, so the week the
 * operator gets is the week they asked for and a "heads up" would be noise.
 *
 * Only ever called from the alternate-primary path, which is unreachable unless
 * `ARIES_ANY_PLATFORM_PUBLISH_ENABLED` is ON — so a Meta tenant's runtime doc
 * gains no new key and every deliverable-A surface below stays dark.
 */
export function recordDeliveryComposition(
  doc: SocialContentJobRuntimeDocument,
  input: {
    platforms: readonly string[];
    storiesRequested: number;
    reelCompanionSkipped: boolean;
    at?: string;
  },
): DeliveryComposition | null {
  const platforms = filterKnownPlatforms(input.platforms);
  if (platforms.length === 0) return null;

  const storiesRequested = readNonNegativeInt(input.storiesRequested);
  const reelCompanionSkipped = input.reelCompanionSkipped === true;
  if (storiesRequested === 0 && !reelCompanionSkipped) return null;

  const marker: DeliveryComposition = {
    platforms,
    stories_requested: storiesRequested,
    // Zero is not a placeholder here: the alternate path clamps the story budget
    // to 0 before the promotion loop runs, so no story row can exist.
    stories_delivered: 0,
    reel_companion_skipped: reelCompanionSkipped,
    reason: 'no_story_or_reel_surface_on_platforms',
    at: input.at ?? new Date().toISOString(),
  };

  const publishStage = doc.stages?.publish;
  if (!publishStage) return null;
  if (!isRecord(publishStage.outputs)) {
    publishStage.outputs = {};
  }
  publishStage.outputs[DELIVERY_COMPOSITION_KEY] = marker;

  appendHistory(doc, deliveryCompositionHistoryNote(marker), { stage: 'publish' });
  return marker;
}

/**
 * The platform list as operator-facing copy: "LinkedIn, X and Reddit".
 * Enum-filters first, so a value that is not a platform can never be labelled.
 * Labels come from `platformDisplayLabel` — the single label map shared with the
 * intake form and the calendar, so no surface can invent its own casing.
 */
export function deliveryPlatformsPhrase(platforms: readonly string[]): string {
  return platformsPhrase(filterKnownPlatforms(platforms));
}

export { platformDisplayLabel as deliveryPlatformLabel };

/**
 * The ONE sentence every surface renders. Names the tenant's ACTUAL platforms —
 * a LinkedIn-only tenant is never told about X or Reddit — and states only the
 * surfaces that were really dropped.
 */
export function deliveryCompositionSentence(marker: DeliveryComposition): string | null {
  const dropped: string[] = [];
  if (marker.stories_requested > 0 && marker.stories_delivered === 0) {
    dropped.push(marker.stories_requested === 1 ? 'the story you asked for' : `the ${marker.stories_requested} stories you asked for`);
  }
  if (marker.reel_companion_skipped) {
    dropped.push('the weekly reel');
  }
  if (dropped.length === 0) return null;

  const platforms = deliveryPlatformsPhrase(marker.platforms);
  const what = dropped.join(' and ');
  return (
    `Stories and reels publish to Facebook and Instagram only, so ${what}`
    + ` could not be delivered on ${platforms} — this week is feed posts only.`
  );
}

/** The job-history phrasing. Shorter than the UI sentence; same facts. */
export function deliveryCompositionHistoryNote(marker: DeliveryComposition): string {
  const platforms = deliveryPlatformsPhrase(marker.platforms);
  const parts: string[] = [];
  if (marker.stories_requested > 0) {
    parts.push(`${marker.stories_requested} requested ${marker.stories_requested === 1 ? 'story' : 'stories'} skipped`);
  }
  if (marker.reel_companion_skipped) {
    parts.push('weekly reel companion skipped');
  }
  return `${parts.join('; ')} — ${platforms} ${platforms.includes(' and ') ? 'have' : 'has'} no story or reel surface (feed-only week)`;
}
