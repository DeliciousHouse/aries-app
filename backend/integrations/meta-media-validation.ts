/**
 * Per-surface media validation for Meta video/Story/Reel publishing.
 *
 * Fail-closed BEFORE any Graph call, mirroring the existing image-Story guards
 * in meta-publishing.ts. Validation is metadata-driven: Aries does NOT download
 * and probe the file — Hermes emits width / height / duration_seconds alongside
 * the asset_url, and missing metadata is rejected (never assumed).
 *
 * Every failure throws a MetaPublishError with status 400, retryable:false —
 * a malformed media payload can never succeed, so it must be terminal.
 */

import { MetaPublishError } from './meta-publishing';

export type MediaSurface = 'feed' | 'story' | 'reel';
export type MediaType = 'image' | 'video';

/**
 * Per-media metadata Hermes provides alongside an asset_url. Aspect/duration
 * checks read these; they are NOT probed from the bytes. Missing numeric
 * metadata for a video surface that requires it is a fail-closed reject.
 */
export interface MediaMetadata {
  url: string;
  widthPx?: number | null;
  heightPx?: number | null;
  durationSeconds?: number | null;
}

export interface ValidateMediaInput {
  media: MediaMetadata[];
  surface: MediaSurface;
  mediaType: MediaType;
  /** Stories cannot be natively scheduled; a scheduledFor on a story is rejected. */
  scheduledFor?: string | null;
}

// Meta per-surface duration ceilings (seconds). Conservative caps we enforce;
// Meta's own limits are looser in places but these keep us safely inside them.
const IG_REEL_MIN_S = 3;
const IG_REEL_MAX_S = 90;
const IG_STORY_VIDEO_MAX_S = 60;
const IG_FEED_VIDEO_MIN_S = 3;
const IG_FEED_VIDEO_MAX_S = 60;
const FB_FEED_VIDEO_MAX_S = 240; // far below Meta's 240min ceiling
const FB_STORY_VIDEO_MAX_S = 60;

// Aspect tolerance for "9:16" / "16:9" / "4:5" checks (ratios compared loosely).
const ASPECT_TOLERANCE = 0.05;

function fail(code: string, message: string): never {
  throw new MetaPublishError(code, message, { status: 400, retryable: false });
}

function requireSingleMedia(media: MediaMetadata[], surface: MediaSurface): MediaMetadata {
  if (media.length !== 1) {
    fail(
      'single_media_required',
      `${surface} placement requires exactly one media item; received ${media.length}.`,
    );
  }
  return media[0];
}

function requireDuration(item: MediaMetadata, surface: MediaSurface): number {
  const d = item.durationSeconds;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) {
    fail(
      'missing_video_metadata',
      `${surface} video requires duration_seconds metadata from Hermes; it was missing or invalid.`,
    );
  }
  return d;
}

function requireDimensions(item: MediaMetadata, surface: MediaSurface): { w: number; h: number } {
  const w = item.widthPx;
  const h = item.heightPx;
  if (
    typeof w !== 'number' || !Number.isFinite(w) || w <= 0 ||
    typeof h !== 'number' || !Number.isFinite(h) || h <= 0
  ) {
    fail(
      'missing_video_metadata',
      `${surface} video requires width/height metadata from Hermes; it was missing or invalid.`,
    );
  }
  return { w, h };
}

function aspectMatches(w: number, h: number, target: number): boolean {
  const ratio = w / h;
  return Math.abs(ratio - target) <= target * ASPECT_TOLERANCE;
}

function assertVerticalNineSixteen(w: number, h: number, surface: MediaSurface): void {
  if (!aspectMatches(w, h, 9 / 16)) {
    fail(
      'aspect_ratio_invalid',
      `${surface} requires a 9:16 vertical video; got ${w}x${h}.`,
    );
  }
}

/**
 * Validate a media set for a (surface, mediaType) pair. Throws on any violation
 * before the Graph call. Returns normally when the payload is publishable.
 */
export function validateMediaForSurface(input: ValidateMediaInput): void {
  const { media, surface, mediaType, scheduledFor } = input;

  // Stories (image or video) are single-media and cannot be natively scheduled.
  if (surface === 'story' && scheduledFor) {
    fail('story_scheduled_publish_not_supported', 'Stories cannot be natively scheduled; publish a story live.');
  }
  if (surface === 'reel' && scheduledFor) {
    fail('reel_scheduled_publish_not_supported', 'Reels cannot be natively scheduled; publish a reel live.');
  }

  // A reel is always video; an image-for-reel is a contract violation.
  if (surface === 'reel' && mediaType !== 'video') {
    fail('media_type_mismatch', 'Reel placement requires a video media item, not an image.');
  }

  if (mediaType === 'image') {
    // Image surfaces keep their existing guards elsewhere; the only added
    // constraint here is single-media for image stories (already enforced in
    // publishToMetaGraph, repeated here for the validator contract).
    if (surface === 'story' && media.length !== 1) {
      fail('single_media_required', 'Image story requires exactly one image.');
    }
    return;
  }

  // ---- video branches ----
  const item = requireSingleMedia(media, surface);
  const duration = requireDuration(item, surface);
  const { w, h } = requireDimensions(item, surface);

  if (surface === 'reel') {
    assertVerticalNineSixteen(w, h, 'reel');
    if (duration < IG_REEL_MIN_S || duration > IG_REEL_MAX_S) {
      fail('duration_out_of_range', `Reel duration must be ${IG_REEL_MIN_S}-${IG_REEL_MAX_S}s; got ${duration}s.`);
    }
    return;
  }

  if (surface === 'story') {
    assertVerticalNineSixteen(w, h, 'story');
    if (duration > IG_STORY_VIDEO_MAX_S) {
      fail('duration_exceeds_story_limit', `Story video must be <= ${IG_STORY_VIDEO_MAX_S}s; got ${duration}s.`);
    }
    return;
  }

  // surface === 'feed' video. Provider-agnostic ceiling: enforce the stricter
  // IG window (the caller knows the provider but feed-video constraints overlap;
  // use the looser FB cap only as the absolute upper bound).
  if (duration < IG_FEED_VIDEO_MIN_S) {
    fail('duration_out_of_range', `Feed video must be >= ${IG_FEED_VIDEO_MIN_S}s; got ${duration}s.`);
  }
  if (duration > FB_FEED_VIDEO_MAX_S) {
    fail('duration_out_of_range', `Feed video must be <= ${FB_FEED_VIDEO_MAX_S}s; got ${duration}s.`);
  }
}

export const VIDEO_DURATION_LIMITS = {
  IG_REEL_MIN_S,
  IG_REEL_MAX_S,
  IG_STORY_VIDEO_MAX_S,
  IG_FEED_VIDEO_MIN_S,
  IG_FEED_VIDEO_MAX_S,
  FB_FEED_VIDEO_MAX_S,
  FB_STORY_VIDEO_MAX_S,
} as const;
