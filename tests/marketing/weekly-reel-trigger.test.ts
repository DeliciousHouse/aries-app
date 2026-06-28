/**
 * Unit tests for maybeFireWeeklyReelJob (backend/marketing/weekly-reel-trigger.ts).
 *
 * Strategy: manipulate env vars to exercise early-return gates; use a real
 * DATA_ROOT temp directory to prove the idempotency key shape without mocking
 * the module graph (avoiding brittle require-cache surgery).
 *
 * Covers:
 *   - flag_off    : ARIES_WEEKLY_REEL_ENABLED off → {fired:false, reason:'flag_off'}
 *   - video_off   : weekly-reel flag ON but ARIES_VIDEO_PUBLISH_ENABLED off
 *                   → {fired:false, reason:'video_publish_off'}
 *   - idempotency : when a one_off_post doc already exists with the deterministic
 *                   createdBy marker `reel:<sourceWeeklyJobId>`, the function
 *                   returns already_exists without calling startSocialContentJob.
 *                   This also proves the key shape.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/weekly-reel-trigger.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { maybeFireWeeklyReelJob } from '../../backend/marketing/weekly-reel-trigger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save + clear a set of env vars, return a restorer. */
function withEnv(
  vars: Record<string, string | undefined>,
): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ---------------------------------------------------------------------------
// Gate 1: weekly-reel feature flag OFF
// ---------------------------------------------------------------------------

test('maybeFireWeeklyReelJob: returns flag_off when ARIES_WEEKLY_REEL_ENABLED is unset', async () => {
  const restore = withEnv({ ARIES_WEEKLY_REEL_ENABLED: undefined });
  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId: 'mkt_weekly_test_001',
    });
    assert.deepEqual(result, { fired: false, reason: 'flag_off' });
  } finally {
    restore();
  }
});

test('maybeFireWeeklyReelJob: returns flag_off when ARIES_WEEKLY_REEL_ENABLED is 0', async () => {
  const restore = withEnv({ ARIES_WEEKLY_REEL_ENABLED: '0' });
  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId: 'mkt_weekly_test_002',
    });
    assert.deepEqual(result, { fired: false, reason: 'flag_off' });
  } finally {
    restore();
  }
});

test('maybeFireWeeklyReelJob: returns flag_off when ARIES_WEEKLY_REEL_ENABLED is false', async () => {
  const restore = withEnv({ ARIES_WEEKLY_REEL_ENABLED: 'false' });
  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId: 'mkt_weekly_test_003',
    });
    assert.deepEqual(result, { fired: false, reason: 'flag_off' });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Gate 2: video-publish upstream gate OFF (while reel flag is ON)
// ---------------------------------------------------------------------------

test('maybeFireWeeklyReelJob: returns video_publish_off when ARIES_VIDEO_PUBLISH_ENABLED is unset', async () => {
  const restore = withEnv({
    ARIES_WEEKLY_REEL_ENABLED: '1',
    ARIES_VIDEO_PUBLISH_ENABLED: undefined,
  });
  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId: 'mkt_weekly_test_004',
    });
    assert.deepEqual(result, { fired: false, reason: 'video_publish_off' });
  } finally {
    restore();
  }
});

test('maybeFireWeeklyReelJob: returns video_publish_off when ARIES_VIDEO_PUBLISH_ENABLED is 0', async () => {
  const restore = withEnv({
    ARIES_WEEKLY_REEL_ENABLED: 'true',
    ARIES_VIDEO_PUBLISH_ENABLED: '0',
  });
  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId: 'mkt_weekly_test_005',
    });
    assert.deepEqual(result, { fired: false, reason: 'video_publish_off' });
  } finally {
    restore();
  }
});

test('maybeFireWeeklyReelJob: returns video_publish_off when ARIES_VIDEO_PUBLISH_ENABLED is false', async () => {
  const restore = withEnv({
    ARIES_WEEKLY_REEL_ENABLED: 'on',
    ARIES_VIDEO_PUBLISH_ENABLED: 'false',
  });
  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId: 'mkt_weekly_test_006',
    });
    assert.deepEqual(result, { fired: false, reason: 'video_publish_off' });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Idempotency key shape: createdBy = `reel:<sourceWeeklyJobId>`
//
// When both flags are ON and a one_off_post doc already exists stamped with
// `created_by = "reel:<sourceWeeklyJobId>"` for this tenant, the function
// must short-circuit with already_exists WITHOUT calling startSocialContentJob.
//
// This proves:
//   1. The key shape (reel: prefix + the exact source job id).
//   2. Idempotency: a re-fire after a lost response does not start a 2nd job.
// ---------------------------------------------------------------------------

test('maybeFireWeeklyReelJob: idempotency key is reel:<sourceWeeklyJobId>; already_exists if doc found', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-reel-trigger-test-'));
  const jobsDir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  await mkdir(jobsDir, { recursive: true });

  const sourceWeeklyJobId = 'mkt_weekly_abc123';
  const expectedCreatedBy = `reel:${sourceWeeklyJobId}`;
  const existingReelJobId = 'mkt_one_off_reel_xyz';

  // Write a one_off_post doc stamped with the deterministic createdBy marker.
  await writeFile(
    path.join(jobsDir, `${existingReelJobId}.json`),
    JSON.stringify({
      schema_name: 'marketing_job_state_schema',
      job_id: existingReelJobId,
      tenant_id: '15',
      job_type: 'one_off_post',
      created_by: expectedCreatedBy,
      created_at: new Date().toISOString(),
      stages: { research: {} },
    }),
  );

  const restore = withEnv({
    ARIES_WEEKLY_REEL_ENABLED: '1',
    ARIES_VIDEO_PUBLISH_ENABLED: '1',
    DATA_ROOT: dataRoot,
  });

  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId,
      brandUrl: 'https://brand.example.com',
    });

    // The function must recognise the existing doc and return already_exists.
    assert.equal(result.fired, false, 'must not fire when the reel job already exists');
    assert.equal(result.reason, 'already_exists');
    assert.equal(
      result.reelJobId,
      existingReelJobId,
      'must surface the already-created reel job id',
    );
  } finally {
    restore();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('maybeFireWeeklyReelJob: idempotency key is tenant-scoped (different tenant → not collapsed)', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-reel-trigger-test-tenant-'));
  const jobsDir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  await mkdir(jobsDir, { recursive: true });

  const sourceWeeklyJobId = 'mkt_weekly_def456';
  const createdBy = `reel:${sourceWeeklyJobId}`;

  // Doc belongs to tenant 99 — NOT tenant 15 that we're going to fire for.
  await writeFile(
    path.join(jobsDir, 'mkt_other_tenant_reel.json'),
    JSON.stringify({
      schema_name: 'marketing_job_state_schema',
      job_id: 'mkt_other_tenant_reel',
      tenant_id: '99',        // <-- different tenant
      job_type: 'one_off_post',
      created_by: createdBy,
      created_at: new Date().toISOString(),
      stages: { research: {} },
    }),
  );

  const restore = withEnv({
    ARIES_WEEKLY_REEL_ENABLED: '1',
    ARIES_VIDEO_PUBLISH_ENABLED: '1',
    DATA_ROOT: dataRoot,
  });

  try {
    const result = await maybeFireWeeklyReelJob({
      tenantId: 15,
      sourceWeeklyJobId,
      brandUrl: 'https://brand.example.com',
    });

    // Must NOT return already_exists for a different tenant's doc.
    assert.notEqual(
      result.reason,
      'already_exists',
      'a doc from a different tenant must not collapse the current tenant\'s fire',
    );
  } finally {
    restore();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
