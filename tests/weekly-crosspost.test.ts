import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adaptCaptionForPlatform,
  buildLinkedInCaption,
  buildRedditContent,
  buildXCaption,
  CROSSPOST_PLATFORMS,
  isWeeklyCrosspostEnabled,
  resolveCrosspostPlatforms,
  weightedXLength,
} from '../backend/marketing/weekly-crosspost';

// ---------------------------------------------------------------------------
// isWeeklyCrosspostEnabled — canonical 4-token truthiness, default OFF.
// ---------------------------------------------------------------------------

test('isWeeklyCrosspostEnabled: default OFF; only 1/true/yes/on enable', () => {
  assert.equal(isWeeklyCrosspostEnabled({}), false);
  assert.equal(isWeeklyCrosspostEnabled({ ARIES_WEEKLY_CROSSPOST_ENABLED: '' }), false);
  assert.equal(isWeeklyCrosspostEnabled({ ARIES_WEEKLY_CROSSPOST_ENABLED: '0' }), false);
  assert.equal(isWeeklyCrosspostEnabled({ ARIES_WEEKLY_CROSSPOST_ENABLED: 'false' }), false);
  for (const on of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
    assert.equal(isWeeklyCrosspostEnabled({ ARIES_WEEKLY_CROSSPOST_ENABLED: on }), true, on);
  }
});

// ---------------------------------------------------------------------------
// weightedXLength — the conservative X weighted counter.
// ---------------------------------------------------------------------------

test('weightedXLength: ASCII counts 1 each', () => {
  assert.equal(weightedXLength('hello'), 5);
  assert.equal(weightedXLength(''), 0);
});

test('weightedXLength: CJK / high code points count 2 each', () => {
  // Three CJK glyphs => weight 6.
  assert.equal(weightedXLength('日本語'), 6);
  // An emoji (U+1F600) counts 2.
  assert.equal(weightedXLength('😀'), 2);
});

test('weightedXLength: each URL counts a fixed 23 regardless of length', () => {
  const shortUrl = 'https://a.co';
  const longUrl = 'https://example.com/some/very/long/path?with=query&more=params';
  assert.equal(weightedXLength(shortUrl), 23);
  assert.equal(weightedXLength(longUrl), 23);
  // Text + URL: "see " (4) + URL (23) = 27.
  assert.equal(weightedXLength('see https://a.co'), 4 + 23);
});

// ---------------------------------------------------------------------------
// buildXCaption — hook + up to 2 hashtags, 270-weighted cap, never empty.
// ---------------------------------------------------------------------------

test('buildXCaption: takes the first sentence/hook and up to 2 hashtags', () => {
  const out = buildXCaption('Big news today. And a longer body here.', ['#one', '#two', '#three']);
  assert.equal(out, 'Big news today. #one #two');
});

test('buildXCaption: no hashtags => just the hook', () => {
  assert.equal(buildXCaption('Just the hook here', []), 'Just the hook here');
});

test('buildXCaption: a plain 270+ char caption is truncated on a word boundary with an ellipsis', () => {
  const word = 'word ';
  const caption = word.repeat(80).trim(); // 80 words, well over 270 chars
  const out = buildXCaption(caption, []);
  assert.ok(weightedXLength(out) <= 270, `weighted length ${weightedXLength(out)} must be <= 270`);
  assert.ok(out.endsWith('…'), 'truncation appends an ellipsis');
  // Word boundary: the text before the ellipsis ends with a complete word (the
  // source is all "word" tokens, so a boundary cut leaves a whole "word").
  const beforeEllipsis = out.slice(0, -1).trimEnd();
  assert.ok(beforeEllipsis.endsWith('word'), `truncation cut on a word boundary; got "${out}"`);
});

test('buildXCaption: a URL counts 23 toward the cap', () => {
  // Build a caption whose weighted length only exceeds 270 because of URLs.
  const url = 'https://example.com';
  const base = 'a'.repeat(250);
  const out = buildXCaption(`${base} ${url} ${url}`, []);
  assert.ok(weightedXLength(out) <= 270, `weighted length ${weightedXLength(out)} must be <= 270`);
});

test('buildXCaption: CJK weight-2 content stays under the weighted cap', () => {
  const cjk = '語'.repeat(200); // 200 glyphs => 400 weighted, must be truncated
  const out = buildXCaption(cjk, []);
  assert.ok(weightedXLength(out) <= 270, `weighted length ${weightedXLength(out)} must be <= 270`);
  assert.ok(out.length > 0, 'never empty');
});

