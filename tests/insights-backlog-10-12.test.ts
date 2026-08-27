/**
 * tests/insights-backlog-10-12.test.ts
 *
 * AA-129 backlog items 10 and 12 — two small, independent cleanups that were
 * blocked only on someone checking whether they were still true.
 *
 * ITEM 12 — the legacy `insights_llm_calls` table. No application reader or
 * writer exists, and `task_execution_log` (AA-159) now does that job. The ticket
 * selected deletion; the live-Postgres test seeds a row before running db:init,
 * so the drop does not rest on an unsupported claim about production row count.
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';

import { resolveProjectRoot } from './helpers/project-root';
import { platformSupports } from '../backend/insights/platforms/capabilities';
import { ConversationsSection } from '../frontend/insights/ConversationsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

// ── Item 12: the legacy table is gone, and stays gone ────────────────────────

test('item 12: deployed db:init drops insights_llm_calls instead of recreating it', () => {
  const initDb = read('scripts', 'init-db.js');
  assert.doesNotMatch(
    initDb,
    /CREATE TABLE IF NOT EXISTS insights_llm_calls/,
    'the table must no longer be created',
  );
  assert.doesNotMatch(initDb, /CREATE INDEX[^;]*idx_insights_llm_calls/, 'nor its index');
  assert.match(
    initDb,
    /DROP TABLE IF EXISTS insights_llm_calls/,
    'the production db:init path must remove the table from existing deployments',
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

async function renderEmptyConversations(
  t: import('node:test').TestContext,
  platform: 'all' | 'linkedin',
): Promise<string> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    status: 'ok',
    period: '90day',
    platform,
    meta: { total: 0, positivePercent: 0, needsReply: 0, viewAllLabel: 'View all' },
    conversations: [],
    leadQuality: [],
  }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(ConversationsSection, { period: '90day', platform }));
  });
  const rendered = JSON.stringify(root.toJSON());
  t.after(async () => {
    await act(async () => root.unmount());
  });
  return rendered;
}

test('item 10: rendered LinkedIn empty state explains comments are unavailable', async (t) => {
  const rendered = await renderEmptyConversations(t, 'linkedin');
  assert.match(rendered, /LinkedIn comments aren't available to Aries yet/);
  assert.match(rendered, /Comments from your other channels still appear here/);
  assert.doesNotMatch(rendered, /No comments recorded in this period/);
});

test('item 10: rendered all-channels empty state keeps the generic message', async (t) => {
  const rendered = await renderEmptyConversations(t, 'all');
  assert.match(rendered, /No comments recorded in this period/);
  assert.doesNotMatch(rendered, /comments aren't available to Aries yet/);
});
