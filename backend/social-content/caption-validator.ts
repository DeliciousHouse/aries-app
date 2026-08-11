/**
 * Per-platform caption validator.
 * Enforces character limits and hashtag constraints per platform.
 *
 * AA-217 v2 (deliverable A — review-tray truthfulness): until now this knew only
 * Instagram and Facebook, so an operator editing a LinkedIn, X or Reddit caption
 * in the review tray was validated against nothing at all — the tray stayed
 * silent while the caption was quietly truncated later, at dispatch, by
 * `adaptCaptionForPlatform`. The limits below are the SAME numbers the adapters
 * enforce (backend/marketing/weekly-crosspost.ts: X_MAX_WEIGHTED 270,
 * LINKEDIN_MAX 2900, REDDIT_TITLE_MAX 280) so the tray warns about exactly what
 * the publisher will do, rather than a second, looser opinion.
 */

export type Channel =
  | 'instagram_feed'
  | 'facebook_feed'
  | 'linkedin_feed'
  | 'x_feed'
  | 'reddit_post';

/**
 * X counts a URL as 23 characters regardless of its real length, and most
 * non-Latin code points as 2. Mirrors `weightedXLength` in
 * backend/marketing/weekly-crosspost.ts — replicated rather than imported so
 * this validator stays dependency-free (it runs in the API response path and is
 * imported by the review tray). The two are pinned against each other in
 * tests/delivery-truthfulness-surfaces.test.ts ("the tray weight counter agrees
 * with the dispatch adapter it predicts").
 */
const X_URL_WEIGHT = 23;
const X_URL_PATTERN = /https?:\/\/[^\s]+/gi;

export function weightedCaptionLengthForX(text: string): number {
  const withoutUrls = text.replace(X_URL_PATTERN, '');
  const urlCount = text.match(X_URL_PATTERN)?.length ?? 0;
  let weight = urlCount * X_URL_WEIGHT;
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    // The CJK/emoji ranges X weights double. Everything else counts as one.
    weight += cp >= 0x1100 ? 2 : 1;
  }
  return weight;
}

export interface CaptionValidationInput {
  channel: Channel;
  text: string;
  hashtags?: string[];
}

export interface CaptionValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validates a caption against platform-specific constraints.
 *
 * Instagram (instagram_feed):
 *   - Max 2200 characters
 *   - Max 30 hashtags
 *
 * Facebook (facebook_feed):
 *   - Max 63206 characters
 *   - No hashtag limit
 *
 * @param input - Validation input with channel, text, and optional hashtags
 * @returns Validation result with ok flag and error messages
 */
export function validateCaption(input: CaptionValidationInput): CaptionValidationResult {
  const errors: string[] = [];

  if (!input.text) {
    errors.push('caption_empty');
    return { ok: false, errors };
  }

  const textLength = input.text.length;
  const hashtags = input.hashtags || [];

  if (input.channel === 'instagram_feed') {
    // Instagram: max 2200 characters
    if (textLength > 2200) {
      errors.push('caption_too_long');
    }

    // Instagram: max 30 hashtags
    if (hashtags.length > 30) {
      errors.push('too_many_hashtags');
    }
  } else if (input.channel === 'facebook_feed') {
    // Facebook: max 63206 characters
    if (textLength > 63206) {
      errors.push('caption_too_long');
    }

    // Facebook: no hashtag limit
  } else if (input.channel === 'linkedin_feed') {
    // LinkedIn commentary caps at 3000; the adapter clamps at 2900 to leave
    // headroom, so warn at the number the publisher will actually enforce.
    if (textLength > 2900) {
      errors.push('caption_too_long');
    }
    // LinkedIn tolerates more, but the adapter keeps at most 5 (end-loaded);
    // anything beyond that is silently dropped, so say so here instead.
    if (hashtags.length > 5) {
      errors.push('too_many_hashtags');
    }
  } else if (input.channel === 'x_feed') {
    // X counts weighted characters, not code points: a URL is always 23 and CJK
    // / emoji are 2. Length-in-characters would pass captions the adapter then
    // truncates, which is the exact silence this branch removes.
    if (weightedCaptionLengthForX(input.text) > 270) {
      errors.push('caption_too_long');
    }
    if (hashtags.length > 1) {
      errors.push('too_many_hashtags');
    }
  } else if (input.channel === 'reddit_post') {
    // Reddit's post title is the FIRST LINE of the content (the publisher splits
    // on it), capped at 300 by the API and at 280 by the adapter.
    const [titleLine = ''] = input.text.split('\n');
    if (titleLine.length > 280) {
      errors.push('title_too_long');
    }
    // Hashtags are not a Reddit convention at all — the adapter strips them, so
    // an operator typing them is writing text that will vanish.
    if (hashtags.length > 0) {
      errors.push('hashtags_not_supported');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
