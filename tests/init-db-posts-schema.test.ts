import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DDL = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');

// A fresh DB provisioned from init-db.js must match the prod posts table.
// Prod posts carries these columns (information_schema diff, 2026-05-20);
// init-db.js previously declared only id/tenant_id/caption/created_at/
// updated_at plus a handful of ALTERs, drifting from prod and breaking
// resolveMediaUrls (job_id) and the scheduled-dispatch path.
const REQUIRED_POSTS_COLUMNS = [
  'job_id',
  'platform',
  'media_type',
  'media_urls',
  'hermes_run_id',
  'creative_asset_ids',
  'status',
  'idempotency_key',
  'platform_post_id',
  'published_at',
  'scheduled_at',
  'published_status',
];

test('init-db.js declares every prod posts column', () => {
  for (const col of REQUIRED_POSTS_COLUMNS) {
    const re = new RegExp(`ALTER TABLE posts\\s+ADD COLUMN IF NOT EXISTS ${col}\\b`);
    assert.match(
      DDL,
      re,
      `init-db.js must add posts.${col} so a fresh DB matches prod`,
    );
  }
});

test('init-db.js indexes posts.job_id for the scheduled-dispatch media lookup', () => {
  assert.match(DDL, /idx_posts_tenant_job/, 'job_id must be indexed for resolveMediaUrls');
});

test('init-db.js keeps the posts.status check constraint in sync with prod', () => {
  assert.match(
    DDL,
    /posts_status_check CHECK \(status IN \([^)]*'published'[^)]*'failed'[^)]*\)\)/,
    'posts.status check constraint must mirror prod',
  );
});
