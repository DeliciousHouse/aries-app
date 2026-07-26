import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('init-db bounds every session lock and statement wait before schema work', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  const firstSchemaQuery = source.indexOf('CREATE TEMP TABLE IF NOT EXISTS __aries_init_guard');
  const timeoutQuery = source.indexOf("SET lock_timeout = '5s'");
  assert.ok(timeoutQuery > 0 && timeoutQuery < firstSchemaQuery);
  assert.match(source, /SET statement_timeout = '120s'/);
});

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
  assert.doesNotMatch(
    source,
    /SET dispatch_status = 'manual_reconciliation'/,
    'pre-app migration is additive schema only; quarantine waits for compatible app health',
  );
  assert.match(source, /COMMIT;/);
});

test('fresh db:init installs the provider fence without performing the post-health quarantine', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  assert.match(source, /ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ/);
  assert.doesNotMatch(source, /quarantineLegacyScheduledDispatches\(client\)/);
  assert.doesNotMatch(source, /SET dispatch_status = 'manual_reconciliation'/);
});

test('post-health cutover owns every legacy quarantine write', () => {
  const migration = readFileSync(
    path.join(REPO_ROOT, 'migrations/20260724000000_scheduled_dispatch_submission_fence.sql'),
    'utf8',
  );
  const cutover = readFileSync(
    path.join(REPO_ROOT, 'scripts/scheduled-dispatch-cutover.js'),
    'utf8',
  );
  const parentQuarantine = cutover.indexOf("SET dispatch_status = 'manual_reconciliation'");
  const childQuarantine = cutover.indexOf("SET status = 'manual_reconciliation'");
  const postQuarantine = cutover.indexOf("SET published_status = 'unverified'");
  const commit = cutover.lastIndexOf("client.query('COMMIT')");

  assert.ok(parentQuarantine > 0, 'legacy in-flight parent rows are quarantined');
  assert.ok(childQuarantine > 0, 'legacy in-flight child rows are quarantined');
  assert.ok(postQuarantine > 0, 'canonical posts are marked unverified for operator review');
  assert.ok(parentQuarantine < commit && childQuarantine < commit && postQuarantine < commit);
  assert.match(cutover, /WHERE (?:scheduled\.)?dispatch_status = 'in_flight'/);
  assert.match(cutover, /legacy in-flight dispatch predates the provider-submission fence/i);
  assert.doesNotMatch(
    cutover,
    /ADD COLUMN IF NOT EXISTS dispatch_started_at/,
    'post-health cutover is data-only; all provider-fence DDL belongs to pre-app init',
  );
  assert.doesNotMatch(migration, /SET dispatch_status = 'manual_reconciliation'/);
});
