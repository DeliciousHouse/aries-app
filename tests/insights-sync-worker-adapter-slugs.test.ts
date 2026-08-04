/**
 * S3-5 / AA-101 — the insights-sync worker must be able to override the Composio
 * action slug of every adapter it can actually run.
 *
 * Each adapter resolves its slugs as `env override ?? hardcoded DEFAULT_SLUGS`,
 * via `actionSlug()` -> `COMPOSIO_<PLATFORM>_<OP>_ACTION`. That override only
 * exists if the variable is passed through to the `aries-insights-sync-worker`
 * service — the sidecar is the process that executes the analytics tools, and it
 * has its own `environment:` block (this repo uses no `env_file`).
 *
 * Instagram was the gap this ticket found: FB, X, YouTube, Reddit and LinkedIn
 * all had their slugs wired on the worker; IG had none, despite riding the SAME
 * always-on gate as Facebook (ANALYTICS_PROVIDER=composio + COMPOSIO_ENABLED, no
 * separate rollout flag). A renamed toolkit slug on IG could therefore only be
 * corrected by editing docker-compose.yml and redeploying — mid-incident, with
 * no `.env` escape hatch, unlike every other platform.
 *
 * This pins the general rule rather than the single fix, so the next adapter
 * added to the worker cannot repeat it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const compose = readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8');

/**
 * The `aries-insights-sync-worker` service block only — asserting against the
 * whole file would pass on a variable wired to `aries-app` instead, which is a
 * different process and would not reach the adapter.
 */
function syncWorkerServiceBlock(): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}aries-insights-sync-worker:\s*$/.test(l));
  assert.ok(start >= 0, 'aries-insights-sync-worker service not found in docker-compose.yml');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z0-9-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const WORKER = syncWorkerServiceBlock();

/**
 * Meta-family adapters. Both ride ANALYTICS_PROVIDER=composio with NO separate
 * rollout flag, so in a Composio-enabled prod deploy both are live at once —
 * which is exactly why IG's missing overrides mattered.
 */
const ALWAYS_ON_OPS: Record<string, readonly string[]> = {
  FACEBOOK: ['LIST_POSTS', 'POST_INSIGHTS', 'ACCOUNT_INSIGHTS', 'LIST_COMMENTS'],
  INSTAGRAM: [
    'LIST_POSTS',
    'POST_INSIGHTS',
    'ACCOUNT_INSIGHTS',
    'ACCOUNT_INFO',
    'LIST_COMMENTS',
  ],
};

test('the sync worker wires an action-slug override for every Meta-family insights op', () => {
  for (const [platform, ops] of Object.entries(ALWAYS_ON_OPS)) {
    for (const op of ops) {
      const key = `COMPOSIO_${platform}_${op}_ACTION`;
      assert.ok(
        WORKER.includes(`${key}:`),
        `${key} is not wired into the aries-insights-sync-worker service. The ` +
          `adapter reads it via actionSlug(); without the passthrough the ` +
          `override cannot be set from the host .env and the platform is pinned ` +
          `to its hardcoded default slug.`,
      );
    }
  }
});

test('every wired override is a passthrough default, never a hardcoded slug', () => {
  // `${VAR:-}` keeps the code default authoritative. A literal value here would
  // silently pin the toolkit slug for every deploy of this image.
  const rows = WORKER.split(/\r?\n/).filter((l) => /COMPOSIO_[A-Z_]+_ACTION:/.test(l));
  assert.ok(rows.length > 0, 'expected action-slug rows on the sync worker');
  for (const row of rows) {
    // Split on the FIRST colon only — the value itself contains ':-'.
    const parsed = row.match(/^\s*([A-Z_]+):\s*(.*)$/);
    assert.ok(parsed, `unparseable compose row: ${row}`);
    const [, key, value] = parsed;
    assert.match(
      value.trim(),
      /^\$\{[A-Z_]+:-\}$/,
      `${key} must be an empty-default passthrough (\${VAR:-}), got: ${value}`,
    );
  }
});

test('Instagram analytics slugs are documented in .env.example (two-place rule)', () => {
  // Every compose-read var also belongs in the env template, or an operator
  // cannot discover the escape hatch exists.
  for (const op of ['LIST_POSTS', 'POST_INSIGHTS', 'ACCOUNT_INSIGHTS', 'LIST_COMMENTS']) {
    const key = `COMPOSIO_INSTAGRAM_${op}_ACTION`;
    assert.match(envExample, new RegExp(`^${key}=`, 'm'), `${key} missing from .env.example`);
  }
  // account_info is shared with the publishing block and is declared once —
  // asserting it exists, without requiring a second (duplicate) declaration.
  assert.match(
    envExample,
    /^COMPOSIO_INSTAGRAM_ACCOUNT_INFO_ACTION=/m,
    'COMPOSIO_INSTAGRAM_ACCOUNT_INFO_ACTION missing from .env.example',
  );
  const declarations = envExample
    .split(/\r?\n/)
    .filter((l) => /^COMPOSIO_INSTAGRAM_ACCOUNT_INFO_ACTION=/.test(l));
  assert.equal(
    declarations.length,
    1,
    'COMPOSIO_INSTAGRAM_ACCOUNT_INFO_ACTION must be declared exactly once',
  );
});
