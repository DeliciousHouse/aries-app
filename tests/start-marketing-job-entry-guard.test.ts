import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression: the runtime guard at the entry of startMarketingJob hardcoded
// `input.jobType !== 'weekly_social_content'` and threw for every value
// outside that. When the type union was widened to include 'one_off_campaign'
// in v0.1.11.0, TypeScript accepted the call site (the literal compared in an
// inequality is type-safe regardless of union width) but the runtime check
// silently rejected every one_off_campaign submission. Production QA against
// PR #446 surfaced the bug as `unsupported_job_type:event_campaign` rendering
// on the form.
//
// Source-level assertion locks both halves of the guard's union in place so a
// future rename or widening can't silently break the entry path again. A full
// integration test against startMarketingJob is heavy (touches DB, brand-kit
// extraction, file IO, Hermes); the source assertion is the cheap, durable
// equivalent.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORCH_SRC = readFileSync(
  path.join(REPO_ROOT, 'backend/marketing/orchestrator.ts'),
  'utf8',
);

test('startMarketingJob entry guard accepts both weekly_social_content and one_off_campaign', () => {
  // The accept-list is enumerated explicitly (a single `!== weekly` check would
  // throw for one_off_campaign). The regex tolerates whitespace and line
  // wrapping but the two literal values must both appear.
  assert.match(
    ORCH_SRC,
    /input\.jobType !== 'weekly_social_content'\s*&&\s*input\.jobType !== 'one_off_campaign'/,
    'entry guard must enumerate both supported job types',
  );
});

test('startMarketingJob sets up social-content runtime state for both job types', () => {
  // One-off campaigns ride the same Hermes pipeline per design premise P3;
  // downstream code reads `social_content_runtime` and crashes if absent.
  // Both job types must reach ensureSocialContentRuntimeState.
  assert.match(
    ORCH_SRC,
    /input\.jobType === 'weekly_social_content'\s*\|\|\s*input\.jobType === 'one_off_campaign'[\s\S]{0,200}ensureSocialContentRuntimeState/,
    'ensureSocialContentRuntimeState must run for both supported job types',
  );
});

test('no stale event_campaign string literals remain in orchestrator', () => {
  // The v0.1.11.0 rename dropped event_campaign from the type union. Any
  // residual literal compares are dead branches that hide intent.
  assert.doesNotMatch(
    ORCH_SRC,
    /['"]event_campaign['"]/,
    "no residual 'event_campaign' literal should appear in orchestrator.ts",
  );
});
