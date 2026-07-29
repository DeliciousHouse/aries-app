import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createMarketingApprovalRecord,
  loadMarketingApprovalRecord,
  marketingApprovalPath,
  saveMarketingApprovalRecord,
  withMarketingApprovalLock,
} from '../backend/marketing/approval-store';

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-approval-path-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function approvalRecord(approvalId: string) {
  return createMarketingApprovalRecord({
    approvalId,
    tenantId: 'tenant-path-safety',
    marketingJobId: 'mkt_path_safety',
    workflowName: 'marketing-pipeline',
    workflowStepId: 'approve_publish',
    marketingStage: 'publish',
    approvalPrompt: 'Approve publish?',
    runtimeContext: {
      pipelinePath: '/pipeline',
      cwd: '/cwd',
      sessionKey: 'path-safety',
    },
  });
}

test('marketingApprovalPath rejects traversal, absolute, and multi-component ids', async () => {
  await withDataRoot(async () => {
    for (const approvalId of [
      '../escape',
      '..\\escape',
      'nested/component',
      'nested\\component',
      '/tmp/escape',
      'C:\\temp\\escape',
    ]) {
      assert.throws(() => marketingApprovalPath(approvalId), /invalid marketing approval id/);
    }
  });
});

test('loadMarketingApprovalRecord cannot read a traversal-selected file', async () => {
  await withDataRoot(async (dataRoot) => {
    const outsidePath = path.join(dataRoot, 'generated', 'draft', 'escape-read.json');
    await mkdir(path.dirname(outsidePath), { recursive: true });
    await writeFile(outsidePath, JSON.stringify(approvalRecord('../escape-read')));

    assert.equal(loadMarketingApprovalRecord('../escape-read'), null);
  });
});

test('saveMarketingApprovalRecord cannot write a traversal-selected file', async () => {
  await withDataRoot(async (dataRoot) => {
    const outsidePath = path.join(dataRoot, 'generated', 'draft', 'escape-write.json');

    assert.throws(
      () => saveMarketingApprovalRecord(approvalRecord('../escape-write')),
      /invalid marketing approval id/,
    );
    await assert.rejects(access(outsidePath), { code: 'ENOENT' });
  });
});

test('withMarketingApprovalLock rejects traversal before creating a lock or invoking work', async () => {
  await withDataRoot(async (dataRoot) => {
    const outsideLockPath = path.join(dataRoot, 'generated', 'draft', 'escape-lock.json.lock');
    let invoked = false;

    await assert.rejects(
      withMarketingApprovalLock('../escape-lock', async () => {
        invoked = true;
      }),
      /invalid marketing approval id/,
    );
    assert.equal(invoked, false);
    await assert.rejects(access(outsideLockPath), { code: 'ENOENT' });
  });
});

test('safe marketing approval ids still support path, write, read, and lock flows', async () => {
  await withDataRoot(async (dataRoot) => {
    const record = approvalRecord('mkta_safe_approval-1');
    const approvalPath = marketingApprovalPath(record.approval_id);
    const expectedRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-approvals');
    assert.equal(path.dirname(approvalPath), expectedRoot);
    assert.equal(path.basename(approvalPath), 'mkta_safe_approval-1.json');

    assert.equal(saveMarketingApprovalRecord(record), approvalPath);
    assert.equal(loadMarketingApprovalRecord(record.approval_id)?.approval_id, record.approval_id);
    const result = await withMarketingApprovalLock(record.approval_id, async () => 'locked');
    assert.equal(result, 'locked');
  });
});
