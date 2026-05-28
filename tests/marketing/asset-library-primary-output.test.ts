import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { resolveStageOutput } from '../../backend/marketing/runtime-state';
import { primaryOutputToSocialContentPlanner } from '../../backend/marketing/workspace-views';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

async function loadFixture(): Promise<SocialContentJobRuntimeDocument> {
  const fixturePath = path.resolve('tests/fixtures/marketing-runtime-primary-output.json');
  const raw = JSON.parse(await readFile(fixturePath, 'utf8'));
  return raw as SocialContentJobRuntimeDocument;
}

function extractHookForAsset(doc: SocialContentJobRuntimeDocument, assetId: string): string | null {
  const match = /^img_(\d+)$/.exec(assetId);
  if (!match) return null;
  const postIndex = parseInt(match[1], 10) - 1;

  const productionOutput = resolveStageOutput(doc, 'production');
  const strategyOutput = resolveStageOutput(doc, 'strategy');

  const productionPkg = (productionOutput && Array.isArray(productionOutput.content_package))
    ? (productionOutput.content_package as Array<Record<string, unknown>>)
    : [];
  const strategyPkg = strategyOutput ? (() => {
    const planner = primaryOutputToSocialContentPlanner(strategyOutput);
    const campaignPlan = planner.campaign_plan as Record<string, unknown>;
    return Array.isArray(campaignPlan.content_package)
      ? (campaignPlan.content_package as Array<Record<string, unknown>>)
      : [];
  })() : [];

  const pkg = productionPkg.length > 0 ? productionPkg : strategyPkg;
  const entry = pkg[postIndex];
  return (typeof entry?.hook === 'string' && entry.hook.length > 0) ? entry.hook : null;
}

test('asset img_1 hook comes from production.primary_output.content_package[0].hook', async () => {
  const doc = await loadFixture();
  const hook = extractHookForAsset(doc, 'img_1');
  assert.ok(hook, 'hook should be non-null for img_1');
  assert.ok(hook.includes('content plan you can actually see'), 'hook text should match fixture');
});

test('asset img_2 hook comes from production.primary_output.content_package[1].hook', async () => {
  const doc = await loadFixture();
  const hook = extractHookForAsset(doc, 'img_2');
  assert.ok(hook, 'hook should be non-null for img_2');
  assert.ok(hook.includes('drafted'), 'hook text should match fixture for img_2');
});

test('asset img_7 hook comes from production.primary_output.content_package[6].hook (last post)', async () => {
  const doc = await loadFixture();
  const hook = extractHookForAsset(doc, 'img_7');
  assert.ok(hook, 'hook should be non-null for img_7');
  assert.ok(hook.includes('Plan.'), 'hook text should match fixture for img_7');
});

test('asset img_99 returns null (no such post in content_package)', async () => {
  const doc = await loadFixture();
  const hook = extractHookForAsset(doc, 'img_99');
  assert.equal(hook, null, 'out-of-range asset ID should return null, not throw');
});

test('non-img_ asset ID returns null (not a numbered img)', async () => {
  const doc = await loadFixture();
  const hook = extractHookForAsset(doc, 'some-hash-based-id-abc12345');
  assert.equal(hook, null, 'non-img_ asset ID should return null without error');
});

test('all 7 img_ assets have non-null hook text from production primary_output', async () => {
  const doc = await loadFixture();
  for (let i = 1; i <= 7; i++) {
    const hook = extractHookForAsset(doc, `img_${i}`);
    assert.ok(hook !== null, `img_${i} should have non-null hook`);
    assert.ok(hook!.length > 0, `img_${i} hook should be non-empty`);
  }
});

test('production primary_output content_package preferred over strategy fallback', async () => {
  const doc = await loadFixture();
  // Both production and strategy have content_package for fixture.
  // Production package should be used first.
  const productionOutput = resolveStageOutput(doc, 'production');
  assert.ok(productionOutput, 'production output resolves');

  const productionPkg = productionOutput.content_package as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(productionPkg) && productionPkg.length > 0, 'production content_package populated');

  // The hook from production should match what extractHookForAsset returns
  const hook = extractHookForAsset(doc, 'img_1');
  assert.equal(hook, productionPkg[0].hook, 'img_1 hook must come from production (not strategy fallback)');
});
