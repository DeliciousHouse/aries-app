import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CLAIM_ROW_SQL is defined in the worker (a .mjs script with no type
// declarations, so it cannot be imported under the route-type tsc gate).
// Extract its value from source instead.
function extractClaimRowSql(): string {
  const workerSource = readFileSync(
    path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs'),
    'utf8',
  );
  const match = workerSource.match(/export const CLAIM_ROW_SQL = `([\s\S]*?)`;/);
  assert.ok(match, 'CLAIM_ROW_SQL must be defined and exported in the worker');
  return match[1];
}

const CLAIM_ROW_SQL = extractClaimRowSql();

// T2 regression: the prod `posts` table has a `caption` column and no
// `content` column (verified against information_schema). The worker claim
// query, the meta-publishing INSERT, and the init-db.js schema must all agree
// on `caption`. A real-DB integration test is not viable here (the repo test
// stack uses mock pools and `npm run verify` runs without a database), so this
// asserts the three sources are mutually consistent and free of the drift.

test('worker claimRow SQL selects p.caption and never p.content', () => {
  assert.match(CLAIM_ROW_SQL, /\bp\.caption\b/, 'claim SQL must select p.caption');
  assert.doesNotMatch(CLAIM_ROW_SQL, /\bp\.content\b/, 'claim SQL must not select the dropped p.content column');
  // Sanity: the join the caption column comes from is still present.
  assert.match(CLAIM_ROW_SQL, /JOIN posts p ON p\.id = sp\.post_id/);
});

test('init-db.js posts table declares caption TEXT NOT NULL, not content', () => {
  const initDbSource = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  const createPostsMatch = initDbSource.match(/CREATE TABLE IF NOT EXISTS posts \(([\s\S]*?)\);/);
  assert.ok(createPostsMatch, 'posts CREATE TABLE must be present in init-db.js');
  const postsBody = createPostsMatch[1];
  assert.match(postsBody, /caption TEXT NOT NULL/, 'posts must declare caption TEXT NOT NULL');
  assert.doesNotMatch(postsBody, /\bcontent\b/, 'posts CREATE TABLE must not declare a content column');
});

test('meta-publishing INSERT INTO posts uses the caption column', () => {
  const metaSource = readFileSync(path.join(REPO_ROOT, 'backend/integrations/meta-publishing.ts'), 'utf8');
  const insertMatch = metaSource.match(/INSERT INTO posts \(([^)]*)\)/);
  assert.ok(insertMatch, 'meta-publishing must INSERT INTO posts');
  const columns = insertMatch[1];
  assert.match(columns, /\bcaption\b/, 'INSERT INTO posts must target the caption column');
  assert.doesNotMatch(columns, /\bcontent\b/, 'INSERT INTO posts must not target the dropped content column');
});
