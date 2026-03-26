import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getBusinessProfile } from '../../backend/tenant/business-profile';

test('getBusinessProfile queries tenant slug fallback with SQL string literals', async () => {
  const previousDataRoot = process.env.DATA_ROOT;
  const tempDataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-business-profile-'));
  process.env.DATA_ROOT = tempDataRoot;

  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      assert.match(sql, /NULLIF\(slug,\s*''\)/);
      assert.match(sql, /'org-' \|\| id::text/);
      assert.deepEqual(params, [11]);
      return {
        rowCount: 1,
        rows: [{ id: 11, name: 'Sugar & Leather', slug: 'org-11' }],
      };
    },
  };

  try {
    const profile = await getBusinessProfile(client as never, '11');
    assert.equal(profile.tenantId, '11');
    assert.equal(profile.businessName, 'Sugar & Leather');
    assert.equal(profile.tenantSlug, 'org-11');
    assert.equal(queries.length, 1);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(tempDataRoot, { force: true, recursive: true });
  }
});
