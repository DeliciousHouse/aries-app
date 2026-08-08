import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiRequestError, requestJson } from '../lib/api/http';

test('Posts request timeout stays active while a 200 response body is unresolved', async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      }),
    } as Response;
  }) as typeof fetch;

  const outcome = await Promise.race([
    requestJson('/api/marketing/posts', { method: 'GET', timeoutMs: 20 }, { fetchImpl })
      .then(() => null, (error: unknown) => error),
    new Promise<'unsettled'>((resolve) => setTimeout(() => resolve('unsettled'), 100)),
  ]);

  assert.notEqual(outcome, 'unsettled', 'a 200 response with an unresolved body must not leave Posts loading forever');
  assert.ok(outcome instanceof ApiRequestError);
  assert.equal(outcome.code, 'request_timeout');
});
