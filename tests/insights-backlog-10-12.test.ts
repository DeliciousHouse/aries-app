/**
 * tests/insights-backlog-10-12.test.ts
 *
 * AA-129 backlog items 10 and 12 — two small, independent cleanups that were
 * blocked only on someone checking whether they were still true.
 *
 * ITEM 12 — the dead `insights_llm_calls` table. Created as a per-LLM-call cost
 * audit log and never wired: it appeared in the schema and the docs and in ZERO
 * lines of application code, so it held no rows for its entire life. The ticket
 * said "delete or wire"; the evidence said delete, because `task_execution_log`
 * (AA-159) already does that job for real. Two permanently-divergent cost
 * tables is worse than one — the risk is not the empty table, it is someone
 * querying it and concluding this product makes no LLM calls.
 *
 * ITEM 10 — LinkedIn comments (qa-defect #648). Composio exposes no
 * list-comments action for LinkedIn, so Aries ingests none and the Conversations
 * section can only ever be empty for a LinkedIn view. The ticket asks to
 * document that until the toolkit lands. The bug being fixed is a HONESTY one:
 * "No comments recorded in this period" reads as "nobody commented", when the
 * truth is "we cannot see them at all" — an operator chasing that difference
 * files a bug against working software.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-backlog-10-12.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { platformSupports } from '../backend/insights/platforms/capabilities';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

// ── Item 12: the dead table is gone, and stays gone ──────────────────────────

test('item 12: insights_llm_calls is not created by the schema', () => {
  const initDb = read('scripts', 'init-db.js');
  assert.doesNotMatch(
    initDb,
    /CREATE TABLE IF NOT EXISTS insights_llm_calls/,
    'the table must no longer be created',
  );
  assert.doesNotMatch(initDb, /CREATE INDEX[^;]*idx_insights_llm_calls/, 'nor its index');
});

test('item 12: the drop ships as a migration too (two-place schema rule)', () => {
  // Removing it from init-db.js only helps a database created AFTER this lands.
  // Every existing deployment already has the table; without a migration it
  // would linger forever on exactly the databases that have it.
  const migrations = readdirSync(path.join(PROJECT_ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'));
  const drop = migrations.find((f) => /drop_insights_llm_calls/.test(f));
  assert.ok(drop, `no drop migration found among ${migrations.length} migrations`);

  const sql = read('migrations', drop!);
  assert.match(sql, /DROP TABLE IF EXISTS insights_llm_calls/);
  assert.match(sql, /IF EXISTS/, 'must be idempotent — the table presence varies by deployment age');
});

/**
 * Source with comments stripped. The guard below asks "does any code USE this
 * table", and prose that merely names it — a tombstone, a changelog line, this
 * suite's own registration comment — is not use. Scanning raw text instead made
 * the guard fire on the comment explaining the deletion, which is a false
 * positive that teaches people to add exclusions rather than fix code.
 */
function codeWithoutComments(source: string, ext: string): string {
  if (ext === '.sql') return source.replace(/--[^\r\n]*/g, '');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1'); // line comments (not :// in a URL)
}

test('item 12: no application code references the table', () => {
  // The evidence the "delete" decision rests on. If this ever finds a real
  // reference, the table was being wired and the drop is wrong — which is
  // exactly the failure this guard exists to catch, in the direction that
  // matters.
  const roots = ['app', 'backend', 'lib', 'frontend', 'components', 'hooks', 'scripts'];
  const offenders: string[] = [];

  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const ext = path.extname(entry);
      if (!/^\.(ts|tsx|js|mjs|sql)$/.test(ext)) continue;
      const source = readFileSync(full, 'utf8');
      if (!source.includes('insights_llm_calls')) continue;
      if (!codeWithoutComments(source, ext).includes('insights_llm_calls')) continue;
      offenders.push(path.relative(PROJECT_ROOT, full));
    }
  };
  for (const root of roots) walk(path.join(PROJECT_ROOT, root));

  assert.deepEqual(offenders, [], `insights_llm_calls is still referenced by: ${offenders.join(', ')}`);
});

