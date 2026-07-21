/**
 * Reel-publish fix #3 — maybeFireReelVideoRetryJob gating + one-shot bound.
 *
 * The automatic retry must be structurally bounded to ONE attempt: it only
 * fires for an ORIGINAL companion (`reel:<uuid>`), never for the retry's own
 * `reel:retry:<uuid>` marker, and the retry marker is idempotent via the
 * runtime-doc scan (reconciler re-delivery collapses onto the one retry).
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/weekly-reel-retry.test.ts
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { maybeFireReelVideoRetryJob } from '../backend/marketing/weekly-reel-trigger';

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withDataRoot<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-retry-'));
  const prev = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const BASE_ARGS = {
  tenantId: 15,
  failedReelJobId: 'job_reel_failed',
  failedReelCreatedBy: 'reel:weekly-src-uuid',
} as const;

test('retry: flag off => not fired', async () => {
  await withEnv({ ARIES_WEEKLY_REEL_ENABLED: undefined, ARIES_VIDEO_PUBLISH_ENABLED: '1' }, async () => {
    const result = await maybeFireReelVideoRetryJob({ ...BASE_ARGS });
    assert.deepEqual(result, { fired: false, reason: 'flag_off' });
  });
});

test('retry: video publish off => not fired', async () => {
  await withEnv({ ARIES_WEEKLY_REEL_ENABLED: '1', ARIES_VIDEO_PUBLISH_ENABLED: undefined }, async () => {
    const result = await maybeFireReelVideoRetryJob({ ...BASE_ARGS });
    assert.deepEqual(result, { fired: false, reason: 'video_publish_off' });
  });
});

test('retry: non-companion created_by => not fired', async () => {
  await withEnv({ ARIES_WEEKLY_REEL_ENABLED: '1', ARIES_VIDEO_PUBLISH_ENABLED: '1' }, async () => {
    const result = await maybeFireReelVideoRetryJob({ ...BASE_ARGS, failedReelCreatedBy: 'weekly-trigger' });
    assert.deepEqual(result, { fired: false, reason: 'not_reel_companion' });
    const nullResult = await maybeFireReelVideoRetryJob({ ...BASE_ARGS, failedReelCreatedBy: null });
    assert.deepEqual(nullResult, { fired: false, reason: 'not_reel_companion' });
  });
});

test('retry: ONE-SHOT BOUND — a failed retry job never retries itself', async () => {
  await withEnv({ ARIES_WEEKLY_REEL_ENABLED: '1', ARIES_VIDEO_PUBLISH_ENABLED: '1' }, async () => {
    const result = await maybeFireReelVideoRetryJob({
      ...BASE_ARGS,
      failedReelJobId: 'job_retry_failed',
      failedReelCreatedBy: 'reel:retry:job_reel_failed',
    });
    assert.deepEqual(result, { fired: false, reason: 'retry_exhausted' });
  });
});

test('retry: idempotent — an existing reel:retry:<jobId> doc collapses the re-fire', async () => {
  // Reconciler re-delivery of the failed job's completion must not create a
  // second retry job.
  await withEnv({ ARIES_WEEKLY_REEL_ENABLED: '1', ARIES_VIDEO_PUBLISH_ENABLED: '1' }, async () => {
    await withDataRoot(async (dir) => {
      const jobsDir = path.join(dir, 'generated', 'draft', 'marketing-jobs');
      await mkdir(jobsDir, { recursive: true });
      await writeFile(
        path.join(jobsDir, 'job_retry_existing.json'),
        JSON.stringify({
          job_id: 'job_retry_existing',
          tenant_id: '15',
          job_type: 'one_off_post',
          created_by: 'reel:retry:job_reel_failed',
          created_at: new Date().toISOString(),
        }),
        'utf8',
      );

      const result = await maybeFireReelVideoRetryJob({ ...BASE_ARGS });
      assert.equal(result.fired, false);
      assert.equal(result.reason, 'already_exists');
      assert.equal(result.reelJobId, 'job_retry_existing');
    });
  });
});
