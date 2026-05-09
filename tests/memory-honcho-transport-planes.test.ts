import assert from 'node:assert/strict';
import test from 'node:test';

import { HonchoHttpTransport } from '@/backend/memory/honcho-http-transport';

test('HonchoHttpTransport uses control-plane JWT for workspace create', async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const h = init?.headers as Record<string, string>;
    seen.push(h?.['authorization'] ?? '');
    return new Response(JSON.stringify({ id: 'ws-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const transport = new HonchoHttpTransport(
    {
      HONCHO_BASE_URL: 'http://honcho.test',
      HONCHO_CONTROL_PLANE_JWT: 'control-only',
      HONCHO_DATA_PLANE_JWT: 'data-only',
    },
    fetchImpl,
  );

  await transport.request({
    method: 'POST',
    path: '/v3/workspaces',
    workspaceId: 'aries-tenant-abcd',
    body: { id: 'aries-tenant-abcd' },
  });

  assert.equal(seen[0], 'Bearer control-only');
});

test('HonchoHttpTransport prefers data-plane JWT for routine workspace paths', async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const h = init?.headers as Record<string, string>;
    seen.push(h?.['authorization'] ?? '');
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const transport = new HonchoHttpTransport(
    {
      HONCHO_BASE_URL: 'http://honcho.test',
      HONCHO_CONTROL_PLANE_JWT: 'control-only',
      HONCHO_DATA_PLANE_JWT: 'data-only',
    },
    fetchImpl,
  );

  await transport.request({
    method: 'GET',
    path: '/v3/workspaces/aries-tenant-abcd/peers/peer-brand/messages',
    workspaceId: 'aries-tenant-abcd',
    query: { peer_id: 'peer-brand' },
  });

  assert.equal(seen[0], 'Bearer data-only');
});
