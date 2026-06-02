/**
 * Self-contained unit tests for the onboarding variant fan-out.
 * buildVariantBriefs is pure; startFirstPostVariantBatch is exercised with an
 * injected startJob stub (no orchestrator, no Hermes) and a per-test mkdtemp
 * DATA_ROOT so the batch record write/read stays isolated.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-fanout.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildVariantBriefs, startFirstPostVariantBatch, VARIANT_COUNT, VARIANT_LENSES } from '../../backend/marketing/onboarding-variant-batch';
import { loadVariantBatch } from '../../backend/marketing/variant-batch-store';

// DATA_ROOT is read lazily by resolveDataRoot() at call time, so setting it here
// (module-eval, before any test body runs) isolates the batch record writes.
process.env.DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'aries-variant-fanout-'));

test('buildVariantBriefs returns one brief per lens, all distinct, sharing the base', () => {
  const briefs = buildVariantBriefs({ primaryGoal: 'Grow signups', offer: '20% off', styleVibe: 'minimalist', audience: 'founders' });
  assert.equal(briefs.length, VARIANT_LENSES.length);
  assert.equal(new Set(briefs).size, briefs.length, 'briefs are distinct');
  for (const b of briefs) {
    assert.ok(b.includes('Grow signups'), 'base goal present');
    assert.ok(b.includes('20% off'), 'base offer present');
    assert.ok(b.includes('Visual direction:'), 'per-variant lens present');
  }
});

test('buildVariantBriefs falls back to a default base when the payload is empty', () => {
  const briefs = buildVariantBriefs({});
  assert.equal(briefs.length, VARIANT_LENSES.length);
  for (const b of briefs) assert.ok(b.startsWith('On-brand first social post.'));
});

test('startFirstPostVariantBatch fans out VARIANT_COUNT single-post weekly jobs with variant tags', async () => {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const startJob = async (req: Record<string, unknown>) => {
    calls.push(req);
    return { status: 'accepted' as const, jobId: `mkt_job_${n++}`, tenantId: '7', jobType: 'weekly_social_content' as const, runtimeArtifactPath: '', approvalRequired: false, currentStage: 'research' as const, approval: null };
  };

  const result = await startFirstPostVariantBatch({
    tenantId: '7',
    createdBy: '42',
    payload: { primaryGoal: 'Grow signups', brandUrl: 'https://aries.example.com' },
    startJob: startJob as never,
  });

  assert.equal(calls.length, VARIANT_COUNT, 'one job per variant');
  assert.equal(result.jobIds.length, VARIANT_COUNT);
  assert.equal(result.slotIndex, 0);
  assert.ok(result.variantBatchId.startsWith('vbatch_'));

  const batchIds = new Set<string>();
  const indices: number[] = [];
  for (const call of calls) {
    assert.equal(call.jobType, 'weekly_social_content');
    assert.equal(call.tenantId, '7');
    assert.equal(call.createdBy, '42');
    const payload = call.payload as Record<string, unknown>;
    assert.equal(payload.staticPostCount, 1, 'scope override: single post');
    assert.equal(payload.imageCreativeCount, 1, 'scope override: single image');
    assert.equal(payload.storyCount, 0);
    assert.equal(payload.slot_index, 0);
    assert.ok(Array.isArray(payload.creativeBriefs) && (payload.creativeBriefs as unknown[]).length === 1, 'one brief per variant');
    assert.equal(payload.brandUrl, 'https://aries.example.com', 'base payload preserved');
    batchIds.add(String(payload.variant_batch_id));
    indices.push(Number(payload.variant_index));
  }
  assert.equal(batchIds.size, 1, 'all variants share one batch id');
  assert.deepEqual([...indices].sort((a, b) => a - b), [0, 1, 2], 'variant_index 0..2');

  // Batch record persisted with the 3 job ids.
  const record = await loadVariantBatch(result.variantBatchId);
  assert.ok(record, 'batch record saved');
  assert.equal(record!.tenant_id, '7');
  assert.equal(record!.user_id, '42');
  assert.equal(record!.slot_index, 0);
  assert.deepEqual(record!.job_ids, result.jobIds);
  assert.equal(record!.picked_variant_index, null);
  assert.equal(record!.abandoned_at, null);
});

test('startFirstPostVariantBatch persists a recoverable batch record even if a submit throws mid-fan-out', async () => {
  let n = 0;
  let capturedBatchId = '';
  const startJob = async (req: Record<string, unknown>) => {
    capturedBatchId = String((req.payload as Record<string, unknown>).variant_batch_id);
    if (n === 1) throw new Error('boom on the second submit');
    return { status: 'accepted' as const, jobId: `mkt_job_${n++}`, tenantId: '7', jobType: 'weekly_social_content' as const, runtimeArtifactPath: '', approvalRequired: false, currentStage: 'research' as const, approval: null };
  };

  await assert.rejects(
    () => startFirstPostVariantBatch({ tenantId: '7', createdBy: '42', payload: {}, startJob: startJob as never }),
    /boom/,
  );

  // The up-front + per-submit saves mean job 0 (submitted before job 1 threw) is recorded,
  // so getVariantBoard can still load + timeout-resolve the draft (no orphaned live jobs).
  const record = await loadVariantBatch(capturedBatchId);
  assert.ok(record, 'batch record persisted despite the mid-fan-out throw');
  assert.equal(record!.job_ids.length, 1, 'the one job submitted before the throw is recorded');
});

test('startFirstPostVariantBatch calls onBatchCreated with the batch id BEFORE any job submits', async () => {
  let createdBatchId = '';
  let jobsAtCallback = -1;
  const startJob = async () => ({
    status: 'accepted' as const,
    jobId: 'mkt_x',
    tenantId: '7',
    jobType: 'weekly_social_content' as const,
    runtimeArtifactPath: '',
    approvalRequired: false,
    currentStage: 'research' as const,
    approval: null,
  });

  const result = await startFirstPostVariantBatch({
    tenantId: '7',
    createdBy: '42',
    payload: {},
    startJob: startJob as never,
    onBatchCreated: async (batchId) => {
      createdBatchId = batchId;
      const rec = await loadVariantBatch(batchId);
      jobsAtCallback = rec?.job_ids.length ?? -1;
    },
  });

  assert.equal(createdBatchId, result.variantBatchId, 'callback receives the batch id');
  assert.equal(jobsAtCallback, 0, 'the record is already persisted (empty) when the callback fires, before any submit');
});
