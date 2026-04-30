import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const CANONICAL_MARKETING_WORKFLOWS = [
  path.join(PROJECT_ROOT, 'lobster', 'marketing-pipeline.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-1-research', 'workflow.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'review-workflow.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-2-strategy', 'finalize-workflow.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-3-production', 'review-workflow.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-3-production', 'finalize-workflow.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'review-workflow.lobster'),
  path.join(PROJECT_ROOT, 'lobster', 'stage-4-publish-optimize', 'publish-workflow.lobster'),
];
const BANNED_WORKFLOW_TOKENS = [
  /\.\.\/bin\//,
  /validate_args\.py/,
  /check_requirements\.py/,
  /bootstrap_marketing_workspace\.sh/,
  /invoke_skill\.py/,
  /marketing-pipeline-compat/,
];
const BANNED_WORKFLOW_ROOT_CWDS = [/^cwd:\s*lobster\s*$/m, /^cwd:\s*aries-app\/lobster\s*$/m];

test('marketing pipeline uses local deterministic stage executables instead of invoke_skill bridge', () => {
  const pipelinePath = path.join(PROJECT_ROOT, 'lobster', 'marketing-pipeline.lobster');
  const content = readFileSync(pipelinePath, 'utf8');

  assert.equal(content.includes('invoke_skill.py'), false);
  assert.match(content, /competitor_url:/);
  assert.match(content, /facebook_page_url:/);
  assert.match(content, /--competitor-url/);
  assert.match(content, /meta-ads-extractor/);
  assert.match(content, /campaign-planner/);
  assert.match(content, /head-of-marketing/);
  assert.match(content, /creative-director/);
  assert.match(content, /stage4-publish-compat/);
  assert.doesNotMatch(content, /\.\.\/bin\//);
  assert.doesNotMatch(content, /validate_args\.py/);
  assert.doesNotMatch(content, /check_requirements\.py/);
  assert.doesNotMatch(content, /bootstrap_marketing_workspace\.sh/);
});

test('canonical marketing workflow files contain zero banned legacy helper references', () => {
  for (const workflowPath of CANONICAL_MARKETING_WORKFLOWS) {
    const content = readFileSync(workflowPath, 'utf8');
    for (const token of BANNED_WORKFLOW_TOKENS) {
      assert.doesNotMatch(content, token, `${path.basename(workflowPath)} must not reference ${token}`);
    }
  }
});

test('canonical marketing workflows do not override the gateway checkout root with a stale lobster cwd', () => {
  for (const workflowPath of CANONICAL_MARKETING_WORKFLOWS) {
    const content = readFileSync(workflowPath, 'utf8');
    for (const token of BANNED_WORKFLOW_ROOT_CWDS) {
      assert.doesNotMatch(
        content,
        token,
        `${path.basename(workflowPath)} must not hardcode a root workflow cwd that re-roots execution into a different Lobster checkout`,
      );
    }
  }
});
