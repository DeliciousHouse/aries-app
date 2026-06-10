import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildPool as buildDraftExpiryPool } from '../scripts/automations/draft-expiry-sweep-worker';
import { buildPool as buildWeeklyTriggerPool } from '../scripts/automations/weekly-job-trigger-worker';
import { buildPool as buildHonchoPool } from '../scripts/automations/honcho-performance-worker';
// @ts-expect-error — plain .mjs module, no type declarations
import { parseWorkerPoolMax } from '../scripts/automations/scheduled-posts-worker.mjs';

// Every sidecar worker's dedicated pool must honor an explicit DB_POOL_MAX
// (docker-compose sets 3 per sidecar) and default to the worker-sized 3 — NOT
// the app default 20 — when the env var is unset. Before this suite existed,
// four of the five sidecars hardcoded max: 3 and silently ignored the env var,
// so the connection-budget docs could not be read off docker-compose.yml
// (cross-model adversarial finding).

const TS_BUILDERS = [
  ['draft-expiry-sweep-worker', buildDraftExpiryPool],
  ['weekly-job-trigger-worker', buildWeeklyTriggerPool],
  ['honcho-performance-worker', buildHonchoPool],
] as const;

describe('sidecar worker pool sizing', () => {
  const savedPoolMax = process.env.DB_POOL_MAX;

  beforeEach(() => {
    delete process.env.DB_POOL_MAX;
  });

  afterEach(() => {
    if (savedPoolMax === undefined) {
      delete process.env.DB_POOL_MAX;
    } else {
      process.env.DB_POOL_MAX = savedPoolMax;
    }
  });

  for (const [name, buildPool] of TS_BUILDERS) {
    it(`${name} defaults to a pool max of 3 when DB_POOL_MAX is unset`, async () => {
      const pool = buildPool();
      try {
        assert.equal(pool.options.max, 3);
      } finally {
        await pool.end();
      }
    });

    it(`${name} honors an explicit DB_POOL_MAX`, async () => {
      process.env.DB_POOL_MAX = '7';
      const pool = buildPool();
      try {
        assert.equal(pool.options.max, 7);
      } finally {
        await pool.end();
      }
    });
  }

  it('scheduled-posts-worker (.mjs) mirrors the same parse semantics', () => {
    assert.equal(parseWorkerPoolMax(undefined), 3);
    assert.equal(parseWorkerPoolMax('3'), 3);
    assert.equal(parseWorkerPoolMax('7'), 7);
    assert.equal(parseWorkerPoolMax('0'), 3);
    assert.equal(parseWorkerPoolMax('1e2'), 3);
    assert.equal(parseWorkerPoolMax('999'), 200);
  });
});
