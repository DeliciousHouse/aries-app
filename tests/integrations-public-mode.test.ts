import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildIntegrationsPageData, handleIntegrationsGet } from '../app/api/integrations/handlers';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousStatusPublic = process.env.MARKETING_STATUS_PUBLIC;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-integrations-public-'));

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

test('/api/integrations does not fall back to public latest-tenant data', async () => {
  await withRuntimeEnv(async () => {
    const response = await handleIntegrationsGet(async () => {
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as { status: string; reason: string };

    assert.equal(response.status, 403);
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'tenant_context_required');
  });
});

test('buildIntegrationsPageData stays callable as an async compatibility wrapper', async () => {
  const body = await buildIntegrationsPageData('');

  assert.equal(body.status, 'ok');
  assert.equal(Array.isArray(body.cards), true);
});
