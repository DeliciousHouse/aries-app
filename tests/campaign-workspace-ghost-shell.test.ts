import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Regression coverage for ISSUE-W2-M2 — visiting
// /dashboard/campaigns/<unknown-id> rendered a fully populated campaign
// shell (heading, Draft chip, zero counters, working tabs) instead of a
// not-found panel. Root cause: the server-side getMarketingJobStatus
// returns a synthetic `{ marketing_job_state: 'not_found' }` payload with
// HTTP 200 for unknown ids, which made the client's `if (!status)` branch
// unreachable and fell through to the real workspace render path.
//
// Fix: the workspace client must short-circuit on marketing_job_state ===
// 'not_found' (in addition to the null case) and render the branded
// "Campaign not found" panel without the tab bar or counters.

const here = dirname(fileURLToPath(import.meta.url));
const workspaceSource = readFileSync(
  resolve(here, '..', 'frontend', 'aries-v1', 'campaign-workspace.tsx'),
  'utf8',
);

test('campaign-workspace short-circuits on marketing_job_state === "not_found"', () => {
  assert.match(
    workspaceSource,
    /marketing_job_state\s*===\s*['"]not_found['"]/,
    'campaign-workspace.tsx must detect the not_found runtime state before rendering the shell',
  );
});

test('campaign-workspace renders a branded "Campaign not found" panel with a back link', () => {
  // Extract the block that handles the null / not-found branch — everything
  // between the `if (!status` guard and its closing `}` — and assert the
  // panel copy and back-to-campaigns link both live inside it.
  const guardMatch = workspaceSource.match(
    /if\s*\(\s*!status[^)]*marketing_job_state[^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/,
  );
  assert.ok(guardMatch, 'expected an if (!status || marketing_job_state === "not_found") guard');
  const block = guardMatch[1];
  assert.match(block, /Campaign not found/, 'guard must render the branded "Campaign not found" title');
  assert.match(block, /\/dashboard\/campaigns/, 'guard must link back to /dashboard/campaigns');
  assert.match(block, /EmptyStatePanel/, 'guard should reuse the branded EmptyStatePanel');
});

test('campaign-workspace does not render tabs, counters, or tab surfaces before the not-found guard', () => {
  // The guard must run before any of the heavy render code that produces
  // the ghost shell (tab bar, metric cards, review surfaces). We assert
  // ordering by index in the source.
  const guardIdx = workspaceSource.search(
    /if\s*\(\s*!status[^)]*marketing_job_state[^)]*['"]not_found['"]/,
  );
  assert.ok(guardIdx > 0, 'not-found guard must exist in the source');

  const tabLabels = ['Brand Review', 'Strategy Review', 'Creative Review', 'Launch Status'];
  for (const label of tabLabels) {
    const labelIdx = workspaceSource.indexOf(label);
    assert.ok(labelIdx > 0, `expected tab label "${label}" to exist in the workspace source`);
    assert.ok(
      labelIdx > guardIdx,
      `tab label "${label}" must render AFTER the not-found guard (ghost-shell regression)`,
    );
  }

  const metricIdx = workspaceSource.indexOf('Generated assets');
  assert.ok(metricIdx > guardIdx, 'metric counters must render AFTER the not-found guard');

  const workflowStateIdx = workspaceSource.indexOf('const workflowState = status.workflowState');
  assert.ok(
    workflowStateIdx > guardIdx,
    'workflowState derivation must come after the not-found guard so unknown ids never reach the shell',
  );
});
