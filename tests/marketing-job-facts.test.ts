import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectProductionReviewArtifacts,
  collectResearchStageArtifacts,
  collectStrategyReviewArtifacts,
} from '../backend/marketing/artifact-collector';
import { createMarketingJobFacts } from '../backend/marketing/job-facts';
import { createMarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';
import type { MarketingArtifactStageNumber, StepPayloadResolution } from '../backend/marketing/stage-artifact-resolution';

function makeRuntimeDoc() {
  const runtimeDoc = createMarketingJobRuntimeDocument({
    jobId: 'mkt_job_facts',
    tenantId: 'tenant_job_facts',
      payload: {
        brandUrl: 'https://brand.example.com',
        websiteUrl: 'https://brand.example.com',
      },
      brandKit: {
        path: '/tmp/tenant_job_facts.brand-kit.json',
        source_url: 'https://brand.example.com',
        canonical_url: 'https://brand.example.com',
        brand_name: 'Brand Example',
      logo_urls: [],
      colors: {
        primary: '#111111',
        secondary: '#f4f4f4',
        accent: '#c24d2c',
        palette: ['#111111', '#f4f4f4', '#c24d2c'],
      },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: '2026-04-24T00:00:00.000Z',
      brand_voice_summary: 'Direct and grounded.',
      offer_summary: 'Proof-led launch audit.',
    },
  });

  runtimeDoc.stages.research.run_id = 'run-research';
  runtimeDoc.stages.strategy.run_id = 'run-strategy';
  runtimeDoc.stages.production.run_id = 'run-production';
  runtimeDoc.stages.publish.run_id = 'run-publish';

  return runtimeDoc;
}

function resolvedPayload(
  runId: string,
  payload: Record<string, unknown>,
  filePath = `/tmp/${runId}.json`,
): StepPayloadResolution {
  return {
    runId,
    path: filePath,
    payload,
    source: 'cache',
  };
}

test('stagePayload loads the same step once', async () => {
  const runtimeDoc = makeRuntimeDoc();
  let reads = 0;
  const facts = createMarketingJobFacts(runtimeDoc, null, {
    readStageStepPayload: async () => {
      reads += 1;
      return resolvedPayload('run-production', { ok: true });
    },
  });

  const first = await facts.stagePayload('production', 'veo_video_generator');
  const second = await facts.stagePayload('production', 'veo_video_generator');

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(reads, 1);
});

test('concurrent stagePayload lookups dedupe the in-flight read', async () => {
  const runtimeDoc = makeRuntimeDoc();
  let reads = 0;
  const facts = createMarketingJobFacts(runtimeDoc, null, {
    readStageStepPayload: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return resolvedPayload('run-production', { ok: true });
    },
  });

  const [first, second] = await Promise.all([
    facts.stagePayload('production', 'veo_video_generator'),
    facts.stagePayload('production', 'veo_video_generator'),
  ]);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(reads, 1);
});

test('different stage keys do not collide', async () => {
  const runtimeDoc = makeRuntimeDoc();
  const seenKeys: string[] = [];
  const facts = createMarketingJobFacts(runtimeDoc, null, {
    readStageStepPayload: async (_runtimeDoc, stage, stepName) => {
      seenKeys.push(`${stage}:${stepName}`);
      return resolvedPayload(`run-${stage}`, { stage, stepName });
    },
  });

  const [research, strategy] = await Promise.all([
    facts.stagePayload('research', 'shared_step'),
    facts.stagePayload('strategy', 'shared_step'),
  ]);

  assert.deepEqual(research, { stage: 1, stepName: 'shared_step' });
  assert.deepEqual(strategy, { stage: 2, stepName: 'shared_step' });
  assert.deepEqual(seenKeys.sort(), ['1:shared_step', '2:shared_step']);
});

