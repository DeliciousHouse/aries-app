import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildIntegrationsPageData, handleIntegrationsGet } from '../app/api/integrations/handlers';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousStatusPublic = process.env.MARKETING_STATUS_PUBLIC;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-integrations-public-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;

  try {
    return await run(dataRoot);
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

test('/api/integrations public mode returns disconnected cards when no marketing tenant exists', async () => {
  await withRuntimeEnv(async () => {
    process.env.MARKETING_STATUS_PUBLIC = '1';

    const response = await handleIntegrationsGet(async () => {
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as {
      status: string;
      cards: Array<{ connection_state: string }>;
      summary: { connected: number; not_connected: number; attention_required: number };
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.summary.connected, 0);
    assert.equal(body.summary.attention_required, 0);
    assert.equal(body.summary.not_connected, body.cards.length);
    assert.equal(body.cards.every((card) => card.connection_state === 'not_connected'), true);
  });
});

test('/api/integrations public mode skips DB-backed status reads for nonnumeric marketing tenants', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    process.env.MARKETING_STATUS_PUBLIC = '1';
    const runtimeRoot = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      path.join(runtimeRoot, 'public-job.json'),
      JSON.stringify({
        tenant_id: 'public_sugarandleather',
        updated_at: '2026-04-02T00:00:00.000Z',
      }),
      'utf8',
    );

    const response = await handleIntegrationsGet(async () => {
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as {
      cards: Array<{ connection_state: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.cards.every((card) => card.connection_state === 'not_connected'), true);
  });
});

test('buildIntegrationsPageData stays callable as an async compatibility wrapper', async () => {
  const body = await buildIntegrationsPageData('');

  assert.equal(body.status, 'ok');
  assert.equal(Array.isArray(body.cards), true);
});
