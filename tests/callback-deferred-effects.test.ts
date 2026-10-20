import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExecutionRunRecord, loadExecutionRunRecord, saveExecutionRunRecord } from '../backend/execution/run-store';
import { withCallbackEffectScope } from '../backend/execution/callback-effects';

async function withReceipt(action: (id: string) => Promise<void>) {
  const previous = process.env.DATA_ROOT;
  const root = mkdtempSync(path.join(tmpdir(), 'deferred-effects-'));
  process.env.DATA_ROOT = root;
  try {
    const run = createExecutionRunRecord({ provider: 'hermes', domain: 'marketing', action: 'run',
      workflowKey: 'social_content_weekly', tenantId: '7', marketingJobId: 'job-deferred' });
    run.external_run_id = 'native-deferred';
    run.callback_receipts = [{ event_id: 'deferred', payload_sha256: 'a'.repeat(64),
      external_run_id: run.external_run_id, state: 'applying', effects: [] }];
    saveExecutionRunRecord(run);
    await withCallbackEffectScope(run, run.callback_receipts[0], () => action(run.aries_run_id));
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('protects Slack intent before first async read; fails_when callback can finish before intent; no_claim Slack delivery', async () => {
  const { notifyApprovalRequired } = await import('../backend/integrations/slack/notifications');
  await withReceipt(async (id) => {
    let reads = 0;
    const db = { async query() {
      reads++;
      const effect = loadExecutionRunRecord(id)!.callback_receipts![0].effects![0];
      assert.equal(effect?.target, 'slack_notification');
      assert.equal(effect?.key, 'approval:job-deferred:strategy');
      assert.equal(effect?.disposition, 'unknown');
      return { rows: [{}], rowCount: 1 };
    } };
    const result = await notifyApprovalRequired({ tenantId: 7, jobId: 'job-deferred', stage: 'strategy',
      appBaseUrl: 'https://aries.example.com', env: { ARIES_SLACK_NOTIFICATIONS_ENABLED: '1' },
      pool: db as never, resolveConfig: async () => null });
    assert.equal(reads, 1);
    assert.equal(result.reason, 'duplicate');
    assert.equal(loadExecutionRunRecord(id)!.callback_receipts![0].effects![0].disposition, 'unknown');
  });
});

test('protects disabled Slack evidence; fails_when disabled is indistinguishable from lost dispatch; no_claim enabled delivery', async () => {
  const { notifyApprovalRequired } = await import('../backend/integrations/slack/notifications');
  const { reconcileHermesMarketingCallbackReceipt } = await import('../backend/marketing/hermes-callbacks');
  await withReceipt(async (id) => {
    await notifyApprovalRequired({ tenantId: 7, jobId: 'job-deferred', stage: 'strategy',
      appBaseUrl: 'https://aries.example.com', env: { ARIES_SLACK_NOTIFICATIONS_ENABLED: '0' },
      pool: { query() { throw new Error('disabled must not query'); } } as never });
    const effect = loadExecutionRunRecord(id)!.callback_receipts![0].effects![0];
    assert.equal(effect?.target, 'slack_notification');
    assert.equal(effect?.disposition, 'not_applicable');
    const saved = loadExecutionRunRecord(id)!;
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, saved.callback_receipts![0]))[0].disposition, 'not_applicable');
    saved.callback_receipts![0].effects![0].disposition = 'unknown';
    saveExecutionRunRecord(saved);
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, { ...saved.callback_receipts![0],
      effects: [{ ...effect, disposition: 'not_applicable' }] }))[0].disposition, 'unknown');
  });
});

test('protects stopped receipts from deferred dispatch; fails_when intent failure still sends; no_claim remote containment', async (t) => {
  const { notifyApprovalRequired } = await import('../backend/integrations/slack/notifications');
  const { scheduleScheduledPostHonchoWrite } = await import('../backend/memory/write-events');
  await withReceipt(async (id) => {
    const run = loadExecutionRunRecord(id)!;
    run.callback_receipts![0].state = 'unknown';
    saveExecutionRunRecord(run);
    const defer = t.mock.method(globalThis, 'setImmediate', (() => { throw new Error('must not defer'); }) as unknown as typeof setImmediate);
    try {
      await assert.rejects(notifyApprovalRequired({ tenantId: 7, jobId: 'job-deferred', stage: 'strategy',
        appBaseUrl: 'https://aries.example.com', env: { ARIES_SLACK_NOTIFICATIONS_ENABLED: '1' },
        pool: { query() { throw new Error('must not query'); } } as never }), /callback effect receipt unavailable/);
      assert.throws(() => scheduleScheduledPostHonchoWrite({ tenantCtx: { tenantId: '7', tenantSlug: 'fixture', userId: 'system', role: 'tenant_admin' },
        jobId: 'job-deferred', postId: '42', platforms: ['instagram'], scheduledForIso: '2030-01-01T00:00:00Z' }), /callback effect receipt unavailable/);
      assert.equal(defer.mock.callCount(), 0);
    } finally { defer.mock.restore(); }
  });
});

test('protects Honcho intent before deferral; fails_when scheduler loses unrecorded work; no_claim provider success', async (t) => {
  const events = await import('../backend/memory/write-events');
  const old = { HONCHO_ENABLED: process.env.HONCHO_ENABLED, HONCHO_WRITE_PUBLISH_ENABLED: process.env.HONCHO_WRITE_PUBLISH_ENABLED,
    HONCHO_WRITE_APPROVALS_ENABLED: process.env.HONCHO_WRITE_APPROVALS_ENABLED };
  process.env.HONCHO_ENABLED = '1';
  process.env.HONCHO_WRITE_PUBLISH_ENABLED = '1';
  process.env.HONCHO_WRITE_APPROVALS_ENABLED = '1';
  try {
    await withReceipt(async (id) => {
      let scheduled = 0;
      const targets = ['honcho_schedule', 'honcho_publish', 'honcho_approval', 'honcho_performance'];
      const defer = t.mock.method(globalThis, 'setImmediate', (() => {
        assert.equal(loadExecutionRunRecord(id)!.callback_receipts![0].effects![scheduled]?.target, targets[scheduled]);
        scheduled++;
        return {};
      }) as unknown as typeof setImmediate);
      try {
        const tenantCtx = { tenantId: '7', tenantSlug: 'fixture', userId: 'system', role: 'tenant_admin' as const };
        events.scheduleScheduledPostHonchoWrite({ tenantCtx,
          jobId: 'job-deferred', postId: '42', platforms: ['instagram'], scheduledForIso: '2030-01-01T00:00:00Z' });
        events.schedulePublishVerificationHonchoWrite({ tenantCtx, jobId: 'job-deferred', platform: 'instagram', publishedAtYmd: '20300101' });
        events.scheduleMarketingApprovalHonchoWrites({ tenantCtx, memoryActorUserId: 'fixture-actor', jobId: 'job-deferred',
          stage: 'strategy', resolution: 'approve', eventDateYmd: '20300101' });
        events.scheduleHermesPublishPerformanceHonchoWrite({ doc: { job_id: 'job-deferred', tenant_id: '7' } as never, payloadRecord: null });
        assert.equal(scheduled, targets.length);
        assert.deepEqual(loadExecutionRunRecord(id)!.callback_receipts![0].effects!.map((effect) => effect.disposition), targets.map(() => 'unknown'));
      } finally { defer.mock.restore(); }
    });
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
