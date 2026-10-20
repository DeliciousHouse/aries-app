import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { createExecutionRunRecord, loadExecutionRunRecord, saveExecutionRunRecord, type ExecutionRunRecord } from '../backend/execution/run-store';
import { callbackEffectDigest, recordCallbackEffectIntent, withCallbackEffectScope } from '../backend/execution/callback-effects';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

async function withEffectRun(action: (run: ExecutionRunRecord) => Promise<void>) {
  const previous = process.env.DATA_ROOT;
  const root = mkdtempSync(path.join(tmpdir(), 'callback-writer-'));
  process.env.DATA_ROOT = root;
  try {
    const run = createExecutionRunRecord({ provider: 'hermes', domain: 'marketing',
      action: 'run', workflowKey: 'social_content_weekly', tenantId: '7', marketingJobId: 'job-effect' });
    run.external_run_id = 'native';
    run.callback_receipts = [{ event_id: 'writer', payload_sha256: 'b'.repeat(64),
      external_run_id: 'native', state: 'applying', effects: [] }];
    saveExecutionRunRecord(run);
    await withCallbackEffectScope(run, run.callback_receipts[0], () => action(run));
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('protects scheduled target and slot intent before SQL; fails_when intent is absent; no_claim live publish', async () => {
  const { upsertScheduledPost } = await import('../backend/social-content/scheduled-posts');
  await withEffectRun(async (run) => {
    let writes = 0;
    const scheduledFor = new Date('2030-01-01T12:00:00Z');
    await upsertScheduledPost({ async query(sql) {
      if (sql.includes('INSERT INTO scheduled_posts')) {
        writes++;
        const effects = loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!;
        assert.equal(effects[0].target, 'scheduled_post');
        assert.equal(effects[0].key, '42');
        assert.equal(effects[0].expected_sha256, callbackEffectDigest({ post_id: '42', tenant_id: 7,
          scheduled_for: scheduledFor.toISOString(), target_platforms: ['instagram'], campaign_end_date: null,
          surface: 'feed', media_type: 'image', width_px: null, height_px: null, duration_seconds: null }));
      }
      return { rows: [{ id: '1', post_id: 42, tenant_id: 7, scheduled_for: scheduledFor,
        target_platforms: ['instagram'], updated_at: scheduledFor }], rowCount: 1 };
    } }, { postId: 42, tenantId: 7, platforms: ['instagram'], scheduledFor });
    assert.equal(writes, 1);
  });
});

test('protects source-bound read-only SQL effect evidence; fails_when missing duplicate changed or invented; no_claim database or provider acceptance', async (t) => {
  const { pool } = await import('../lib/db');
  const { reconcileHermesMarketingCallbackReceipt } = await import('../backend/marketing/hermes-callbacks');
  await withEffectRun(async (run) => {
    const expected = { tenant_id: 7, job_id: 'job-effect', hermes_run_id: 'native', platform: 'instagram',
      caption: 'test', idempotency_key: 'job-effect:1:instagram:feed', creative_asset_ids: [], media_type: 'image',
      surface: 'feed', style_dimension: null, style_value: null, width_px: null, height_px: null, duration_seconds: null };
    recordCallbackEffectIntent('post', expected.idempotency_key, expected);
    let rows: Record<string, unknown>[] = [expected];
    let reads = 0;
    const mock = t.mock.method(pool, 'query', async (sql: string, params: unknown[]) => {
      assert.match(sql, /^SELECT/);
      assert.match(sql, /tenant_id = \$2 AND job_id = \$3 LIMIT 2/);
      assert.deepEqual(params, [expected.idempotency_key, 7, 'job-effect']);
      reads++;
      return { rows, rowCount: rows.length };
    });
    try {
      const saved = loadExecutionRunRecord(run.aries_run_id)!;
      const receipt = saved.callback_receipts![0];
      const original = JSON.stringify(saved);
      assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'verified');
      for (const unavailable of [[], [expected, expected], [{ ...expected, caption: 'changed' }]]) {
        rows = unavailable;
        assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
      }
      const before = reads;
      assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, { ...receipt,
        effects: [{ ...receipt.effects![0], key: 'invented' }] }))[0].disposition, 'unknown');
      assert.equal(reads, before);
      assert.equal(JSON.stringify(loadExecutionRunRecord(run.aries_run_id)), original);
    } finally { mock.mock.restore(); }
  });
});

