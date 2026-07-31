/**
 * tests/marketing-job-kind.test.ts
 *
 * AA-153 — the post workspace header eyebrow was hardcoded to "Post", so a
 * week-long `weekly_social_content` job read as a single post (QA sweep
 * 2026-07-20, ISSUE-009). These pin the resolver and the label together, since
 * the bug was a label that did not follow the data.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing-job-kind.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMarketingJobKind } from '../backend/marketing/job-kind';
import { marketingJobKindEyebrow } from '../frontend/aries-v1/post-workspace-state';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

type DocFields = Pick<SocialContentJobRuntimeDocument, 'job_type' | 'created_by'>;

function doc(fields: Partial<DocFields>): DocFields {
  return { job_type: 'weekly_social_content', created_by: null, ...fields };
}

// ── Resolver ──────────────────────────────────────────────────────────────────

test('a weekly job resolves to weekly, not a post (the reported bug)', () => {
  assert.equal(resolveMarketingJobKind(doc({ job_type: 'weekly_social_content' })), 'weekly_social_content');
});

test('a one-off job resolves to a post', () => {
  assert.equal(resolveMarketingJobKind(doc({ job_type: 'one_off_post' })), 'one_off_post');
});

test('a one_off_campaign doc still reads as a post', () => {
  // createSocialContentJobRuntimeDocument collapses one_off_campaign into
  // one_off_post, so this shape is defensive — but the union permits it.
  assert.equal(resolveMarketingJobKind(doc({ job_type: 'one_off_campaign' })), 'one_off_post');
});

test('the reel companion marker wins over its one_off_post job_type', () => {
  // The companion is submitted as a one_off_post, so without the marker check
  // every reel would read as a plain post.
  assert.equal(
    resolveMarketingJobKind(doc({ job_type: 'one_off_post', created_by: 'reel:abc-123' })),
    'reel',
  );
});

test('a reel retry is still a reel', () => {
  assert.equal(
    resolveMarketingJobKind(doc({ job_type: 'one_off_post', created_by: 'reel:retry:abc-123' })),
    'reel',
  );
});

test('a real user id in created_by is not mistaken for a reel', () => {
  for (const createdBy of ['user-42', 'reeling-user', 'REEL:upper', '', null]) {
    const kind = resolveMarketingJobKind(doc({ job_type: 'one_off_post', created_by: createdBy }));
    assert.equal(kind, 'one_off_post', `created_by=${String(createdBy)} must not read as a reel`);
  }
});

test('a missing document falls back to weekly rather than throwing', () => {
  assert.equal(resolveMarketingJobKind(null), 'weekly_social_content');
  assert.equal(resolveMarketingJobKind(undefined), 'weekly_social_content');
});

// ── Label ─────────────────────────────────────────────────────────────────────

test('each kind gets its own eyebrow', () => {
  assert.equal(marketingJobKindEyebrow('weekly_social_content'), 'Weekly plan');
  assert.equal(marketingJobKindEyebrow('one_off_post'), 'Post');
  assert.equal(marketingJobKindEyebrow('reel'), 'Reel');
});

test('a response without jobKind falls back to the weekly label', () => {
  // Responses cached before AA-153 carry no jobKind.
  assert.equal(marketingJobKindEyebrow(undefined), 'Weekly plan');
  assert.equal(marketingJobKindEyebrow(null), 'Weekly plan');
});

test('a weekly job never renders the eyebrow "Post"', () => {
  // The regression, stated directly.
  const kind = resolveMarketingJobKind(doc({ job_type: 'weekly_social_content' }));
  assert.notEqual(marketingJobKindEyebrow(kind), 'Post');
  assert.equal(marketingJobKindEyebrow(kind), 'Weekly plan');
});
