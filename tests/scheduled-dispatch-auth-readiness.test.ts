import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../app/api/internal/publishing/scheduled-dispatch/route';

const ROUTE_URL = 'https://aries.example.test/api/internal/publishing/scheduled-dispatch';

test('scheduled-dispatch GET is an authenticated readiness probe with no provider work', async (t) => {
  const previous = process.env.INTERNAL_API_SECRET;
  try {
    await t.test('configured matching secret', async () => {
      process.env.INTERNAL_API_SECRET = 'x';
      const response = await GET(new Request(ROUTE_URL, {
        headers: { authorization: 'Bearer x' },
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready' });
    });

    await t.test('mismatched secret', async () => {
      process.env.INTERNAL_API_SECRET = 'x';
      const response = await GET(new Request(ROUTE_URL, {
        headers: { authorization: 'Bearer y' },
      }));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'invalid_internal_callback_secret' });
    });

    await t.test('app secret not configured', async () => {
      delete process.env.INTERNAL_API_SECRET;
      const response = await GET(new Request(ROUTE_URL, {
        headers: { authorization: 'Bearer z' },
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'internal_api_secret_not_configured' });
    });
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previous;
  }
});
