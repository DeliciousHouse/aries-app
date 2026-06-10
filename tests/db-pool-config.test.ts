import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import pool, { getPoolStats, parsePoolMax } from '../lib/db';

describe('parsePoolMax', () => {
  // The invalid-input cases below intentionally trigger the parser's
  // console.warn; stub it so CI output stays clean, and assert on it where the
  // warning is the behavior under test.
  let warnMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    warnMock = mock.method(console, 'warn', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('parses a valid integer', () => {
    assert.equal(parsePoolMax('25'), 25);
    assert.equal(parsePoolMax(' 25 '), 25);
  });

  it('clamps above the maximum', () => {
    assert.equal(parsePoolMax('999'), 200);
    assert.equal(parsePoolMax('200'), 200);
  });

  it('honors small explicit values down to 1 (sidecar workers set 3)', () => {
    // docker-compose.yml sets DB_POOL_MAX: 3 on every sidecar worker; the old
    // MIN_POOL_MAX=5 floor silently inflated the shared-pool consumers
    // configured below it and broke the connection-budget math in DOCKER.md /
    // guardrail #1.
    assert.equal(parsePoolMax('3'), 3);
    assert.equal(parsePoolMax('1'), 1);
  });

  it('falls back to the default for non-positive values', () => {
    assert.equal(parsePoolMax('0'), 20);
    assert.equal(parsePoolMax('-4'), 20);
  });

  it('rejects partial-parse inputs instead of truncating them', () => {
    // Number.parseInt would turn '1e2' into 1 and '3garbage' into 3 — silently
    // under-provisioning a production pool from a malformed env var
    // (cross-model adversarial finding). Strict integer parsing sends these to
    // the default instead.
    assert.equal(parsePoolMax('1e2'), 20);
    assert.equal(parsePoolMax('3garbage'), 20);
    assert.equal(parsePoolMax('3.9'), 20);
    assert.equal(warnMock.mock.callCount(), 3);
  });

  it('defaults when the value is not a valid integer', () => {
    assert.equal(parsePoolMax('garbage'), 20);
    assert.equal(parsePoolMax(undefined), 20);
  });

  it('honors a caller-provided fallback (worker pools default to 3)', () => {
    assert.equal(parsePoolMax(undefined, 3), 3);
    assert.equal(parsePoolMax('garbage', 3), 3);
    assert.equal(parsePoolMax('0', 3), 3);
    assert.equal(parsePoolMax('7', 3), 7);
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
