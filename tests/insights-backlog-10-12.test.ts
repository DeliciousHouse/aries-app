/**
 * tests/insights-backlog-10-12.test.ts
 *
 * AA-129 backlog items 10 and 12 — two small, independent cleanups that were
 * blocked only on someone checking whether they were still true.
 *
 * ITEM 12 — the dead `insights_llm_calls` table. Created as a per-LLM-call cost
 * audit log and never wired: it appears in the schema and the docs and in ZERO
 * lines of application code. The ticket said "delete or wire"; the evidence
 * said delete, because `task_execution_log` (AA-159) already does that job for
 * real. Two permanently-divergent cost tables is worse than one — the risk is
 * not the empty table, it is someone querying it and concluding this product
 * makes no LLM calls.
 *
 * TWO CORRECTIONS FROM REVIEW, both worth stating because the first version of
 * this ticket got them wrong:
 *
 *   1. The drop shipped as a migration ONLY, and migrations/-only files do not
 *      run in production. Fresh databases stopped getting the table; the one
 *      database that had it kept it. The drop now lives in scripts/init-db.js,
 *      the schema the deploy actually applies.
 *
 *   2. "It held zero rows for its whole life" was an INFERENCE from the code
 *      (nothing writes it), stated as though it were a measurement of prod. It
 *      is not claimed here any more: the drop COUNTS first and refuses to act
 *      when the table is non-empty, so the assumption is enforced rather than
 *      trusted. The executed proof is in
 *      tests/insights-llm-calls-drop.requires-infra.test.ts.
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
import { installJsdom } from './helpers/jsdom-env';

// Item 10's tests RENDER the real section, so they need a DOM. Installed before
// the component (and React) are imported — the section is a client component
// and reaches for browser globals on mount.
installJsdom();
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as Record<string, unknown>).self ??= globalThis;

import { platformSupports } from '../backend/insights/platforms/capabilities';
import { __resetInsightInflightForTests } from '../frontend/insights/useInsight';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

// The section fetches through useInsight, which dedups by URL across the
// module — without a reset between renders the second platform would be served
// the first one's body and every render assertion below would be vacuous.
const originalFetch = globalThis.fetch;
test.beforeEach(() => __resetInsightInflightForTests());
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetInsightInflightForTests();
});

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

test('item 12: the drop is on the path that actually RUNS in production', () => {
  // THE CORRECTION. The first version of this ticket shipped the drop as a
  // migration only, and asserted here that the migration file contained the
  // DROP — which proved a file existed, not that anything ran.
  //
  // migrations/-only files do NOT execute in production. The repo says so in
  // its own words (migrations/20260604000000_marketing_schedule.sql: "the
  // source of truth applied at container start is scripts/init-db.js. …
  // migrations/-only files do NOT run in prod"), and the deploy proves it:
  // scripts/release/apply-schema-with-worker-restore.sh runs
  // `node scripts/init-db.js` and nothing else. So a drop that lives only
  // under migrations/ leaves the table on the one database that has it —
  // forever — which is precisely the outcome the ticket exists to prevent.
  const initDb = read('scripts', 'init-db.js');
  assert.match(
    initDb,
    /DROP TABLE insights_llm_calls/,
    'the drop must be in init-db.js — the schema the deploy actually applies',
  );

  // …and the deploy must still be running that file, or the assertion above is
  // about a script nobody executes.
  const deployScript = read('scripts', 'release', 'apply-schema-with-worker-restore.sh');
  assert.match(deployScript, /scripts\/init-db\.js/, 'the deploy applies init-db.js');
});

test('item 12: the migration file exists as a RECORD, and says it does not apply', () => {
  // Kept for the two-place convention (the schema change is recorded under
  // migrations/ like every sibling), but it must not read as the mechanism —
  // that misreading is what produced the first, ineffective fix.
  const migrations = readdirSync(path.join(PROJECT_ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'));
  const drop = migrations.find((f) => /drop_insights_llm_calls/.test(f));
  assert.ok(drop, `no drop migration found among ${migrations.length} migrations`);

  const sql = read('migrations', drop!);
  assert.match(sql, /DROP TABLE IF EXISTS insights_llm_calls/);
  assert.match(
    sql,
    /do NOT run in prod|does not run in prod|mirror/i,
    'the file must state that migrations/ do not execute, so nobody reads it as the delivery path',
  );
});

test('item 12: no AA-129 file claims a production row count nobody measured', () => {
  // Review rejected this twice. The first fix left "nothing has ever inserted a
  // row / every deployment kept it empty / there is no data to preserve" in the
  // migration body and "held zero rows for its entire life" in CLAUDE.md — all
  // statements about production history and current state that nobody has
  // queried.
  //
  // The defensible claim is about the CODE ("no writer exists"), which this
  // suite verifies. The claim about the DATA is not ours to make, and the drop
  // is built so it does not need to be: it counts at runtime. This guard keeps
  // the prose honest, because prose is where the overreach happened both times.
  const UNVERIFIABLE = [
    /\bheld zero rows\b/i,
    /\bzero rows for its\b/i,
    /\bnever held a row\b/i,
    /\bnothing has ever inserted a row\b/i,
    /\bno data to preserve\b/i,
    /\bpermanently[- ]empty\b/i,
    /\bon every deployment it has been an empty table\b/i,
  ];
  const FILES = [
    ['migrations', '20260814000000_drop_insights_llm_calls.sql'],
    ['scripts', 'init-db.js'],
    ['scripts', 'verify-regression-suite.mjs'],
  ] as const;

  for (const parts of FILES) {
    const source = read(...parts);
    for (const pattern of UNVERIFIABLE) {
      // A file may QUOTE the rejected claim while explaining why it is not made
      // — what it must not do is assert it. Lines that also carry the retraction
      // vocabulary are allowed.
      const offending = source
        .split(/\r?\n/)
        .filter((line) => pattern.test(line))
        .filter((line) => !/not claimed|NOT verified|inference|nobody has queried|deliberately not/i.test(line));
      assert.deepEqual(
        offending,
        [],
        `${parts.join('/')}: asserts an unmeasured production row count — ${offending.join(' | ')}`,
      );
    }
  }
});

test('item 12: the drop refuses to act on an unverified assumption', () => {
  // "It held zero rows for its whole life" was an INFERENCE from the code (no
  // writers), not a measurement of production — the review was right to reject
  // it as evidence. Rather than drop on the strength of that inference, the
  // block counts first: empty is removed, non-empty is kept and reported.
  //
  // So the claim becomes a precondition, and the worst case degrades from
  // "silently destroyed rows nobody knew existed" to "a warning in the deploy
  // log". Behaviour against a real Postgres is proven in
  // tests/insights-llm-calls-drop.requires-infra.test.ts.
  const initDb = read('scripts', 'init-db.js');
  assert.match(initDb, /SELECT count\(\*\) FROM insights_llm_calls/, 'it counts before dropping');
  assert.match(initDb, /IF row_count = 0 THEN/, 'and drops only on zero');
  assert.match(initDb, /RAISE WARNING/, 'a non-empty table is reported, not destroyed');
  assert.match(
    initDb,
    /to_regclass\('insights_llm_calls'\) IS NULL/,
    'absent is a no-op, so re-running every deploy is safe',
  );
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

/**
 * The two places that name the table ON PURPOSE: the guarded drop in the
 * schema, and the migration that records it. Both REMOVE the table; neither
 * wires it up. Everything else naming it is a reintroduction.
 */
