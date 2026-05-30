import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression: dashboard-projection.ts:1019 and runtime-views.ts:1093 each
// had inequality checks against the literal 'weekly_social_content' that
// silently skipped one_off_campaign documents. The projection layer's
// early-return left one_off campaigns invisible in aggregate dashboards
// (campaign list, posts inventory) and stuck the client on "Loading…".
// runtime-views.ts:1093 flipped isWeeklySocialContent to false for one_off,
// which would route them to a launch-review approval surface that doesn't
// exist for the social-content pipeline.
//
// Same FP-class as v0.1.11.1: widening a string-literal union doesn't trip
// TypeScript on inequality checks against literal values. Source-level
// assertion is the cheap durable test that would have caught this at PR time.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTION_SRC = readFileSync(
  path.join(REPO_ROOT, 'backend/social-content/dashboard-projection.ts'),
  'utf8',
);
const RUNTIME_VIEWS_SRC = readFileSync(
  path.join(REPO_ROOT, 'backend/marketing/runtime-views.ts'),
  'utf8',
);

test('buildSocialContentDashboardProjection accepts both weekly and one_off campaigns', () => {
  // The gate must enumerate both supported job types so projection enrichment
  // runs for one_off campaigns too. A single `!== weekly` would early-return
  // and leave the dashboard empty for one_off.
  assert.match(
    PROJECTION_SRC,
    /reqJobType !== 'weekly_social_content'\s*&&[\s\S]*?reqJobType !== 'one_off_campaign'/,
    'dashboard projection gate must accept both weekly_social_content and one_off_campaign',
  );
});

test('runtime-views isWeeklySocialContent treats one_off as weekly for approval routing', () => {
  // One-off campaigns ride the weekly social-content pipeline (design premise
  // P3), so they must NOT flip isWeeklySocialContent to false and pull the
  // launch-review approval branch.
  assert.match(
    RUNTIME_VIEWS_SRC,
    /requestedJobType === 'weekly_social_content'\s*\|\|[\s\S]*?requestedJobType === 'one_off_campaign'/,
    'isWeeklySocialContent must accept both job types so one_off rides the weekly approval surface',
  );
});

test('no residual single-literal weekly checks remain in dashboard-projection projection gate', () => {
  // Defensive: if anyone reverts the gate to a single-literal compare we want
  // a loud failure. The literal `requestedJobTypeFromDoc(runtimeDoc) !== 'weekly_social_content'`
  // without the one_off addition is exactly what shipped the bug.
  assert.doesNotMatch(
    PROJECTION_SRC,
    /requestedJobTypeFromDoc\(runtimeDoc\) !== 'weekly_social_content'\s*\)\s*\{/,
    'a single-literal weekly inequality at the projection gate is the bug shape; do not regress',
  );
});
