import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublishRouteUrl,
  buildSignedPublicUrl,
  pickBestCaption,
} from '../scripts/smoke-meta-publish';
import {
  MetaPublishError,
  classifyMetaPublishFailure,
  classifyMetaPublishFailureKind,
} from '../backend/integrations/meta-publishing';

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


// ---------------------------------------------------------------------------
// Publish-handler error-branch decision (P4)
// ---------------------------------------------------------------------------
//
// The fb/ig publish handlers require DB/auth/session to drive end-to-end, so —
// per the repo convention (publish-handler-caption-fallback.test.ts) — we pin
// the error-branch DECISION in isolation. This mirrors the branch order in
// publish-facebook/handler.ts and publish-instagram/handler.ts:
//   outcome_unknown -> needs_manual_reconciliation (502, unchanged)
//   auth            -> needs_reconnect (409)  [NEW]
//   other Meta err  -> generic { reason: error.code } at error.status
type HandlerBranch =
  | { kind: 'needs_manual_reconciliation'; status: number }
  | { kind: 'needs_reconnect'; reason: string; status: number }
  | { kind: 'generic'; reason: string; status: number };

function decidePublishHandlerBranch(error: unknown): HandlerBranch {
  if (classifyMetaPublishFailure(error) === 'outcome_unknown') {
    return { kind: 'needs_manual_reconciliation', status: 502 };
  }
  if (error instanceof MetaPublishError && classifyMetaPublishFailureKind(error) === 'auth') {
    return { kind: 'needs_reconnect', reason: 'needs_reconnect', status: error.status };
  }
  if (error instanceof MetaPublishError) {
    return { kind: 'generic', reason: error.code, status: error.status };
  }
  return { kind: 'generic', reason: 'publish_failed', status: 500 };
}

test('publish handler: oauth_token_missing -> needs_reconnect at 409', () => {
  const err = new MetaPublishError('oauth_token_missing', 'token expired', { status: 409 });
  const branch = decidePublishHandlerBranch(err);
  assert.deepEqual(branch, { kind: 'needs_reconnect', reason: 'needs_reconnect', status: 409 });
});

test('publish handler: external_account_missing -> needs_reconnect at 409', () => {
  const err = new MetaPublishError('external_account_missing', 'no page', { status: 409 });
  const branch = decidePublishHandlerBranch(err);
  assert.equal(branch.kind, 'needs_reconnect');
  assert.equal(branch.status, 409);
});

test('publish handler: a transient graph error stays the generic retryable branch (not auth)', () => {
  const err = new MetaPublishError('graph_network_error', 'ETIMEDOUT', { status: 502, retryable: true });
  const branch = decidePublishHandlerBranch(err);
  assert.equal(branch.kind, 'generic');
  assert.equal(branch.reason, 'graph_network_error');
});

test('publish handler: outcome-unknown still wins (needs_manual_reconciliation, 502) — unchanged', () => {
  const err = new MetaPublishError('instagram_publish_missing_id', 'no id', { status: 502, outcomeUnknown: true });
  const branch = decidePublishHandlerBranch(err);
  assert.deepEqual(branch, { kind: 'needs_manual_reconciliation', status: 502 });
});
