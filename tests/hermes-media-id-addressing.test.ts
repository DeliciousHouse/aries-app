/**
 * Tests for id-based Hermes media addressing (epic #508).
 *
 * Two surfaces are exercised here without a live DB, via injected query stubs:
 *
 *   1. resolveSignableBasename (backend/marketing/signable-basename.ts) — the
 *      Phase-3 "load-bearing break" guard. An id-addressed internal URL must be
 *      resolved to the row's on-disk basename BEFORE signing, or the public
 *      proxy 404s at Meta-fetch time. Legacy basename URLs must pass through
 *      unchanged with no DB hit.
 *
 *   2. The id route — the handler resolves an authenticated tenant, loads its
 *      `id=$1 AND tenant_id=$2` row, and reads persisted runtime bytes from the
 *      active mount. A row owned by another tenant remains a 404.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleGetHermesMedia } from '../app/api/internal/hermes/media/[...path]/route';
import { resolveSignableBasename } from '../backend/marketing/signable-basename';
import { pool } from '../lib/db';
import type { TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';

type QueryCall = { sql: string; params: unknown[] };

function makeDb(
  handler: (call: QueryCall) => { rows: Array<{ storage_key?: string | null }> },
) {
  const calls: QueryCall[] = [];
  const db = {
    query(sql: string, params?: unknown[]) {
      const call = { sql, params: params ?? [] };
      calls.push(call);
      return Promise.resolve(handler(call));
    },
  };
  return { db, calls };
}

const UUID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';

function tenantLoader(tenantId: string): TenantContextLoader {
  return async () => ({
    tenantId,
    tenantSlug: `tenant-${tenantId}`,
    userId: 'user-1',
    role: 'tenant_admin',
  }) satisfies TenantContext;
}

test('id media route remaps persisted runtime storage keys to the active mount by basename', async (t) => {
  const mount = await mkdtemp(path.join(tmpdir(), 'hermes-media-id-'));
  const filename = 'persisted-preview.png';
  const priorMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const queryParams: unknown[][] = [];

  await writeFile(path.join(mount, filename), 'persisted preview bytes');
  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
    assert.match(sql, /WHERE id = \$1 AND tenant_id = \$2/);
    queryParams.push(params);
    return params[1] === 42
      ? {
          rows: [{ storage_kind: 'runtime_asset', storage_key: `/old/hermes/mount/${filename}` }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }) as typeof pool.query);

  try {
    const request = new Request(`https://aries.example.com/api/internal/hermes/media/${UUID}`);
    const context = { params: Promise.resolve({ path: [UUID] }) };
    const response = await handleGetHermesMedia(request, context, tenantLoader('42'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'persisted preview bytes');

    const wrongTenant = await handleGetHermesMedia(request, context, tenantLoader('43'));
    assert.equal(wrongTenant.status, 404);
    assert.deepEqual(queryParams, [[UUID, 42], [UUID, 43]]);
  } finally {
    if (priorMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = priorMount;
    await rm(mount, { recursive: true, force: true });
  }
});

test('resolveSignableBasename — legacy basename URL passes through with no DB hit', async () => {
  const { db, calls } = makeDb(() => {
    throw new Error('DB must not be queried for a legacy basename URL');
  });
  const basename = await resolveSignableBasename(
    '/api/internal/hermes/media/openai_codex_abc123.png',
    '42',
    db,
  );
  assert.equal(basename, 'openai_codex_abc123.png');
  assert.equal(calls.length, 0, 'no DB lookup for a non-UUID segment');
});

test('resolveSignableBasename — id URL resolves to the row storage_key basename, tenant-scoped', async () => {
  const { db, calls } = makeDb((call) => {
    // Ownership is enforced in SQL: id=$1 AND tenant_id=$2.
    assert.ok(call.sql.includes('WHERE id = $1 AND tenant_id = $2'), 'must scope by id + tenant');
    assert.deepEqual(call.params, [UUID, 42]);
    return { rows: [{ storage_key: '/hermes-media/real_image_9f.png' }] };
  });
  const basename = await resolveSignableBasename(
    `/api/internal/hermes/media/${UUID}`,
    '42',
    db,
  );
  assert.equal(basename, 'real_image_9f.png', 'signs the on-disk basename, not the UUID');
  assert.equal(calls.length, 1, 'exactly one PK lookup (no fan-out)');
});

test('resolveSignableBasename — id URL with no owned row -> null (skip signing)', async () => {
  const { db } = makeDb(() => ({ rows: [] }));
  const basename = await resolveSignableBasename(
    `/api/internal/hermes/media/${UUID}`,
    '42',
    db,
  );
  assert.equal(basename, null, 'wrong tenant / missing row must not produce a signed URL');
});

test('resolveSignableBasename — id URL with null storage_key -> null', async () => {
  const { db } = makeDb(() => ({ rows: [{ storage_key: null }] }));
  const basename = await resolveSignableBasename(
    `/api/internal/hermes/media/${UUID}`,
    '42',
    db,
  );
  assert.equal(basename, null);
});

test('resolveSignableBasename — non-positive tenant id -> null, no DB hit', async () => {
  const { db, calls } = makeDb(() => ({ rows: [{ storage_key: '/x/y.png' }] }));
  const basename = await resolveSignableBasename(
    `/api/internal/hermes/media/${UUID}`,
    '0',
    db,
  );
  assert.equal(basename, null);
  assert.equal(calls.length, 0);
});
