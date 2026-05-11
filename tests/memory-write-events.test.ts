import assert from 'node:assert/strict';
import test from 'node:test';

import { recordApprovalEvent, scheduleMarketingApprovalHonchoWrites } from '../backend/memory/write-events';

test('recordApprovalEvent skips DB when Honcho is disabled', async () => {
  const prevH = process.env.HONCHO_ENABLED;
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  process.env.HONCHO_ENABLED = 'false';
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'true';
  const queries: string[] = [];
  const mockPool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  await recordApprovalEvent(
    {
      tenantCtx: { tenantId: 'tid', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' },
      memoryActorUserId: 'u1',
      jobId: 'j1',
      stage: 'strategy',
      eventDateYmd: '20260511',
    },
    mockPool as never,
  );
  assert.equal(queries.length, 0);
  process.env.HONCHO_ENABLED = prevH;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
});

test('scheduleMarketingApprovalHonchoWrites with approvals gate off returns immediately', async () => {
  const prevW = process.env.HONCHO_WRITE_APPROVALS_ENABLED;
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = 'false';
  scheduleMarketingApprovalHonchoWrites({
    tenantCtx: { tenantId: 't1', tenantSlug: 'slug', userId: 'u1', role: 'tenant_admin' },
    memoryActorUserId: 'u1',
    jobId: 'job-a',
    stage: 'strategy',
    resolution: 'approve',
    eventDateYmd: '20260511',
  });
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = prevW;
});
