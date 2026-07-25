import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('init-db only replaces check constraints when the catalog definition is stale', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  const drops = [...source.matchAll(/DROP CONSTRAINT IF EXISTS ([a-z0-9_]+);/gi)];
  const checkDrops = drops.filter((match) => match[1] !== 'marketing_taste_profile_pkey');
  assert.ok(checkDrops.length > 0, 'fixture finds live check-constraint migrations');

  for (const match of checkDrops) {
    const prefix = source.slice(Math.max(0, match.index! - 650), match.index);
    assert.match(
      prefix,
      /IF NOT EXISTS \([\s\S]*pg_get_constraintdef/,
      `${match[1]} must be catalog-guarded so a correct live definition takes no table lock`,
    );
  }
});

test('submission-fence migration bounds lock and statement waits locally', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'migrations/20260724000000_scheduled_dispatch_submission_fence.sql'),
    'utf8',
  );
  assert.match(source, /BEGIN;[\s\S]*SET LOCAL lock_timeout = '5s';/);
  assert.match(source, /SET LOCAL statement_timeout = '120s';/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ/);
  assert.match(source, /manual_reconciliation/);
  assert.match(source, /COMMIT;/);
});

test('submission-fence cutover quarantines every legacy in-flight row before commit', () => {
  const migration = readFileSync(
    path.join(REPO_ROOT, 'migrations/20260724000000_scheduled_dispatch_submission_fence.sql'),
    'utf8',
  );
  const parentQuarantine = migration.indexOf("SET dispatch_status = 'manual_reconciliation'");
  const childQuarantine = migration.indexOf("SET status = 'manual_reconciliation'");
  const postQuarantine = migration.indexOf("SET published_status = 'unverified'");
  const commit = migration.lastIndexOf('COMMIT;');

  assert.ok(parentQuarantine > 0, 'legacy in-flight parent rows are quarantined');
  assert.ok(childQuarantine > 0, 'legacy in-flight child rows are quarantined');
  assert.ok(postQuarantine > 0, 'canonical posts are marked unverified for operator review');
  assert.ok(parentQuarantine < commit && childQuarantine < commit && postQuarantine < commit);
  assert.match(migration, /WHERE dispatch_status = 'in_flight'/);
  assert.match(migration, /legacy in-flight dispatch predates the provider-submission fence/i);
});

test('boot-time old-version cutover quarantines legacy in-flight rows exactly once', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  assert.match(source, /CREATE TABLE IF NOT EXISTS aries_schema_cutovers/);
  assert.match(source, /scheduled_dispatch_provider_fence_v1[\s\S]*?ON CONFLICT \(name\) DO NOTHING/);
  assert.match(source, /const cutoverClaimed = cutoverClaim\.rowCount === 1/);
  assert.match(source, /if \(cutoverClaimed\)[\s\S]*?dispatch_status = 'manual_reconciliation'/);
  assert.match(
    source,
    /BEGIN[\s\S]*scheduled_dispatch_provider_fence_v1[\s\S]*ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ[\s\S]*manual_reconciliation[\s\S]*COMMIT/,
  );
});
