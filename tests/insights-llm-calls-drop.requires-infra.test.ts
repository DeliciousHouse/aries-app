/**
 * tests/insights-llm-calls-drop.requires-infra.test.ts
 *
 * AA-129 item 12 — the guarded drop, EXECUTED against a real Postgres.
 *
 * WHY THIS FILE EXISTS. The first version of this ticket asserted that a
 * migration file contained a DROP, and called that proof. It was not: the
 * migration never runs in production, and no test executed the statement
 * anywhere. Review rejected it on exactly that basis ("only proves an inert
 * migration file contains DROP"), and was right.
 *
 * So this runs the real block — extracted from scripts/init-db.js, the file the
 * deploy actually applies — against a live database, and checks both branches:
 *
 *   - an EMPTY table is dropped (the expected production state), and
 *   - a table WITH ROWS is kept and reported, because "it never held a row" is
 *     an inference from the code, not a measurement of prod. If that inference
 *     is ever wrong, the deploy must not silently destroy the rows.
 *
 * Self-skips without live DB env, like every requires-infra file.
 *
 * Run:
 *   ARIES_TEST_REQUIRES_INFRA_ENABLED=1 DB_HOST=… DB_PORT=… DB_USER=… \
 *   DB_PASSWORD=… DB_NAME=… APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-llm-calls-drop.requires-infra.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { resolveProjectRoot } from './helpers/project-root';
import { requireDbEnvOrSkip } from './helpers/requires-infra';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

/**
 * The exact DO block scripts/init-db.js executes. Extracted rather than
 * duplicated: a copy in this file could drift from the deployed statement, and
 * the test would then verify something production does not do.
 */
function extractDropBlock(): string {
  const src = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');
  const TAG = '$drop_dead_llm_calls$';
  const start = src.indexOf(`DO ${TAG}`);
  assert.ok(start >= 0, 'the guarded drop block is missing from scripts/init-db.js');
  const end = src.indexOf(`${TAG};`, start + TAG.length + 3);
  assert.ok(end > start, 'the drop block is not terminated');
  return src.slice(start, end + TAG.length + 1);
}

/**
 * A throwaway SCHEMA reached through search_path — the isolation idiom
 * tests/scheduled-dispatch-cutover.requires-infra.test.ts already establishes.
 *
 * Deliberately NOT renaming the real `public` schema: an earlier draft did, and
 * a crash between the rename and the restore would have left the developer's
 * database with no `public` at all. Isolation must not be able to damage the
 * thing it is protecting.
 */
async function withScratchSchema(
  label: string,
  fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>,
): Promise<void> {
  const schema = `aa129_drop_${process.pid}_${label}`;
  const connection = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
  const admin = new pg.Pool({ ...connection, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new pg.Pool({ ...connection, max: 1, options: `-c search_path="${schema}"` });

  try {
    await fn((sql, params) => scoped.query(sql, params) as never);
  } finally {
    await scoped.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

const DROP_BLOCK = extractDropBlock();

test('AA-129 item 12: an EMPTY insights_llm_calls is dropped by the deployed block', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  await withScratchSchema(t.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24), async (q) => {
    await q('CREATE TABLE insights_llm_calls (id BIGSERIAL PRIMARY KEY, tenant_id INTEGER)');
    await q('CREATE INDEX idx_insights_llm_calls_tenant_called_at ON insights_llm_calls (tenant_id)');

    const before = await q("SELECT to_regclass('insights_llm_calls') IS NOT NULL AS present");
    assert.equal(before.rows[0].present, true, 'the table exists before the drop runs');

    await q(DROP_BLOCK);

    const after = await q("SELECT to_regclass('insights_llm_calls') IS NOT NULL AS present");
    assert.equal(after.rows[0].present, false, 'the empty table must be gone');

    // Scoped to THIS schema. An unscoped pg_indexes lookup also matches the
    // index on any real insights_llm_calls the developer's database still has,
    // so it reported an "orphan" that belonged to another schema entirely —
    // the test failing on state it did not create.
    const idx = await q(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_insights_llm_calls_tenant_called_at'`,
    );
    assert.equal(idx.rows[0].n, 0, 'the index goes with the table — no orphan left behind');
  });
});

test('AA-129 item 12: a table WITH ROWS is preserved, not destroyed', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  // The whole reason the block counts first. "It held zero rows for its whole
  // life" was an inference from the code; if it is ever wrong, a deploy must
  // not quietly delete data nobody knew was being written.
  await withScratchSchema(t.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24), async (q) => {
    await q('CREATE TABLE insights_llm_calls (id BIGSERIAL PRIMARY KEY, tenant_id INTEGER)');
    await q('INSERT INTO insights_llm_calls (tenant_id) VALUES (42), (43)');

    await q(DROP_BLOCK);

    const after = await q("SELECT to_regclass('insights_llm_calls') IS NOT NULL AS present");
    assert.equal(after.rows[0].present, true, 'a non-empty table must survive');

    const rows = await q('SELECT count(*)::int AS n FROM insights_llm_calls');
    assert.equal(rows.rows[0].n, 2, 'and keep every row');
  });
});

test('AA-129 item 12: the block is a safe no-op when the table is absent', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  // init-db.js runs on EVERY deploy, so this statement executes forever after
  // the table is gone. It must never error, and must stay idempotent.
  await withScratchSchema(t.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24), async (q) => {
    await q(DROP_BLOCK);
    await q(DROP_BLOCK);

    const after = await q("SELECT to_regclass('insights_llm_calls') IS NOT NULL AS present");
    assert.equal(after.rows[0].present, false);
  });
});

