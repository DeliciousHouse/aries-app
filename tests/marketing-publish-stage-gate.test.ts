import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-publish-gate-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedJobAtPublishStage() {
  const {
    createMarketingJobRuntimeDocument,
    markStageCompleted,
    saveMarketingJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createMarketingJobRuntimeDocument({
    jobId: 'job-publish-gate',
    tenantId: '101',
    payload: {
      brandUrl: 'https://brand.example',
      businessType: 'performance marketing agency',
      competitorUrl: 'https://betterup.com',
    },
    brandKit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'clear',
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });

  // Simulate Stages 1-3 having completed with artifacts so we can assert
  // they're preserved after the publish-stage gate fires.
  markStageCompleted(doc, 'research', {
    runId: 'research-run-1',
    summary: { summary: 'research complete' },
    artifacts: [
      {
        id: 'research-artifact',
        stage: 'research',
        title: 'Research summary',
        category: 'analysis',
        status: 'completed',
        summary: 'Research artifact preserved',
        details: [],
      },
    ],
  });
  markStageCompleted(doc, 'strategy', {
    runId: 'strategy-run-1',
    summary: { summary: 'strategy complete' },
    artifacts: [
      {
        id: 'strategy-artifact',
        stage: 'strategy',
        title: 'Strategy plan',
        category: 'analysis',
        status: 'completed',
        summary: 'Strategy artifact preserved',
        details: [],
      },
    ],
  });
  markStageCompleted(doc, 'production', {
    runId: 'production-run-1',
    summary: { summary: 'production complete' },
    artifacts: [
      {
        id: 'production-artifact',
        stage: 'production',
        title: 'Production drafts',
        category: 'creative',
        status: 'completed',
        summary: 'Production artifact preserved',
        details: [],
      },
    ],
  });
  saveMarketingJobRuntime(doc.job_id, doc);
  return doc;
}

test('advancePublishStage short-circuits when Meta is not connected and preserves stages 1-3 artifacts', async () => {
  await withRuntimeEnv(async () => {
    const orchestrator = await import('../backend/marketing/orchestrator');
    const { loadMarketingJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');

    const doc = await seedJobAtPublishStage();

    let gateCalls = 0;
    orchestrator.__setPublishStageChannelGateForTests(async (tenantId: string) => {
      gateCalls++;
      assert.equal(tenantId, '101');
      return true; // tenant needs to connect Meta
    });

    try {
      await orchestrator.__advancePublishStageForTests(doc, 'resume-token-test');
    } finally {
      orchestrator.__setPublishStageChannelGateForTests(null);
    }

    assert.equal(gateCalls, 1, 'gate should be called exactly once');

    const reloaded = await loadMarketingJobRuntime(doc.job_id);
    assert.ok(reloaded, 'doc should be persisted');
    if (!reloaded) return;

    const publish = getStageRecord(reloaded, 'publish');
    assert.equal(publish.status, 'requires_channel_connection');
    assert.equal(reloaded.status, 'needs_connection');
    assert.equal(reloaded.state, 'needs_connection');

    // Stages 1-3 artifacts must be preserved.
    const research = getStageRecord(reloaded, 'research');
    assert.equal(research.status, 'completed');
    assert.ok(research.artifacts.some((a) => a.id === 'research-artifact'));

    const strategy = getStageRecord(reloaded, 'strategy');
    assert.equal(strategy.status, 'completed');
    assert.ok(strategy.artifacts.some((a) => a.id === 'strategy-artifact'));

    const production = getStageRecord(reloaded, 'production');
    assert.equal(production.status, 'completed');
    assert.ok(production.artifacts.some((a) => a.id === 'production-artifact'));

    // Publish stage carries the channel-connect artifact and no approval pause.
    assert.ok(publish.artifacts.some((a) => a.id === 'publish-needs-channel'));
    assert.equal(reloaded.approvals.current, null);

    // History line written.
    const historyNote = reloaded.history.find((h: { note?: string | null }) => (h.note ?? '').includes('no Meta connection'));
    assert.ok(historyNote, 'expected publish-paused history entry');
  });
});

test('advancePublishStage proceeds past the gate when Meta is connected', async () => {
  await withRuntimeEnv(async () => {
    const orchestrator = await import('../backend/marketing/orchestrator');
    const doc = await seedJobAtPublishStage();

    let gateCalls = 0;
    orchestrator.__setPublishStageChannelGateForTests(async () => {
      gateCalls++;
      return false; // tenant is connected
    });

    // We expect the function to attempt Hermes submission and fail because no
    // execution backend is wired in tests. The important assertion is that it
    // passed the gate and did NOT short-circuit to requires_channel_connection.
    let threw = false;
    try {
      await orchestrator.__advancePublishStageForTests(doc, 'resume-token-test');
    } catch {
      threw = true;
    } finally {
      orchestrator.__setPublishStageChannelGateForTests(null);
    }

    assert.equal(gateCalls, 1, 'gate should be called exactly once');

    const { loadMarketingJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');
    const reloaded = await loadMarketingJobRuntime(doc.job_id);
    assert.ok(reloaded);
    if (!reloaded) return;
    const publish = getStageRecord(reloaded, 'publish');
    // Must not be the short-circuit status; either in_progress, failed, or
    // some other downstream state — but never requires_channel_connection.
    assert.notEqual(publish.status, 'requires_channel_connection');
    assert.ok(threw || publish.status !== 'requires_channel_connection');
  });
});
