import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function dbPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

test('db:init drops the legacy insights_llm_calls table even when it contains rows', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const pool = dbPool();
  t.after(() => pool.end());
  await pool.query(`
    DROP TABLE IF EXISTS insights_llm_calls;
    CREATE TABLE insights_llm_calls (
      id BIGSERIAL PRIMARY KEY,
      purpose TEXT NOT NULL
    );
    INSERT INTO insights_llm_calls (purpose) VALUES ('row-count-is-not-assumed');
  `);

  const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'init-db.js')], {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `db:init failed:\n${result.stderr}\n${result.stdout}`);

  const { rows } = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.insights_llm_calls')::text AS table_name",
  );
  assert.equal(rows[0]?.table_name, null, 'the production schema path must drop the legacy table');
});
