/**
 * Reel-publish fix #1b/#3 — the reel-companion outcome gate.
 *
 * A COMPLETED reel-companion job (`created_by` starting `reel:`) with no video
 * `posts` row must read FAILED (not approved-with-nothing-publishable), and an
 * ORIGINAL companion gets exactly one automatic retry job.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/reel-video-outcome.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  enforceReelCompanionVideoOutcome,
  isReelCompanionCreatedBy,
  REEL_VIDEO_MISSING_ERROR_CODE,
} from '../backend/marketing/reel-video-outcome';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

function stage(name: string) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: null,
    outputs: {}, artifacts: [], errors: [],
  };
}

function makeDoc(opts: { createdBy?: string | null; state?: string } = {}): SocialContentJobRuntimeDocument {
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: 'job_reel_1',
    tenant_id: '15', job_type: 'one_off_post',
    state: opts.state ?? 'completed', status: opts.state ?? 'completed',
    current_stage: 'publish',
    created_by: opts.createdBy === undefined ? 'reel:weekly-src-uuid' : opts.createdBy,
    stages: {
      research: stage('research'), strategy: stage('strategy'),
      production: stage('production'), publish: stage('publish'),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

function makeDb(videoPostRows: unknown[], opts: { throwOnQuery?: boolean } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (opts.throwOnQuery) throw new Error('db down');
      return { rows: videoPostRows, rowCount: videoPostRows.length };
    },
  };
  return { db, queries };
}

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-outcome-'));
  const prev = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('isReelCompanionCreatedBy: reel: and reel:retry: markers match; others do not', () => {
  assert.equal(isReelCompanionCreatedBy('reel:abc'), true);
  assert.equal(isReelCompanionCreatedBy('reel:retry:abc'), true);
  assert.equal(isReelCompanionCreatedBy('weekly-trigger'), false);
  assert.equal(isReelCompanionCreatedBy(null), false);
  assert.equal(isReelCompanionCreatedBy(undefined), false);
});

test('outcome: non-reel job is untouched', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc({ createdBy: 'weekly-trigger' });
    const { db, queries } = makeDb([]);
    const outcome = await enforceReelCompanionVideoOutcome(doc, { db });
    assert.equal(outcome.action, 'none');
    assert.equal(queries.length, 0, 'no DB lookup for non-reel jobs');
    assert.equal(doc.state, 'completed');
  });
});

test('outcome: non-terminal reel doc is untouched (mid-pipeline callbacks)', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc({ state: 'running' });
    const { db, queries } = makeDb([]);
    const outcome = await enforceReelCompanionVideoOutcome(doc, { db });
    assert.equal(outcome.action, 'none');
    assert.equal(queries.length, 0);
    assert.equal(doc.state, 'running');
  });
});

test('outcome: healthy reel job (video post exists) stays completed — idempotent on re-delivery', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    const { db } = makeDb([{ '?column?': 1 }]);
    const outcome = await enforceReelCompanionVideoOutcome(doc, { db });
    assert.equal(outcome.action, 'none');
    assert.equal(doc.state, 'completed');
    assert.equal(doc.last_error, null);
  });
});

test('outcome: completed reel job with NO video post is marked failed + one retry fired', async () => {
  // FAIL BEFORE: the job read 'completed'/approved with nothing publishable
  //   (or, worse, with a dead reel post) — the 2026-07-06/07-13 incidents.
  // PASS AFTER:  doc.state === 'failed', loud error recorded, retry fired once.
  await withDataRoot(async () => {
    const doc = makeDoc({ createdBy: 'reel:weekly-src-uuid' });
    const { db } = makeDb([]);
    const retryCalls: unknown[] = [];
    const outcome = await enforceReelCompanionVideoOutcome(doc, {
      db,
      fireRetry: async (args) => {
        retryCalls.push(args);
        return { fired: true, reelJobId: 'job_retry_1' };
      },
    });

    assert.equal(outcome.action, 'failed');
    assert.equal(doc.state, 'failed');
    assert.equal(doc.status, 'failed');
    assert.equal(doc.last_error?.code, REEL_VIDEO_MISSING_ERROR_CODE);
    assert.equal(doc.stages.production.status, 'failed', 'production stage carries the failure');
    assert.equal(retryCalls.length, 1, 'exactly one retry submission');
    const call = retryCalls[0] as Record<string, unknown>;
    assert.equal(call.failedReelJobId, 'job_reel_1');
    assert.equal(call.failedReelCreatedBy, 'reel:weekly-src-uuid');
    assert.equal(call.tenantId, 15);
    assert.ok(
      doc.history.some((h) => typeof h.note === 'string' && h.note.includes('job_retry_1')),
      'retry outcome recorded in job history',
    );
  });
});

test('outcome: failed RETRY reel job is marked failed but fires no further retry (helper refuses)', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc({ createdBy: 'reel:retry:job_reel_0' });
    const { db } = makeDb([]);
    const retryResults: unknown[] = [];
    const outcome = await enforceReelCompanionVideoOutcome(doc, {
      db,
      // Use the REAL helper's refusal semantics via a passthrough that records:
      fireRetry: async (args) => {
        // Mirror maybeFireReelVideoRetryJob's one-shot bound exactly.
        const createdBy = typeof args.failedReelCreatedBy === 'string' ? args.failedReelCreatedBy : '';
        const result = createdBy.startsWith('reel:retry:')
          ? { fired: false, reason: 'retry_exhausted' }
          : { fired: true, reelJobId: 'unexpected' };
        retryResults.push(result);
        return result;
      },
    });

    assert.equal(outcome.action, 'failed');
    assert.equal(doc.state, 'failed');
    assert.deepEqual(retryResults, [{ fired: false, reason: 'retry_exhausted' }]);
  });
});

test('outcome: DB lookup error fails OPEN — a possibly-healthy job is never marked failed', async () => {
  await withDataRoot(async () => {
    const doc = makeDoc();
    const { db } = makeDb([], { throwOnQuery: true });
    const outcome = await enforceReelCompanionVideoOutcome(doc, { db });
    assert.equal(outcome.action, 'none');
    assert.equal(doc.state, 'completed', 'DB blip must not fail the job');
  });
});
