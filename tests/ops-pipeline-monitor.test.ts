import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

/**
 * AA-117 (S6-4) — guards for the pipeline monitor, the thing that would have
 * caught the outage this ticket exists for.
 *
 * The 2026-08-06 → 08-10 outage ran FOUR DAYS with every weekly run failing at
 * the strategy stage and nobody told; the no-jobs gap before it ran ~3 weeks
 * silently. `ops/aries-pipeline-monitor.py` (PR #964) is the answer, and it is
 * deliberately a HOST script rather than an in-app notifier: one of the
 * conditions it alerts on is "the app is dead or wedged", and an in-app outbox
 * cannot report its own absence.
 *
 * That placement is also why the repo's own test suite could not cover it —
 * it is Python, outside the app, and its `fcntl` dependency is POSIX-only so it
 * cannot even import on Windows. The result was a 62KB alerting script whose
 * fixture suite nothing ran.
 *
 * These are STRUCTURAL guards only. The behavioural suite is the script's own
 * `--self-test`, now wired into CI (ubuntu, where fcntl exists). What is pinned
 * here is that the safety net still exists to be run — nobody deletes the
 * self-test, the suppression rules, or the redaction while "simplifying".
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const MONITOR_PATH = path.join(PROJECT_ROOT, 'ops', 'aries-pipeline-monitor.py');
const README_PATH = path.join(PROJECT_ROOT, 'ops', 'README-aries-pipeline-monitor.md');

const MONITOR = readFileSync(MONITOR_PATH, 'utf8');
const README = readFileSync(README_PATH, 'utf8');

test('the monitor and its runbook exist', () => {
  assert.ok(statSync(MONITOR_PATH).isFile());
  assert.ok(statSync(README_PATH).isFile());
  assert.ok(MONITOR.startsWith('#!/usr/bin/env python3'), 'must stay directly executable by cron');
});

test('the fixture suite CI runs still exists', () => {
  // The CI step invokes `--self-test`. If that flag is removed or renamed, the
  // step would fail loudly rather than silently stop covering anything — but
  // pinning it here fails faster and says why.
  assert.match(MONITOR, /--self-test/, 'the self-test mode must remain');
  assert.match(MONITOR, /def run_self_test\(/, 'the fixture harness must remain');
  // Dry-run is what makes the monitor safe to inspect before arming.
  assert.match(MONITOR, /--dry-run/);
});

test('CI actually runs the fixture suite', () => {
  // The gap this ticket closes: a 62KB alerting script whose own tests nothing
  // executed. Assert the workflow wiring, not just the flag's existence.
  const workflow = readFileSync(
    path.join(PROJECT_ROOT, '.github', 'workflows', 'tests.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /python3 ops\/aries-pipeline-monitor\.py --self-test/,
    'the monitor fixture suite must run in CI',
  );
});

test('provider-auth suppression survives — losing it re-creates a known bug', () => {
  // The branch review caught this exact logic OVER-suppressing genuine
  // gateway-key 401s, i.e. hiding a real outage behind a rule meant only to
  // avoid double-paging with the hermes-auth-sentinel. Deleting the rule
  // double-pages; breaking it goes silent. Both are regressions worth failing on.
  assert.match(MONITOR, /auth_suppressed/, 'the suppression counter must remain');
  assert.match(README, /Provider-auth suppression \(do not remove\)/);
});

test('alerts never carry a credential — the header promises this', () => {
  // The script states: "no token, credential, caption, or DB password is ever
  // placed in a message, a log line, or a command line."
  assert.match(MONITOR, /SECURITY: no token, credential, caption, or DB password/);
  // The DB password must never be passed to psql at all (peer auth in-container).
  assert.doesNotMatch(MONITOR, /PGPASSWORD/, 'the DB password must never be passed');
  assert.match(MONITOR, /redact/i, 'redaction must remain before anything is sent');
});

test('it reads state and never mutates it', () => {
  // An alerting bug must not be able to damage the pipeline it watches. The
  // header claims SELECTs only; pin that no write statement appears.
  assert.doesNotMatch(
    MONITOR,
    /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|DROP TABLE|TRUNCATE)\b/,
    'the monitor must stay read-only against the database',
  );
});

test('the runbook keeps the stale-cron-path warning', () => {
  // The install points cron at a WORKTREE path. Left unrepointed after a merge,
  // cron silently keeps running an old copy of the monitor — which fails in the
  // worst possible way: it looks armed and reports nothing.
  assert.match(README, /Path caveat/i);
  assert.match(README, /worktree/i);
  assert.match(README, /## Install/);
});

test('it stays stdlib-only, so cron needs no environment to maintain', () => {
  // A pip dependency would mean a virtualenv on the host and a second thing to
  // keep alive for the alerter that exists because things silently die.
  const thirdParty = ['requests', 'psycopg', 'httpx', 'boto3', 'yaml', 'dotenv'];
  for (const mod of thirdParty) {
    assert.doesNotMatch(
      MONITOR,
      new RegExp(`^\\s*(import|from)\\s+${mod}\\b`, 'm'),
      `${mod} would make this more than stdlib`,
    );
  }
});
