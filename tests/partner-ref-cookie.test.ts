import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  isValidPartnerRefFormat,
  parsePartnerRefCookie,
  serializePartnerRefCookie,
} from '@/lib/partner-ref-cookie';

const SECRET = 'unit-test-nextauth-secret-at-least-32-chars-long';

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.PARTNER_REF_COOKIE_SECRET;
});

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.PARTNER_REF_COOKIE_SECRET;
});

test('isValidPartnerRefFormat accepts 4–32 alphanum underscore hyphen', () => {
  assert.equal(isValidPartnerRefFormat('ab12'), true);
  assert.equal(isValidPartnerRefFormat('a'.repeat(32)), true);
  assert.equal(isValidPartnerRefFormat('abc'), false);
  assert.equal(isValidPartnerRefFormat('ab cd'), false);
});

test('serialize + parse roundtrip', () => {
  const ref = 'partner9';
  const cookie = serializePartnerRefCookie(ref, SECRET);
  assert.equal(parsePartnerRefCookie(cookie, SECRET), ref);
});

test('parse rejects tampered signature', () => {
  const cookie = serializePartnerRefCookie('goodref', SECRET);
  const tampered = `${cookie.slice(0, -4)}xxxx`;
  assert.equal(parsePartnerRefCookie(tampered, SECRET), null);
});

test('serialize throws when no secret available', () => {
  delete process.env.NEXTAUTH_SECRET;
  assert.throws(() => serializePartnerRefCookie('refcode9'), /NEXTAUTH_SECRET/);
});

test('PARTNER_REF_COOKIE_SECRET overrides NEXTAUTH_SECRET', () => {
  const alt = 'other-secret-at-least-32-characters-x';
  process.env.PARTNER_REF_COOKIE_SECRET = alt;
  const ref = 'ref999';
  const c = serializePartnerRefCookie(ref);
  assert.equal(parsePartnerRefCookie(c, alt), ref);
  assert.equal(parsePartnerRefCookie(c, SECRET), null);
});
