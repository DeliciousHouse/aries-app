// PRD §20 invariant 8:
//   "Video render requests require approval."
//
// Operationalized as: the post-type taxonomy in jobs-status includes
// 'video_render' as a distinct category, and review items are built per-job
// so video renders surface in the approval queue alongside other post types.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './_helpers';

test('postType taxonomy distinguishes video_render from script and static', () => {
  const source = readRepoFile('backend/marketing/jobs-status.ts');
  assert.match(
    source,
    /postType:\s*['"]static['"]\s*\|\s*['"]image['"]\s*\|\s*['"]video_script['"]\s*\|\s*['"]video_render['"]/,
    'postType union must include video_render as a distinct category so it can carry its own approval state',
  );
});

test('review items pipeline exists and surfaces non-approved items', () => {
  const source = readRepoFile('backend/marketing/runtime-views.ts');
  assert.match(
    source,
    /buildReviewItemsForJob/,
    'buildReviewItemsForJob is the canonical entry into the approval queue and must remain in runtime-views',
  );
  assert.match(
    source,
    /item\.status\s*!==\s*['"]approved['"]/,
    'aggregate counters must explicitly compare against the "approved" status so non-approved items remain visible',
  );
});
