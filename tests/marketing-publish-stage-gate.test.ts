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
    createSocialContentJobRuntimeDocument,
    markStageCompleted,
    saveSocialContentJobRuntime,
  } = await import('../backend/marketing/runtime-state');

  const doc = createSocialContentJobRuntimeDocument({
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
  saveSocialContentJobRuntime(doc.job_id, doc);
  return doc;
}

test('advancePublishStage short-circuits when no channel is connected and preserves stages 1-3 artifacts', async () => {
  await withRuntimeEnv(async () => {
    const orchestrator = await import('../backend/marketing/orchestrator');
    const { loadSocialContentJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');

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

    const reloaded = await loadSocialContentJobRuntime(doc.job_id);
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

    // History line written. The note is channel-neutral (internal wording, not
    // operator copy) so it reads correctly whichever platforms are in play.
    const historyNote = reloaded.history.find((h: { note?: string | null }) =>
      (h.note ?? '').includes('no connected publishing channel'),
    );
    assert.ok(historyNote, 'expected publish-paused history entry');

    // Operator-facing copy stays Meta-specific while the AA-217 flag is OFF:
    // with the flag off, connecting anything else genuinely will not unblock
    // this job, so neutral wording would misdirect the reader.
    const artifact = publish.artifacts.find((a) => a.id === 'publish-needs-channel');
    assert.ok(artifact);
    assert.equal(artifact?.title, 'Connect Meta to publish');
    assert.match(publish.summary?.summary ?? '', /Connect Meta in Settings/);
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

    const { loadSocialContentJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');
    const reloaded = await loadSocialContentJobRuntime(doc.job_id);
    assert.ok(reloaded);
    if (!reloaded) return;
    const publish = getStageRecord(reloaded, 'publish');
    // Must not be the short-circuit status; either in_progress, failed, or
    // some other downstream state — but never requires_channel_connection.
    assert.notEqual(publish.status, 'requires_channel_connection');
    assert.ok(threw || publish.status !== 'requires_channel_connection');
  });
});

// ---------------------------------------------------------------------------
// AA-217: with ARIES_ANY_PLATFORM_PUBLISH_ENABLED on, any connected publishable
// platform gets a tenant past this gate — and the blocked-state copy turns
// channel-neutral only once the flag makes that statement true.
//
// The gate under test is the REAL verdict function (tenantNeedsChannelConnection
// over the real counters); only the pool is faked, since the default gate opens
// its own connection.
// ---------------------------------------------------------------------------

const AA217_ENVS = [
  'ARIES_ANY_PLATFORM_PUBLISH_ENABLED',
  'ARIES_X_ENABLED',
  'ARIES_LINKEDIN_ENABLED',
  'ARIES_REDDIT_ENABLED',
  'COMPOSIO_REDDIT_TARGET_SUBREDDIT',
] as const;

async function withFlags<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const prev = AA217_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of AA217_ENVS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await run();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Answers both connection-count queries from a list of connected platforms. */
function connectionsClient(connected: string[]) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const scoped = sql.includes('platform = ANY($2)')
        ? ((params[1] as string[]) ?? [])
        : ['facebook', 'instagram'];
      const count = connected.filter((p) => scoped.includes(p)).length;
      return { rows: [{ connected_count: count }], rowCount: 1 };
    },
  };
}

/** The real gate verdict, wired to a fake client instead of the pool. */
async function realGateFor(connected: string[], tenantId: string): Promise<boolean> {
  const { tenantNeedsChannelConnection } = await import('../lib/tenant-needs-channel-connection');
  return tenantNeedsChannelConnection(
    connectionsClient(connected) as never,
    tenantId,
  );
}

test('AA-217 flag ON: a LinkedIn-only tenant passes the publish gate', async () => {
  await withRuntimeEnv(async () => {
    await withFlags({ ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1', ARIES_LINKEDIN_ENABLED: 'true' }, async () => {
      const orchestrator = await import('../backend/marketing/orchestrator');
      const doc = await seedJobAtPublishStage();

      orchestrator.__setPublishStageChannelGateForTests((tenantId) =>
        realGateFor(['linkedin'], tenantId),
      );
      try {
        await orchestrator.__advancePublishStageForTests(doc, 'resume-token-test');
      } catch {
        // Hermes submission is expected to fail in tests; the gate is the subject.
      } finally {
        orchestrator.__setPublishStageChannelGateForTests(null);
      }

      const { loadSocialContentJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');
      const reloaded = await loadSocialContentJobRuntime(doc.job_id);
      assert.ok(reloaded);
      if (!reloaded) return;
      assert.notEqual(
        getStageRecord(reloaded, 'publish').status,
        'requires_channel_connection',
        'a connected LinkedIn account must unblock Stage 4',
      );
    });
  });
});

test('AA-217 flag ON: a zero-connection tenant is still blocked, with channel-neutral copy', async () => {
  await withRuntimeEnv(async () => {
    await withFlags({ ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1', ARIES_LINKEDIN_ENABLED: 'true' }, async () => {
      const orchestrator = await import('../backend/marketing/orchestrator');
      const doc = await seedJobAtPublishStage();

      orchestrator.__setPublishStageChannelGateForTests((tenantId) => realGateFor([], tenantId));
      try {
        await orchestrator.__advancePublishStageForTests(doc, 'resume-token-test');
      } finally {
        orchestrator.__setPublishStageChannelGateForTests(null);
      }

      const { loadSocialContentJobRuntime, getStageRecord } = await import('../backend/marketing/runtime-state');
      const reloaded = await loadSocialContentJobRuntime(doc.job_id);
      assert.ok(reloaded);
      if (!reloaded) return;

      const publish = getStageRecord(reloaded, 'publish');
      assert.equal(publish.status, 'requires_channel_connection');
      assert.equal(reloaded.status, 'needs_connection');

      // Copy is neutral now that any channel would genuinely unblock the job.
      const artifact = publish.artifacts.find((a) => a.id === 'publish-needs-channel');
      assert.ok(artifact);
      assert.equal(artifact?.title, 'Connect a social account to publish');
      assert.match(publish.summary?.summary ?? '', /Connect a social account in Settings/);
      assert.doesNotMatch(publish.summary?.summary ?? '', /Connect Meta/);

      // Stages 1-3 are still preserved.
      for (const stage of ['research', 'strategy', 'production'] as const) {
        assert.equal(getStageRecord(reloaded, stage).status, 'completed');
      }
    });
  });
});

test('AA-217 flag ON: a pending-only connection does not open the gate', async () => {
  await withRuntimeEnv(async () => {
    await withFlags({ ARIES_ANY_PLATFORM_PUBLISH_ENABLED: '1', ARIES_LINKEDIN_ENABLED: 'true' }, async () => {
      // connectionsClient only ever counts connected rows, so "pending only" is
      // modelled as an empty connected list — the gate must stay shut.
      assert.equal(await realGateFor([], '101'), true);
    });
  });
});