const SANCTIONED_REMOVAL_SITES = new Set([
  'scripts/init-db.js',
  'migrations/20260814000000_drop_insights_llm_calls.sql',
]);

test('item 12: nothing WIRES the table — only the sanctioned removal sites name it', () => {
  // The evidence the "delete" decision rests on. If this ever finds a real
  // reference outside the removal sites, something started writing to a table
  // believed unused and the drop is wrong — which is exactly the failure this
  // guard exists to catch, in the direction that matters.
  const roots = ['app', 'backend', 'lib', 'frontend', 'components', 'hooks', 'scripts', 'migrations'];
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
      const rel = path.relative(PROJECT_ROOT, full).split(path.sep).join('/');
      if (SANCTIONED_REMOVAL_SITES.has(rel)) continue;
      offenders.push(rel);
    }
  };
  for (const root of roots) walk(path.join(PROJECT_ROOT, root));

  assert.deepEqual(offenders, [], `insights_llm_calls is referenced by: ${offenders.join(', ')}`);
});

test('item 12: the sanctioned sites only ever REMOVE the table', () => {
  // The exemption above is safe only while those two files drop rather than
  // create. Without this, "add it to the allowlist" would be a way to smuggle
  // the table back in.
  for (const rel of SANCTIONED_REMOVAL_SITES) {
    const raw = readFileSync(path.join(PROJECT_ROOT, ...rel.split('/')), 'utf8');
    // Comments stripped: both files legitimately DESCRIBE the CREATE they
    // removed, and prose is not a statement. Checking raw text failed on the
    // migration's own explanation of what it replaced.
    const code = codeWithoutComments(raw, path.extname(rel));
    assert.doesNotMatch(
      code,
      /CREATE TABLE[^;]*insights_llm_calls/i,
      `${rel}: a removal site must never create the table`,
    );
    assert.match(code, /DROP TABLE[^;]*insights_llm_calls/i, `${rel}: must contain the drop`);
  }
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

/**
 * RENDER the real section against a stubbed empty-comments response and return
 * the text an operator would actually read.
 *
 * The previous version of this test imported the module, discarded it with
 * `void mod`, and then regex-scanned the source — while claiming in a comment
 * to be "the actual behaviour". The review called that out and was right: the
 * import proved nothing, and a string appearing in the file is not the same as
 * that string reaching the screen for a given platform. This renders.
 */
async function renderEmptyConversations(platform: string): Promise<string> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ conversations: [], meta: { total: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const { act, create } = await import('react-test-renderer');
  const React = (await import('react')).default;
  const { ConversationsSection } = await import('../frontend/insights/ConversationsSection');

  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(
      React.createElement(ConversationsSection, { period: 'week', platform } as never),
    );
    await new Promise((r) => setTimeout(r, 10));
  });

  const out: string[] = [];
  const walk = (children: unknown[]) => {
    for (const child of children) {
      if (typeof child === 'string') out.push(child);
      else if (child && typeof child === 'object' && 'children' in child) {
        walk((child as { children: unknown[] }).children ?? []);
      }
    }
  };
  walk(root.root.children as unknown[]);
  await act(async () => root.unmount());
  return out.join(' ');
}