test('buildXCaption: ADVERSARIAL many-short-URL caption can never exceed the weighted cap', () => {
  // Regression (adversarial review finding): truncation used to count URL chars
  // per-code-point (weight ~8 for 'http://a') while the cap counter charges 23
  // per URL — a caption packed with short URLs blew past X's 280 hard cap.
  // The truncation oracle is now weightedXLength itself, so this must hold.
  const manyUrls = Array.from({ length: 40 }, () => 'http://a').join(' ');
  const out = buildXCaption(manyUrls, []);
  assert.ok(
    weightedXLength(out) <= 270,
    `weighted length ${weightedXLength(out)} must be <= 270 for a many-URL caption`,
  );
  assert.ok(out.length > 0, 'never empty');
});

test('buildXCaption: an only-emoji caption stays under the weighted cap', () => {
  const emoji = '🔥'.repeat(300); // weight-2 each => 600 weighted, must truncate
  const out = buildXCaption(emoji, []);
  assert.ok(weightedXLength(out) <= 270, `weighted length ${weightedXLength(out)} must be <= 270`);
  assert.ok(out.length > 0, 'never empty');
});

test('buildXCaption: truncation cutting inside a long URL still respects the cap', () => {
  // A single giant URL as the whole caption: any prefix of it still matches the
  // URL regex (and charges 23), and the ellipsis can be absorbed into the URL
  // token — the final oracle guard must keep the result under the cap.
  const giantUrl = `https://example.com/${'x'.repeat(600)}`;
  const out = buildXCaption(giantUrl, []);
  assert.ok(weightedXLength(out) <= 270, `weighted length ${weightedXLength(out)} must be <= 270`);
});

test('buildXCaption: never returns empty even for empty input', () => {
  assert.notEqual(buildXCaption('', []), undefined);
  // Empty caption => empty string is acceptable (nothing to say) but must be a string.
  assert.equal(typeof buildXCaption('', []), 'string');
  // A whitespace-only caption falls back gracefully.
  assert.equal(typeof buildXCaption('   ', ['#x']), 'string');
});

// ---------------------------------------------------------------------------
// buildLinkedInCaption — full caption clamped to 2900.
// ---------------------------------------------------------------------------

test('buildLinkedInCaption: short caption passes through unchanged', () => {
  const c = 'Line one\n\nLine two\n\n#brand';
  assert.equal(buildLinkedInCaption(c), c);
});

test('buildLinkedInCaption: over 2900 chars is clamped with an ellipsis', () => {
  const long = 'x'.repeat(5000);
  const out = buildLinkedInCaption(long);
  assert.equal(out.length, 2900);
  assert.ok(out.endsWith('…'));
});

// ---------------------------------------------------------------------------
// buildRedditContent — title (first line, hashtags stripped, 280 clamp), body.
// ---------------------------------------------------------------------------

test('buildRedditContent: title = first sentence with hashtags stripped', () => {
  const { title, body } = buildRedditContent('Our new drop is here #sale #new\n\nBody text follows.');
  assert.equal(title, 'Our new drop is here');
  assert.equal(body, 'Our new drop is here #sale #new\n\nBody text follows.');
});

test('buildRedditContent: title clamped to 280 chars', () => {
  const longTitle = 'a'.repeat(400);
  const { title } = buildRedditContent(longTitle);
  assert.ok(title.length <= 280, `title length ${title.length} <= 280`);
  assert.ok(title.endsWith('…'));
});

test('buildRedditContent: title never empty (falls back to a stable label)', () => {
  const { title } = buildRedditContent('#only #hashtags #here');
  assert.equal(title, 'New post');
  const { title: t2 } = buildRedditContent('');
  assert.equal(t2, 'New post');
});

test('buildRedditContent: body preserves the full caption', () => {
  const caption = 'Hook.\n\nA longer body.\n\n#tag';
  const { body } = buildRedditContent(caption);
  assert.equal(body, caption);
});

// ---------------------------------------------------------------------------
// adaptCaptionForPlatform — the per-row caption the synthesis inserts.
// ---------------------------------------------------------------------------

test('adaptCaptionForPlatform: x delegates to buildXCaption', () => {
  assert.equal(
    adaptCaptionForPlatform('x', 'Hook here. Body.', ['#a', '#b', '#c']),
    'Hook here. #a #b',
  );
});

