/**
 * Per-platform caption validator for Instagram and Facebook.
 * Enforces character limits and hashtag constraints per Meta Graph API specs.
 */

export type Channel = 'instagram_feed' | 'facebook_feed';

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
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
