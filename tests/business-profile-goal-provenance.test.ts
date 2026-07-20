import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  persistBusinessProfileFieldsFromMarketingPayload,
  updateBusinessProfileWithDiagnostics,
} from '../backend/tenant/business-profile';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function withTempDataRoot(run: (dataRoot: string) => Promise<void> | void): Promise<void> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'aries-goal-provenance-'));
  process.env.DATA_ROOT = dataRoot;

  return Promise.resolve(run(dataRoot)).finally(() => {
    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

function readStoredProfile(dataRoot: string, tenantId: string): Record<string, unknown> {
  const profilePath = path.join(
    dataRoot,
    'generated',
    'validated',
    tenantId,
    'business-profile.json',
  );
  return JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
}

test('an explicit business-profile goal update persists explicit provenance', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 11, name: 'Example Business', slug: 'example-business' }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: 'tenant-explicit',
      businessName: 'Example Business',
      primaryGoal: 'Increase social media presence',
    });

    const stored = readStoredProfile(dataRoot, 'tenant-explicit');
    assert.equal(stored.primary_goal, 'Increase social media presence');
    assert.equal(stored.primary_goal_source, 'explicit');
  });
});

test('a system-populated marketing goal persists inferred provenance', async () => {
  await withTempDataRoot((dataRoot) => {
    persistBusinessProfileFieldsFromMarketingPayload({
      tenantId: 'tenant-inferred',
      payload: { primaryGoal: 'Increase social media presence' },
    });

    const stored = readStoredProfile(dataRoot, 'tenant-inferred');
    assert.equal(stored.primary_goal, 'Increase social media presence');
    assert.equal(stored.primary_goal_source, 'inferred');
  });
});

test('a legacy persisted onboarding preset remains explicit during unrelated profile edits', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const tenantId = 'tenant-legacy-explicit';
    const profilePath = path.join(
      dataRoot,
      'generated',
      'validated',
      tenantId,
      'business-profile.json',
    );
    mkdirSync(path.dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, JSON.stringify({
      tenant_id: tenantId,
      business_name: 'Legacy Business',
      primary_goal: 'Increase social media presence',
      channels: [],
    }));

    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 12, name: 'Legacy Business', slug: 'legacy-business' }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId,
      businessName: 'Legacy Business Renamed',
    });

    const stored = readStoredProfile(dataRoot, tenantId);
    assert.equal(stored.primary_goal_source, 'explicit');
  });
});

test('database bootstrap and migration persist primary goal provenance', () => {
  const initDbSource = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');
  const migrationSource = readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '20260720000000_business_profiles_primary_goal_source.sql'),
    'utf8',
  );

  assert.match(initDbSource, /primary_goal_source TEXT NOT NULL DEFAULT 'inferred'/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS primary_goal_source TEXT NOT NULL DEFAULT 'inferred'/);
  assert.match(migrationSource, /Increase social media presence/);
});
