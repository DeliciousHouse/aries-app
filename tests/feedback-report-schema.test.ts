import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('feedback_reports page_path ships through migration/init, with read-only request readiness', () => {
  const migration = source('migrations/20260814000000_feedback_reports_page_path.sql');
  assert.match(
    migration,
    /ALTER TABLE feedback_reports\s+ADD COLUMN IF NOT EXISTS page_path TEXT;/,
  );

  const schema = source('scripts/init-db.js');
  assert.match(schema, /page_path TEXT/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS page_path TEXT/);
  const store = source('backend/feedback/report-store.ts');
  assert.match(store, /SELECT[\s\S]*?page_path[\s\S]*?FROM feedback_reports LIMIT 0/);
  assert.doesNotMatch(store, /ALTER TABLE|CREATE TABLE|CREATE INDEX/);
});