test('adaptCaptionForPlatform: linkedin delegates to buildLinkedInCaption', () => {
  const c = 'Full caption\n\nwith body';
  assert.equal(adaptCaptionForPlatform('linkedin', c), c);
});

test('adaptCaptionForPlatform: reddit serializes title then blank line then body', () => {
  const out = adaptCaptionForPlatform('reddit', 'Our drop #sale\n\nBody here.');
  // First non-empty line is the clean title the reddit publisher will read.
  assert.equal(out.split(/\r?\n/)[0], 'Our drop');
  assert.ok(out.includes('\n\n'), 'title and body separated by a blank line');
  assert.ok(out.endsWith('Body here.'), 'full body preserved');
});

test('adaptCaptionForPlatform: reddit with empty body still yields a title', () => {
  const out = adaptCaptionForPlatform('reddit', '');
  assert.equal(out, 'New post');
});

// ---------------------------------------------------------------------------
// resolveCrosspostPlatforms — flag + connected-account gating, fail-open.
// ---------------------------------------------------------------------------

// Every crosspost platform needs its COMPOSIO_<P>_PUBLISH_POST_ACTION slug, and
// weekly X image rows also need COMPOSIO_X_UPLOAD_MEDIA_ACTION. The publisher's
// requireSlug throws without them, so the producer skips the platform rather
// than manufacture rows that fail terminally at every dispatch.
const PUBLISH_SLUGS = {
  COMPOSIO_ENABLED: 'true',
  COMPOSIO_X_PUBLISH_POST_ACTION: 'TWITTER_CREATION_OF_A_POST',
  COMPOSIO_X_UPLOAD_MEDIA_ACTION: 'TWITTER_UPLOAD_MEDIA',
  COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
  COMPOSIO_REDDIT_PUBLISH_POST_ACTION: 'REDDIT_CREATE_REDDIT_POST',
};

// Reddit needs BOTH its rollout flag and an explicit target subreddit — the
// publisher hard-refuses without one, so the producer skips it. "All flags on"
// therefore has to include the subreddit to keep reddit in the eligible set.
const ALL_FLAGS_ON = {
  ...PUBLISH_SLUGS,
  ARIES_X_ENABLED: '1',
  ARIES_LINKEDIN_ENABLED: '1',
  ARIES_REDDIT_ENABLED: '1',
  COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test',
};

function fakePool(
  rows: Array<{
    platform: string;
    connected_account_id?: string | null;
    external_account_id?: string | null;
  }>,
  opts: { throwOnQuery?: boolean } = {},
) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (opts.throwOnQuery) return Promise.reject(new Error('db down'));
      const normalizedRows = rows.map((row) => ({
        ...row,
        connected_account_id:
          row.connected_account_id === undefined ? 'ca_test' : row.connected_account_id,
      }));
      return Promise.resolve({ rows: normalizedRows, rowCount: normalizedRows.length });
    },
  };
}

test('resolveCrosspostPlatforms: returns the intersection of flag-ON and connected', async () => {
  // All flags ON but only x + reddit connected => linkedin excluded.
  const pool = fakePool([{ platform: 'x' }, { platform: 'reddit' }]);
  const out = await resolveCrosspostPlatforms(15, pool, ALL_FLAGS_ON);
  assert.deepEqual(out, ['x', 'reddit']);
  // Preserves CROSSPOST_PLATFORMS order.
  assert.equal(CROSSPOST_PLATFORMS.indexOf('x') < CROSSPOST_PLATFORMS.indexOf('reddit'), true);
});

test('resolveCrosspostPlatforms: COMPOSIO_ENABLED unset excludes every Composio-only platform', async () => {
  const pool = fakePool([{ platform: 'x' }, { platform: 'linkedin' }, { platform: 'reddit' }]);
  const { COMPOSIO_ENABLED: _, ...composioOff } = ALL_FLAGS_ON;
  const out = await resolveCrosspostPlatforms(15, pool, composioOff);
  assert.deepEqual(out, []);
  assert.equal(pool.calls.length, 0, 'nothing dispatchable → no connection query');
});

