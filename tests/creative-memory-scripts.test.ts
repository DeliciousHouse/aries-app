import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('Creative Memory scripts are intentionally scoped', () => {
  const seed=readFileSync(path.join(PROJECT_ROOT, 'scripts/creative-memory-seed.mjs'),'utf8');
  const backfill=readFileSync(path.join(PROJECT_ROOT, 'scripts/creative-memory-backfill.mjs'),'utf8');
  const smoke=readFileSync(path.join(PROJECT_ROOT, 'scripts/creative-memory-smoke.mjs'),'utf8');
  assert.match(seed,/CREATIVE_MEMORY_TENANT_ID/);
  assert.match(seed,/ON CONFLICT/);
  assert.doesNotMatch(seed,/INSERT INTO business_profiles/);
  assert.match(backfill,/noop-v1/);
  assert.match(smoke,/Campaign Learning/);
});
