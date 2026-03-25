import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStage1CacheDir = process.env.LOBSTER_STAGE1_CACHE_DIR;
  const previousStage2CacheDir = process.env.LOBSTER_STAGE2_CACHE_DIR;
  const previousStage3CacheDir = process.env.LOBSTER_STAGE3_CACHE_DIR;
  const previousStage4CacheDir = process.env.LOBSTER_STAGE4_CACHE_DIR;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-runtime-views-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.LOBSTER_STAGE1_CACHE_DIR = path.join(dataRoot, 'lobster-stage1-cache');
  process.env.LOBSTER_STAGE2_CACHE_DIR = path.join(dataRoot, 'lobster-stage2-cache');
  process.env.LOBSTER_STAGE3_CACHE_DIR = path.join(dataRoot, 'lobster-stage3-cache');
  process.env.LOBSTER_STAGE4_CACHE_DIR = path.join(dataRoot, 'lobster-stage4-cache');

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousOpenClawLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    if (previousStage1CacheDir === undefined) delete process.env.LOBSTER_STAGE1_CACHE_DIR;
    else process.env.LOBSTER_STAGE1_CACHE_DIR = previousStage1CacheDir;
    if (previousStage2CacheDir === undefined) delete process.env.LOBSTER_STAGE2_CACHE_DIR;
    else process.env.LOBSTER_STAGE2_CACHE_DIR = previousStage2CacheDir;
    if (previousStage3CacheDir === undefined) delete process.env.LOBSTER_STAGE3_CACHE_DIR;
    else process.env.LOBSTER_STAGE3_CACHE_DIR = previousStage3CacheDir;
    if (previousStage4CacheDir === undefined) delete process.env.LOBSTER_STAGE4_CACHE_DIR;
    else process.env.LOBSTER_STAGE4_CACHE_DIR = previousStage4CacheDir;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function installMinimalMarketingInvoker(): void {
  setOpenClawTestInvoker((payload) => {
    const args = (payload.args as Record<string, unknown> | undefined) ?? {};
    const action = String(args.action || '');

    if (action === 'run') {
      return {
        ok: true,
        status: 'needs_approval',
        output: [
          {
            run_id: 'run-research',
            executive_summary: {
              market_positioning: 'Proof-led competitive research is complete.',
              campaign_takeaway: 'Outcome-first hooks are winning.',
            },
          },
        ],
        requiresApproval: {
          resumeToken: 'resume_strategy',
          prompt: 'Research complete. Approve strategy to continue.',
        },
      };
    }

    if (action === 'resume') {
      const token = String(args.token || '');
      if (token === 'resume_strategy') {
        return {
          ok: true,
          status: 'needs_approval',
          output: [
            {
              run_id: 'run-strategy',
              strategy_handoff: {
                run_id: 'run-strategy',
                core_message: 'Launch campaigns with operator control.',
                primary_cta: 'Book a walkthrough',
              },
            },
          ],
          requiresApproval: {
            resumeToken: 'resume_production',
            prompt: 'Strategy complete. Approve production to continue.',
          },
        };
      }
    }

    throw new Error(`Unexpected action: ${action}`);
  });
}

test('production authenticated v1 surfaces do not import demo fixture data directly', () => {
  const files = [
    'components/redesign/layout/app-shell.tsx',
    'frontend/aries-v1/home-dashboard.tsx',
    'frontend/aries-v1/campaign-list.tsx',
    'frontend/aries-v1/campaign-workspace.tsx',
    'frontend/aries-v1/review-queue.tsx',
    'frontend/aries-v1/review-item.tsx',
    'frontend/aries-v1/calendar-screen.tsx',
    'frontend/aries-v1/results-screen.tsx',
    'frontend/aries-v1/settings-screen.tsx',
  ];

  for (const file of files) {
    const source = readRepoFile(file);
    assert.doesNotMatch(source, /from ['"]\.\/data['"]/);
    assert.doesNotMatch(source, /from ['"]@\/frontend\/aries-v1\/data['"]/);
    assert.doesNotMatch(source, /ARIES_CAMPAIGNS|ARIES_REVIEW_ITEMS|ARIES_CHANNELS|ARIES_WORKSPACE/);
  }
});

test('authenticated app shell exposes a visible logout control and does not hardcode review badge counts', () => {
  const source = readRepoFile('components/redesign/layout/app-shell.tsx');

  assert.match(source, /Logout/);
  assert.doesNotMatch(source, /ARIES_REVIEW_ITEMS/);
});

test('runtime campaign and review view services exist and return honest empty states without demo data', async () => {
  await withMarketingRuntimeEnv(async () => {
    const views = await import('../backend/marketing/runtime-views');

    const campaigns = await views.listMarketingCampaignsForTenant('tenant_empty');
    const reviews = await views.listMarketingReviewItemsForTenant('tenant_empty');

    assert.deepEqual(campaigns, []);
    assert.deepEqual(reviews, []);
  });
});

test('review decisions persist and can be reloaded from runtime-backed state', async () => {
  await withMarketingRuntimeEnv(async () => {
    installMinimalMarketingInvoker();
    const { startMarketingJob } = await import('../backend/marketing/orchestrator');
    const views = await import('../backend/marketing/runtime-views');

    const started = await startMarketingJob({
      tenantId: 'tenant_123',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    const reviewsBefore = await views.listMarketingReviewItemsForTenant('tenant_123');
    assert.equal(reviewsBefore.length > 0, true);

    const firstReview = reviewsBefore[0];
    await views.recordMarketingReviewDecision({
      tenantId: 'tenant_123',
      reviewId: firstReview.id,
      action: 'changes_requested',
      actedBy: 'Morgan',
      note: 'Tighten the headline before launch.',
    });

    const persisted = await views.getMarketingReviewItemForTenant('tenant_123', firstReview.id);
    assert.equal(persisted?.status, 'changes_requested');
    assert.equal(persisted?.lastDecision?.actedBy, 'Morgan');
    assert.equal(persisted?.lastDecision?.note, 'Tighten the headline before launch.');

    const runtimePath = path.join(
      process.env.DATA_ROOT!,
      'generated',
      'draft',
      'marketing-reviews',
      `${started.jobId}.json`,
    );
    const saved = JSON.parse(await readFile(runtimePath, 'utf8')) as Record<string, unknown>;
    assert.equal(typeof saved, 'object');
    clearOpenClawTestInvoker();
  });
});
