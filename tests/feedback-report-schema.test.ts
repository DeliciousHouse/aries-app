import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('feedback_reports page_path ships through migration, init, and on-demand upgrade paths', () => {
  const migration = source('migrations/20260814000000_feedback_reports_page_path.sql');
  assert.match(
    migration,
    /ALTER TABLE feedback_reports\s+ADD COLUMN IF NOT EXISTS page_path TEXT;/,
  );

  for (const path of ['scripts/init-db.js', 'backend/feedback/report-store.ts']) {
    const schema = source(path);
    assert.match(schema, /page_path TEXT/);
    assert.match(schema, /ADD COLUMN IF NOT EXISTS page_path TEXT/);
  }
});
