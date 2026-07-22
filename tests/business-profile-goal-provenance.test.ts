import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pool from '../lib/db';
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

test('an unrelated profile update preserves inferred goal provenance', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const tenantId = 'tenant-inferred-unrelated-save';
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
      business_name: 'Inferred Business',
      primary_goal: 'Stay visible every week',
      primary_goal_source: 'inferred',
      channels: [],
    }));

    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 13, name: 'Inferred Business', slug: 'inferred-business' }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId,
      businessName: 'Inferred Business Renamed',
    });

    const stored = readStoredProfile(dataRoot, tenantId);
    assert.equal(stored.primary_goal, 'Stay visible every week');
    assert.equal(stored.primary_goal_source, 'inferred');
  });
});

test('deliberately confirming an unchanged inferred goal persists explicit provenance', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const tenantId = 'tenant-inferred-confirmed';
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
      business_name: 'Confirmed Business',
      primary_goal: 'Stay visible every week',
      primary_goal_source: 'inferred',
      channels: [],
    }));

    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 14, name: 'Confirmed Business', slug: 'confirmed-business' }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId,
      primaryGoal: 'Stay visible every week',
    });

    const stored = readStoredProfile(dataRoot, tenantId);
    assert.equal(stored.primary_goal, 'Stay visible every week');
    assert.equal(stored.primary_goal_source, 'explicit');
  });
});

test('the held request client completes the provenance upsert when the pool has no spare connection', async (t) => {
  await withTempDataRoot(async () => {
    const events: string[] = [];
    let globalPoolQueryCalled = false;
    const saturatedPoolCheckout = new Promise<never>(() => {});

    t.mock.method(pool, 'query', (() => {
      globalPoolQueryCalled = true;
      return saturatedPoolCheckout;
    }) as unknown as typeof pool.query);

    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 42, name: 'Ordered Business', slug: 'ordered-business' }],
          };
        }
        if (sql.includes('UPDATE organizations')) {
          events.push('organization-updated');
        }
        if (sql.includes('INSERT INTO business_profiles')) {
          events.push('profile-upserted');
        }
        if (sql.includes('DELETE FROM insights_narratives')) {
          events.push('goal-cache-invalidated');
        }
        return { rowCount: 1, rows: [] };
      },
    };

    const update = updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '42',
      businessName: 'Ordered Business',
      primaryGoal: 'Stay visible every week',
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('profile update waited for a nested pool checkout')),
        250,
      );
    });

    try {
      await Promise.race([update, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    assert.equal(globalPoolQueryCalled, false, 'the held client must avoid a nested pool checkout');
    assert.deepEqual(events, [
      'organization-updated',
      'profile-upserted',
      'goal-cache-invalidated',
    ]);
  });
});

test('a failed held-client provenance upsert rejects and skips goal-cache invalidation', async (t) => {
  await withTempDataRoot(async () => {
    const events: string[] = [];
    let globalPoolQueryCalled = false;

    t.mock.method(pool, 'query', (async () => {
      globalPoolQueryCalled = true;
      throw new Error('unexpected global pool checkout');
    }) as unknown as typeof pool.query);

    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 43, name: 'Fail Closed Business', slug: 'fail-closed-business' }],
          };
        }
        if (sql.includes('UPDATE organizations')) {
          events.push('organization-updated');
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO business_profiles')) {
          events.push('profile-upsert-failed');
          throw new Error('simulated provenance upsert failure');
        }
        if (sql.includes('DELETE FROM insights_narratives')) {
          events.push('goal-cache-invalidated');
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await assert.rejects(
      updateBusinessProfileWithDiagnostics(client as never, {
        tenantId: '43',
        businessName: 'Fail Closed Business',
        primaryGoal: 'Stay visible every week',
      }),
      /simulated provenance upsert failure/,
    );

    assert.equal(globalPoolQueryCalled, false, 'authenticated persistence must stay on the held client');
    assert.deepEqual(events, ['organization-updated', 'profile-upsert-failed']);
  });
});

test('both authenticated consumers keep their checked-out client through the profile update', () => {
  for (const [consumer, relativePath] of [
    ['PATCH /api/business/profile', path.join('app', 'api', 'business', 'profile', 'route.ts')],
    ['onboarding resume', path.join('app', 'onboarding', 'resume', 'page.tsx')],
  ] as const) {
    const source = readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
    assert.match(
      source,
      /const client = await pool\.connect\(\);[\s\S]*?updateBusinessProfileWithDiagnostics\(client,/,
      `${consumer} must pass its checked-out PoolClient into the authenticated update path`,
    );
    assert.match(source, /finally \{\s*client\.release\(\);\s*\}/, `${consumer} must release that client`);
  }
});

test('a system-populated legacy preset without provenance remains inferred during unrelated profile edits', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const tenantId = 'tenant-legacy-inferred';
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
      business_name: 'Legacy System-Populated Business',
      primary_goal: 'Increase social media presence',
      channels: [],
    }));

    const client = {
      async query(sql: string) {
        if (sql.includes('SELECT id, name')) {
          return {
            rowCount: 1,
            rows: [{ id: 12, name: 'Legacy System-Populated Business', slug: 'legacy-business' }],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId,
      businessName: 'Legacy System-Populated Business Renamed',
    });

    const stored = readStoredProfile(dataRoot, tenantId);
    assert.equal(stored.primary_goal, 'Increase social media presence');
    assert.equal(stored.primary_goal_source, 'inferred');
  });
});

test('database bootstrap and migration leave unknown legacy goal provenance inferred', () => {
  const initDbSource = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');
  const migrationSource = readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '20260720000000_business_profiles_primary_goal_source.sql'),
    'utf8',
  );

  assert.match(initDbSource, /primary_goal_source TEXT NOT NULL DEFAULT 'inferred'/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS primary_goal_source TEXT NOT NULL DEFAULT 'inferred'/);
  assert.doesNotMatch(initDbSource, /SET primary_goal_source = 'explicit'/);
  assert.doesNotMatch(migrationSource, /SET primary_goal_source = 'explicit'/);
  assert.doesNotMatch(initDbSource, /WHERE primary_goal IN/);
  assert.doesNotMatch(migrationSource, /WHERE primary_goal IN/);
});
