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
 *   2. The id-route SQL contract — the ingest + upload-replace writers emit
 *      id-based served_asset_ref, and the route reads bytes keyed on
 *      `id=$1 AND tenant_id=$2`. The cross-tenant / missing-row / wrong-kind
 *      404 behavior is asserted at the resolver level (the route delegates the
 *      ownership decision entirely to that single SQL predicate).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSignableBasename } from '../backend/marketing/signable-basename';

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