test('jsonAtPath memoizes repeated path reads', async () => {
  const runtimeDoc = makeRuntimeDoc();
  let reads = 0;
  const facts = createMarketingJobFacts(runtimeDoc, null, {
    readJsonAtPath: async () => {
      reads += 1;
      return { ok: true };
    },
  });

  const [first, second] = await Promise.all([
    facts.jsonAtPath('/tmp/reused.json'),
    facts.jsonAtPath('/tmp/reused.json'),
  ]);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(reads, 1);
});

test('jsonAtPath caches missing files as null', async () => {
  const runtimeDoc = makeRuntimeDoc();
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aries-job-facts-missing-'));
  const missingPath = path.join(tempRoot, 'missing.json');

  try {
    const facts = createMarketingJobFacts(runtimeDoc, null);
    const first = facts.jsonAtPath(missingPath);
    const second = facts.jsonAtPath(missingPath);

    assert.strictEqual(first, second);
    assert.equal(await first, null);
    assert.strictEqual(facts.jsonAtPath(missingPath), first);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('jsonAtPath caches malformed JSON as null', async () => {
  const runtimeDoc = makeRuntimeDoc();
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aries-job-facts-malformed-'));
  const malformedPath = path.join(tempRoot, 'broken.json');

  try {
    await mkdir(path.dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, '{not-json', 'utf8');

    const facts = createMarketingJobFacts(runtimeDoc, null);
    const first = facts.jsonAtPath(malformedPath);
    const second = facts.jsonAtPath(malformedPath);

    assert.strictEqual(first, second);
    assert.equal(await first, null);
    assert.strictEqual(facts.jsonAtPath(malformedPath), first);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('shared facts dedupe stage payload reads across collector invocations', async () => {
  const runtimeDoc = makeRuntimeDoc();
  const readCounts = new Map<string, number>();

  const stagePayloads = new Map<string, Record<string, unknown>>([
    ['1:ads_analyst_compile', { executive_summary: { market_positioning: 'Research ready' } }],
    ['1:meta_ads_extractor', { competitor: 'Competitor Example' }],
    ['2:website_brand_analysis', {
      brand_slug: 'brand-example',
      brand_analysis: { brand_promise: 'Clear value' },
    }],
    ['2:campaign_planner', { campaign_plan: { core_message: 'Planner ready', primary_cta: 'Book now' } }],
    ['2:strategy_review_preview', { review_packet: { objective: 'Review strategy', channels_in_scope: ['meta-ads'] } }],
    ['3:production_review_preview', { review_packet: { summary: { core_message: 'Production ready' }, asset_previews: {} } }],
    ['3:veo_video_generator', { video_assets: { platform_contracts: [] } }],
  ]);

  const facts = createMarketingJobFacts(runtimeDoc, null, {
    readStageStepPayload: async (_runtimeDoc, stage: MarketingArtifactStageNumber, stepName: string) => {
      const key = `${stage}:${stepName}`;
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
      return resolvedPayload(`run-${stage}`, stagePayloads.get(key) ?? {}, `/tmp/${key}.json`);
    },
    readJsonAtPath: async () => null,
  });

  await Promise.all([
    collectResearchStageArtifacts(facts, runtimeDoc.stages.research.primary_output),
    collectStrategyReviewArtifacts(facts, runtimeDoc.stages.strategy.primary_output),
    collectProductionReviewArtifacts(facts, { job_id: runtimeDoc.job_id }),
    collectResearchStageArtifacts(facts, runtimeDoc.stages.research.primary_output),
    collectStrategyReviewArtifacts(facts, runtimeDoc.stages.strategy.primary_output),
    collectProductionReviewArtifacts(facts, { job_id: runtimeDoc.job_id }),
  ]);

  assert.deepEqual(
    Array.from(readCounts.entries()).sort(([left], [right]) => left.localeCompare(right)),
    [
      ['1:ads_analyst_compile', 1],
      ['1:meta_ads_extractor', 1],
      ['2:campaign_planner', 1],
      ['2:strategy_review_preview', 1],
      ['2:website_brand_analysis', 1],
      ['3:production_review_preview', 1],
      ['3:veo_video_generator', 1],
    ],
  );
});
