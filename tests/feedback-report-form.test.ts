import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JIRA_BROWSE_PREFIX,
  buildReportSubmitBody,
  outcomeFromResponse,
  screenshotPayloadFromDataUrl,
  ticketUrlForKey,
  validateReportForm,
} from '../frontend/feedback/report-form';

test('client validation blocks the POST: impact required, title/description bounded', () => {
  assert.ok(
    validateReportForm({ impact: null, category: 'bug', title: 't', description: 'd' }).impact,
  );
  assert.ok(
    validateReportForm({
      impact: 'p2_feature_degraded',
      category: 'bug',
      title: '   ',
      description: 'd',
    }).title,
  );
  assert.ok(
    validateReportForm({
      impact: 'p2_feature_degraded',
      category: 'bug',
      title: 'x'.repeat(256),
      description: 'd',
    }).title,
  );
  assert.ok(
    validateReportForm({
      impact: 'p2_feature_degraded',
      category: 'bug',
      title: 't',
      description: 'y'.repeat(10_001),
    }).description,
  );
  assert.deepEqual(
    validateReportForm({
      impact: 'p2_feature_degraded',
      category: 'bug',
      title: 't',
      description: 'd',
    }),
    {},
  );
});

test('INVARIANT: the POST body contains no identity or tenant fields', () => {
  const body = buildReportSubmitBody(
    { impact: 'p1_account_blocked', category: 'bug', title: ' t ', description: ' d ' },
    { base64: 'AAAA', mime: 'image/png' },
  );
  assert.deepEqual(Object.keys(body).sort(), [
    'category',
    'description',
    'impact',
    'screenshot',
    'title',
  ]);
  assert.equal(body.title, 't');
  assert.equal(body.description, 'd');
  const serialized = JSON.stringify(body);
  for (const banned of ['tenant', 'user', 'email', 'submitter', 'priority', 'label']) {
    assert.ok(!serialized.toLowerCase().includes(banned), `body must not carry "${banned}"`);
  }
});

test('attach round-trip: data URL becomes { base64, mime } in the POST payload', () => {
  const result = screenshotPayloadFromDataUrl('data:image/webp;base64,UklGRgAA');
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.payload, { base64: 'UklGRgAA', mime: 'image/webp' });
  }
});

test('over-cap file is rejected inline via base64-length math (no decode)', () => {
  // ~2.1 MB decoded — over the 2,000,000-byte cap.
  const bigBase64 = 'A'.repeat(Math.ceil((2_100_000 * 4) / 3));
  const result = screenshotPayloadFromDataUrl(`data:image/png;base64,${bigBase64}`);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /2 MB or smaller/);
});

test('unsupported mime and malformed data URLs are inline errors', () => {
  const gif = screenshotPayloadFromDataUrl('data:image/gif;base64,R0lGODdh');
  assert.ok(!gif.ok);
  const garbage = screenshotPayloadFromDataUrl('not-a-data-url');
  assert.ok(!garbage.ok);
});

test('ticket URL is the fixed https prefix + validated server key ONLY', () => {
  assert.equal(JIRA_BROWSE_PREFIX, 'https://sugarandleather.atlassian.net/browse/');
  assert.equal(ticketUrlForKey('AA-123'), 'https://sugarandleather.atlassian.net/browse/AA-123');
  // Anything that isn't a well-formed key never becomes an href.
  for (const evil of ['javascript:alert(1)', 'AA-1"onmouseover', '../evil', 'aa-1', '']) {
    assert.equal(ticketUrlForKey(evil), null);
  }
});

test('201 with key maps to success with the pinned href; pending_retry appends attach note', () => {
  const done = outcomeFromResponse(201, {
    jira_ticket_key: 'AA-55',
    status: 'synced',
    screenshot_discarded: null,
  });
  assert.equal(done.kind, 'success');
  if (done.kind === 'success') {
    assert.equal(done.ticketUrl, 'https://sugarandleather.atlassian.net/browse/AA-55');
    assert.ok(done.message.includes('AA-55'));
    assert.ok(!done.message.includes('syncing'));
  }

  const attaching = outcomeFromResponse(201, {
    jira_ticket_key: 'AA-56',
    status: 'pending_retry',
    screenshot_discarded: null,
  });
  assert.equal(attaching.kind, 'success');
  if (attaching.kind === 'success') {
    assert.ok(attaching.message.includes('attachment is still syncing'));
  }
});

test('202 maps to received-syncing; screenshot_discarded reason is appended', () => {
  const received = outcomeFromResponse(202, {
    jira_ticket_key: null,
    status: 'pending_retry',
    screenshot_discarded: null,
  });
  assert.equal(received.kind, 'received');
  assert.ok(received.message.includes('syncing to our tracker'));

  const discarded = outcomeFromResponse(201, {
    jira_ticket_key: 'AA-57',
    status: 'synced',
    screenshot_discarded: 'too_large',
  });
  assert.ok(discarded.message.includes('too large'));
});

test('429 keeps the server message; network/5xx map to a generic retryable error', () => {
  const limited = outcomeFromResponse(429, { error: 'Too many reports in the last hour.' });
  assert.equal(limited.kind, 'rate_limited');
  assert.equal(limited.message, 'Too many reports in the last hour.');

  const fallback = outcomeFromResponse(429, null);
  assert.equal(fallback.kind, 'rate_limited');

  for (const status of [500, 502, 400, 401]) {
    assert.equal(outcomeFromResponse(status, null).kind, 'error');
  }
});
