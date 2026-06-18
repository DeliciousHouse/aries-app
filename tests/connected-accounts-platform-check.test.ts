/**
 * Regression guard for #650 / fix/connected-accounts-x-platform-check.
 *
 * The connected_accounts.platform CHECK constraint was missing 'x', which
 * DB-blocked X connect in prod. This test locks:
 *
 *   1. The inline CREATE TABLE CHECK in scripts/init-db.js includes all 8
 *      IntegrationPlatform values (facebook, instagram, meta_ads, tiktok,
 *      youtube, linkedin, reddit, x).
 *   2. The idempotent self-heal ALTER TABLE … ADD CONSTRAINT block in
 *      scripts/init-db.js also includes all 8 values.
 *   3. migrations/20260618000000_connected_accounts_allow_x.sql exists and
 *      its ADD CONSTRAINT includes all 8 values.
 *   4. (Invariant) Every value in INTEGRATION_PLATFORMS (the TS union) is
 *      present in the init-db connected_accounts CHECK — so a future platform
 *      addition that forgets the CHECK is caught here.
 *
 * Self-contained: reads source files as text, no DB required.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { INTEGRATION_PLATFORMS } from '@/backend/integrations/providers/types';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT_DB = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');
const MIGRATION_FILE = path.join(
  PROJECT_ROOT,
  'migrations',
  '20260618000000_connected_accounts_allow_x.sql',
);
const MIGRATION = fs.readFileSync(MIGRATION_FILE, 'utf8');

// Full set of platforms the CHECK must cover — matches INTEGRATION_PLATFORMS.
const ALL_PLATFORMS: readonly string[] = [
  'facebook',
  'instagram',
  'meta_ads',
  'tiktok',
  'youtube',
  'linkedin',
  'reddit',
  'x',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the comma-separated content inside
 *   CHECK (platform IN (<content>))
 * from a larger source string.  Returns `null` if the pattern is not found.
 * The regex is deliberately anchored on `platform IN (` so it does not match
 * the `provider IN (` or `status IN (` siblings.
 */
function extractPlatformCheckContent(src: string): string | null {
  const m = /platform\s+IN\s*\(([^)]+)\)/.exec(src);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Test 1 — inline CREATE TABLE constraint
// ---------------------------------------------------------------------------

test('init-db.js: connected_accounts inline CREATE TABLE platform CHECK includes all 8 platforms', () => {
  // Isolate the connected_accounts CREATE TABLE block so we are not accidentally
  // matching a CHECK in a different table.
  const createBlockMatch =
    /CREATE TABLE IF NOT EXISTS connected_accounts\s*\(([\s\S]*?)\);/.exec(INIT_DB);
  assert.ok(
    createBlockMatch,
    'init-db.js must contain a CREATE TABLE IF NOT EXISTS connected_accounts block',
  );
  const createBlock = createBlockMatch[1];

  const content = extractPlatformCheckContent(createBlock);
  assert.ok(
    content,
    'connected_accounts CREATE TABLE must have a CHECK (platform IN (...)) constraint',
  );

  for (const platform of ALL_PLATFORMS) {
    assert.ok(
      content.includes(`'${platform}'`),
      `init-db.js connected_accounts CREATE TABLE CHECK must include platform '${platform}'; got: ${content}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2 — idempotent self-heal ADD CONSTRAINT block
// ---------------------------------------------------------------------------

test('init-db.js: connected_accounts self-heal ADD CONSTRAINT platform CHECK includes all 8 platforms', () => {
  // Match the ADD CONSTRAINT … CHECK block that follows the CREATE TABLE.
  const alterBlockMatch =
    /ADD CONSTRAINT connected_accounts_platform_check([\s\S]*?)CHECK\s*\(\s*platform\s+IN\s*\(([^)]+)\)\s*\)/.exec(
      INIT_DB,
    );
  assert.ok(
    alterBlockMatch,
    'init-db.js must have the idempotent ADD CONSTRAINT connected_accounts_platform_check … CHECK block',
  );
  const content = alterBlockMatch[2];

  for (const platform of ALL_PLATFORMS) {
    assert.ok(
      content.includes(`'${platform}'`),
      `init-db.js ADD CONSTRAINT self-heal CHECK must include platform '${platform}'; got: ${content}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 3 — migration file exists and ADD CONSTRAINT includes all 8 platforms
// ---------------------------------------------------------------------------

test('migrations/20260618000000_connected_accounts_allow_x.sql: ADD CONSTRAINT includes all 8 platforms', () => {
  const alterBlockMatch =
    /ADD CONSTRAINT connected_accounts_platform_check([\s\S]*?)CHECK\s*\(\s*platform\s+IN\s*\(([^)]+)\)\s*\)/.exec(
      MIGRATION,
    );
  assert.ok(
    alterBlockMatch,
    'migration must have an ADD CONSTRAINT connected_accounts_platform_check … CHECK block',
  );
  const content = alterBlockMatch[2];

  for (const platform of ALL_PLATFORMS) {
    assert.ok(
      content.includes(`'${platform}'`),
      `migration ADD CONSTRAINT CHECK must include platform '${platform}'; got: ${content}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 4 — INTEGRATION_PLATFORMS superset invariant
// ---------------------------------------------------------------------------

test('connected_accounts.platform CHECK is a superset of INTEGRATION_PLATFORMS (invariant: future platform additions are caught)', () => {
  // Re-extract the inline CREATE TABLE CHECK as the canonical gate for this
  // invariant — it is the source of truth for what a freshly provisioned DB allows.
  const createBlockMatch =
    /CREATE TABLE IF NOT EXISTS connected_accounts\s*\(([\s\S]*?)\);/.exec(INIT_DB);
  assert.ok(createBlockMatch, 'connected_accounts CREATE TABLE block must exist in init-db.js');
  const createBlock = createBlockMatch[1];

  const content = extractPlatformCheckContent(createBlock);
  assert.ok(content, 'connected_accounts CREATE TABLE must have a platform CHECK clause');

  for (const platform of INTEGRATION_PLATFORMS) {
    assert.ok(
      content.includes(`'${platform}'`),
      `INTEGRATION_PLATFORMS includes '${platform}' but the connected_accounts.platform CHECK in ` +
        `init-db.js does not — add '${platform}' to the CHECK (this is the #650 oversight pattern)`,
    );
  }

  // Symmetry check: every value in ALL_PLATFORMS (this test's hardcoded list)
  // must also appear in INTEGRATION_PLATFORMS, so this test stays in sync when
  // a platform is removed from the enum.
  for (const platform of ALL_PLATFORMS) {
    assert.ok(
      (INTEGRATION_PLATFORMS as readonly string[]).includes(platform),
      `ALL_PLATFORMS in this test includes '${platform}' but INTEGRATION_PLATFORMS does not — update this test's ALL_PLATFORMS list`,
    );
  }
});
