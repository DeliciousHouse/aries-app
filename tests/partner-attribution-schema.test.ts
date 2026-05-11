import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('init-db defines partner_attribution_outbox', () => {
  const ddl = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS partner_attribution_outbox/);
  assert.match(ddl, /idx_partner_attribution_outbox_pending/);
});