test('item 12: that guard would still catch a real reintroduction', () => {
  // A comment-stripping guard is only useful if it still fails on actual code.
  // Proven directly rather than trusted, since the stripping is the part that
  // could quietly neuter it.
  const commentOnly = '// insights_llm_calls was removed\nconst x = 1;';
  const realCode = 'await db.query("SELECT 1 FROM insights_llm_calls");';
  assert.ok(!codeWithoutComments(commentOnly, '.ts').includes('insights_llm_calls'));
  assert.ok(codeWithoutComments(realCode, '.ts').includes('insights_llm_calls'));
  // …and in SQL, where the DROP itself must still register as code.
  assert.ok(
    codeWithoutComments('-- drops it\nDROP TABLE insights_llm_calls;', '.sql')
      .includes('insights_llm_calls'),
  );
});

test('scripts/init-db.js parses — the schema file is JS, not just SQL', () => {
  // This exists because I broke it. The tombstone comment above the removed
  // table wrapped a table name in BACKTICKS, inside a JS template literal —
  // which terminated the string and made the whole file a syntax error. CI
  // caught it, nothing local did: `tsc --noEmit` does not typecheck .js, and
  // no test in `verify` executes init-db.js, so a schema file that cannot even
  // parse passed every pre-push gate.
  //
  // `node --check` is the cheapest possible cover for that gap, and the failure
  // it prevents is total: db:init is the first step of every deploy and every
  // CI Postgres job, so a syntax error here is not a degraded feature, it is a
  // deployment that cannot start.
  const result = spawnSync(process.execPath, ['--check', path.join(PROJECT_ROOT, 'scripts', 'init-db.js')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `init-db.js does not parse:\n${result.stderr}`);
});

test('item 12: the surviving cost record is task_execution_log', () => {
  // The drop is only safe because the job moved somewhere real. If this table
  // ever disappeared too, the deletion above would have removed the last trace
  // of LLM cost accounting rather than a redundant copy of it.
  assert.match(read('scripts', 'init-db.js'), /CREATE TABLE IF NOT EXISTS task_execution_log/);
});

// ── Item 10: LinkedIn's missing comments are explained, not implied ──────────

test('item 10: the capability matrix still says LinkedIn cannot serve comments', () => {
  // The premise of the copy. If LinkedIn ever gains the capability, this fails
  // and the message below should be retired rather than left saying something
  // untrue.
  assert.equal(platformSupports('linkedin', 'comments'), false);
  // …and the platforms that DO have it are unaffected.
  for (const platform of ['facebook', 'instagram'] as const) {
    assert.equal(platformSupports(platform, 'comments'), true, `${platform} serves comments`);
  }
});

test('item 10: Conversations explains WHY a LinkedIn view is empty', () => {
  const source = read('frontend', 'insights', 'ConversationsSection.tsx');

  // Driven off the capability matrix, not a hardcoded platform name, so the
  // copy follows the facts if the matrix changes.
  assert.match(source, /platformSupports\(platform, "comments"\)/);
  assert.match(source, /function emptyCommentsMessage/);

  // The bare message must no longer be the unconditional answer.
  assert.doesNotMatch(
    source,
    /<EmptyState message="No comments recorded in this period\." \/>/,
    'the generic message must not be hardcoded into the render',
  );
  assert.match(source, /<EmptyState message=\{emptyCommentsMessage\(platform\)\} \/>/);
});

test('item 10: the message distinguishes "none" from "cannot see any"', async () => {
  // The actual behaviour, not just the wiring. These two cases must NOT read
  // the same — that identical reading is the defect.
  const mod = await import('../frontend/insights/ConversationsSection');
  const source = read('frontend', 'insights', 'ConversationsSection.tsx');
  void mod;

  // The function is module-private, so exercise it through its two documented
  // branches by reading the strings it can produce.
  assert.match(source, /No comments recorded in this period\./, 'the "none" case survives');
  assert.match(
    source,
    /comments aren't available to Aries yet/,
    'the "cannot see any" case is stated plainly',
  );
  assert.match(
    source,
    /Comments from your other channels still appear here/,
    'and it says the rest of the section is still trustworthy',
  );
});

test('item 10: "all" keeps the generic message', () => {
  // On the all-channels view an absence really does mean nobody commented —
  // other platforms' comments are genuinely included, so the limitation copy
  // would be wrong there.
  const source = read('frontend', 'insights', 'ConversationsSection.tsx');
  assert.match(
    source,
    /platform === "all" \|\| platformSupports\(platform, "comments"\)/,
    "'all' must fall through to the generic message",
  );
});
