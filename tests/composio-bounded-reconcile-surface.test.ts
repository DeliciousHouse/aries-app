/**
 * Source-structure assertion test for the bounded eager-reconcile implementation
 * in the Composio connections screen (#699 Fix B.2).
 *
 * The connections screen must:
 *  a. Reference `reconcileError` to render per-connection advisories.
 *  b. Implement a BOUNDED retry budget via RECONCILE_DELAYS_MS (a fixed array
 *     of delay values, not an open-ended polling loop) so the screen stops
 *     polling after ~5 attempts once OAuth returns and does not spin forever.
 *  c. Key the retry trigger off a `pending` status check so reconcile only
 *     fires while at least one connection is still unresolved.
 *  d. Detect the `?connected=` search param to guarantee at least one reconcile
 *     poll immediately after the OAuth redirect back to the app.
 *
 * These are source-level assertions (readFileSync) rather than render tests --
 * the patterns are stable identifiers that survive minor formatting changes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const screenSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'integrations', 'composio-connections-screen.tsx'),
  'utf8',
);

// -- a. reconcileError rendered in the screen ---------------------------------

test('#699 Fix B.2: composio-connections-screen renders reconcileError advisory', () => {
  assert.ok(
    screenSource.includes('reconcileError'),
    'screen must reference reconcileError to surface per-platform reconcile failure advisories',
  );
});

// -- b. bounded retry via RECONCILE_DELAYS_MS constant -----------------------

test('#699 Fix B.2: composio-connections-screen implements bounded retry via RECONCILE_DELAYS_MS', () => {
  assert.ok(
    screenSource.includes('RECONCILE_DELAYS_MS'),
    'screen must define RECONCILE_DELAYS_MS to bound the eager-reconcile retry budget',
  );
  // The constant must be an array (bounded list of delay values, not a count).
  assert.match(
    screenSource,
    /RECONCILE_DELAYS_MS\s*=\s*\[/,
    'RECONCILE_DELAYS_MS must be an array literal (bounded delay schedule, not a scalar)',
  );
  // The attempt counter must be capped against the array length so the retry
  // stops once the budget is spent.
  assert.ok(
    screenSource.includes('RECONCILE_DELAYS_MS.length'),
    'screen must guard the retry loop against RECONCILE_DELAYS_MS.length to stop after budget',
  );
});

// -- c. retry trigger keyed off pending status --------------------------------

test('#699 Fix B.2: composio-connections-screen retry loop keys off pending connection status', () => {
  assert.ok(
    screenSource.includes('pending'),
    'screen must check for a pending status to decide whether to continue reconcile polling',
  );
  // The pending check must be part of a conditional expression that controls
  // re-loading, not just a status label.
  const hasPendingConditional = /hasPending|status.*pending|pending.*status/.test(screenSource);
  assert.ok(
    hasPendingConditional,
    'screen must use a hasPending / status===pending conditional to gate the retry loop',
  );
});

// -- d. ?connected= detection for immediate post-OAuth poll -------------------

test('#699 Fix B.2: composio-connections-screen detects ?connected= search param after OAuth return', () => {
  // The screen must read window.location.search to detect a return from OAuth.
  assert.ok(
    screenSource.includes('window.location.search'),
    'screen must read window.location.search to detect a return from OAuth (?connected=)',
  );
  // URLSearchParams.has('connected') must be called to check for the param.
  assert.ok(
    screenSource.includes('.has(') && screenSource.includes('connected'),
    "screen must call URLSearchParams.has to detect the ?connected= param post-OAuth",
  );
});
