import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clientIpFromHeaders,
  hashIp,
  normalizeClientContext,
  normalizeSubmissionId,
  parseScreenshot,
  redactSecrets,
  sanitizePageUrl,
  validateSubmission,
} from '@/lib/feedback/submission';
import { FEEDBACK_LIMITS } from '@/lib/feedback/options';

// A 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

test('validateSubmission accepts a minimal valid body', () => {
  const result = validateSubmission({
    submissionId: 'fb_0123456789abcdef',
    comment: '  Login button does nothing  ',
    category: 'Login issue',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.comment, 'Login button does nothing'); // trimmed
  assert.equal(result.value.category, 'Login issue');
  assert.equal(result.value.submissionId, 'fb_0123456789abcdef');
  assert.equal(result.value.screenshot, null);
});

test('validateSubmission ignores any client-sent severity (inferred server-side)', () => {
  const result = validateSubmission({ comment: 'hi', category: 'Bug', severity: 'Blocker' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(!('severity' in result.value)); // severity is not part of validated input
});

test('validateSubmission requires a non-empty comment', () => {
  const result = validateSubmission({ comment: '   ', category: 'Bug' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fieldErrors.comment);
  assert.equal(result.error, 'invalid_input');
});

test('validateSubmission rejects an unknown category', () => {
  const result = validateSubmission({ comment: 'hi', category: 'Nonsense' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fieldErrors.category);
});

test('validateSubmission mints a submission id when the client one is malformed', () => {
  const result = validateSubmission({
    submissionId: 'not-a-valid-id',
    comment: 'hi',
    category: 'Bug',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value.submissionId, /^fb_[a-f0-9]{16}$/);
});

test('validateSubmission accepts a valid screenshot data URL', () => {
  const result = validateSubmission({
    comment: 'see attached',
    category: 'Bug',
    screenshot: PNG_DATA_URL,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.value.screenshot);
  assert.equal(result.value.screenshot?.mime, 'image/png');
  assert.ok((result.value.screenshot?.bytes.length ?? 0) > 0);
});

test('parseScreenshot returns null for absent screenshot', () => {
  const r = parseScreenshot(undefined);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.screenshot, null);
});

test('parseScreenshot rejects unsupported mime types', () => {
  const r = parseScreenshot('data:application/pdf;base64,AAAA');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, 'screenshot_unsupported_type');
});

test('parseScreenshot rejects oversized images', () => {
  const big = 'A'.repeat(Math.ceil((FEEDBACK_LIMITS.screenshotBytesMax + 1024) / 3) * 4);
  const r = parseScreenshot(`data:image/png;base64,${big}`);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, 'screenshot_too_large');
});

test('parseScreenshot accepts the { dataUrl } object form', () => {
  const r = parseScreenshot({ dataUrl: PNG_DATA_URL });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.screenshot?.mime, 'image/png');
});

test('normalizeClientContext clamps console errors and field lengths', () => {
  const ctx = normalizeClientContext({
    pageUrl: 'https://aries.example.com/dashboard',
    userAgent: 'Chrome',
    viewport: '1920x1080',
    consoleErrors: Array.from({ length: 100 }, (_, i) => `err ${i}`),
  });
  assert.equal(ctx.pageUrl, 'https://aries.example.com/dashboard');
  assert.equal(ctx.viewport, '1920x1080');
  assert.equal(ctx.consoleErrors.length, FEEDBACK_LIMITS.consoleErrorsMax);
  // keeps the most recent (tail) errors
  assert.equal(ctx.consoleErrors.at(-1), 'err 99');
});

test('normalizeClientContext tolerates a missing/garbage context', () => {
  const ctx = normalizeClientContext(null);
  assert.deepEqual(ctx, { pageUrl: null, userAgent: null, viewport: null, consoleErrors: [] });
});

test('normalizeSubmissionId preserves a valid high-entropy client id', () => {
  assert.equal(normalizeSubmissionId('fb_deadbeefdeadbeef'), 'fb_deadbeefdeadbeef');
});

test('normalizeSubmissionId rejects a too-short (guessable) client id', () => {
  // Short ids would weaken the screenshot access token + overwrite protection.
  assert.match(normalizeSubmissionId('fb_abc'), /^fb_[a-f0-9]{16}$/);
});

test('sanitizePageUrl redacts secret query params and drops the fragment', () => {
  const out = sanitizePageUrl('https://aries.example.com/reset?token=abc123&email=a@b.com&view=grid#x');
  assert.match(out, /token=REDACTED/);
  assert.match(out, /email=REDACTED/);
  assert.match(out, /view=grid/); // benign params kept
  assert.ok(!out.includes('#x')); // fragment dropped
  assert.ok(!out.includes('abc123'));
});

test('redactSecrets scrubs JWTs, bearer assignments, emails, and long hex', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFghiJKL';
  assert.ok(!redactSecrets(`auth failed ${jwt}`).includes(jwt));
  assert.ok(!redactSecrets('Authorization: Bearer sk-livesecret').includes('sk-livesecret'));
  assert.ok(!redactSecrets('user bob@example.com failed').includes('bob@example.com'));
  assert.ok(!redactSecrets('hash ' + 'a'.repeat(40)).includes('a'.repeat(40)));
});

test('normalizeClientContext sanitizes the captured page URL', () => {
  const ctx = normalizeClientContext({ pageUrl: 'https://aries.example.com/login?code=secretcode&next=/dash' });
  assert.ok(ctx.pageUrl);
  assert.ok(!ctx.pageUrl!.includes('secretcode'));
  assert.match(ctx.pageUrl!, /code=REDACTED/);
});

test('hashIp is deterministic, hex, and never the raw ip', () => {
  const h1 = hashIp('203.0.113.7');
  const h2 = hashIp('203.0.113.7');
  assert.equal(h1, h2);
  assert.match(h1 ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(h1, '203.0.113.7');
  assert.equal(hashIp(null), null);
});

test('clientIpFromHeaders takes the first x-forwarded-for hop, else x-real-ip', () => {
  const headers = new Headers({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' });
  assert.equal(clientIpFromHeaders(headers), '198.51.100.9');
  assert.equal(clientIpFromHeaders(new Headers({ 'x-real-ip': '203.0.113.5' })), '203.0.113.5');
  assert.equal(clientIpFromHeaders(new Headers()), null);
});
