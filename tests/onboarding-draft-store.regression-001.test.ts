import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withUnreachableDatabaseEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousDbHost = process.env.DB_HOST;
  const previousDbPort = process.env.DB_PORT;
  const previousDbUser = process.env.DB_USER;
  const previousDbPassword = process.env.DB_PASSWORD;
  const previousDbName = process.env.DB_NAME;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-onboarding-draft-db-down-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = '1';
  process.env.DB_USER = 'aries_unreachable';
  process.env.DB_PASSWORD = 'aries_unreachable';
  process.env.DB_NAME = 'aries_unreachable';

  try {
    return await run();
  } finally {
    try {
      const db = await import('../lib/db');
      await db.pool.end();
      delete (globalThis as { __ariesPgPool?: unknown }).__ariesPgPool;
    } catch {
      // The test may fail before the pool module is imported.
    }

    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousDbHost === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = previousDbHost;
    if (previousDbPort === undefined) delete process.env.DB_PORT;
    else process.env.DB_PORT = previousDbPort;
    if (previousDbUser === undefined) delete process.env.DB_USER;
    else process.env.DB_USER = previousDbUser;
    if (previousDbPassword === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = previousDbPassword;
    if (previousDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = previousDbName;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

// Regression: ISSUE-001 — onboarding draft creation returned 500 when Postgres was temporarily unreachable.
// Found by /qa on 2026-05-07.
// Report: .gstack/qa-reports/qa-report-aries-sugarandleather-com-2026-05-07.md
test('onboarding draft store falls back to DATA_ROOT when configured Postgres is unreachable', async () => {
  await withUnreachableDatabaseEnv(async () => {
    const store = await import('../backend/onboarding/draft-store');

    const created = await store.createOnboardingDraft({
      businessName: 'QA Offline Database Brand',
      websiteUrl: 'https://offline-db.example',
    });
    const updated = await store.updateOnboardingDraft(created.draftId, {
      goal: 'Complete onboarding while the shared database is unavailable',
      status: 'ready_for_auth',
    });
    const reloaded = await store.getOnboardingDraft(created.draftId);

    assert.equal(created.status, 'draft');
    assert.equal(updated.status, 'ready_for_auth');
    assert.equal(reloaded?.businessName, 'QA Offline Database Brand');
    assert.equal(reloaded?.goal, 'Complete onboarding while the shared database is unavailable');
  });
});
