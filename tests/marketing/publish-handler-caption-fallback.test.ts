/**
 * Tests for publish handler caption resolution fallback (Fix for Regression 3).
 *
 * When ARIES_SOCIAL_COPY_FINALIZE_ENABLED=0 (default), social-copy.json does not
 * exist and loadSocialCopyArtifact returns null. In this case the publish handlers
 * must fall back to the production stage's content_package[] to build the caption.
 *
 * We test the fallback logic in isolation — the caption resolution algorithm —
 * not the full HTTP handler (which requires DB/auth setup). The algorithm is
 * extracted here to be testable without side effects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Inline caption resolution algorithm — mirrors what both handlers do
// ---------------------------------------------------------------------------

type ContentPost = {
  hook?: string;
  body?: string;
  cta?: string;
  hashtags?: string[];
  platforms?: string[];
};

/**
 * Resolve caption from content_package[] for a given platform preference.
 * Mirrors the logic in publish-facebook/handler.ts and publish-instagram/handler.ts.
 */
function resolveCaptionFromContentPackage(
  contentPackage: unknown,
  preferredPlatforms: string[],
): string {
  if (!Array.isArray(contentPackage) || contentPackage.length === 0) {
    return '';
  }
  const posts = contentPackage as ContentPost[];
  const preferred = posts.find(
    (p) =>
      Array.isArray(p.platforms) &&
      p.platforms.some((pl: string) => preferredPlatforms.includes(pl)),
  ) ?? posts[0];
  if (!preferred) return '';
  const parts = [preferred.hook, preferred.body, preferred.cta].filter(Boolean).join('\n\n');
  const tags =
    Array.isArray(preferred.hashtags) && preferred.hashtags.length > 0
      ? `\n\n${preferred.hashtags.join(' ')}`
      : '';
  return `${parts}${tags}`.trim();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FACEBOOK_POST: ContentPost = {
  hook: 'Stop guessing what your audience wants.',
  body: 'Our analytics platform gives you the insight to know — not just feel.',
  cta: 'Start your free trial today.',
  hashtags: ['#marketing', '#analytics', '#growth'],
  platforms: ['facebook', 'meta'],
};

const INSTAGRAM_POST: ContentPost = {
  hook: 'Your brand story deserves to be seen.',
  body: 'Authentic content, built for the feed. No filters needed.',
  cta: 'Tap to learn more.',
  hashtags: ['#branding', '#instagram', '#creator'],
  platforms: ['instagram'],
};

const MULTI_POST_CONTENT_PACKAGE: ContentPost[] = [FACEBOOK_POST, INSTAGRAM_POST];

// ---------------------------------------------------------------------------
// Tests — Facebook caption resolution
// ---------------------------------------------------------------------------

test('caption fallback: resolves facebook-targeted post from content_package', () => {
  const caption = resolveCaptionFromContentPackage(MULTI_POST_CONTENT_PACKAGE, ['facebook', 'meta']);
  assert.ok(
    caption.includes('Stop guessing what your audience wants.'),
    'Facebook handler must pick the facebook-targeted post hook',
  );
});

test('caption fallback: facebook caption includes body and cta', () => {
  const caption = resolveCaptionFromContentPackage(MULTI_POST_CONTENT_PACKAGE, ['facebook', 'meta']);
  assert.ok(caption.includes('analytics platform'), 'Caption must include body text');
  assert.ok(caption.includes('Start your free trial today.'), 'Caption must include CTA');
});

test('caption fallback: facebook caption appends hashtags with newline separator', () => {
  const caption = resolveCaptionFromContentPackage(MULTI_POST_CONTENT_PACKAGE, ['facebook', 'meta']);
  assert.ok(caption.includes('#marketing'), 'Caption must include hashtags');
  assert.ok(caption.includes('#analytics'), 'Caption must include all hashtags');
  assert.ok(caption.includes('#growth'), 'Caption must include all hashtags');
  // Hashtags should be on their own paragraph (separated by \n\n)
  const hashtagParagraph = caption.split('\n\n').find((p) => p.startsWith('#'));
  assert.ok(hashtagParagraph, 'Hashtags must appear as a separate paragraph in the caption');
});

// ---------------------------------------------------------------------------
// Tests — Instagram caption resolution
// ---------------------------------------------------------------------------

test('caption fallback: resolves instagram-targeted post from content_package', () => {
  const caption = resolveCaptionFromContentPackage(MULTI_POST_CONTENT_PACKAGE, ['instagram']);
  assert.ok(
    caption.includes('Your brand story deserves to be seen.'),
    'Instagram handler must pick the instagram-targeted post hook',
  );
});

test('caption fallback: instagram caption includes hashtags', () => {
  const caption = resolveCaptionFromContentPackage(MULTI_POST_CONTENT_PACKAGE, ['instagram']);
  assert.ok(caption.includes('#branding'), 'Instagram caption must include hashtags');
  assert.ok(caption.includes('#instagram'), 'Instagram caption must include #instagram hashtag');
});

// ---------------------------------------------------------------------------
// Tests — fallback to first post when no platform match
// ---------------------------------------------------------------------------

test('caption fallback: falls back to first post when no platform matches', () => {
  const postsWithoutPlatform: ContentPost[] = [
    { hook: 'First post hook', body: 'First post body', cta: 'CTA here', hashtags: ['#tag1'], platforms: [] },
    { hook: 'Second post hook', body: 'Second post body', cta: 'CTA 2', hashtags: ['#tag2'], platforms: ['instagram'] },
  ];
  const caption = resolveCaptionFromContentPackage(postsWithoutPlatform, ['facebook']);
  assert.ok(
    caption.includes('First post hook'),
    'Must fall back to first post when no facebook post is found',
  );
});

// ---------------------------------------------------------------------------
// Tests — empty / missing content_package
// ---------------------------------------------------------------------------

test('caption fallback: returns empty string when content_package is null', () => {
  const caption = resolveCaptionFromContentPackage(null, ['facebook', 'meta']);
  assert.strictEqual(caption, '', 'Must return empty string when content_package is null');
});

test('caption fallback: returns empty string when content_package is empty array', () => {
  const caption = resolveCaptionFromContentPackage([], ['facebook', 'meta']);
  assert.strictEqual(caption, '', 'Must return empty string when content_package is empty');
});

test('caption fallback: returns empty string when content_package is not an array', () => {
  const caption = resolveCaptionFromContentPackage({ some: 'object' }, ['facebook', 'meta']);
  assert.strictEqual(caption, '', 'Must return empty string when content_package is not an array');
});

// ---------------------------------------------------------------------------
// Tests — partial post data (missing fields)
// ---------------------------------------------------------------------------

test('caption fallback: works when post is missing cta', () => {
  const partialPost: ContentPost[] = [
    { hook: 'Hook text', body: 'Body text', hashtags: ['#tag'], platforms: ['facebook'] },
  ];
  const caption = resolveCaptionFromContentPackage(partialPost, ['facebook', 'meta']);
  assert.ok(caption.includes('Hook text'), 'Hook must appear');
  assert.ok(caption.includes('Body text'), 'Body must appear');
  // CTA is missing — should not crash
});

test('caption fallback: works when post has no hashtags', () => {
  const postNoHashtags: ContentPost[] = [
    { hook: 'Hook', body: 'Body', cta: 'CTA', hashtags: [], platforms: ['instagram'] },
  ];
  const caption = resolveCaptionFromContentPackage(postNoHashtags, ['instagram']);
  assert.ok(caption.includes('Hook'), 'Hook must appear');
  assert.ok(!caption.includes('\n\n#'), 'No hashtag paragraph when hashtags is empty');
});