test('item 10: a LinkedIn view RENDERS the limitation, not "no comments"', async () => {
  // The defect, stated as the operator experiences it: on LinkedIn the section
  // can only ever be empty, and "No comments recorded in this period" reads as
  // "nobody commented" — so someone chases a bug against working software.
  const text = await renderEmptyConversations('linkedin');

  assert.match(text, /LinkedIn comments aren't available to Aries yet/,
    `expected the limitation copy on screen, got: ${text.slice(0, 200)}`);
  assert.match(text, /Comments from your other channels still appear here/,
    'and a note that the rest of the section is still trustworthy');
  assert.doesNotMatch(text, /No comments recorded in this period/,
    'the misleading message must NOT be what a LinkedIn operator sees');
});

test('item 10: a platform that DOES serve comments renders the plain message', async () => {
  // The other half. If the limitation copy leaked onto Facebook it would be a
  // lie in the opposite direction — telling an operator we cannot see comments
  // we can in fact see.
  const text = await renderEmptyConversations('facebook');

  assert.match(text, /No comments recorded in this period/,
    `expected the plain empty state, got: ${text.slice(0, 200)}`);
  assert.doesNotMatch(text, /aren't available to Aries yet/,
    'no limitation copy on a platform that serves comments');
});

test('item 10: "all" RENDERS the generic message', async () => {
  // On the all-channels view an absence really does mean nobody commented —
  // other platforms' comments are genuinely included, so the limitation copy
  // would be wrong there.
  const text = await renderEmptyConversations('all');
  assert.match(text, /No comments recorded in this period/);
  assert.doesNotMatch(text, /aren't available to Aries yet/);

  const source = read('frontend', 'insights', 'ConversationsSection.tsx');
  assert.match(
    source,
    /platform === "all" \|\| platformSupports\(platform, "comments"\)/,
    "'all' must fall through to the generic message",
  );
});
