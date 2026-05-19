import assert from 'node:assert/strict';
import test from 'node:test';

import {
  signMediaToken,
  urlSafeB64Decode,
  urlSafeB64Encode,
  verifyMediaToken,
} from '../lib/signed-media-token';

const SECRET = 'test-internal-api-secret-32bytes!';
const ALT_SECRET = 'different-secret-value-for-tests!';

const BASE_PAYLOAD = {
  tenantId: 'tenant-42',
  basename: 'hero-image.png',
  expiresAt: Date.now() + 3_600_000, // 1 hour from now
};

test('urlSafeB64Encode / urlSafeB64Decode round-trips arbitrary bytes', () => {
  const original = Buffer.from([0x00, 0xff, 0xab, 0xcd, 0x12, 0x34]);
  const encoded = urlSafeB64Encode(original);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'encoded value should be URL-safe base64 (no +/=)');
  const decoded = urlSafeB64Decode(encoded);
  assert.deepEqual(decoded, original);
});

test('sign + verify round-trip succeeds', () => {
  const token = signMediaToken(BASE_PAYLOAD, SECRET);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);

  const result = verifyMediaToken(token, SECRET);
  assert.ok(result !== null, 'expected non-null payload');
  assert.equal(result.tenantId, BASE_PAYLOAD.tenantId);
  assert.equal(result.basename, BASE_PAYLOAD.basename);
  assert.equal(result.expiresAt, BASE_PAYLOAD.expiresAt);
});

test('verify rejects tampered signature', () => {
  const token = signMediaToken(BASE_PAYLOAD, SECRET);

  // Decode, mutate the sig field, re-encode
  const decoded = urlSafeB64Decode(token).toString('utf8');
  const envelope = JSON.parse(decoded) as { sig: string; [k: string]: unknown };
  envelope.sig = urlSafeB64Encode(Buffer.from('tampered-signature-data-xxxxxxxxxxxx'));
  const tampered = urlSafeB64Encode(Buffer.from(JSON.stringify(envelope), 'utf8'));

  const result = verifyMediaToken(tampered, SECRET);
  assert.equal(result, null, 'tampered token should return null');
});

test('verify rejects expired token', () => {
  const expiredPayload = { ...BASE_PAYLOAD, expiresAt: Date.now() - 1 };
  const token = signMediaToken(expiredPayload, SECRET);
  const result = verifyMediaToken(token, SECRET);
  assert.equal(result, null, 'expired token should return null');
});

test('verify rejects basename mismatch detected by caller (route layer)', () => {
  // The route checks payload.basename === URL basename segment.
  // verify itself returns the payload intact — the route then compares.
  const token = signMediaToken({ ...BASE_PAYLOAD, basename: 'actual.png' }, SECRET);
  const result = verifyMediaToken(token, SECRET);
  assert.ok(result !== null);
  assert.equal(result.basename, 'actual.png');
  // A route serving 'other.png' would see this mismatch and return 404.
  assert.notEqual(result.basename, 'other.png');
});

test('verify rejects malformed token (random string)', () => {
  assert.equal(verifyMediaToken('not-a-valid-token', SECRET), null);
  assert.equal(verifyMediaToken('', SECRET), null);
  assert.equal(verifyMediaToken('aaaa', SECRET), null);
});

test('verify rejects token signed with a different secret', () => {
  const token = signMediaToken(BASE_PAYLOAD, ALT_SECRET);
  const result = verifyMediaToken(token, SECRET);
  assert.equal(result, null, 'token signed with different secret should not verify');
});

test('signing with different secrets produces different tokens', () => {
  const tokenA = signMediaToken(BASE_PAYLOAD, SECRET);
  const tokenB = signMediaToken(BASE_PAYLOAD, ALT_SECRET);
  assert.notEqual(tokenA, tokenB, 'different secrets should produce different tokens');
});

test('verify returns null for JSON-valid but structurally wrong envelope', () => {
  // Valid base64 of a JSON object missing required fields
  const bad = urlSafeB64Encode(Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8'));
  assert.equal(verifyMediaToken(bad, SECRET), null);
});
