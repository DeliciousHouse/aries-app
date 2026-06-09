/**
 * Live-DB (requires-infra) test for the PR2 tenant-scope taste migration
 * (20260609_marketing_taste_tenant_scoped) + the tenant-scoped store SQL
 * (applyTenantTasteSignal / getTasteForTenant).
 *
 * Source-level assertions always run; the live-DB leg self-skips without DB env
 * (requireDbEnvOrSkip) and wraps every write in BEGIN/ROLLBACK so nothing
 * persists. The relaxation ALTERs are applied INSIDE the transaction so the
 * test works against a DB where the migration has not yet been applied, and the
 * rollback restores the original (strict) shape. Indexed in tests/REQUIRES_INFRA.md.
 *
 * Run:
 *   export DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=...
 *   export ARIES_TEST_REQUIRES_INFRA_ENABLED=1
 *   npm run test:requires-infra
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { requireDbEnvOrSkip } from '../helpers/requires-infra';
import {
  applyTasteSignal,
  applyTenantTasteSignal,
  getTasteForTenant,
} from '../../backend/marketing/taste-profile-store';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INIT_DB_SRC = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
const MIGRATION_SRC = readFileSync(
  path.join(REPO_ROOT, 'migrations/20260609000000_marketing_taste_tenant_scoped.sql'),
  'utf8',
);

test('init-db.js + the migration declare the tenant-scope relaxation in lockstep', () => {
  for (const src of [INIT_DB_SRC, MIGRATION_SRC]) {
    assert.match(src, /DROP CONSTRAINT IF EXISTS marketing_taste_profile_pkey/);
    assert.match(src, /ALTER TABLE marketing_taste_profile ALTER COLUMN user_id DROP NOT NULL/);
    assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_user\s+ON marketing_taste_profile \(tenant_id, user_id\)/);
    assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_only\s+ON marketing_taste_profile \(tenant_id\) WHERE user_id IS NULL/);
    assert.match(src, /ALTER TABLE marketing_taste_signal ALTER COLUMN user_id DROP NOT NULL/);
    assert.match(src, /ALTER TABLE posts ADD COLUMN IF NOT EXISTS style_dimension TEXT/);
    assert.match(src, /ALTER TABLE posts ADD COLUMN IF NOT EXISTS style_value TEXT/);
  }
  // init-db.js's fresh-DB CREATE must already be relaxed (no inline PK, nullable user_id).
  assert.ok(
    !/CREATE TABLE IF NOT EXISTS marketing_taste_profile[\s\S]*?PRIMARY KEY \(tenant_id, user_id\)/.test(INIT_DB_SRC),
    'fresh-DB CREATE must not re-introduce the (tenant_id,user_id) PK',
  );
});

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) return null;
  return { host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME, max: 2 };
}

const dbConfig = dbConfigFromEnv();

test('tenant + per-user taste rows coexist; both upsert paths merge (real Postgres, rolled back)', async (t) => {
  if (!dbConfig) {
    requireDbEnvOrSkip(t);
    return;
  }

  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Apply the relaxation in-transaction so this works pre-migration and the
      // rollback restores the strict shape regardless.
      await client.query('ALTER TABLE marketing_taste_profile DROP CONSTRAINT IF EXISTS marketing_taste_profile_pkey');
      await client.query('ALTER TABLE marketing_taste_profile ALTER COLUMN user_id DROP NOT NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_user ON marketing_taste_profile (tenant_id, user_id)');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_only ON marketing_taste_profile (tenant_id) WHERE user_id IS NULL');

      const org = await client.query('SELECT id FROM organizations ORDER BY id LIMIT 1');
      const usr = await client.query('SELECT id FROM users ORDER BY id LIMIT 1');
      if (org.rowCount === 0 || usr.rowCount === 0) {
        console.warn('[taste-tenant-scoped] no organizations/users rows; skipping FK-dependent leg.');
        await client.query('ROLLBACK');
        return;
      }
      const tenantId = String(org.rows[0].id);
      const userId = String(usr.rows[0].id);
      const dim = 'visual_style';
      const value = `__qa_tenant_${Date.now()}__`;

      // Tenant-scoped write twice → one tenant row (user_id IS NULL), rejected=2.
      await applyTenantTasteSignal({ tenantId, dimension: dim, value, outcome: 'rejected' }, client as never);
      await applyTenantTasteSignal({ tenantId, dimension: dim, value, outcome: 'rejected' }, client as never);

      // Per-user write (the untouched onboarding path) → a SEPARATE row.
      await applyTasteSignal({ tenantId, userId, dimension: dim, value, outcome: 'approved' }, client as never);

      const tenantRows = await client.query(
        `SELECT (dimensions -> $2 -> $3 ->> 'rejected_count')::int AS r
           FROM marketing_taste_profile WHERE tenant_id = $1 AND user_id IS NULL`,
        [Number(tenantId), dim, value],
      );
      assert.equal(tenantRows.rowCount, 1, 'exactly one tenant-scoped row');
      assert.equal(tenantRows.rows[0].r, 2, 'tenant rejected_count merged to 2');

      const userRows = await client.query(
        `SELECT count(*)::int AS c FROM marketing_taste_profile WHERE tenant_id = $1 AND user_id = $2`,
        [Number(tenantId), Number(userId)],
      );
      assert.equal(userRows.rows[0].c, 1, 'the per-user onboarding row coexists with the tenant row');

      // getTasteForTenant reads ONLY the tenant-scoped row and decays it.
      const view = await getTasteForTenant(tenantId, client as never);
      assert.ok(view, 'tenant taste view exists');
      assert.equal(view!.dimensions[dim]?.value, value, 'tenant read resolves the tenant-scoped value');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log('[taste-tenant-scoped] PASS: relaxation + coexistence + both upsert paths against real Postgres.');
  } finally {
    await pool.end();
  }
});
