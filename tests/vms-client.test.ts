import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { postAriesSignup } from '@/backend/partners/vms-client';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.PARTNER_ATTRIBUTION_ENABLED = 'true';
  process.env.VMS_BASE_URL = 'http://vms.test';
  process.env.VMS_WEBHOOK_SECRET = 'whsec_test';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.PARTNER_ATTRIBUTION_ENABLED;
  delete process.env.VMS_BASE_URL;
  delete process.env.VMS_WEBHOOK_SECRET;
});

test('postAriesSignup returns ok on 201', async () => {
  const fetchMock = mock.fn(async () => new Response('{}', { status: 201 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await postAriesSignup({
    refCode: 'abc1',
    name: 'Test User',
    email: 't@example.com',
    company: 'Co',
    domain: 'example.com',
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail('expected ok');
  }
  assert.equal(result.status, 201);
  assert.equal(fetchMock.mock.calls.length, 1);
  const args = fetchMock.mock.calls[0]?.arguments as unknown[] | undefined;
  assert.ok(Array.isArray(args) && args.length >= 2);
  assert.equal(String(args[0]), 'http://vms.test/api/aries/signup');
  const init = args[1] as RequestInit;
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['x-aries-secret'], 'whsec_test');
});

test('postAriesSignup returns ok on 200', async () => {
  globalThis.fetch = mock.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const result = await postAriesSignup({
    refCode: 'abc1',
    name: 'Test User',
    email: 't@example.com',
  });
  assert.equal(result.ok, true);
});

test('postAriesSignup 401 is terminal', async () => {
  globalThis.fetch = mock.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  const result = await postAriesSignup({
    refCode: 'abc1',
    name: 'Test User',
    email: 't@example.com',
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('expected failure');
  assert.equal(result.retryable, false);
});

test('postAriesSignup 400 is terminal', async () => {
  globalThis.fetch = mock.fn(async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
  const result = await postAriesSignup({
    refCode: 'abc1',
    name: 'Test User',
    email: 't@example.com',
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('expected failure');
  assert.equal(result.retryable, false);
});

test('postAriesSignup 503 is retryable', async () => {
  globalThis.fetch = mock.fn(async () => new Response('later', { status: 503 })) as unknown as typeof fetch;
  const result = await postAriesSignup({
    refCode: 'abc1',
    name: 'Test User',
    email: 't@example.com',
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('expected failure');
  assert.equal(result.retryable, true);
});

test('postAriesSignup timeout is retryable', async () => {
  globalThis.fetch = mock.fn(
    async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  ) as unknown as typeof fetch;

  const result = await postAriesSignup({
    refCode: 'abc1',
    name: 'Test User',
    email: 't@example.com',
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('expected failure');
  assert.equal(result.retryable, true);
});