test('protects actual asset and post writers intent timing; fails_when write precedes receipt; no_claim live database or durable object storage', async () => {
  const { ingestProductionCreativeAssetsToDb } = await import('../backend/marketing/ingest-production-assets');
  const { synthesizePublishPostsFromContentPackage } = await import('../backend/marketing/synthesize-publish-posts');
  const previousMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const previousDurable = process.env.ARIES_DURABLE_MEDIA_ENABLED;
  try {
    process.env.ARIES_DURABLE_MEDIA_ENABLED = '0';
    await withEffectRun(async (run) => {
      process.env.HERMES_IMAGE_CACHE_MOUNT = process.env.DATA_ROOT;
      writeFileSync(path.join(process.env.DATA_ROOT!, 'intent.png'), Buffer.from('fixture-bytes'));
      const doc = { job_id: 'job-effect', tenant_id: '7', stages: {
        production: { primary_output: { stage: 'production', artifacts: {
          creative_assets: [{ assetId: 'image_1', type: 'image', path: '/cache/intent.png' }],
        }, content_package: [{ post_number: 1, hook: 'Test', platforms: ['instagram'] }] } },
        publish: { primary_output: { stage: 'publish', schedule: [
          { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
        ] } },
      }, approvals: { current: null, history: [] }, publish_config: { platforms: [] },
      inputs: { request: {} }, brand_kit: null } as unknown as SocialContentJobRuntimeDocument;
      let assets = 0;
      let posts = 0;
      const db = { async query(sql: string, params: unknown[] = []) {
        const effects = loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!;
        if (sql.includes('INSERT INTO creative_assets')) {
          assets++;
          assert.ok(effects.some((effect) => effect.target === 'creative_asset_checksum' && effect.key === params[4]));
          return { rows: [{ id: 'asset-row' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO posts')) {
          posts++;
          assert.ok(effects.some((effect) => effect.target === 'post' && effect.key === params[5]));
          return { rows: [{ id: 'post-row' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      } };
      await ingestProductionCreativeAssetsToDb({ jobId: 'job-effect', tenantId: 7, doc, pool: db });
      assert.equal(assets, 1);
      const effects = loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!;
      assert.equal(effects.find((effect) => effect.target === 'creative_asset_row')?.key, 'asset-row');
      await synthesizePublishPostsFromContentPackage({ jobId: 'job-effect', tenantId: 7, doc,
        publishRunId: 'native', pool: db });
      assert.equal(posts, 1);
    });
  } finally {
    if (previousMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = previousMount;
    if (previousDurable === undefined) delete process.env.ARIES_DURABLE_MEDIA_ENABLED;
    else process.env.ARIES_DURABLE_MEDIA_ENABLED = previousDurable;
  }
});

test('protects child identity before actual Hermes port POST; fails_when missing or ambiguous submission; no_claim native history', async () => {
  const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
  const { reconcileHermesMarketingCallbackReceipt } = await import('../backend/marketing/hermes-callbacks');
  await withEffectRun(async (run) => {
    let posts = 0;
    const port = new HermesMarketingPort({ HERMES_GATEWAY_URL: 'http://localhost:8787',
      HERMES_API_SERVER_KEY: 'fixture-key', HERMES_POLL_BRIDGE_ENABLED: '0',
      INTERNAL_API_SECRET: 'fixture-callback', APP_BASE_URL: 'https://aries.example.com',
      ARIES_PERF_CONTEXT_ENABLED: '0' }, async (_url, init) => {
      posts++;
      const payload = JSON.parse(String(init?.body));
      const effect = loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!
        .find((item) => item.target === 'child_submission');
      assert.equal(effect?.key, payload.callback_context.aries_run_id);
      const child = loadExecutionRunRecord(effect!.key!)!;
      assert.equal(child.submission?.state, 'unknown');
      return new Response(JSON.stringify({ run_id: 'native-child' }), { status: 202 });
    }, async () => {}, async () => ({ refreshed: false, enriched: false }), { query: async () => ({ rows: [], rowCount: 1 }) });
    const doc = { job_id: 'job-effect', tenant_id: '7', inputs: { request: {}, brand_url: 'https://example.com' },
      brand_kit: { brand_name: 'Test' } } as unknown as SocialContentJobRuntimeDocument;
    await port.runPipeline({ jobId: 'job-effect', doc, argsJson: '{}', timeoutMs: 1000, maxStdoutBytes: 65536 });
    assert.equal(posts, 1);
    const saved = loadExecutionRunRecord(run.aries_run_id)!;
    const receipt = saved.callback_receipts![0];
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'verified');
    const child = loadExecutionRunRecord(receipt.effects![0].key!)!;
    child.submission!.state = 'unknown';
    saveExecutionRunRecord(child);
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
    assert.equal(posts, 1);
  });
});

test('protects projection writer intent and readback; fails_when missing changed corrupt or cross-tenant; no_claim whole callback delivery', async () => {
  const store = await import('../backend/marketing/workspace-store');
  const { reconcileHermesMarketingCallbackReceipt } = await import('../backend/marketing/hermes-callbacks');
  await withEffectRun(async (run) => {
    const record = { schema_name: 'marketing_campaign_workspace', schema_version: '1.0.0',
      job_id: 'job-effect', tenant_id: '7', brief: {}, stage_reviews: {}, creative_asset_reviews: {},
      status_history: [] } as unknown as Parameters<typeof store.saveSocialContentWorkspaceRecord>[0];
    const file = store.saveSocialContentWorkspaceRecord(record);
    const projection = { post: null, sourceUpdatedAt: '2030-01-01T00:00:00.000Z',
      listRow: { dashboard: { posts: [], assets: [], publishItems: [], calendarEvents: [],
        statuses: { countsByStatus: {} } } } } as unknown as Parameters<typeof store.persistDashboardListProjection>[2];
    store.persistDashboardListProjection('job-effect', '7', projection);
    store.persistPendingApprovalCount('job-effect', '7', 3);
    const saved = loadExecutionRunRecord(run.aries_run_id)!;
    const receipt = saved.callback_receipts![0];
    assert.deepEqual(receipt.effects!.map((effect) => effect.target), ['dashboard_projection', 'pending_approval_count']);
    assert.deepEqual((await reconcileHermesMarketingCallbackReceipt(saved, receipt)).map((effect) => effect.disposition), ['verified', 'verified']);
    assert.equal(store.persistPendingApprovalCount('job-effect', '7', 3), false);
    assert.equal(store.persistPendingApprovalCount('job-effect', '7', 4), true);
    const changed = loadExecutionRunRecord(run.aries_run_id)!;
    assert.deepEqual((await reconcileHermesMarketingCallbackReceipt(changed, changed.callback_receipts![0]))
      .map((effect) => effect.disposition), ['verified', 'unknown', 'verified']);
    for (const bad of [
      { ...record, tenant_id: '8', dashboard_list_projection: projection, pending_approval_count: 3 },
      { ...record, dashboard_list_projection: { ...projection, sourceUpdatedAt: 'changed' }, pending_approval_count: 4 },
      { ...record },
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.deepEqual((await reconcileHermesMarketingCallbackReceipt(saved, receipt)).map((effect) => effect.disposition), ['unknown', 'unknown']);
    }
    writeFileSync(file, '{');
    assert.deepEqual((await reconcileHermesMarketingCallbackReceipt(saved, receipt)).map((effect) => effect.disposition), ['unknown', 'unknown']);
    rmSync(file);
    assert.deepEqual((await reconcileHermesMarketingCallbackReceipt(saved, receipt)).map((effect) => effect.disposition), ['unknown', 'unknown']);
    assert.equal(JSON.stringify(loadExecutionRunRecord(run.aries_run_id)), JSON.stringify(changed));
  });
});

test('protects runtime snapshot before file mutation; fails_when missing corrupt changed or wrong tenant; no_claim historical delivery', async (t) => {
  const runtime = await import('../backend/marketing/runtime-state');
  const { reconcileHermesMarketingCallbackReceipt } = await import('../backend/marketing/hermes-callbacks');
  await withEffectRun(async (run) => {
    const doc = runtime.createSocialContentJobRuntimeDocument({ jobId: 'job-effect', tenantId: '7',
      payload: { brandUrl: 'https://example.com' }, brandKit: { source_url: 'https://example.com',
        extracted_at: '2030-01-01T00:00:00.000Z' } as Parameters<typeof runtime.createSocialContentJobRuntimeDocument>[0]['brandKit'] });
    const file = runtime.marketingRuntimePath(doc.job_id);
    const write = fs.writeFileSync;
    const fault = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === file) {
        assert.ok(loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!
          .some((effect) => effect.target === 'marketing_runtime_snapshot'));
        throw new Error('injected runtime write failure');
      }
      return write(...args);
    });
    assert.throws(() => runtime.saveSocialContentJobRuntime(doc.job_id, doc), /injected runtime write failure/);
    fault.mock.restore();
    const saved = loadExecutionRunRecord(run.aries_run_id)!;
    const receipt = saved.callback_receipts![0];
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
    writeFileSync(file, JSON.stringify(doc));
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'verified');
    for (const bad of [{ ...doc, tenant_id: '8' }, { ...doc, state: 'failed' }, { ...doc, job_id: 'other' }]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
    }
    writeFileSync(file, '{');
    assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
    assert.equal(JSON.stringify(loadExecutionRunRecord(run.aries_run_id)), JSON.stringify(saved));
  });
});

test('protects ingested media bytes and tenant intent before rename; fails_when changed or missing; no_claim remote storage', async (t) => {
  const { ingestSinglePath, readIngestedAssetEvidence } = await import('../backend/marketing/asset-ingest');
  const { reconcileHermesMarketingCallbackReceipt } = await import('../backend/marketing/hermes-callbacks');
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'callback-source-'));
  const source = path.join(sourceRoot, 'image.png');
  writeFileSync(source, 'isolated media bytes');
  try {
    await withEffectRun(async (run) => {
      const rename = fs.renameSync;
      let observed = false;
      const probe = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]).includes('ingested-assets')) {
          observed = true;
          assert.ok(loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!
            .some((effect) => effect.target === 'ingested_asset'));
        }
        return rename(...args);
      });
      const destination = ingestSinglePath(source, '7');
      probe.mock.restore();
      assert.equal(observed, true);
      const saved = loadExecutionRunRecord(run.aries_run_id)!;
      const receipt = saved.callback_receipts![0];
      const key = receipt.effects![0].key!;
      assert.equal(await readIngestedAssetEvidence('8', key), null);
      assert.equal(await readIngestedAssetEvidence('7', `../${key}`), null);
      assert.equal(await readIngestedAssetEvidence('7', key.replace('ingested-assets/', 'ingested-assets\\')), null);
      assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'verified');
      writeFileSync(destination, 'changed bytes');
      assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
      rmSync(destination);
      assert.equal((await reconcileHermesMarketingCallbackReceipt(saved, receipt))[0].disposition, 'unknown');
      assert.equal(JSON.stringify(loadExecutionRunRecord(run.aries_run_id)), JSON.stringify(saved));
    });
  } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
});

