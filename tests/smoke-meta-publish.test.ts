import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublishRouteUrl,
  buildSignedPublicUrl,
  pickBestCaption,
} from '../scripts/smoke-meta-publish';

test('buildPublishRouteUrl builds instagram URL correctly', () => {
  const url = buildPublishRouteUrl('https://aries.sugarandleather.com', 'mkt_abc123', 'instagram');
  assert.equal(url, 'https://aries.sugarandleather.com/api/marketing/jobs/mkt_abc123/publish-instagram');
});

test('buildPublishRouteUrl builds facebook URL correctly', () => {
  const url = buildPublishRouteUrl('https://aries.example.com/', 'mkt_xyz789', 'facebook');
  assert.equal(url, 'https://aries.example.com/api/marketing/jobs/mkt_xyz789/publish-facebook');
});

test('buildPublishRouteUrl encodes jobId with special chars', () => {
  const url = buildPublishRouteUrl('https://example.com', 'mkt_a/b', 'instagram');
  assert.ok(url.includes('mkt_a%2Fb'), `expected encoded jobId in: ${url}`);
});

test('buildSignedPublicUrl produces a token URL with expected shape', () => {
  const signedUrl = buildSignedPublicUrl({
    mediaUrl: '/tmp/aries-data/generated/draft/assets/img_001.jpg',
    tenantId: '16',
    appBase: 'https://aries.sugarandleather.com',
    secret: 'test-secret-32-chars-padded-here',
  });

  assert.ok(signedUrl.startsWith('https://aries.sugarandleather.com/api/public/media/'), `unexpected prefix: ${signedUrl}`);
  assert.ok(signedUrl.endsWith('/img_001.jpg'), `expected basename at end: ${signedUrl}`);
  const parts = signedUrl.split('/');
  const tokenPart = parts[parts.length - 2];
  assert.ok(typeof tokenPart === 'string' && tokenPart.length > 0, 'token segment should be non-empty');
  assert.doesNotMatch(tokenPart ?? '', /[+/=]/, 'token should be URL-safe base64');
});

test('buildSignedPublicUrl strips trailing slash from appBase', () => {
  const signed = buildSignedPublicUrl({
    mediaUrl: '/hermes-media/img.png',
    tenantId: '1',
    appBase: 'https://example.com/',
    secret: 'secret',
  });
  assert.ok(!signed.includes('//api'), `double-slash in: ${signed}`);
});

test('pickBestCaption returns instagram_feed caption with hashtags', () => {
  const socialCopy = {
    posts: [
      { channel: 'instagram_feed', caption: 'Hello world', hashtags: ['#tag1', '#tag2'] },
      { channel: 'facebook_feed', caption: 'FB caption', hashtags: [] },
    ],
  };
  const result = pickBestCaption(socialCopy, 'instagram');
  assert.equal(result, 'Hello world\n\n#tag1 #tag2');
});

test('pickBestCaption returns facebook_feed caption for facebook provider', () => {
  const socialCopy = {
    posts: [
      { channel: 'instagram_feed', caption: 'IG caption', hashtags: [] },
      { channel: 'facebook_feed', caption: 'FB hello', hashtags: ['#fb'] },
    ],
  };
  const result = pickBestCaption(socialCopy, 'facebook');
  assert.equal(result, 'FB hello\n\n#fb');
});

test('pickBestCaption returns empty string when no matching channel', () => {
  const socialCopy = {
    posts: [
      { channel: 'twitter', caption: 'tweet', hashtags: [] },
    ],
  };
  assert.equal(pickBestCaption(socialCopy, 'instagram'), '');
});

test('pickBestCaption returns empty string for null socialCopy', () => {
  assert.equal(pickBestCaption(null, 'instagram'), '');
});

test('pickBestCaption omits hashtag block when hashtags array is empty', () => {
  const socialCopy = {
    posts: [{ channel: 'instagram_feed', caption: 'Clean caption', hashtags: [] }],
  };
  assert.equal(pickBestCaption(socialCopy, 'instagram'), 'Clean caption');
});
