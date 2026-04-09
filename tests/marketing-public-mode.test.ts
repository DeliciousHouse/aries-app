import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withPublicEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousStatusPublic = process.env.MARKETING_STATUS_PUBLIC;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-public-guard-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.MARKETING_STATUS_PUBLIC = '1';

  try {
    return await run();
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousStatusPublic === undefined) delete process.env.MARKETING_STATUS_PUBLIC;
    else process.env.MARKETING_STATUS_PUBLIC = previousStatusPublic;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/marketing/jobs rejects unauthenticated public create even when public mode is enabled', async () => {
  await withPublicEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');

    const response = await handlePostMarketingJobs(
      new Request('http://localhost/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://theframex.com',
            businessName: 'The FrameX',
          },
        }),
      }),
      async () => {
        throw new Error('Authentication required.');
      },
    );
    const body = (await response.json()) as { status: string; reason: string };

    assert.equal(response.status, 403);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');
  });
});

test('/api/marketing/jobs/latest rejects unauthenticated public reads even when public mode is enabled', async () => {
  await withPublicEnv(async () => {
    const { handleGetLatestMarketingJobStatus } = await import('../app/api/marketing/jobs/latest/handler');

    const response = await handleGetLatestMarketingJobStatus(async () => {
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as { status: string; reason: string };

    assert.equal(response.status, 403);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');
  });
});

test('/api/pipeline/url-preview requires an explicit draft token for public preview extraction', async () => {
  await withPublicEnv(async () => {
    const { GET } = await import('../app/api/pipeline/url-preview/route');

    const response = await GET(
      new NextRequest('http://localhost/api/pipeline/url-preview?url=https%3A%2F%2Ftheframex.com'),
    );
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Missing draft parameter');
  });
});
