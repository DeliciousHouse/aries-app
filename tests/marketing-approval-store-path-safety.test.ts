import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadMarketingApprovalRecord,
  marketingApprovalPath,
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

test('marketing approval paths reject traversal and absolute user-controlled ids', async () => {
  await withDataRoot(async () => {
    for (const approvalId of ['../escape', '..\\escape', '/tmp/escape', 'C:\\temp\\escape']) {
      assert.throws(
        () => marketingApprovalPath(approvalId),
        /invalid marketing approval id/,
      );
      assert.equal(loadMarketingApprovalRecord(approvalId), null);
    }
  });
});

test('marketing approval paths preserve valid persisted approval ids', async () => {
  await withDataRoot(async (dataRoot) => {
    const approvalPath = marketingApprovalPath('mkta_safe_approval-1');
    const expectedRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-approvals');
    assert.equal(path.dirname(approvalPath), expectedRoot);
    assert.equal(path.basename(approvalPath), 'mkta_safe_approval-1.json');
  });
});
