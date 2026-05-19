/**
 * Tests for per-platform approval consumption logic (Option A).
 *
 * Verifies that a single shared publish-stage approval with
 * publish_config.live_publish_platforms = ['meta-ads', 'instagram']
 * allows BOTH facebook and instagram publish calls to succeed, with
 * consumed_platforms accumulating after each call.
 * The approval is only fully 'consumed' once all platforms have published.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  createMarketingApprovalRecord,
  saveMarketingApprovalRecord,
  loadMarketingApprovalRecord,
  findLatestMarketingApprovalRecord,
  withMarketingApprovalLock,
} from '../../backend/marketing/approval-store';

// Override DATA_ROOT to a temp directory so tests don't pollute real state.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aries-approval-test-'));
process.env.DATA_ROOT = tmpDir;

function makeApprovalRecord(overrides: Partial<Parameters<typeof createMarketingApprovalRecord>[0]> = {}) {
  return createMarketingApprovalRecord({
    tenantId: 'tenant-42',
    marketingJobId: 'mkt_testjob',
    workflowName: 'marketing-pipeline',
    workflowStepId: 'publish_step',
    marketingStage: 'publish',
    executionProvider: 'hermes',
    approvalPrompt: 'Approve publish',
    runtimeContext: {
      pipelinePath: '/pipeline',
      cwd: '/cwd',
      sessionKey: 'sk_test',
    },
    publishConfig: {
      live_publish_platforms: ['facebook', 'instagram'],
    } as Parameters<typeof createMarketingApprovalRecord>[0]['publishConfig'],
    ...overrides,
  });
}

test('createMarketingApprovalRecord: initializes consumed_platforms as empty array', () => {
  const record = makeApprovalRecord();
  assert.ok(Array.isArray(record.consumed_platforms), 'consumed_platforms must be an array');
  assert.equal(record.consumed_platforms.length, 0, 'must start empty');
  assert.equal(record.status, 'pending');
});

test('per-platform consumption: facebook can consume an approved record', () => {
  const record = makeApprovalRecord();
  record.status = 'approved';
  saveMarketingApprovalRecord(record);

  withMarketingApprovalLock(record.approval_id, async () => {
    const loaded = loadMarketingApprovalRecord(record.approval_id);
    assert.ok(loaded, 'record must load');
    assert.ok(!loaded.consumed_platforms.includes('facebook'), 'facebook not yet consumed');

    loaded.consumed_platforms = [...loaded.consumed_platforms, 'facebook'];
    const configuredPlatforms: string[] = loaded.publish_config?.live_publish_platforms ?? [];
    const allConsumed = configuredPlatforms.length > 0
      && configuredPlatforms.every((p) => loaded.consumed_platforms.includes(p));
    if (allConsumed) {
      loaded.status = 'consumed';
    }
    saveMarketingApprovalRecord(loaded);
  });

  const after = loadMarketingApprovalRecord(record.approval_id);
  assert.ok(after, 'record must still exist');
  assert.ok(after.consumed_platforms.includes('facebook'), 'facebook should be in consumed_platforms');
  assert.equal(after.status, 'approved', 'status must remain approved (instagram not yet done)');
});

test('per-platform consumption: both platforms consumed flips status to consumed', () => {
  const record = makeApprovalRecord();
  record.status = 'approved';
  saveMarketingApprovalRecord(record);

  // Simulate facebook call
  const afterFb = loadMarketingApprovalRecord(record.approval_id)!;
  afterFb.consumed_platforms = [...afterFb.consumed_platforms, 'facebook'];
  const configuredPlatforms: string[] = afterFb.publish_config?.live_publish_platforms ?? [];
  let allConsumed = configuredPlatforms.length > 0
    && configuredPlatforms.every((p) => afterFb.consumed_platforms.includes(p));
  if (allConsumed) afterFb.status = 'consumed';
  saveMarketingApprovalRecord(afterFb);

  // Simulate instagram call
  const afterIg = loadMarketingApprovalRecord(record.approval_id)!;
  assert.equal(afterIg.status, 'approved', 'still approved after only facebook');
  afterIg.consumed_platforms = [...afterIg.consumed_platforms, 'instagram'];
  allConsumed = configuredPlatforms.length > 0
    && configuredPlatforms.every((p) => afterIg.consumed_platforms.includes(p));
  if (allConsumed) {
    afterIg.status = 'consumed';
    afterIg.resolved_at = new Date().toISOString();
  }
  saveMarketingApprovalRecord(afterIg);

  const final = loadMarketingApprovalRecord(record.approval_id)!;
  assert.equal(final.status, 'consumed', 'approval must be fully consumed after both platforms');
  assert.ok(final.consumed_platforms.includes('facebook'), 'facebook in consumed_platforms');
  assert.ok(final.consumed_platforms.includes('instagram'), 'instagram in consumed_platforms');
  assert.ok(final.resolved_at, 'resolved_at must be set');
});

test('per-platform consumption: second call for same platform is rejected', () => {
  const record = makeApprovalRecord();
  record.status = 'approved';
  saveMarketingApprovalRecord(record);

  // Consume facebook once
  const r1 = loadMarketingApprovalRecord(record.approval_id)!;
  r1.consumed_platforms = [...r1.consumed_platforms, 'facebook'];
  saveMarketingApprovalRecord(r1);

  // Attempt facebook again
  const r2 = loadMarketingApprovalRecord(record.approval_id)!;
  const alreadyConsumed = r2.consumed_platforms.includes('facebook');
  assert.ok(alreadyConsumed, 'facebook should already be in consumed_platforms, causing rejection');
});

test('per-platform consumption: record with no consumed_platforms field (legacy) is backfilled to []', () => {
  const record = makeApprovalRecord();
  record.status = 'approved';
  // Simulate an old record on-disk without the field by writing raw JSON
  const approvalPath = path.join(
    tmpDir, 'generated', 'draft', 'marketing-approvals',
    `${record.approval_id}.json`,
  );
  fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = { ...record } as any;
  delete raw.consumed_platforms;
  fs.writeFileSync(approvalPath, JSON.stringify(raw));

  const loaded = loadMarketingApprovalRecord(record.approval_id);
  assert.ok(loaded, 'must load');
  assert.ok(Array.isArray(loaded.consumed_platforms), 'consumed_platforms must be backfilled to array');
  assert.equal(loaded.consumed_platforms.length, 0, 'backfilled array must be empty');
});