test('resolveCrosspostPlatforms: a missing or blank connected_account_id is not dispatchable', async () => {
  for (const connectedAccountId of [null, '', '   ']) {
    const pool = fakePool([{ platform: 'x', connected_account_id: connectedAccountId }]);
    const out = await resolveCrosspostPlatforms(15, pool, ALL_FLAGS_ON);
    assert.deepEqual(out, []);
  }
});

test('resolveCrosspostPlatforms: a flag-OFF platform is excluded even if connected', async () => {
  const pool = fakePool([{ platform: 'x' }, { platform: 'linkedin' }, { platform: 'reddit' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    ...PUBLISH_SLUGS,
    ARIES_X_ENABLED: '1',
    ARIES_LINKEDIN_ENABLED: '0', // OFF
    ARIES_REDDIT_ENABLED: '1',
    COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'r/test',
  });
  assert.deepEqual(out, ['x', 'reddit']);
  // The query is scoped to the flag-enabled platforms only ($2 = ['x','reddit']).
  assert.deepEqual(pool.calls[0].params?.[1], ['x', 'reddit']);
});

test('resolveCrosspostPlatforms: no connected account => excluded', async () => {
  const pool = fakePool([{ platform: 'x' }]); // only x connected
  const out = await resolveCrosspostPlatforms(15, pool, ALL_FLAGS_ON);
  assert.deepEqual(out, ['x']);
});

test('resolveCrosspostPlatforms: all flags OFF => [] with no DB query', async () => {
  const pool = fakePool([{ platform: 'x' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {});
  assert.deepEqual(out, []);
  assert.equal(pool.calls.length, 0, 'no query when nothing is flag-enabled');
});

test('resolveCrosspostPlatforms: DB error fails open to []', async () => {
  const pool = fakePool([], { throwOnQuery: true });
  const out = await resolveCrosspostPlatforms(15, pool, ALL_FLAGS_ON);
  assert.deepEqual(out, [], 'a DB error must never break synthesis — fail open to []');
});

// ── reddit config gate (COMPOSIO_REDDIT_TARGET_SUBREDDIT) ───────────────────
// The publisher throws ComposioCapabilityMissingError without a subreddit and
// there is no u_<username> fallback, so synthesizing reddit rows here would
// manufacture posts guaranteed to fail terminally at dispatch, every week.

test('resolveCrosspostPlatforms: reddit is skipped when COMPOSIO_REDDIT_TARGET_SUBREDDIT is unset', async () => {
  const pool = fakePool([
    { platform: 'x' },
    { platform: 'linkedin', external_account_id: 'urn:li:person:test' },
    { platform: 'reddit' },
  ]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    ...PUBLISH_SLUGS,
    ARIES_X_ENABLED: '1',
    ARIES_LINKEDIN_ENABLED: '1',
    ARIES_REDDIT_ENABLED: '1', // flag ON, but no subreddit configured
  });
  assert.deepEqual(out, ['x', 'linkedin'], 'reddit dropped despite flag ON and account connected');
  assert.deepEqual(pool.calls[0].params?.[1], ['x', 'linkedin'], 'the query is scoped to the surviving platforms');
});

test('resolveCrosspostPlatforms: LinkedIn without an author URN is not dispatchable', async () => {
  const pool = fakePool([{ platform: 'linkedin', external_account_id: null }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_LINKEDIN_ENABLED: '1',
    COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
  });
  assert.deepEqual(out, [], 'publisher requires connected_accounts.external_account_id');
});

test('resolveCrosspostPlatforms: whitespace-only LinkedIn author URN is not dispatchable', async () => {
  const pool = fakePool([{ platform: 'linkedin', external_account_id: '   ' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_LINKEDIN_ENABLED: '1',
    COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: 'LINKEDIN_CREATE_LINKED_IN_POST',
  });
  assert.deepEqual(out, []);
});

test('resolveCrosspostPlatforms: a whitespace-only subreddit counts as unset', async () => {
  const pool = fakePool([{ platform: 'reddit' }, { platform: 'x' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    ...PUBLISH_SLUGS,
    ARIES_X_ENABLED: '1',
    ARIES_REDDIT_ENABLED: '1',
    COMPOSIO_REDDIT_TARGET_SUBREDDIT: '   ',
  });
  assert.deepEqual(out, ['x']);
});

test('resolveCrosspostPlatforms: reddit-only with no subreddit => [] and no DB query', async () => {
  const pool = fakePool([{ platform: 'reddit' }]);
  const out = await resolveCrosspostPlatforms(15, pool, { ...PUBLISH_SLUGS, ARIES_REDDIT_ENABLED: '1' });
  assert.deepEqual(out, []);
  assert.equal(pool.calls.length, 0, 'nothing eligible → the early return still short-circuits the query');
});

test('resolveCrosspostPlatforms: reddit IS included once the subreddit is set (happy-path guard)', async () => {
  const pool = fakePool([{ platform: 'reddit' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    ...PUBLISH_SLUGS,
    ARIES_REDDIT_ENABLED: '1',
    COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'somecommunity',
  });
  assert.deepEqual(out, ['reddit']);
});

// ── publish action-slug config gate (COMPOSIO_<P>_PUBLISH_POST_ACTION) ──────
// Same class of guarantee as the reddit subreddit gate. docker-compose declares
// these with an EMPTY default and actionSlug() has no code fallback, so a
// deployment can have ARIES_LINKEDIN_ENABLED=true with no slug — in which case
// requireSlug throws ComposioCapabilityMissingError at EVERY dispatch. Under
// AA-217 that would let a LinkedIn-only tenant pass the publish gate and
// synthesize a full week of posts that all fail terminally.

test('resolveCrosspostPlatforms: a platform with no publish action slug is skipped', async () => {
  const pool = fakePool([{ platform: 'x' }, { platform: 'linkedin' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_X_ENABLED: '1',
    ARIES_LINKEDIN_ENABLED: '1',
    // x has a slug; linkedin does NOT.
    COMPOSIO_X_PUBLISH_POST_ACTION: 'TWITTER_CREATION_OF_A_POST',
    COMPOSIO_X_UPLOAD_MEDIA_ACTION: 'TWITTER_UPLOAD_MEDIA',
  });
  assert.deepEqual(out, ['x'], 'linkedin dropped despite flag ON and account connected');
  assert.deepEqual(pool.calls[0].params?.[1], ['x'], 'the query is scoped to the surviving platforms');
});

test('resolveCrosspostPlatforms: X is skipped when its image upload action slug is missing', async () => {
  const pool = fakePool([{ platform: 'x' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_X_ENABLED: '1',
    COMPOSIO_X_PUBLISH_POST_ACTION: 'TWITTER_CREATION_OF_A_POST',
  });
  assert.deepEqual(out, [], 'weekly X rows always carry an image and require upload_media');
  assert.equal(pool.calls.length, 0, 'nothing dispatchable → no connection query');
});

test('resolveCrosspostPlatforms: a whitespace-only publish slug counts as unset', async () => {
  const pool = fakePool([{ platform: 'linkedin' }]);
  const out = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_LINKEDIN_ENABLED: '1',
    COMPOSIO_LINKEDIN_PUBLISH_POST_ACTION: '   ',
  });
  assert.deepEqual(out, []);
  assert.equal(pool.calls.length, 0, 'nothing eligible → no query');
});

test('resolveCrosspostPlatforms: reddit needs BOTH its subreddit and its publish slug', async () => {
  const pool = fakePool([{ platform: 'reddit' }]);
  // Subreddit set, slug missing.
  const noSlug = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_REDDIT_ENABLED: '1',
    COMPOSIO_REDDIT_TARGET_SUBREDDIT: 'somecommunity',
  });
  assert.deepEqual(noSlug, [], 'a configured subreddit does not compensate for a missing slug');
  // Slug set, subreddit missing.
  const noSubreddit = await resolveCrosspostPlatforms(15, pool, {
    COMPOSIO_ENABLED: 'true',
    ARIES_REDDIT_ENABLED: '1',
    COMPOSIO_REDDIT_PUBLISH_POST_ACTION: 'REDDIT_CREATE_REDDIT_POST',
  });
  assert.deepEqual(noSubreddit, [], 'a configured slug does not compensate for a missing subreddit');
});

test('resolveCrosspostPlatforms: single query, no fan-out (guardrail #1)', async () => {
  const pool = fakePool([{ platform: 'x' }, { platform: 'linkedin' }, { platform: 'reddit' }]);
  await resolveCrosspostPlatforms(15, pool, ALL_FLAGS_ON);
  assert.equal(pool.calls.length, 1, 'exactly one connected_accounts query');
  assert.match(pool.calls[0].sql, /FROM connected_accounts/i);
  assert.match(pool.calls[0].sql, /status = 'connected'/i);
});
