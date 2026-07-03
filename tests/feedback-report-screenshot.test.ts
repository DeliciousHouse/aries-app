import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  preDecodeBase64Cap,
  screenshotFilename,
  validateReportScreenshot,
} from '../backend/feedback/report-screenshot';

const MAX = 2_000_000;

function pngBase64(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

test('valid screenshot decodes and passes through', () => {
  const result = validateReportScreenshot({ base64: pngBase64(1024), mime: 'image/png' }, MAX);
  assert.equal(result.discarded, null);
  assert.equal(result.screenshot?.mime, 'image/png');
  assert.equal(result.screenshot?.bytes.length, 1024);
});

test('absent screenshot is fine (null, no discard)', () => {
  const result = validateReportScreenshot(null, MAX);
  assert.equal(result.screenshot, null);
  assert.equal(result.discarded, null);
});

test('oversized screenshot is discarded with too_large, not rejected', () => {
  const result = validateReportScreenshot(
    { base64: pngBase64(MAX + 1), mime: 'image/png' },
    MAX,
  );
  assert.equal(result.screenshot, null);
  assert.equal(result.discarded, 'too_large');
});

test('bad mime is discarded with unsupported_type (gif is out in v2)', () => {
  const result = validateReportScreenshot({ base64: pngBase64(64), mime: 'image/gif' }, MAX);
  assert.equal(result.discarded, 'unsupported_type');
});

test('garbage base64 is discarded with invalid_base64', () => {
  const result = validateReportScreenshot(
    { base64: '!!!not-base64-at-all!!!', mime: 'image/png' },
    MAX,
  );
  assert.equal(result.discarded, 'invalid_base64');
});

test('non-object / missing fields are discarded with invalid_payload', () => {
  assert.equal(validateReportScreenshot('data:image/png;base64,AAAA', MAX).discarded, 'invalid_payload');
  assert.equal(validateReportScreenshot({ mime: 'image/png' }, MAX).discarded, 'invalid_payload');
  assert.equal(validateReportScreenshot({ base64: 'AAAA' }, MAX).discarded, 'invalid_payload');
});

test('pre-decode cap rejects by string length WITHOUT decoding', (t) => {
  const oversized = 'A'.repeat(preDecodeBase64Cap(MAX) + 1);
  const fromSpy = t.mock.method(Buffer, 'from');
  const result = validateReportScreenshot({ base64: oversized, mime: 'image/png' }, MAX);
  assert.equal(result.discarded, 'too_large');
  // Proof: no Buffer.from call ever saw the oversized payload.
  const sawPayload = fromSpy.mock.calls.some((call) => call.arguments[0] === oversized);
  assert.equal(sawPayload, false);
  mock.restoreAll();
});

test('pre-decode cap formula matches the decoded reality at the boundary', () => {
  // A payload exactly at the cap must decode and pass the decoded-size check.
  const atCap = pngBase64(MAX);
  assert.ok(atCap.length <= preDecodeBase64Cap(MAX));
  const result = validateReportScreenshot({ base64: atCap, mime: 'image/png' }, MAX);
  assert.equal(result.discarded, null);
  assert.equal(result.screenshot?.bytes.length, MAX);
});

test('attachment filename derives from mime', () => {
  assert.equal(screenshotFilename('abc', 'image/png'), 'screenshot-abc.png');
  assert.equal(screenshotFilename('abc', 'image/jpeg'), 'screenshot-abc.jpg');
  assert.equal(screenshotFilename('abc', 'image/webp'), 'screenshot-abc.webp');
});
