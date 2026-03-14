import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isValidElement } from 'react';

import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingNewJobScreen from '../frontend/marketing/new-job';

async function loadStartMarketingJob() {
  const module = await import('../backend/marketing/jobs-start');
  return module.startMarketingJob;
}

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousN8nBaseUrl = process.env.N8N_BASE_URL;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-'));

  process.env.CODE_ROOT = process.cwd();
  process.env.DATA_ROOT = dataRoot;
  process.env.N8N_BASE_URL = 'http://127.0.0.1:9';

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }

    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }

    if (previousN8nBaseUrl === undefined) {
      delete process.env.N8N_BASE_URL;
    } else {
      process.env.N8N_BASE_URL = previousN8nBaseUrl;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/marketing/new-job uses the canonical MarketingNewJobScreen', () => {
  const element = MarketingNewJobPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingNewJobScreen);
});

test('startMarketingJob rejects brand_campaign requests without both required URLs', async () => {
  await withMarketingRuntimeEnv(async () => {
    const startMarketingJob = await loadStartMarketingJob();

    await assert.rejects(
      () =>
        startMarketingJob({
          tenantId: 'tenant_123',
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
          },
        }),
      /missing_required_fields:.*competitorUrl/i,
    );

    await assert.rejects(
      () =>
        startMarketingJob({
          tenantId: 'tenant_123',
          jobType: 'brand_campaign',
          payload: {
            competitorUrl: 'https://facebook.com/competitor',
          },
        }),
      /missing_required_fields:.*brandUrl/i,
    );
  });
});

test('startMarketingJob fallback preserves the canonical brand_campaign job type', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const startMarketingJob = await loadStartMarketingJob();
    const result = await startMarketingJob({
      tenantId: 'tenant_123',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    assert.equal(result.jobType, 'brand_campaign');
    assert.equal(result.wiring, 'backend_fallback');

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${result.jobId}.json`);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as {
      job_type?: string;
      inputs?: {
        brand_url?: string;
        competitor_url?: string;
      };
    };

    assert.equal(runtimeDoc.job_type, 'brand_campaign');
    assert.equal(runtimeDoc.inputs?.brand_url, 'https://brand.example');
    assert.equal(runtimeDoc.inputs?.competitor_url, 'https://facebook.com/competitor');
  });
});
