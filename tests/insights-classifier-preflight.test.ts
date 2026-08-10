/**
 * tests/insights-classifier-preflight.test.ts
 *
 * The boot-time gateway probe (probeClassifierGateway) and the gateway-origin
 * helper the failure details now carry.
 *
 * BACKGROUND: `classifyComments: unreachable (fetch failed)` appeared on every
 * insights sync and named nothing. The cause was that the sync sidecar carried
 * HERMES_GATEWAY_URL=http://host.docker.internal:8642 but not the
 * `host.docker.internal:host-gateway` extra_hosts mapping that makes that name
 * resolvable — the mapping was declared on aries-app only. A failure that names
 * the host it could not reach is the difference between a five-minute fix and a
 * symptom nobody could act on; a probe at container start is the difference
 * between finding out now and finding out 30 minutes later inside a `partial`
 * run's error_message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGatewayOrigin,
  probeClassifierGateway,
} from '@/backend/insights/sync/classify-comments';

const ENV = {
  ARIES_COMMENT_CLASSIFICATION_ENABLED: '1',
  HERMES_GATEWAY_URL: 'http://host.docker.internal:8642',
  HERMES_API_SERVER_KEY: 'super-secret-key',
};

test('classifyGatewayOrigin returns host:port and never the API key', () => {
  assert.equal(classifyGatewayOrigin(ENV), 'host.docker.internal:8642');
  assert.equal(classifyGatewayOrigin({ HERMES_GATEWAY_URL: 'https://hermes.test' }), 'hermes.test');
  assert.equal(classifyGatewayOrigin({ HERMES_GATEWAY_URL: 'http://127.0.0.1:8651/' }), '127.0.0.1:8651');
  // Unset / unparseable degrade to '' rather than throwing — this runs inside a
  // catch block and at boot.
  assert.equal(classifyGatewayOrigin({}), '');
  assert.equal(classifyGatewayOrigin({ HERMES_GATEWAY_URL: 'not a url' }), '');
  // A URL carrying userinfo must not leak it (url.host excludes credentials).
  const origin = classifyGatewayOrigin({ HERMES_GATEWAY_URL: 'http://user:pw@gw.test:8642' });
  assert.equal(origin, 'gw.test:8642');
  assert.ok(!origin.includes('pw'));
});

test('any HTTP response means reachable — including 404 for the sentinel run id', async () => {
  for (const status of [200, 404, 400, 500]) {
    const res = await probeClassifierGateway({
      env: ENV,
      fetchImpl: async () => new Response('', { status }),
    });
    assert.equal(res.ok, true, `HTTP ${status} should count as reachable`);
  }
});

test('the probe asks for a run id that cannot exist, with a bearer header', async () => {
  const seen: { url?: string; auth?: string; method?: string } = {};
  await probeClassifierGateway({
    env: ENV,
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.method = init?.method;
      seen.auth = new Headers(init?.headers).get('authorization') ?? undefined;
      return new Response('', { status: 404 });
    },
  });
  assert.match(String(seen.url), /^http:\/\/host\.docker\.internal:8642\/v1\/runs\//);
  assert.equal(seen.method, 'GET');
  assert.equal(seen.auth, 'Bearer super-secret-key');
});

test('401/403 is reported as unauthorized, not unreachable (a different fix)', async () => {
  for (const status of [401, 403]) {
    const res = await probeClassifierGateway({
      env: ENV,
      fetchImpl: async () => new Response('', { status }),
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'unauthorized');
    assert.equal(res.detail, `HTTP ${status}`);
  }
});

test('a thrown fetch is unreachable and NAMES the gateway host', async () => {
  const res = await probeClassifierGateway({
    env: ENV,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unreachable');
  assert.match(String(res.detail), /fetch failed/);
  assert.match(String(res.detail), /gateway host\.docker\.internal:8642/);
  // The whole point of the detail string is that it can be logged.
  assert.ok(!String(res.detail).includes('super-secret-key'));
});

test('gate skips are reported distinctly and cost nothing', async () => {
  const explode = async () => { throw new Error('fetch must not be called'); };

  const disabled = await probeClassifierGateway({ env: { ...ENV, ARIES_COMMENT_CLASSIFICATION_ENABLED: '0' }, fetchImpl: explode });
  assert.deepEqual(disabled, { ok: false, reason: 'disabled' });

  const noUrl = await probeClassifierGateway({ env: { ...ENV, HERMES_GATEWAY_URL: '' }, fetchImpl: explode });
  assert.deepEqual(noUrl, { ok: false, reason: 'not_configured' });

  const noKey = await probeClassifierGateway({ env: { ...ENV, HERMES_API_SERVER_KEY: '' }, fetchImpl: explode });
  assert.deepEqual(noKey, { ok: false, reason: 'not_configured' });
});

test('the probe never throws — it is voided at container start', async () => {
  const res = await probeClassifierGateway({
    env: ENV,
    fetchImpl: () => { throw new Error('synchronous explosion'); },
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unreachable');
});
