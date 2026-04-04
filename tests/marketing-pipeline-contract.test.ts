import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

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
});