test('protects durable callback effect identity; fails_when changed or late intent writes; no_claim provider acceptance', async () => {
  const previous = process.env.DATA_ROOT;
  const root = mkdtempSync(path.join(tmpdir(), 'callback-effect-intent-'));
  process.env.DATA_ROOT = root;
  try {
    const run = createExecutionRunRecord({ provider: 'hermes', domain: 'marketing',
      action: 'run', workflowKey: 'social_content_weekly', tenantId: '7', marketingJobId: 'job-effect' });
    const receipt = { event_id: 'effect-test', payload_sha256: 'a'.repeat(64), external_run_id: 'native',
      state: 'applying' as const, effects: [] };
    run.external_run_id = 'native';
    run.callback_receipts = [receipt];
    saveExecutionRunRecord(run);
    recordCallbackEffectIntent('post', 'outside', { caption: 'not part of a callback' });
    assert.equal(loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!.length, 0);
    await withCallbackEffectScope(run, receipt, async () => {
      const expected = { caption: 'test', tenant_id: 7 };
      recordCallbackEffectIntent('post', 'job:1:facebook:feed', expected);
      const saved = loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!;
      assert.deepEqual(saved, [{ target: 'post', key: 'job:1:facebook:feed',
        expected_sha256: callbackEffectDigest(expected), disposition: 'unknown' }]);
      recordCallbackEffectIntent('post', 'job:1:facebook:feed', { tenant_id: 7, caption: 'test' });
      assert.equal(receipt.effects.length, 1);
      assert.throws(() => recordCallbackEffectIntent('post', 'job:1:facebook:feed', { caption: 'changed' }), /conflicting/);
      const latest = loadExecutionRunRecord(run.aries_run_id)!;
      latest.callback_receipts![0].state = 'unknown';
      saveExecutionRunRecord(latest);
      assert.throws(() => recordCallbackEffectIntent('post', 'late', expected), /unavailable/);
    });
    assert.equal(loadExecutionRunRecord(run.aries_run_id)!.callback_receipts![0].effects!.length, 1);
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
