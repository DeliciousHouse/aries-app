import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QA_SESSION_DEFAULT_TTL_MINUTES,
  QA_SESSION_MAX_TTL_MINUTES,
  QA_TENANT_SLUG,
  QA_USER_EMAIL,
  assertQaScoped,
  buildQaTokenClaims,
  buildSessionCookieJson,
  clampTtlMinutes,
  sessionCookieNameForBaseUrl,
} from '../scripts/qa/qa-session-lib';

const QA_ROW = {
  user_id: 42,
  email: QA_USER_EMAIL,
  full_name: 'Aries QA Bot',
  tenant_id: 99,
  tenant_slug: QA_TENANT_SLUG,
  role: 'tenant_admin',
  active_membership_count: 1,
};

test('INVARIANT: minting is pinned to the sandbox identity — everything else fails closed', () => {
  assert.deepEqual(assertQaScoped(QA_ROW), { ok: true });
  // A real user's email can never mint.
  assert.equal(assertQaScoped({ ...QA_ROW, email: 'brendan3394@gmail.com' }).ok, false);
  // The QA user reassigned onto a REAL tenant can never mint.
  assert.equal(assertQaScoped({ ...QA_ROW, tenant_slug: 'sugar-leather' }).ok, false);
  assert.equal(assertQaScoped({ ...QA_ROW, tenant_slug: null }).ok, false);
  assert.equal(assertQaScoped({ ...QA_ROW, tenant_id: null }).ok, false);
});

test('INVARIANT: the QA bot must hold EXACTLY ONE active membership (multi-workspace CEO hardening 10)', () => {
  // A second membership would let the bot switch/resolve into a real tenant
  // once the multi-workspace flag is on — fail closed.
  assert.equal(assertQaScoped({ ...QA_ROW, active_membership_count: 2 }).ok, false);
  assert.equal(assertQaScoped({ ...QA_ROW, active_membership_count: 0 }).ok, false);
  // pg may surface COUNT as a string on some paths; the guard normalizes.
  assert.deepEqual(assertQaScoped({ ...QA_ROW, active_membership_count: '1' }), { ok: true });
  assert.equal(assertQaScoped({ ...QA_ROW, active_membership_count: '3' }).ok, false);
});

test('TTL clamps: garbage/zero → default, oversize → 12h ceiling', () => {
  assert.equal(clampTtlMinutes(undefined), QA_SESSION_DEFAULT_TTL_MINUTES);
  assert.equal(clampTtlMinutes(Number.NaN), QA_SESSION_DEFAULT_TTL_MINUTES);
  assert.equal(clampTtlMinutes(0), QA_SESSION_DEFAULT_TTL_MINUTES);
  assert.equal(clampTtlMinutes(-5), QA_SESSION_DEFAULT_TTL_MINUTES);
  assert.equal(clampTtlMinutes(45.9), 45);
  assert.equal(clampTtlMinutes(10_000), QA_SESSION_MAX_TTL_MINUTES);
});

test('cookie name matches Auth.js defaults per scheme (name doubles as JWT salt)', () => {
  assert.equal(
    sessionCookieNameForBaseUrl('https://aries.sugarandleather.com'),
    '__Secure-authjs.session-token',
  );
  assert.equal(sessionCookieNameForBaseUrl('http://localhost:3000'), 'authjs.session-token');
});

test('token claims mirror the auth.ts jwt-callback shape', () => {
  const claims = buildQaTokenClaims(QA_ROW);
  assert.deepEqual(claims, {
    sub: '42',
    userId: '42',
    email: QA_USER_EMAIL,
    name: 'Aries QA Bot',
    tenantId: '99',
    tenantSlug: QA_TENANT_SLUG,
    tenantRole: 'tenant_admin',
  });
});

test('cookie JSON targets the app host with secure/httpOnly and a real expiry', () => {
  const nowMs = 1_800_000_000_000;
  const [cookie] = buildSessionCookieJson('https://aries.sugarandleather.com', 'tok', 60, nowMs);
  assert.equal(cookie.name, '__Secure-authjs.session-token');
  assert.equal(cookie.value, 'tok');
  assert.equal(cookie.domain, 'aries.sugarandleather.com');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.expires, nowMs / 1000 + 3600);
});
