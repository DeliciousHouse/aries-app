// PRD §20 invariant 14:
//   "Provider callbacks must be authenticated, schema-validated, tenant-mapped
//    through Aries state, and idempotent."
//
// Operationalized as four properties verified at the unit level via the
// internal callback auth helper, and at the structural level on the Hermes run
// callback route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyInternalCallbackRequest,
  hashCallbackToken,
} from '../../lib/internal-callback-auth';
import { readRepoFile } from './_helpers';

test('verifyInternalCallbackRequest refuses when INTERNAL_API_SECRET is not configured', () => {
  const req = new Request('https://aries.example.com/api/internal/hermes/runs', {
    method: 'POST',
    headers: { authorization: 'Bearer anything' },
  });
  const result = verifyInternalCallbackRequest(req, {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 503);
    assert.equal(result.reason, 'internal_api_secret_not_configured');
  }
});

test('verifyInternalCallbackRequest refuses requests with no Authorization header', () => {
  const req = new Request('https://aries.example.com/api/internal/hermes/runs', {
    method: 'POST',
  });
  const result = verifyInternalCallbackRequest(req, { INTERNAL_API_SECRET: 'sentinel-secret' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.equal(result.reason, 'missing_internal_callback_secret');
  }
});

test('verifyInternalCallbackRequest refuses a wrong secret', () => {
  const req = new Request('https://aries.example.com/api/internal/hermes/runs', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-secret' },
  });
  const result = verifyInternalCallbackRequest(req, { INTERNAL_API_SECRET: 'sentinel-secret' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.reason, 'invalid_internal_callback_secret');
  }
});

test('verifyInternalCallbackRequest accepts the configured secret', () => {
  const req = new Request('https://aries.example.com/api/internal/hermes/runs', {
    method: 'POST',
    headers: { authorization: 'Bearer sentinel-secret' },
  });
  const result = verifyInternalCallbackRequest(req, { INTERNAL_API_SECRET: 'sentinel-secret' });
  assert.equal(result.ok, true);
});

test('callback tokens are sha256-hashed (no plaintext at rest)', () => {
  const hex = hashCallbackToken('some-plaintext-token');
  assert.match(hex, /^[0-9a-f]{64}$/, 'hashCallbackToken must return a 64-char hex sha256 digest');
});

test('Hermes runs callback route enforces all four properties', () => {
  const source = readRepoFile('app/api/internal/hermes/runs/route.ts');
  // (a) authentication via the internal-callback helper
  assert.match(source, /verifyInternalCallbackRequest\(/);
  // (b) schema validation via parser
  assert.match(source, /parseHermesRunCallbackPayload\(/);
  // (c) tenant mapping is implicit in handleHermesRunCallback (looks up
  //     execution_runs row); we assert the route does NOT trust a tenant id
  //     from the request body.
  assert.ok(
    !/body\.(tenantId|tenant_id)/.test(source),
    'Hermes runs callback route must not read tenant id from the request body',
  );
  // (d) idempotency / callback-token verification
  assert.match(source, /verifyCallbackToken\(/);
});
