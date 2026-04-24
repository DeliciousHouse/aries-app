import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import pool, { getPoolStats, parsePoolMax } from '../lib/db';

describe('parsePoolMax', () => {
  it('parses a valid integer', () => {
    assert.equal(parsePoolMax('25'), 25);
  });

  it('clamps above the maximum', () => {
    assert.equal(parsePoolMax('999'), 200);
  });

  it('clamps below the minimum', () => {
    assert.equal(parsePoolMax('1'), 5);
  });

  it('defaults when the value is not a valid integer', () => {
    assert.equal(parsePoolMax('garbage'), 20);
    assert.equal(parsePoolMax(undefined), 20);
  });
});

describe('db pool singleton', () => {
  it('returns the same pool instance across imports', async () => {
    const importedModule = await import('../lib/db');
    assert.strictEqual(importedModule.default, pool);
    assert.strictEqual(importedModule.pool, pool);
  });

  it('reports numeric pool counters', () => {
    const stats = getPoolStats();

    assert.equal(typeof stats.total, 'number');
    assert.equal(typeof stats.idle, 'number');
    assert.equal(typeof stats.waiting, 'number');
  });
});
